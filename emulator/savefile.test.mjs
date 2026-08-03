// node --test emulator/savefile.test.mjs
//
// Covers the two things that must never regress: a legacy v1 artifact (every published
// ?share= link) still reads, and a save file can't talk the emulator into mounting
// disks from somewhere we didn't put them.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'

import {
  packSaveFile,
  readSaveFile,
  readContainerMeta,
  probeSaveFileMeta,
  detectFormat,
  HEADER_SIZE,
  MAGIC,
} from './savefile.js'
import {
  WORLDS,
  LEGACY_WORLD_ID,
  CDN_HOST,
  resolveWorld,
  validateWorld,
  worldDescriptor,
  worldToV86Config,
  currentWorld,
  readModeParams,
  isDevWorldId,
  isValidWorldId,
  verifyDiskSizes,
} from './worlds.js'

const te = new TextEncoder()
const ORIGIN = 'http://localhost:5173'
const prod = { origin: ORIGIN, dev: false }
const dev = { origin: ORIGIN, dev: true }

// A minimal but structurally real v86 state: 4×i32 header then the JSON blob.
function fakeState(extra = 0) {
  const json = te.encode(JSON.stringify({ buffer_infos: [], state: [] }))
  const total = 16 + json.length + extra
  const buf = new Uint8Array(total)
  const view = new DataView(buf.buffer)
  view.setUint32(0, 0x86768676, true)
  view.setUint32(4, 6, true)
  view.setUint32(8, total, true)
  view.setUint32(12, json.length, true)
  buf.set(json, 16)
  return buf
}

const HEARTBEATS = te.encode(
  '{"t":1,"win":"index.html - EditPlus","keys":12}\n{"t":2,"win":"Paint Shop Pro","keys":3}\n'
)

// --- container round trip --------------------------------------------------------

test('packs and reads back a container', async () => {
  const state = fakeState(64 * 1024) // padded so gzip has something to chew on
  const thumb = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 1, 2, 3)
  const bytes = await packSaveFile({
    meta: {
      world: WORLDS.get(LEGACY_WORLD_ID),
      tracking: { totalActiveMs: 4200, sessions: 2 },
    },
    chunks: [
      { id: 'state', bytes: state },
      {
        id: 'heartbeats',
        bytes: HEARTBEATS,
        hash: true,
        extra: { format: 'ndjson' },
      },
      { id: 'thumb', bytes: thumb, codec: 'raw', extra: { mime: 'image/png' } },
    ],
  })

  assert.equal(detectFormat(bytes), 'container')
  const save = await readSaveFile(bytes)
  assert.equal(save.legacy, false)
  assert.deepEqual(await save.state(), state)
  assert.deepEqual(await save.chunk('thumb'), thumb)
  assert.equal(save.meta.tracking.totalActiveMs, 4200)
  assert.equal(save.meta.world.id, LEGACY_WORLD_ID)
  assert.ok(save.meta.id, 'file gets a generated id')
  assert.ok(save.meta.createdAt > 0)

  const samples = await save.ndjson('heartbeats')
  assert.equal(samples.length, 2)
  assert.equal(samples[0].win, 'index.html - EditPlus')

  const entry = save.chunkEntry('state')
  assert.equal(entry.size, state.length)
  assert.equal(entry.codec, 'gzip')
  assert.ok(entry.length < entry.size, 'a compressible state gets smaller')
  assert.equal(entry.sha256, undefined, 'hashing the 65 MB state is opt-in')
  assert.match(save.chunkEntry('heartbeats').sha256, /^[0-9a-f]{64}$/)
})

test('metadata is readable from a header-only prefix', async () => {
  const bytes = await packSaveFile({
    meta: { world: WORLDS.get(LEGACY_WORLD_ID) },
    chunks: [{ id: 'state', bytes: fakeState() }],
  })
  const metaLen = new DataView(bytes.buffer).getUint32(12, true)
  const prefix = bytes.subarray(0, HEADER_SIZE + metaLen)
  const { meta, payloadStart } = readContainerMeta(prefix)
  assert.equal(meta.world.id, LEGACY_WORLD_ID)
  assert.ok(payloadStart >= HEADER_SIZE + metaLen)

  assert.throws(
    () => readContainerMeta(bytes.subarray(0, HEADER_SIZE + 4)),
    /truncated/
  )
})

