// parse a v86 `save_state` snapshot and expose its disk overlays
//
// state format (v86 v6):
//   header: 4 little-endian int32s [magic, version, total_len, json_len], with
//     magic 0x86768676 and version 6
//   json at [16, 16+json_len): { buffer_infos, state }
//     buffer_infos[i] = { offset, length } into the data section
//     state = the machine state tree; typed arrays serialise as
//       { __state_type__, buffer_id } and disk overlays as arrays of
//       [blockIndex, { buffer_id }] pairs
//   data section starts at (16 + json_len) rounded up to 4 bytes; a buffer's bytes
//     are data[offset .. offset+length]
//
// a disk overlay is v86's in-memory copy-on-write layer: only the blocks the guest
// actually wrote are present, each pair mapping a block index to a buffer holding
// that block's BLOCK_SIZE bytes at blockIndex*BLOCK_SIZE on the disk

export const STATE_MAGIC = 0x86768676
export const STATE_VERSION = 6
export const BLOCK_SIZE = 256

const td = new TextDecoder()

function u32(view, off) {
  return view.getUint32(off, true)
}

// a serialised overlay is a non-empty array whose every element is
// [int, { buffer_id }]
function isBlockPair(e) {
  return (
    Array.isArray(e) &&
    e.length === 2 &&
    Number.isInteger(e[0]) &&
    e[1] &&
    typeof e[1] === 'object' &&
    'buffer_id' in e[1]
  )
}
function isOverlay(node) {
  return Array.isArray(node) && node.length > 0 && node.every(isBlockPair)
}

// document order matters: it is the order v86 registered the disks in
function findOverlays(state) {
  const out = []
  const visit = (node) => {
    if (Array.isArray(node)) {
      if (isOverlay(node)) {
        out.push(node)
        return
      }
      for (const e of node) visit(e)
    } else if (node && typeof node === 'object') {
      for (const v of Object.values(node)) visit(v)
    }
  }
  visit(state)
  return out
}

// one disk's overlay: Map<blockIndex, Uint8Array(blockSize)> plus the byte span it
// touches
export class DiskOverlay {
  constructor(blocks, blockSize) {
    this.blocks = blocks
    this.blockSize = blockSize
    let maxIdx = -1
    for (const idx of blocks.keys()) if (idx > maxIdx) maxIdx = idx
    this.maxBlock = maxIdx
    this.maxByte = (maxIdx + 1) * blockSize
  }
  get blockCount() {
    return this.blocks.size
  }
  hasBlock(blockIndex) {
    return this.blocks.has(blockIndex)
  }
  block(blockIndex) {
    return this.blocks.get(blockIndex) || null
  }
}

// input must already be decompressed (see maybeGunzip)
export function parseState(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  const magic = u32(view, 0)
  const version = u32(view, 4)
  if (magic !== STATE_MAGIC)
    throw new Error(
      `not a v86 state: magic 0x${magic.toString(16)} !== 0x${STATE_MAGIC.toString(16)}`
    )
  if (version !== STATE_VERSION)
    throw new Error(
      `unexpected v86 state version ${version} (want ${STATE_VERSION})`
    )

  const jsonLen = u32(view, 12)
  const json = JSON.parse(td.decode(bytes.subarray(16, 16 + jsonLen)))
  const dataStart = (16 + jsonLen + 3) & ~3
  const infos = json.buffer_infos

  const bufferBytes = (id) => {
    const info = infos[id]
    const start = dataStart + info.offset
    return bytes.subarray(start, start + info.length)
  }

  // all block buffers share one size, so take it from the overlays themselves and
  // fall back to the documented 256
  const overlayArrays = findOverlays(json.state)
  let blockSize = 0
  for (const arr of overlayArrays)
    for (const [, ref] of arr)
      blockSize = Math.max(blockSize, infos[ref.buffer_id].length)
  if (!blockSize) blockSize = BLOCK_SIZE

  const overlays = overlayArrays.map((arr) => {
    const blocks = new Map()
    for (const [idx, ref] of arr) blocks.set(idx, bufferBytes(ref.buffer_id))
    return new DiskOverlay(blocks, blockSize)
  })

  return { json, overlays, blockSize }
}

// input without the 0x1f 0x8b gzip magic is returned unchanged
export async function maybeGunzip(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes
  if (typeof DecompressionStream !== 'undefined') {
    const ds = new DecompressionStream('gzip')
    const stream = new Response(bytes).body.pipeThrough(ds)
    return new Uint8Array(await new Response(stream).arrayBuffer())
  }
  const { gunzipSync } = await import('node:zlib')
  return new Uint8Array(gunzipSync(bytes))
}
