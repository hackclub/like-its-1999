// the host side of the agent connection, as pure transitions: facts in, decisions out.
// nothing here touches the emulator, the clock or the network (link.js does that), and `now`
// is always passed in
//
// what it has to survive, per PROTOCOL.md:
//   - no agent at all, forever (every v1 world; must stay quiet and healthy)
//   - an agent that answers late, or never
//   - a snapshot restored mid-conversation, so frames arrive from a previous page's epoch
//   - the same save restored into two tabs, each with its own epoch
//   - duplicate IDENTs, replies to calls nobody made, pushes that fail
// the rule throughout: anything unrecognised is dropped, never fatal

import { TYPES, withFields, fieldText, fieldInt } from './frame.js'

export const PROTO = 1

// how the host reports the connection to the rest of the page
//   'idle'      nothing sent yet
//   'looking'   announcing, no answer yet
//   'absent'    long enough without an answer that we assume no agent exists
//   'parent'    a parent answered, no usable child yet
//   'ready'     a child is running the build we want
export const STATES = ['idle', 'looking', 'absent', 'parent', 'ready']

// announce every 2s while looking, then back off once we conclude nothing is there. a v1
// world has no agent and never will, so the slow rate only catches one that appears later
// (after a force reboot, say)
export const ANNOUNCE_MS = 2000
export const ABSENT_AFTER_MS = 15000
export const SLOW_ANNOUNCE_MS = 30000

// bytes per PAYLOAD_DATA frame, one in flight at a time waiting for an acknowledgement.
// v86's emulated UART cannot drop bytes, but Windows' own serial driver sits behind it and a
// host write arrives as fast as the guest takes interrupts: pushing a 21 KB binary in one
// burst overran that driver and left the guest holding the port and deaf to everything
export const CHUNK_BYTES = 512

// how long to wait for a chunk to be acknowledged before abandoning the transfer; the guest
// is paced, not slow, so a silence this long means something is wrong
export const CHUNK_ACK_MS = 4000

// a call that gets no reply in this long is failed, so a wedged child cannot leak pending
// calls forever
export const CALL_TIMEOUT_MS = 10000

// once identified the host stops announcing, so it pings a quiet connection instead and
// forgets everything it believed if nothing answers for long enough
//
// force reboot is a button in the toolbar: it restarts Windows without reloading the page,
// so an agent that was happily "connected" is talking to a machine that no longer exists,
// and it still believes it has pushed the child
export const IDLE_PING_MS = 10000
export const LOST_AFTER_MS = 30000

export function createAgent({ epoch, wantHash = '', wantBytes = null } = {}) {
  if (!epoch) throw new Error('an agent needs an epoch')
  return {
    epoch: String(epoch),
    wantHash,
    wantBytes,
    state: 'idle',
    role: null,
    ver: '',
    hash: '',
    caps: [],
    lookingSince: null,
    lastHeard: null,
    lastAnnounce: null,
    lastPing: null,
    pushedHash: null, // what we last sent bytes for, so we don't loop on a failing push
    transfer: null, // { seq, sentAt } while a chunk is in flight
    nextCallId: 1,
    pending: new Map(), // id -> { fn, at }
    statuses: [],
  }
}

const announce = (a) => ({
  type: TYPES.ANNOUNCE,
  fields: [a.epoch, String(PROTO), a.wantHash],
})

// one chunk, addressed by sequence number, or the END frame once the bytes run out
function chunkFrame(a, seq) {
  const at = seq * CHUNK_BYTES
  if (at >= a.wantBytes.length)
    return { type: TYPES.PAYLOAD_END, fields: [a.epoch, a.wantHash] }
  return {
    type: TYPES.PAYLOAD_DATA,
    fields: [a.epoch, String(seq), a.wantBytes.subarray(at, at + CHUNK_BYTES)],
  }
}

