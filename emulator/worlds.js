// Worlds: which base image + machine config a save belongs to.
//
// A v86 state restores only against the exact disks and memory config it was captured
// with, so "the image" is part of a save's identity. A world bundles that identity:
// an id, the disk URLs and sizes, memory/vga sizes, whether COM2 exists, and the
// shipped instant-boot snapshot. Saves record their world (see savefile.js) and the
// emulator is built from the *resolved* world, not from module constants — which is
// what lets a v1 share keep booting against v1 disks after a v2 image ships.
//
// Two kinds of world:
//
//   - Registered (production). A fixed id string, forever. Published `?share=` links
//     are the Playable URL of Unified DB records and get spot-checked long after
//     submission, so these ids and URLs must never be repurposed. A rebuild is a NEW
//     world at a NEW path prefix; the old one stays exactly where it is.
//   - Dev (local only). Minted at runtime with a content fingerprint in the id, since
//     local images get rebuilt constantly at the same path. When the bytes change the
//     id changes, so the previous save is recognised as stale instead of being
//     restored over disks that no longer match it. Disk sizes and the presence of the
//     shipped snapshot are probed rather than hardcoded, so a rebuild of a different
//     size needs no code edit.
//
// A save file is untrusted input, so an embedded world descriptor is only honoured if
// its assets pass the allowlist below — a save must never be able to point the
// emulator at an arbitrary host.

import { sha256hex } from './savefile.js'

const MiB = 1024 * 1024

// Every published v1 share is a bare state with no world recorded, so "no world" maps
// here.
export const LEGACY_WORLD_ID = 'win98-checkpoint03-v1'

export const CDN_HOST = 'cdn.like-its-1999.jer.app'

// Where a fresh local image is served from. Only ever used for *dev* worlds: a
// registered world must never derive its URLs from an env var, or the day this moves to
// /v2/ every published v1 share would mount v2 disks under v1 RAM.
const DEV_BASE = import.meta.env?.VITE_VM_BASE || '/vm/'

// Registered worlds are PINNED, absolutely and forever. Published `?share=` links are
// the Playable URL of Unified DB records and get spot-checked long after submission, so
// v1's bytes must stay reachable at v1's addresses no matter what the current build
// points at. Adding a v2 world means adding an entry here, never editing this one.
//
// A Map, not an object: world ids come out of untrusted save files, and `WORLDS[id]`
// with id 'toString' or 'constructor' would hand back a function from the prototype
// chain and sail straight past validation.
export const WORLDS = new Map([
  [
    LEGACY_WORLD_ID,
    {
      id: LEGACY_WORLD_ID,
      label: "Windows 98 SE — Like It's 1999 v1",
      memory: 128 * MiB,
      vgaMemory: 32 * MiB, // matches the VBEMP 032MB True Color driver
      uart1: false,
      disks: {
        hda: {
          url: `https://${CDN_HOST}/v1/hda.img`,
          size: 314572800,
          chunkSize: 256 * 1024,
        },
        hdb: {
          url: `https://${CDN_HOST}/v1/hdb.img`,
          size: 1073741824,
          chunkSize: 256 * 1024,
        },
      },
      initialState: { url: `https://${CDN_HOST}/v1/state.bin.zst` },
    },
  ],
])

const CURRENT_WORLD_ID = LEGACY_WORLD_ID

// Locally there is no CDN, so rewrite a registered world's pinned URLs onto the dev
// base. Dev only: in production the pinned URLs are the whole point.
function forDev(world) {
  const swap = (url) => DEV_BASE + url.slice(url.lastIndexOf('/') + 1)
  return {
    ...world,
    disks: Object.fromEntries(
      Object.entries(world.disks).map(([k, d]) => [
        k,
        { ...d, url: swap(d.url) },
      ])
    ),
    initialState: world.initialState
      ? { url: swap(world.initialState.url) }
      : null,
  }
}

// World ids land in IndexedDB keys, URLs and status text, and arrive from untrusted
// files. Keep them boring.
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
export const isValidWorldId = (id) => typeof id === 'string' && ID_RE.test(id)

// --- allowlist ------------------------------------------------------------------

const DISK_KEYS = new Set(['hda', 'hdb', 'hdc', 'fda'])
const LIMITS = {
  memory: [16 * MiB, 512 * MiB],
  vgaMemory: [1 * MiB, 128 * MiB],
  diskSize: [1, 8 * 1024 * MiB],
  chunkSize: [512, 4 * MiB],
}

