// Session persistence: read and write `.99sv` save containers (savefile.js), keyed by
// the world they belong to (worlds.js).
//
// A save_state() is ~65 MB raw, so this uses IndexedDB rather than localStorage — it
// stores binary directly with a large disk-backed quota. The v86 state inside the
// container is gzipped, so what lands on disk is about what the old bare `.gz` was.
//
// Saves are stored PER WORLD instead of in one global slot. That matters twice over:
// a v1 share and a v2 session can coexist without clobbering each other, and locally
// a rebuilt image is a new (fingerprinted) world, so its slot is separate and the
// previous image's session is left intact rather than restored over changed disks.
// Old slots are pruned so a fast rebuild loop doesn't accumulate 65 MB records.
//
// Everything a save carries besides the RAM image — tracking data, thumbnail, project
// metadata, unknown sections written by a future build — round-trips through here: a
// save re-encodes what it understands and passes the rest back verbatim.

import {
  packSaveFile,
  readSaveFile,
  EXTENSION,
  UnsupportedSaveError,
} from './savefile.js'
import { resolveWorld, worldDescriptor, LEGACY_WORLD_ID } from './worlds.js'

const DB_NAME = 'like-its-99'
const DB_VERSION = 2
const STORE = 'vm'
const INDEX_KEY = 'index'
const LEGACY_KEY = 'state' // the pre-container single slot
const LEGACY_IMAGE_ID = LEGACY_WORLD_ID // what that slot was tagged with

// How many world slots to keep. Rebuild-heavy dev sessions would otherwise pile up.
export const MAX_SLOTS = 3

const slotKey = (worldId) => `world:${worldId}`

// One cached connection, closed when another tab needs to upgrade. Opening per
// operation leaked ~5 connections per save, and without the versionchange handler an
// old tab blocks a future DB_VERSION bump: the new tab's open() then never settles, and
// since the boot path top-level awaits it, the emulator would never start at all.
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

// Run everything in ONE transaction. Splitting a save across several (slot put, then
// prunes, then index put) meant an interrupted save — and pagehide is the normal case —
// could leave the index and the records disagreeing, stranding megabytes in a record
// nothing mentioned.
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

// --- slot index -----------------------------------------------------------------
// A tiny record listing which worlds have saves and when they were written, so listing
// and pruning never have to load the multi-megabyte records themselves.
//
// A Map, which IndexedDB stores natively: world ids come from untrusted files, and with
// a plain object an id of '__proto__' sets the prototype instead of a key, producing a
// slot that is written but never listed, never pruned and never cleared.

const toIndex = (raw) => (raw instanceof Map ? new Map(raw) : new Map())

// Pruning works off the slot records that actually exist rather than the index, so a
// record the index somehow doesn't mention still gets reclaimed by the next save.
const slotKeysIn = async (store, req) =>
  (await req(store.getAllKeys())).filter(
    (k) => typeof k === 'string' && k.startsWith('world:')
  )

// Newest first: [{ worldId, at, label }]. Reads only the index, never the multi-megabyte
// slot records.
export async function listSavedWorlds() {
  const index = toIndex(await idbGet(INDEX_KEY))
  return [...index]
    .map(([worldId, meta]) => ({
      worldId,
      at: meta?.at ?? 0,
      label: meta?.label || worldId,
    }))
    .sort((a, b) => b.at - a.at)
}

// --- reading --------------------------------------------------------------------

// Open a save from raw bytes: container or legacy artifact, plus its resolved world.
// Throws if the world can't be trusted (see the allowlist in worlds.js).
async function openSave(bytes) {
  const save = await readSaveFile(bytes)
  const world = resolveWorld(save.meta.world ?? null)
  return { save, world, state: await save.state() }
}

