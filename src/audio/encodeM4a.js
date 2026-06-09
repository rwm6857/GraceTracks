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

  let encodeError = null
  const encoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
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
  const outName = file.name.replace(/\.wav$/i, '') + '.m4a'
  return new File([buffer], outName, { type: 'audio/mp4' })
}
