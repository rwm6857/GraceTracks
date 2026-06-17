/**
 * In-browser WAV → M4A (AAC) conversion for the upload page.
 *
 * Uses WebCodecs `AudioEncoder` (codec mp4a.40.2 / AAC-LC) and mp4-muxer to
 * wrap the encoded chunks in an MP4 container, producing a `.m4a` File the
 * upload flow can PUT to R2 exactly like a natively-recorded m4a.
 *
 * This is *upload-time* work, not playback: it runs once per stem on a capable
 * desktop browser, so a full `decodeAudioData` of one stem is acceptable here
 * (the playback OOM constraint in CLAUDE.md is about holding many stems of
 * resident PCM during mixing, which this never does). Where WebCodecs AAC
 * encoding is unavailable (notably iOS Safari, Firefox), `isM4aEncodeSupported`
 * returns false and the caller falls back to uploading the raw WAV — both
 * formats are already resolved by the mixer (src/audio/stems.js).
 */

import { Muxer, ArrayBufferTarget } from 'mp4-muxer'

/** Quick synchronous capability probe — true if AAC encoding is plausible. */
export function isM4aEncodeSupported() {
  return (
    typeof AudioEncoder !== 'undefined' &&
    typeof AudioData !== 'undefined' &&
    (typeof AudioContext !== 'undefined' || typeof window.webkitAudioContext !== 'undefined')
  )
}

// MPEG-4 sampling-frequency index table (ISO 14496-3). Index 15 means "explicit
// frequency follows" and needs a longer config — we only synthesize the 2-byte
// form, so unlisted rates skip synthesis and lean on the verify-and-fallback net.
const SR_INDEX = {
  96000: 0, 88200: 1, 64000: 2, 48000: 3, 44100: 4, 32000: 5,
  24000: 6, 22050: 7, 16000: 8, 12000: 9, 11025: 10, 8000: 11, 7350: 12,
}

/**
 * Build the 2-byte AAC-LC AudioSpecificConfig (objectType=2) for a sample rate
 * and channel count. Safari's AudioEncoder omits `decoderConfig.description`, so
 * mp4-muxer would write an MP4 with no codec config → an undecodable/silent file.
 * Supplying this lets the muxer write a valid esds box. Returns null for sample
 * rates outside the short-form table.
 * @returns {Uint8Array|null}
 */
function buildAacAsc(sampleRate, channels) {
  const freqIdx = SR_INDEX[sampleRate]
  if (freqIdx == null) return null
  const objectType = 2 // AAC-LC
  // 5 bits objectType | 4 bits freqIdx | 4 bits channelConfig | 3 bits zero pad
  const b0 = (objectType << 3) | (freqIdx >> 1)
  const b1 = ((freqIdx & 1) << 7) | (channels << 3)
  return new Uint8Array([b0, b1])
}

/**
 * Confirm an encoded M4A actually decodes to non-silent audio of about the
 * expected length. Catches Safari's structurally-broken encoder output, which
 * uploads fine but plays as silence everywhere. Throws if the file is
 * undecodable, badly truncated, or entirely silent.
 */
async function verifyPlayableM4a(arrayBuffer, expectedDurationSec) {
  const AC = window.AudioContext || window.webkitAudioContext
  const ctx = new AC()
  let decoded
  try {
    // decodeAudioData detaches its input on some engines — hand it a copy so the
    // caller's buffer stays intact for the uploaded File.
    decoded = await ctx.decodeAudioData(arrayBuffer.slice(0))
  } finally {
    ctx.close?.()
  }
  if (!decoded || decoded.length === 0) throw new Error('converted M4A decoded empty')
  if (decoded.duration < expectedDurationSec * 0.9) {
    throw new Error(`converted M4A truncated (${decoded.duration.toFixed(1)}s of ${expectedDurationSec.toFixed(1)}s)`)
  }
  // Sample sparsely for any signal — a working stem is never pure digital silence.
  const data = decoded.getChannelData(0)
  let peak = 0
  for (let i = 0; i < data.length; i += 997) {
    const v = Math.abs(data[i])
    if (v > peak) peak = v
  }
  if (peak < 1e-4) throw new Error('converted M4A is silent')
}

