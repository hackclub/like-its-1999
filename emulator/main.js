import { V86 } from 'v86'

// Vite resolves these to served URLs (dev) or hashed asset URLs (build).
import wasmUrl from 'v86/build/v86.wasm?url'
import seabiosUrl from './vendor/bios/seabios.bin?url'
import vgabiosUrl from './vendor/bios/vgabios.bin?url'
import {
  loadSavedSession,
  listSavedWorlds,
  saveSession,
  clearSavedSession,
  exportSession,
  readImport,
  storeImport,
  fetchSharedSave,
  StaleSaveError,
  StorageFullError,
} from './persist.js'
import {
  readModeParams,
  currentWorld,
  worldToV86Config,
  isDevWorldId,
} from './worlds.js'
import {
  planBoot,
  planSave,
  planImport,
  sessionFrom,
  applySave,
} from './session.js'
import { createLink } from './daemon/link.js'
import { installDebug } from './debug.js'
import { loadDaemon } from './daemon/build.js'
import { toNdjson } from './daemon/tracking.js'
import {
  seal,
  importPublicKey,
  hasRecipientKey,
  RECIPIENT_PUBLIC_KEY_B64,
} from './daemon/sealed.js'
import { sha256hex } from './savefile.js'
import { createFileBrowser, openLiveFs } from './vmfs/filebrowser.js'
import { createCdromControl } from './cdrom-ui.js'
import { installAtapiCdromFix } from './cdrom-atapi-fix.js'

// Our custom Windows 98 image (built in tmp-image-build/, checkpoint 03):
//   - C: (hda) — Win98 SE + absolute mouse (vbmouse) + True Color (VBEMP) + the
//     web-dev toolkit's registry/DLLs + configured desktop & home pages.
//   - D: (hdb) — the toolkit: EditPlus, Netscape (Communicator+Composer), Paint
//     Shop Pro 6, GIF Construction Set, WS_FTP LE, Flash 4.
//   - state.bin.zst — instant-boot RAM snapshot of the settled desktop.
// The disks are async: reads stream in 256 KiB chunks and guest writes go to an
// in-memory overlay that is never written back — so D: is effectively read-only and
// only C: writes matter for a submission.
//
// Which image, and the machine config that goes with it, is a *world* (worlds.js) —
// not module constants — because a v86 state only restores against the disks it was
// captured on. Boot order: a shared machine, else an explicitly requested world, else
// this build's current world (locally, a fingerprint of the images on disk).
const params = readModeParams()
const status = document.getElementById('status')
const setStatus = (text) => {
  if (status) status.textContent = text
}

// Identifies this restore, not this file: one saved machine can be restored many
// times, and the tracking data has to be able to tell those apart later.
const instanceId = crypto.randomUUID()

// A ?share=<url> parameter turns this tab into a viewer of someone else's exported
// machine: we fetch it and boot it instead of the user's own session, autosave is
// disabled, and a manual save warns before it clobbers whatever the user had saved.
// Legacy v1 shares (a bare gzipped state, which is every link published so far) carry
// no world, so they resolve to the legacy world and keep booting against v1 disks.
let shared = null
if (params.share) {
  try {
    setStatus('loading shared machine…')
    shared = await fetchSharedSave(params.share)
  } catch (e) {
    console.error('shared machine failed to load:', e)
    alert(
      `Couldn't load the shared machine:\n${e.message}\n\nBooting normally.`
    )
  }
}
const isShared = !!shared

// The world to build the machine from. currentWorld() handles ?world= too, including
// re-measuring a local image before honouring a dev world id.
let world = shared?.world ?? null
let worldNote = ''
if (!world) {
  try {
    world = await currentWorld(params)
  } catch (e) {
    // Fall back rather than stopping, and say so in the toolbar. A modal here would
    // block the page before the emulator even exists.
    console.error('requested world unavailable:', e)
    worldNote = e.message
    params.world = null
    world = await currentWorld(params)
  }
}

// Gather the facts, then let session.js decide. Every combination of shared / fresh /
// nosave / unreadable / generation is table-tested there rather than reasoned about here.
const saved = isShared || params.fresh ? null : await loadSavedSession(world)
// Two facts about *other* slots, both read from the small index rather than the records.
// `otherDevSaves` distinguishes a rebuilt local image from a first visit; `storedElsewhere`
// is whether a fresh boot has something it would destroy by saving.
const slots =
  !saved && !isShared && (params.fresh || isDevWorldId(world.id))
    ? await listSavedWorlds()
    : []
