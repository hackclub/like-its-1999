// re-encode one uploaded font file. same reencode-not-passthrough model as
// image-import.js and audio-import.js: fonteditor-core parses the font into its
// table/glyph object model and we serialize a fresh font from that model, so a renamed
// non-font fails to parse and the re-emit keeps only the tables it understands (glyf
// outlines, cmap, metrics, name), dropping hint bytecode, DSIG, GPOS/GSUB, embedded
// bitmaps and any unknown table wholesale.
//
// output is always a glyf-based TrueType, the one outline flavor Win98's GDI
// rasterizes universally. so CFF/PostScript OpenType (.otf, and CFF-flavored
// .woff/.woff2) gets converted cubic->quadratic into glyf, because Win98 cannot render
// OpenType-CFF (OTTO) at all. WOFF/WOFF2 are compressed sfnt wrappers and decompress
// through the same path

// fonteditor-core doesn't expose its woff2 brotli wasm through its package "exports"
// map, so reach the asset by relative path: Vite emits it as a hashed asset and returns
// its URL, which is what woff2.init() wants. only a string at module-eval time, so the
// wasm isn't fetched until a woff2 upload triggers init
import woff2WasmUrl from '../node_modules/fonteditor-core/woff2/woff2.wasm?url'

// fonteditor-core and its wasm are heavy, so keep them out of the initial bundle every
// visitor downloads
let corePromise
const loadCore = () => (corePromise ??= import('fonteditor-core'))

// the brotli wasm must be initialised once before Font.create can read a .woff2
let woff2Promise
const ensureWoff2 = (woff2) => (woff2Promise ??= woff2.init(woff2WasmUrl))

// dispatch (media-import.js) already guaranteed one of these four extensions
const TYPE_BY_EXT = { ttf: 'ttf', otf: 'otf', woff: 'woff', woff2: 'woff2' }

// returns { ext: 'TTF', data }; throws if the file won't parse as the font container
// its extension claims
export async function reencodeFont(file, ext) {
  const { Font, woff2 } = await loadCore()
  const type = TYPE_BY_EXT[ext]
  if (type === 'woff2') await ensureWoff2(woff2)

  const buffer = await file.arrayBuffer()
  let font
  try {
    font = Font.create(buffer, { type })
  } catch {
    throw new Error(`"${file.name}" is not a decodable font`)
  }
  // toBuffer:true returns an ArrayBuffer holding a freshly written glyf TrueType
  const out = font.write({ type: 'ttf', toBuffer: true })
  return { ext: 'TTF', data: new Uint8Array(out) }
}
