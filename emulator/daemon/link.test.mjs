// node --test emulator/daemon/link.test.mjs
//
// v86's bus is a connected pair and a send goes to the *other* side's listeners, so
// counting input with `add_listener` records nothing at all; the fake below models both
// endpoints, which is the only reason a test can catch it

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createLink, TICK_MS } from './link.js'
import { encode, decode, TYPES, decodeFields, fieldText } from './frame.js'

// shaped like the real v86: `add_listener` registers on our side, devices listen on
// `bus.pair`, and a send on one endpoint is delivered to the other
function fakeEmulator() {
  const ours = new Map()
  const theirs = new Map()
  const out = []
  const call = (map, name, arg) =>
    (map.get(name) || []).forEach((fn) => fn(arg))
  const add = (map, name, fn) => map.set(name, [...(map.get(name) || []), fn])

  return {
    written: out,
    add_listener: (name, fn) => add(ours, name, fn),
    bus: { pair: { register: (name, fn) => add(theirs, name, fn) } },
    serial_send_bytes: (_port, bytes) => out.push(bytes),
    // a device emitting toward the page
    deviceSends: (name, arg) => call(ours, name, arg),
    // the page's adapters emitting toward the devices: keyboard, mouse, and so on
    userInput: (name, arg) => call(theirs, name, arg),
  }
}

const sentFrames = (emulator) =>
  decode(new Uint8Array(emulator.written.flatMap((b) => [...b]))).frames

test('input is counted from the device-side endpoint, not add_listener', (t) => {
  const emulator = fakeEmulator()
  let clock = 0
  const link = createLink({
    emulator,
    epoch: 'e1',
    instanceId: 'i1',
    now: () => clock,
  })
  t.after(() => link.stop())

  // a foreground window, so spans have somewhere to belong
  link.log.exe = 'EDITPLUS.EXE'
  link.log.win = 'a - EditPlus'

  // make codes count; break codes (bit 7) and the 0xe0 extended prefix do not, so a
  // physical keypress counts once
  emulator.userInput('keyboard-code', 0x1e) // 'a' down
  emulator.userInput('keyboard-code', 0x9e) // 'a' up
  emulator.userInput('keyboard-code', 0xe0) // extended prefix
  emulator.userInput('keyboard-code', 0x48) // arrow up
  clock = 500
  // v86 sends the state of [left, middle, right] on press and on release, and again as
  // all-false when the pointer leaves the canvas, so one click is at least two events
  emulator.userInput('mouse-click', [true, false, false])
  emulator.userInput('mouse-click', [false, false, false])
  emulator.userInput('mouse-click', [false, false, false])
  emulator.userInput('mouse-wheel', 1)

  clock = 1000
  const summary = link.summary()
  assert.equal(summary.lines, 0, 'nothing written yet: the span is still open')
  link.seal()
  const [span] = link.log.lines.filter((l) => l.ev === 'active')
  assert.equal(span.keys, 2, 'two make codes')
  assert.equal(span.clicks, 1, 'one press, however many events it took')
  assert.equal(span.wheel, 1)
  assert.equal(span.exe, 'EDITPLUS.EXE')
})

test('a machine with no agent announces, gives up quietly, and still logs input', async (t) => {
  const emulator = fakeEmulator()
  let clock = 0
  const states = []
  const link = createLink({
    emulator,
    epoch: 'e1',
    instanceId: 'i1',
    now: () => clock,
    onState: (s) => states.push(s),
  })
  t.after(() => link.stop())

  await new Promise((r) => setTimeout(r, TICK_MS + 200))
  const frames = sentFrames(emulator)
  assert.equal(frames[0].type, TYPES.RESET, 'the stream is reset first')
  assert.equal(frames[1].type, TYPES.ANNOUNCE)
  assert.deepEqual(decodeFields(frames[1].payload).map(fieldText)[0], 'e1')
  assert.deepEqual(states, ['looking'])
  assert.equal(link.state, 'looking')

  emulator.userInput('keyboard-code', 0x1e)
  link.seal()
  assert.equal(link.summary().keys, 1)
})

