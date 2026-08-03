// Package file trees into ZIP archives. Thin wrapper around fflate (zero deps, ~8kB,
// isomorphic) — no reason to hand-roll DEFLATE/CRC32 when a well-maintained one exists
// and we only need "give it a name->bytes map, get a zip back".
import { zipSync } from 'fflate'

// Package a FatFs.walk() tree into a ZIP Uint8Array. Entry names are made relative to
// the tree root, prefixed with the root folder's own name so the zip contains one
// top-level folder.
export async function zipTree(fs, tree, { compress = true } = {}) {
  const files = {}
  const rootName = tree.name && tree.name !== '/' ? tree.name : 'root'
  const add = async (node, prefix) => {
    for (const f of node.files)
      files[`${prefix}/${f.name}`] = await fs.readFile(f.path)
    for (const d of node.dirs) await add(d, `${prefix}/${d.name}`)
  }
  await add(tree, rootName)
  return zipSync(files, { level: compress ? 6 : 0 })
}

// Package an explicit list of files (flat, no directory structure) into a ZIP.
export async function zipFiles(fs, paths, { compress = true } = {}) {
  const files = {}
  for (const p of paths) {
    files[p.split('/').filter(Boolean).pop()] = await fs.readFile(p)
  }
  return zipSync(files, { level: compress ? 6 : 0 })
}
