// node --test emulator/daemon/frame.test.mjs
//
// The decoder's job is to find real frames in a byte stream that may start mid-frame, may
// contain the sync word inside payloads, and may be corrupt. So most of this file is
// adversarial rather than round-trip.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  encode,
  decode,
  createDecoder,
  encodeFields,
  decodeFields,
  fieldText,
  fieldInt,
  crc32,
  withFields,
  TYPES,
  TYPE_NAMES,
  SYNC,
  HEADER_SIZE,
  MAX_PAYLOAD,
} from './frame.js'

const text = (frame) => decodeFields(frame.payload).map(fieldText)

// --- fields ---------------------------------------------------------------------

test('field lists round trip, including the characters that break text protocols', () => {
  const nasty = 'C:\\My Documents\\a\tb\nc"d\'e\\ - EditPlus'
  const fields = ['win', nasty, '', '42']
  const decoded = decodeFields(encodeFields(fields)).map(fieldText)
  assert.deepEqual(decoded, fields)
})

test('field lists carry raw bytes untouched', () => {
  const raw = Uint8Array.from({ length: 256 }, (_, i) => i)
  const [back] = decodeFields(encodeFields([raw]))
  assert.deepEqual(back, raw)
})

test('malformed field lists decode to null rather than throwing', () => {
  assert.equal(decodeFields(new Uint8Array(0)), null)
  assert.equal(
    decodeFields(Uint8Array.of(3, 0, 0)),
    null,
    'claims 3 fields, has 1'
  )
  assert.equal(
    decodeFields(Uint8Array.of(1, 10, 0, 1, 2)),
    null,
    'length past end'
  )
  assert.equal(
    decodeFields(Uint8Array.of(1, 1, 0, 65, 66)),
    null,
    'trailing byte means we misread it'
  )
})

test('fieldInt only accepts clean integers', () => {
  const int = (s) => fieldInt(new TextEncoder().encode(s))
  assert.equal(int('0'), 0)
  assert.equal(int('123'), 123)
  assert.equal(int('-7'), -7)
  for (const bad of [
    '',
    ' 1',
    '1 ',
    '1.5',
    '0x10',
    'NaN',
    'Infinity',
    '1e3',
    '+1',
  ])
    assert.equal(int(bad), null, bad)
})

// --- frames ---------------------------------------------------------------------

test('a frame round trips', () => {
  const bytes = encode(TYPES.EVENT, ['win', 'EDITPLUS.EXE'])
  const { frames, rest, dropped } = decode(bytes)
  assert.equal(frames.length, 1)
  assert.equal(frames[0].type, TYPES.EVENT)
  assert.deepEqual(text(frames[0]), ['win', 'EDITPLUS.EXE'])
  assert.equal(rest.length, 0)
  assert.equal(dropped, 0)
})

test('several frames in one arrival', () => {
  const buf = new Uint8Array([
    ...encode(TYPES.PING, ['1', '2']),
    ...encode(TYPES.PONG, ['1', '2']),
    ...encode(TYPES.RESET, []),
  ])
  const { frames, rest } = decode(buf)
  assert.deepEqual(
    frames.map((f) => TYPE_NAMES[f.type]),
    ['PING', 'PONG', 'RESET']
  )
  assert.equal(rest.length, 0)
})

test('garbage before a frame is dropped and the frame is still found', () => {
  const junk = Uint8Array.from([0, 1, 2, 0x39, 0x39, 0xff, 0xff, 3, 4])
  const good = encode(TYPES.IDENT, ['7', 'parent'])
  const { frames, dropped } = decode(new Uint8Array([...junk, ...good]))
  assert.equal(frames.length, 1)
  assert.deepEqual(text(frames[0]), ['7', 'parent'])
  assert.ok(dropped >= junk.length)
})

test('a sync word inside a payload does not confuse the decoder', () => {
  // '99' is a legitimate substring of plenty of real titles.
  const frame = encode(TYPES.EVENT, ['win', 'like-its-1999 - EditPlus'])
  const { frames } = decode(frame)
  assert.equal(frames.length, 1)
  assert.deepEqual(text(frames[0]), ['win', 'like-its-1999 - EditPlus'])
})

test('a truncated tail is kept for next time, not dropped', () => {
  const frame = encode(TYPES.PING, ['1', '9'])
  const cut = frame.length - 3
  const { frames, rest } = decode(frame.subarray(0, cut))
  assert.equal(frames.length, 0)
  assert.equal(rest.length, cut, 'the whole partial frame is retained')
})

test('a bad CRC drops the frame', () => {
  const frame = encode(TYPES.PING, ['1', '9'])
  frame[frame.length - 1] ^= 0xff
  const { frames, dropped } = decode(frame)
  assert.equal(frames.length, 0)
  assert.ok(dropped > 0)
})