const plan = planBoot({
  params,
  shared,
  saved,
  world,
  otherDevSaves:
    isDevWorldId(world.id) && slots.some((s) => isDevWorldId(s.worldId)),
  storedElsewhere: slots.some((s) => s.worldId === world.id),
  worldNote,
})
const session = sessionFrom(plan)
const bootNote = plan.note
const bootState =
  plan.source === 'shared'
    ? shared.state
    : plan.source === 'saved'
      ? saved.state
      : null

if (plan.blocked)
  console.warn(`refusing to write over the saved session: ${plan.blocked}`)
if (plan.source === 'cold' && world.snapshotIsStale)
  console.warn(
    `${world.id}: state.bin.zst predates the disk images, ignoring it. ` +
      'Recapture the snapshot after flattening, or keep cold booting.'
  )

// v86 wraps this buffer and reads `.buffer` off it, so hand it an ArrayBuffer that
// covers exactly the state (a subarray view would point at the wrong bytes).
const asArrayBuffer = (u8) =>
  u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength
    ? u8.buffer
    : u8.slice().buffer

// Instant boot from whatever the plan chose. v86's built-in zstd handles the shipped
// .zst; a cold boot passes nothing and comes up from the BIOS, which is the local loop
// for booting an image you just rebuilt.
const initialState = bootState
  ? { buffer: asArrayBuffer(bootState) }
  : plan.source === 'snapshot'
    ? world.initialState
    : null

const emulator = new V86({
  wasm_path: wasmUrl,
  bios: { url: seabiosUrl },
  vga_bios: { url: vgabiosUrl },

  screen_container: document.getElementById('screen_container'),

  // memory/vga sizes, the disks and COM2 all come from the world — they must match
  // what the state was captured with or restore_state fails.
  ...worldToV86Config(world, { initialState }),

  autostart: true,
})

// Minimal status wiring so it's obvious the thing is alive while it loads.
// Once the guest is running we clear it (keeping any note about how we booted) —
// download-progress keeps firing for lazy disk reads during normal use, so we only
// show it pre-start.
let running = false
emulator.add_listener(
  'emulator-loaded',
  () => !running && setStatus('booting…')
)
emulator.add_listener('emulator-started', () => {
  running = true
  setStatus(bootNote)
})
emulator.add_listener('download-progress', (e) => {
  if (running || !e.file_name || !e.total) return
  setStatus(
    `downloading ${e.file_name} — ${Math.round((100 * e.loaded) / e.total)}%`
  )
})

// --- tracking -------------------------------------------------------------------
// Talk to the in-guest agent over COM1 and record what the machine was doing. Every world
// shipped so far has no agent at all, so `absent` is the normal, healthy outcome here and
// must stay quiet: the log still records input and the page still works.
//
// An image with the daemon installed answers, and usually already has the child we want
// cached, in which case nothing is transferred at all. A push only happens when the build
// has changed.
// Fetched rather than imported: the hash is derived from the bytes, and a build with no
// agent binary is a normal state that must not stop the page.
const daemonBuild = await loadDaemon()
const link = createLink({
  emulator,
  epoch: instanceId,
  instanceId,
  wantHash: daemonBuild.hash,
  wantBytes: daemonBuild.bytes,
  onState: (state) => {
    if (state === 'ready') setStatus(`${bootNote || 'tracking on'}`)
  },
})

// Seal this instance's log for the container. Encryption keeps window titles (file names,
// paths) out of an artifact participants publish; the signature anchors when the bytes
// existed. Both are best-effort: a save must never fail because a key is missing or the
// signing endpoint is down, so either one falling through just means a less provable log.
async function sealTracking() {
  if (!hasRecipientKey()) return null
  const lines = toNdjson(link.seal())
  if (!lines) return null
  try {
    const gz = await gzipBytes(new TextEncoder().encode(lines))
    const sealed = await seal(
      gz,
      await importPublicKey(RECIPIENT_PUBLIC_KEY_B64)
    )
    return { ...sealed, ...(await countersign(sealed.body)) }
  } catch (e) {
    console.warn('could not seal the tracking log:', e.message)
    return null
  }
}

