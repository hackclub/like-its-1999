// node --test emulator/daemon/tracking.test.mjs
//
// The log must record enough to compute hours later under a policy we have not chosen yet,
// and must not quietly lose a span. It deliberately computes no hours, so these tests are
// about fidelity and volume rather than totals.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createLog,
  onWindow,
  onInput,
  onTick,
  onVisibility,
  onAgent,
  seal,
  toNdjson,
  fromNdjson,
  summarise,
  KEEPALIVE_MS,
  IDLE_GAP_MS,
} from './tracking.js'

const S = 1000
const M = 60 * S
const log = () => createLog({ instanceId: 'i1' })
// seal takes no time: a span always ends at the last input, never at the flush moment.
const sealAt = (l) => seal(l)
const kinds = (l) => l.lines.map((x) => x.ev)
const actives = (l) => l.lines.filter((x) => x.ev === 'active')

test('a window change is recorded once, and repeats are not', () => {
  const l = log()
  onWindow(l, { exe: 'EDITPLUS.EXE', win: 'a - EditPlus', tick: 5 }, 0)
  assert.equal(
    onWindow(l, { exe: 'EDITPLUS.EXE', win: 'a - EditPlus' }, 1000),
    null
  )
  onWindow(l, { exe: 'PSP.EXE', win: 'Paint Shop Pro' }, 2000)
  assert.deepEqual(kinds(l), ['win', 'win'])
  assert.equal(l.lines[0].tick, 5, 'the guest tick is kept as an ordering hint')
})

test('typing for a while produces a keepalive rhythm, not a line per keystroke', () => {
  const l = log()
  onWindow(l, { exe: 'EDITPLUS.EXE', win: 'a' }, 0)
  // Ten minutes of steady typing, one input event per second.
  for (let t = 0; t <= 10 * M; t += S) onInput(l, { keys: 3 }, t)
  const written = actives(l)
  assert.equal(written.length, 5, 'one per 2-minute keepalive, not 600')
  assert.ok(written.every((a) => a.exe === 'EDITPLUS.EXE'))
  assert.equal(
    written.reduce((n, a) => n + a.keys, 0),
    601 * 3,
    'every keystroke is accounted for'
  )
})

test('a span closes when input stops, and reopens when it resumes', () => {
  const l = log()
  onWindow(l, { exe: 'EDITPLUS.EXE', win: 'a' }, 0)
  onInput(l, { keys: 10 }, 0)
  onInput(l, { keys: 10 }, 30 * S)

  // Nothing for longer than the idle gap.
  assert.equal(onTick(l, 30 * S + IDLE_GAP_MS - 1), null)
  const closed = onTick(l, 30 * S + IDLE_GAP_MS)
  assert.equal(closed.why, 'idle')
  assert.equal(
    closed.t,
    30 * S,
    'the span ends at the last input, not at the timeout'
  )
  assert.equal(closed.from, 0)
  assert.equal(closed.keys, 20)

  // And a later keystroke starts a fresh span rather than extending the old one.
  onInput(l, { keys: 1 }, 60 * M)
  sealAt(l)
  const spans = actives(l)
  assert.equal(spans.length, 2)
  assert.equal(spans[1].from, 60 * M)
})

test('a window change closes the current span so time is never misattributed', () => {
  const l = log()
  onWindow(l, { exe: 'EDITPLUS.EXE', win: 'a' }, 0)
  onInput(l, { keys: 50 }, 10 * S)
  onWindow(l, { exe: 'PSP.EXE', win: 'psp' }, 20 * S)
  onInput(l, { keys: 5 }, 25 * S)
  sealAt(l)

  const spans = actives(l)
  assert.equal(spans.length, 2)
  assert.equal(spans[0].exe, 'EDITPLUS.EXE')
  assert.equal(spans[0].keys, 50)
  assert.equal(spans[1].exe, 'PSP.EXE')
  assert.equal(spans[1].keys, 5)
})

test('clicks and wheel are counted alongside keys', () => {
  const l = log()
  onWindow(l, { exe: 'PSP.EXE', win: 'psp' }, 0)
  onInput(l, { clicks: 3 }, 0)
  onInput(l, { wheel: 2, keys: 1 }, S)
  sealAt(l)
  const [span] = actives(l)
  assert.equal(span.clicks, 3)
  assert.equal(span.wheel, 2)
  assert.equal(span.keys, 1)
})

