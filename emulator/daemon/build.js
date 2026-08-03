// The child binary the host wants the guest to run.
//
// Built by scripts/build-daemon.sh and committed under bin/, because the image build is
// offline and a fresh clone should be able to deploy without a cross-compiler. Vite emits
// it as a hashed asset (vite.config.js already treats *.bin as an asset), so it is fetched
// rather than inlined.
//
// The hash is computed from the bytes rather than written down: it is the identity the
// parent stores the file under and the thing the host compares against what is already
// running, so deriving it removes any chance of the two disagreeing.
//
// A build without the binary is a normal state, not an error. Every world shipped so far
// has no agent at all, and the page must stay healthy: the link still runs, still counts
// input, and simply reports `absent`.

import childUrl from './bin/child.bin?url'
import { sha256hex } from '../savefile.js'

let cached = null

export async function loadDaemon() {
  if (cached) return cached
  try {
    const resp = await fetch(childUrl)
    if (!resp.ok) throw new Error(`fetch failed (${resp.status})`)
    const bytes = new Uint8Array(await resp.arrayBuffer())
    if (!bytes.length) throw new Error('empty')
    // 32 hex characters is plenty to identify a build and keeps the cache filename short
    // enough for a FAT volume.
    cached = { hash: (await sha256hex(bytes)).slice(0, 32), bytes }
  } catch (e) {
    console.warn('no in-guest agent in this build:', e.message)
    cached = { hash: '', bytes: null }
  }
  return cached
}
