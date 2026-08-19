// node --test emulator/session.test.mjs
//
// the boot/save state machine, enumerated: the save guards are checked as a full cross
// product rather than sampled

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  planBoot,
  planSave,
  planImport,
  sessionFrom,
  applySave,
  BOOT_SOURCES,
} from './session.js'

// planBoot only ever reads identity off these
const saveFile = (id) => ({ id })
const shared = {
  save: saveFile('shared'),
  state: 'shared-bytes',
  world: { id: 'w' },
}
const stored = (over = {}) => ({
  save: saveFile('stored'),
  state: 'stored-bytes',
  gen: 3,
  ...over,
})
const withSnapshot = {
  id: 'win98-checkpoint03-v1',
  initialState: { url: 's.zst' },
}
const noSnapshot = { id: 'dev:abc', initialState: null }
const staleSnapshot = {
  id: 'dev:abc',
  initialState: { url: 's.zst' },
  snapshotIsStale: true,
}

// --- planBoot -------------------------------------------------------------------

test('a shared machine wins over everything and never claims a generation', () => {
  for (const params of [{}, { fresh: true }, { nosave: true }])
    for (const saved of [null, stored(), { readOnly: true, reason: 'nope' }]) {
      const plan = planBoot({ params, shared, saved, world: withSnapshot })
      assert.equal(plan.source, 'shared')
      assert.equal(plan.prior.id, 'shared')
      // null, not 0: a generation check would refuse a deliberate save over someone
      // else's machine
      assert.equal(plan.gen, null)
      assert.equal(plan.note, 'shared machine')
      assert.equal(plan.blocked, null)
    }
})

test('?fresh=1 cold boots and can still save', () => {
  const plan = planBoot({
    params: { fresh: true },
    saved: null,
    world: withSnapshot,
  })
  assert.equal(plan.source, 'cold')
  assert.equal(plan.gen, null, 'fresh must not make a generation claim')
  assert.equal(plan.prior, null)

  const verdict = planSave({ session: sessionFrom(plan) })
  assert.equal(verdict.allowed, true)
  assert.equal(verdict.expectGen, null)
})

test('?fresh=1 does not silently destroy a machine that is stored', () => {
  const plan = planBoot({
    params: { fresh: true },
    saved: null,
    world: withSnapshot,
    storedElsewhere: true,
  })
  assert.equal(plan.source, 'cold')
  assert.match(plan.blocked, /click Save/)

  const session = sessionFrom(plan)
  assert.equal(
    planSave({ session, auto: true }).allowed,
    false,
    'autosave declines'
  )
  assert.equal(
    planSave({ session, auto: true }).reason,
    null,
    'and says nothing, since nobody asked'
  )

  // a deliberate save skips the generation check: nothing was claimed after ignoring
  // the slot
  const forced = planSave({ session, force: true })
  assert.equal(forced.allowed, true)
  assert.equal(forced.expectGen, null)

  const empty = planBoot({ params: { fresh: true }, world: withSnapshot })
  assert.equal(empty.blocked, null)
  assert.equal(
    planSave({ session: sessionFrom(empty), auto: true }).allowed,
    true
  )
})

test('a stored session is restored and carries its generation forward', () => {
  const plan = planBoot({ saved: stored(), world: withSnapshot })
  assert.equal(plan.source, 'saved')
  assert.equal(plan.prior.id, 'stored')
  assert.equal(plan.gen, 3)
  assert.equal(plan.note, '')
  assert.equal(planSave({ session: sessionFrom(plan) }).expectGen, 3)
})

test('a migrated pre-container save says so and claims generation 0', () => {
  const plan = planBoot({
    saved: stored({ gen: 0, migrated: true }),
    world: withSnapshot,
  })
  assert.equal(plan.source, 'saved')
  assert.equal(plan.note, 'restored a pre-container save')
  assert.equal(plan.gen, 0)
})

test('an unreadable save is booted around, never overwritten', () => {
  const plan = planBoot({
    saved: { readOnly: true, reason: 'needs a newer version' },
    world: withSnapshot,
  })
  assert.equal(plan.source, 'snapshot', 'boot the shipped image instead')
  assert.match(plan.blocked, /cannot read the machine saved here/)
  assert.match(plan.blocked, /needs a newer version/, 'and says why')
  assert.equal(plan.prior, null)
  assert.match(plan.note, /not overwriting/)

  const session = sessionFrom(plan)
  assert.equal(planSave({ session }).allowed, false)
  assert.equal(planSave({ session }).reason, plan.blocked)
  assert.equal(planSave({ session, auto: true }).allowed, false)
  assert.equal(planSave({ session, force: true }).allowed, true)
  assert.equal(planSave({ session, force: true }).expectGen, null)
})

