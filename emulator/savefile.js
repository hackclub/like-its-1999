// The `.99sv` save container: a v86 state plus everything else a saved machine needs
// to carry (which world it belongs to, time-tracking data, a thumbnail, provenance).
//
// Why a container at all: a v86 state only restores against the exact disk bytes and
// machine config it was captured with, and a bare state records neither. Rebuild the
// image and every old save/share silently restores into the wrong world. The container
// pins each save to its world and leaves room for the rest.
//
// Layout — fixed header, UNCOMPRESSED metadata, then independently-encoded chunks:
//
//   0   "99SV"                       magic
//   4   u32  version                 what wrote this
//   8   u32  minReader               oldest reader that can still make sense of it
//   12  u32  metaLen
//   16  u32  reserved (0)
//   20  u32  reserved (0)
//   24  u64  totalLength             the whole file, so truncation is detectable
//   32  metadata JSON (utf8, metaLen bytes)
//       payloadStart = align4(32 + metaLen)
//       chunk i at payloadStart + entry.offset, entry.length bytes
//
// `version` vs `minReader` is the compatibility hinge. A purely additive change (new
// metadata keys, new chunks) bumps `version` and leaves `minReader` alone, so older
// builds keep reading the file. Only a change that genuinely breaks old readers raises
// `minReader`, and then they refuse it loudly instead of guessing. Without that split,
// any future bump would lock every existing build out of every new file.
//
// `totalLength` exists because a truncated upload otherwise parses as a perfectly valid
// container: header, metadata and the small chunks all check out, and only the state
// chunk fails much later. Participants upload these over flaky connections.
//
// Metadata is deliberately outside the compression so it can be read from a single
// small HTTP Range request — a share page or a review CLI can see the world, the
// tracked hours and the thumbnail without pulling ~65 MB of RAM image.
//
// Extensibility rules, which callers MUST honour:
//   - every metadata key except `chunks` is optional, and unknown keys are ignored
//   - unknown chunks are preserved verbatim on rewrite (see storedChunk + pack's
//     `stored` input), so an older build never strips data a newer one wrote
// Only a breaking layout change bumps the container version.
//
// This module is world-agnostic on purpose: it never resolves URLs or decides what a
// world id means (see worlds.js). A legacy artifact (bare gzipped or raw v86 state,
// which is every v1 save and every `?share=` link published so far) reads back with no
// `world` at all, and the caller maps "no world" to the legacy world.

import { STATE_MAGIC, maybeGunzip } from './vmfs/state.js'

export const CONTAINER_VERSION = 1
// Raise only when a change genuinely breaks older readers (see the header notes).
const MIN_READER_VERSION = 1
export const MAGIC = Uint8Array.of(0x39, 0x39, 0x53, 0x56) // "99SV"
export const HEADER_SIZE = 32
export const EXTENSION = '.99sv'

// Metadata is read from a small Range request, so a corrupt or hostile metaLen must not
// be able to turn that into a full download of the whole file.
export const MAX_META_BYTES = 1024 * 1024

const te = new TextEncoder()
const td = new TextDecoder()

const toU8 = (input) =>
  input instanceof Uint8Array
    ? input
    : new Uint8Array(
        input.buffer ?? input,
        input.byteOffset ?? 0,
        input.byteLength
      )

// Plain arithmetic, not bitwise: `&` coerces to int32, so a large offset would come back
// negative and a negative payloadStart feeding subarray() reads the wrong bytes.
const align4 = (n) => n + ((4 - (n % 4)) % 4)

const isSize = (n) => Number.isSafeInteger(n) && n >= 0

// --- isomorphic primitives ------------------------------------------------------

async function gzip(bytes) {
  if (typeof CompressionStream !== 'undefined') {
    const stream = new Response(bytes).body.pipeThrough(
      new CompressionStream('gzip')
    )
    return new Uint8Array(await new Response(stream).arrayBuffer())
  }
  const { gzipSync } = await import('node:zlib')
  return new Uint8Array(gzipSync(bytes))
}

async function gunzip(bytes) {
  if (typeof DecompressionStream !== 'undefined') {
    const stream = new Response(bytes).body.pipeThrough(
      new DecompressionStream('gzip')
    )
    return new Uint8Array(await new Response(stream).arrayBuffer())
  }
  const { gunzipSync } = await import('node:zlib')
  return new Uint8Array(gunzipSync(bytes))
}