const gzipBytes = async (bytes) =>
  new Uint8Array(
    await new Response(
      new Response(bytes).body.pipeThrough(new CompressionStream('gzip'))
    ).arrayBuffer()
  )

// Ask the server to countersign the ciphertext hash. Offline, or no endpoint deployed, is
// an ordinary outcome rather than an error.
async function countersign(body) {
  try {
    const resp = await fetch('/api/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha256: await sha256hex(body) }),
    })
    if (!resp.ok) return {}
    const { keyId, signedAt, sig } = await resp.json()
    return { sig, signedAt, sigKeyId: keyId }
  } catch {
    return {}
  }
}

// Integer scaling: Win98 is pixel art, so we draw it at the largest whole number
// of DEVICE pixels per guest pixel that fits — crisp, no mushy fractional scaling.
//
// screen_set_scale(s) does NOT map s directly to pixels: v86 folds in an internal
// per-video-mode factor (1 in SVGA/True Color, 2 in plain VGA) that is NOT the
// devicePixelRatio. So: devicePxPerGuestPx = s * modeFactor * dpr. We measure
// modeFactor (rather than assume it) whenever the mode changes, then invert.
const holder = document.getElementById('screen_holder')
const canvas = document.querySelector('#screen_container canvas')
let guestW = 0
let guestH = 0
let modeFactor = 1 // CSS px per guest px at scale 1; re-measured per video mode

function measureModeFactor() {
  if (!guestW) return
  emulator.screen_set_scale(1, 1)
  modeFactor = canvas.getBoundingClientRect().width / guestW || 1
}

function rescale() {
  if (!guestW || !guestH) return
  const dpr = window.devicePixelRatio || 1
  // Always measure the holder: whether the parent fullscreens the iframe or (standalone)
  // the holder goes fullscreen itself, the viewport grows to the screen, so the holder
  // already reflects the available space in *device* pixels.
  const availW = holder.clientWidth * dpr
  const availH = holder.clientHeight * dpr
  const deviceMultiple = Math.max(
    1,
    Math.floor(Math.min(availW / guestW, availH / guestH))
  )
  const scale = deviceMultiple / (modeFactor * dpr)
  emulator.screen_set_scale(scale, scale)
}

emulator.add_listener('screen-set-size', ([w, h]) => {
  guestW = w
  guestH = h
  measureModeFactor()
  rescale()
})
window.addEventListener('resize', rescale)
document.addEventListener('fullscreenchange', rescale)

// Fullscreen the emulator. Prefer the parent shell — it's the top-level document, so
// only it can keyboard.lock() (which lets Esc/Tab/etc reach Win98). We call it
// synchronously from this click so the user-activation (which propagates to the
// parent) is still valid for requestFullscreen. Standalone (no parent), fullscreen the
// holder ourselves. Either way NO pointer lock: the absolute-mouse driver tracks the
// host 1:1, whereas a pointer lock switches the guest to relative mouse (inverted Y,
// unnatural sensitivity).
document.getElementById('fullscreen').addEventListener('click', () => {
  let parentFn = null
  try {
    if (window.parent !== window)
      parentFn = window.parent.enterEmulatorFullscreen
  } catch {}
  if (parentFn) parentFn()
  else holder.requestFullscreen?.().catch(() => {})
})

// The parent owns the fullscreen (it's on the iframe element), so we can't see it via
// document.fullscreenElement here — it messages us instead. Hide the toolbar + rescale.
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.data?.type !== 'fullscreen') return
  document.body.classList.toggle('fs', e.data.on)
  rescale()
})

// --- State persistence --------------------------------------------------------
// Save the running session to IndexedDB as a `.99sv` container (savefile.js) keyed by
// its world, restore it on next load (see initial_state above), and export/import it
// as a file — the same artifact a ?share= URL points at.
const $ = (id) => document.getElementById(id)
const clock = () =>
  new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

// Everything the container needs besides the RAM image: the world, the thumbnail, and this
// instance's tracking log.
//
// The thumbnail is captured only for deliberate saves. An autosave skips it: the
// pagehide/beforeunload path is a race against the tab closing, and rendering plus
// PNG-encoding a frame there is exactly the wrong place to spend time (the canvas is
// often already gone by then anyway). Skipping it is free — packSession carries the
// previous container's thumbnail through untouched when we don't supply a new one.
//
// The tracking log is sealed on every save, including autosaves, because unlike the
// thumbnail it has changed since the last one and the previous chunk is this instance's
// own: rewriting it loses the newest spans rather than preserving anything.
const saveOptions = async ({ withThumb = true, expectGen } = {}) => ({
  world,
  prior: session.prior,
  instanceId,
  expectGen,
  thumb: withThumb ? await captureScreen({ maxWidth: THUMB_WIDTH }) : null,
  hb: await sealTracking(),
})

