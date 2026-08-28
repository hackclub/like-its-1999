// check a participant's .99sv: is the activity log intact, and where did the time go
//
//   node scripts/check-save.mjs <file.99sv>
//   HB_KEY=<base64> node scripts/check-save.mjs <file.99sv>
//
// written for someone spot-checking a submission, so it runs from a clean clone with no
// npm install and no key. the two halves are deliberately separate:
//
//   without a key   integrity only. the countersignature covers the ciphertext, so anyone
//                   can confirm the log is unedited and that our server vouched for it at
//                   a stated time, which is the part that matters for fraud
//   with the key    the same file, plus the activity summary the hour justification quotes
//
// the log stays sealed for everyone else on purpose. it holds the window titles of a whole
// Windows 98 session, meaning someone's file names and paths, and a save is a public URL

import { readFile } from 'node:fs/promises'
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

import { signedMessage } from '../api/signed-message.mjs'
import { readSaveFile } from '../emulator/savefile.js'
import { unseal, importPrivateKey } from '../emulator/daemon/sealed.js'
import { fromNdjson } from '../emulator/daemon/tracking.js'

// committed counterpart of HB_SIGN_KEY (scripts/hb-keys.mjs)
const SIGN_PUBLIC_KEY_B64 =
  'MCowBQYDK2VwAyEAhMtVECEzetNtvcFBcSW97FmikEwHU7zQEYBYrdXDdm4='

const SESSION_GAP_MS = 15 * 60 * 1000
const ASSET_CAP = 0.25
// the signature clock is the server's, the line clock is the participant's browser
const CLOCK_SKEW_S = 120

// program -> [display name, category]. only `asset` carries a rule; the rest exist to keep
// unrelated time out of it. an unlisted program is `unknown` rather than guessed at
const PROGRAMS = {
  'EDITPLUS.EXE': ['EditPlus', 'code'],
  'GVIM.EXE': ['gVim', 'code'],
  'NOTEPAD.EXE': ['Notepad', 'code'],
  'VB6.EXE': ['Visual Basic 6', 'code'],
  'MSDEV.EXE': ['Visual C++ 6', 'code'],
  'DELPHI32.EXE': ['Delphi 5', 'code'],
  'PYTHONWIN.EXE': ['Pythonwin', 'code'],
  'WISH80.EXE': ['Tcl/Tk wish', 'code'],
  'TCLSH80.EXE': ['tclsh', 'code'],
  'SQUEAK.EXE': ['Squeak', 'code'],
  'REBOL.EXE': ['REBOL/Core', 'code'],
  'MAKER.EXE': ['Game Maker', 'code'],
  'QBASIC.EXE': ['QBasic', 'code'],
  'PSP.EXE': ['Paint Shop Pro 6', 'asset'],
  'ANIMSHOP.EXE': ['Animation Shop 2', 'asset'],
  'GIFCON32.EXE': ['GIF Construction Set', 'asset'],
  'FLASH.EXE': ['Flash 4', 'asset'],
  'MSPAINT.EXE': ['MS Paint', 'asset'],
  'SNDREC32.EXE': ['Sound Recorder', 'asset'],
  'KODAKIMG.EXE': ['Imaging', 'asset'],
  'KODAKPRV.EXE': ['Imaging Preview', 'asset'],
  'CHARMAP.EXE': ['Character Map', 'asset'],
  'NETSCAPE.EXE': ['Netscape', 'test'],
  'IEXPLORE.EXE': ['Internet Explorer 5', 'test'],
  'SWFLASH.EXE': ['Flash Player', 'test'],
  'FLASHPLA.EXE': ['Flash Player', 'test'],
  'WINFROTZ.EXE': ['WinFrotz', 'test'],
  'EXPLORER.EXE': ['Windows Explorer', 'files'],
  'WINZIP32.EXE': ['WinZip', 'files'],
  'WINFILE.EXE': ['File Manager', 'files'],
  'COMMAND.COM': ['MS-DOS Prompt', 'shell'],
  'WINOLDAP.MOD': ['MS-DOS Prompt', 'shell'],
  'CONAGENT.EXE': ['MS-DOS Prompt', 'shell'],
  'WORDPAD.EXE': ['WordPad', 'other'],
  'WINAMP.EXE': ['Winamp', 'other'],
  'MPLAYER2.EXE': ['Media Player', 'other'],
  'CDPLAYER.EXE': ['CD Player', 'other'],
  'SNDVOL32.EXE': ['Volume Control', 'other'],
  'WINMINE.EXE': ['Minesweeper', 'other'],
  'SOL.EXE': ['Solitaire', 'other'],
  'FREECELL.EXE': ['FreeCell', 'other'],
  'MSHEARTS.EXE': ['Hearts', 'other'],
  'RUNDLL32.EXE': ['Control Panel applet', 'other'],
  'CONTROL.EXE': ['Control Panel', 'other'],
  'WS_FTP.EXE': ['WS_FTP LE', 'other'],
}

