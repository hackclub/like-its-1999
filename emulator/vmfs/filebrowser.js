// <dialog> file browser over one or more FatFs disks (fat.js), taking any FatFs
// whatever its byte source; openLiveFs builds one over a running v86 emulator
//
//   createFileBrowser({
//     disks: [
//       { label: 'C:\\', fs: () => openLiveFs(emulator, 'hda') },
//       { label: 'D:\\', fs: () => openLiveFs(emulator, 'hdb') },
//     ],
//   })
//
// a disk's `fs` may be a FatFs or a `() => Promise<FatFs>` thunk, resolved on first
// use and cached; `createFileBrowser({ fs, title })` is the single-disk shorthand.
// `onDownload(path, isDir, fs)` replaces the default zip/file download, e.g. with
// "attach to a submission"

import { FatFs } from './fat.js'
import { v86Device } from './blockdev.js'
import { exportDirZip } from './extract.js'

// v86 exposes disk backends as the master/slave of each ide channel; hda is C:, hdb D:
export async function openLiveFs(emulator, disk = 'hda') {
  const ide = emulator?.v86?.cpu?.devices?.ide
  const iface = {
    hda: ide?.primary?.master,
    hdb: ide?.primary?.slave,
    hdc: ide?.secondary?.master,
    hdd: ide?.secondary?.slave,
  }[disk]
  if (!iface?.buffer) throw new Error(`emulator has no ${disk} disk`)
  return FatFs.open(v86Device(iface.buffer))
}

const basename = (path) => path.split('/').filter(Boolean).pop() || ''

function triggerDownload(bytes, name, type) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([bytes], { type }))
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
}

export async function downloadDirZip(fs, path) {
  const bytes = await exportDirZip(fs, path)
  triggerDownload(bytes, (basename(path) || 'disk') + '.zip', 'application/zip')
}

export async function downloadFile(fs, path) {
  const bytes = await fs.readFile(path)
  triggerDownload(bytes, basename(path) || 'file', 'application/octet-stream')
}

const CSS = `
.vmfs-dialog { width: min(560px, 92vw); max-height: 80vh; padding: 0; border: 1px solid #888; background: #fff; color: #111; font: 13px system-ui, sans-serif; }
.vmfs-dialog::backdrop { background: rgba(0,0,0,.4); }
.vmfs-dialog .vmfs-body { display: flex; flex-direction: column; max-height: 80vh; }
.vmfs-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid #ddd; }
.vmfs-head .title { flex: 1; font-weight: bold; }
.vmfs-crumbs { padding: 6px 10px; border-bottom: 1px solid #eee; word-break: break-all; }
.vmfs-crumbs button { background: none; border: none; color: #06c; cursor: pointer; padding: 0; font: inherit; }
.vmfs-crumbs span { color: #888; }
.vmfs-list { flex: 1; overflow: auto; padding: 4px 0; min-height: 120px; }
.vmfs-row { display: flex; align-items: center; gap: 8px; padding: 4px 10px; }
.vmfs-row.dir { cursor: pointer; }
.vmfs-row.dir:hover { background: #eef4ff; }
.vmfs-row .name { flex: 1; }
.vmfs-row .size { color: #888; font-variant-numeric: tabular-nums; }
.vmfs-row .dl { padding: 0 6px; }
.vmfs-foot { display: flex; gap: 8px; padding: 8px 10px; border-top: 1px solid #ddd; }
.vmfs-foot .msg { flex: 1; color: #888; align-self: center; }
.vmfs-dialog button.action { cursor: pointer; }
.vmfs-dialog button[disabled] { opacity: .5; cursor: default; }
`

function injectStyles() {
  if (document.getElementById('vmfs-style')) return
  const el = document.createElement('style')
  el.id = 'vmfs-style'
  el.textContent = CSS
  document.head.appendChild(el)
}

