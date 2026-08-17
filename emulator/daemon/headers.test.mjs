// the golden vectors only pin down the parts a fixture exercises, and a type number that
// drifts between frame.js and c/frame.h is not a decode failure: it is a frame delivered
// to the wrong handler, so the numbers themselves are compared by reading the C header

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { TYPES, HEADER_SIZE, TRAILER_SIZE, MAX_PAYLOAD, SYNC } from './frame.js'
import { CHUNK_BYTES } from './agent.js'

const header = readFileSync(
  fileURLToPath(new URL('./c/frame.h', import.meta.url)),
  'utf8'
)

const defines = Object.fromEntries(
  [
    ...header.matchAll(
      /^#define\s+(F_[A-Z0-9_]+)\s+(0x[0-9a-fA-F]+|\d+)\s*(?:\/\*.*)?$/gm
    ),
  ].map(([, name, value]) => [name, Number(value)])
)

test('the C header defines every constant this test checks', () => {
  for (const name of [
    'F_SYNC0',
    'F_SYNC1',
    'F_HEADER',
    'F_TRAILER',
    'F_MAX_PAYLOAD',
    'F_FROZEN_MAX',
  ])
    assert.ok(name in defines, `${name} is missing from c/frame.h`)
})

test('framing constants agree', () => {
  assert.equal(defines.F_SYNC0, SYNC[0])
  assert.equal(defines.F_SYNC1, SYNC[1])
  assert.equal(defines.F_HEADER, HEADER_SIZE)
  assert.equal(defines.F_TRAILER, TRAILER_SIZE)
  assert.equal(defines.F_MAX_PAYLOAD, MAX_PAYLOAD)
})

test('every message type has the same number on both sides', () => {
  for (const [name, value] of Object.entries(TYPES)) {
    const key = `F_${name}`
    assert.ok(key in defines, `c/frame.h has no ${key}`)
    assert.equal(defines[key], value, `${key} disagrees with TYPES.${name}`)
  }
})

// the parent answers everything up to F_FROZEN_MAX itself and forwards the rest verbatim,
// so a type on the wrong side is either swallowed by a binary that cannot be updated or
// forwarded to a child that cannot answer
test('the frozen range holds exactly the messages the parent implements', () => {
  const parent = [
    'RESET',
    'ANNOUNCE',
    'IDENT',
    'PAYLOAD_BEGIN',
    'PAYLOAD_DATA',
    'PAYLOAD_END',
    'STATUS',
    'PING',
    'PONG',
  ]
  const child = ['CALL', 'REPLY', 'EVENT']
  for (const name of parent)
    assert.ok(
      TYPES[name] <= defines.F_FROZEN_MAX,
      `${name} must be in the frozen range`
    )
  for (const name of child)
    assert.ok(
      TYPES[name] > defines.F_FROZEN_MAX,
      `${name} must be above the frozen range`
    )
  assert.deepEqual(
    Object.keys(TYPES).sort(),
    [...parent, ...child].sort(),
    'a type was added without deciding which side of the line it lives on'
  )
})

test('a payload chunk fits in a frame', () => {
  assert.ok(CHUNK_BYTES < MAX_PAYLOAD)
})
