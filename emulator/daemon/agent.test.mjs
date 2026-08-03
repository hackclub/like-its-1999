// node --test emulator/daemon/agent.test.mjs
//
// The host's connection state machine. The named tests are the hazards PROTOCOL.md commits
// to surviving; the sweep at the end asserts the invariants hold for every ordering of
// them, because that is where the save feature's bugs lived.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createAgent,
  onFrame,
  onTick,
  call,
  setWanted,
  PROTO,
  STATES,
  ANNOUNCE_MS,
  ABSENT_AFTER_MS,
  SLOW_ANNOUNCE_MS,
  CALL_TIMEOUT_MS,
  CHUNK_BYTES,
  CHUNK_ACK_MS,
  IDLE_PING_MS,
  LOST_AFTER_MS,
} from './agent.js'
import { TYPES, encodeFields, decodeFields, fieldText } from './frame.js'

const WANT = 'abc123'
const bytes = (n) => Uint8Array.from({ length: n }, (_, i) => i & 0xff)

// Frames as they arrive from the wire: type plus an encoded field payload.
const inbound = (type, fields) => ({ type, payload: encodeFields(fields) })
const ident = (epoch, role, hash, extra = {}) =>
  inbound(TYPES.IDENT, [
    epoch,
    role,
    String(extra.proto ?? PROTO),
    extra.ver ?? '1.0',
    hash,
    extra.caps ?? 'win,health',
  ])

const start = (over = {}) => {
  const a = createAgent({
    epoch: 'e1',
    wantHash: WANT,
    wantBytes: bytes(100),
    ...over,
  })
  onTick(a, 0) // idle -> looking
  return a
}
const sentTypes = (r) => r.sends.map((s) => s.type)
const fieldsOf = (send) =>
  send.fields.map((f) => (typeof f === 'string' ? f : '<bytes>'))

// --- announcing and absence -----------------------------------------------------

test('the first tick resets the stream and announces', () => {
  const a = createAgent({ epoch: 'e1', wantHash: WANT })
  const r = onTick(a, 0)
  assert.deepEqual(sentTypes(r), [TYPES.RESET, TYPES.ANNOUNCE])
  assert.equal(a.state, 'looking')
  // The announce carries the epoch and the hash we want, so a parent can answer both.
  assert.deepEqual(fieldsOf(r.sends[1]), ['e1', String(PROTO), WANT])
})

test('announces on an interval, then concludes absence and slows down', () => {
  const a = start()
  assert.deepEqual(sentTypes(onTick(a, 500)), [], 'not yet due')
  assert.deepEqual(sentTypes(onTick(a, ANNOUNCE_MS)), [TYPES.ANNOUNCE])

  const gaveUp = onTick(a, ABSENT_AFTER_MS)
  assert.equal(a.state, 'absent')
  assert.ok(gaveUp.events.some((e) => e.state === 'absent'))

  // Absent is a quiet, healthy state: it keeps looking, just rarely.
  const t = ABSENT_AFTER_MS
  assert.deepEqual(sentTypes(onTick(a, t + 1000)), [])
  assert.deepEqual(sentTypes(onTick(a, t + SLOW_ANNOUNCE_MS)), [TYPES.ANNOUNCE])
})

test('an agent that appears after we gave up still connects', () => {
  const a = start()
  onTick(a, ABSENT_AFTER_MS)
  assert.equal(a.state, 'absent')
  onFrame(a, ident('e1', 'child', WANT), 20000)
  assert.equal(a.state, 'ready')
})

// --- identification and pushing --------------------------------------------------

test('a child already running the wanted build needs no push', () => {
  const a = start()
  const r = onFrame(a, ident('e1', 'child', WANT), 100)
  assert.equal(a.state, 'ready')
  assert.deepEqual(sentTypes(r), [], 'nothing to do')
  assert.deepEqual(a.caps, ['win', 'health'])
  assert.equal(a.ver, '1.0')
})