test('unknown chunks and unknown metadata keys survive a rewrite', async () => {
  const future = te.encode('some future section')
  const first = await packSaveFile({
    meta: {
      world: WORLDS.get(LEGACY_WORLD_ID),
      somethingNew: { added: 'by a later build' },
      ext: { note: 'keep me' },
    },
    chunks: [
      { id: 'state', bytes: fakeState() },
      { id: 'future-thing', bytes: future },
    ],
  })

  // Rewrite the way persist.js does: re-encode what we understand, pass the rest
  // through verbatim.
  const old = await readSaveFile(first)
  const carried = old.chunks
    .filter((c) => c.id !== 'state')
    .map((c) => ({ id: c.id, stored: old.storedChunk(c.id), entry: c }))
  const second = await packSaveFile({
    meta: { ...old.meta, chunks: undefined },
    chunks: [{ id: 'state', bytes: fakeState(4) }, ...carried],
  })

  const save = await readSaveFile(second)
  assert.deepEqual(await save.chunk('future-thing'), future)
  assert.equal(save.meta.somethingNew.added, 'by a later build')
  assert.equal(save.meta.ext.note, 'keep me')
  assert.equal(save.meta.id, old.meta.id, 'the file keeps its identity')
})

test('repeated saves keep chunks the caller no longer supplies', async () => {
  // The regression this guards: treat the boot-time save as `prior` forever and the
  // second write mints a new file id and silently drops the thumbnail (and, later, the
  // heartbeat log). `prior` must advance to the file just written.
  const thumb = te.encode('pretend png')
  const first = await packSaveFile({
    meta: { world: WORLDS.get(LEGACY_WORLD_ID) },
    chunks: [
      { id: 'state', bytes: fakeState() },
      { id: 'thumb', bytes: thumb, codec: 'raw' },
    ],
  })

  // Emulate three successive saves that supply no thumbnail, each one advancing prior.
  let prior = await readSaveFile(first)
  for (let i = 0; i < 3; i++) {
    const carried = prior.chunks
      .filter((c) => c.id !== 'state')
      .map((c) => ({ id: c.id, stored: prior.storedChunk(c.id), entry: c }))
    const next = await packSaveFile({
      meta: { ...prior.meta, chunks: undefined },
      chunks: [{ id: 'state', bytes: fakeState(i + 1) }, ...carried],
    })
    prior = await readSaveFile(next)
  }

  assert.deepEqual(
    await prior.chunk('thumb'),
    thumb,
    'thumbnail survived 3 saves'
  )
  assert.equal(prior.meta.id, (await readSaveFile(first)).meta.id)
})

test('an additive newer version stays readable, a breaking one does not', async () => {
  // The compat hinge: bumping `version` alone must not lock existing builds out of new
  // files, or every future change becomes a flag day.
  const additive = await packSaveFile({
    meta: { world: WORLDS.get(LEGACY_WORLD_ID) },
    chunks: [{ id: 'state', bytes: fakeState() }],
  })
  new DataView(additive.buffer).setUint32(4, 99, true) // version only
  const stillFine = readContainerMeta(additive)
  assert.equal(stillFine.version, 99)
  assert.equal(stillFine.meta.world.id, LEGACY_WORLD_ID)

  const breaking = await packSaveFile({
    chunks: [{ id: 'state', bytes: fakeState() }],
  })
  new DataView(breaking.buffer).setUint32(8, 99, true) // minReader
  assert.throws(() => readContainerMeta(breaking), /needs a newer version/)
  assert.throws(
    () => readContainerMeta(breaking),
    (e) => e.name === 'UnsupportedSaveError'
  )
})

