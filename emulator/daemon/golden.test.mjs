// node --test emulator/daemon/golden.test.mjs
//
// The wire format has two implementations — frame.js here and c/frame.c in the guest — and
// nothing stops them drifting apart except this file. Three properties:
//
//   1. The committed fixture still matches what frame.js produces today, so an accidental
//      change to the JS encoder shows up as a failing test rather than as guests that can
//      no longer be understood.
//   2. The C decodes every fixture frame and, re-encoding from what it decoded, produces
//      bytes this decoder reads back as the same frames.
//   3. Those bytes are identical to the originals, which catches disagreements the field
//      comparison would miss (header layout, CRC, integer width).
//
// The C half needs clang. Where it is missing the test says so and skips rather than
// pretending: `scripts/build-daemon.sh test` is the thing that guarantees it ran.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { encode, createDecoder, decodeFields } from './frame.js'
import { GOLDEN, sameFields } from './c/fixtures.mjs'

const here = new URL('.', import.meta.url).pathname
const fixture = join(here, 'c/fixtures/frames.bin')
const golden = join(here, 'build/test_golden')

const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const encodeAll = () => concat(GOLDEN.map((f) => encode(f.type, f.fields)))

const decodeAll = (bytes) => {
  const dec = createDecoder()
  const frames = dec.push(bytes)
  return { frames, dropped: dec.droppedBytes, pending: dec.pending }
}

test('the committed fixture still matches what frame.js produces', () => {
  assert.ok(existsSync(fixture), 'run: node scripts/gen-frame-fixtures.mjs')
  const onDisk = new Uint8Array(readFileSync(fixture))
  assert.deepEqual(
    onDisk,
    encodeAll(),
    'the wire format changed — regenerate deliberately, and remember every already-built guest speaks the old one'
  )
})

test('the fixture decodes to exactly the golden table', () => {
  const { frames, dropped, pending } = decodeAll(
    new Uint8Array(readFileSync(fixture))
  )
  assert.equal(dropped, 0, 'a clean fixture needs no resyncing')
  assert.equal(pending, 0, 'and no partial frame at the end')
  assert.equal(frames.length, GOLDEN.length)
  frames.forEach((frame, i) => {
    assert.equal(frame.type, GOLDEN[i].type, `frame ${i} type`)
    const fields = decodeFields(frame.payload)
    assert.ok(fields, `frame ${i} is a field list`)
    assert.ok(sameFields(fields, GOLDEN[i].fields), `frame ${i} fields`)
  })
})

test('the C implementation agrees byte for byte', (t) => {
  if (!existsSync(golden)) {
    t.skip('build it first: scripts/build-daemon.sh host')
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'daemon-golden-'))
  const inPath = join(dir, 'in.bin')
  const outPath = join(dir, 'out.bin')
  const original = encodeAll()
  writeFileSync(inPath, original)

  // The C decodes each frame and re-encodes it from the decoded fields.
  execFileSync(golden, [inPath, outPath], { stdio: 'pipe' })

  const returned = new Uint8Array(readFileSync(outPath))
  const { frames, dropped } = decodeAll(returned)
  assert.equal(dropped, 0, 'the C produced a clean stream')
  assert.equal(
    frames.length,
    GOLDEN.length,
    'every frame survived the round trip'
  )
  frames.forEach((frame, i) => {
    assert.equal(frame.type, GOLDEN[i].type, `frame ${i} type`)
    assert.ok(
      sameFields(decodeFields(frame.payload), GOLDEN[i].fields),
      `frame ${i}`
    )
  })

  // The strongest form: not merely equivalent, identical.
  assert.deepEqual(
    returned,
    original,
    'C and JS encode the same frames to the same bytes'
  )
})
