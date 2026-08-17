// a v86 state restores only against the exact disks and memory config it was captured
// with, so the image is part of a save's identity; the emulator is built from the
// resolved world rather than module constants, which is what lets a v1 share keep
// booting against v1 disks after a v2 image ships
//
// registered world ids and URLs must never be repurposed: published ?share= links are
// the Playable URL of Unified DB records and get spot-checked long after submission, so
// a rebuild is a new world at a new path prefix
//
// dev world ids carry a content fingerprint, since local images get rebuilt constantly
// at the same path; when the bytes change the id changes, so the previous save is
// recognised as stale instead of restored over disks that no longer match it
//
// a save file is untrusted input, so an embedded world descriptor is honoured only if
// its assets pass the allowlist below

import { sha256hex } from './savefile.js'

const MiB = 1024 * 1024

// every published v1 share is a bare state with no world recorded, so "no world" maps here
export const LEGACY_WORLD_ID = 'win98-checkpoint03-v1'

// v2: the same Windows 98 SE with a much wider toolkit (VB6, Visual C++ 6, Delphi 5,
// Inform 6.21, MinGW, Python, Tcl/Tk, NASM and the rest) on a 1 GiB C: and a 4 GiB D:
export const V2_WORLD_ID = 'win98-checkpoint24-v2'

// Cloudflare R2 behind a custom domain. Both worlds moved here on 2026-08-17, and the
// reason was range requests rather than tidiness: the previous host answered the first
// range against a cold object with 200 and the whole body, so one 256 KiB chunk read cost
// a full 1 GiB on v1 and would have cost 4 GiB on v2. R2 serves ranges straight from
// object storage (cf-cache-status: DYNAMIC) and returns 206 with exactly the bytes asked
// for, cold or warm.
//
// v1's bytes were mirrored from the old host, not re-uploaded from a local checkpoint, and
// verified identical: published ?share= links must keep getting the bytes they always got.
export const CDN_HOST = 'like-its-1999.hackclub-assets.com'

// dev worlds only: a registered world must never derive its URLs from an env var, or the
// day this moves to /v2/ every published v1 share would mount v2 disks under v1 RAM
const DEV_BASE = import.meta.env?.VITE_VM_BASE || '/vm/'

// pinned forever: v1's bytes must stay reachable at v1's addresses no matter what the
// current build points at, so adding a v2 world means adding an entry here, never
// editing this one
//
// a Map because world ids come out of untrusted save files, and WORLDS[id] with id
// 'toString' or 'constructor' would hand back a function from the prototype chain and
// sail straight past validation
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
  [
    V2_WORLD_ID,
    {
      id: V2_WORLD_ID,
      label: "Windows 98 SE — Like It's 1999 v2",
      // identical machine to v1 on purpose: the disks got bigger, the hardware did not
      memory: 128 * MiB,
      vgaMemory: 32 * MiB,
      uart1: false,
      disks: {
        hda: {
          url: `https://${CDN_HOST}/v2/hda.img`,
          size: 1073741824,
          chunkSize: 256 * 1024,
        },
        hdb: {
          url: `https://${CDN_HOST}/v2/hdb.img`,
          size: 4294967296,
          chunkSize: 256 * 1024,
        },
      },
      initialState: { url: `https://${CDN_HOST}/v2/snapshot.bin.zst` },
    },
  ],
])

const CURRENT_WORLD_ID = V2_WORLD_ID

// locally there is no CDN, so rewrite a registered world's pinned URLs onto the dev base
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

// world ids land in IndexedDB keys, URLs and status text, and arrive from untrusted files
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
export const isValidWorldId = (id) => typeof id === 'string' && ID_RE.test(id)

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

// assets may live only where we put them: the app's own /vm/ path, or a versioned prefix
// on the CDN, and nothing else in dev either; a save file names these URLs and the
// emulator mounts them
function assetAllowed(url, env) {
  let u
  try {
    u = new URL(url, env.origin)
  } catch {
    return false
  }
  // the checks below read the normalised path, so traversal can't sneak past them, but a
  // url that needed normalising is never one we wrote, so refuse it outright rather than
  // reasoning about what it collapsed to
  if (url.includes('..')) return false
  if (u.origin === env.origin && u.pathname.startsWith('/vm')) return true
  return (
    u.protocol === 'https:' &&
    u.host === CDN_HOST &&
    /^\/v\d+\//.test(u.pathname)
  )
}

const inRange = (n, [lo, hi]) => Number.isFinite(n) && n >= lo && n <= hi

// descriptors arrive from untrusted save files; throws with a reason
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

// what gets written into a save file, kept beside validateWorld so the two can't drift
const DESCRIPTOR_KEYS = ['id', 'label', 'memory', 'vgaMemory', 'uart1', 'disks']