export async function sha256hex(bytes) {
  const subtle = globalThis.crypto?.subtle
  if (subtle) {
    const digest = await subtle.digest('SHA-256', bytes)
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(bytes).digest('hex')
}

function randomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// --- detection ------------------------------------------------------------------

// 'container' | 'legacy' | 'unknown'. "Legacy" is a bare v86 state, gzipped or not —
// what every v1 save and every published share link is. Nothing downstream ever needs
// to tell those two apart (maybeGunzip handles both), so they're one case.
export function detectFormat(input) {
  const bytes = toU8(input)
  if (bytes.length >= HEADER_SIZE && MAGIC.every((b, i) => bytes[i] === b))
    return 'container'
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b)
    return 'legacy'
  if (
    bytes.length >= 16 &&
    new DataView(bytes.buffer, bytes.byteOffset, 16).getUint32(0, true) >>>
      0 ===
      STATE_MAGIC
  )
    return 'legacy'
  return 'unknown'
}

// --- reading --------------------------------------------------------------------

// Parse just the header + metadata. Accepts a truncated buffer (a Range-request
// prefix) as long as it covers the metadata; throws if it doesn't, so a caller can
// widen the range and retry.
export function readContainerMeta(input) {
  const bytes = toU8(input)
  if (detectFormat(bytes) !== 'container')
    throw new Error('not a 99SV container')

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint32(4, true)
  const minReader = view.getUint32(8, true)
  // A newer *additive* version stays readable; only minReader locks us out.
  if (minReader > CONTAINER_VERSION)
    throw new UnsupportedSaveError(
      `this save needs a newer version of the page (needs reader ` +
        `${minReader}, this build is ${CONTAINER_VERSION})`
    )

  const metaLen = view.getUint32(12, true)
  if (metaLen > MAX_META_BYTES)
    throw new Error(
      `container metadata is implausibly large (${metaLen} bytes)`
    )
  const totalLength = Number(view.getBigUint64(24, true))

  const metaEnd = HEADER_SIZE + metaLen
  if (bytes.length < metaEnd)
    throw new Error(
      `truncated: need ${metaEnd} bytes for metadata, have ${bytes.length}`
    )

  let meta
  try {
    meta = JSON.parse(td.decode(bytes.subarray(HEADER_SIZE, metaEnd)))
  } catch (e) {
    throw new Error(`container metadata is not valid JSON: ${e.message}`)
  }
  const chunks = Array.isArray(meta.chunks) ? meta.chunks : []
  const payloadStart = align4(metaEnd)
  validateChunkTable(chunks, payloadStart, totalLength)

  return { version, minReader, meta, chunks, payloadStart, totalLength }
}

// The chunk table steers every later read, so treat it as hostile input. We don't try to
// make a malicious file harmless to open (a giant chunk can still exhaust memory, which
// is acceptable) — the goal is that a bad table can never make us read the WRONG bytes
// and present them as a valid machine or as tracking evidence.
function validateChunkTable(chunks, payloadStart, totalLength) {
  const seen = new Set()
  for (const c of chunks) {
    if (!c || typeof c.id !== 'string' || !c.id)
      throw new Error('chunk table has an entry with no id')
    if (seen.has(c.id)) throw new Error(`duplicate chunk id "${c.id}"`)
    seen.add(c.id)
    // Negative or non-integer offsets are the dangerous case: subarray() treats a
    // negative index as "from the end" and NaN as 0, both of which silently succeed.
    if (!isSize(c.offset) || !isSize(c.length))
      throw new Error(
        `chunk "${c.id}" has a bad offset/length (${c.offset}/${c.length})`
      )
    if (c.size != null && !isSize(c.size))
      throw new Error(`chunk "${c.id}" has a bad size (${c.size})`)
    if (totalLength && payloadStart + c.offset + c.length > totalLength)
      throw new Error(`chunk "${c.id}" runs past the end of the file`)
  }
}

// A save this build genuinely cannot read, as opposed to one that's damaged. Callers use
// it to leave the stored copy alone instead of overwriting something they can't parse.
export class UnsupportedSaveError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UnsupportedSaveError'
  }
}