test('detects a truncated file instead of reading it as valid', async () => {
  // A part-uploaded share otherwise parses fine: header, metadata and the small chunks
  // all check out, and only the state chunk fails, much later and much less clearly.
  const bytes = await packSaveFile({
    meta: { world: WORLDS.get(LEGACY_WORLD_ID) },
    chunks: [
      { id: 'state', bytes: fakeState(4096) },
      { id: 'thumb', bytes: te.encode('png-ish'), codec: 'raw' },
    ],
  })
  await assert.rejects(
    () => readSaveFile(bytes.subarray(0, bytes.length - 64)),
    /truncated file/
  )
})

test('rejects a hostile chunk table rather than reading the wrong bytes', async () => {
  const build = async (mutate) => {
    const bytes = await packSaveFile({
      meta: { world: WORLDS.get(LEGACY_WORLD_ID) },
      chunks: [{ id: 'state', bytes: fakeState(256) }],
    })
    const view = new DataView(bytes.buffer)
    const metaLen = view.getUint32(12, true)
    const meta = JSON.parse(
      new TextDecoder().decode(
        bytes.subarray(HEADER_SIZE, HEADER_SIZE + metaLen)
      )
    )
    mutate(meta)
    // Re-pack by hand so the table can say things packSaveFile would never write.
    const json = te.encode(JSON.stringify(meta))
    const out = new Uint8Array(HEADER_SIZE + json.length + 4096)
    out.set(bytes.subarray(0, HEADER_SIZE), 0)
    const ov = new DataView(out.buffer)
    ov.setUint32(12, json.length, true)
    ov.setBigUint64(24, BigInt(out.length), true)
    out.set(json, HEADER_SIZE)
    return out
  }

  // A negative offset is the nasty one: subarray() reads from the END of the buffer, so
  // it silently succeeds and hands back unrelated bytes.
  for (const [name, mutate] of [
    ['negative offset', (m) => (m.chunks[0].offset = -1024)],
    ['string offset', (m) => (m.chunks[0].offset = '0')],
    ['missing length', (m) => delete m.chunks[0].length],
    ['fractional length', (m) => (m.chunks[0].length = 1.5)],
    ['past end', (m) => (m.chunks[0].length = 1 << 30)],
    ['no id', (m) => delete m.chunks[0].id],
    ['duplicate id', (m) => m.chunks.push({ ...m.chunks[0] })],
  ])
    await assert.rejects(
      async () => readSaveFile(await build(mutate)),
      /bad offset|bad size|past the end|no id|duplicate chunk/,
      name
    )
})

// --- legacy artifacts (published v1 shares) -------------------------------------

test('reads a bare v86 state as a legacy save', async () => {
  const state = fakeState()
  assert.equal(detectFormat(state), 'legacy')
  const save = await readSaveFile(state)
  assert.equal(save.legacy, true)
  assert.equal(
    save.meta.world,
    undefined,
    'no world recorded -> caller maps it'
  )
  assert.deepEqual(await save.state(), state)
})

test('reads a gzipped v86 state as a legacy save', async () => {
  const state = fakeState()
  const gz = new Uint8Array(gzipSync(state))
  assert.equal(detectFormat(gz), 'legacy')
  const save = await readSaveFile(gz)
  assert.equal(save.legacy, true)
  assert.deepEqual(await save.state(), state)
})

test('refuses bytes that are neither', async () => {
  await assert.rejects(
    () => readSaveFile(te.encode('this is not a machine')),
    /not a valid save file/
  )
  assert.equal(detectFormat(MAGIC.subarray(0, 3)), 'unknown')
})

// --- worlds ---------------------------------------------------------------------

test('no world descriptor resolves to the legacy world', () => {
  assert.equal(resolveWorld(null, prod).id, LEGACY_WORLD_ID)
})

test('the registry wins over whatever the file claims', () => {
  const tampered = {
    id: LEGACY_WORLD_ID,
    memory: 64 * 1024 * 1024,
    vgaMemory: 8 * 1024 * 1024,
    disks: { hda: { url: 'https://evil.example/hda.img', size: 1024 } },
  }
  const world = resolveWorld(tampered, prod)
  assert.equal(world.disks.hda.url, WORLDS.get(LEGACY_WORLD_ID).disks.hda.url)
  assert.equal(world.memory, 128 * 1024 * 1024)
})

