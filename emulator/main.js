import { V86 } from 'v86'

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

// custom win98 image (built in tmp-image-build/, checkpoint 03): C: (hda) is win98 se
// with the web-dev toolkit installed, D: (hdb) holds the toolkit itself, state.bin.zst
// is a boot snapshot of the settled desktop
// disks are async and guest writes go to an in-memory overlay that is never written
// back, so D: is effectively read-only and only C: writes matter for a submission
//
// a v86 state only restores against the disks it was captured on, so an image plus its
// machine config is a world (worlds.js). boot order: shared machine, else a requested
// world, else this build's current world
const params = readModeParams()
const status = document.getElementById('status')
const setStatus = (text) => {
  if (status) status.textContent = text
}

// per restore, not per save: one saved machine can be restored many times and the
// tracking data has to tell those apart later
const instanceId = crypto.randomUUID()

// legacy v1 shares (a bare gzipped state, which is every link published so far) carry
// no world, so they resolve to the legacy world and keep booting against v1 disks
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

let world = shared?.world ?? null
let worldNote = ''
if (!world) {
  try {
    world = await currentWorld(params)
  } catch (e) {
    // fall back rather than stop: a modal here blocks the page before the emulator exists
    console.error('requested world unavailable:', e)
    worldNote = e.message
    params.world = null
    world = await currentWorld(params)
  }
}

const saved = isShared || params.fresh ? null : await loadSavedSession(world)
// the index, not the records: this only needs to know which other slots exist
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

// v86 reads `.buffer` off what it is handed, so a subarray view would give it the
// wrong bytes
const asArrayBuffer = (u8) =>
  u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength
    ? u8.buffer
    : u8.slice().buffer

// v86 decompresses the shipped .zst itself; a cold boot passes nothing and comes up
// from the bios
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

  // memory/vga sizes, the disks and COM2 come from the world; they must match what the
  // state was captured with or restore_state fails
  ...worldToV86Config(world, { initialState }),

  autostart: true,
})

// download-progress keeps firing for lazy disk reads during normal use, so only show
// it before the guest starts
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

// talks to the in-guest agent over COM1. every world shipped so far has no agent, so an
// absent one is normal and must stay quiet: the log still records input either way
// fetched rather than imported so the hash comes from the bytes, and so a build with no
// agent binary does not stop the page
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

// encryption keeps window titles (file names, paths) out of an artifact participants
// publish; the signature anchors when the bytes existed. both are best-effort: a save
// must never fail because a key is missing or the signing endpoint is down
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

// offline, or no endpoint deployed, is an ordinary outcome rather than an error
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

// win98 is pixel art, so draw it at the largest whole number of device pixels per guest
// pixel that fits
//
// screen_set_scale(s) does not map s directly to pixels: v86 folds in a per-video-mode
// factor (1 in svga/true color, 2 in plain vga) that is not the devicePixelRatio, so
// devicePxPerGuestPx = s * modeFactor * dpr. measure modeFactor per mode, then invert
const holder = document.getElementById('screen_holder')
const canvas = document.querySelector('#screen_container canvas')
const textDiv = document.querySelector('#screen_container div')
let guestW = 0
let guestH = 0
let modeFactor = 1 // css px per guest px at scale 1

// never trust a measurement of 0: v86 sizes an element as (measured rect * scale), so
// measuring a hidden one writes width:0 and the screen goes black with the guest still
// drawing into it (what happened on exit from a dos text-mode program)
function measureModeFactor() {
  if (!guestW) return
  emulator.screen_set_scale(1, 1)
  const w = canvas.getBoundingClientRect().width
  if (w > 0) modeFactor = w / guestW
}