// start a transfer: the header plus the first chunk, and acknowledgements drive the rest
function pushChild(a, now) {
  if (!a.wantBytes || !a.wantHash) return []
  // a child already running what we want is left alone, so a reload does not tear down a
  // working tracker
  if (a.hash === a.wantHash) return []
  // one attempt per hash: if the parent reports it failed, we do not spin
  if (a.pushedHash === a.wantHash) return []
  a.pushedHash = a.wantHash
  a.transfer = { seq: 0, sentAt: now }
  return [
    {
      type: TYPES.PAYLOAD_BEGIN,
      fields: [a.epoch, a.wantHash, String(a.wantBytes.length)],
    },
    chunkFrame(a, 0),
  ]
}

// a frame arrived; returns { sends, events, dropped } and mutates `a`
//
// frames from another epoch are dropped outright: the whole defence against a snapshot
// restored mid-conversation, and against two tabs restoring the same machine
export function onFrame(a, frame, now = 0) {
  const sends = []
  const events = []
  const drop = (why) => ({ sends, events, dropped: why })

  const withF = withFields(frame)
  if (!withF) return drop('payload is not a field list')
  const [epochField, ...rest] = withF.fields
  if (fieldText(epochField) !== a.epoch) return drop('stale epoch')

  a.lastHeard = now

  const setState = (next) => {
    if (a.state === next) return
    a.state = next
    events.push({ type: 'state', state: next, role: a.role, ver: a.ver })
  }

  switch (frame.type) {
    case TYPES.IDENT: {
      const role = fieldText(rest[0])
      if (role !== 'parent' && role !== 'child') return drop('unknown role')
      if (fieldInt(rest[1]) === null) return drop('bad proto')
      a.role = role
      a.ver = fieldText(rest[2])
      a.hash = fieldText(rest[3])
      a.caps = fieldText(rest[4]).split(',').filter(Boolean)
      // a duplicate IDENT is idempotent: pushChild refuses to re-send bytes for a hash it
      // already sent
      setState(role === 'child' && a.hash === a.wantHash ? 'ready' : 'parent')
      sends.push(...pushChild(a, now))
      break
    }

    case TYPES.STATUS: {
      const code = fieldText(rest[0])
      const detail = fieldText(rest[1])

      // acknowledgements are flow control, not status, and there is one per 512 bytes:
      // recording them floods the history, and one push was enough to evict `child-down`
      // from a fifty-entry ring
      if (code === 'payload-ack') {
        // only the chunk we are waiting on advances the transfer, so a duplicate or a late
        // ack is harmless
        if (a.transfer && Number(detail) === a.transfer.seq) {
          a.transfer = { seq: a.transfer.seq + 1, sentAt: now }
          sends.push(chunkFrame(a, a.transfer.seq))
          // the END frame is the last thing we send, so stop tracking after it
          if (a.transfer.seq * CHUNK_BYTES >= a.wantBytes.length)
            a.transfer = null
        }
        break
      }

      // the parent's count of frames it could not send: a reply it failed to encode looks
      // exactly like a call that was never answered, so the number is the only way to tell
      // those apart. optional, since older parents omit it
      const dropped = fieldInt(rest[2])
      a.statuses.push({
        code,
        detail,
        at: now,
        ...(dropped ? { droppedByGuest: dropped } : {}),
      })
      if (a.statuses.length > 50) a.statuses.shift()
      events.push({ type: 'status', code, detail })
      if (code === 'push-failed') a.transfer = null

      // a failed transfer is not retried, since the same bytes would fail the same way, but
      // a child that ran and then died is different: the parent may need the bytes again, so
      // allow one fresh push and rely on the parent's own backoff to prevent a crash loop
      if (code === 'child-down') {
        a.hash = ''
        a.pushedHash = null
        a.transfer = null
        setState('parent')
      }
      break
    }

    case TYPES.PING:
      sends.push({ type: TYPES.PONG, fields: [a.epoch, fieldText(rest[0])] })
      break

    case TYPES.PONG:
      break

    case TYPES.REPLY: {
      const id = fieldInt(rest[0])
      if (id === null) return drop('bad call id')
      const call = a.pending.get(id)
      // a reply to a call this page never made: the mid-RPC snapshot artifact
      if (!call) return drop('unmatched call id')
      a.pending.delete(id)
      events.push({
        type: 'reply',
        id,
        fn: call.fn,
        ok: fieldText(rest[1]) === '1',
        data: rest.slice(2).map(fieldText),
      })
      break
    }

    case TYPES.EVENT: {
      const name = fieldText(rest[0])
      if (!name) return drop('unnamed event')
      events.push({ type: 'event', name, data: rest.slice(1).map(fieldText) })
      break
    }

    default:
      // unknown types, and the guest-only ones (RESET, ANNOUNCE, PAYLOAD_*), are not ours
      return drop(`unhandled type 0x${frame.type.toString(16)}`)
  }

  return { sends, events, dropped: null }
}

