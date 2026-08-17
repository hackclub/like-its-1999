// bake a v86 state's disk overlays into base image files, so guest writes that exist
// only in a save_state live on disk. clones each base, paints the matching overlay's
// blocks in, and checks the result still mounts as FAT
//
// v86 serialises overlays in the order the disks are registered (hda then hdb), so
// overlay[i] pairs with base[i] by default; a base that fails the mount check after
// flattening usually means the wrong pairing

import { parseState, maybeGunzip } from './state.js'
import { nodeFileSource } from './blockdev.js'
import { OverlayBlockDevice } from './blockdev.js'
import { FatFs } from './fat.js'

// paints an overlay's blocks onto an already-cloned output image (node)
export async function applyOverlayToFile(outPath, overlay) {
  const fs = await import('node:fs/promises')
  const handle = await fs.open(outPath, 'r+')
  try {
    const bs = overlay.blockSize
    // sort by index so the writes go out sequentially
    const idxs = [...overlay.blocks.keys()].sort((a, b) => a - b)
    for (const idx of idxs) {
      const bytes = overlay.block(idx)
      await handle.write(bytes, 0, bytes.length, idx * bs)
    }
    return idxs.length
  } finally {
    await handle.close()
  }
}

async function mountsOk(outPath) {
  try {
    const base = await nodeFileSource(outPath)
    try {
      const fs = await FatFs.open(new OverlayBlockDevice(base, null))
      const entries = await fs.readdir('/')
      return entries.length > 0
    } finally {
      await base.close?.()
    }
  } catch {
    return false
  }
}

export async function flattenOne(
  basePath,
  outPath,
  overlay,
  { verify = true } = {}
) {
  const fs = await import('node:fs/promises')
  await fs.copyFile(basePath, outPath)
  const written = await applyOverlayToFile(outPath, overlay)
  const ok = verify ? await mountsOk(outPath) : null
  return {
    written,
    blocks: overlay.blockCount,
    bytes: overlay.maxByte,
    mountsOk: ok,
  }
}

// node CLI: node flatten.js <state> <base> <out> [<base2> <out2> ...]
// VMFS_OVERLAY_MAP="0,1" overrides the overlay used per base, in base order

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`

if (isMain) {
  const fsp = await import('node:fs/promises')
  const args = process.argv.slice(2)
  const force = args.includes('--force')
  const positional = args.filter((a) => a !== '--force')
  const [statePath, ...pairs] = positional

  if (!statePath || pairs.length < 2 || pairs.length % 2 !== 0) {
    console.error(`usage: node flatten.js <state> <base> <out> [<base2> <out2> ...]
  pairs bases with overlays in order; override with VMFS_OVERLAY_MAP="0,1"
  --force  write even if a flattened image fails the FAT mount check`)
    process.exit(1)
  }

  const stateBytes = new Uint8Array(await fsp.readFile(statePath))
  const { overlays, blockSize } = parseState(await maybeGunzip(stateBytes))
  console.error(
    `state has ${overlays.length} overlay(s), block size ${blockSize}:`
  )
  overlays.forEach((o, i) =>
    console.error(
      `  #${i}: ${o.blockCount} blocks, touches up to ${(o.maxByte / 1e6).toFixed(1)} MB`
    )
  )

  const map = process.env.VMFS_OVERLAY_MAP
    ? process.env.VMFS_OVERLAY_MAP.split(',').map(Number)
    : null

  const bases = []
  for (let i = 0; i < pairs.length; i += 2)
    bases.push({ base: pairs[i], out: pairs[i + 1] })

  let failed = false
  for (let i = 0; i < bases.length; i++) {
    const overlayIdx = map ? map[i] : i
    const overlay = overlays[overlayIdx]
    if (!overlay) {
      console.error(`no overlay #${overlayIdx} for base ${bases[i].base}`)
      process.exit(1)
    }
    const { base, out } = bases[i]
    const r = await flattenOne(base, out, overlay)
    const status = r.mountsOk === false ? 'FAILED FAT mount' : 'ok'
    console.log(
      `${base} + overlay#${overlayIdx} -> ${out}: wrote ${r.written} blocks [${status}]`
    )
    if (r.mountsOk === false && !force) failed = true
  }

  if (failed) {
    console.error(
      '\none or more images failed to mount — check the overlay↔base pairing ' +
        '(VMFS_OVERLAY_MAP) or pass --force to keep the output anyway.'
    )
    process.exit(2)
  }
}
