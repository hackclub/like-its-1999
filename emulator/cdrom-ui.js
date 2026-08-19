// toolbar button + <dialog> for the guest's one CD-ROM drive: mount a file upload
// (reencoded via media-import.js), a preset disc, or (dev only) a raw .iso. see
// main.js for why set_cdrom()/eject_cdrom() need no boot-time config, and why presets
// mount by URL while uploads mount as a buffer
import { buildMediaCdrom } from './media-import.js'
import { buildIso9660 } from './vmfs/iso9660.js'
import { uniqueBaseName } from './iso-name.js'

const CSS = `
.cdrom-dialog { width: min(420px, 92vw); padding: 0; border: 1px solid #888; background: #fff; color: #111; font: 13px system-ui, sans-serif; }
.cdrom-dialog::backdrop { background: rgba(0,0,0,.4); }
.cdrom-body { display: flex; flex-direction: column; }
.cdrom-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid #ddd; }
.cdrom-head .title { flex: 1; font-weight: bold; }
.cdrom-section { padding: 10px; border-bottom: 1px solid #eee; display: flex; flex-direction: column; gap: 6px; }
.cdrom-section .label { font-weight: bold; }
.cdrom-section .hint { color: #888; }
.cdrom-row { display: flex; gap: 6px; align-items: center; }
.cdrom-row select { flex: 1; }
.cdrom-foot { display: flex; gap: 8px; padding: 8px 10px; }
.cdrom-foot .msg { flex: 1; color: #888; align-self: center; }
.cdrom-dialog button { cursor: pointer; }
.cdrom-dialog button[disabled], .cdrom-dialog input[disabled] { opacity: .5; cursor: default; }
.cdrom-body .cdrom-section:last-of-type { border-bottom: none; }
`

function injectStyles() {
  if (document.getElementById('cdrom-style')) return
  const el = document.createElement('style')
  el.id = 'cdrom-style'
  el.textContent = CSS
  document.head.appendChild(el)
}