// longest first, so "Microsoft Internet Explorer" wins over a shorter match
const TITLE_SUFFIXES = [
  ' - Microsoft Internet Explorer',
  ' - Microsoft Visual Basic [design]',
  ' - Microsoft Visual Basic [break]',
  ' - Microsoft Visual Basic [run]',
  ' - Microsoft Visual Basic',
  ' - Microsoft Visual C++',
  ' - Paint Shop Pro',
  ' - Animation Shop',
  ' - Netscape',
  ' - WordPad',
  ' - Notepad',
]

// what a program calls itself with nothing open, so "gVim, on: VIM" doesn't get printed
const BARE_TITLES = {
  'gVim': ['VIM'],
  'EditPlus': ['EditPlus'],
  'Paint Shop Pro 6': ['Paint Shop Pro'],
  'Windows Explorer': ['Program Manager'],
  'Flash 4': ['Macromedia Flash 4', 'Macromedia Flash'],
  'Internet Explorer 5': ['Microsoft Internet Explorer'],
  'Visual Basic 6': ['Microsoft Visual Basic'],
  'Visual C++ 6': ['Microsoft Visual C++'],
  'Netscape': ['Netscape', 'Loading plugins...'],
  'WinZip': ['WinZip (Unregistered)', 'WinZip'],
}

const lookup = (exe) => {
  const key = String(exe ?? '')
    .trim()
    .toUpperCase()
  if (!key || key === '?') return { program: 'no window', category: 'unknown' }
  const hit = PROGRAMS[key]
  if (hit) return { program: hit[0], category: hit[1] }
  return { program: key.replace(/\.(EXE|COM|MOD)$/, ''), category: 'unknown' }
}

// what was on screen, said as briefly as it can be said: programs wrap the interesting part
// in "App - [C:\long\path\file.js]" or append " - Product", and the filename is the part a
// reviewer wants
function cleanTitle(win, program) {
  let t = String(win ?? '').trim()
  if (!t) return null

  const bracketed = t.match(/^.+? - \[(.+)\]$/)
  if (bracketed) t = bracketed[1].trim()

  for (const suffix of TITLE_SUFFIXES) {
    if (t.endsWith(suffix)) {
      t = t.slice(0, -suffix.length).trim()
      break
    }
  }

  // EditPlus marks an unsaved buffer with a trailing star, which would otherwise list the
  // same file twice
  t = t.replace(/\s+\*$/, '')

  // any program that puts a path in its title bar: the filename is the useful end
  if (t.includes('\\')) t = t.slice(t.lastIndexOf('\\') + 1).trim()
  t = t.replace(/\s*-\s*$/, '')

  if (!t || t === program || (BARE_TITLES[program] || []).includes(t))
    return null
  return t.length > 40 ? '…' + t.slice(-39) : t
}