test('with nothing stored, an empty slot is still a claim that gets checked', () => {
  const plan = planBoot({ saved: null, world: withSnapshot })
  assert.equal(plan.source, 'snapshot')
  assert.equal(plan.gen, 0, 'must be 0 ("I believe nothing is here"), not null')
  assert.equal(planSave({ session: sessionFrom(plan) }).expectGen, 0)
})

test('a rebuilt local image is reported rather than looking like a lost save', () => {
  const quiet = planBoot({
    saved: null,
    world: noSnapshot,
    otherDevSaves: false,
  })
  assert.equal(quiet.note, '')
  const rebuilt = planBoot({
    saved: null,
    world: noSnapshot,
    otherDevSaves: true,
  })
  assert.equal(rebuilt.note, 'image changed, booting fresh')
})

test('cold boots when there is no snapshot, or the snapshot is older than the disks', () => {
  assert.equal(planBoot({ world: noSnapshot }).source, 'cold')

  const stale = planBoot({ world: staleSnapshot })
  assert.equal(stale.source, 'cold')
  assert.equal(stale.note, 'snapshot older than disks, cold booting')

  const restored = planBoot({ saved: stored(), world: staleSnapshot })
  assert.equal(restored.source, 'saved')
  assert.equal(restored.note, '')
})

test('a fresh boot over a stored machine still explains a bad world', () => {
  const plan = planBoot({
    params: { fresh: true },
    world: withSnapshot,
    storedElsewhere: true,
    worldNote: 'unknown world "bogus"',
  })
  assert.match(plan.note, /unknown world/)
  assert.match(plan.note, /saved machine is untouched/)
})

test('a world-resolution message survives to the toolbar', () => {
  const plan = planBoot({ world: withSnapshot, worldNote: 'unknown world "x"' })
  assert.equal(plan.note, 'unknown world "x"')
  const rebuilt = planBoot({
    world: noSnapshot,
    otherDevSaves: true,
    worldNote: 'unknown world "x"',
  })
  assert.equal(rebuilt.note, 'image changed, booting fresh')
})

test('planBoot always returns a known source and never throws on sparse input', () => {
  for (const params of [
    {},
    { fresh: true },
    { nosave: true },
    { fresh: true, nosave: true },
  ])
    for (const sharedIn of [null, shared])
      for (const saved of [
        null,
        stored(),
        stored({ gen: 0 }),
        stored({ migrated: true }),
        { readOnly: true, reason: 'x' },
      ])
        for (const world of [withSnapshot, noSnapshot, staleSnapshot, {}])
          for (const otherDevSaves of [false, true]) {
            const plan = planBoot({
              params,
              shared: sharedIn,
              saved,
              world,
              otherDevSaves,
            })
            assert.ok(BOOT_SOURCES.includes(plan.source), JSON.stringify(plan))
            assert.equal(typeof plan.note, 'string')
            assert.ok(plan.gen === null || Number.isInteger(plan.gen))
            if (plan.source === 'saved') assert.ok(plan.prior)
            if (plan.source === 'shared') assert.ok(plan.prior)
            if (plan.blocked) assert.notEqual(plan.source, 'saved')
          }
})

test('planBoot does not mutate its inputs', () => {
  const params = { fresh: false }
  const world = { ...withSnapshot }
  const saved = stored()
  planBoot({ params, saved, world })
  assert.deepEqual(params, { fresh: false })
  assert.deepEqual(world, { ...withSnapshot })
  assert.equal(saved.gen, 3)
})

// --- planSave -------------------------------------------------------------------

const ok = { gen: 5, blocked: null, prior: saveFile('p') }