/**
 * Convert a WAV File to an M4A (AAC-LC) File. Throws if encoding is not
 * supported or fails — callers should fall back to the original file.
 *
 * @param {File} file - source .wav file
 * @param {{ bitrate?: number }} [opts]
 * @returns {Promise<File>} a new File with a `.m4a` name and `audio/mp4` type
 */
export async function wavFileToM4a(file, { bitrate = 160000 } = {}) {
  if (!isM4aEncodeSupported()) throw new Error('AAC encoding not supported in this browser')

  // ─── 1. Decode WAV → PCM (AudioBuffer) ─────────────────────────────────────
  const AC = window.AudioContext || window.webkitAudioContext
  const ctx = new AC()
  let audioBuffer
  try {
    const arrayBuf = await file.arrayBuffer()
    audioBuffer = await ctx.decodeAudioData(arrayBuf)
  } finally {
    ctx.close?.()
  }

  const sampleRate = audioBuffer.sampleRate
  const numberOfChannels = Math.min(audioBuffer.numberOfChannels, 2)

  // ─── 2. Confirm the encoder accepts this config ────────────────────────────
  const config = { codec: 'mp4a.40.2', sampleRate, numberOfChannels, bitrate }
  const support = await AudioEncoder.isConfigSupported(config)
  if (!support?.supported) throw new Error('AAC config not supported')

  // ─── 3. Wire encoder → muxer ───────────────────────────────────────────────
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    audio: { codec: 'aac', sampleRate, numberOfChannels },
    fastStart: 'in-memory',
  })

  // Safari emits AAC chunks with no decoderConfig.description; synthesize one so
  // the muxer can still write a valid esds. Only fills it in when missing, so
  // browsers that provide a real description (Chrome) are left untouched.
  const fallbackAsc = buildAacAsc(sampleRate, numberOfChannels)
  let encodeError = null
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      if (fallbackAsc && meta?.decoderConfig && !meta.decoderConfig.description) {
        meta = { ...meta, decoderConfig: { ...meta.decoderConfig, description: fallbackAsc } }
      } else if (fallbackAsc && !meta?.decoderConfig) {
        meta = { decoderConfig: { codec: config.codec, sampleRate, numberOfChannels, description: fallbackAsc } }
      }
      muxer.addAudioChunk(chunk, meta)
    },
    error: (e) => { encodeError = e },
  })
  encoder.configure(config)

  // ─── 4. Feed PCM in ~1s planar frames ──────────────────────────────────────
  const total = audioBuffer.length
  const channelData = []
  for (let c = 0; c < numberOfChannels; c++) channelData.push(audioBuffer.getChannelData(c))

  const FRAME = sampleRate // one second per AudioData
  for (let offset = 0; offset < total; offset += FRAME) {
    if (encodeError) break
    const n = Math.min(FRAME, total - offset)
    // f32-planar layout: all channel-0 samples, then all channel-1 samples, …
    const planar = new Float32Array(n * numberOfChannels)
    for (let c = 0; c < numberOfChannels; c++) {
      planar.set(channelData[c].subarray(offset, offset + n), c * n)
    }
    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate,
      numberOfFrames: n,
      numberOfChannels,
      timestamp: Math.round((offset / sampleRate) * 1e6),
      data: planar,
    })
    encoder.encode(audioData)
    audioData.close()
  }

  await encoder.flush()
  encoder.close()
  if (encodeError) throw encodeError

  // ─── 5. Finalize MP4 → File ────────────────────────────────────────────────
  muxer.finalize()
  const { buffer } = muxer.target

  // Reject a structurally-broken encode (Safari) before it can reach R2 — the
  // caller falls back to uploading the original WAV, which the mixer supports.
  await verifyPlayableM4a(buffer, audioBuffer.duration)

  const outName = file.name.replace(/\.wav$/i, '') + '.m4a'
  return new File([buffer], outName, { type: 'audio/mp4' })
}
