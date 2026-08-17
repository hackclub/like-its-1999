// node --test emulator/daemon/conversation.test.mjs
//
// the host and a fake guest talking over encoded bytes: the unit tests check each side's
// decisions alone, these check that the two halves agree

import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as agentModule from './agent.js'
import { createAgent, ABSENT_AFTER_MS, CHUNK_BYTES } from './agent.js'
import { connect } from './fakeguest.mjs'
import { TYPES, encode } from './frame.js'

const HASH = 'sha256-of-the-child'
const child = (n = 1000) =>
  Uint8Array.from({ length: n }, (_, i) => (i * 7) & 0xff)

const setup = (guestOptions = {}, agentOptions = {}) => {
  const agent = createAgent({
    epoch: 'e1',
    wantHash: HASH,
    wantBytes: child(),
    ...agentOptions,
  })
  return { agent, link: connect(agentModule, agent, guestOptions) }
}

test('a cold machine gets the child pushed, runs it, and becomes callable', () => {
  const { agent, link } = setup({ role: 'parent', hash: '' })
  link.tick(0) // reset + announce -> parent identifies -> host pushes -> child identifies

  assert.equal(link.guest.state.received.length, 1, 'the binary arrived')
  assert.deepEqual(link.guest.state.received[0].bytes, child())
  assert.equal(link.guest.state.received[0].hash, HASH)
  assert.equal(agent.state, 'ready')
  assert.equal(agent.hash, HASH)
  assert.ok(link.call('getForeground'), 'a call goes out once ready')
})

test('a call round trips through real bytes', () => {
  const { link } = setup({
    role: 'child',
    hash: HASH,
    handlers: {
      getForeground: () => ['EDITPLUS.EXE', 'index.html - EditPlus'],
    },
  })
  link.tick(0)
  const c = link.call('getForeground')
  const reply = link.events.find((e) => e.type === 'reply' && e.id === c.id)
  assert.equal(reply.ok, true)
  assert.deepEqual(reply.data, ['EDITPLUS.EXE', 'index.html - EditPlus'])
})

test('a title full of protocol-hostile characters survives the wire', () => {
  // why payloads are length-prefixed rather than delimited text
  const nasty = 'C:\\Docs\\a\tb\nc"99"\\ - EditPlus'
  const { link } = setup({
    role: 'child',
    hash: HASH,
    handlers: { getForeground: () => ['EDITPLUS.EXE', nasty] },
  })
  link.tick(0)
  const c = link.call('getForeground')
  assert.equal(link.events.find((e) => e.id === c.id).data[1], nasty)
})

test('an unknown function is refused rather than dropped', () => {
  const { link } = setup({ role: 'child', hash: HASH, handlers: {} })
  link.tick(0)
  const c = link.call('nosuchthing')
  const reply = link.events.find((e) => e.type === 'reply' && e.id === c.id)
  assert.equal(reply.ok, false)
})

test('an unsolicited window change arrives as an event', () => {
  const { link } = setup({ role: 'child', hash: HASH })
  link.tick(0)
  link.guest.event('win', 'PSP.EXE', 'Paint Shop Pro')
  const ev = link.events.find((e) => e.type === 'event' && e.name === 'win')
  assert.deepEqual(ev.data, ['PSP.EXE', 'Paint Shop Pro'])
})

test('a machine with no agent stays quiet and healthy', () => {
  // every v1 world looks like this, forever, and it must never read as an error
  const { agent, link } = setup({ quirks: { silent: true } })
  link.tick(0)
  link.tick(ABSENT_AFTER_MS)
  assert.equal(agent.state, 'absent')
  link.tick(ABSENT_AFTER_MS + 60000)
  assert.equal(agent.state, 'absent')
  assert.equal(agent.pending.size, 0)
  assert.equal(link.call('health'), null, 'calls refused, not queued')
})

test('an agent that wakes up late is still picked up', () => {
  const { agent, link } = setup({
    quirks: { silent: true },
    role: 'child',
    hash: HASH,
  })
  link.tick(0)
  link.tick(ABSENT_AFTER_MS)
  assert.equal(agent.state, 'absent')

  link.guest.setQuirk('silent', false)
  link.tick(ABSENT_AFTER_MS + 30000) // a slow announce reaches it
  assert.equal(agent.state, 'ready')
})

test('a reload does not disturb a child already running the wanted build', () => {
  const { agent, link } = setup({ role: 'child', hash: HASH })
  link.tick(0)
  assert.equal(agent.state, 'ready')
  assert.equal(link.guest.state.received.length, 0, 'nothing was pushed')
})

