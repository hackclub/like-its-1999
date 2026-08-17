// single "upload files" entry point for the CD-ROM modal (cdrom-ui.js), routing each
// file to a reencode pipeline by extension.
//
// the extension only picks which pipeline to try; the security boundary is the reencode
// inside each one (see the individual modules). a file whose bytes don't match its
// extension fails to decode in whichever pipeline it was routed to
import { buildIso9660 } from './vmfs/iso9660.js'
import { uniqueBaseName } from './iso-name.js'
import { reencodeImage } from './image-import.js'
import { reencodeAudioFile } from './audio-import.js'
import { reencodeFont } from './font-import.js'

// prettier-ignore
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'bmp', 'dib', 'ico', 'avif', 'heic', 'heif', 'tif', 'tiff'])
// prettier-ignore
const AUDIO_EXTS = new Set(['mp3', 'wav', 'wave', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'weba', 'mid', 'midi'])
const FONT_EXTS = new Set(['ttf', 'otf', 'woff', 'woff2'])

function extensionOf(name) {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

function reencodeOne(file) {
  const ext = extensionOf(file.name)
  if (IMAGE_EXTS.has(ext)) return reencodeImage(file)
  if (AUDIO_EXTS.has(ext)) return reencodeAudioFile(file)
  if (FONT_EXTS.has(ext)) return reencodeFont(file, ext)
  return Promise.reject(
    new Error(`"${file.name}" is not a supported file type`)
  )
}

// re-encode a list of File objects into an ISO9660 image ready for
// emulator.set_cdrom({ buffer: ... }); throws if any file can't be reencoded
export async function buildMediaCdrom(files) {
  const used = new Set()
  const entries = []
  for (const file of files) {
    const { ext, data } = await reencodeOne(file)
    entries.push({ name: `${uniqueBaseName(file.name, used)}.${ext}`, data })
  }
  return buildIso9660({ volumeLabel: 'IMPORTED', files: entries })
}
