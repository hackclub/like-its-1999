// session persistence: read and write `.99sv` save containers (savefile.js), keyed by the
// world they belong to (worlds.js)
//
// a save_state() is ~65 MB raw, so this uses IndexedDB rather than localStorage: binary
// directly, with a large disk-backed quota
//
// saves are stored per world rather than in one global slot, so a v1 share and a v2
// session can coexist, and locally a rebuilt image is a new (fingerprinted) world whose
// slot is separate from the previous image's session; old dev slots are pruned so a fast
// rebuild loop doesn't accumulate 65 MB records
//
// a save re-encodes what it understands and passes everything else back verbatim
// (tracking data, thumbnail, project metadata, sections written by a future build)

import {
  packSaveFile,
  readSaveFile,
  EXTENSION,
  UnsupportedSaveError,
} from './savefile.js'
import {
  resolveWorld,
  worldDescriptor,
  verifyDiskSizes,
  isDevWorldId,
  LEGACY_WORLD_ID,
} from './worlds.js'

const DB_NAME = 'like-its-99'
const DB_VERSION = 2
const STORE = 'vm'
const INDEX_KEY = 'index'
const LEGACY_KEY = 'state' // the pre-container single slot, tagged with the v1 world id

// how many local rebuild worlds to keep; registered worlds are never pruned, because one
// of those is a participant's machine
export const MAX_DEV_SLOTS = 3

const slotKey = (worldId) => `world:${worldId}`

// one cached connection, closed when another tab needs to upgrade; opening per operation
// leaked ~5 connections per save, and without the versionchange handler an old tab blocks
// a DB_VERSION bump, so the new tab's open() never settles and the boot path (which
// top-level awaits it) never starts the emulator
let dbPromise = null

function openDb() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE))
        req.result.createObjectStore(STORE)
    }
    req.onblocked = () =>
      reject(
        new Error(
          'another tab is holding an older version of the save database — ' +
            'close it and reload'
        )
      )
    req.onsuccess = () => {
      const db = req.result
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      db.onclose = () => {
        dbPromise = null
      }
      resolve(db)
    }
    req.onerror = () => {
      dbPromise = null
      reject(req.error)
    }
  })
  return dbPromise
}

// one transaction for everything: split across several (slot put, prunes, index put), an
// interrupted save (pagehide is the normal case) left the index and the records
// disagreeing, stranding megabytes in a record nothing mentioned
async function withStore(mode, fn) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const store = tx.objectStore(STORE)
    let result
    const req = (request) =>
      new Promise((res, rej) => {
        request.onsuccess = () => res(request.result)
        request.onerror = () => rej(request.error)
      })
    Promise.resolve(fn(store, req)).then(
      (value) => {
        result = value
      },
      (err) => {
        try {
          tx.abort()
        } catch {}
        reject(err)
      }
    )
    tx.oncomplete = () => resolve(result)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'))
  })
}

const idbGet = (key) =>
  withStore('readonly', (store, req) => req(store.get(key)))

// the slot index is a small record of which worlds have saves and when, so listing and
// pruning never load the multi-megabyte records
//
// a Map, which IndexedDB stores natively: world ids come from untrusted files, and with a
// plain object an id of '__proto__' sets the prototype instead of a key, producing a slot
// that is written but never listed, pruned or cleared

const toIndex = (raw) => (raw instanceof Map ? new Map(raw) : new Map())

// pruning works off the slot records that exist rather than the index, so a record the
// index doesn't mention still gets reclaimed by the next save
const slotKeysIn = async (store, req) =>
  (await req(store.getAllKeys())).filter(
    (k) => typeof k === 'string' && k.startsWith('world:')
  )

// newest first: [{ worldId, at, label, gen }]
export async function listSavedWorlds() {
  const index = toIndex(await idbGet(INDEX_KEY))
  return [...index]
    .map(([worldId, meta]) => ({
      worldId,
      at: meta?.at ?? 0,
      label: meta?.label || worldId,
      // generation as of that write, so an import can compare-and-swap without loading
      // the multi-megabyte record just to read one number
      gen: meta?.gen ?? null,
    }))
    .sort((a, b) => b.at - a.at)
}