test('sealing writes the span in progress rather than losing it', () => {
  const l = log()
  onWindow(l, { exe: 'EDITPLUS.EXE', win: 'a' }, 0)
  onInput(l, { keys: 7 }, S)
  onInput(l, { keys: 3 }, 20 * S)
  assert.equal(actives(l).length, 0, 'nothing written yet')
  sealAt(l)
  assert.equal(actives(l).length, 1)
  assert.equal(actives(l)[0].keys, 10)
  assert.equal(actives(l)[0].why, 'seal')
  assert.equal(actives(l)[0].from, S)
  assert.equal(
    actives(l)[0].t,
    20 * S,
    'ends at the last input, not at the save'
  )
})

test('visibility changes are recorded and close the span', () => {
  const l = log()
  onWindow(l, { exe: 'EDITPLUS.EXE', win: 'a' }, 0)
  onInput(l, { keys: 4 }, S)
  onVisibility(l, false, 2 * S)
  assert.equal(actives(l).length, 1, 'the span was closed at the boundary')
  assert.equal(l.lines.at(-1).kind, 'hidden')
  assert.equal(onVisibility(l, false, 3 * S), null, 'no change, no line')
  onVisibility(l, true, 4 * S)
  assert.equal(l.lines.at(-1).kind, 'shown')
  assert.equal(
    actives(l)[0].visible,
    true,
    'the span records the state it ran under'
  )
})

test('agent state and marks are recorded so gaps can be explained', () => {
  const l = log()
  onAgent(l, 'absent', 0, 'no answer in 15s')
  onVisibility(l, false, 5 * S)
  onAgent(l, 'ready', 10 * S)
  assert.deepEqual(kinds(l), ['agent', 'mark', 'agent'])
  assert.equal(l.lines[1].kind, 'hidden')
})

test('the log round trips through NDJSON', () => {
  const l = log()
  onWindow(l, { exe: 'EDITPLUS.EXE', win: 'C:\\a\tb\n"c" - EditPlus' }, 0)
  onInput(l, { keys: 2 }, S)
  sealAt(l)
  const back = fromNdjson(toNdjson(l))
  assert.deepEqual(back, l.lines)
  assert.ok(toNdjson(l).endsWith('\n'))
  assert.equal(
    toNdjson(createLog({ instanceId: 'x' })),
    '',
    'an empty log is empty'
  )
})

test('NDJSON is ordered by time even if lines arrive out of order', () => {
  const l = log()
  onAgent(l, 'ready', 500)
  l.lines.push({ ev: 'mark', t: 10, kind: 'late-arrival' })
  const back = fromNdjson(toNdjson(l))
  assert.deepEqual(
    back.map((x) => x.t),
    [10, 500]
  )
})

test('summarise reports what was recorded, and calls it nothing more', () => {
  const l = log()
  onWindow(l, { exe: 'EDITPLUS.EXE', win: 'a' }, 0)
  onInput(l, { keys: 100 }, 0)
  onInput(l, { keys: 100 }, 60 * S)
  onWindow(l, { exe: 'PSP.EXE', win: 'psp' }, 60 * S)
  onInput(l, { keys: 10 }, 90 * S)
  sealAt(l)

  const s = summarise(l)
  // 0-60s in EditPlus, then a lone keystroke at 90s: a zero-length span, because nothing
  // credits the silence after someone stops typing. A tally may add a per-span minimum.
  assert.equal(s.activeMs, 60 * S)
  assert.equal(s.byExe['PSP.EXE'], 0)
  assert.equal(s.keys, 210, 'every keystroke is still counted')
  assert.deepEqual(Object.keys(s.byExe), ['EDITPLUS.EXE', 'PSP.EXE'])
  // No hours, no policy, no cap applied: that is the tally's job, later.
  assert.equal(s.hours, undefined)
})

test('a full day of steady work stays a small log', () => {
  const l = log()
  const apps = ['EDITPLUS.EXE', 'PSP.EXE', 'IEXPLORE.EXE']
  for (let t = 0; t < 8 * 60 * M; t += 10 * S) {
    if (t % (20 * M) === 0)
      onWindow(l, { exe: apps[(t / (20 * M)) % 3], win: 'w' }, t)
    onInput(l, { keys: 5 }, t)
  }
  sealAt(l)
  // Fixed-rate sampling would be ~17k lines a day; spans are two orders of magnitude less.
  assert.ok(l.lines.length < 300, `${l.lines.length} lines`)
  assert.equal(summarise(l).keys, 5 * (8 * 60 * 6))
})
