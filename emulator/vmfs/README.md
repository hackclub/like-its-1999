# vmfs — read files out of a v86 state, and flatten states into disks

Isomorphic (Node + browser) tooling for the v86 Windows 98 image. One shared state
parser drives two jobs:

- **Extract / browse** — mount the FAT filesystem a `save_state` describes, list
  directories, read files, and export a directory as a ZIP — reading only the disk
  bytes actually needed (coalesced Range reads; nothing wasteful).
- **Flatten** — bake a state's disk overlays into base image files (the automated
  replacement for `tmp-image-build/scripts/parse_state.py` + `flatten.py`).

## Modules

| file             | what it is                                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state.js`       | parse a v86 state (magic `0x86768676` v6); extract disk overlays; `maybeGunzip`                                                                       |
| `blockdev.js`    | `OverlayBlockDevice` (overlay painted over a base) + base sources (`nodeFileSource`, `httpRangeSource`, `bufferSource`) + `v86Device` (live emulator) |
| `fat.js`         | `FatFs` — read-only FAT12/16/32 with VFAT long names: `readdir` / `readFile` / `walk` / `resolve`                                                     |
| `zip.js`         | `zipTree` / `zipFiles` — packages a FatFs tree/list into a ZIP (thin wrapper over [fflate](https://github.com/101arrowz/fflate))                      |
| `iso9660.js`     | `buildIso9660` — dependency-free ISO9660 (flat, Level 1) writer, for CDs mounted via `emulator.set_cdrom()`; see `../image-import.js`                 |
| `extract.js`     | `openStateFs`, `unwrapState` (accepts a `.99sv` container or a raw/gz state), `exportDirZip`, `exportFilesZip` + a Node CLI                           |
| `flatten.js`     | `flattenOne`, `applyOverlayToFile` + a Node CLI                                                                                                       |
| `filebrowser.js` | `<dialog>` file browser UI + `openLiveFs(emulator)` + `downloadDirZip` (browser)                                                                      |

Everything here is dependency-free except `zip.js`, which leans on `fflate` (zero deps
itself) rather than hand-rolling DEFLATE/CRC32.

A base disk image is any object with `readRange(offset, length) -> Uint8Array`.
Locally that's `nodeFileSource('public/vm/hda.img')`; in the browser it's
`httpRangeSource('https://.../hda.img')` (needs HTTP Range + CORS — the R2 bucket has
both) or `bufferSource(alreadyLoadedBytes)`.

## CLI — extract

```bash
cd emulator/vmfs
# <state> is a raw or .gz v86 state; <base> is the matching base image (hda.img for C:)
node extract.js ls   <state> <base> "/My Documents"
node extract.js tree <state> <base> "/My Documents/some folder"
node extract.js zip  <state> <base> "/My Documents/some folder" out.zip
node extract.js find <state> <base> "notes.txt"        # search by name
```

`VMFS_OVERLAY=0` forces a specific overlay; `VMFS_PROBE=/WINDOWS` sets the
auto-detect probe path (default `/WINDOWS`, which exists on C:).

## CLI — flatten

```bash
cd emulator/vmfs
# clones each base, paints the matching overlay in, verifies it still mounts as FAT
node flatten.js <state> hda.img hda-flat.img hdb.img hdb-flat.img
```

Overlays pair with bases in order (`overlay[0]`→first base = hda, `overlay[1]`→hdb);
override with `VMFS_OVERLAY_MAP="0,1"`, or `--force` to keep output that fails the
mount check. See `tmp-image-build/BUILD.md` step 5 for where flatten fits the pipeline.

## Browser usage

There are two ways to get a `FatFs` in the browser. Both feed the same `FatFs` /
`createFileBrowser` / `exportDirZip` code — only the byte source differs.

**Live VM (preferred — what the "Browse files" button uses).** Read straight from the
running emulator's disk buffer. v86 already merges the guest's writes over the base and
reuses its own 256 KiB chunk cache, so there's no `save_state`, no overlay parsing, and
no re-download — and it reflects unsaved changes.

```js
import { createFileBrowser, openLiveFs } from './vmfs/filebrowser.js'

const fs = await openLiveFs(emulator) // C: (hda) of the live VM
const browser = createFileBrowser({ fs }) // builds a <dialog>
browseButton.onclick = () => browser.open('/')
// The folder action is injectable — default downloads a zip:
//   createFileBrowser({ fs, onSelect: (path, fs) => uploadSomewhere(path) })
```

**Standalone state file (no running VM).** Parse a `.bin`/`.gz` state and read the
base image from the CDN over HTTP Range (only the needed bytes are fetched).

```js
import { openStateFs, exportDirZip } from './vmfs/extract.js'
import { httpRangeSource } from './vmfs/blockdev.js'

const base = httpRangeSource(import.meta.env.VITE_VM_BASE + 'hda.img')
const { fs } = await openStateFs(stateFileBytes, base) // stateFileBytes: gz or raw
const zip = await exportDirZip(fs, '/My Documents/whatever')
// new Blob([zip], { type: 'application/zip' }) -> download
```