const dur = (ms) => {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}
const hours = (ms) => (ms / 3600000).toFixed(2)
const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) : '0.0') + '%'
const utc = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19)
const day = (t) => new Date(t).toISOString().slice(0, 10)
const clock = (t) => new Date(t).toISOString().slice(11, 16)

const rule = (label) => {
  console.log()
  console.log(label)
  console.log('-'.repeat(label.length))
}

// ---------------------------------------------------------------- open and verify

const file = process.argv[2]
if (!file || file === '--help' || file === '-h') {
  console.log(`check a participant's .99sv save

  node scripts/check-save.mjs <file.99sv>              verify the log is intact
  HB_KEY=<base64> node scripts/check-save.mjs <file>   and summarise the activity

Verification needs no key: the countersignature is over the ciphertext, so anyone can
confirm the log was not edited and that the signing server vouched for it. Reading the
log needs the sealing private key, which is not distributed, because the log contains
the window titles of the participant's whole session.`)
  process.exit(file ? 0 : 1)
}

const bytes = new Uint8Array(await readFile(file))
const save = await readSaveFile(bytes)
const meta = save.meta || {}
const chunks = (save.chunks || []).filter((c) => c.id.startsWith('hb/'))

console.log(`check-save  ${file}`)
console.log('='.repeat(12 + file.length))
console.log(`  file size      ${(bytes.length / 1e6).toFixed(1)} MB`)
console.log(`  container      ${save.format} v${save.version ?? '?'}`)
console.log(`  world          ${meta.world?.id || '(none recorded)'}`)
if (meta.updatedAt) console.log(`  saved at       ${utc(meta.updatedAt)}Z`)
console.log(`  tracking logs  ${chunks.length}`)

if (!chunks.length) {
  console.log('\nno tracking log in this file, so there are no hours to check.')
  process.exit(1)
}

const signKey = createPublicKey({
  key: Buffer.from(SIGN_PUBLIC_KEY_B64, 'base64'),
  format: 'der',
  type: 'spki',
})

const instances = []
let failures = 0

for (const entry of chunks) {
  const body = save.storedChunk(entry.id)
  const digest = createHash('sha256').update(body).digest('hex')
  const checks = []

  checks.push(
    entry.sha256
      ? {
          ok: entry.sha256 === digest,
          name: 'digest',
          detail:
            entry.sha256 === digest
              ? 'sha256 matches the bytes'
              : `recorded ${entry.sha256}, bytes are ${digest}`,
        }
      : { ok: false, name: 'digest', detail: 'none recorded' }
  )

  let signedAt = null
  if (!entry.sig || !entry.signedAt) {
    checks.push({
      ok: false,
      name: 'signature',
      detail: 'not countersigned, so nothing vouches for when this was written',
    })
  } else {
    signedAt = entry.signedAt
    let ok = false
    try {
      ok = edVerify(
        null,
        Buffer.from(
          signedMessage(entry.sigKeyId, digest, entry.signedAt),
          'utf8'
        ),
        signKey,
        Buffer.from(entry.sig, 'base64')
      )
    } catch {
      ok = false
    }
    checks.push({
      ok,
      name: 'signature',
      detail: ok
        ? `vouched for ${utc(entry.signedAt)}Z by key ${entry.sigKeyId || 'hb1'}`
        : 'the bytes do not match the signature',
    })
  }

  instances.push({
    id: entry.id.slice(3),
    entry,
    body,
    bytes: body.length,
    signedAt,
    checks,
    lines: null,
  })
}

// ---------------------------------------------------------------- unseal, if we can

const rawKey = process.env.HB_KEY?.trim()
let keyNote = null