test('an unknown world id is refused outright', () => {
  assert.throws(
    () => resolveWorld('win98-someone-elses-image', prod),
    /unknown world/
  )
})

const unregistered = (disks, over = {}) => ({
  id: 'win98-cp99-v9',
  memory: 128 * 1024 * 1024,
  vgaMemory: 32 * 1024 * 1024,
  disks,
  ...over,
})

test('refuses disks from a host we do not serve', () => {
  assert.throws(
    () =>
      resolveWorld(
        unregistered({
          hda: { url: 'https://evil.example/hda.img', size: 314572800 },
        }),
        prod
      ),
    /not allowed/
  )
})

test('refuses plain http and localhost in production', () => {
  for (const url of [
    'http://cdn.like-its-1999.jer.app/v1/hda.img',
    'http://localhost:9999/hda.img',
  ])
    assert.throws(
      () => resolveWorld(unregistered({ hda: { url, size: 314572800 } }), prod),
      /not allowed/
    )
})

test('refuses an unversioned CDN path', () => {
  assert.throws(
    () =>
      resolveWorld(
        unregistered({
          hda: {
            url: 'https://cdn.like-its-1999.jer.app/hda.img',
            size: 314572800,
          },
        }),
        prod
      ),
    /not allowed/
  )
})

test('accepts a versioned CDN prefix and our own /vm/ path', () => {
  const world = resolveWorld(
    unregistered({
      hda: {
        url: 'https://cdn.like-its-1999.jer.app/v2/hda.img',
        size: 314572800,
      },
      hdb: { url: '/vm/hdb.img', size: 1073741824 },
    }),
    prod
  )
  assert.equal(world.disks.hda.size, 314572800)
  assert.equal(
    world.disks.hdb.chunkSize,
    256 * 1024,
    'chunk size gets a default'
  )
})

test('refuses unknown disk keys and out-of-range numbers', () => {
  assert.throws(
    () =>
      resolveWorld(
        unregistered({ hdz: { url: '/vm/x.img', size: 1024 } }),
        prod
      ),
    /unknown disk "hdz"/
  )
  assert.throws(
    () =>
      resolveWorld(
        unregistered({ hda: { url: '/vm/hda.img', size: 99 * 1024 ** 3 } }),
        prod
      ),
    /size .* out of range/
  )
  assert.throws(
    () =>
      resolveWorld(
        unregistered(
          { hda: { url: '/vm/hda.img', size: 1024 } },
          { memory: 4 }
        ),
        prod
      ),
    /memory .* out of range/
  )
})

test('refuses a path that needs normalising, in dev too', () => {
  for (const url of [
    '/vm/../../etc/passwd',
    'https://cdn.like-its-1999.jer.app/v1/../hda.img',
  ])
    for (const env of [prod, dev])
      assert.throws(
        () =>
          resolveWorld(unregistered({ hda: { url, size: 314572800 } }), env),
        /not allowed/
      )
})

test('assets may only come from our own /vm/ or the CDN, dev included', () => {
  // There is no dev-only escape hatch: a save file names these urls and the emulator
  // mounts them, so the rule is the same everywhere.
  for (const url of [
    'http://127.0.0.1:8080/hda.img',
    'https://evil.example/hda.img',
    'http://localhost:5173/elsewhere/hda.img',
  ])
    for (const env of [prod, dev])
      assert.throws(
        () =>
          validateWorld(unregistered({ hda: { url, size: 314572800 } }), env),
        /not allowed/,
        url
      )
})

