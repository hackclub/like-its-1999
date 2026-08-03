// The golden vector table: the frames both implementations must agree on, byte for byte.
//
// Shared by the generator (scripts/gen-frame-fixtures.mjs, which writes frames.bin) and
// the test (../golden.test.mjs, which checks the committed file still matches and that
// the C round-trips it). Defined once here so the two cannot drift.
//
// Cases are chosen for what could plausibly differ between a JS and a C implementation:
// empty fields, the largest field, high bytes, characters that break delimited formats,
// integer edges, and a payload containing the sync word.

export const GOLDEN = [
  { type: 0x01, fields: [] }, // RESET: no fields at all
  { type: 0x02, fields: ['e1', '1', ''] }, // ANNOUNCE with an empty trailing field
  { type: 0x03, fields: ['e1', 'parent', '1', '1.0', '', 'win,health,exec'] },
  { type: 0x07, fields: ['e1', 'child-down', 'exit 1'] },
  { type: 0x08, fields: ['e1', '0'] }, // integer zero
  { type: 0x09, fields: ['e1', '4294967295'] }, // u32 max as decimal text
  {
    type: 0x22,
    // Everything that breaks a delimited text protocol, which is why fields are
    // length-prefixed.
    fields: [
      'e1',
      'win',
      'EDITPLUS.EXE',
      'C:\\My Documents\\a\tb\nc"d\'e\\ - EditPlus',
    ],
  },
  {
    type: 0x22,
    // '99' inside a payload: a decoder that trusts the first sync word it sees breaks here.
    fields: [
      'e1',
      'win',
      'IEXPLORE.EXE',
      'like-its-1999 - Microsoft Internet Explorer',
    ],
  },
  {
    type: 0x05,
    // Raw bytes rather than text: every byte value, to catch sign-extension mistakes.
    fields: [
      'e1',
      '0',
      new Uint8Array(Array.from({ length: 256 }, (_, i) => i)),
    ],
  },
  {
    type: 0x05,
    // Exactly the maximum payload: 1 count byte + three 2-byte length prefixes + 'e1' +
    // '1' leaves 65526 bytes. Filled with sync words so a decoder that rescans inside a
    // payload has every chance to go wrong.
    fields: ['e1', '1', new Uint8Array(65526).fill(0x39)],
  },
  {
    type: 0x20,
    fields: ['e1', '1', 'exec', 'dir C:\\ /w'],
  },
  {
    type: 0x21,
    // A reply with many fields, and one that is exactly one byte.
    fields: ['e1', '7', '1', 'a', 'bb', 'ccc', '', 'eeeee'],
  },
]

// Compare two field lists, where either side may be a string or raw bytes.
export function sameFields(a, b) {
  if (a.length !== b.length) return false
  const te = new TextEncoder()
  const bytes = (f) => (f instanceof Uint8Array ? f : te.encode(f))
  for (let i = 0; i < a.length; i++) {
    const x = bytes(a[i])
    const y = bytes(b[i])
    if (x.length !== y.length) return false
    for (let j = 0; j < x.length; j++) if (x[j] !== y[j]) return false
  }
  return true
}
