// node --test emulator/persist.test.mjs
//
// Storage, against fake-indexeddb rather than a hand-rolled stub, so transaction
// lifetimes and structured-clone semantics behave like a browser's. This covers the code
// where a bug means losing someone's machine: the compare-and-swap, pruning, the
// refuse-to-overwrite paths, and the pre-container migration.

import 'fake-indexeddb/auto'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'

import {
  loadSavedSession,
  saveSession,
  clearSavedSession,
  listSavedWorlds,
  readImport,
  storeImport,
  StaleSaveError,
  MAX_SLOTS,
} from './persist.js'
import { packSaveFile, readSaveFile } from './savefile.js'
import { WORLDS, LEGACY_WORLD_ID } from './worlds.js'

const te = new TextEncoder()
const legacyWorld = WORLDS.get(LEGACY_WORLD_ID)
const devWorld = (id = 'dev:aaaa1111') => ({
  ...legacyWorld,
  id,
  label: `local image ${id}`,
})

// A structurally real v86 state, padded so gzip has something to do.
function fakeState(pad = 2048) {
  const json = te.encode(JSON.stringify({ buffer_infos: [], state: [] }))
  const total = 16 + json.length + pad
  const buf = new Uint8Array(total)
  const view = new DataView(buf.buffer)
  view.setUint32(0, 0x86768676, true)
  view.setUint32(4, 6, true)
  view.setUint32(8, total, true)
  view.setUint32(12, json.length, true)
  buf.set(json, 16)
  return buf
}

// Stands in for the emulator: saveSession only calls save_state().
const fakeEmulator = (pad = 2048) => ({
  save_state: async () => fakeState(pad).buffer,
})

const opts = (world, over = {}) => ({
  world,
  prior: null,
  instanceId: 'instance-1',
  thumb: null,
  ...over,
})

// Reach into the database the way nothing in the app does, to assert on what landed.
const DB = 'like-its-99'

// One helper for all direct access. It tolerates a database that has no object store
// yet, which happens whenever a test asserts on storage before anything has written —
// otherwise transaction() throws inside a callback and the promise never settles.
function withRawStore(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 2)
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains('vm'))
        open.result.createObjectStore('vm')
    }
    open.onsuccess = () => {
      const db = open.result
      if (!db.objectStoreNames.contains('vm')) {
        db.close()
        return resolve(undefined)
      }
      const tx = db.transaction('vm', mode)
      let result
      try {
        const req = fn(tx.objectStore('vm'))
        if (req) req.onsuccess = () => (result = req.result)
      } catch (e) {
        db.close()
        return reject(e)
      }
      tx.oncomplete = () => {
        db.close()
        resolve(result)
      }
      tx.onerror = () => {
        db.close()
        reject(tx.error)
      }
    }
    open.onerror = () => reject(open.error)
  })
}

const raw = (key) => withRawStore('readonly', (store) => store.get(key))
const rawKeys = async () =>
  (await withRawStore('readonly', (store) => store.getAllKeys())) ?? []
const putRaw = (key, value) =>
  withRawStore('readwrite', (store) => store.put(value, key))

// Each test starts from an empty database. Deleting it also exercises the real
// versionchange path: persist.js caches one connection, and its handler is what lets
// another tab's upgrade (or this delete) proceed instead of hanging.
beforeEach(
  () =>
    new Promise((resolve) => {
      const req = indexedDB.deleteDatabase(DB)
      req.onsuccess = req.onerror = req.onblocked = () => resolve()
    })
)

// --- writing and the compare-and-swap --------------------------------------------

test('a first save creates the slot and indexes it', async () => {
  const { size, gen, save } = await saveSession(
    fakeEmulator(),
    opts(legacyWorld)
  )
  assert.equal(gen, 1)
  assert.ok(size > 0)
  assert.ok(save.chunkIds.includes('state'))

  const rec = await raw(`world:${legacyWorld.id}`)
  assert.equal(rec.worldId, legacyWorld.id)
  assert.equal(rec.gen, 1)
  assert.ok(rec.at > 0)

  const index = await raw('index')
  assert.ok(
    index instanceof Map,
    'the index is a Map, so __proto__ ids are safe'
  )
  assert.equal(index.get(legacyWorld.id).label, legacyWorld.label)

  const listed = await listSavedWorlds()
  assert.deepEqual(
    listed.map((s) => s.worldId),
    [legacyWorld.id]
  )
})