test('v86 config carries COM2 only when the world has it', () => {
  const base = WORLDS.get(LEGACY_WORLD_ID)
  const off = worldToV86Config(base)
  assert.equal(off.uart1, undefined)
  assert.equal(off.memory_size, 128 * 1024 * 1024)
  assert.equal(off.hda.fixed_chunk_size, 256 * 1024)
  assert.equal(off.hda.async, true)
  assert.equal(off.initial_state, undefined)

  const on = worldToV86Config(
    { ...base, uart1: true },
    { initialState: { buffer: 1 } }
  )
  assert.equal(on.uart1, true)
  assert.deepEqual(on.initial_state, { buffer: 1 })
})

// --- dev worlds: rapid image iteration ------------------------------------------

// Stub server: reports sizes/mtimes for whatever we say exists.
function stubFetch(assets) {
  return async (url, init) => {
    assert.equal(init?.method, 'HEAD')
    const name = String(url).split('/').pop()
    const asset = assets[name]
    if (!asset) return { ok: false, status: 404, headers: new Headers() }
    return {
      ok: true,
      status: 200,
      headers: new Headers({
        'content-length': String(asset.size),
        'last-modified': asset.modified,
      }),
    }
  }
}

const imageAt = (modified, size = 314572800) => ({
  'hda.img': { size, modified },
  'hdb.img': { size: 1073741824, modified },
  'state.bin.zst': { size: 9_200_000, modified },
})

test('a dev world takes its sizes from the server and fingerprints the image', async () => {
  const fetchA = stubFetch(imageAt('Wed, 29 Jul 2026 10:00:00 GMT'))
  const a = await currentWorld({}, { dev: true, fetch: fetchA })
  assert.ok(isDevWorldId(a.id))
  assert.equal(a.disks.hda.size, 314572800)
  assert.deepEqual(a.initialState, { url: '/vm/state.bin.zst' })

  // Same bytes -> same id, so a reload keeps restoring the session.
  const again = await currentWorld({}, { dev: true, fetch: fetchA })
  assert.equal(again.id, a.id)

  // Rebuilt image (new mtime and size) -> new id, so the old save is stale rather
  // than restored over disks that no longer match it.
  const rebuilt = await currentWorld(
    {},
    {
      dev: true,
      fetch: stubFetch(imageAt('Thu, 30 Jul 2026 12:00:00 GMT', 320000000)),
    }
  )
  assert.notEqual(rebuilt.id, a.id)
  assert.equal(rebuilt.disks.hda.size, 320000000)
})

test('a dev world with no shipped snapshot cold boots', async () => {
  const assets = imageAt('Wed, 29 Jul 2026 10:00:00 GMT')
  delete assets['state.bin.zst']
  const world = await currentWorld({}, { dev: true, fetch: stubFetch(assets) })
  assert.equal(world.initialState, null)
  assert.equal(world.snapshotIsStale, false)
})

test('a snapshot older than the disks is ignored, not restored', async () => {
  // Mid-rebuild: new disks, snapshot not recaptured yet. Restoring it would paint the
  // old build's RAM over the new image.
  const assets = imageAt('Thu, 30 Jul 2026 12:00:00 GMT')
  assets['state.bin.zst'].modified = 'Wed, 08 Jul 2026 21:58:14 GMT'
  const stale = await currentWorld({}, { dev: true, fetch: stubFetch(assets) })
  assert.equal(stale.snapshotIsStale, true)
  assert.equal(stale.initialState, null)

  // Recapture it and the instant boot comes back.
  assets['state.bin.zst'].modified = 'Thu, 30 Jul 2026 12:30:00 GMT'
  const fresh = await currentWorld({}, { dev: true, fetch: stubFetch(assets) })
  assert.equal(fresh.snapshotIsStale, false)
  assert.deepEqual(fresh.initialState, { url: '/vm/state.bin.zst' })
})

test('a dev world falls back to registry sizes when HEAD is unsupported', async () => {
  const world = await currentWorld(
    {},
    {
      dev: true,
      fetch: async () => {
        throw new Error('no HEAD here')
      },
    }
  )
  assert.equal(world.id, 'dev:unknown')
  assert.equal(world.disks.hda.size, WORLDS.get(LEGACY_WORLD_ID).disks.hda.size)
  assert.equal(world.initialState, null)
})

