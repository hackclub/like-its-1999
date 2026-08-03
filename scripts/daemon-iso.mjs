// Put the guest binaries on a CD.
//
//   node scripts/daemon-iso.mjs            -> public/tmp-daemon.iso
//
// A CD because it is the only raw-bytes route into the guest that already exists. The host
// can read the guest's filesystem but not write it (vmfs/fat.js is a reader), and the
// import pipelines deliberately re-encode everything they touch, so neither will carry an
// executable. Mount this with `like99.dev.mountIso('/tmp-daemon.iso')` and the guest copies
// the files itself; `like99.dev.installDaemon()` does the whole thing.
//
// Same ISO writer the media import uses, so this stays honest about what the guest can read.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { buildIso9660 } from '../emulator/vmfs/iso9660.js'

const at = (rel) => fileURLToPath(new URL(rel, import.meta.url))

const files = [
  {
    name: 'DAEMON.EXE',
    data: readFileSync(at('../emulator/daemon/bin/daemon.exe')),
  },
  {
    name: 'CHILD.BIN',
    data: readFileSync(at('../emulator/daemon/bin/child.bin')),
  },
]

const iso = buildIso9660({ volumeLabel: 'DAEMON', files })
const out = at('../public/tmp-daemon.iso')
writeFileSync(out, iso)

console.log(`${out}  ${iso.length} bytes`)
for (const f of files) console.log(`  ${f.name}  ${f.data.length}`)