function envDefaults(opts = {}) {
  return {
    dev: opts.dev ?? import.meta.env?.DEV ?? false,
    origin:
      opts.origin ??
      (typeof location !== 'undefined' ? location.origin : 'http://localhost'),
  }
}

// Assets may live only in the two places we put them: the app's own /vm/ path, or a
// versioned prefix on the CDN. Nothing else, in dev either — a save file names these
// URLs and the emulator mounts them.
function assetAllowed(url, env) {
  let u
  try {
    u = new URL(url, env.origin)
  } catch {
    return false
  }
  // The checks below read the *normalised* path, so traversal can't sneak past them —
  // but a url that needed normalising is never something we wrote, so refuse it
  // outright rather than reasoning about what it collapsed to.
  if (url.includes('..')) return false
  if (u.origin === env.origin && u.pathname.startsWith('/vm')) return true
  return (
    u.protocol === 'https:' &&
    u.host === CDN_HOST &&
    /^\/v\d+\//.test(u.pathname)
  )
}

const inRange = (n, [lo, hi]) => Number.isFinite(n) && n >= lo && n <= hi

// Validate a world descriptor that came out of a save file. Throws with a reason.
export function validateWorld(desc, opts = {}) {
  const env = envDefaults(opts)
  const where = desc?.id
    ? `world "${String(desc.id).slice(0, 64)}"`
    : 'world descriptor'
  if (!desc || typeof desc !== 'object')
    throw new Error('missing world descriptor')
  if (desc.id != null && !isValidWorldId(desc.id))
    throw new Error(`${where}: id is not a valid world id`)
  if (!inRange(desc.memory, LIMITS.memory))
    throw new Error(`${where}: memory ${desc.memory} out of range`)
  if (!inRange(desc.vgaMemory, LIMITS.vgaMemory))
    throw new Error(`${where}: vgaMemory ${desc.vgaMemory} out of range`)

  const disks = desc.disks || {}
  const keys = Object.keys(disks)
  if (!keys.length) throw new Error(`${where}: no disks`)
  for (const key of keys) {
    if (!DISK_KEYS.has(key)) throw new Error(`${where}: unknown disk "${key}"`)
    const d = disks[key]
    if (!d?.url) throw new Error(`${where}: disk ${key} has no url`)
    if (!assetAllowed(d.url, env))
      throw new Error(`${where}: disk ${key} url is not allowed (${d.url})`)
    if (!inRange(d.size, LIMITS.diskSize))
      throw new Error(`${where}: disk ${key} size ${d.size} out of range`)
    if (d.chunkSize != null && !inRange(d.chunkSize, LIMITS.chunkSize))
      throw new Error(
        `${where}: disk ${key} chunkSize ${d.chunkSize} out of range`
      )
  }
  if (desc.initialState?.url && !assetAllowed(desc.initialState.url, env))
    throw new Error(`${where}: initialState url is not allowed`)

  return {
    id: desc.id || 'unregistered',
    label: desc.label || desc.id || 'unregistered world',
    memory: desc.memory,
    vgaMemory: desc.vgaMemory,
    uart1: !!desc.uart1,
    disks: Object.fromEntries(
      keys.map((k) => [
        k,
        {
          url: disks[k].url,
          size: disks[k].size,
          chunkSize: disks[k].chunkSize || 256 * 1024,
        },
      ])
    ),
    initialState: desc.initialState?.url
      ? { url: desc.initialState.url }
      : null,
  }
}

// What gets written into a save file: the mirror image of validateWorld above, kept
// beside it on purpose so the two can't drift apart.
const DESCRIPTOR_KEYS = ['id', 'label', 'memory', 'vgaMemory', 'uart1', 'disks']

export function worldDescriptor(world) {
  const desc = {}
  for (const k of DESCRIPTOR_KEYS) if (world[k] != null) desc[k] = world[k]
  if (world.initialState?.url)
    desc.initialState = { url: world.initialState.url }
  return desc
}

