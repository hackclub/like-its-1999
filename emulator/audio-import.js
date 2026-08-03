// Re-encode one uploaded audio/MIDI file (see media-import.js, which combines this
// with image-import.js behind a single "upload files" picker). Same
// reencode-not-passthrough security model as image-import.js: only decoded audio
// samples (or, for MIDI, only parsed note/control events) survive the trip — never
// the original bytes.
//
// Two unrelated pipelines share this module because MIDI isn't audio — it's a
// sequence of synthesizer events, not samples, so Web Audio's decoder can't touch
// it; it needs its own parse-and-rewrite path instead of decodeAudioData.
import { parseMidi, writeMidi } from 'midi-file'

// Fixed output quality for real audio, regardless of input — the audio equivalent of
// image-import.js's MAX_IMAGE_DIMENSION: bound each file's *density* (bytes/sec),
// not its total size. How long a clip someone imports is up to them; mono/22050Hz is
// plenty for a background-music-style clip and keeps that density modest either way.
const SAMPLE_RATE = 22050
const CHANNELS = 1

function isMidi(bytes) {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x4d && // "M"
    bytes[1] === 0x54 && // "T"
    bytes[2] === 0x68 && // "h"
    bytes[3] === 0x64 // "d"
  )
}

// MIDI isn't decoded to samples, it's parsed to events and re-serialized — the same
// decode-or-reject guarantee, just for a symbolic format instead of a sampled one.
// SysEx / sequencer-specific / unknown-meta events are legitimate MIDI constructs
// that carry arbitrary opaque vendor payloads, and midi-file preserves them verbatim
// across a parse+rewrite — background music never needs them, so they're dropped
// rather than forwarded, tightening this to the same guarantee as the image
// pipeline: only meaningful, playable data survives.
function reencodeMidi(file, bytes) {
  let parsed
  try {
    parsed = parseMidi(bytes)
  } catch {
    throw new Error(`"${file.name}" is not a decodable MIDI file`)
  }
  const DROP = new Set([
    'sysEx',
    'endSysEx',
    'sequencerSpecific',
    'unknownMeta',
  ])
  parsed.tracks = parsed.tracks.map((track) =>
    track.filter((e) => !DROP.has(e.type))
  )
  return { ext: 'MID', data: new Uint8Array(writeMidi(parsed)) }
}

// Hand-written 16-bit PCM WAV — the format hasn't changed since 1991, not worth a
// dependency for a ~40-line header (same call as vmfs/iso9660.js).
function encodeWav(samples, sampleRate) {
  const dataSize = samples.length * 2 // 16-bit mono
  const buf = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buf)
  const str = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }

  str(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate (mono, 16-bit)
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  str(36, 'data')
  view.setUint32(40, dataSize, true)

  let off = 44
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(off, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true)
  }
  return new Uint8Array(buf)
}

async function reencodeAudio(file, bytes) {
  let decoded
  try {
    // Any BaseAudioContext can decode; length/rate here are irrelevant to decoding,
    // only to how long a silent buffer this throwaway context could render.
    decoded = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(
      bytes.buffer
    )
  } catch {
    throw new Error(`"${file.name}" is not a decodable audio file`)
  }

  const offline = new OfflineAudioContext(
    CHANNELS,
    Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE)),
    SAMPLE_RATE
  )
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start(0)
  const rendered = await offline.startRendering() // resamples + downmixes to mono

  return {
    ext: 'WAV',
    data: encodeWav(rendered.getChannelData(0), SAMPLE_RATE),
  }
}

// Re-encode one File as audio/MIDI. Returns { ext, data }; throws if it won't
// decode/parse as either (the caller — media-import.js — takes that as final: this
// module is already the fallback for anything the image pipeline couldn't read).
export async function reencodeAudioFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  return isMidi(bytes) ? reencodeMidi(file, bytes) : reencodeAudio(file, bytes)
}