// text mode cannot share the graphical path:
//   - `screen-set-size` reports character cells (80x25), not pixels, so the integer
//     device-multiple maths below would divide the viewport by 80 and overshoot ~9x
//   - v86 scales the text <div> twice: elem_set_scale writes an explicit width/height of
//     (measured rect * scale) and a css transform of the same scale, so the glyphs grow
//     by s while the layout box grows by s^2 and the flex holder centres the empty space
//
// so: fit the glyphs to the holder, anchor the transform top-left (see index.html), then
// put the box back to the glyph extent so centring works on what is visible
function rescaleText() {
  emulator.screen_set_scale(1, 1)
  const nat = textDiv.getBoundingClientRect()
  if (!nat.width || !nat.height) return
  const s = Math.min(
    holder.clientWidth / nat.width,
    holder.clientHeight / nat.height
  )
  emulator.screen_set_scale(s, s)
  textDiv.style.width = nat.width * s + 'px'
  textDiv.style.height = nat.height * s + 'px'
}

// ask the dom rather than trust the last screen-set-size: returning from a full-screen
// dos box does not reliably fire the event, and a stale text-mode flag makes every later
// rescale measure the hidden div, get 0 and give up, leaving the screen at 1:1
const inTextMode = () => getComputedStyle(canvas).display === 'none'

function rescale() {
  if (inTextMode()) return rescaleText()
  if (!guestW || !guestH) return
  const dpr = window.devicePixelRatio || 1
  // the holder reflects the available space under both fullscreen paths (parent
  // fullscreens the iframe, or standalone the holder fullscreens itself)
  const availW = holder.clientWidth * dpr
  const availH = holder.clientHeight * dpr
  const deviceMultiple = Math.max(
    1,
    Math.floor(Math.min(availW / guestW, availH / guestH))
  )
  const scale = deviceMultiple / (modeFactor * dpr)
  emulator.screen_set_scale(scale, scale)
}

emulator.add_listener('screen-set-size', ([w, h, bpp]) => {
  // bpp is the only thing separating the two callers in v86's vga.js: text mode sends
  // [cols, rows, 0], graphical sends [width, height, bpp] and only those are guest pixels
  if (bpp !== 0) {
    guestW = w
    guestH = h
  }
  // v86 swaps which element is visible around this event, so measuring now reads the
  // outgoing one. the swap back from a full-screen dos box can take longer than a frame,
  // hence the second, later measurement
  requestAnimationFrame(() => {
    if (!inTextMode()) measureModeFactor()
    rescale()
  })
  setTimeout(() => {
    if (!inTextMode()) measureModeFactor()
    rescale()
  }, 250)
})
window.addEventListener('resize', rescale)
document.addEventListener('fullscreenchange', rescale)

// prefer the parent shell: only the top-level document can keyboard.lock(), which is
// what lets Esc/Tab reach win98. called synchronously from the click so the user
// activation (which propagates to the parent) is still valid for requestFullscreen
// no pointer lock either way: it switches the guest to relative mouse (inverted Y,
// unnatural sensitivity) instead of the absolute driver that tracks the host 1:1
document.getElementById('fullscreen').addEventListener('click', () => {
  let parentFn = null
  try {
    if (window.parent !== window)
      parentFn = window.parent.enterEmulatorFullscreen
  } catch {}
  if (parentFn) parentFn()
  else holder.requestFullscreen?.().catch(() => {})
})

// the parent owns the fullscreen (it is on the iframe element), so it is invisible to
// document.fullscreenElement here and the parent messages us instead
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.data?.type !== 'fullscreen') return
  document.body.classList.toggle('fs', e.data.on)
  rescale()
})

// Win98 powers the monitor down after a while, and v86 answers by collapsing the screen
// elements to nothing. That kills the mouse outright: v86 gates every mouse event on
// is_child(e.target, screen_container) (mouse.js may_handle), and a zero-sized container can
// never contain the target, so no click is ever delivered. Keys still get through — the
// keyboard adapter binds to window with no such gate — but the machine looks dead, and a
// participant has neither that knowledge nor a console to rescue themselves with.
//
// So take the click ourselves and send a harmless left shift (make + break), which wakes the
// display without typing anything into whatever has focus in the guest.
holder.addEventListener('pointerdown', () => {
  const collapsed =
    !canvas.getBoundingClientRect().width &&
    !textDiv.getBoundingClientRect().width
  if (collapsed) emulator.keyboard_send_scancodes([0x2a, 0xaa])
})

