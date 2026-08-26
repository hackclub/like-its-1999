# vmfs — read files out of a v86 state, and flatten states into disks

Isomorphic (Node + browser) tooling for the v86 Windows 98 image. One shared state
parser drives two jobs:

- **Extract / browse** — mount the FAT filesystem a `save_state` describes, list
  directories, read files, and export a directory as a ZIP — reading only the disk
  bytes actually needed (coalesced Range reads; nothing wasteful).
- **Flatten** — bake a state's disk overlays into base image files (the automated
  replacement for `tmp-image-build/scripts/parse_state.py` + `flatten.py`).

## Modules

| file             | what it is                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `state.js`       | parse a v86 state (magic `0x86768676` v6); extract disk overlays; `maybeGunzip`                                                       |
| `blockdev.js`    | `OverlayBlockDevice` (overlay painted over a base) + `nodeFileSource` (base source) + `v86Device` (live emulator)                     |
| `fat.js`         | `FatFs` — read-only FAT12/16/32 with VFAT long names: `readdir` / `readFile` / `walk` / `resolve`                                     |
| `zip.js`         | `zipTree` — packages a FatFs tree into a ZIP (thin wrapper over [fflate](https://github.com/101arrowz/fflate))                        |
| `iso9660.js`     | `buildIso9660` — dependency-free ISO9660 (flat, Level 1) writer, for CDs mounted via `emulator.set_cdrom()`; see `../image-import.js` |
| `extract.js`     | `openStateFs`, `unwrapState` (accepts a `.99sv` container or a raw/gz state), `exportDirZip` + a Node CLI                             |
| `flatten.js`     | `flattenOne`, `applyOverlayToFile` + a Node CLI                                                                                       |
| `filebrowser.js` | `<dialog>` file browser UI + `openLiveFs(emulator)` + `downloadDirZip` (browser)                                                      |

Everything here is dependency-free except `zip.js`, which leans on `fflate` (zero deps
itself) rather than hand-rolling DEFLATE/CRC32.

A base disk image is any object with `readRange(offset, length) -> Uint8Array`.
Under Node that's `nodeFileSource('public/vm/hda.img')`. In the browser nothing reads a
base image over HTTP: the page has a running emulator, so it goes through `v86Device`,
which already merges the guest's unsaved writes over the base and reuses v86's own chunk
cache.

## CLI — extract

```bash
cd emulator/vmfs
# <state> is a .99sv container or a raw/.gz v86 state; <base> is the matching base image
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

In the browser there is one byte source: the running emulator's disk buffer. v86 already
merges the guest's writes over the base and reuses its own 256 KiB chunk cache, so there's
no `save_state`, no overlay parsing, and no re-download, and it reflects unsaved changes.

```js
import { createFileBrowser, openLiveFs } from './vmfs/filebrowser.js'

const fs = await openLiveFs(emulator) // C: (hda) of the live VM
const browser = createFileBrowser({ fs }) // builds a <dialog>
browseButton.onclick = () => browser.open('/')
// The folder action is injectable — default downloads a zip:
//   createFileBrowser({ fs, onSelect: (path, fs) => uploadSomewhere(path) })
```

Reading a saved state without a running VM is a Node job, and the `extract` CLI above is
the way in: it takes a `.99sv` container or a raw/gzipped state plus the matching base
image, and reads only the ranges the overlay does not already cover.
