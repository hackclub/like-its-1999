// A minimal, dependency-free ISO9660 (Level 1) writer — enough to hand v86 a
// mountable CD-ROM image (see ../image-import.js and the preset-CD picker in
// main.js). No Joliet/Rock Ridge, no subdirectories: plain 8.3 uppercase names in a
// single flat root directory, which every CDFS driver back to Windows 95 reads
// without extra IFS layers. That's the only shape this project needs; extending it
// to subdirectories would mean a real path table (this one only ever has one entry).
//
// Reference: ECMA-119 / ISO 9660:1988. Directory record + path table layouts below
// cite section numbers from that spec.

const SECTOR = 2048
const enc = new TextEncoder()

function u16le(n) {
  return [n & 0xff, (n >> 8) & 0xff]
}
function u16be(n) {
  return [(n >> 8) & 0xff, n & 0xff]
}
function u32le(n) {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]
}
function u32be(n) {
  return [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}
// Numeric fields in the PVD/directory records are stored in *both* byte orders
// back-to-back (ECMA-119 7.2/7.3) so readers of either endianness can parse them.
const both16 = (n) => [...u16le(n), ...u16be(n)]
const both32 = (n) => [...u32le(n), ...u32be(n)]

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let pos = 0
  for (const c of chunks) {
    out.set(c, pos)
    pos += c.length
  }
  return out
}

function sectorPad(bytes) {
  const rem = bytes.length % SECTOR
  return rem === 0 ? bytes : concat([bytes, new Uint8Array(SECTOR - rem)])
}

function strField(str, len) {
  const out = new Uint8Array(len).fill(0x20) // space-padded (ECMA-119 a1/d1 fields)
  out.set(enc.encode(str.slice(0, len)), 0)
  return out
}

// 17-byte digit-string date/time (ECMA-119 8.4.26.1).
function pvdDateTime(d) {
  const p2 = (n) => String(n).padStart(2, '0')
  const digits =
    String(d.getUTCFullYear()).padStart(4, '0') +
    p2(d.getUTCMonth() + 1) +
    p2(d.getUTCDate()) +
    p2(d.getUTCHours()) +
    p2(d.getUTCMinutes()) +
    p2(d.getUTCSeconds()) +
    '00' // hundredths of a second, unused
  return concat([enc.encode(digits), new Uint8Array([0])]) // + GMT offset byte
}
function unspecifiedDateTime() {
  return concat([new Uint8Array(16).fill(0x30), new Uint8Array([0])])
}

// 7-byte binary date/time used inside directory records (ECMA-119 9.1.5).
function dirDateTime(d) {
  return new Uint8Array([
    d.getUTCFullYear() - 1900,
    d.getUTCMonth() + 1,
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    0, // GMT offset
  ])
}

// One directory record (ECMA-119 9.1). `nameStr` is '\0'/'\x01' for the self/parent
// pseudo-entries, or an "8.3;1"-style identifier for a real file.
function dirRecord({ nameStr, isDir, lba, length, date }) {
  const nameBytes = enc.encode(nameStr)
  const bytes = [
    0, // length — patched in below once known
    0, // extended attribute record length
    ...both32(lba),
    ...both32(length),
    ...dirDateTime(date),
    isDir ? 0x02 : 0x00, // file flags
    0, // file unit size
    0, // interleave gap size
    ...both16(1), // volume sequence number
    nameBytes.length,
    ...nameBytes,
  ]
  if (bytes.length % 2 !== 0) bytes.push(0) // records must end on an even boundary
  bytes[0] = bytes.length
  return new Uint8Array(bytes)
}

// One path table entry (ECMA-119 9.4). This writer only ever has a root entry.
function pathTableRecord({ order, lba }) {
  const nameBytes = new Uint8Array([0]) // root identifier
  const u32 = order === 'L' ? u32le : u32be
  const u16 = order === 'L' ? u16le : u16be
  const bytes = [
    nameBytes.length,
    0, // extended attribute record length
    ...u32(lba),
    ...u16(1), // parent directory number (root's own path table index)
    ...nameBytes,
  ]
  if (bytes.length % 2 !== 0) bytes.push(0)
  return new Uint8Array(bytes)
}

// Coerce an arbitrary filename into a Level-1-legal "8.3;1" identifier. Defense in
// depth, not a security boundary — callers (image-import.js) already dedupe/sanitize
// before we get here, but a broken/oversized name should degrade gracefully, not
// produce a corrupt image.
function isoFileName(name) {
  const dot = name.lastIndexOf('.')
  const rawBase = dot === -1 ? name : name.slice(0, dot)
  const rawExt = dot === -1 ? '' : name.slice(dot + 1)
  const clean = (s) => s.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
  const base = clean(rawBase).slice(0, 8) || 'FILE'
  const ext = clean(rawExt).slice(0, 3)
  return (ext ? `${base}.${ext}` : base) + ';1'
}