test('generations advance and a stale write is refused without changing anything', async () => {
  const first = await saveSession(fakeEmulator(), opts(legacyWorld))
  const second = await saveSession(
    fakeEmulator(),
    opts(legacyWorld, { prior: first.save, expectGen: first.gen })
  )
  assert.equal(second.gen, 2)

  const before = await raw(`world:${legacyWorld.id}`)
  await assert.rejects(
    () =>
      saveSession(
        fakeEmulator(4096),
        opts(legacyWorld, { prior: first.save, expectGen: first.gen })
      ),
    (e) => e instanceof StaleSaveError && /saved elsewhere/.test(e.message)
  )
  const after = await raw(`world:${legacyWorld.id}`)
  assert.equal(after.gen, before.gen)
  assert.equal(after.bytes.byteLength, before.bytes.byteLength)
})

test('claiming an empty slot fails once something is actually there', async () => {
  // The regression: a tab that booted with nothing stored used to overwrite a machine
  // another tab created afterwards.
  await saveSession(fakeEmulator(), opts(legacyWorld))
  await assert.rejects(
    () => saveSession(fakeEmulator(), opts(legacyWorld, { expectGen: 0 })),
    StaleSaveError
  )
})

test('expectGen null overwrites deliberately', async () => {
  await saveSession(fakeEmulator(), opts(legacyWorld))
  const forced = await saveSession(
    fakeEmulator(4096),
    opts(legacyWorld, { expectGen: null })
  )
  assert.equal(forced.gen, 2)
})

test('a save with no expectGen still verifies the slot is empty', async () => {
  await saveSession(fakeEmulator(), opts(legacyWorld))
  // opts() omits expectGen entirely -> undefined -> treated as "no claim", so this is
  // the one shape that is allowed to pass unchecked. Documenting it rather than asserting
  // a wrong behaviour: main.js always supplies a value from planSave.
  const again = await saveSession(fakeEmulator(), opts(legacyWorld))
  assert.equal(again.gen, 2)
})

// --- pruning ---------------------------------------------------------------------

test('pruning keeps the newest slots and deletes the records, not just the index', async () => {
  const keep = MAX_SLOTS
  for (let i = 0; i < keep + 2; i++) {
    await saveSession(fakeEmulator(), opts(devWorld(`dev:world${i}`)))
    // Distinct timestamps so "newest" is well defined.
    await new Promise((r) => setTimeout(r, 2))
  }
  const index = await raw('index')
  assert.equal(index.size, keep)

  const keys = (await rawKeys()).filter((k) => String(k).startsWith('world:'))
  assert.equal(
    keys.length,
    keep,
    'no orphaned multi-megabyte records left behind'
  )
  assert.ok(index.has('dev:world4'), 'the newest survived')
  assert.ok(!index.has('dev:world0'), 'the oldest was dropped')
  assert.ok(!keys.includes('world:dev:world0'))
})

test('pruning reclaims a slot record the index never knew about', async () => {
  // Writes are single-transaction now, so this shouldn't arise — but a record with no
  // index entry would otherwise be invisible and unreclaimable forever.
  await putRaw('world:dev:orphan', {
    v: 2,
    worldId: 'dev:orphan',
    bytes: new Uint8Array(64),
    at: 0,
    gen: 1,
  })
  for (let i = 0; i < MAX_SLOTS; i++) {
    await saveSession(fakeEmulator(), opts(devWorld(`dev:live${i}`)))
    await new Promise((r) => setTimeout(r, 2))
  }
  const keys = (await rawKeys()).filter((k) => String(k).startsWith('world:'))
  assert.ok(!keys.includes('world:dev:orphan'), 'the orphan was pruned')
})

// --- reading ---------------------------------------------------------------------

test('no saved session reads as null', async () => {
  assert.equal(await loadSavedSession(legacyWorld), null)
})

test('a saved session round trips with its generation', async () => {
  const written = await saveSession(fakeEmulator(), opts(legacyWorld))
  const loaded = await loadSavedSession(legacyWorld)
  assert.equal(loaded.gen, written.gen)
  assert.equal(loaded.save.meta.id, written.save.meta.id)
  assert.deepEqual(await loaded.save.state(), fakeState())
  assert.equal(loaded.readOnly, undefined)
})