// Resolve the world a save should boot in.
//   - no descriptor (legacy artifact) -> the legacy world
//   - a registered id -> the registry entry WINS over whatever the file says, so a
//     moved CDN prefix is a one-line fix here instead of a rewrite of files in the wild
//   - anything else -> validated against the allowlist, or refused
// Can this world be found again after a page reload, from its id alone? True for a
// registered world (the registry has it) and for the current local image (it can be
// re-measured). False for a validated descriptor out of a save file: nothing but that file
// knows what it means, so storing a machine under it would put it somewhere no later load
// could reach. Never written into a save — worldDescriptor copies only its own key list.
export function resolveWorld(desc, opts = {}) {
  const env = envDefaults(opts)
  const registered = (id) => {
    const world = WORLDS.get(id)
    if (!world) return null
    return { ...(env.dev ? forDev(world) : world), resolvable: true }
  }

  if (desc == null) return registered(LEGACY_WORLD_ID)
  const id = typeof desc === 'string' ? desc : desc.id
  const hit = typeof id === 'string' ? registered(id) : null
  if (hit) return hit
  if (typeof desc === 'string')
    throw new Error(
      `unknown world "${String(desc).slice(0, 64)}" (this build has no such image)`
    )
  // A dev world's id is a fingerprint of the image bytes, so trusting one a file hands
  // us would reintroduce exactly what the fingerprint prevents: an old save restored
  // over a rebuilt image. Only currentWorld() may mint dev worlds, by measuring.
  if (isDevWorldId(id))
    throw new Error(
      `"${String(id).slice(0, 64)}" is a local build's world — it can only be opened ` +
        'on the machine that made it, against the same image'
    )
  return { ...validateWorld(desc, opts), resolvable: false }
}

// Check a world's disk sizes against the objects themselves.
//
// Only worth doing for a world that came out of a save file. A registered world's sizes are
// pinned in the registry beside its URLs, and a dev world measures them, so neither can be
// wrong; an unregistered descriptor can claim any in-range number for a real object, and v86
// would then read past the end of it for the rest of the session. Cheap, because it is one
// HEAD per disk and only on the rare path.
//
// A host that will not answer HEAD is not a reason to refuse: `probeAsset` returns null and
// the claim stands, which is the same degradation the dev fingerprint already accepts.
export async function verifyDiskSizes(world, opts = {}) {
  if (world.resolvable !== false) return world
  const doFetch = opts.fetch || globalThis.fetch
  const entries = Object.entries(world.disks)
  const probes = await Promise.all(
    entries.map(([, d]) => probeAsset(d.url, doFetch))
  )
  entries.forEach(([key, d], i) => {
    const actual = probes[i]?.size
    if (actual && actual !== d.size)
      throw new Error(
        `that machine says ${key} is ${d.size} bytes, but ${d.url} is ${actual}`
      )
  })
  return world
}

// The V86 constructor options a world implies. Everything else (bios, screen, wasm)
// is the page's business.
export function worldToV86Config(world, { initialState } = {}) {
  const config = {
    memory_size: world.memory,
    vga_memory_size: world.vgaMemory,
  }
  for (const [key, d] of Object.entries(world.disks))
    config[key] = {
      url: d.url,
      size: d.size,
      async: true,
      fixed_chunk_size: d.chunkSize,
    }
  // v86 only creates COM2 when asked, and restore_state touches uart1 state only if
  // the device exists — so this flag is part of the world's identity, not a detail.
  if (world.uart1) config.uart1 = true
  // v86 writes its own bookkeeping into the image objects it's handed, so give it a copy
  // rather than the world's own initialState.
  if (initialState) config.initial_state = { ...initialState }
  return config
}

// --- URL-driven dev modes -------------------------------------------------------

// ?fresh=1   cold boot: ignore the saved session and the shipped snapshot
// ?nosave=1  boot normally but never write to browser storage (Export still works)
// ?world=id  boot a specific world
export function readModeParams(search) {
  const q = new URLSearchParams(
    search ?? (typeof location !== 'undefined' ? location.search : '')
  )
  const flag = (name) => q.has(name) && q.get(name) !== '0'
  return {
    fresh: flag('fresh'),
    nosave: flag('nosave'),
    world: q.get('world') || null,
    share: q.get('share') || null,
  }
}

// --- dev worlds -----------------------------------------------------------------

// Identify a local image by what the server says about its bytes. Any rebuild changes
// size or mtime, so the id changes with it and stale saves are caught automatically —
// no constant to remember to bump, which is the failure mode of the old IMAGE_ID.
async function probeAsset(url, doFetch) {
  try {
    const resp = await doFetch(url, { method: 'HEAD' })
    if (!resp.ok) return null
    return {
      etag: resp.headers.get('etag') || '',
      modified: resp.headers.get('last-modified') || '',
      size: Number(resp.headers.get('content-length')) || 0,
    }
  } catch {
    return null
  }
}

