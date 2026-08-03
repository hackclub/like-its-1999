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

// How many *local rebuild* worlds to keep. A dev session regenerates these constantly and
// each is tens of megabytes; registered worlds are never pruned, because one of those is a
// participant's machine and nothing here is entitled to decide it is stale.
export const MAX_DEV_SLOTS = 3

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
      // The generation as of that write, so an import can compare-and-swap without
      // loading the multi-megabyte record just to read one number.
      gen: meta?.gen ?? null,
    }))
    .sort((a, b) => b.at - a.at)
}

// --- reading --------------------------------------------------------------------

// Open a save from raw bytes: container or legacy artifact, plus its resolved world.
// Throws if the world can't be trusted (see the allowlist in worlds.js).
async function openSave(bytes) {
  const save = await readSaveFile(bytes)
  const world = resolveWorld(save.meta.world ?? null)
  // Only checks a world this build does not know: the registry pins its own sizes and a dev
  // world measures them. An unregistered descriptor could otherwise claim any in-range size
  // for a real object and have v86 read past the end of it all session.
  await verifyDiskSizes(world)
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

// The v1 world, whether it came from the registry or a dev rewrite of it.
const isLegacyWorld = (world) => world.id === LEGACY_WORLD_ID

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
// A ceiling on a shared machine. A save is around 13 MB and the biggest plausible one is a
// few times that; a `?share=` URL is an arbitrary host, so reading it unbounded lets any
// link decide how much memory this tab uses. Content-Length is not enough on its own — it is
// the sender's claim — so the stream is counted as it arrives.
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

export async function fetchSharedSave(url) {
  return openSave(await fetchBounded(normalizeShareUrl(url), MAX_SHARE_BYTES))
}

// --- writing --------------------------------------------------------------------

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
// `expectGen` is a compare-and-swap, and it has three values, enforced HERE rather than
// trusted from the caller:
//
//   a number    "I read this generation" — must still match
//   undefined   "I never looked", which is a claim that nothing is stored, so it is
//               checked against generation 0 rather than waved through
//   null        "overwrite deliberately", the only value that skips the check
//
// Each tab holds its own in-memory `prior`, so without this two tabs on one machine take
// turns writing containers derived from stale metadata, each silently discarding the
// other's chunks. Treating undefined as "no claim" was how a caller could destroy another
// tab's save by simply forgetting an argument.
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

    // Index first, then prune what the index no longer keeps: if anything goes wrong
    // the index under-promises rather than pointing at records that are gone.
    const index = toIndex(await req(store.get(INDEX_KEY)))
    index.set(worldId, { at: Date.now(), label, gen })
    // Prune only local rebuild worlds. Recency across everything would eventually delete a
    // participant's real machine to make room for a dev image, and those are not remotely
    // the same thing: a dev slot is regenerated by rebuilding, a registered one is somebody's
    // week of work.
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
    // The pre-container slot has now been superseded by a real one for the world it was
    // captured against. Leaving it there kept a second copy of a multi-megabyte save alive
    // and let the stale original come back if this slot were ever pruned.
    if (worldId === LEGACY_WORLD_ID) store.delete(LEGACY_KEY)
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
// Ask the browser not to evict us, once. Saves are the deliverable: a machine quietly
// evicted under storage pressure is indistinguishable from one that was never saved. Best
// effort by design — Firefox prompts, Safari decides for itself, and a refusal is not a
// reason to fail a save.
let persistenceAsked = false
async function askForPersistence() {
  if (persistenceAsked) return
  persistenceAsked = true
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted()))
      await navigator.storage.persist()
  } catch {}
}

// Storage full is the one save failure a user can actually act on, so it says what to do
// rather than surfacing a DOMException name.
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
  const slot = index.get(world.id) ?? null
  return {
    save,
    world,
    state,
    bytes,
    needsReload: world.id !== runningWorld.id,
    replaces: slot, // { at, label, gen } or null
    // What the user is being shown, so the write can refuse if it changed while they were
    // deciding. Undefined for a slot the index has never seen, which writeSlot checks
    // against generation 0.
    gen: slot?.gen ?? undefined,
  }
}

// Commit a previously read import into its own world's slot.
//
// The user has been shown what this replaces, so it is deliberate — but deliberate about
// the machine they were *told* about. If another tab saved in between, that consent does not
// cover the newer machine, so this still compares and swaps and raises StaleSaveError.
export const storeImport = ({ world, bytes, gen }) =>
  writeSlot(world.id, world.label, bytes, gen)