test('the save guards, as a full cross product', () => {
  const cases = []
  for (const nosave of [false, true])
    for (const isShared of [false, true])
      for (const blocked of [null, 'unreadable'])
        for (const auto of [false, true])
          for (const force of [false, true])
            for (const saving of [false, true])
              for (const gen of [5, null])
                cases.push({
                  nosave,
                  isShared,
                  blocked,
                  auto,
                  force,
                  saving,
                  gen,
                })

  for (const c of cases) {
    const verdict = planSave({
      params: { nosave: c.nosave },
      session: { ...ok, blocked: c.blocked, gen: c.gen },
      isShared: c.isShared,
      auto: c.auto,
      force: c.force,
      saving: c.saving,
    })
    const label = JSON.stringify(c)

    // the rules, restated independently of the implementation
    const expected =
      !c.nosave &&
      !(c.auto && c.isShared) &&
      !(c.blocked && !c.force) &&
      !c.saving
    assert.equal(verdict.allowed, expected, label)

    if (verdict.allowed) {
      assert.equal(verdict.expectGen, c.force ? null : c.gen, label)
      assert.equal(verdict.withThumb, !c.auto, label)
    } else {
      if (c.auto) assert.equal(verdict.reason, null, label)
      else if (!(c.auto && c.isShared))
        assert.equal(typeof verdict.reason, 'string', label)
    }
  }
  assert.equal(cases.length, 128)
})

test('never writes a thumbnail on an autosave', () => {
  // encoding a png on the pagehide path races the tab closing, and the stored thumbnail
  // carries forward untouched anyway
  assert.equal(planSave({ session: ok, auto: true }).withThumb, false)
  assert.equal(planSave({ session: ok, auto: false }).withThumb, true)
})

test('null and undefined generations mean different things', () => {
  // undefined means "we never looked", a claim that nothing is stored, so it gets
  // checked; explicit null means do not check (fresh boot, shared machine)
  assert.equal(planSave({ session: { blocked: null } }).expectGen, 0)
  assert.equal(
    planSave({ session: { gen: null, blocked: null } }).expectGen,
    null
  )
  assert.equal(planSave({ session: { gen: 0, blocked: null } }).expectGen, 0)
  assert.equal(planSave({ session: { gen: 7, blocked: null } }).expectGen, 7)
})

// --- session bookkeeping ---------------------------------------------------------

test('a completed save becomes the basis for the next one', () => {
  const session = sessionFrom(
    planBoot({ saved: stored(), world: withSnapshot })
  )
  const next = applySave(session, { save: saveFile('written'), gen: 4 })
  assert.equal(next.prior.id, 'written')
  assert.equal(next.gen, 4)
  assert.equal(next.blocked, null)
  assert.equal(planSave({ session: next }).expectGen, 4)
})

test('a forced save clears the blocked flag so later autosaves work normally', () => {
  const session = sessionFrom(
    planBoot({ saved: { readOnly: true, reason: 'x' }, world: withSnapshot })
  )
  assert.equal(planSave({ session, auto: true }).allowed, false)
  const after = applySave(session, { save: saveFile('written'), gen: 1 })
  assert.equal(planSave({ session: after, auto: true }).allowed, true)
})

// --- planImport -----------------------------------------------------------------

const importOf = ({ resolvable = true, ...over } = {}) => ({
  world: { id: 'w', label: 'World W', resolvable },
  save: saveFile('imported'),
  state: 'bytes',
  needsReload: false,
  replaces: null,
  ...over,
})

test('importing over nothing needs no confirmation', () => {
  const v = planImport({ imported: importOf() })
  assert.equal(v.needsConfirm, false)
  assert.equal(v.refuse, null)
})

test('importing over an existing machine asks first', () => {
  const v = planImport({ imported: importOf({ replaces: { at: 123 } }) })
  assert.equal(v.needsConfirm, true)
  assert.equal(v.replaces.at, 123)
})

test('a machine for another world reloads into that world', () => {
  const v = planImport({
    imported: importOf({ needsReload: true }),
  })
  assert.equal(v.needsReload, true)
  assert.equal(v.refuse, null)
})

test('a machine for a world this build cannot resolve is refused', () => {
  // a reload can only find a registered world or the current local image, so storing it
  // would fill a slot no later page load could open
  const v = planImport({
    imported: importOf({ needsReload: true, resolvable: false }),
  })
  assert.match(v.refuse, /does not have/)
  assert.equal(v.needsConfirm, false)
})

test('?nosave=1 refuses an import it would have to store', () => {
  const v = planImport({
    imported: importOf({ needsReload: true }),
    params: { nosave: true },
  })
  assert.match(v.refuse, /not possible with \?nosave/)
  assert.equal(v.needsConfirm, false)

  // a same-world import needs no store, so it is still allowed
  const same = planImport({ imported: importOf(), params: { nosave: true } })
  assert.equal(same.refuse, null)
})