test('a dev world id in a file is refused, not trusted', async () => {
  // The fingerprint only means anything if we measure it ourselves. Honouring a dev id
  // a file claims is how an old save gets restored over a rebuilt image.
  const desc = {
    id: 'dev:deadbeef1234',
    memory: 128 * 1024 * 1024,
    vgaMemory: 32 * 1024 * 1024,
    disks: { hda: { url: '/vm/hda.img', size: 314572800 } },
  }
  for (const env of [prod, dev])
    assert.throws(() => resolveWorld(desc, env), /can only be opened/)

  // And an explicit ?world= for a dev id is only honoured when the image still matches.
  const assets = imageAt('Wed, 29 Jul 2026 10:00:00 GMT')
  const minted = await currentWorld({}, { dev: true, fetch: stubFetch(assets) })
  const opts = { ...dev, fetch: stubFetch(assets) }
  assert.equal((await currentWorld({ world: minted.id }, opts)).id, minted.id)
  await assert.rejects(
    () => currentWorld({ world: 'dev:notthisone' }, opts),
    /different local image/
  )
})

test('registered worlds are pinned to versioned CDN urls', () => {
  // The expensive failure this guards: if a registered world derived its URLs from the
  // current build's base, shipping a v2 image would silently repoint every published v1
  // share link at v2 disks.
  for (const [id, world] of WORLDS) {
    for (const [key, disk] of Object.entries(world.disks))
      assert.match(
        disk.url,
        new RegExp(`^https://${CDN_HOST}/v\\d+/`),
        `${id} disk ${key} must be an absolute, version-pinned url`
      )
    if (world.initialState)
      assert.match(
        world.initialState.url,
        new RegExp(`^https://${CDN_HOST}/v\\d+/`)
      )
  }
})

test('world ids from files must be boring', () => {
  // These end up in IndexedDB keys, URLs and status text.
  for (const bad of [
    '__proto__',
    'a/b',
    '',
    'x'.repeat(65),
    'has space',
    '<script>',
    null,
  ])
    assert.equal(isValidWorldId(bad), false, `${bad} should be rejected`)
  for (const good of ['win98-checkpoint03-v1', 'dev:8fd95e3a2203'])
    assert.equal(isValidWorldId(good), true)
})

test('a prototype-chain id cannot masquerade as a registered world', () => {
  // WORLDS is a Map, so 'toString' is simply not a member. With a plain object it would
  // have returned Function.prototype.toString, sailed past validation, and blown up at
  // boot with no error shown.
  for (const id of ['toString', 'constructor', '__proto__'])
    assert.throws(() => resolveWorld(id, prod), /unknown world|not a valid/)
})

test('the descriptor we write is the descriptor we accept', () => {
  // worldDescriptor and validateWorld are mirrors; a round trip catches them drifting.
  const world = WORLDS.get(LEGACY_WORLD_ID)
  const round = validateWorld(worldDescriptor(world), prod)
  assert.equal(round.id, world.id)
  assert.equal(round.memory, world.memory)
  assert.equal(round.uart1, world.uart1)
  assert.deepEqual(round.disks, world.disks)
  assert.deepEqual(round.initialState, world.initialState)
})

// --- mode params ----------------------------------------------------------------

test('parses the dev mode params', () => {
  assert.deepEqual(readModeParams('?fresh=1'), {
    fresh: true,
    nosave: false,
    world: null,
    share: null,
  })
  const p = readModeParams(
    '?nosave&world=dev:abc&vm=/vm-cp02/&share=https://x/y.gz'
  )
  assert.equal(p.fresh, false)
  assert.equal(p.nosave, true)
  assert.equal(p.world, 'dev:abc')
  assert.equal(p.share, 'https://x/y.gz')
  assert.equal(readModeParams('?fresh=0').fresh, false)
})

// --- reading a remote save's metadata only ---------------------------------------