// Open a save file of any accepted shape. Chunk bodies are decoded lazily, so reading
// metadata off a full buffer costs nothing.
export async function readSaveFile(input) {
  const bytes = toU8(input)
  const format = detectFormat(bytes)

  if (format === 'legacy') {
    // No world recorded: the caller maps this to the legacy world.
    const meta = { legacy: true, chunks: [] }
    let cached = null
    return {
      format,
      legacy: true,
      meta,
      chunks: [],
      chunkIds: ['state'],
      hasChunk: (id) => id === 'state',
      chunkEntry: () => null,
      storedChunk: (id) => (id === 'state' ? bytes : null),
      chunk: async (id) => {
        if (id !== 'state') return null
        if (!cached) cached = await maybeGunzip(bytes)
        return cached
      },
      state: async () => {
        if (!cached) cached = await maybeGunzip(bytes)
        return cached
      },
    }
  }

  if (format !== 'container')
    throw new Error('not a valid save file (no 99SV, gzip or v86 state header)')

  const { version, minReader, meta, chunks, payloadStart, totalLength } =
    readContainerMeta(bytes)
  if (totalLength && bytes.length < totalLength)
    throw new Error(
      `truncated file: header says ${totalLength} bytes, have ${bytes.length}`
    )
  const byId = new Map(chunks.map((c) => [c.id, c]))

  const storedChunk = (id) => {
    const entry = byId.get(id)
    if (!entry) return null
    const start = payloadStart + entry.offset
    const end = start + entry.length
    if (end > bytes.length)
      throw new Error(`chunk "${id}" runs past the end of the file`)
    return bytes.subarray(start, end)
  }

  const decoded = new Map()
  const chunk = async (id) => {
    if (decoded.has(id)) return decoded.get(id)
    const entry = byId.get(id)
    const stored = storedChunk(id)
    if (!stored) return null
    const codec = entry.codec || 'raw'
    let out
    if (codec === 'raw') out = stored
    else if (codec === 'gzip') out = await gunzip(stored)
    else throw new Error(`chunk "${id}" uses unknown codec "${codec}"`)
    // The recorded size is worth checking precisely because it's cheap: it catches a
    // chunk that decompressed to something other than what was written.
    if (entry.size != null && out.length !== entry.size)
      throw new Error(
        `chunk "${id}" decoded to ${out.length} bytes, expected ${entry.size}`
      )
    decoded.set(id, out)
    return out
  }

  return {
    format,
    legacy: false,
    version,
    minReader,
    meta,
    chunks,
    chunkIds: chunks.map((c) => c.id),
    hasChunk: (id) => byId.has(id),
    chunkEntry: (id) => byId.get(id) || null,
    storedChunk,
    chunk,
    state: async () => {
      const raw = await chunk('state')
      if (!raw) throw new Error('container has no "state" chunk')
      return raw
    },
    // JSON / NDJSON convenience for the tracking chunks.
    json: async (id) => {
      const raw = await chunk(id)
      return raw ? JSON.parse(td.decode(raw)) : null
    },
    ndjson: async (id) => {
      const raw = await chunk(id)
      if (!raw) return []
      return td
        .decode(raw)
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line))
    },
  }
}

// --- writing --------------------------------------------------------------------

