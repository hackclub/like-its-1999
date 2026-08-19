// the decisions a session makes: what to boot from, whether a save may proceed, and what
// an import would replace
//
// nothing here touches the DOM, storage or the emulator; main.js supplies the facts and
// carries out the verdicts, which is what keeps these combinations testable

// where a session's initial RAM comes from
//   'shared'   someone else's machine, fetched from ?share=
//   'saved'    this browser's stored session for this world
//   'snapshot' the world's shipped instant-boot snapshot
//   'cold'     no RAM at all: boot the disks from the BIOS up
export const BOOT_SOURCES = ['shared', 'saved', 'snapshot', 'cold']

// inputs are facts the caller has already gathered:
//   saved   what loadSavedSession returned: null, { save, state, gen, migrated },
//           or { readOnly: true, reason }
//   otherDevSaves  some other dev world has a save, which is how a rebuilt local image is
//                  distinguished from a first-ever visit
//   storedElsewhere a machine IS stored for this world but we deliberately did not read
//                  it (?fresh=1), so a save has something to destroy
//
// `gen` in the returned plan is the compare-and-swap claim about the stored slot: a
// number means "I read this generation", 0 means "I believe nothing is stored", and null
// means "don't check" (a deliberate overwrite)
export function planBoot({
  params = {},
  shared = null,
  saved = null,
  world = {},
  otherDevSaves = false,
  storedElsewhere = false,
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
    // not the user's session to keep; a save is only possible after an explicit
    // confirmation, so it counts as deliberate and skips the generation check
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
    // ignoring what's stored means a later save is meant to replace it, so checking a
    // generation we never read would only refuse that write
    //
    // replacing it still has to be asked for: a URL parameter plus two minutes of
    // autosave is not consent to destroy hours of someone's work, so when there IS a
    // machine here the session starts blocked until a Save click confirms
    //
    // both notes can apply at once (?fresh=1&world=bogus), and the world-resolution
    // message is the one the user cannot otherwise discover, so it comes first
    const freshNote = storedElsewhere
      ? 'fresh boot; the saved machine is untouched'
      : ''
    return {
      ...plan,
      source: 'cold',
      gen: null,
      blocked: storedElsewhere
        ? 'started fresh; click Save to replace the machine stored here'
        : null,
      note: [worldNote, freshNote].filter(Boolean).join(' · '),
    }
  }

  if (saved?.readOnly) {
    // a save we can't parse is still someone's machine: boot around it and refuse to
    // write, rather than treating it as absent and overwriting it on the next autosave;
    // phrased as a refusal because it is shown as one, in the toolbar and in the confirm
    // dialog when the user insists
    plan.blocked = `this build cannot read the machine saved here (${saved.reason})`
    plan.note = 'existing save not readable; not overwriting it'
  } else if (saved) {
    plan.source = 'saved'
    plan.prior = saved.save
    plan.gen = saved.gen ?? 0
    if (saved.migrated) plan.note = 'restored a pre-container save'
  } else if (otherDevSaves) {
    // locally a world id is a fingerprint of the image bytes, so "nothing saved for this
    // world" plus "something saved for another" means the image was rebuilt underneath
    plan.note = 'image changed, booting fresh'
  }

  // a snapshot older than the disks beside it would paint the previous build's RAM over
  // the image you just rebuilt
  if (plan.source === 'snapshot') {
    if (world.snapshotIsStale) {
      plan.source = 'cold'
      plan.note = 'snapshot older than disks, cold booting'
    } else if (!world.initialState) {
      plan.source = 'cold'
    }
  }
  return plan
}

//   session  { gen, blocked } as maintained by applySave
//   auto     true for the timer / visibility autosaves, false for a button press
//   force    the user has been shown what they are replacing and said yes
//
// `reason` is a message worth showing when a deliberate save is refused; an autosave that
// declines stays silent, because it happens on a timer and the user did not ask for it
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
  if (session.blocked && !force) return no(session.blocked)
  if (saving) return no('a save is already in progress')

  return {
    allowed: true,
    reason: null,
    // null and undefined are not the same here: null is "don't check" (fresh boot, shared
    // machine), while a missing value means we never looked, which is a claim of "nothing
    // is stored" and must be verified; collapsing them with ?? re-broke ?fresh=1 saving
    expectGen: force ? null : session.gen === undefined ? 0 : session.gen,
    // never render a thumbnail on an autosave: that path runs during page teardown,
    // racing the tab closing, and the previous thumbnail carries forward untouched
    withThumb: !auto,
  }
}

export const sessionFrom = (plan) => ({
  prior: plan.prior,
  gen: plan.gen,
  blocked: plan.blocked,
})

// the file just written is what the next save must derive from, and its generation is
// what the next compare-and-swap expects; keep working from the boot-time copy and later
// saves silently drop whatever only the stored one had
export const applySave = (session, { save, gen }) => ({
  ...session,
  prior: save,
  gen,
  blocked: null,
})

// `refuse` is set when the file cannot be applied at all: a machine for another world has
// to be stored before it can be reloaded into, which ?nosave=1 forbids
export function planImport({ imported, params = {} } = {}) {
  if (!imported) throw new Error('planImport needs a read import')
  const { world, needsReload, replaces } = imported
  if (needsReload && params.nosave)
    return {
      needsConfirm: false,
      replaces,
      needsReload,
      refuse:
        `that machine belongs to ${world.label}, which needs saving to open, ` +
        'not possible with ?nosave=1',
    }
  // a cross-world import is stored and then reloaded into with ?world=<id>, which only
  // resolves for a registered (or freshly measured local) world; a file naming some other
  // world would land in a slot nothing could ever open again. a `?share=` link of the
  // same file still opens, since that path carries the descriptor and stores nothing
  if (needsReload && !world.resolvable)
    return {
      needsConfirm: false,
      replaces,
      needsReload,
      refuse:
        `that machine belongs to ${world.label}, which this version of the page does ` +
        'not have. Open it with a ?share= link instead, or update the page.',
    }
  return {
    // importing replaces a stored machine unrecoverably, so ask first, and only when
    // there is genuinely something to lose
    needsConfirm: !!replaces,
    replaces,
    needsReload,
    refuse: null,
  }
}
