// A guest that speaks the protocol, for testing the host half without a VM.
//
// It plays parent and child together, because from the host's side that distinction is
// only ever a `role` field and which frames come back. What makes it useful is the
// `quirks`: the failure modes PROTOCOL.md promises to survive are hard to provoke in a
// real guest and trivial here.
//
// Not a reference implementation. The C parent is the real one; this exists to make the
// host's state machine face a peer that misbehaves on demand.

import {
  TYPES,
  encode,
  createDecoder,
  withFields,
  fieldText,
  fieldInt,
} from './frame.js'

export function createFakeGuest({
  role = 'parent',
  hash = '',
  ver = '1.0',
  caps = 'win,health,exec',
  onSend = () => {},
  handlers = {},
  quirks = {},
} = {}) {
  const decoder = createDecoder()
  const g = {
    role,
    hash,
    ver,
    caps,
    epoch: null, // adopted from the most recent ANNOUNCE
    transfer: null, // { hash, len, got, seqs }
    received: [], // completed pushes, for assertions
    sent: [], // frames emitted, decoded, for assertions
    resets: 0,
    quirks: {
      silent: false, // never answer anything
      wrongEpoch: false, // echo a bogus epoch, as a pre-restore frame would
      failPush: false, // report push-failed instead of running the child
      dropIdent: false, // ignore ANNOUNCE but answer everything else
      dropAcks: false, // take chunks but never acknowledge them
      ...quirks,
    },
  }

  const emit = (type, fields) => {
    if (g.quirks.silent) return
    const epoch = g.quirks.wrongEpoch ? 'STALE-EPOCH' : (fields[0] ?? g.epoch)
    const out = [epoch, ...fields.slice(1)]
    g.sent.push({ type, fields: out })
    onSend(encode(type, out))
  }

  const identify = () =>
    emit(TYPES.IDENT, [g.epoch, g.role, '1', g.ver, g.hash, g.caps])

  const handle = (frame) => {
    const withF = withFields(frame)
    if (!withF) return
    const [epochField, ...rest] = withF.fields
    const epoch = fieldText(epochField)

    switch (frame.type) {
      case TYPES.RESET:
        g.resets++
        g.transfer = null
        decoder.reset()
        return

      case TYPES.ANNOUNCE:
        // The guest always adopts the host's epoch: a fresh page wins over whatever a
        // restored snapshot was mid-conversation with.
        g.epoch = epoch
        if (!g.quirks.dropIdent) identify()
        return

      default:
        // Everything else is answered in the host's epoch, whatever we think ours is.
        break
    }

    if (frame.type === TYPES.PAYLOAD_BEGIN) {
      const [h, len] = [fieldText(rest[0]), fieldInt(rest[1])]
      // Always restart from scratch, discarding any partial transfer.
      g.transfer = { hash: h, len, got: 0, seqs: [], chunks: [] }
      return
    }

    if (frame.type === TYPES.PAYLOAD_DATA) {
      if (!g.transfer) return // stray DATA without a BEGIN
      const seq = fieldInt(rest[0])
      const bytes = rest[1] ?? new Uint8Array(0)
      g.transfer.seqs.push(seq)
      g.transfer.got += bytes.length
      g.transfer.chunks.push(bytes)
      // Acknowledge, which is what lets the host send the next one. A guest that does not
      // (quirks.dropAcks) is how the host's transfer timeout gets tested.
      if (!g.quirks.dropAcks)
        emit(TYPES.STATUS, [epoch, 'payload-ack', String(seq)])
      return
    }

    if (frame.type === TYPES.PAYLOAD_END) {
      const t = g.transfer
      g.transfer = null
      if (!t) return // stray END
      const contiguous = t.seqs.every((s, i) => s === i)
      const complete = t.got === t.len
      if (g.quirks.failPush || !contiguous || !complete) {
        emit(TYPES.STATUS, [epoch, 'push-failed', !complete ? 'short' : 'gap'])
        return
      }
      const all = new Uint8Array(t.got)
      let at = 0
      for (const c of t.chunks) {
        all.set(c, at)
        at += c.length
      }
      g.received.push({ hash: t.hash, bytes: all })
      // "Spawn" it: from here on we are the child, running that build.
      g.role = 'child'
      g.hash = t.hash
      emit(TYPES.STATUS, [epoch, 'child-up', t.hash])
      identify()
      return
    }

    if (frame.type === TYPES.PING) {
      emit(TYPES.PONG, [epoch, fieldText(rest[0])])
      return
    }

    if (frame.type === TYPES.CALL) {
      const id = fieldText(rest[0])
      const fn = fieldText(rest[1])
      const args = rest.slice(2).map(fieldText)
      const impl = handlers[fn]
      if (!impl) {
        emit(TYPES.REPLY, [epoch, id, '0', 'no such function'])
        return
      }
      const out = impl(...args)
      emit(TYPES.REPLY, [
        epoch,
        id,
        '1',
        ...(Array.isArray(out) ? out : [String(out)]),
      ])
      return
    }
  }

  return {
    state: g,

    // Bytes from the host.
    feed(bytes) {
      for (const frame of decoder.push(bytes)) handle(frame)
    },

    // Push an unsolicited event, the way a foreground change arrives.
    event(name, ...data) {
      emit(TYPES.EVENT, [g.epoch, name, ...data])
    },

    // Any frame at all, for cases the helpers don't cover.
    send(type, ...fields) {
      emit(type, [g.epoch, ...fields])
    },

    status(code, detail = '') {
      emit(TYPES.STATUS, [g.epoch, code, detail])
    },

    // The child died: the parent notices, says so, and re-identifies so the host can
    // decide whether to push a replacement (the parent cannot always respawn from cache —
    // a cold-booted machine has none, since guest writes only live in the overlay).
    childDown(detail = 'exit 1') {
      g.role = 'parent'
      g.hash = ''
      emit(TYPES.STATUS, [g.epoch, 'child-down', detail])
      identify()
    },

    // Emit a frame and cut it in half, leaving a partial frame in the host's buffer —
    // exactly what a snapshot taken mid-transmission produces.
    halfFrame(type = TYPES.EVENT, fields = ['win', 'A.EXE', 'a']) {
      const full = encode(type, [g.epoch, ...fields])
      onSend(full.subarray(0, Math.max(4, Math.floor(full.length / 2))))
    },

    // A reply addressed to a call from a previous page, replayed after a restore.
    replayStaleReply(epoch = 'OLD-EPOCH', id = '1') {
      onSend(encode(TYPES.REPLY, [epoch, id, '1', 'stale']))
    },

    setQuirk(name, value = true) {
      g.quirks[name] = value
    },
  }
}

// Wire a host agent and a fake guest into each other, so a test can drive a whole
// conversation. Frames the host wants to send are encoded and fed to the guest; bytes the
// guest emits are decoded and handed to onFrame.
export function connect(agentModule, agent, guestOptions = {}) {
  const decoder = createDecoder()
  const events = []
  let guest

  const deliverToHost = (bytes) => {
    for (const frame of decoder.push(bytes)) {
      const r = agentModule.onFrame(agent, frame, now)
      events.push(...r.events)
      send(r.sends)
    }
  }
  const send = (frames) => {
    for (const f of frames) guest.feed(encode(f.type, f.fields))
  }

  let now = 0
  guest = createFakeGuest({ ...guestOptions, onSend: deliverToHost })

  return {
    guest,
    events,
    get now() {
      return now
    },
    tick(at) {
      now = at
      const r = agentModule.onTick(agent, now)
      events.push(...r.events)
      send(r.sends)
      return r
    },
    call(fn, args = []) {
      const c = agentModule.call(agent, fn, args, now)
      if (c) send([c.frame])
      return c
    },
    // Drop the host's partial-frame buffer, the way a page reload does.
    reloadHost() {
      decoder.reset()
    },
  }
}