// chunks[] entries are either
//   { id, bytes, codec = 'gzip', extra, hash }   encode these bytes now, or
//   { id, stored, entry }                        copy already-encoded bytes verbatim
// The second form is how unknown chunks survive a rewrite: read them with
// storedChunk(id) + chunkEntry(id) and hand them straight back.
//
// `hash: true` records a sha256 of the uncompressed bytes. It's off by default because
// the state chunk is ~65 MB and gets rewritten on every autosave; ask for it on the
// small chunks whose integrity someone may need to argue about later.
export async function packSaveFile({ meta = {}, chunks = [] }) {
  const table = []
  const bodies = []
  const seen = new Set()
  let offset = 0

  for (const c of chunks) {
    if (!c || typeof c.id !== 'string' || !c.id)
      throw new Error('every chunk needs a string id')
    if (seen.has(c.id)) throw new Error(`duplicate chunk id "${c.id}"`)
    seen.add(c.id)
    let stored
    let entry
    if (c.stored) {
      stored = toU8(c.stored)
      entry = { ...(c.entry || {}), id: c.id }
    } else {
      const bytes = toU8(c.bytes)
      const codec = c.codec || 'gzip'
      if (codec !== 'gzip' && codec !== 'raw')
        throw new Error(`chunk "${c.id}": unknown codec "${codec}"`)
      stored = codec === 'gzip' ? await gzip(bytes) : bytes
      entry = {
        ...(c.extra || {}),
        id: c.id,
        codec,
        size: bytes.length,
      }
      if (c.hash) entry.sha256 = await sha256hex(bytes)
    }
    entry.offset = offset
    entry.length = stored.length
    table.push(entry)
    bodies.push(stored)
    offset += stored.length
  }

  // Spread first, then fill gaps: defaults written before the spread would be silently
  // undone by an explicit `id: null` or `createdAt: undefined`, which is how a file
  // loses its identity (and its provenance chain) on a later save.
  const metaObject = { ...meta, chunks: table }
  if (!metaObject.id) metaObject.id = randomId()
  if (!Number.isFinite(metaObject.createdAt)) metaObject.createdAt = Date.now()
  const metaJson = te.encode(JSON.stringify(metaObject))
  if (metaJson.length > MAX_META_BYTES)
    throw new Error(
      `metadata is too large (${metaJson.length} > ${MAX_META_BYTES} bytes)`
    )
  const payloadStart = align4(HEADER_SIZE + metaJson.length)
  const out = new Uint8Array(payloadStart + offset)
  const view = new DataView(out.buffer)

  out.set(MAGIC, 0)
  view.setUint32(4, CONTAINER_VERSION, true)
  view.setUint32(8, MIN_READER_VERSION, true)
  view.setUint32(12, metaJson.length, true)
  view.setBigUint64(24, BigInt(out.length), true)
  out.set(metaJson, HEADER_SIZE)
  let at = payloadStart
  for (const body of bodies) {
    out.set(body, at)
    at += body.length
  }
  return out
}

// Read only the metadata of a remote save file. Streams and cancels rather than
// trusting Range support: hosts sometimes answer a ranged request with the whole
// object (see the R2/Cloudflare note in tmp-image-build/README.md), and we must not
// download 65 MB to read a header.
export async function probeSaveFileMeta(url, opts = {}) {
  const doFetch = opts.fetch || globalThis.fetch
  const want = opts.initialBytes ?? 64 * 1024

  const readPrefix = async (upto) => {
    const resp = await doFetch(url, {
      headers: { Range: `bytes=0-${upto - 1}` },
    })
    if (!resp.ok) throw new Error(`fetch failed (${resp.status})`)
    if (!resp.body) return toU8(await resp.arrayBuffer()).subarray(0, upto)
    const reader = resp.body.getReader()
    const parts = []
    let total = 0
    while (total < upto) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
      total += value.length
    }
    await reader.cancel().catch(() => {})
    const buf = new Uint8Array(total)
    let at = 0
    for (const p of parts) {
      buf.set(p, at)
      at += p.length
    }
    return buf.subarray(0, Math.min(total, upto))
  }

  let prefix = await readPrefix(want)
  if (detectFormat(prefix) !== 'container') return null // legacy artifact
  const metaLen = new DataView(
    prefix.buffer,
    prefix.byteOffset,
    prefix.byteLength
  ).getUint32(12, true)
  // Bounded before it's used as a fetch length: this whole function exists to avoid
  // pulling tens of megabytes, so four corrupt bytes must not undo that.
  if (metaLen > MAX_META_BYTES)
    throw new Error(
      `container metadata is implausibly large (${metaLen} bytes)`
    )
  if (HEADER_SIZE + metaLen > prefix.length)
    prefix = await readPrefix(align4(HEADER_SIZE + metaLen))
  return readContainerMeta(prefix)
}