test('a transfer is paced: one chunk out, then one per acknowledgement', () => {
  // Not an optimisation. An unpaced push overran Windows' serial driver in the real guest
  // and left it holding the port and deaf, so only one chunk is ever in flight.
  const total = CHUNK_BYTES * 2 + 10
  const a = start({ wantBytes: bytes(total) })
  const r = onFrame(a, ident('e1', 'parent', ''), 100)
  assert.equal(a.state, 'parent')
  assert.deepEqual(sentTypes(r), [TYPES.PAYLOAD_BEGIN, TYPES.PAYLOAD_DATA])
  assert.equal(
    r.sends[0].fields[2],
    String(total),
    'the header declares the full length'
  )
  assert.equal(r.sends[1].fields[1], '0', 'starting at chunk zero')

  // Each acknowledgement releases exactly one more chunk, in order, ending with END.
  const ack = (seq, at) =>
    onFrame(a, inbound(TYPES.STATUS, ['e1', 'payload-ack', String(seq)]), at)

  let r1 = ack(0, 200)
  assert.deepEqual(sentTypes(r1), [TYPES.PAYLOAD_DATA])
  assert.equal(r1.sends[0].fields[1], '1')

  let r2 = ack(1, 300)
  assert.deepEqual(sentTypes(r2), [TYPES.PAYLOAD_DATA])
  assert.equal(r2.sends[0].fields[1], '2')

  const r3 = ack(2, 400)
  assert.deepEqual(sentTypes(r3), [TYPES.PAYLOAD_END])
  assert.equal(a.transfer, null, 'and the transfer is finished')

  // A late duplicate acknowledgement does not push anything further.
  assert.deepEqual(sentTypes(ack(2, 500)), [])
})

test('an acknowledgement for the wrong chunk does not advance the transfer', () => {
  const a = start({ wantBytes: bytes(CHUNK_BYTES * 3) })
  onFrame(a, ident('e1', 'parent', ''), 100)
  const r = onFrame(a, inbound(TYPES.STATUS, ['e1', 'payload-ack', '7']), 200)
  assert.deepEqual(
    sentTypes(r),
    [],
    'nothing sent for a chunk we are not waiting on'
  )
  assert.equal(a.transfer.seq, 0, 'still waiting on chunk zero')
})

test('a transfer whose chunks are never acknowledged is abandoned, not hung', () => {
  const a = start({ wantBytes: bytes(CHUNK_BYTES * 4) })
  onFrame(a, ident('e1', 'parent', ''), 100)
  assert.ok(a.transfer, 'a chunk is in flight')

  assert.deepEqual(onTick(a, 100 + CHUNK_ACK_MS - 1).events, [], 'not yet')
  const r = onTick(a, 100 + CHUNK_ACK_MS)
  assert.equal(a.transfer, null)
  assert.ok(
    r.events.some((e) => e.type === 'status' && e.code === 'push-timeout'),
    'and it says so rather than going quiet'
  )
})

test('a child running the wrong build is replaced', () => {
  const a = start()
  const r = onFrame(a, ident('e1', 'child', 'oldhash'), 100)
  assert.equal(a.state, 'parent', 'not ready: the build is wrong')
  assert.ok(sentTypes(r).includes(TYPES.PAYLOAD_BEGIN))
})

test('a duplicate IDENT is idempotent and does not re-push', () => {
  const a = start()
  const first = onFrame(a, ident('e1', 'parent', ''), 100)
  assert.ok(sentTypes(first).includes(TYPES.PAYLOAD_BEGIN))
  const again = onFrame(a, ident('e1', 'parent', ''), 200)
  assert.deepEqual(sentTypes(again), [], 'the same bytes are not sent twice')
  assert.equal(a.state, 'parent')
})

test('a failed push is not retried, and the old child keeps running', () => {
  const a = start()
  onFrame(a, ident('e1', 'child', 'oldhash'), 100)
  const r = onFrame(
    a,
    inbound(TYPES.STATUS, ['e1', 'push-failed', 'bad hash']),
    200
  )
  assert.ok(
    r.events.some((e) => e.type === 'status' && e.code === 'push-failed')
  )
  // Another IDENT must not start the same doomed transfer again.
  assert.deepEqual(
    sentTypes(onFrame(a, ident('e1', 'child', 'oldhash'), 300)),
    []
  )
})

test('a new deploy mid-session re-announces and allows one fresh push', () => {
  const a = start()
  onFrame(a, ident('e1', 'child', WANT), 100)
  assert.equal(a.state, 'ready')
  const sends = setWanted(a, { hash: 'newhash', bytes: bytes(10) })
  assert.deepEqual(
    sends.map((s) => s.type),
    [TYPES.ANNOUNCE]
  )
  assert.equal(a.state, 'parent', 'no longer running what we want')
  assert.ok(
    sentTypes(onFrame(a, ident('e1', 'parent', ''), 200)).includes(
      TYPES.PAYLOAD_BEGIN
    )
  )
})

test('with no bytes to push, a parent-only machine simply stays unready', () => {
  const a = start({ wantBytes: null })
  const r = onFrame(a, ident('e1', 'parent', ''), 100)
  assert.deepEqual(sentTypes(r), [])
  assert.equal(a.state, 'parent')
})

