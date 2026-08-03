// Wire framing for the guest agent. See PROTOCOL.md for the format and the reasoning;
// this file is the whole of it, and it is pure — no I/O, no emulator, no time.
//
// The only subtle part is decoding. The byte stream is not guaranteed to start on a frame
// boundary (a v86 snapshot restores whatever was queued in the UART, mid-frame included)
// and a payload can legitimately contain the sync word, so a decoder cannot trust the
// first sync it sees. `decode` therefore treats every candidate position as a hypothesis
// and only accepts one whose length is sane and whose CRC checks out.

const SYNC0 = 0x39 // '9'
const SYNC1 = 0x39
export const SYNC = Uint8Array.of(SYNC0, SYNC1)

// Sync(2) + type(1) + flags(1) + len(4), then the payload, then crc32(4).
export const HEADER_SIZE = 8
export const TRAILER_SIZE = 4

// Normative, not advisory: a header claiming more than this is discarded rather than
// buffered, so a corrupt length can't make a receiver wait for gigabytes.
export const MAX_PAYLOAD = 65536

export const TYPES = {
  RESET: 0x01,
  ANNOUNCE: 0x02,
  IDENT: 0x03,
  PAYLOAD_BEGIN: 0x04,
  PAYLOAD_DATA: 0x05,
  PAYLOAD_END: 0x06,
  STATUS: 0x07,
  PING: 0x08,
  PONG: 0x09,
  CALL: 0x20,
  REPLY: 0x21,
  EVENT: 0x22,
}

export const TYPE_NAMES = Object.fromEntries(
  Object.entries(TYPES).map(([k, v]) => [v, k])
)

const te = new TextEncoder()
const td = new TextDecoder()

// --- CRC-32 (IEEE, the zlib polynomial) -----------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