// The saved session for a world, or null. Reads only this world's slot, so a rebuilt
// local image (a different world id) simply has nothing here.
//
// Returns `{ readOnly: true }` when a slot exists but this build can't parse it. That
// case must never fall through to "no session", because the autosave two minutes later
// would overwrite a save we merely failed to understand — a stale cached build or a
// rolled-back deploy would destroy someone's machine instead of just not opening it.
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

  // Migrate the pre-container slot, once. It was tagged with the v1 image id and
  // records no fingerprint, so only the world it was actually captured against may
  // adopt it — a dev world is a rebuilt image and must not.
  try {
    const legacy = await idbGet(LEGACY_KEY)
    if (
      legacy?.gz &&
      legacy.imageId === LEGACY_IMAGE_ID &&
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

// The v1 world, whether it came from the registry or a dev rewrite of it.
const isLegacyWorld = (world) => world.id === LEGACY_IMAGE_ID

// GitHub's web URLs (github.com/…/raw/… and /blob/…) 302-redirect to
// raw.githubusercontent.com, and the *redirect* response carries no CORS header — so a
// cross-origin fetch dies on the hop before it ever reaches the (CORS-enabled) raw
// host. Rewrite straight to the raw host so we skip the redirect entirely. Any other
// URL is returned untouched.
function normalizeShareUrl(url) {
  const m = url.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:raw|blob)\/(.+?)(?:\?.*)?$/
  )
  if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`
  return url
}

// Fetch a shared machine by URL. Accepts a container or any legacy v1 artifact — every
// `?share=` link published so far is a bare gzipped state, and those must keep working
// unchanged, so a file with no world recorded resolves to the legacy world.
export async function fetchSharedSave(url) {
  const resp = await fetch(normalizeShareUrl(url))
  if (!resp.ok) throw new Error(`fetch failed (${resp.status})`)
  return openSave(new Uint8Array(await resp.arrayBuffer()))
}

// --- writing --------------------------------------------------------------------

const MAX_PROVENANCE = 20

// Append one entry per restore (not per save), so the chain records how this file
// descends from earlier ones without growing on every autosave.
function nextProvenance(prior, world, instanceId) {
  const chain = Array.isArray(prior?.provenance) ? [...prior.provenance] : []
  const last = chain[chain.length - 1]
  if (last?.instanceId === instanceId) return chain
  chain.push({
    instanceId,
    world: world.id,
    at: Date.now(),
    parent: last?.instanceId ?? null,
  })
  return chain.slice(-MAX_PROVENANCE)
}

// Build the container bytes for the running machine.
//
// `prior` is the save this session was booted from (if any); its metadata and any
// chunks we don't generate ourselves are carried through untouched, which is what lets
// a future build add sections without this one destroying them.
async function packSession(
  emulator,
  { world, prior = null, hb = null, thumb = null, instanceId, tracking = {} }
) {
  const state = new Uint8Array(await emulator.save_state())
  const priorMeta = prior?.meta ?? {}
  const generated = new Set(['state'])

  const chunks = [{ id: 'state', bytes: state }]

  // The tracking log, sealed and countersigned by the time it gets here (see
  // daemon/sealed.js). One chunk per instance, never rewritten by anyone else: one saved
  // machine can be restored many times, and each fork appending to a shared chunk is how
  // logs get silently clobbered or double-counted.
  if (hb?.body?.length) {
    const id = `hb/${instanceId}`
    generated.add(id)
    chunks.push({
      id,
      bytes: hb.body,
      codec: 'raw', // already gzipped, then encrypted; gzip again would only add bytes
      // Hash it: this is the chunk whose integrity someone may have to argue about months
      // later, and the signature covers exactly this hash. The 65 MB state stays unhashed
      // because that cost would land on every autosave.
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

  // Verbatim pass-through of everything else the loaded file had.
  if (prior && !prior.legacy)
    for (const entry of prior.chunks)
      if (!generated.has(entry.id))
        chunks.push({
          id: entry.id,
          stored: prior.storedChunk(entry.id),
          entry,
        })

  // Drop the prior chunk table (rebuilt below) and the legacy marker (a container is
  // not a legacy artifact); keep every other key, including ones we don't know.
  const { chunks: _table, legacy: _legacy, ...carriedMeta } = priorMeta
  return packSaveFile({
    meta: {
      ...carriedMeta,
      updatedAt: Date.now(),
      world: worldDescriptor(world),
      tracking: { ...(priorMeta.tracking || {}), ...tracking, instanceId },
      provenance: nextProvenance(priorMeta, world, instanceId),
    },
    chunks,
  })
}

// Raised when the slot moved on underneath us — another tab saved since we loaded.
export class StaleSaveError extends Error {
  constructor(message) {
    super(message)
    this.name = 'StaleSaveError'
  }
}

// Store bytes for a world, index it, and prune, all in one transaction.
//
// `expectGen` is a compare-and-swap. Each tab holds its own in-memory `prior`, so
// without this, two tabs on the same machine (or the same save restored twice, which the
// daemon design explicitly expects) take turns writing containers derived from stale
// metadata, and each one silently discards the other's chunks and provenance. Pass null
// to overwrite deliberately.
async function writeSlot(worldId, label, bytes, expectGen) {
  return withStore('readwrite', async (store, req) => {
    const existing = await req(store.get(slotKey(worldId)))
    const currentGen = existing?.gen ?? 0
    if (expectGen != null && currentGen !== expectGen)
      throw new StaleSaveError(
        `this machine was saved elsewhere (generation ${currentGen}, expected ` +
          `${expectGen}) — reload to pick up the newer save`
      )
    const gen = currentGen + 1
    store.put({ v: 2, worldId, bytes, at: Date.now(), gen }, slotKey(worldId))

    // Index first, then prune what the index no longer keeps: if anything goes wrong
    // the index under-promises rather than pointing at records that are gone.
    const index = toIndex(await req(store.get(INDEX_KEY)))
    index.set(worldId, { at: Date.now(), label })
    const kept = new Map(
      [...index]
        .sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0))
        .slice(0, MAX_SLOTS)
    )
    store.put(kept, INDEX_KEY)
    for (const key of await slotKeysIn(store, req)) {
      const id = key.slice('world:'.length)
      if (!kept.has(id)) store.delete(key)
    }
    return gen
  })
}

// Capture, pack and store the running session.
//
// Returns `{ size, save, gen }`, and the caller MUST feed `save` and `gen` back into the
// next call. "Prior" means the newest version of this file, not the one the page booted
// from: keep passing the boot-time save and every write re-derives from stale metadata,
// minting a new file id and dropping chunks that only existed in the stored copy (a
// thumbnail today, the heartbeat log once the daemon lands).
export async function saveSession(emulator, opts) {
  const bytes = await packSession(emulator, opts)
  const gen = await writeSlot(
    opts.world.id,
    opts.world.label,
    bytes,
    opts.expectGen
  )
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

// Download the running session as a file — the same artifact a `?share=` URL points at.
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

// Read an imported file WITHOUT writing anything, and report what storing it would
// replace. Reading first is what lets the caller name the machine being destroyed (and
// the right world — a file may belong to a different one than the page is running)
// before the user commits to it.
export async function readImport(file, runningWorld) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const { save, world, state } = await openSave(bytes)
  const index = toIndex(await idbGet(INDEX_KEY))
  return {
    save,
    world,
    state,
    bytes,
    needsReload: world.id !== runningWorld.id,
    replaces: index.get(world.id) ?? null, // { at, label } or null
  }
}

// Commit a previously read import into its own world's slot. Deliberate overwrite: the
// user has been shown what it replaces.
export const storeImport = ({ world, bytes }) =>
  writeSlot(world.id, world.label, bytes, null)