// --- the snapshot hazards --------------------------------------------------------

test('frames from another epoch are dropped', () => {
  // A save restored mid-conversation: the queued tail belongs to a previous page.
  const a = start()
  const r = onFrame(a, ident('OLD-EPOCH', 'child', WANT), 100)
  assert.equal(r.dropped, 'stale epoch')
  assert.equal(a.state, 'looking', 'state untouched')
  assert.equal(
    a.lastHeard,
    null,
    'and it does not even count as hearing something'
  )
})

test('a reply to a call this page never made is dropped', () => {
  const a = start()
  onFrame(a, ident('e1', 'child', WANT), 100)
  const r = onFrame(a, inbound(TYPES.REPLY, ['e1', '99', '1', 'stale']), 200)
  assert.equal(r.dropped, 'unmatched call id')
  assert.deepEqual(r.events, [])
})

test('a call and its reply are matched by id', () => {
  const a = start()
  onFrame(a, ident('e1', 'child', WANT), 100)
  const c = call(a, 'getForeground', [], 100)
  assert.equal(c.frame.type, TYPES.CALL)
  assert.deepEqual(c.frame.fields, ['e1', '1', 'getForeground'])

  const r = onFrame(
    a,
    inbound(TYPES.REPLY, [
      'e1',
      String(c.id),
      '1',
      'EDITPLUS.EXE',
      'a - EditPlus',
    ]),
    150
  )
  assert.deepEqual(r.events, [
    {
      type: 'reply',
      id: c.id,
      fn: 'getForeground',
      ok: true,
      data: ['EDITPLUS.EXE', 'a - EditPlus'],
    },
  ])
  assert.equal(a.pending.size, 0)
})

test('a call with no child to answer it is refused rather than queued', () => {
  const a = start()
  assert.equal(call(a, 'health', [], 0), null)
  onFrame(a, ident('e1', 'parent', ''), 100)
  assert.equal(call(a, 'health', [], 100), null, 'a parent is not a child')
})

test('a call that is never answered fails on a timeout', () => {
  const a = start()
  onFrame(a, ident('e1', 'child', WANT), 0)
  const c = call(a, 'exec', ['dir'], 0)
  assert.deepEqual(onTick(a, CALL_TIMEOUT_MS - 1).events, [])
  const r = onTick(a, CALL_TIMEOUT_MS)
  assert.deepEqual(r.events, [
    { type: 'reply', id: c.id, fn: 'exec', ok: false, data: ['timeout'] },
  ])
  assert.equal(a.pending.size, 0)
})

test('a child dying drops us back to parent, and a new one makes us ready again', () => {
  const a = start()
  onFrame(a, ident('e1', 'child', WANT), 100)
  const down = onFrame(
    a,
    inbound(TYPES.STATUS, ['e1', 'child-down', 'exit 1']),
    200
  )
  assert.equal(a.state, 'parent')
  assert.ok(down.events.some((e) => e.type === 'state' && e.state === 'parent'))
  onFrame(a, ident('e1', 'child', WANT), 300)
  assert.equal(a.state, 'ready')
})

test('a guest PING is answered with its own token', () => {
  const a = start()
  const r = onFrame(a, inbound(TYPES.PING, ['e1', '42']), 100)
  assert.equal(r.sends[0].type, TYPES.PONG)
  assert.deepEqual(r.sends[0].fields, ['e1', '42'])
})

test('malformed and foreign frames are dropped, never fatal', () => {
  const a = start()
  const cases = [
    {
      frame: { type: TYPES.IDENT, payload: Uint8Array.of(9, 9, 9) },
      why: /field list/,
    },
    { frame: ident('e1', 'wizard', WANT), why: /role/ },
    { frame: ident('e1', 'child', WANT, { proto: 'x' }), why: /proto/ },
    { frame: inbound(TYPES.REPLY, ['e1', 'notanumber', '1']), why: /call id/ },
    { frame: inbound(TYPES.EVENT, ['e1', '']), why: /unnamed/ },
    { frame: inbound(TYPES.ANNOUNCE, ['e1']), why: /unhandled/ },
    { frame: inbound(0x77, ['e1']), why: /unhandled/ },
  ]
  for (const { frame, why } of cases) {
    const r = onFrame(a, frame, 100)
    assert.match(r.dropped, why)
    assert.deepEqual(r.events, [])
  }
  assert.equal(a.state, 'looking', 'nothing shifted the state machine')
})

