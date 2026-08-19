// node --test emulator/world-switch.test.mjs
//
// which worlds the toolbar offers, how they are labelled, and where switching lands. the
// DOM half is left to the browser; these are the decisions

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { switchableWorlds, optionLabel, switchUrl } from './world-switch.js'
import {
  WORLDS,
  LEGACY_WORLD_ID,
  V2_WORLD_ID,
  CURRENT_WORLD_ID,
} from './worlds.js'

const v1 = WORLDS.get(LEGACY_WORLD_ID)
const v2 = WORLDS.get(V2_WORLD_ID)
const slot = (worldId, extra = {}) => ({
  worldId,
  at: 0,
  size: null,
  gen: 1,
  ...extra,
})

test('with nothing saved anywhere, the only world is the one running', () => {
  const choices = switchableWorlds({ world: v2, slots: [] })
  assert.equal(choices.length, 1)
  assert.equal(choices[0].world.id, V2_WORLD_ID)
  assert.equal(choices[0].current, true)
  // the caller reads this as "no switch to draw"
  assert.ok(choices.length < 2)
})

test('an older world is offered only once it has a machine in it', () => {
  const without = switchableWorlds({ world: v2, slots: [slot(V2_WORLD_ID)] })
  assert.deepEqual(
    without.map((c) => c.world.id),
    [V2_WORLD_ID]
  )

  const with1 = switchableWorlds({
    world: v2,
    slots: [slot(V2_WORLD_ID), slot(LEGACY_WORLD_ID)],
  })
  assert.deepEqual(
    with1.map((c) => c.world.id),
    [V2_WORLD_ID, LEGACY_WORLD_ID]
  )
})

test('the running world comes first and is the only one marked current', () => {
  const choices = switchableWorlds({
    world: v1,
    slots: [slot(LEGACY_WORLD_ID), slot(V2_WORLD_ID)],
  })
  assert.equal(choices[0].world.id, LEGACY_WORLD_ID)
  assert.equal(choices.filter((c) => c.current).length, 1)
  assert.equal(choices[0].current, true)
})

test('the running world is offered even with no save of its own', () => {
  const choices = switchableWorlds({
    world: v2,
    slots: [slot(LEGACY_WORLD_ID)],
  })
  assert.equal(choices[0].world.id, V2_WORLD_ID)
  assert.equal(choices[0].slot, null)
  assert.equal(choices.length, 2)
})

test('a label carries whichever of date and size the entry has', () => {
  const at = Date.UTC(2026, 6, 12)
  assert.match(
    optionLabel(v1, slot(LEGACY_WORLD_ID, { at, size: 58_000_000 })),
    /^v1 · saved .+, 58 MB$/
  )
  assert.match(optionLabel(v1, slot(LEGACY_WORLD_ID, { at })), /^v1 · saved /)
  assert.equal(
    optionLabel(v1, slot(LEGACY_WORLD_ID, { size: 58_000_000 })),
    'v1 · 58 MB'
  )
  // a legacy v1 save predates both fields, and must still name its world
  assert.equal(optionLabel(v1, slot(LEGACY_WORLD_ID)), 'v1')
  assert.equal(optionLabel(v1, null), 'v1')
})

test('switching to the current world leaves a canonical URL with no world param', () => {
  const url = new URL(
    switchUrl(
      CURRENT_WORLD_ID,
      'https://x.test/emulator/?world=' + LEGACY_WORLD_ID
    )
  )
  assert.equal(url.searchParams.get('world'), null)
})

test('switching to an older world pins it explicitly', () => {
  const url = new URL(switchUrl(LEGACY_WORLD_ID, 'https://x.test/emulator/'))
  assert.equal(url.searchParams.get('world'), LEGACY_WORLD_ID)
})

test('a share or a fresh flag is never dragged into the world switched to', () => {
  const url = new URL(
    switchUrl(
      LEGACY_WORLD_ID,
      'https://x.test/emulator/?share=https%3A%2F%2Fa.test%2Fs.bin&fresh=1'
    )
  )
  assert.equal(url.searchParams.get('share'), null)
  assert.equal(url.searchParams.get('fresh'), null)
  assert.equal(url.searchParams.get('world'), LEGACY_WORLD_ID)
})

test('unrelated query and hash survive the switch', () => {
  const url = new URL(
    switchUrl(LEGACY_WORLD_ID, 'https://x.test/emulator/?debug=1#frag')
  )
  assert.equal(url.searchParams.get('debug'), '1')
  assert.equal(url.hash, '#frag')
})