// A trackpad flick freezes Win98, and it takes two v86 bugs to do it.
//
// mouse.js:317 collapses every wheel event to a single ±1 notch and calls
// send_mouse_packet, so a 0.01-pixel inertial tick costs a full 4-byte PS/2 packet and an
// IRQ12 — exactly as much as a real wheel click. A macOS trackpad emits those at 60-120Hz
// and momentum keeps them coming after the fingers lift, which is several hundred
// interrupts from one gesture. Then ps2.js's 1024-byte mouse_buffer overflows, and
// ByteQueue.push (lib.js:257) overwrites the oldest byte *without advancing start*. Packets
// are 4 bytes, so the ring desyncs and the guest starts reading byte 3 of one packet as
// byte 1 of the next: that is why the pointer stays wrong afterwards rather than just
// catching up.
//
// Coalescing here rather than patching v86 keeps the fix in our own code. One notch per
// FLUSH_MS is ~17/second, far above what a 1999 wheel could physically produce and far
// below what drowns the guest. The threshold is in normalised pixels so a real wheel (100+
// per click) still moves immediately while inertial dribble accumulates.
const WHEEL_FLUSH_MS = 60
const WHEEL_NOTCH_PX = 40
let wheelAcc = 0
let wheelLastFlush = 0

// deltaMode 1 is lines and 2 is pages; both are rare, but a page-mode event is worth ~100x
// a pixel one and would otherwise read as no scroll at all
const wheelPixels = (e) =>
  e.deltaMode === 1
    ? e.deltaY * 16
    : e.deltaMode === 2
      ? e.deltaY * 400
      : e.deltaY

// capture on window runs before v86's own bubble-phase listener on the same target, so
// stopImmediatePropagation keeps the raw event away from it entirely. Only events over the
// screen are taken: v86 ignores the rest anyway (may_handle), and swallowing them would
// break scrolling on the page around it.
window.addEventListener(
  'wheel',
  (e) => {
    if (!canvas.parentNode.contains(e.target)) return
    e.preventDefault()
    e.stopImmediatePropagation()

    wheelAcc += wheelPixels(e)
    const now = performance.now()
    if (now - wheelLastFlush < WHEEL_FLUSH_MS) return
    if (Math.abs(wheelAcc) < WHEEL_NOTCH_PX) return

    // v86 reads e.wheelDelta, which is positive scrolling up, whereas deltaY is positive
    // scrolling down
    const notch = wheelAcc > 0 ? -1 : 1
    wheelAcc -= notch * -WHEEL_NOTCH_PX
    wheelLastFlush = now
    emulator.bus?.send('mouse-wheel', [notch, 0])
  },
  { capture: true, passive: false }
)

// sessions are stored in IndexedDB as a `.99sv` container (savefile.js) keyed by world;
// an export is the same container as a file, which is what a ?share= url points at
const $ = (id) => document.getElementById(id)
const clock = () =>
  new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

