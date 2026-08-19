// toolbar <select> for moving between the worlds that mean something to this participant:
// the one running, plus any other registered world they still have a machine saved in.
//
// it exists because a v2 build boots v2 for everyone (worlds.js currentWorld), so a
// returning participant's v1 machine is still in storage but nothing on screen says so.
// persistent state rather than a notice, deliberately: dialogs and the status line both go
// unread, and this is still here an hour later when they wonder where their old work went
import { CURRENT_WORLD_ID, WORLDS } from './worlds.js'

// "win98-checkpoint03-v1" -> "v1". dev worlds have no such suffix and keep their label
const shortName = (world) => {
  const m = /-(v\d+)$/.exec(world.id || '')
  return m ? m[1] : world.label || world.id
}

const when = (at) =>
  !at
    ? ''
    : new Date(at).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
      })

const megabytes = (size) => (!size ? '' : `${(size / 1e6).toFixed(0)} MB`)

// "v1 · saved 12 Jul, 58 MB", degrading to "v1" when the entry predates both fields
export function optionLabel(world, slot) {
  const detail = [
    slot?.at ? `saved ${when(slot.at)}` : '',
    megabytes(slot?.size),
  ].filter(Boolean)
  return detail.length
    ? `${shortName(world)} · ${detail.join(', ')}`
    : shortName(world)
}

// which worlds to offer: the running one, then every other registered world with a save.
// an older world with nothing in it is not a destination anybody wants, and offering it
// would only invite a new participant into the inferior image
export function switchableWorlds({ world, slots = [] }) {
  const saved = new Map(slots.map((s) => [s.worldId, s]))
  const out = [{ world, slot: saved.get(world.id) ?? null, current: true }]
  for (const [id, registered] of WORLDS) {
    if (id === world.id) continue
    const slot = saved.get(id)
    if (slot) out.push({ world: registered, slot, current: false })
  }
  return out
}

// where switching lands. the canonical URL for the current world carries no parameter, and
// a share or a fresh boot is not something to drag along into the world being switched to
export function switchUrl(id, href) {
  const url = new URL(href)
  if (id === CURRENT_WORLD_ID) url.searchParams.delete('world')
  else url.searchParams.set('world', id)
  url.searchParams.delete('share')
  url.searchParams.delete('fresh')
  return url.toString()
}

// returns null when there is nothing to choose between, so the caller leaves the toolbar
// alone: a select with one option is furniture that has to be read to be dismissed
export function createWorldSwitch({
  world,
  slots = [],
  saveFirst = async () => {},
  navigate = (url) => location.replace(url),
} = {}) {
  const choices = switchableWorlds({ world, slots })
  if (choices.length < 2) return null

  const select = document.createElement('select')
  select.id = 'world-switch'
  for (const choice of choices) {
    const opt = document.createElement('option')
    opt.value = choice.world.id
    opt.textContent = optionLabel(choice.world, choice.slot)
    if (choice.current) opt.selected = true
    select.append(opt)
  }

  select.addEventListener('change', async () => {
    const id = select.value
    if (id === world.id) return
    select.disabled = true
    // switching reloads the page, and autosave is on a two-minute timer, so the machine
    // being left behind is saved first. each world owns its own slot, so this touches
    // only the one being left
    try {
      await saveFirst()
    } catch (e) {
      console.warn('could not save before switching worlds:', e)
    }
    navigate(switchUrl(id, location.href))
  })

  return select
}