export function onTick(a, now) {
  const sends = []
  const events = []

  if (a.state === 'idle') {
    a.state = 'looking'
    a.lookingSince = now
    a.lastAnnounce = now
    sends.push({ type: TYPES.RESET, fields: [] }, announce(a))
    events.push({ type: 'state', state: 'looking' })
  } else if (a.state === 'looking' || a.state === 'absent') {
    if (a.state === 'looking' && now - a.lookingSince >= ABSENT_AFTER_MS) {
      a.state = 'absent'
      events.push({ type: 'state', state: 'absent' })
    }
    const every = a.state === 'absent' ? SLOW_ANNOUNCE_MS : ANNOUNCE_MS
    if (now - a.lastAnnounce >= every) {
      a.lastAnnounce = now
      sends.push(announce(a))
    }
  }

  // a connection quiet this long is gone (the guest rebooted, or the agent died), so forget
  // every belief about it, including that we already pushed a child
  if ((a.state === 'parent' || a.state === 'ready') && a.lastHeard !== null) {
    if (now - a.lastHeard >= LOST_AFTER_MS) {
      a.role = null
      a.hash = ''
      a.caps = []
      a.pushedHash = null
      a.transfer = null
      a.state = 'looking'
      a.lookingSince = now
      a.lastAnnounce = now
      sends.push({ type: TYPES.RESET, fields: [] }, announce(a))
      events.push({ type: 'state', state: 'looking' })
      return { sends, events }
    }
    if (now - Math.max(a.lastHeard, a.lastPing ?? 0) >= IDLE_PING_MS) {
      a.lastPing = now
      sends.push({ type: TYPES.PING, fields: [a.epoch, String(now % 100000)] })
    }
  }

  if (a.transfer && now - a.transfer.sentAt >= CHUNK_ACK_MS) {
    a.transfer = null
    events.push({
      type: 'status',
      code: 'push-timeout',
      detail: 'no acknowledgement from the guest',
    })
  }

  for (const [id, call] of [...a.pending])
    if (now - call.at >= CALL_TIMEOUT_MS) {
      a.pending.delete(id)
      events.push({
        type: 'reply',
        id,
        fn: call.fn,
        ok: false,
        data: ['timeout'],
      })
    }

  return { sends, events }
}

// { id, frame }, or null when there is no child to ask, so a caller never queues work at a
// machine that cannot answer
export function call(a, fn, args = [], now = 0) {
  if (a.state !== 'ready') return null
  const id = a.nextCallId++
  a.pending.set(id, { fn, at: now })
  return {
    id,
    frame: { type: TYPES.CALL, fields: [a.epoch, String(id), fn, ...args] },
  }
}

// a new deploy while the page is open: re-announce so the parent learns the new hash, and
// allow one push of the new bytes
export function setWanted(a, { hash, bytes }) {
  a.wantHash = hash
  a.wantBytes = bytes
  a.pushedHash = null
  if (a.state === 'ready' && a.hash !== hash) a.state = 'parent'
  return a.state === 'idle' ? [] : [announce(a)]
}
