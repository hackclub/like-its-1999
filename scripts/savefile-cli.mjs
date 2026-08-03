// Inspect and unpack `.99sv` saves (and legacy v1 artifacts) from the command line.
//
//   node scripts/savefile-cli.mjs info    <file|url>
//   node scripts/savefile-cli.mjs extract <file> <chunkId> <out>
//   node scripts/savefile-cli.mjs state   <file> <out>
//
// This is how a submitted machine gets reviewed: `info` on an http(s) URL reads only the
// container's metadata over a Range request, so you can see which world it belongs to and
// what it carries without pulling tens of megabytes of RAM image.
//
// It lives here rather than inside emulator/savefile.js because that module is shipped to a
// browser, and a CLI in it meant the bundler had to externalize node:fs/promises on every
// production build.

import * as fsp from 'node:fs/promises'

import { readSaveFile, probeSaveFileMeta } from '../emulator/savefile.js'

const [cmd, file, ...rest] = process.argv.slice(2)
const usage = `usage:
node scripts/savefile-cli.mjs info    <file|url>
node scripts/savefile-cli.mjs extract <file> <chunkId> <out>
node scripts/savefile-cli.mjs state   <file> <out>`

if (!cmd || !file) {
  console.error(usage)
  process.exit(1)
}

if (cmd === 'info' && /^https?:\/\//.test(file)) {
  const probed = await probeSaveFileMeta(file)
  if (!probed) {
    console.log('format:     legacy v1 artifact (no container metadata)')
    process.exit(0)
  }
  console.log(`format:     container v${probed.version}`)
  console.log(`total size: ${(probed.totalLength / 1024).toFixed(0)} KiB`)
  console.log(`world:      ${probed.meta.world?.id ?? '(none)'}`)
  console.log(
    `chunks:     ${probed.chunks.map((c) => `${c.id} (${c.length}B)`).join(', ')}`
  )
  // Only the tracking chunks that exist. There is no aggregate figure in the metadata:
  // nothing writes one, and printing `?? 0` made every file look like zero hours worked.
  const sealed = probed.chunks.filter((c) => c.id.startsWith('hb/'))
  if (sealed.length)
    console.log(`tracking:   ${sealed.length} sealed log(s) present`)
  process.exit(0)
}

const bytes = new Uint8Array(await fsp.readFile(file))
const save = await readSaveFile(bytes)

if (cmd === 'info') {
  const kb = (n) => `${(n / 1024).toFixed(0)} KiB`
  console.log(`format:     ${save.format}${save.legacy ? ' (legacy v1)' : ''}`)
  console.log(`file size:  ${kb(bytes.length)}`)
  if (save.legacy) {
    const raw = await save.state()
    console.log(`state:      ${kb(raw.length)} decompressed`)
    console.log('world:      (none recorded — treated as the legacy world)')
  } else {
    const m = save.meta
    console.log(`id:         ${m.id ?? '(none)'}`)
    console.log(
      `created:    ${m.createdAt ? new Date(m.createdAt).toISOString() : '(none)'}`
    )
    const w = m.world
    console.log(
      `world:      ${typeof w === 'string' ? w : (w?.id ?? '(none)')}`
    )
    if (w && typeof w === 'object') {
      if (w.memory) console.log(`  memory:   ${w.memory / 1048576} MiB`)
      if (w.vgaMemory) console.log(`  vga:      ${w.vgaMemory / 1048576} MiB`)
      if (w.uart1 != null) console.log(`  uart1:    ${w.uart1}`)
      for (const [k, d] of Object.entries(w.disks || {}))
        console.log(`  ${k}:      ${d.url} (${d.size} bytes)`)
    }
    // What the file actually carries, per instance. Use scripts/hb-decrypt.mjs to read
    // one; the hours are computed from the log, never stored alongside it.
    const sealed = save.chunkIds.filter((id) => id.startsWith('hb/'))
    if (sealed.length)
      console.log(
        `tracking:   ${sealed.length} sealed log(s): ${sealed.join(', ')}`
      )
    if (m.tracking?.instanceId)
      console.log(`last run:   instance ${m.tracking.instanceId}`)
    console.log('chunks:')
    for (const c of save.chunks)
      console.log(
        `  ${c.id.padEnd(12)} ${String(c.length).padStart(10)} stored  ` +
          `${String(c.size ?? '?').padStart(10)} raw  ${c.codec || 'raw'}`
      )
  }
} else if (cmd === 'extract' || cmd === 'state') {
  const id = cmd === 'state' ? 'state' : rest[0]
  const out = cmd === 'state' ? rest[0] : rest[1]
  if (!id || !out) {
    console.error(usage)
    process.exit(1)
  }
  const data = await save.chunk(id)
  if (!data) {
    console.error(`no chunk "${id}" (have: ${save.chunkIds.join(', ')})`)
    process.exit(1)
  }
  await fsp.writeFile(out, data)
  console.error(`wrote ${out} (${data.length} bytes)`)
} else {
  console.error(usage)
  process.exit(1)
}