test('a remote container is probed for metadata without pulling the body', async () => {
  // The point of the container's uncompressed header: a reviewer can see which world a
  // submitted machine belongs to, and what it carries, from one small read rather than 65 MB
  // of RAM image. The 'r' in Range is the sender's promise, so this counts what it gets.
  const bytes = await packSaveFile({
    meta: { world: { id: 'win98-checkpoint03-v1' }, note: 'x'.repeat(4096) },
    chunks: [
      // Raw and incompressible, so "we did not download the body" means something: a
      // gzipped chunk of zeros would shrink to nothing and prove nothing.
      {
        id: 'state',
        bytes: Uint8Array.from({ length: 300_000 }, (_, i) => (i * 37) & 0xff),
        codec: 'raw',
      },
      { id: 'thumb', bytes: new Uint8Array(64), codec: 'raw' },
    ],
  })

  let served = 0
  const fetch = async (_url, opts) => {
    const m = /bytes=0-(\d+)/.exec(opts.headers.Range)
    const upto = Number(m[1]) + 1
    served += Math.min(upto, bytes.length)
    return {
      ok: true,
      body: null,
      arrayBuffer: async () => bytes.slice(0, upto).buffer,
    }
  }

  const probed = await probeSaveFileMeta('https://example.test/m.99sv', {
    fetch,
    initialBytes: 1024, // deliberately smaller than the metadata, to force the second read
  })
  assert.equal(probed.meta.world.id, 'win98-checkpoint03-v1')
  assert.deepEqual(
    probed.chunks.map((c) => c.id),
    ['state', 'thumb']
  )
  assert.equal(probed.totalLength, bytes.length)
  assert.ok(
    served < bytes.length / 10,
    `read only the header (${served} of ${bytes.length} bytes)`
  )
})

test('a probe refuses an implausible metadata length instead of downloading it', async () => {
  // Four corrupt bytes must not turn a header read into a full download, which is the one
  // thing this function exists to avoid.
  const bytes = await packSaveFile({
    chunks: [{ id: 'state', bytes: fakeState(64) }],
  })
  new DataView(bytes.buffer).setUint32(12, 0x7fffffff, true)
  const fetch = async () => ({
    ok: true,
    body: null,
    arrayBuffer: async () => bytes.buffer,
  })
  await assert.rejects(
    () => probeSaveFileMeta('https://example.test/m.99sv', { fetch }),
    /implausibly large/
  )
})

test('a probe reports a legacy artifact as having no container metadata', async () => {
  const gz = new Uint8Array(gzipSync(fakeState(128)))
  const fetch = async () => ({
    ok: true,
    body: null,
    arrayBuffer: async () => gz.buffer,
  })
  assert.equal(
    await probeSaveFileMeta('https://example.test/old.bin.gz', { fetch }),
    null
  )
})

test('a descriptor cannot lie about how big a disk is', async () => {
  // The last way a save file could still steer the emulator wrong: claim an in-range size
  // for a real object, and v86 spends the session reading past the end of it. Only checked
  // for a world this build does not know, since a registered one pins its own sizes.
  const desc = {
    id: 'someone-elses-world',
    memory: 128 * 1024 * 1024,
    vgaMemory: 32 * 1024 * 1024,
    disks: {
      hda: { url: `https://${CDN_HOST}/v9/hda.img`, size: 314572800 },
    },
  }
  const world = resolveWorld(desc, { dev: false })
  assert.equal(world.resolvable, false)

  const head = (size) => async () => ({
    ok: true,
    headers: new Map([['content-length', String(size)]]),
  })
  // Map has .get, which is all probeAsset uses.
  await assert.rejects(
    () => verifyDiskSizes(world, { fetch: head(999) }),
    /but .* is 999/
  )
  assert.equal(
    (await verifyDiskSizes(world, { fetch: head(314572800) })).id,
    'someone-elses-world',
    'and the honest case passes through'
  )

  // A registered world is not probed at all, however wrong the file was.
  const registered = resolveWorld(LEGACY_WORLD_ID, { dev: false })
  let called = 0
  await verifyDiskSizes(registered, {
    fetch: async () => {
      called++
      return { ok: false }
    },
  })
  assert.equal(called, 0)
})