test('a stale reply replayed after a restore is ignored', () => {
  // a snapshot taken mid-call comes back and the child answers a question this page
  // never asked
  const { link } = setup({
    role: 'child',
    hash: HASH,
    handlers: { health: () => ['1.0', '1000', '0', ''] },
  })
  link.tick(0)
  const mine = link.call('health')
  link.guest.replayStaleReply('OLD-EPOCH', String(mine.id))

  const replies = link.events.filter((e) => e.type === 'reply')
  assert.equal(replies.length, 1)
  assert.deepEqual(
    replies[0].data,
    ['1.0', '1000', '0', ''],
    'the real one, not the ghost'
  )
})

test('a guest still talking in an old epoch is ignored until it adopts ours', () => {
  const { agent, link } = setup({
    role: 'child',
    hash: HASH,
    quirks: { wrongEpoch: true },
  })
  link.tick(0)
  assert.notEqual(agent.state, 'ready', 'nothing it says counts')

  link.guest.setQuirk('wrongEpoch', false)
  link.tick(2000)
  assert.equal(agent.state, 'ready')
})

test('a half frame left over from a snapshot does not block what follows', () => {
  const { agent, link } = setup({ role: 'child', hash: HASH })
  link.guest.state.epoch = 'e1'
  link.guest.halfFrame() // torn mid-transmission, as a save does
  link.tick(0)
  assert.equal(
    agent.state,
    'ready',
    'the IDENT after the debris was still found'
  )
})

test('a failed push leaves the machine usable and is not retried in a loop', () => {
  const { agent, link } = setup({
    role: 'parent',
    hash: '',
    quirks: { failPush: true },
  })
  link.tick(0)
  assert.equal(agent.state, 'parent')
  assert.ok(
    link.events.some((e) => e.type === 'status' && e.code === 'push-failed')
  )

  const before = link.guest.state.received.length
  link.tick(2000)
  link.tick(4000)
  assert.equal(link.guest.state.received.length, before, 'no push loop')
})

test('a child that dies is reported and replaced without waiting for a tick', () => {
  const { agent, link } = setup({ role: 'child', hash: HASH })
  link.tick(0)
  assert.equal(agent.state, 'ready')
  assert.equal(link.guest.state.received.length, 0, 'nothing pushed yet')

  // the parent reports the death and re-identifies, which invites the push that brings
  // the child back, all in one exchange
  link.guest.childDown()
  assert.ok(
    link.events.some((e) => e.type === 'status' && e.code === 'child-down')
  )
  assert.ok(
    link.events.some((e) => e.type === 'state' && e.state === 'parent'),
    'the drop to parent was observable'
  )
  assert.equal(link.guest.state.received.length, 1, 'a replacement was pushed')
  assert.equal(agent.state, 'ready')
})

test('a multi-chunk binary arrives byte-identical', () => {
  const big = child(CHUNK_BYTES * 2 + 777)
  const { agent, link } = setup(
    { role: 'parent', hash: '' },
    { wantBytes: big }
  )
  link.tick(0)
  assert.equal(agent.state, 'ready')
  assert.deepEqual(link.guest.state.received[0].bytes, big)
})

test('a new deploy mid-session replaces the running child', () => {
  const { agent, link } = setup({ role: 'child', hash: HASH })
  link.tick(0)
  assert.equal(agent.state, 'ready')

  const next = Uint8Array.from({ length: 50 }, () => 9)
  for (const frame of agentModule.setWanted(agent, {
    hash: 'v2hash',
    bytes: next,
  }))
    link.guest.feed(encode(frame.type, frame.fields))

  link.tick(2000)
  assert.equal(agent.hash, 'v2hash')
  assert.deepEqual(link.guest.state.received.at(-1).bytes, next)
  assert.equal(agent.state, 'ready')
})

test('the guest sees exactly one reset per page load', () => {
  const { link } = setup({ role: 'child', hash: HASH })
  link.tick(0)
  link.tick(2000)
  link.tick(4000)
  assert.equal(link.guest.state.resets, 1)
})

test('a PING from the guest is answered with its own token', () => {
  const { link } = setup({ role: 'child', hash: HASH })
  link.tick(0)
  link.guest.send(TYPES.PING, '77')
  const pong = link.guest.state.sent.filter((f) => f.type === TYPES.PING)
  assert.equal(pong.length, 1, 'the guest pinged')
  // the host's PONG goes back through the same wire; the guest ignores it without error
  assert.equal(link.guest.state.resets, 1)
})

test('stray payload frames without a BEGIN are ignored', () => {
  const { agent, link } = setup({ role: 'child', hash: HASH })
  link.tick(0)
  link.guest.feed(encode(TYPES.PAYLOAD_DATA, ['e1', '0', new Uint8Array(10)]))
  link.guest.feed(encode(TYPES.PAYLOAD_END, ['e1', 'whatever']))
  assert.equal(link.guest.state.received.length, 0)
  assert.equal(agent.state, 'ready', 'and the connection is unharmed')
})
