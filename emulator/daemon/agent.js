// The host side of the agent connection, as pure transitions.
//
// Same reasoning as session.js: every bug in the save feature lived in stateful glue that
// needed a DOM, an emulator and IndexedDB to reach, so this file takes facts in and returns
// decisions out. Nothing here touches the emulator, the clock or the network — `link.js`
// does that, and `now` is always passed in.
//
// What it has to survive, per PROTOCOL.md:
//   - no agent at all, forever (every v1 world; must stay quiet and healthy)
//   - an agent that answers late, or never
//   - a snapshot restored mid-conversation, so frames arrive from a previous page's epoch
//   - the same save restored into two tabs, each with its own epoch
//   - duplicate IDENTs, replies to calls nobody made, pushes that fail
// The rule throughout: anything unrecognised is dropped, never fatal.

import { TYPES, withFields, fieldText, fieldInt } from './frame.js'

export const PROTO = 1

// How the host reports the connection to the rest of the page.
//   'idle'      nothing sent yet
//   'looking'   announcing, no answer yet
//   'absent'    long enough without an answer that we assume no agent exists
//   'parent'    a parent answered, no usable child yet
//   'ready'     a child is running the build we want
// Exported because the fuzz test asserts the machine can never leave this set.
export const STATES = ['idle', 'looking', 'absent', 'parent', 'ready']

// Announce every 2s while looking, then back off once we conclude nothing is there. A v1
// world has no agent and never will, so the slow rate exists only to catch one that appears
// later (after a Force Reboot, say).
export const ANNOUNCE_MS = 2000
export const ABSENT_AFTER_MS = 15000
export const SLOW_ANNOUNCE_MS = 30000

// Bytes per PAYLOAD_DATA frame.
//
// Small, and sent one at a time waiting for an acknowledgement, because of a layer the
// protocol cannot see. v86's emulated UART cannot drop bytes, which made an unpaced push
// look safe, but Windows' own serial driver sits behind it and a host write arrives as
// fast as the guest takes interrupts. Pushing a 21 KB binary in one burst overran that
// driver and left the guest holding the port and deaf to everything. One chunk in flight
// removes the race instead of guessing at a rate that might be slow enough.
export const CHUNK_BYTES = 512

// How long to wait for a chunk to be acknowledged before giving up on the transfer. The
// guest is not slow, it is just paced; a silence this long means something is wrong, and
// abandoning beats hanging.
export const CHUNK_ACK_MS = 4000

// A call that gets no reply in this long is failed, so a wedged child cannot leak pending
// calls forever.
export const CALL_TIMEOUT_MS = 10000

// Once identified the host stops announcing, so it needs another way to notice the guest
// going away. It pings a quiet connection, and if nothing answers for long enough it
// forgets everything it believed and starts looking again.
//
// This is not hypothetical. Force Reboot is a button in the toolbar: it restarts Windows
// without reloading the page, so the agent that was happily "connected" is talking to a
// machine that no longer exists. Worse, it still believed it had pushed the child, so even
// once rediscovered it would not have pushed again.
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

// One chunk, addressed by sequence number, or the END frame once the bytes run out.
function chunkFrame(a, seq) {
  const at = seq * CHUNK_BYTES
  if (at >= a.wantBytes.length)
    return { type: TYPES.PAYLOAD_END, fields: [a.epoch, a.wantHash] }
  return {
    type: TYPES.PAYLOAD_DATA,
    fields: [a.epoch, String(seq), a.wantBytes.subarray(at, at + CHUNK_BYTES)],
  }
}

// Start a transfer: the header plus the first chunk. Everything after that is driven by
// acknowledgements, one chunk in flight at a time.
function pushChild(a, now) {
  if (!a.wantBytes || !a.wantHash) return []
  // The point of the hash: a child already running what we want is left alone, so a
  // reload does not tear down a working tracker.
  if (a.hash === a.wantHash) return []
  // One attempt per hash: if the parent reports it failed, we do not spin.
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

// A frame arrived. Returns { sends, events, dropped } and mutates `a`.
//
// Frames from another epoch are dropped outright: that is the whole defence against a
// snapshot restored mid-conversation, and against two tabs restoring the same machine.
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
      // A duplicate IDENT is idempotent: same fields in, same state out, and pushChild
      // refuses to re-send bytes for a hash it already sent.
      setState(role === 'child' && a.hash === a.wantHash ? 'ready' : 'parent')
      sends.push(...pushChild(a, now))
      break
    }

    case TYPES.STATUS: {
      const code = fieldText(rest[0])
      const detail = fieldText(rest[1])

      // Acknowledgements are flow control, not status, and there is one per 512 bytes.
      // Recording them would flood the history and evict the things worth keeping: a
      // single push was enough to push `child-down` out of a fifty-entry ring, which is
      // how this was found. Handled and dropped before anything else sees them.
      if (code === 'payload-ack') {
        // Only the chunk we are actually waiting on advances the transfer, so a duplicate
        // or a late ack is harmless.
        if (a.transfer && Number(detail) === a.transfer.seq) {
          a.transfer = { seq: a.transfer.seq + 1, sentAt: now }
          sends.push(chunkFrame(a, a.transfer.seq))
          // The END frame is the last thing we send, so stop tracking after it.
          if (a.transfer.seq * CHUNK_BYTES >= a.wantBytes.length)
            a.transfer = null
        }
        break
      }

      // The parent's count of frames it could not send. A reply it failed to encode looks
      // to us exactly like a call that was never answered, so the number is the only way to
      // tell those apart. Absent from older parents, which is why it is optional.
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

      // A failed *transfer* is not retried: the same bytes would fail the same way, and
      // whatever child was already running keeps running. A child that ran and then died
      // is different — the parent may need the bytes again — so allow one fresh push and
      // rely on the parent's own backoff to prevent a crash loop.
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
      // A reply to a call this page never made: the mid-RPC-snapshot artifact.
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
      // Unknown types, and the guest-only ones (RESET, ANNOUNCE, PAYLOAD_*), are not ours.
      return drop(`unhandled type 0x${frame.type.toString(16)}`)
  }

  return { sends, events, dropped: null }
}

// Time passed. Announces while looking, concludes absence, and fails calls that will never
// be answered.
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

  // A connection that has gone quiet for too long is gone: the guest rebooted, or the
  // agent died. Forget every belief about it, including that we already pushed a child,
  // and go back to announcing so a fresh guest is found and given one.
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

  // A chunk that is never acknowledged abandons the transfer rather than hanging on it.
  // The guest is paced, not slow, so silence this long means something is actually wrong.
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

// Ask the child to run a function. Returns { id, frame } or null when there is no child to
// ask, so a caller never queues work at a machine that cannot answer.
export function call(a, fn, args = [], now = 0) {
  if (a.state !== 'ready') return null
  const id = a.nextCallId++
  a.pending.set(id, { fn, at: now })
  return {
    id,
    frame: { type: TYPES.CALL, fields: [a.epoch, String(id), fn, ...args] },
  }
}

// The build the host wants changed (a new deploy while the page is open). Re-announce so
// the parent learns the new hash, and allow one push of the new bytes.
export function setWanted(a, { hash, bytes }) {
  a.wantHash = hash
  a.wantBytes = bytes
  a.pushedHash = null
  if (a.state === 'ready' && a.hash !== hash) a.state = 'parent'
  return a.state === 'idle' ? [] : [announce(a)]
}
