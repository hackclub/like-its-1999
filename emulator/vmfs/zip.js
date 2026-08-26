// fflate is the one dependency in vmfs: zero deps itself, isomorphic, and saves
// hand-rolling DEFLATE and CRC32 for what is just a name -> bytes map
import { zipSync } from 'fflate'

// entry names are relative to the tree root and prefixed with the root folder's own
// name, so the zip contains a single top-level folder
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