let saving = false
async function doSave(label = 'saved', { auto = false, force = false } = {}) {
  // Whether this save may happen at all is session.js's call: ?nosave, a shared machine
  // on the autosave path, an unreadable save we must not clobber, or one already in
  // flight. An autosave that declines says nothing, since nobody asked for it.
  const verdict = planSave({ params, session, isShared, auto, force, saving })
  if (!verdict.allowed) return verdict.reason && setStatus(verdict.reason)
  saving = true
  try {
    const { size, save, gen } = await saveSession(
      emulator,
      await saveOptions(verdict)
    )
    Object.assign(session, applySave(session, { save, gen }))
    setStatus(`${label} ${clock()} · ${(size / 1e6).toFixed(1)} MB`)
  } catch (e) {
    if (e instanceof StorageFullError) {
      // The one save failure a user can act on, so it says what to do.
      console.warn(e.message)
      setStatus('out of browser storage — export to a file')
      alert(e.message)
      return
    }
    if (e instanceof StaleSaveError) {
      // Another tab owns this machine now. Silently winning would discard its work.
      console.warn(e.message)
      setStatus('another tab saved this machine — reload to continue here')
      return
    }
    console.error(e)
    setStatus(`save failed (${e.name})`)
  } finally {
    saving = false
  }
}

// A shared machine indicates itself in the toolbar and never autosaves. A manual save
// is still allowed, but it overwrites the user's own saved session — so we warn first.
if (isShared) $('shared-badge')?.removeAttribute('hidden')

$('save')?.addEventListener('click', () => {
  if (
    isShared &&
    !confirm(
      "You're viewing a shared machine. Saving will overwrite your own saved " +
        'machine with it. Are you sure?'
    )
  )
    return
  // A save we couldn't parse is still someone's machine, so replacing it is a decision
  // the user has to make explicitly rather than something an autosave does quietly.
  if (
    session.blocked &&
    !confirm(
      `${session.blocked}\n\nSaving will replace the machine stored here, permanently. ` +
        'Continue?'
    )
  )
    return
  // Replacing an unreadable save is deliberate, so it skips the compare-and-swap. (A
  // shared machine already boots with no generation claim, so it needs no special case.)
  doSave('saved', { force: !!session.blocked })
})
$('export')?.addEventListener('click', async () => {
  try {
    const bytes = await exportSession(emulator, await saveOptions())
    setStatus(`exported ${clock()} · ${(bytes / 1e6).toFixed(1)} MB`)
  } catch (e) {
    console.error(e)
    setStatus('export failed')
  }
})

// Render the guest framebuffer to a PNG. screen_make_screenshot() returns an <img>
// already at native guest resolution (graphics) or char-cell resolution (text mode).
// Nearest-neighbour only, both ways: Win98 is pixel art and any smoothing turns it to
// mush. `scale` blows every guest pixel up to an N×N block for the download; `maxWidth`
// shrinks it for the thumbnail embedded in a save.
async function captureScreen({ scale = 1, maxWidth = 0 } = {}) {
  if (!running) return null
  const img = emulator.screen_make_screenshot()
  if (!img) return null
  try {
    if (img.decode) await img.decode()
    else if (!img.complete)
      await new Promise((res, rej) => {
        img.onload = res
        img.onerror = rej
      })
    const factor = maxWidth ? Math.min(1, maxWidth / img.naturalWidth) : scale
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(img.naturalWidth * factor))
    c.height = Math.max(1, Math.round(img.naturalHeight * factor))
    const ctx = c.getContext('2d')
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(img, 0, 0, c.width, c.height)
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'))
    return new Uint8Array(await blob.arrayBuffer())
  } catch (e) {
    // A frame isn't always capturable — mid-navigation the canvas is already gone and
    // decode() throws. Never let that break a save; a thumbnail is decoration.
    console.debug('screen capture unavailable:', e.message)
    return null
  }
}