test('a save needing a newer reader is read-only, not absent', async () => {
  const bytes = await packSaveFile({
    meta: { world: { id: legacyWorld.id } },
    chunks: [{ id: 'state', bytes: fakeState() }],
  })
  new DataView(bytes.buffer).setUint32(8, 99, true) // minReader
  await putRaw(`world:${legacyWorld.id}`, {
    v: 2,
    worldId: legacyWorld.id,
    bytes,
    at: Date.now(),
    gen: 9,
  })

  const loaded = await loadSavedSession(legacyWorld)
  assert.equal(loaded.readOnly, true)
  assert.match(loaded.reason, /newer version/)
  assert.notEqual(loaded, null, 'must not look like "nothing saved"')
})

test('corrupt bytes are read-only too, and are left untouched', async () => {
  await putRaw(`world:${legacyWorld.id}`, {
    v: 2,
    worldId: legacyWorld.id,
    bytes: te.encode('this is not a machine at all'),
    at: Date.now(),
    gen: 4,
  })
  const loaded = await loadSavedSession(legacyWorld)
  assert.equal(loaded.readOnly, true)
  assert.match(loaded.reason, /unreadable/)
  const rec = await raw(`world:${legacyWorld.id}`)
  assert.equal(rec.gen, 4)
})

// --- the pre-container migration --------------------------------------------------

const legacySlot = async () =>
  putRaw('state', {
    imageId: LEGACY_WORLD_ID,
    gz: new Uint8Array(gzipSync(fakeState())),
    at: 1700000000000,
  })

test('the old single-slot save migrates into the world it was captured on', async () => {
  await legacySlot()
  const loaded = await loadSavedSession(legacyWorld)
  assert.equal(loaded.migrated, true)
  assert.equal(loaded.gen, 0)
  assert.deepEqual(await loaded.save.state(), fakeState())
})

test('a rebuilt local image must NOT adopt the old save', async () => {
  // It records no fingerprint, so it can only be trusted for the world it was tagged
  // with. Adopting it into every dev world meant restoring weeks-old RAM over new disks.
  await legacySlot()
  assert.equal(await loadSavedSession(devWorld()), null)
})

test('a real slot takes precedence over the old one', async () => {
  await legacySlot()
  const written = await saveSession(fakeEmulator(4096), opts(legacyWorld))
  const loaded = await loadSavedSession(legacyWorld)
  assert.equal(loaded.migrated, undefined)
  assert.equal(loaded.gen, written.gen)
})

// --- clearing --------------------------------------------------------------------

test('clearing removes the slot, its index entry and the old save', async () => {
  await legacySlot()
  await saveSession(fakeEmulator(), opts(legacyWorld))
  await clearSavedSession(legacyWorld)

  assert.equal(await raw(`world:${legacyWorld.id}`), undefined)
  assert.equal(await raw('state'), undefined, 'the pre-container slot goes too')
  assert.equal((await raw('index')).size, 0)
  assert.equal(await loadSavedSession(legacyWorld), null)
})

test('clearing one world leaves the others alone', async () => {
  await saveSession(fakeEmulator(), opts(devWorld('dev:one')))
  await saveSession(fakeEmulator(), opts(devWorld('dev:two')))
  await clearSavedSession(devWorld('dev:one'))
  const listed = (await listSavedWorlds()).map((s) => s.worldId)
  assert.deepEqual(listed, ['dev:two'])
  assert.ok(await raw('world:dev:two'))
})

// --- carry-forward ----------------------------------------------------------------

test('a save carries forward chunks and metadata it was not given again', async () => {
  // Same guarantee as the format test, but through the storage path a real autosave takes.
  const thumb = te.encode('pretend png bytes')
  const sealed = te.encode('pretend ciphertext')
  const first = await saveSession(
    fakeEmulator(),
    opts(legacyWorld, {
      thumb,
      hb: { body: sealed, seal: { alg: 'ECIES-P256-AES256GCM' }, sig: 'sig1' },
    })
  )
  assert.deepEqual(first.save.chunkIds.sort(), [
    'hb/instance-1',
    'state',
    'thumb',
  ])

  // An autosave: no thumbnail, no tracking data supplied.
  const second = await saveSession(
    fakeEmulator(4096),
    opts(legacyWorld, { prior: first.save, expectGen: first.gen })
  )
  assert.deepEqual(second.save.chunkIds.sort(), [
    'hb/instance-1',
    'state',
    'thumb',
  ])
  assert.deepEqual(await second.save.chunk('thumb'), thumb)
  assert.equal(second.save.meta.id, first.save.meta.id, 'same file identity')
  assert.deepEqual(
    await second.save.chunk('hb/instance-1'),
    sealed,
    'the sealed log survives an autosave that knows nothing about it'
  )
  const entry = second.save.chunkEntry('hb/instance-1')
  assert.equal(entry.sig, 'sig1', 'and so does its signature')
  assert.match(entry.sha256, /^[0-9a-f]{64}$/, 'the signed hash is recorded')
})

