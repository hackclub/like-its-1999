// open the filesystem a v86 state describes, browse it, and export directories as
// zips, reading only the disk bytes needed. runs unchanged in node and the browser;
// the byte source (local file vs http range url) is injected

import { parseState, maybeGunzip } from './state.js'
import { detectFormat, readSaveFile } from '../savefile.js'
import { OverlayBlockDevice } from './blockdev.js'
import { FatFs } from './fat.js'
import { zipTree } from './zip.js'

// a saved machine is either a .99sv container or the raw/gzipped v86 state that every
// v1 save and published share link is
export async function unwrapState(bytes) {
  if (detectFormat(bytes) === 'container')
    return (await readSaveFile(bytes)).state()
  return maybeGunzip(bytes)
}

// mount a FAT filesystem from a state's disk overlay painted over a base image. with
// no overlayIndex, try each overlay and keep the one where the probe path resolves
// ('/WINDOWS' exists on the C: image)
export async function openStateFs(stateBytes, baseSource, opts = {}) {
  const raw = await unwrapState(stateBytes)
  const { overlays, blockSize } = parseState(raw)
  if (!overlays.length) throw new Error('state contains no disk overlays')

  const probe = opts.probe ?? '/WINDOWS'
  const candidates =
    opts.overlayIndex != null ? [opts.overlayIndex] : overlays.map((_, i) => i)

  let lastErr
  for (const idx of candidates) {
    const dev = new OverlayBlockDevice(baseSource, overlays[idx], blockSize)
    try {
      const fs = await FatFs.open(dev, opts.fat)
      if (opts.overlayIndex != null)
        return { fs, dev, overlayIndex: idx, overlays }
      await fs.resolve(probe)
      return { fs, dev, overlayIndex: idx, overlays }
    } catch (e) {
      lastErr = e
    }
  }
  throw new Error(
    `could not mount a FAT filesystem from any overlay (probe ${probe}): ${lastErr?.message}`
  )
}

export async function exportDirZip(fs, path, opts = {}) {
  const tree = await fs.walk(path)
  return zipTree(fs, tree, opts)
}

// node CLI: <state> is a .99sv container or a raw/gzipped v86 state, <base> is the
// base disk image (e.g. public/vm/hda.img) and only the ranges needed are read from it
//   ls    <state> <base> [path]              list a directory (default /)
//   tree  <state> <base> [path]              recursive listing
//   zip   <state> <base> <path> <out.zip>    export a directory as a zip
//   find  <state> <base> <name> [startPath]  find entries by case-insensitive name

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`

if (isMain) {
  const { nodeFileSource } = await import('./blockdev.js')
  const fsp = await import('node:fs/promises')

  const [cmd, statePath, basePath, ...rest] = process.argv.slice(2)
  const usage = `usage:
  node extract.js ls    <state> <base> [path]
  node extract.js tree  <state> <base> [path]
  node extract.js zip   <state> <base> <path> <out.zip>
  node extract.js find  <state> <base> <name> [startPath]`

  if (!cmd || !statePath || !basePath) {
    console.error(usage)
    process.exit(1)
  }

  const stateBytes = new Uint8Array(await fsp.readFile(statePath))
  const base = await nodeFileSource(basePath)
  const probe = process.env.VMFS_PROBE
  const overlayIndex =
    process.env.VMFS_OVERLAY != null
      ? Number(process.env.VMFS_OVERLAY)
      : undefined
  const {
    fs,
    dev,
    overlayIndex: used,
  } = await openStateFs(stateBytes, base, {
    probe,
    overlayIndex,
  })
  console.error(
    `mounted overlay #${used} · FAT${fs.fatType} · part@${fs.partOffset}`
  )

  const fmtSize = (n) => String(n).padStart(9)
  const report = () =>
    console.error(
      `read ${(dev.bytesFetched / 1024).toFixed(0)} KiB from base in ${dev.rangeRequests} range(s)`
    )

  if (cmd === 'ls') {
    const path = rest[0] || '/'
    const entries = await fs.readdir(path)
    for (const e of entries)
      console.log(
        `${e.isDir ? 'd' : '-'} ${fmtSize(e.size)}  ${e.mtime || ''}  ${e.name}`
      )
    report()
  } else if (cmd === 'tree') {
    const path = rest[0] || '/'
    const tree = await fs.walk(path)
    const print = (n, depth) => {
      console.log('  '.repeat(depth) + (n.name === '/' ? '/' : n.name + '/'))
      for (const f of n.files)
        console.log('  '.repeat(depth + 1) + f.name + '  (' + f.size + ')')
      for (const d of n.dirs) print(d, depth + 1)
    }
    print(tree, 0)
    report()
  } else if (cmd === 'zip') {
    const [path, out] = rest
    if (!path || !out) {
      console.error(usage)
      process.exit(1)
    }
    const bytes = await exportDirZip(fs, path)
    await fsp.writeFile(out, bytes)
    console.log(`wrote ${out} (${(bytes.length / 1024).toFixed(1)} KiB)`)
    report()
  } else if (cmd === 'find') {
    const [name, start] = rest
    if (!name) {
      console.error(usage)
      process.exit(1)
    }
    const want = name.toLowerCase()
    const tree = await fs.walk(start || '/')
    const hits = []
    const scan = (n) => {
      if ((n.name || '').toLowerCase() === want) hits.push(n.path)
      for (const f of n.files)
        if (f.name.toLowerCase() === want) hits.push(f.path)
      for (const d of n.dirs) scan(d)
    }
    scan(tree)
    for (const h of hits) console.log(h)
    if (!hits.length) console.log('(no matches)')
    report()
  } else {
    console.error(usage)
    process.exit(1)
  }

  await base.close?.()
}