const SHOT_SCALE = 3
const THUMB_WIDTH = 320

$('screenshot')?.addEventListener('click', async () => {
  const blob = await captureScreen({ scale: SHOT_SCALE })
  if (!blob) return setStatus('screenshot unavailable')
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `like-its-1999-${stamp}.png`
  a.click()
  URL.revokeObjectURL(a.href)
  setStatus(`screenshot ${clock()}`)
})
$('import-btn')?.addEventListener('click', () => $('import')?.click())
$('import')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0]
  if (!file) return
  setStatus('importing…')
  try {
    // Read first, then ask. The file names its own world, which may not be the one
    // running, so only now can we say accurately what would be replaced.
    const imported = await readImport(file, world)
    const verdict = planImport({ imported, params })
    if (verdict.refuse) throw new Error(verdict.refuse)
    if (
      verdict.needsConfirm &&
      !confirm(
        `This will replace the machine saved for ${imported.world.label}` +
          (verdict.replaces.at
            ? `, last saved ${new Date(verdict.replaces.at).toLocaleString()}`
            : '') +
          '.\n\nThat cannot be undone. Continue?'
      )
    ) {
      setStatus('import cancelled')
      e.target.value = ''
      return
    }

    // A state only restores into the machine it was captured on, so a file from another
    // world can't be applied live: store it and reload into that world.
    if (verdict.needsReload) {
      await storeImport(imported)
      setStatus(`imported a ${imported.world.label} machine — reloading…`)
      const url = new URL(location.href)
      url.searchParams.delete('share')
      url.searchParams.delete('fresh')
      url.searchParams.set('world', imported.world.id)
      location.replace(url)
      return
    }

    await emulator.restore_state(asArrayBuffer(imported.state))
    Object.assign(
      session,
      applySave(session, {
        save: imported.save,
        gen: params.nosave ? null : await storeImport(imported),
      })
    )
    setStatus(`imported ${clock()}`)
  } catch (err) {
    console.error(err)
    setStatus(
      err instanceof StaleSaveError
        ? 'that machine was saved in another tab — reload and try again'
        : `import failed: ${err.message}`
    )
  }
  e.target.value = ''
})
// File browser: read the disks straight from the live VM's buffers (merges the
// guest's writes and reuses v86's chunk cache — no save_state, no re-download) and let
// the user download files / folders. Built lazily on first click, then reused; each
// disk's FAT is only read when that disk is first opened.
let browser = null
$('browse')?.addEventListener('click', async () => {
  try {
    if (!browser)
      browser = createFileBrowser({
        disks: [
          { label: 'C:\\', fs: () => openLiveFs(emulator, 'hda') },
          { label: 'D:\\', fs: () => openLiveFs(emulator, 'hdb') },
        ],
      })
    browser.open('/')
  } catch (e) {
    setStatus('browse failed: ' + e.message)
    console.error(e)
  }
})

// --- CD-ROM: user image import + preset discs ---------------------------------
// v86 always builds a secondary-master ATAPI CD-ROM device (see cpu.js), even when
// no `cdrom` is passed at boot — so emulator.set_cdrom()/eject_cdrom() just work,
// no change to the V86 config above needed. Win98 sees it as drive E:, and only one
// disc can be "in the drive" at a time, same as the real hardware this emulates. The
// toolbar button + upload/preset/dev-iso modal live in cdrom-ui.js.
//
// Preset discs are static, hosted, read-only images (built like hda.img). Mount them
// by URL (`{ url, size, async: true }`) rather than `{ buffer }` — that makes v86
// treat it like hda/hdb (an AsyncXHRBuffer whose save_state only serializes its
// sparse overlay), so a preset never gets embedded whole into every autosave.
// URL mounts only work with the ATAPI patches below — see cdrom-atapi-fix.js.
installAtapiCdromFix(emulator)
// Preset discs sit next to the disks they ship with, so derive their base from the
// world rather than a module constant. Any disk will do: a world is only required to
// have one, and it needn't be hda.
const assetBase = (Object.values(world.disks)[0]?.url ?? '/vm/').replace(
  /[^/]*$/,
  ''
)
const PRESETS = [
  {
    id: 'win98se',
    label: 'Windows 98 Second Edition (E:\\win98)',
    url: assetBase + 'presets/win98se.iso',
    size: 655591424,
  },
]

