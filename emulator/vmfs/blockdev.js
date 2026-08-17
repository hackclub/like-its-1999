// read-only view of a base disk image with a v86 overlay (the guest's writes) painted
// over it, i.e. the disk as the guest saw it when the state was saved. base is any
// BaseSource: { readRange(offset, length) -> Promise<Uint8Array>, size? }. base reads
// are coalesced into the fewest contiguous ranges, so a remote base costs the minimum
// number of Range requests

export class OverlayBlockDevice {
  constructor(base, overlay, blockSize) {
    this.base = base
    this.overlay = overlay || null
    this.blockSize = blockSize || overlay?.blockSize || 256
    this.bytesFetched = 0
    this.rangeRequests = 0
  }

  get size() {
    return this.base.size ?? 0
  }

  async read(offset, length) {
    const out = new Uint8Array(length)
    const bs = this.blockSize
    const first = Math.floor(offset / bs)
    const last = Math.floor((offset + length - 1) / bs)

    // base reads are block-aligned so the copy math below stays simple
    let runStart = -1
    const runs = []
    for (let b = first; b <= last; b++) {
      const missing = !this.overlay || !this.overlay.hasBlock(b)
      if (missing && runStart === -1) runStart = b
      if (!missing && runStart !== -1) {
        runs.push([runStart, b - 1])
        runStart = -1
      }
    }
    if (runStart !== -1) runs.push([runStart, last])

    for (const [rs, re] of runs) {
      const rOff = rs * bs
      const rLen = (re - rs + 1) * bs
      const data = await this.#baseRead(rOff, rLen)
      const copyStart = Math.max(offset, rOff)
      const copyEnd = Math.min(offset + length, rOff + rLen)
      out.set(
        data.subarray(copyStart - rOff, copyEnd - rOff),
        copyStart - offset
      )
    }

    if (this.overlay) {
      for (let b = first; b <= last; b++) {
        const blk = this.overlay.block(b)
        if (!blk) continue
        const bOff = b * bs
        const copyStart = Math.max(offset, bOff)
        const copyEnd = Math.min(offset + length, bOff + bs)
        out.set(
          blk.subarray(copyStart - bOff, copyEnd - bOff),
          copyStart - offset
        )
      }
    }

    return out
  }

  async #baseRead(offset, length) {
    // the last block of a run can start past the end of the base
    let len = length
    if (this.base.size != null)
      len = Math.min(len, Math.max(0, this.base.size - offset))
    if (len <= 0) return new Uint8Array(length)
    const data = await this.base.readRange(offset, len)
    this.bytesFetched += data.length
    this.rangeRequests += 1
    if (len === length) return data
    // zero-pad past EOF so callers always get `length` bytes
    const padded = new Uint8Array(length)
    padded.set(data, 0)
    return padded
  }
}

// BaseSource over a local file (node)
export async function nodeFileSource(path) {
  const fs = await import('node:fs/promises')
  const handle = await fs.open(path, 'r')
  const { size } = await handle.stat()
  return {
    size,
    async readRange(offset, length) {
      const buf = Buffer.allocUnsafe(length)
      const { bytesRead } = await handle.read(buf, 0, length, offset)
      return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead)
    },
    async close() {
      await handle.close()
    },
  }
}

// BaseSource over an HTTP URL that supports Range requests; size comes from the first
// response's Content-Range if not passed in
export function httpRangeSource(url, knownSize) {
  let size = knownSize ?? null
  return {
    get size() {
      return size
    },
    async readRange(offset, length) {
      const end = offset + length - 1
      const res = await fetch(url, {
        headers: { Range: `bytes=${offset}-${end}` },
      })
      if (res.status !== 206 && res.status !== 200)
        throw new Error(`range fetch failed: HTTP ${res.status} for ${url}`)
      if (size == null) {
        const cr = res.headers.get('content-range')
        const m = cr && /\/(\d+)$/.exec(cr)
        if (m) size = parseInt(m[1], 10)
      }
      return new Uint8Array(await res.arrayBuffer())
    },
  }
}

// device over a running v86 emulator's disk buffer, e.g.
// emulator.v86.cpu.devices.ide.primary.master.buffer for C:. buffer.get() already
// merges the guest's writes over the base and reuses v86's chunk cache, so this needs
// no overlay and reflects unsaved changes. v86 requires 256-byte-aligned reads
export function v86Device(buffer, size = buffer.byteLength) {
  const ALIGN = 256
  return {
    size,
    read(offset, length) {
      const start = Math.floor(offset / ALIGN) * ALIGN
      const end = Math.min(size, Math.ceil((offset + length) / ALIGN) * ALIGN)
      return new Promise((resolve) => {
        buffer.get(start, end - start, (data) => {
          const from = offset - start
          resolve(data.subarray(from, from + length))
        })
      })
    },
  }
}

// BaseSource over an in-memory buffer
export function bufferSource(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  return {
    size: bytes.length,
    async readRange(offset, length) {
      return bytes.subarray(offset, offset + length)
    },
  }
}