// Build a flat, single-directory ISO9660 image.
// `files`: [{ name: string, data: Uint8Array }, ...] — at least one entry required.
export function buildIso9660({
  volumeLabel = 'DATA',
  files,
  date = new Date(),
}) {
  if (!files?.length) throw new Error('buildIso9660: no files given')

  const label = volumeLabel
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .slice(0, 32)
  const sorted = [...files]
    .map((f) => ({ name: isoFileName(f.name), data: f.data }))
    .sort((a, b) => a.name.localeCompare(b.name))

  // Fixed header layout: 16 reserved sectors, PVD, terminator, then one sector each
  // for the (tiny, root-only) L- and M-order path tables.
  const pathTableLLBA = 18
  const pathTableMLBA = 19
  const rootLBA = 20

  const ptLUnpadded = pathTableRecord({ order: 'L', lba: rootLBA })
  const ptMUnpadded = pathTableRecord({ order: 'M', lba: rootLBA })
  const pathTableBytes = ptLUnpadded.length // same length in both orders

  // Root directory content: self + parent + one record per file. The self/parent
  // records need the directory's own (sector-rounded) length, which we only know
  // after summing everything else — compute unpadded size first, then pad, then
  // build the final self/parent records with that padded length.
  const fileDataSizes = sorted.map((f) => f.data.length)
  const selfParentLen = 34 * 2
  const fileRecordLens = sorted.map(
    (f) =>
      dirRecord({ nameStr: f.name, isDir: false, lba: 0, length: 0, date })
        .length
  )
  const rootDirUnpaddedLen =
    selfParentLen + fileRecordLens.reduce((a, b) => a + b, 0)
  const rootDirSectors = Math.ceil(rootDirUnpaddedLen / SECTOR)
  const rootDirBytes = rootDirSectors * SECTOR

  // Lay out file data after the root directory, sector-aligned per file.
  let lba = rootLBA + rootDirSectors
  const fileLBAs = []
  for (const size of fileDataSizes) {
    fileLBAs.push(lba)
    lba += Math.ceil(size / SECTOR) || 1
  }
  const totalSectors = lba

  const rootRecord = dirRecord({
    nameStr: '\0',
    isDir: true,
    lba: rootLBA,
    length: rootDirBytes,
    date,
  })
  const parentRecord = dirRecord({
    nameStr: '\x01',
    isDir: true,
    lba: rootLBA,
    length: rootDirBytes,
    date,
  })

  const rootDirContent = concat([
    rootRecord,
    parentRecord,
    ...sorted.map((f, i) =>
      dirRecord({
        nameStr: f.name,
        isDir: false,
        lba: fileLBAs[i],
        length: f.data.length,
        date,
      })
    ),
  ])

  const pvd = new Uint8Array(SECTOR)
  pvd[0] = 1 // volume descriptor type: primary
  pvd.set(enc.encode('CD001'), 1)
  pvd[6] = 1 // version
  pvd.set(strField('', 32), 8) // system identifier
  pvd.set(strField(label, 32), 40) // volume identifier
  pvd.set(new Uint8Array(both32(totalSectors)), 80) // volume space size
  pvd.set(new Uint8Array(both16(1)), 120) // volume set size
  pvd.set(new Uint8Array(both16(1)), 124) // volume sequence number
  pvd.set(new Uint8Array(both16(SECTOR)), 128) // logical block size
  pvd.set(new Uint8Array(both32(pathTableBytes)), 132)
  pvd.set(new Uint8Array(u32le(pathTableLLBA)), 140)
  pvd.set(new Uint8Array(u32le(0)), 144) // optional L path table: unused
  pvd.set(new Uint8Array(u32be(pathTableMLBA)), 148)
  pvd.set(new Uint8Array(u32be(0)), 152) // optional M path table: unused
  pvd.set(rootRecord, 156) // must be exactly 34 bytes
  pvd.set(strField('', 128), 190) // volume set id
  pvd.set(strField('', 128), 318) // publisher id
  pvd.set(strField('', 128), 446) // data preparer id
  pvd.set(strField('like-its-1999', 128), 574) // application id
  pvd.set(strField('', 38), 702) // copyright file id
  pvd.set(strField('', 36), 740) // abstract file id
  pvd.set(strField('', 37), 778) // bibliographic file id
  pvd.set(pvdDateTime(date), 814) // creation
  pvd.set(pvdDateTime(date), 831) // modification
  pvd.set(unspecifiedDateTime(), 848) // expiration
  pvd.set(pvdDateTime(date), 865) // effective
  pvd[882] = 1 // file structure version

  const vdst = new Uint8Array(SECTOR)
  vdst[0] = 255 // volume descriptor set terminator
  vdst.set(enc.encode('CD001'), 1)
  vdst[6] = 1

  return concat([
    new Uint8Array(16 * SECTOR), // system area (unused)
    pvd,
    vdst,
    sectorPad(ptLUnpadded),
    sectorPad(ptMUnpadded),
    sectorPad(rootDirContent),
    ...sorted.map((f) => sectorPad(f.data)),
  ])
}
