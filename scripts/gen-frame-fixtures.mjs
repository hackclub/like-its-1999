// Regenerate the committed golden frame vectors:
//
//   node scripts/gen-frame-fixtures.mjs
//
// The output is checked in, so a diff here means the wire format changed. That is a thing
// that should happen deliberately and show up in review, not quietly: every already-built
// guest binary speaks the old format.

import { writeFile } from 'node:fs/promises'
import { encode } from '../emulator/daemon/frame.js'
import { GOLDEN } from '../emulator/daemon/c/fixtures.mjs'

const parts = GOLDEN.map((f) => encode(f.type, f.fields))
const total = parts.reduce((n, p) => n + p.length, 0)
const out = new Uint8Array(total)
let at = 0
for (const p of parts) {
  out.set(p, at)
  at += p.length
}

const path = new URL(
  '../emulator/daemon/c/fixtures/frames.bin',
  import.meta.url
)
await writeFile(path, out)
console.log(`wrote ${GOLDEN.length} frames, ${out.length} bytes`)