test('a corrupted payload is caught by the CRC', () => {
  const frame = encode(TYPES.EVENT, ['win', 'EDITPLUS.EXE'])
  frame[HEADER_SIZE + 5] ^= 0x01
  assert.equal(decode(frame).frames.length, 0)
})

test('a set flag bit makes a frame skippable', () => {
  // Rule 2: all flags are reserved, so an old reader must skip rather than misread.
  const frame = encode(TYPES.PING, ['1', '9'])
  frame[3] = 0x01
  assert.equal(decode(frame).frames.length, 0)
})

test('an oversize length is rejected without buffering', () => {
  const header = new Uint8Array(HEADER_SIZE)
  header.set(SYNC, 0)
  header[2] = TYPES.PING
  new DataView(header.buffer).setUint32(4, MAX_PAYLOAD + 1, true)
  const { frames, rest } = decode(header)
  assert.equal(frames.length, 0)
  assert.ok(rest.length < HEADER_SIZE, 'did not sit waiting for a bogus length')
  // Raw payload trips the frame cap; a single huge field trips the field cap first.
  assert.throws(
    () => encode(TYPES.PAYLOAD_DATA, new Uint8Array(MAX_PAYLOAD + 1)),
    /payload too large/
  )
  assert.throws(
    () => encode(TYPES.PAYLOAD_DATA, [new Uint8Array(MAX_PAYLOAD + 1)]),
    /field too long/
  )
})

test('type 0 is not a frame', () => {
  const frame = encode(TYPES.PING, [])
  frame[2] = 0
  assert.equal(decode(frame).frames.length, 0)
})

test('a maximum-size payload is accepted', () => {
  const big = new Uint8Array(MAX_PAYLOAD - 3) // 3 bytes of field header
  big.fill(0x39) // all sync words, to be awkward
  const frame = encode(TYPES.PAYLOAD_DATA, [big])
  const { frames } = decode(frame)
  assert.equal(frames.length, 1)
  assert.deepEqual(decodeFields(frames[0].payload)[0], big)
})

test('withFields returns null for a payload that is not a field list', () => {
  const raw = encode(TYPES.PAYLOAD_DATA, Uint8Array.of(1, 2, 3))
  const [frame] = decode(raw).frames
  assert.equal(withFields(frame), null)
})

// --- streaming decoder ----------------------------------------------------------

test('the streaming decoder reassembles frames split byte by byte', () => {
  const dec = createDecoder()
  const buf = new Uint8Array([
    ...encode(TYPES.ANNOUNCE, ['9', '1', 'abc']),
    ...encode(TYPES.EVENT, ['win', 'x']),
  ])
  const got = []
  for (const b of buf) got.push(...dec.push(Uint8Array.of(b)))
  assert.deepEqual(
    got.map((f) => TYPE_NAMES[f.type]),
    ['ANNOUNCE', 'EVENT']
  )
  assert.equal(dec.pending, 0)
})

test('the streaming decoder survives a mid-frame restore', () => {
  // Exactly what a v86 snapshot does: the queued tail of an old frame arrives first,
  // ahead of whatever the new page sends.
  const orphan = encode(TYPES.REPLY, ['1', '5', 'ok']).subarray(0, 6)
  const dec = createDecoder()
  assert.deepEqual(dec.push(orphan), [])
  const frames = dec.push(encode(TYPES.IDENT, ['2', 'parent']))
  assert.equal(frames.length, 1)
  assert.equal(frames[0].type, TYPES.IDENT)
  assert.ok(dec.droppedBytes > 0)
})

test('the streaming decoder refuses to grow without bound on garbage', () => {
  const dec = createDecoder({ maxBuffer: 1024 })
  // A sync word followed by a plausible length, then never enough bytes.
  const tease = new Uint8Array(HEADER_SIZE)
  tease.set(SYNC, 0)
  tease[2] = TYPES.PING
  new DataView(tease.buffer).setUint32(4, 4096, true)
  for (let i = 0; i < 20; i++) dec.push(tease)
  assert.ok(dec.pending <= 1024)
})

test('reset clears a partial frame', () => {
  const dec = createDecoder()
  dec.push(encode(TYPES.PING, ['1', '1']).subarray(0, 5))
  assert.ok(dec.pending > 0)
  dec.reset()
  assert.equal(dec.pending, 0)
})

// --- constants ------------------------------------------------------------------

test('crc32 matches known values', () => {
  assert.equal(crc32(new TextEncoder().encode('')), 0)
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926)
  assert.equal(
    crc32(new TextEncoder().encode('The quick brown fox')),
    0xb74574de
  )
})