export function worldDescriptor(world) {
  const desc = {}
  for (const k of DESCRIPTOR_KEYS) if (world[k] != null) desc[k] = world[k]
  if (world.initialState?.url)
    desc.initialState = { url: world.initialState.url }
  return desc
}

// a registered id wins over whatever the file says, so a moved CDN prefix is a one-line
// fix here instead of a rewrite of files in the wild
//
// resolvable: can this world be found again from its id alone after a reload? false for a
// descriptor out of a save file, since nothing but that file knows what it means, so
// storing a machine under it would put it somewhere no later load could reach
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
  // a dev world's id fingerprints the image bytes, so trusting one a file hands us would
  // reintroduce exactly what the fingerprint prevents: an old save restored over a
  // rebuilt image. only currentWorld() may mint dev worlds, by measuring
  if (isDevWorldId(id))
    throw new Error(
      `"${String(id).slice(0, 64)}" is a local build's world — it can only be opened ` +
        'on the machine that made it, against the same image'
    )
  return { ...validateWorld(desc, opts), resolvable: false }
}

// only worth doing for a world out of a save file: registered sizes are pinned beside
// their URLs and dev sizes are measured, but an unregistered descriptor can claim any
// in-range number for a real object, and v86 would then read past the end of it for the
// rest of the session
//
// a host that will not answer HEAD leaves probeAsset null and the claim stands, the same
// degradation the dev fingerprint already accepts
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

// everything else (bios, screen, wasm) is the page's business
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
  // v86 only creates COM2 when asked, and restore_state touches uart1 state only if the
  // device exists, so this flag is part of the world's identity
  if (world.uart1) config.uart1 = true
  // v86 writes its own bookkeeping into the image objects it's handed, so give it a copy
  if (initialState) config.initial_state = { ...initialState }
  return config
}

// ?fresh=1     cold boot: ignore the saved session and the shipped snapshot
// ?nosave=1    boot normally but never write to browser storage (Export still works)
// ?world=id    boot a specific world
// ?vmbase=/p/  dev only: build the dev world from a different local image directory, so
//              two locally-served images can be booted side by side without restarting
//              Vite to change VITE_VM_BASE
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
    vmbase: q.get('vmbase') || null,
  }
}

// a URL-supplied fetch base: dev only, same shape as the bases we write ourselves, and it
// still has to satisfy assetAllowed downstream like every other asset URL
function devBase(params, env) {
  const raw = params?.vmbase
  if (!raw || !env.dev) return DEV_BASE
  const base = raw.endsWith('/') ? raw : raw + '/'
  if (!base.startsWith('/vm') || base.includes('..'))
    throw new Error('vmbase must be a local path under /vm')
  return base
}

// identify a local image by what the server says about its bytes: any rebuild changes size
// or mtime, so the id changes with it and there is no constant to remember to bump
async function probeAsset(url, doFetch) {
  try {
    const resp = await doFetch(url, { method: 'HEAD' })
    if (!resp.ok) return null
    // vite answers a missing path under /vm*/ with 200 and an HTML body, not a 404, so ok
    // alone would let a missing state.bin.zst read as a snapshot that exists and then get
    // mounted as RAM. an image or a zstd snapshot is never text/html
    const type = resp.headers.get('content-type') || ''
    if (type.includes('text/html')) return null
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

// sizes and the presence of the shipped snapshot come from the server, so a freshly
// rebuilt (or differently sized, or snapshot-less) image just works
async function makeDevWorld(base, opts = {}) {
  const doFetch = opts.fetch || globalThis.fetch
  const template = WORLDS.get(CURRENT_WORLD_ID)
  const diskKeys = Object.keys(template.disks)
  const stateUrl = base + 'state.bin.zst'

  // in parallel: this is on the critical path of every local page load
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

  // restoring a snapshot older than the disks beside it would paint the previous build's
  // RAM over the disk you just rebuilt. mid-loop (disks rebuilt, snapshot not recaptured
  // yet) that is normal, so cold boot instead, and only when we can positively tell
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

  // if the server answered nothing at all (no HEAD support) the fingerprint degrades to
  // 'unknown' and staleness can't be detected
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
    initialState: stateProbe && !snapshotIsStale ? { url: stateUrl } : null,
    snapshotIsStale,
    dev: true,
    resolvable: true,
  }
}

// a dev id is honoured only when the image on disk still fingerprints to it; measuring
// rather than taking the id's word for it is what stops a rebuilt image being restored
// into, so this stays the single entry point for "which world am I"
export async function currentWorld(params = {}, opts = {}) {
  const env = envDefaults(opts)
  const forHere = (world) => ({
    ...(env.dev ? forDev(world) : world),
    resolvable: true,
  })
  const mint = () => makeDevWorld(devBase(params, env), opts)

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