// `presets`: [{ id, label, url, size }, ...]. `setStatus`: the toolbar status line
export function createCdromControl({
  emulator,
  presets = [],
  setStatus = () => {},
  // opens the mounted disc in the guest's shell, best-effort: see revealDisc in main.js.
  // never awaited and never surfaced, since the disc is mounted either way
  revealDisc = null,
}) {
  injectStyles()

  const btn = document.createElement('button')
  btn.type = 'button'
  let mounted = false
  let busy = false
  // disabled rather than absent until the guest is running, matching the HTML
  // placeholder it replaces so there's no flicker or layout shift
  let ready = false
  const renderBtn = () => {
    btn.textContent = mounted ? 'Eject disc' : 'Add files...'
    btn.disabled = busy || !ready
  }
  renderBtn()

  // a restored session can already have a disc in the drive before this control runs
  // a mount() itself (see persist.js), so sync the label here. no public V86 API for
  // "is a disc in the drive", so reach the device directly as vmfs/blockdev.js does
  emulator.add_listener('emulator-started', () => {
    ready = true
    if (emulator.v86?.cpu?.devices?.cdrom?.has_disk?.()) mounted = true
    renderBtn()
  })

  const dialog = document.createElement('dialog')
  dialog.className = 'cdrom-dialog'
  dialog.innerHTML = `
    <div class="cdrom-body">
      <div class="cdrom-head">
        <span class="title">Add files to the CD drive (E:)</span>
        <button data-close>Close</button>
      </div>
      <div class="cdrom-section" data-files-section>
        <span class="label">Add files</span>
        <span class="hint">They arrive on the CD drive as Imported (E:). Copy them onto
          the hard disk before you edit them, because E: is read-only.</span>
        <span class="hint">Images: .png, .jpg, .gif (animated), .webp, .bmp</span>
        <span class="hint">Audio: .mp3, .wav, .ogg, .mid</span>
        <span class="hint">Fonts: .ttf, .otf, .woff, .woff2</span>
        <input type="file" accept="image/*,audio/*,.mid,.midi,font/*,.ttf,.otf,.woff,.woff2" multiple data-files />
      </div>
    </div>`
  document.body.appendChild(dialog)

  const body = dialog.querySelector('.cdrom-body')
  const $ = (sel) => dialog.querySelector(sel)
  const mountControlsExtra = [] // dev-only controls append themselves here

  if (presets.length) {
    const section = document.createElement('div')
    section.className = 'cdrom-section'
    section.innerHTML = `
      <span class="label">Preset discs</span>
      <div class="cdrom-row">
        <select data-preset></select>
        <button data-mount-preset>Mount</button>
      </div>`
    const select = section.querySelector('select')
    for (const p of presets) {
      const opt = document.createElement('option')
      opt.value = p.id
      opt.textContent = p.label
      select.append(opt)
    }
    body.append(section)
  }

  // Vite inlines and dead-code-eliminates import.meta.env.DEV, so this section and
  // the listener behind it never ship
  if (import.meta.env.DEV) {
    const section = document.createElement('div')
    section.className = 'cdrom-section'
    section.innerHTML = `
      <span class="label">Load .iso (dev only)</span>
      <input type="file" accept=".iso" data-iso />`
    body.append(section)
  }

  // dev-only escape hatch on "Upload files": skip the reencode and put raw file bytes
  // on the disc unsanitized, for checking that files which shouldn't survive the real
  // pipeline (a renamed non-image, say) are actually rejected by it. stripped from
  // production along with buildRawCdrom
  let prepareFiles = (files) => buildMediaCdrom(files)
  if (import.meta.env.DEV) {
    const label = document.createElement('label')
    label.innerHTML =
      '<input type="checkbox" data-skip-reencode /> Skip reencode (dev only)'
    $('[data-files-section]').append(label)
    const skipReencodeCheckbox = label.querySelector('[data-skip-reencode]')
    mountControlsExtra.push(skipReencodeCheckbox)

    const buildRawCdrom = async (files) => {
      const used = new Set()
      const entries = []
      for (const file of files) {
        const dot = file.name.lastIndexOf('.')
        const ext = dot === -1 ? 'BIN' : file.name.slice(dot + 1)
        const data = new Uint8Array(await file.arrayBuffer())
        entries.push({
          name: `${uniqueBaseName(file.name, used)}.${ext}`,
          data,
        })
      }
      return buildIso9660({ volumeLabel: 'RAW', files: entries })
    }

    prepareFiles = (files) =>
      skipReencodeCheckbox.checked
        ? buildRawCdrom(files)
        : buildMediaCdrom(files)
  }

  const foot = document.createElement('div')
  foot.className = 'cdrom-foot'
  foot.innerHTML = '<span class="msg"></span>'
  body.append(foot)
  const setMsg = (t) => (foot.querySelector('.msg').textContent = t || '')

  // disabled while a mount is in flight so a slow reencode can't resolve in the
  // background and clobber whatever was mounted after it; the generation counter
  // below is what actually guarantees that if one of these fires anyway
  const mountControls = [
    $('[data-files]'),
    $('[data-mount-preset]'),
    $('[data-preset]'),
    $('[data-iso]'),
    ...mountControlsExtra,
  ].filter(Boolean)
  const setBusy = (b) => {
    busy = b
    renderBtn()
    for (const el of mountControls) el.disabled = b
  }

  $('[data-close]').addEventListener('click', () => dialog.close())

  // identifies the current mount/eject action, so a mount() only applies its result if
  // nothing newer superseded it. applying a stale result is the "closed the dialog on
  // the files upload, mounted the preset instead, then the files upload finished late
  // and silently overwrote it" bug
  let generation = 0

  // `prepare` does the slow part (reencoding, or an arrayBuffer() read); `apply` does
  // the emulator.set_cdrom() call, effectively instant for every caller below
  async function mount(prepare, apply, label, reveal = false) {
    const myGen = ++generation
    setBusy(true)
    setMsg(`mounting ${label}...`)
    try {
      const prepared = await prepare()
      if (myGen !== generation) return // superseded, drop this result

      // the guest learns about the swap via cdrom-atapi-fix.js: set_cdrom() sets v86's
      // medium_changed, and the patched TEST UNIT READY turns that into the UNIT
      // ATTENTION response Win98 reacts to. the eject IRQ alone does nothing, since
      // Win98 ignores it and detects media purely by polling
      emulator.eject_cdrom()
      await apply(prepared)
      if (myGen !== generation) return // superseded mid-apply

      mounted = true
      setStatus(`mounted ${label}`)
      dialog.close()
      if (reveal && revealDisc) revealDisc()
    } catch (e) {
      if (myGen !== generation) return // don't report a stale error over a newer action
      mounted = false
      setMsg('error: ' + e.message)
      console.error(e)
    } finally {
      if (myGen === generation) setBusy(false)
    }
  }

  $('[data-files]').addEventListener('change', (e) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (!files.length) return
    mount(
      () => prepareFiles(files),
      (iso) => emulator.set_cdrom({ buffer: iso.buffer }),
      `${files.length} file(s)`,
      true
    )
  })

  $('[data-mount-preset]')?.addEventListener('click', () => {
    const preset = presets.find((p) => p.id === $('[data-preset]').value)
    if (!preset) return
    mount(
      () => preset,
      (p) =>
        emulator.set_cdrom({
          url: p.url,
          size: p.size,
          async: true,
          fixed_chunk_size: 256 * 1024,
        }),
      preset.label
    )
  })

  $('[data-iso]')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    mount(
      () => file.arrayBuffer(),
      (buffer) => emulator.set_cdrom({ buffer }),
      file.name
    )
  })

  btn.addEventListener('click', () => {
    if (busy) return
    if (mounted) {
      generation++ // invalidate any in-flight mount so it can't clobber this eject
      emulator.eject_cdrom()
      mounted = false
      renderBtn()
      setStatus('CD ejected')
    } else {
      setMsg('')
      dialog.showModal()
    }
  })

  return btn
}