// throws if the world can't be trusted (see the allowlist in worlds.js)
async function openSave(bytes) {
  const save = await readSaveFile(bytes)
  const world = resolveWorld(save.meta.world ?? null)
  // only checks a world this build does not know (the registry pins its own sizes and a
  // dev world measures them); an unregistered descriptor could otherwise claim any
  // in-range size for a real object and have v86 read past the end of it all session
  await verifyDiskSizes(world)
  return { save, world, state: await save.state() }
}

// reads only this world's slot, so a rebuilt local image (a different world id) has
// nothing here
//
// returns `{ readOnly: true }` when a slot exists but this build can't parse it; falling
// through to "no session" would let the autosave two minutes later overwrite a save we
// merely failed to understand, so a stale cached build or a rolled-back deploy would
// destroy someone's machine
export async function loadSavedSession(world) {
  let rec
  try {
    rec = await idbGet(slotKey(world.id))
  } catch (e) {
    console.error('save storage is unavailable:', e)
    return { readOnly: true, reason: e.message }
  }

  if (rec?.bytes) {
    try {
      const save = await readSaveFile(new Uint8Array(rec.bytes))
      return { save, state: await save.state(), world, gen: rec.gen ?? 0 }
    } catch (e) {
      if (e instanceof UnsupportedSaveError)
        return { readOnly: true, reason: e.message }
      console.error('saved session is corrupt, leaving it alone:', e)
      return {
        readOnly: true,
        reason: `saved session is unreadable (${e.message})`,
      }
    }
  }

  // migrate the pre-container slot, once; it was tagged with the v1 image id and records
  // no fingerprint, so only the world it was captured against may adopt it (a dev world
  // is a rebuilt image and must not)
  try {
    const legacy = await idbGet(LEGACY_KEY)
    if (
      legacy?.gz &&
      legacy.imageId === LEGACY_WORLD_ID &&
      isLegacyWorld(world)
    ) {
      const save = await readSaveFile(new Uint8Array(legacy.gz))
      return { save, state: await save.state(), world, gen: 0, migrated: true }
    }
  } catch (e) {
    console.error('pre-container save is unreadable, ignoring it:', e)
  }
  return null
}

// the v1 world, whether from the registry or a dev rewrite of it
const isLegacyWorld = (world) => world.id === LEGACY_WORLD_ID