if (rawKey) {
  let priv = null
  try {
    priv = await importPrivateKey(rawKey)
  } catch (e) {
    keyNote = `HB_KEY will not import: ${e.message}`
  }
  if (priv) {
    for (const inst of instances) {
      try {
        const plain = await unseal(
          { seal: inst.entry.seal, body: inst.body },
          priv
        )
        const text = new TextDecoder().decode(new Uint8Array(gunzipSync(plain)))
        inst.lines = fromNdjson(text).map((l) => ({ ...l, instance: inst.id }))
      } catch (e) {
        inst.checks.push({ ok: false, name: 'decrypt', detail: e.message })
        continue
      }
      inst.checks.push({
        ok: true,
        name: 'decrypt',
        detail: `${inst.lines.length} lines, authenticated by AES-GCM`,
      })

      // a log that grew long after it was vouched for cannot happen honestly. a couple of
      // seconds can: the signature timestamp is the server's clock and the line timestamps
      // are the participant's browser, so the two are never exactly aligned
      if (inst.lines.length && inst.signedAt) {
        const last = Math.max(...inst.lines.map((l) => l.t))
        const behind = (last - inst.signedAt) / 1000
        const ok = behind <= CLOCK_SKEW_S
        inst.checks.push({
          ok,
          name: 'ordering',
          detail: ok
            ? behind > 0
              ? `signed ${behind.toFixed(1)}s before the last line, within clock skew`
              : `signed ${(-behind).toFixed(0)}s after the last line`
            : `signed ${behind.toFixed(0)}s BEFORE the last line, too far to be clock skew`,
        })
      }
    }
  }
} else {
  keyNote =
    'HB_KEY is not set, so the log stays sealed and only integrity was checked.'
}

// ---------------------------------------------------------------- integrity report

rule('integrity')
instances.sort((a, b) => (a.signedAt ?? 0) - (b.signedAt ?? 0))
for (const inst of instances) {
  console.log(`  ${inst.id}   ${inst.bytes} bytes sealed`)
  for (const c of inst.checks) {
    if (!c.ok) failures++
    console.log(
      `    ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(10)} ${c.detail}`
    )
  }
}
console.log()
console.log(
  failures
    ? `  ${failures} check(s) FAILED.`
    : '  every check passed.'
)

rule('when the server vouched for these bytes')
console.log('  visible without any key, and independent of what the log says:')
for (const inst of instances)
  console.log(
    `    ${inst.signedAt ? utc(inst.signedAt) + 'Z' : '(unsigned)'}   ${String(inst.bytes).padStart(6)} bytes`
  )

const allLines = instances.flatMap((i) => i.lines || [])
if (!allLines.length) {
  console.log()
  console.log(keyNote || 'no readable log lines.')
  process.exit(failures ? 1 : 0)
}
if (keyNote) console.log(`\n  note: ${keyNote}`)

// ---------------------------------------------------------------- activity summary

const spans = allLines
  .filter((l) => l.ev === 'active')
  .map((l) => {
    const { program, category } = lookup(l.exe)
    return {
      from: l.from,
      to: l.t,
      ms: Math.max(0, l.t - l.from),
      keys: l.keys || 0,
      clicks: l.clicks || 0,
      program,
      category,
      title: cleanTitle(l.win, program),
      instance: l.instance,
    }
  })
  .sort((a, b) => a.from - b.from)

const totalMs = spans.reduce((n, s) => n + s.ms, 0)
const zero = spans.filter((s) => s.ms === 0).length

// two instances open at once would double count, so say so rather than merging silently
const ranges = instances
  .filter((i) => i.lines?.length)
  .map((i) => ({
    id: i.id,
    from: Math.min(...i.lines.map((l) => l.from ?? l.t)),
    to: Math.max(...i.lines.map((l) => l.t)),
  }))
const overlaps = []
for (let a = 0; a < ranges.length; a++)
  for (let b = a + 1; b < ranges.length; b++)
    if (ranges[a].from < ranges[b].to && ranges[b].from < ranges[a].to)
      overlaps.push(
        `${ranges[a].id.slice(0, 8)} and ${ranges[b].id.slice(0, 8)}`
      )

const sessions = []
for (const s of spans) {
  const last = sessions[sessions.length - 1]
  if (!last || s.from - last.to > SESSION_GAP_MS)
    sessions.push({ from: s.from, to: s.to, ms: s.ms, spans: [s] })
  else {
    last.to = Math.max(last.to, s.to)
    last.ms += s.ms
    last.spans.push(s)
  }
}

