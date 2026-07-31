// The decisions a session makes: what to boot from, whether a save may proceed, and
// what an import would replace.
//
// This exists as pure functions on purpose. Every bug in this feature so far has been
// here — in the combinations of shared / fresh / nosave / unreadable-save / generation /
// migrated / dev-versus-registered world — and none were reachable by a test while the
// logic lived inside main.js, where it needed a DOM, an emulator and IndexedDB to run.
// Two of them were introduced *by fixes* to the others, which is what happens when a
// state machine can only be checked by clicking through it. Nothing in here touches the
// DOM, storage or the emulator; main.js supplies facts and carries out the verdicts.

// Where a session's initial RAM comes from.
//   'shared'   someone else's machine, fetched from ?share=
//   'saved'    this browser's stored session for this world
//   'snapshot' the world's shipped instant-boot snapshot
//   'cold'     no RAM at all: boot the disks from the BIOS up
export const BOOT_SOURCES = ['shared', 'saved', 'snapshot', 'cold']

// Decide how to start.
//
// Inputs are all facts the caller has already gathered:
//   params  { fresh, nosave, world, share } from readModeParams
//   shared  the fetched shared machine, or null
//   saved   what loadSavedSession returned: null, { save, state, gen, migrated },
//           or { readOnly: true, reason }
//   world   the resolved world (needs id, initialState, snapshotIsStale)
//   otherDevSaves  true when some *other* dev world has a save, which is how a rebuilt
//                  local image is distinguished from a first-ever visit
//   worldNote  a message from world resolution that should survive to the toolbar
//
// Returns { source, prior, gen, blocked, note }. `gen` is the compare-and-swap claim
// about the stored slot: a number means "I read this generation", 0 means "I believe
// nothing is stored", and null means "don't check" (a deliberate overwrite).
export function planBoot({
  params = {},
  shared = null,
  saved = null,
  world = {},
  otherDevSaves = false,
  worldNote = '',
} = {}) {
  const plan = {
    source: 'snapshot',
    prior: null,
    gen: 0,
    blocked: null,
    note: '',
  }

  if (shared) {
    // Not the user's session to keep. A save is only possible after an explicit
    // confirmation, so it counts as deliberate and skips the generation check.
    return {
      ...plan,
      source: 'shared',
      prior: shared.save,
      gen: null,
      note: 'shared machine',
    }
  }

  plan.note = worldNote

  if (params.fresh) {
    // "Ignore what's stored and start clean", so a later save is meant to replace it.
    // Checking a generation we never read would just refuse that write.
    return { ...plan, source: 'cold', gen: null }
  }

  if (saved?.readOnly) {
    // A save we can't parse is still someone's machine. Boot around it and refuse to
    // write, rather than treating it as absent and overwriting it on the next autosave.
    plan.blocked = saved.reason
    plan.note = 'existing save not readable — not overwriting it'
  } else if (saved) {
    plan.source = 'saved'
    plan.prior = saved.save
    plan.gen = saved.gen ?? 0
    if (saved.migrated) plan.note = 'restored a pre-container save'
  } else if (otherDevSaves) {
    // Locally a world id is a fingerprint of the image bytes, so "nothing saved for this
    // world" plus "something saved for another" means the image was rebuilt underneath.
    plan.note = 'image changed — booting fresh'
  }

  // Nothing to restore from: either no snapshot ships with this world, or the one that
  // does is older than the disks beside it and would paint the previous build's RAM over
  // the image you just rebuilt.
  if (plan.source === 'snapshot') {
    if (world.snapshotIsStale) {
      plan.source = 'cold'
      plan.note = 'snapshot older than disks — cold booting'
    } else if (!world.initialState) {
      plan.source = 'cold'
    }
  }
  return plan
}

// Decide whether a save may proceed, and how.
//
//   params   { nosave } from readModeParams
//   session  { gen, blocked } as maintained by applySave
//   isShared whether this tab is viewing someone else's machine
//   auto     true for the timer / visibility autosaves, false for a button press
//   force    the user has been shown what they are replacing and said yes
//   saving   a save is already in flight
//
// Returns { allowed, expectGen, withThumb, reason }. `reason` is a message worth showing
// when a *deliberate* save is refused; an autosave that declines stays silent, because it
// happens on a timer and the user did not ask for it.
export function planSave({
  params = {},
  session = {},
  isShared = false,
  auto = false,
  force = false,
  saving = false,
} = {}) {
  const no = (reason) => ({
    allowed: false,
    reason: auto ? null : reason,
    expectGen: undefined,
    withThumb: false,
  })

  if (params.nosave) return no('saving is off (?nosave)')
  if (auto && isShared) return no(null)
  if (session.blocked && !force)
    return no('not saving over a machine this build cannot read')
  if (saving) return no('a save is already in progress')

  return {
    allowed: true,
    reason: null,
    // Deliberate overwrites skip the check; everything else must match what it read.
    // null and undefined are NOT the same here: null is "don't check" (fresh boot, shared
    // machine), while a missing value means we never looked, which is a claim of "nothing
    // is stored" and must be verified. Collapsing them with ?? re-broke ?fresh=1 saving.
    expectGen: force ? null : session.gen === undefined ? 0 : session.gen,
    // Never render and encode a thumbnail on an autosave: that path runs during page
    // teardown, racing the tab closing, and the previous thumbnail carries forward
    // untouched anyway.
    withThumb: !auto,
  }
}

// The session state a boot plan implies.
export const sessionFrom = (plan) => ({
  prior: plan.prior,
  gen: plan.gen,
  blocked: plan.blocked,
})

// Fold a completed save back in. The file just written is what the next save must derive
// from and the generation the next compare-and-swap expects; keep working from the
// boot-time copy and later saves silently drop whatever only the stored one had.
export const applySave = (session, { save, gen }) => ({
  ...session,
  prior: save,
  gen,
  blocked: null,
})

// Decide what to do with a file the user picked.
//
//   imported { world, needsReload, replaces } from readImport
//   params   { nosave }
//
// Returns { needsConfirm, replaces, needsReload, refuse }. `refuse` is set when the file
// cannot be applied at all: a machine for another world has to be stored before it can be
// reloaded into, which ?nosave=1 forbids.
export function planImport({ imported, params = {} } = {}) {
  if (!imported) throw new Error('planImport needs a read import')
  const { world, needsReload, replaces } = imported
  if (needsReload && params.nosave)
    return {
      needsConfirm: false,
      replaces,
      needsReload,
      refuse:
        `that machine belongs to ${world.label}, which needs saving to open — ` +
        'not possible with ?nosave=1',
    }
  return {
    // Importing replaces a stored machine unrecoverably, so ask first — and only when
    // there is genuinely something to lose.
    needsConfirm: !!replaces,
    replaces,
    needsReload,
    refuse: null,
  }
}