export const isDevWorldId = (id) =>
  typeof id === 'string' && id.startsWith('dev:')

// Build the dev world for a base URL: sizes and the presence of the shipped snapshot
// come from the server, so a freshly rebuilt (or differently sized, or snapshot-less)
// image just works.
async function makeDevWorld(base, opts = {}) {
  const doFetch = opts.fetch || globalThis.fetch
  const template = WORLDS.get(CURRENT_WORLD_ID)
  const diskKeys = Object.keys(template.disks)
  const stateUrl = base + 'state.bin.zst'

  // Probe in parallel: this is on the critical path of every local page load, for the
  // feature whose whole point is a fast rebuild loop.
  const [stateProbe, ...diskProbeList] = await Promise.all([
    probeAsset(stateUrl, doFetch),
    ...diskKeys.map((key) => probeAsset(base + key + '.img', doFetch)),
  ])

  const disks = {}
  const diskProbes = {}
  const marks = []
  diskKeys.forEach((key, i) => {
    const probe = diskProbeList[i]
    const d = template.disks[key]
    diskProbes[key] = probe
    disks[key] = {
      url: base + key + '.img',
      size: probe?.size || d.size,
      chunkSize: d.chunkSize,
    }
    marks.push(
      `${key}:${probe ? `${probe.etag}${probe.modified}${probe.size}` : '?'}`
    )
  })

  if (stateProbe) marks.push(`state:${stateProbe.etag}${stateProbe.modified}`)

  // A snapshot older than the disks it sits next to is a *stale* instant-boot image:
  // restoring it would paint the previous build's RAM over the disk you just rebuilt,
  // which is the same silent corruption the fingerprint exists to prevent. Mid-loop
  // (disks rebuilt, snapshot not recaptured yet) this is the normal state of things, so
  // cold boot instead. Only skip it when we can positively tell it's older.
  const at = (probe) => {
    const t = probe?.modified ? Date.parse(probe.modified) : NaN
    return Number.isNaN(t) ? null : t
  }
  const stateAt = at(stateProbe)
  const newestDiskAt = Object.keys(template.disks)
    .map((key) => at(diskProbes[key]))
    .reduce(
      (a, b) => (a == null || b == null ? (a ?? b) : Math.max(a, b)),
      null
    )
  const snapshotIsStale =
    stateAt != null && newestDiskAt != null && stateAt < newestDiskAt

  // An explicit revision wins; otherwise fingerprint what the server reported. If the
  // server answered nothing at all (no HEAD support) the fingerprint degrades to
  // 'unknown' and staleness can't be detected — dev only, and worth a warning.
  const rev =
    import.meta.env?.VITE_VM_REV ||
    (marks.some((m) => !m.endsWith('?'))
      ? (await sha256hex(new TextEncoder().encode(marks.join('|')))).slice(
          0,
          12
        )
      : 'unknown')

  return {
    id: `dev:${rev}`,
    label: `local image ${rev}`,
    memory: template.memory,
    vgaMemory: template.vgaMemory,
    uart1: template.uart1,
    disks,
    // No snapshot on disk, or one older than the disks: cold boot either way.
    initialState: stateProbe && !snapshotIsStale ? { url: stateUrl } : null,
    snapshotIsStale,
    dev: true,
    resolvable: true,
  }
}

// The world this page should boot: the one ?world= names, else this build's own.
//
// A dev id is honoured only when the image on disk still fingerprints to it. Measuring
// rather than taking the id's word for it is what stops a rebuilt image being restored
// into, and it's why this is the single entry point for "which world am I" — a caller
// that could bypass the measurement would reintroduce the hole.
export async function currentWorld(params = {}, opts = {}) {
  const env = envDefaults(opts)
  const forHere = (world) => ({
    ...(env.dev ? forDev(world) : world),
    resolvable: true,
  })
  const mint = () => makeDevWorld(DEV_BASE, opts)

  if (!params.world)
    return env.dev ? mint() : forHere(WORLDS.get(CURRENT_WORLD_ID))

  if (!isValidWorldId(params.world)) throw new Error('not a valid world id')
  const registered = WORLDS.get(params.world)
  if (registered) return forHere(registered)
  if (env.dev && isDevWorldId(params.world)) {
    const minted = await mint()
    if (minted.id === params.world) return minted
    throw new Error(
      `"${params.world}" was built from a different local image than the one on disk now`
    )
  }
  throw new Error(
    `unknown world "${params.world}" (this build has no such image)`
  )
}
