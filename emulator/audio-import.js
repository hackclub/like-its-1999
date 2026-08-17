// re-encode one uploaded audio/MIDI file. same reencode-not-passthrough model as
// image-import.js: only decoded samples, or for MIDI only parsed note/control events,
// survive the trip.
//
// two pipelines share this module because MIDI is a sequence of synthesizer events
// rather than samples, so decodeAudioData can't read it and it needs its own
// parse-and-rewrite path
import { parseMidi, writeMidi } from 'midi-file'

// bounds each file's density (bytes/sec) rather than its total size, the audio
// equivalent of image-import.js's MAX_IMAGE_DIMENSION. mono at 22050Hz is enough for a
// background-music clip
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

// SysEx, sequencer-specific and unknown-meta events carry arbitrary opaque vendor
// payloads, and midi-file preserves them verbatim across a parse + rewrite. background
// music never needs them, so they're dropped rather than forwarded, leaving the same
// guarantee as the image pipeline: only playable data survives
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

// hand-written 16-bit PCM WAV; the format hasn't changed since 1991, so a dependency
// isn't worth it for a ~40-line header (same call as vmfs/iso9660.js)
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
    // any BaseAudioContext can decode; this one's length/rate only bound what it could
    // render, not what it can decode
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

// returns { ext, data }; throws if the file won't decode as audio or parse as MIDI
export async function reencodeAudioFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  return isMidi(bytes) ? reencodeMidi(file, bytes) : reencodeAudio(file, bytes)
}