// --- invariants over every ordering ---------------------------------------------

test('no sequence of frames can leave the agent in a bad state', () => {
  const inputs = [
    () => ident('e1', 'child', WANT),
    () => ident('e1', 'child', 'other'),
    () => ident('e1', 'parent', ''),
    () => ident('OLD', 'child', WANT),
    () => inbound(TYPES.STATUS, ['e1', 'child-down', '']),
    () => inbound(TYPES.STATUS, ['e1', 'push-failed', '']),
    () => inbound(TYPES.EVENT, ['e1', 'win', 'A.EXE', 'a']),
    () => inbound(TYPES.REPLY, ['e1', '1', '1', 'x']),
    () => inbound(TYPES.PING, ['e1', '1']),
    () => ({ type: TYPES.IDENT, payload: Uint8Array.of(1, 2, 3) }),
  ]

  let checked = 0
  for (let i = 0; i < inputs.length; i++)
    for (let j = 0; j < inputs.length; j++)
      for (let k = 0; k < inputs.length; k++) {
        const a = start()
        let now = 0
        for (const make of [inputs[i], inputs[j], inputs[k]]) {
          now += 100
          const r = onFrame(a, make(), now)
          assert.ok(STATES.includes(a.state))
          // Every send must be addressed to this epoch, or the guest will drop it.
          for (const s of r.sends)
            assert.equal(
              typeof s.fields[0] === 'string' ? s.fields[0] : 'e1',
              'e1',
              `send on ${a.state}`
            )
          // Bytes are only ever offered once per hash.
          assert.ok(a.pushedHash === null || a.pushedHash === a.wantHash)
        }
        onTick(a, now + 100)
        assert.ok(STATES.includes(a.state))
        checked++
      }
  assert.equal(checked, 1000)
})

test('a payload chunk always fits in a frame', () => {
  const a = start({ wantBytes: bytes(CHUNK_BYTES * 3) })
  const r = onFrame(a, ident('e1', 'parent', ''), 100)
  for (const s of r.sends)
    if (s.type === TYPES.PAYLOAD_DATA) {
      const encoded = encodeFields(s.fields)
      assert.ok(encoded.length <= 65536, `chunk frame ${encoded.length}`)
      const back = decodeFields(encoded)
      assert.equal(fieldText(back[0]), 'e1')
    }
})

// --- losing the guest -------------------------------------------------------------

test('a quiet connection is pinged, and a dead one is rediscovered', () => {
  // Force Reboot restarts Windows without reloading the page, so a connected agent can be
  // talking to a machine that no longer exists. Before this, it stayed "connected" forever
  // and never announced again, and its belief that it had already pushed the child meant
  // it would not have pushed to the replacement either.
  const a = start()
  onFrame(a, ident('e1', 'child', WANT), 1000)
  assert.equal(a.state, 'ready')

  // Quiet but alive: it gets pinged rather than abandoned.
  assert.deepEqual(sentTypes(onTick(a, 1000 + IDLE_PING_MS - 1)), [])
  assert.deepEqual(sentTypes(onTick(a, 1000 + IDLE_PING_MS)), [TYPES.PING])
  assert.equal(a.state, 'ready')

  // Still nothing after long enough: forget it and start looking again.
  const lost = onTick(a, 1000 + LOST_AFTER_MS)
  assert.equal(a.state, 'looking')
  assert.deepEqual(sentTypes(lost), [TYPES.RESET, TYPES.ANNOUNCE])
  assert.ok(lost.events.some((e) => e.state === 'looking'))
  assert.equal(a.hash, '', 'and forgets what was running')
  assert.equal(
    a.pushedHash,
    null,
    'including that it had pushed, so it pushes again'
  )

  // A replacement guest is picked up and gets the binary.
  const r = onFrame(a, ident('e1', 'parent', ''), 1000 + LOST_AFTER_MS + 100)
  assert.ok(sentTypes(r).includes(TYPES.PAYLOAD_BEGIN))
})

test('an answered ping keeps the connection alive indefinitely', () => {
  const a = start()
  onFrame(a, ident('e1', 'child', WANT), 0)
  let t = 0
  for (let i = 0; i < 20; i++) {
    t += IDLE_PING_MS
    const r = onTick(a, t)
    // The guest answers every ping, so we never conclude it is gone.
    if (r.sends.some((s) => s.type === TYPES.PING))
      onFrame(a, inbound(TYPES.PONG, ['e1', '1']), t + 5)
  }
  assert.equal(a.state, 'ready')
})