// github.com/.../raw/... and /blob/... 302-redirect to raw.githubusercontent.com, and the
// redirect response carries no CORS header, so a cross-origin fetch dies on the hop
// before it reaches the (CORS-enabled) raw host; rewrite straight to the raw host
function normalizeShareUrl(url) {
  const m = url.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:raw|blob)\/(.+?)(?:\?.*)?$/
  )
  if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`
  return url
}

// a `?share=` URL is an arbitrary host, so reading it unbounded lets any link decide how
// much memory this tab uses; Content-Length is only the sender's claim, so the stream is
// counted as it arrives
export const MAX_SHARE_BYTES = 128 * 1024 * 1024

async function fetchBounded(url, limit) {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`fetch failed (${resp.status})`)
  const claimed = Number(resp.headers.get('content-length'))
  if (Number.isFinite(claimed) && claimed > limit)
    throw new Error(`that machine is too large (${claimed} bytes)`)
  if (!resp.body) {
    const bytes = new Uint8Array(await resp.arrayBuffer())
    if (bytes.length > limit) throw new Error('that machine is too large')
    return bytes
  }
  const reader = resp.body.getReader()
  const parts = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > limit) {
      await reader.cancel().catch(() => {})
      throw new Error(`that machine is too large (over ${limit} bytes)`)
    }
    parts.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

// accepts a container or any legacy v1 artifact: every published `?share=` link is a bare
// gzipped state, and a file with no world recorded resolves to the legacy world
export async function fetchSharedSave(url) {
  return openSave(await fetchBounded(normalizeShareUrl(url), MAX_SHARE_BYTES))
}

// `prior` is the save this session was booted from (if any); its metadata and any chunks
// we don't generate ourselves are carried through untouched, which lets a future build
// add sections without this one destroying them
async function packSession(
  emulator,
  { world, prior = null, hb = null, thumb = null, instanceId, tracking = {} }
) {
  const state = new Uint8Array(await emulator.save_state())
  const priorMeta = prior?.meta ?? {}
  const generated = new Set(['state'])

  const chunks = [{ id: 'state', bytes: state }]

  // the tracking log, sealed and countersigned by the time it gets here (see
  // daemon/sealed.js); one chunk per instance, never rewritten by anyone else, because
  // one saved machine can be restored many times and forks appending to a shared chunk
  // clobber or double-count each other
  if (hb?.body?.length) {
    const id = `hb/${instanceId}`
    generated.add(id)
    chunks.push({
      id,
      bytes: hb.body,
      codec: 'raw', // already gzipped, then encrypted; gzip again would only add bytes
      // the signature covers exactly this hash; the 65 MB state stays unhashed because
      // that cost would land on every autosave
      hash: true,
      extra: {
        format: 'ndjson+gzip+sealed',
        seal: hb.seal,
        sig: hb.sig ?? null,
        signedAt: hb.signedAt ?? null,
        sigKeyId: hb.sigKeyId ?? null,
      },
    })
  }
  if (thumb) {
    generated.add('thumb')
    chunks.push({
      id: 'thumb',
      bytes: thumb,
      codec: 'raw', // already a PNG; gzip would only add bytes
      extra: { mime: 'image/png' },
    })
  }

  // verbatim pass-through of everything else the loaded file had
  if (prior && !prior.legacy)
    for (const entry of prior.chunks)
      if (!generated.has(entry.id))
        chunks.push({
          id: entry.id,
          stored: prior.storedChunk(entry.id),
          entry,
        })

  // drop the prior chunk table (rebuilt below) and the legacy marker; keep every other
  // key, including ones we don't know
  const { chunks: _table, legacy: _legacy, ...carriedMeta } = priorMeta
  return packSaveFile({
    meta: {
      ...carriedMeta,
      updatedAt: Date.now(),
      world: worldDescriptor(world),
      tracking: { ...(priorMeta.tracking || {}), ...tracking, instanceId },
    },
    chunks,
  })
}

// raised when the slot moved on underneath us, i.e. another tab saved since we loaded
export class StaleSaveError extends Error {
  constructor(message) {
    super(message)
    this.name = 'StaleSaveError'
  }
}

// `expectGen` is a compare-and-swap, enforced here rather than trusted from the caller:
//
//   a number    "I read this generation", must still match
//   undefined   "I never looked", which is a claim that nothing is stored, so it is
//               checked against generation 0 rather than waved through
//   null        "overwrite deliberately", the only value that skips the check
//
// each tab holds its own in-memory `prior`, so without this two tabs on one machine take
// turns writing containers derived from stale metadata, each discarding the other's chunks
async function writeSlot(worldId, label, bytes, expectGen) {
  const expected = expectGen === undefined ? 0 : expectGen
  return withStore('readwrite', async (store, req) => {
    const existing = await req(store.get(slotKey(worldId)))
    const currentGen = existing?.gen ?? 0
    if (expected !== null && currentGen !== expected)
      throw new StaleSaveError(
        `this machine was saved elsewhere (generation ${currentGen}, expected ` +
          `${expected}) — reload to pick up the newer save`
      )
    const gen = currentGen + 1
    store.put({ v: 2, worldId, bytes, at: Date.now(), gen }, slotKey(worldId))

    // index first, then prune what it no longer keeps, so a failure leaves the index
    // under-promising rather than pointing at records that are gone
    const index = toIndex(await req(store.get(INDEX_KEY)))
    index.set(worldId, { at: Date.now(), label, gen })
    // prune only local rebuild worlds; recency across everything would eventually delete
    // a participant's real machine to make room for a dev image, which is regenerated by
    // rebuilding anyway
    const disposable = [...index]
      .filter(([id]) => isDevWorldId(id))
      .sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0))
    const kept = new Map(
      [...index].filter(
        ([id]) =>
          !isDevWorldId(id) ||
          disposable.slice(0, MAX_DEV_SLOTS).some(([keep]) => keep === id)
      )
    )
    store.put(kept, INDEX_KEY)
    for (const key of await slotKeysIn(store, req)) {
      const id = key.slice('world:'.length)
      if (!kept.has(id)) store.delete(key)
    }
    // the pre-container slot is now superseded for the world it was captured against;
    // leaving it kept a second copy of a multi-megabyte save alive and let the stale
    // original come back if this slot were ever pruned
    if (worldId === LEGACY_WORLD_ID) store.delete(LEGACY_KEY)
    return gen
  })
}

// ask the browser not to evict us, once; best effort, since Firefox prompts, Safari
// decides for itself, and a refusal is not a reason to fail a save
let persistenceAsked = false
async function askForPersistence() {
  if (persistenceAsked) return
  persistenceAsked = true
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted()))
      await navigator.storage.persist()
  } catch {}
}

// storage full is the one save failure a user can act on, so it says what to do rather
// than surfacing a DOMException name
export class StorageFullError extends Error {
  constructor(message) {
    super(message)
    this.name = 'StorageFullError'
  }
}

const isQuota = (e) =>
  e?.name === 'QuotaExceededError' ||
  e?.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
  /quota/i.test(e?.message || '')

// returns { size, save, gen }, and the caller must feed `save` and `gen` back into the
// next call: "prior" means the newest version of this file, not the one the page booted
// from, and keep passing the boot-time save and every write re-derives from stale
// metadata, minting a new file id and dropping chunks that only the stored copy had
export async function saveSession(emulator, opts) {
  const bytes = await packSession(emulator, opts)
  await askForPersistence()
  let gen
  try {
    gen = await writeSlot(
      opts.world.id,
      opts.world.label,
      bytes,
      opts.expectGen
    )
  } catch (e) {
    if (!isQuota(e)) throw e
    const mb = (bytes.byteLength / 1e6).toFixed(0)
    throw new StorageFullError(
      `no room to save (${mb} MB needed). Export the machine to a file, then free ` +
        'browser storage for this site.'
    )
  }
  return { size: bytes.byteLength, save: await readSaveFile(bytes), gen }
}

export async function clearSavedSession(world) {
  await withStore('readwrite', async (store, req) => {
    store.delete(slotKey(world.id))
    const index = toIndex(await req(store.get(INDEX_KEY)))
    index.delete(world.id)
    store.put(index, INDEX_KEY)
    if (isLegacyWorld(world)) store.delete(LEGACY_KEY)
  })
}

// the same artifact a `?share=` URL points at
export async function exportSession(emulator, opts) {
  const bytes = await packSession(emulator, opts)
  const stamp = new Date().toISOString().slice(0, 10)
  const a = document.createElement('a')
  a.href = URL.createObjectURL(
    new Blob([bytes], { type: 'application/octet-stream' })
  )
  a.download = `like-its-1999-${stamp}${EXTENSION}`
  a.click()
  URL.revokeObjectURL(a.href)
  return bytes.byteLength
}

// reads an imported file without writing anything, and reports what storing it would
// replace, so the caller can name the machine being destroyed (and the right world, since
// a file may belong to a different one than the page is running) before the user commits
export async function readImport(file, runningWorld) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const { save, world, state } = await openSave(bytes)
  const index = toIndex(await idbGet(INDEX_KEY))
  const slot = index.get(world.id) ?? null
  return {
    save,
    world,
    state,
    bytes,
    needsReload: world.id !== runningWorld.id,
    replaces: slot, // { at, label, gen } or null
    // what the user is being shown, so the write can refuse if it changed while they
    // were deciding; undefined for a slot the index has never seen, which writeSlot
    // checks against generation 0
    gen: slot?.gen ?? undefined,
  }
}

// the user has been shown what this replaces, but that consent covers the machine they
// were told about, so if another tab saved in between this still compares and swaps and
// raises StaleSaveError
export const storeImport = ({ world, bytes, gen }) =>
  writeSlot(world.id, world.label, bytes, gen)