export function crc32(bytes, start = 0, end = bytes.length) {
  let c = -1
  for (let i = start; i < end; i++)
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

// --- field lists ----------------------------------------------------------------
// count(u8), then per field: len(u16le) + bytes. No escaping, because window titles
// contain quotes, backslashes, tabs and sometimes newlines, and an escaping scheme is a
// bug farm shared between a C emitter and a JS parser.

export const MAX_FIELDS = 255
export const MAX_FIELD_BYTES = 65535

export function encodeFields(fields) {
  if (fields.length > MAX_FIELDS)
    throw new Error(`too many fields (${fields.length} > ${MAX_FIELDS})`)
  const parts = fields.map((f) =>
    f instanceof Uint8Array ? f : te.encode(f == null ? '' : String(f))
  )
  let total = 1
  for (const p of parts) {
    if (p.length > MAX_FIELD_BYTES)
      throw new Error(`field too long (${p.length} > ${MAX_FIELD_BYTES})`)
    total += 2 + p.length
  }
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  out[0] = parts.length
  let at = 1
  for (const p of parts) {
    view.setUint16(at, p.length, true)
    out.set(p, at + 2)
    at += 2 + p.length
  }
  return out
}

// Returns an array of Uint8Array fields, or null if the bytes aren't a well-formed list.
// Null rather than a throw: a malformed payload is a dropped frame, never an exception
// that unwinds a receive loop.
export function decodeFields(bytes) {
  if (bytes.length < 1) return null
  const count = bytes[0]
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = []
  let at = 1
  for (let i = 0; i < count; i++) {
    if (at + 2 > bytes.length) return null
    const len = view.getUint16(at, true)
    at += 2
    if (at + len > bytes.length) return null
    out.push(bytes.subarray(at, at + len))
    at += len
  }
  // Trailing bytes mean we misread the structure; treat it as malformed.
  return at === bytes.length ? out : null
}

export const fieldText = (f) => (f ? td.decode(f) : '')

// Decimal text in, number out. Returns null for anything that isn't a clean integer, so
// a caller can drop the frame instead of propagating NaN.
export function fieldInt(f) {
  const s = fieldText(f)
  if (!/^-?\d{1,15}$/.test(s)) return null
  return Number(s)
}

// --- frames ---------------------------------------------------------------------

export function encode(type, fields = []) {
  const payload = Array.isArray(fields) ? encodeFields(fields) : fields
  if (payload.length > MAX_PAYLOAD)
    throw new Error(`payload too large (${payload.length} > ${MAX_PAYLOAD})`)
  const out = new Uint8Array(HEADER_SIZE + payload.length + TRAILER_SIZE)
  const view = new DataView(out.buffer)
  out[0] = SYNC0
  out[1] = SYNC1
  out[2] = type
  out[3] = 0 // flags: reserved, must be zero
  view.setUint32(4, payload.length, true)
  out.set(payload, HEADER_SIZE)
  // CRC covers type+flags+len+payload — everything but the sync word, which is a marker
  // rather than data.
  view.setUint32(
    HEADER_SIZE + payload.length,
    crc32(out, 2, HEADER_SIZE + payload.length),
    true
  )
  return out
}

// Pull as many frames as possible out of `buffer`.
//
// Returns { frames, rest, dropped }: `rest` is the unconsumed tail to keep for next time,
// and `dropped` counts bytes thrown away resyncing (useful as a health signal, since a
// steady trickle means something upstream is confused).
//
// A frame is only accepted if flags are zero, the length is within the cap, and the CRC
// matches. Anything else advances one byte and looks for the next sync: that is what makes
// a false sync word inside a payload, and a mid-frame restore, both self-healing.
export function decode(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const frames = []
  let at = 0
  let dropped = 0

  while (at + HEADER_SIZE <= bytes.length) {
    if (bytes[at] !== SYNC0 || bytes[at + 1] !== SYNC1) {
      at++
      dropped++
      continue
    }
    const type = bytes[at + 2]
    const flags = bytes[at + 3]
    const len = view.getUint32(at + 4, true)

    // Reject before buffering: a bogus length must not make us wait for more bytes.
    if (flags !== 0 || len > MAX_PAYLOAD || type === 0) {
      at++
      dropped++
      continue
    }
    const end = at + HEADER_SIZE + len + TRAILER_SIZE
    if (end > bytes.length) break // genuinely incomplete: wait for more

    const want = view.getUint32(at + HEADER_SIZE + len, true)
    if (crc32(bytes, at + 2, at + HEADER_SIZE + len) !== want) {
      at++
      dropped++
      continue
    }
    frames.push({
      type,
      payload: bytes.subarray(at + HEADER_SIZE, at + HEADER_SIZE + len),
    })
    at = end
  }

  return { frames, rest: bytes.subarray(at), dropped }
}

// A frame plus its decoded fields, or null if the payload isn't a field list. Convenience
// for callers that always expect fields (everything except PAYLOAD_DATA's raw bytes).
export function withFields(frame) {
  const fields = decodeFields(frame.payload)
  return fields ? { ...frame, fields } : null
}

// Accumulates bytes across arrivals and yields whole frames. The only stateful thing in
// this module, and the state is one buffer.
export function createDecoder({ maxBuffer = MAX_PAYLOAD * 4 } = {}) {
  let buffer = new Uint8Array(0)
  let dropped = 0
  return {
    push(chunk) {
      const incoming =
        chunk instanceof Uint8Array ? chunk : Uint8Array.of(chunk)
      const merged = new Uint8Array(buffer.length + incoming.length)
      merged.set(buffer)
      merged.set(incoming, buffer.length)
      const result = decode(merged)
      dropped += result.dropped
      buffer = result.rest
      // A partial frame can never exceed one max frame; more than that means we are
      // accumulating garbage that happens to start with a sync word.
      if (buffer.length > maxBuffer) {
        dropped += buffer.length
        buffer = new Uint8Array(0)
      }
      return result.frames
    },
    reset() {
      buffer = new Uint8Array(0)
    },
    get pending() {
      return buffer.length
    },
    get droppedBytes() {
      return dropped
    },
  }
}