const topBy = (list, pick, n) => {
  const by = new Map()
  for (const s of list) {
    const k = pick(s)
    if (k) by.set(k, (by.get(k) || 0) + s.ms)
  }
  return [...by].sort((a, b) => b[1] - a[1]).slice(0, n)
}

// a sitting that recorded a keystroke and no elapsed time is not a work session, and
// listing it would pad the count
const real = sessions.filter((s) => s.ms > 0)
const empty = sessions.length - real.length

rule(
  `sessions  (${real.length}, split on a gap over ${SESSION_GAP_MS / 60000} minutes, times UTC)`
)
real.forEach((sess, i) => {
  const programs = topBy(sess.spans, (s) => s.program, 3)
  const titles = topBy(sess.spans, (s) => s.title, 3)
  console.log(
    `  ${String(i + 1).padStart(2)}.  ${day(sess.from)}  ${clock(sess.from)}-${clock(sess.to)}   active ${dur(sess.ms).padStart(8)}`
  )
  console.log(
    `        ${programs.map(([p, ms]) => `${p} ${dur(ms)}`).join(', ') || '(nothing attributed)'}`
  )
  if (titles.length)
    console.log(`        on: ${titles.map(([t]) => t).join(' · ')}`)
})
if (empty)
  console.log(
    `\n  (${empty} further sitting(s) recorded a keystroke but no elapsed time, so they add nothing)`
  )

rule('time by category')
const byCat = new Map()
for (const s of spans)
  byCat.set(s.category, (byCat.get(s.category) || 0) + s.ms)
for (const [cat, ms] of [...byCat].sort((a, b) => b[1] - a[1]))
  console.log(
    `  ${cat.padEnd(9)} ${dur(ms).padStart(8)}  ${pct(ms, totalMs).padStart(6)}  ${'#'.repeat(Math.round((ms / totalMs) * 30))}`
  )

rule('the number')
const assetMs = byCat.get('asset') || 0
const otherMs = totalMs - assetMs
console.log(
  `  active time        ${dur(totalMs).padStart(8)}   ${hours(totalMs)} h, over ${real.length} session(s) on ${new Set(spans.map((s) => day(s.from))).size} day(s)`
)
console.log(
  `  asset time         ${dur(assetMs).padStart(8)}   ${pct(assetMs, totalMs)} of active time`
)

let approvable = totalMs
if (assetMs > totalMs * ASSET_CAP) {
  approvable = otherMs / (1 - ASSET_CAP)
  console.log(
    `  over the ${ASSET_CAP * 100}% art cap. the largest total that stays inside it is`
  )
  console.log(
    `  non-asset / 0.75   ${dur(otherMs)} / 0.75 = ${dur(approvable)}`
  )
  console.log(
    `  so ${dur(assetMs - approvable * ASSET_CAP)} of the asset time cannot be counted.`
  )
} else {
  console.log(
    `  inside the ${ASSET_CAP * 100}% art cap, so the cap does not reduce anything.`
  )
}
console.log()
console.log(`  ceiling before any other deflation:  ${hours(approvable)} h`)

rule('worth a second look')
console.log(
  `  - input recorded: ${spans.reduce((n, s) => n + s.keys, 0)} keys, ${spans.reduce((n, s) => n + s.clicks, 0)} clicks across ${spans.length} spans`
)
console.log(
  `  - ${zero} span(s) recorded input but no elapsed time, credited as zero here`
)
if (overlaps.length)
  console.log(
    `  - two instances ran at once (${overlaps.join('; ')}), so some time may be double counted`
  )
console.log(
  '  - wall clock is not used anywhere above; every figure is summed span duration'
)
console.log(
  '  - this tool approves nothing. the cap is on approved hours, and approving is a person’s job'
)

process.exit(failures ? 1 : 0)