$('cdrom-slot')?.replaceWith(
  createCdromControl({ emulator, presets: PRESETS, setStatus })
)

// Like power-cycling the PC: reboots the CPU + reloads the BIOS and clears RAM, so
// Win98 comes up from a cold start. The disks (C:, D:, and whatever's in the CD-ROM
// drive) are untouched — unlike "Reset" below, no disk state is discarded, and the
// machine boots straight back into the current C:.
//
// We must zero RAM ourselves: v86's restart() (-> cpu.reboot_internal()) deliberately
// leaves memory intact, which is a *warm* reboot. Win98 does not survive that here — it
// boots on top of the previous session's stale VMM structures and wedges (bare desktop,
// hourglass, ring-0 spin forever). Clearing RAM first turns it into a real cold boot,
// which also makes this the recovery path for a memory-corrupted session (e.g. a broken
// ?share= snapshot): the poisoned RAM is thrown away and only the clean disk survives.
$('reboot')?.addEventListener('click', () => {
  if (
    !confirm(
      'Force-reboot the machine? Unsaved work in open programs will be lost.'
    )
  )
    return
  const cpu = emulator.v86.cpu
  cpu.zero_memory(0, cpu.memory_size[0]) // cold boot: discard RAM (see above)
  emulator.restart() // synchronous — cpu.reboot_internal() has already run by the time this returns
  setStatus(`rebooted ${clock()}`)
})

// Reset always completes, deliberately: it is the escape hatch for a machine that is
// already in a bad state, so it must not be refusable. But if another tab has saved since
// this one loaded, the machine being discarded is not the one the user has in mind, so they
// get told before it goes.
$('reset')?.addEventListener('click', async () => {
  if (!confirm('Discard your saved session and reset to the clean image?'))
    return
  const current = (await listSavedWorlds()).find((s) => s.worldId === world.id)
  if (
    current?.gen != null &&
    session.gen != null &&
    current.gen !== session.gen &&
    !confirm(
      'This machine was saved in another tab since you opened this one, so the ' +
        'machine you are discarding is newer than the one you have been looking at.' +
        '\n\nDiscard it anyway?'
    )
  )
    return
  await clearSavedSession(world)
  const url = new URL(location.href)
  url.searchParams.delete('share')
  location.replace(url)
})

// Autosave periodically and when the tab is hidden (best-effort before close).
setInterval(() => doSave('autosaved', { auto: true }), 120_000)

// Listen on the TOP document (same-origin): the iframe's own visibilitychange is
// unreliable, and the top document is the authoritative tab-visibility source. We
// prefer visibilitychange over 'blur' — blur fires on every focus change (devtools,
// alt-tab to another app, address bar), far too often for a ~65 MB save, and it also
// fires while the tab is still visible. This only fires when the tab is genuinely
// hidden (switch/minimize/close). pagehide is a best-effort catch for navigation/
// close (async may not finish there — the 2-min timer is the real safety net).
const topDoc = (() => {
  try {
    return window.top.document
  } catch {
    return document
  }
})()
topDoc.addEventListener('visibilitychange', () => {
  const hidden = topDoc.visibilityState === 'hidden'
  // Recorded rather than acted on: whether a hidden tab's time counts is a policy question
  // for whatever tallies hours later, and a hidden tab barely executes the guest anyway.
  link.visibility(!hidden)
  if (hidden) doSave('autosaved', { auto: true })
})
window.addEventListener('pagehide', () => doSave('autosaved', { auto: true }))

// Warn before the tab actually closes/navigates away, and kick off a best-effort
// save right then too — visibilitychange usually beats us to it, but this covers
// browsers/paths where hidden fires late or not at all. beforeunload must be bound
// on the top window (closing/navigating the iframe alone doesn't leave the page).
const topWin = (() => {
  try {
    return window.top
  } catch {
    return window
  }
})()
// Warn only. The visibilitychange handler above has already fired by this point, so a
// second save here would just race the first (the in-flight one wins and this one is
// dropped) while making the teardown path slower.
topWin.addEventListener('beforeunload', (e) => {
  e.preventDefault()
  e.returnValue = ''
})

// Expose for poking around in the console. The surface, and what is gated to dev, is in
// debug.js; it exists because driving this machine from a console is how it gets debugged.
window.like99 = installDebug({
  emulator,
  link,
  world,
  params,
  instanceId,
  save: () => doSave('saved'),
})