test('a call with no agent rejects rather than hanging', async (t) => {
  const emulator = fakeEmulator()
  const link = createLink({ emulator, epoch: 'e1', instanceId: 'i1' })
  t.after(() => link.stop())
  await assert.rejects(() => link.call('health'), /no agent/)
})

test('a reply from the guest resolves the matching call', async (t) => {
  const emulator = fakeEmulator()
  let clock = 0
  const link = createLink({
    emulator,
    epoch: 'e1',
    instanceId: 'i1',
    now: () => clock,
  })
  t.after(() => link.stop())

  // identify as a child running the (empty) wanted build, so the agent is ready
  const ident = encode(TYPES.IDENT, ['e1', 'child', '1', '1.0', '', 'win'])
  for (const b of ident) emulator.deviceSends('serial0-output-byte', b)
  assert.equal(link.state, 'ready')

  // becoming ready fires a getForeground of its own, so match on the function name:
  // replying to the wrong id leaves this waiting forever
  const pending = link.call('health')
  const call = sentFrames(emulator)
    .filter((f) => f.type === TYPES.CALL)
    .map((f) => decodeFields(f.payload).map(fieldText))
    .find((fields) => fields[2] === 'health')
  assert.ok(call, 'the call went out')

  const reply = encode(TYPES.REPLY, ['e1', call[1], '1', '0.1', '1000'])
  for (const b of reply) emulator.deviceSends('serial0-output-byte', b)
  assert.deepEqual(await pending, ['0.1', '1000'])
})

test('becoming ready asks what is in front, unprompted', async (t) => {
  // the child learns the epoch from calls it receives, so without a first call it can
  // never address an unsolicited event
  const emulator = fakeEmulator()
  const link = createLink({ emulator, epoch: 'e1', instanceId: 'i1' })
  t.after(() => link.stop())
  const ident = encode(TYPES.IDENT, ['e1', 'child', '1', '1.0', '', 'win'])
  for (const b of ident) emulator.deviceSends('serial0-output-byte', b)

  const call = sentFrames(emulator)
    .filter((f) => f.type === TYPES.CALL)
    .map((f) => decodeFields(f.payload).map(fieldText))
    .find((fields) => fields[2] === 'getForeground')
  assert.ok(call, 'it asked without being told to')

  const reply = encode(TYPES.REPLY, [
    'e1',
    call[1],
    '1',
    'EXPLORER.EXE',
    'Program Manager',
  ])
  for (const b of reply) emulator.deviceSends('serial0-output-byte', b)
  const line = link.log.lines.find((l) => l.ev === 'win')
  assert.equal(line.exe, 'EXPLORER.EXE')
})

test('a window event from the guest becomes a span in the log', (t) => {
  const emulator = fakeEmulator()
  let clock = 0
  const link = createLink({
    emulator,
    epoch: 'e1',
    instanceId: 'i1',
    now: () => clock,
  })
  t.after(() => link.stop())

  const ident = encode(TYPES.IDENT, ['e1', 'child', '1', '1.0', '', 'win'])
  for (const b of ident) emulator.deviceSends('serial0-output-byte', b)

  const ev = encode(TYPES.EVENT, [
    'e1',
    'win',
    'PSP.EXE',
    'Paint Shop Pro',
    '4242',
  ])
  for (const b of ev) emulator.deviceSends('serial0-output-byte', b)

  const line = link.log.lines.find((l) => l.ev === 'win')
  assert.equal(line.exe, 'PSP.EXE')
  assert.equal(line.win, 'Paint Shop Pro')
})

test('stopping releases pending calls instead of leaving them hanging', async (t) => {
  const emulator = fakeEmulator()
  const link = createLink({ emulator, epoch: 'e1', instanceId: 'i1' })
  t.after(() => link.stop())
  const ident = encode(TYPES.IDENT, ['e1', 'child', '1', '1.0', '', ''])
  for (const b of ident) emulator.deviceSends('serial0-output-byte', b)

  const pending = link.call('health')
  link.stop()
  await assert.rejects(() => pending, /link stopped/)
})
