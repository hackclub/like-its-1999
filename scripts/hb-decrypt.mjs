// Read the tracking logs out of a save file.
//
//   HB_KEY=<base64 private key> node scripts/hb-decrypt.mjs <file.99sv> [--json]
//
// The page seals each instance's log to a public key (emulator/daemon/sealed.js) and has
// the server countersign the ciphertext hash, so this is the only way to read one. Prints
// a per-instance summary by default, or the raw NDJSON with --json.
//
// The key never lives on a server: pass it in from a password manager for the few minutes
// a review takes.

import { readFile } from 'node:fs/promises'
import { createPublicKey, verify as nodeVerify, createHash } from 'node:crypto'

import { readSaveFile } from '../emulator/savefile.js'
import { unseal, importPrivateKey } from '../emulator/daemon/sealed.js'
import { fromNdjson } from '../emulator/daemon/tracking.js'

// Committed counterpart of HB_SIGN_KEY (see scripts/hb-keys.mjs).
const SIGN_PUBLIC_KEY_B64 = ''

const [file, ...flags] = process.argv.slice(2)
const asJson = flags.includes('--json')

if (!file) {
  console.error(
    'usage: HB_KEY=<base64> node scripts/hb-decrypt.mjs <file.99sv> [--json]'
  )
  process.exit(1)
}
if (!process.env.HB_KEY) {
  console.error('HB_KEY is not set (the sealing private key, base64 PKCS8)')
  process.exit(1)
}

const gunzip = async (bytes) => {
  const { gunzipSync } = await import('node:zlib')
  return new Uint8Array(gunzipSync(bytes))
}

function verifySignature(entry, body) {
  if (!entry.sig || !entry.signedAt) return 'unsigned'
  if (!SIGN_PUBLIC_KEY_B64) return 'cannot check (no public key committed yet)'
  const sha256 = createHash('sha256').update(body).digest('hex')
  const message = Buffer.from(
    `${entry.sigKeyId || 'hb1'}|${sha256}|${entry.signedAt}`,
    'utf8'
  )
  const key = createPublicKey({
    key: Buffer.from(SIGN_PUBLIC_KEY_B64, 'base64'),
    format: 'der',
    type: 'spki',
  })
  const ok = nodeVerify(null, message, key, Buffer.from(entry.sig, 'base64'))
  return ok
    ? `valid, signed ${new Date(entry.signedAt).toISOString()}`
    : 'INVALID — the bytes do not match the signature'
}

const bytes = new Uint8Array(await readFile(file))
const save = await readSaveFile(bytes)
const priv = await importPrivateKey(process.env.HB_KEY)

const logs = save.chunks.filter((c) => c.id.startsWith('hb/'))
if (!logs.length) {
  console.error('no tracking chunks in this file')
  process.exit(1)
}

const all = []
for (const entry of logs) {
  const body = save.storedChunk(entry.id)
  const instance = entry.id.slice(3)
  console.error(`\n=== ${entry.id} ===`)
  console.error(`signature: ${verifySignature(entry, body)}`)

  let lines
  try {
    const plain = await unseal({ header: entry.seal, body }, priv)
    lines = fromNdjson(new TextDecoder().decode(await gunzip(plain)))
  } catch (e) {
    console.error(`could not open: ${e.message}`)
    continue
  }

  all.push(...lines.map((l) => ({ ...l, instance })))
  if (asJson) continue

  const spans = lines.filter((l) => l.ev === 'active')
  const byExe = new Map()
  let keys = 0
  for (const s of spans) {
    byExe.set(
      s.exe || '?',
      (byExe.get(s.exe || '?') || 0) + Math.max(0, s.t - s.from)
    )
    keys += s.keys || 0
  }
  const mins = (ms) => `${(ms / 60000).toFixed(1)}m`
  console.error(`lines: ${lines.length}, spans: ${spans.length}, keys: ${keys}`)
  for (const [exe, ms] of [...byExe].sort((a, b) => b[1] - a[1]))
    console.error(`  ${exe.padEnd(16)} ${mins(ms)}`)
  // No hours: the tally applies a policy (idle, coding vs asset, the 25% cap) and does not
  // live here.
}

if (asJson)
  console.log(
    all
      .sort((a, b) => a.t - b.t)
      .map((l) => JSON.stringify(l))
      .join('\n')
  )