const fmtSize = (n) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(1)} MB`

export function createFileBrowser({
  disks,
  fs,
  title = 'C:\\',
  onDownload,
} = {}) {
  injectStyles()
  const list0 = disks || [{ label: title, fs }]
  const diskList = list0.map((d) => {
    let resolved = null
    return {
      label: d.label,
      async get() {
        if (!resolved)
          resolved = typeof d.fs === 'function' ? await d.fs() : d.fs
        return resolved
      },
    }
  })

  const download =
    onDownload ||
    ((path, isDir, activeFs) =>
      isDir ? downloadDirZip(activeFs, path) : downloadFile(activeFs, path))

  const dialog = document.createElement('dialog')
  dialog.className = 'vmfs-dialog'
  dialog.innerHTML = `
    <div class="vmfs-body">
      <div class="vmfs-head"></div>
      <div class="vmfs-crumbs"></div>
      <div class="vmfs-list"></div>
      <div class="vmfs-foot">
        <span class="msg"></span>
        <button class="action" data-download disabled>Download this folder (.zip)</button>
      </div>
    </div>`
  document.body.appendChild(dialog)

  const $ = (sel) => dialog.querySelector(sel)
  const head = $('.vmfs-head')
  const crumbs = $('.vmfs-crumbs')
  const list = $('.vmfs-list')
  const msg = $('.vmfs-foot .msg')
  const downloadBtn = $('[data-download]')

  let activeIdx = 0
  let current = '/'
  let fsCache = null
  const setMsg = (t) => (msg.textContent = t || '')
  const diskLabel = () => diskList[activeIdx].label

  function renderHead() {
    head.replaceChildren()
    if (diskList.length > 1) {
      const sel = document.createElement('select')
      sel.className = 'title'
      diskList.forEach((d, i) => {
        const opt = document.createElement('option')
        opt.value = String(i)
        opt.textContent = d.label
        sel.append(opt)
      })
      sel.value = String(activeIdx)
      sel.onchange = () => switchDisk(Number(sel.value))
      head.append(sel)
    } else {
      const label = document.createElement('span')
      label.className = 'title'
      label.textContent = diskLabel()
      head.append(label)
    }
    const spacer = document.createElement('span')
    spacer.style.flex = '1'
    const close = document.createElement('button')
    close.className = 'action'
    close.textContent = 'Close'
    close.onclick = () => dialog.close()
    head.append(spacer, close)
  }

  async function switchDisk(idx) {
    activeIdx = idx
    fsCache = null
    await navigate('/')
  }

  function renderCrumbs() {
    crumbs.replaceChildren()
    const root = document.createElement('button')
    root.textContent = diskLabel()
    root.onclick = () => navigate('/')
    crumbs.append(root)
    let acc = ''
    for (const p of current.split('/').filter(Boolean)) {
      acc += '/' + p
      const sep = document.createElement('span')
      sep.textContent = ' \\ '
      const b = document.createElement('button')
      b.textContent = p
      const target = acc
      b.onclick = () => navigate(target)
      crumbs.append(sep, b)
    }
  }

  function makeDownloadButton(path, isDir) {
    const btn = document.createElement('button')
    btn.className = 'action dl'
    btn.textContent = '⬇'
    btn.title = isDir ? 'Download folder as .zip' : 'Download file'
    btn.onclick = async (ev) => {
      ev.stopPropagation() // don't also navigate into the folder
      btn.disabled = true
      setMsg((isDir ? 'Zipping ' : 'Downloading ') + basename(path) + ' ...')
      try {
        await download(path, isDir, await diskList[activeIdx].get())
        setMsg('Done.')
      } catch (e) {
        setMsg('Error: ' + e.message)
      } finally {
        btn.disabled = false
      }
    }
    return btn
  }

  async function navigate(path) {
    current = path
    downloadBtn.disabled = true
    setMsg('Loading...')
    renderCrumbs()
    list.replaceChildren()
    let entries
    try {
      fsCache = await diskList[activeIdx].get()
      entries = await fsCache.readdir(path)
    } catch (e) {
      setMsg('Error: ' + e.message)
      return
    }
    entries.sort((a, b) => b.isDir - a.isDir || a.name.localeCompare(b.name))
    for (const e of entries) {
      const childPath = path === '/' ? `/${e.name}` : `${path}/${e.name}`
      const row = document.createElement('div')
      row.className = 'vmfs-row' + (e.isDir ? ' dir' : '')
      const icon = document.createElement('span')
      icon.textContent = e.isDir ? '📁' : '📄'
      const name = document.createElement('span')
      name.className = 'name'
      name.textContent = e.name
      row.append(icon, name)
      if (!e.isDir) {
        const size = document.createElement('span')
        size.className = 'size'
        size.textContent = fmtSize(e.size)
        row.append(size)
      } else {
        row.onclick = () => navigate(childPath)
      }
      row.append(makeDownloadButton(childPath, e.isDir))
      list.append(row)
    }
    setMsg(`${entries.length} item${entries.length === 1 ? '' : 's'}`)
    downloadBtn.disabled = current === '/' // don't zip a whole disk by accident
  }

  downloadBtn.onclick = async () => {
    downloadBtn.disabled = true
    setMsg('Packaging ' + current + ' ...')
    try {
      await download(current, true, await diskList[activeIdx].get())
      setMsg('Done.')
    } catch (e) {
      setMsg('Error: ' + e.message)
    } finally {
      downloadBtn.disabled = current === '/'
    }
  }

  renderHead()

  return {
    dialog,
    open(path = '/') {
      dialog.showModal()
      navigate(path)
    },
    close: () => dialog.close(),
  }
}