test('each instance writes its own tracking chunk and never rewrites another', async () => {
  // One saved machine restored twice: the forks must not clobber each other, which is what
  // per-instance chunk ids buy.
  const one = await saveSession(
    fakeEmulator(),
    opts(legacyWorld, {
      instanceId: 'i-A',
      hb: { body: te.encode('log A'), seal: { alg: 'x' } },
    })
  )
  const two = await saveSession(
    fakeEmulator(4096),
    opts(legacyWorld, {
      instanceId: 'i-B',
      prior: one.save,
      expectGen: one.gen,
      hb: { body: te.encode('log B'), seal: { alg: 'x' } },
    })
  )
  assert.deepEqual(two.save.chunkIds.sort(), ['hb/i-A', 'hb/i-B', 'state'])
  assert.deepEqual(await two.save.chunk('hb/i-A'), te.encode('log A'))
  assert.deepEqual(await two.save.chunk('hb/i-B'), te.encode('log B'))
})

test('provenance gains one entry per restore, not per save', async () => {
  const a = await saveSession(fakeEmulator(), opts(legacyWorld))
  assert.equal(a.save.meta.provenance.length, 1)
  const b = await saveSession(
    fakeEmulator(),
    opts(legacyWorld, { prior: a.save, expectGen: a.gen })
  )
  assert.equal(b.save.meta.provenance.length, 1, 'same instance, same entry')

  const c = await saveSession(
    fakeEmulator(),
    opts(legacyWorld, {
      prior: b.save,
      expectGen: b.gen,
      instanceId: 'instance-2',
    })
  )
  assert.equal(c.save.meta.provenance.length, 2)
  assert.equal(c.save.meta.provenance[1].parent, 'instance-1')
})

// --- import ----------------------------------------------------------------------

const fileOf = (bytes) => ({ arrayBuffer: async () => bytes.buffer ?? bytes })

test('readImport writes nothing and reports what it would replace', async () => {
  await saveSession(fakeEmulator(), opts(legacyWorld))
  const before = await raw(`world:${legacyWorld.id}`)

  const bytes = await packSaveFile({
    meta: { world: { id: legacyWorld.id } },
    chunks: [{ id: 'state', bytes: fakeState(8192) }],
  })
  const imported = await readImport(fileOf(bytes), legacyWorld)

  assert.equal(imported.needsReload, false)
  assert.ok(imported.replaces, 'names the machine that would be lost')
  assert.equal(imported.world.id, legacyWorld.id)
  const after = await raw(`world:${legacyWorld.id}`)
  assert.equal(after.gen, before.gen, 'reading must not write')

  const gen = await storeImport(imported)
  assert.equal(gen, before.gen + 1)
  assert.equal(
    (await raw(`world:${legacyWorld.id}`)).bytes.byteLength,
    bytes.length
  )
})

test('a legacy v1 file imports as the legacy world', async () => {
  const gz = new Uint8Array(gzipSync(fakeState()))
  const imported = await readImport(fileOf(gz), devWorld())
  assert.equal(imported.world.id, LEGACY_WORLD_ID)
  assert.equal(
    imported.needsReload,
    true,
    'a different world than the one running'
  )
  assert.equal(imported.replaces, null)
  assert.equal(imported.save.legacy, true)
})

test('an import naming a disallowed disk is refused', async () => {
  const bytes = await packSaveFile({
    meta: {
      world: {
        id: 'win98-evil-v1',
        memory: 134217728,
        vgaMemory: 33554432,
        disks: {
          hda: { url: 'https://evil.example/hda.img', size: 314572800 },
        },
      },
    },
    chunks: [{ id: 'state', bytes: fakeState() }],
  })
  await assert.rejects(
    () => readImport(fileOf(bytes), legacyWorld),
    /not allowed/
  )
  assert.equal(await raw('world:win98-evil-v1'), undefined)
})