// ---------------------------------------------------------------------------------
// Node CLI:  node savefile.js <command> [args]
//
//   info    <file|url>                 header, world, chunk table, tracking summary
//   extract <file> <chunkId> <out>     write one decoded chunk
//   state   <file> <out>               shorthand for `extract <file> state <out>`
//
// <file> may be a .99sv container or a legacy raw/gzipped v86 state, so this works on
// submissions from either era. `info` also takes an http(s) URL, which reads only the
// metadata over Range — the point being you can review a submitted machine's world and
// tracked hours without pulling tens of megabytes.
// ---------------------------------------------------------------------------------

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`

if (isMain) {
  const fsp = await import('node:fs/promises')
  const [cmd, file, ...rest] = process.argv.slice(2)
  const usage = `usage:
  node savefile.js info    <file|url>
  node savefile.js extract <file> <chunkId> <out>
  node savefile.js state   <file> <out>`

  if (!cmd || !file) {
    console.error(usage)
    process.exit(1)
  }

  if (cmd === 'info' && /^https?:\/\//.test(file)) {
    const probed = await probeSaveFileMeta(file)
    if (!probed) {
      console.log('format:     legacy v1 artifact (no container metadata)')
      process.exit(0)
    }
    console.log(`format:     container v${probed.version}`)
    console.log(`total size: ${(probed.totalLength / 1024).toFixed(0)} KiB`)
    console.log(`world:      ${probed.meta.world?.id ?? '(none)'}`)
    console.log(
      `chunks:     ${probed.chunks.map((c) => `${c.id} (${c.length}B)`).join(', ')}`
    )
    if (probed.meta.tracking)
      console.log(
        `tracking:   ${probed.meta.tracking.totalActiveMs ?? 0} ms active`
      )
    process.exit(0)
  }

  const bytes = new Uint8Array(await fsp.readFile(file))
  const save = await readSaveFile(bytes)

  if (cmd === 'info') {
    const kb = (n) => `${(n / 1024).toFixed(0)} KiB`
    console.log(
      `format:     ${save.format}${save.legacy ? ' (legacy v1)' : ''}`
    )
    console.log(`file size:  ${kb(bytes.length)}`)
    if (save.legacy) {
      const raw = await save.state()
      console.log(`state:      ${kb(raw.length)} decompressed`)
      console.log('world:      (none recorded — treated as the legacy world)')
    } else {
      const m = save.meta
      console.log(`id:         ${m.id ?? '(none)'}`)
      console.log(
        `created:    ${m.createdAt ? new Date(m.createdAt).toISOString() : '(none)'}`
      )
      const w = m.world
      console.log(
        `world:      ${typeof w === 'string' ? w : (w?.id ?? '(none)')}`
      )
      if (w && typeof w === 'object') {
        if (w.memory) console.log(`  memory:   ${w.memory / 1048576} MiB`)
        if (w.vgaMemory) console.log(`  vga:      ${w.vgaMemory / 1048576} MiB`)
        if (w.uart1 != null) console.log(`  uart1:    ${w.uart1}`)
        for (const [k, d] of Object.entries(w.disks || {}))
          console.log(`  ${k}:      ${d.url} (${d.size} bytes)`)
      }
      if (m.tracking)
        console.log(
          `tracking:   ${m.tracking.totalActiveMs ?? 0} ms active · ` +
            `${m.tracking.sessions ?? 0} session(s) · ` +
            `${m.tracking.attestations?.length ?? 0} attestation(s)`
        )
      if (m.provenance?.length)
        console.log(`provenance: ${m.provenance.length} entr(ies)`)
      console.log('chunks:')
      for (const c of save.chunks)
        console.log(
          `  ${c.id.padEnd(12)} ${String(c.length).padStart(10)} stored  ` +
            `${String(c.size ?? '?').padStart(10)} raw  ${c.codec || 'raw'}`
        )
    }
  } else if (cmd === 'extract' || cmd === 'state') {
    const id = cmd === 'state' ? 'state' : rest[0]
    const out = cmd === 'state' ? rest[0] : rest[1]
    if (!id || !out) {
      console.error(usage)
      process.exit(1)
    }
    const data = await save.chunk(id)
    if (!data) {
      console.error(`no chunk "${id}" (have: ${save.chunkIds.join(', ')})`)
      process.exit(1)
    }
    await fsp.writeFile(out, data)
    console.error(`wrote ${out} (${data.length} bytes)`)
  } else {
    console.error(usage)
    process.exit(1)
  }
}
