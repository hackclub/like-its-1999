// re-encode one uploaded image file (see media-import.js, which routes uploads to the
// three pipelines by extension).
//
// the security boundary is the re-encode, not a magic-byte or extension check: both
// paths below (canvas, and the GIF decoder + encoder pair) round-trip decoded pixel
// data only, so a non-image renamed to look like one fails to decode and is rejected,
// and no bytes from the original file reach the guest
import { GifReader } from 'omggif'
import { GIFEncoder, quantize, applyPalette } from 'gifenc'

// bounds the output's pixel count per file, not the batch's total size. well above any
// resolution this VM's display runs at, with headroom for zooming inside Paint Shop Pro
const MAX_IMAGE_DIMENSION = 2048

function clampedSize(width, height) {
  if (width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION) {
    return { width, height }
  }
  const scale = MAX_IMAGE_DIMENSION / Math.max(width, height)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error('image encode failed')),
      type,
      quality
    )
  )
}

// createImageBitmap only ever yields a GIF's first frame, which is why GIFs route to
// reencodeGif; this path takes everything else (JPEG, WEBP, HEIC, PNG, ...)
async function reencodeStill(file) {
  let bitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error(`"${file.name}" is not a decodable image`)
  }
  const { width, height } = clampedSize(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height)
  bitmap.close()

  const asPng = file.type === 'image/png'
  const blob = await canvasToBlob(
    canvas,
    asPng ? 'image/png' : 'image/jpeg',
    asPng ? undefined : 0.9
  )
  return {
    ext: asPng ? 'PNG' : 'JPG',
    data: new Uint8Array(await blob.arrayBuffer()),
  }
}

function readRect(src, srcWidth, x, y, w, h) {
  const out = new Uint8ClampedArray(w * h * 4)
  for (let row = 0; row < h; row++) {
    const off = ((y + row) * srcWidth + x) * 4
    out.set(src.subarray(off, off + w * 4), row * w * 4)
  }
  return out
}
function writeRect(dst, dstWidth, x, y, w, h, rect) {
  for (let row = 0; row < h; row++) {
    const off = ((y + row) * dstWidth + x) * 4
    dst.set(rect.subarray(row * w * 4, row * w * 4 + w * 4), off)
  }
}
function clearRect(dst, dstWidth, x, y, w, h) {
  for (let row = 0; row < h; row++) {
    const off = ((y + row) * dstWidth + x) * 4
    dst.fill(0, off, off + w * 4)
  }
}

// used by the GIF path when a source exceeds MAX_IMAGE_DIMENSION, keeping the bound
// uniform with stills
function downscaleRGBA(rgba, width, height, newWidth, newHeight) {
  const src = document.createElement('canvas')
  src.width = width
  src.height = height
  src.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0)
  const dst = document.createElement('canvas')
  dst.width = newWidth
  dst.height = newHeight
  const dctx = dst.getContext('2d')
  dctx.drawImage(src, 0, 0, newWidth, newHeight)
  return dctx.getImageData(0, 0, newWidth, newHeight).data
}

// canvas/toBlob can only emit a single still frame, so animated GIFs bypass canvas:
// omggif decodes each raw frame, applying GIF disposal-method compositing to recover
// each frame's full-canvas visual, and gifenc re-encodes into a fresh GIF.
//
// all frames share one palette, quantized over every frame's pixels at once, written
// once as the global table on frame 0. gifenc has no delta/dirty-rect frame support
// (it always writes a full width*height frame), so a per-frame 256-color local table
// at ~768-1024 bytes would dwarf the pixel data on small many-frame GIFs
function reencodeGif(file, bytes) {
  let reader
  try {
    reader = new GifReader(bytes)
  } catch {
    throw new Error(`"${file.name}" is not a decodable image`)
  }

  const { width, height } = reader
  const composite = new Uint8ClampedArray(width * height * 4)
  const composited = [] // one full-canvas RGBA snapshot per output frame
  const delays = []

  for (let i = 0; i < reader.numFrames(); i++) {
    const frame = reader.frameInfo(i)
    // "restore to previous" needs what was under this frame before it's drawn, to put
    // back once this frame's delay elapses
    const saved =
      frame.disposal === 3
        ? readRect(
            composite,
            width,
            frame.x,
            frame.y,
            frame.width,
            frame.height
          )
        : null

    reader.decodeAndBlitFrameRGBA(i, composite)
    composited.push(composite.slice())
    delays.push((frame.delay || 1) * 10) // GIF delay units are centiseconds -> ms

    if (frame.disposal === 2) {
      clearRect(composite, width, frame.x, frame.y, frame.width, frame.height)
    } else if (frame.disposal === 3) {
      writeRect(
        composite,
        width,
        frame.x,
        frame.y,
        frame.width,
        frame.height,
        saved
      )
    }
  }

  const out = clampedSize(width, height)
  const frames =
    out.width === width && out.height === height
      ? composited
      : composited.map((f) =>
          downscaleRGBA(f, width, height, out.width, out.height)
        )

  const allPixels = new Uint8ClampedArray(
    frames.length * out.width * out.height * 4
  )
  frames.forEach((frame, i) => allPixels.set(frame, i * frame.length))
  const palette = quantize(allPixels, 256, {
    format: 'rgba4444',
    oneBitAlpha: true,
  })
  const transparentIndex = palette.findIndex((c) => c[3] === 0)

  const gif = GIFEncoder()
  frames.forEach((frame, i) => {
    const index = applyPalette(frame, palette, 'rgba4444')
    gif.writeFrame(index, out.width, out.height, {
      palette: i === 0 ? palette : undefined, // global table once, reused after
      delay: delays[i],
      transparent: transparentIndex !== -1,
      transparentIndex: transparentIndex === -1 ? 0 : transparentIndex,
      repeat: 0,
    })
  })

  gif.finish()
  return { ext: 'GIF', data: gif.bytes() }
}

// returns { ext, data }; throws if the file won't decode as an image
export async function reencodeImage(file) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const isGif =
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 // "GIF8", magic bytes rather than file.type/extension
  return isGif ? reencodeGif(file, bytes) : reencodeStill(file)
}