// an autosave skips the thumbnail: it runs on the pagehide path where the canvas is
// often already gone, and packSession carries the previous container's thumbnail through
// when none is supplied. the tracking log is sealed on every save because the previous
// chunk is this instance's own, so keeping it would drop the newest spans
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
  // an autosave that declines says nothing, since nobody asked for it
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
      console.warn(e.message)
      setStatus('out of browser storage — export to a file')
      alert(e.message)
      return
    }
    if (e instanceof StaleSaveError) {
      // another tab owns this machine now; winning silently would discard its work
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
  // a save we couldn't parse is still someone's machine, so replacing it has to be an
  // explicit decision rather than something an autosave does quietly
  if (
    session.blocked &&
    !confirm(
      `${session.blocked}\n\nSaving will replace the machine stored here, permanently. ` +
        'Continue?'
    )
  )
    return
  // replacing an unreadable save is deliberate, so it skips the compare-and-swap
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

// screen_make_screenshot() returns an <img> at native guest resolution (graphics) or
// char-cell resolution (text mode). nearest-neighbour both ways: win98 is pixel art and
// smoothing turns it to mush
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
    // mid-navigation the canvas is already gone and decode() throws; a thumbnail is
    // decoration and must never break a save
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
    // read first, then ask: the file names its own world, which may not be the one
    // running, so only now can we say what would be replaced
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

    // a state only restores into the machine it was captured on, so a file from another
    // world cannot be applied live: store it and reload into that world
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
// reads the disks from the live vm's buffers, which merges the guest's writes and
// reuses v86's chunk cache, so no save_state and no re-download
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

// v86 always builds a secondary-master atapi cd-rom device (see cpu.js) even when no
// `cdrom` is passed at boot, so set_cdrom()/eject_cdrom() work with no change to the
// V86 config above. win98 sees it as drive E:
//
// mount presets by url (`{ url, size, async: true }`) rather than `{ buffer }`: that
// gives an AsyncXHRBuffer whose save_state only serializes the sparse overlay, so a
// preset is never embedded whole into every autosave. url mounts need cdrom-atapi-fix.js
installAtapiCdromFix(emulator)
// preset discs sit next to the disks they ship with, so derive their base from the
// world. any disk will do: a world is only required to have one and it needn't be hda
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

// power-cycles the pc: the disks (C:, D:, and whatever is in the cd-rom drive) survive
//
// ram has to be zeroed by hand: v86's restart() (-> cpu.reboot_internal()) leaves memory
// intact, which is a warm reboot, and win98 does not survive that here (it boots on top
// of the previous session's stale vmm structures and wedges on a bare desktop). that
// also makes this the recovery path for a memory-corrupted session, e.g. a bad ?share=
$('reboot')?.addEventListener('click', () => {
  if (
    !confirm(
      'Force-reboot the machine? Unsaved work in open programs will be lost.'
    )
  )
    return
  const cpu = emulator.v86.cpu
  cpu.zero_memory(0, cpu.memory_size[0])
  emulator.restart() // synchronous: cpu.reboot_internal() has run by the time this returns
  setStatus(`rebooted ${clock()}`)
})

// reset always completes, deliberately: it is the escape hatch for a machine already in
// a bad state, so it must not be refusable. if another tab has saved since this one
// loaded, the machine being discarded is newer than the one on screen, so warn first
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

setInterval(() => doSave('autosaved', { auto: true }), 120_000)

// listen on the top document (same-origin): the iframe's own visibilitychange is
// unreliable. visibilitychange rather than 'blur' because blur fires on every focus
// change (devtools, alt-tab, address bar), far too often for a ~65 MB save. pagehide is
// best-effort for navigation/close; async may not finish there, so the timer above is
// the real safety net
const topDoc = (() => {
  try {
    return window.top.document
  } catch {
    return document
  }
})()
topDoc.addEventListener('visibilitychange', () => {
  const hidden = topDoc.visibilityState === 'hidden'
  // recorded rather than acted on: whether a hidden tab's time counts is a policy
  // question for whatever tallies hours later
  link.visibility(!hidden)
  if (hidden) doSave('autosaved', { auto: true })
})
window.addEventListener('pagehide', () => doSave('autosaved', { auto: true }))

// beforeunload has to be bound on the top window: closing or navigating the iframe
// alone does not leave the page
const topWin = (() => {
  try {
    return window.top
  } catch {
    return window
  }
})()
// warn only: the visibilitychange handler above has already fired by this point, so a
// save here would just race the in-flight one and be dropped
topWin.addEventListener('beforeunload', (e) => {
  e.preventDefault()
  e.returnValue = ''
})

// console handle for debugging; what it exposes and what is gated to dev is in debug.js
window.like99 = installDebug({
  emulator,
  link,
  world,
  params,
  instanceId,
  save: () => doSave('saved'),
})
