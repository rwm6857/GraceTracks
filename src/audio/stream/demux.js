/**
 * demux.js — turn a compressed stem file into decodable pieces.
 *
 *  • demuxM4a(arrayBuffer)  → AAC EncodedAudioChunks + the AudioSpecificConfig
 *                             (the `description` WebCodecs AudioDecoder needs) +
 *                             per-chunk absolute sample positions.
 *  • parseWav(arrayBuffer)  → a lazy PCM reader (no decoder needed); used as the
 *                             universal fallback when a stem is .wav.
 *
 * We hold the COMPRESSED bytes (≈12 MB/stem) and only decode a few seconds ahead
 * of the playhead, so resident PCM stays tiny (the whole point of the streaming
 * engine). mp4box does the MP4 container parsing; WebCodecs does the AAC decode.
 */
import { createFile, MP4BoxBuffer } from 'mp4box'

/** Walk the MPEG-4 descriptor tree to find a child descriptor by tag. */
function findDesc(d, tag) {
  if (!d || !d.descs) return null
  return d.descs.find(x => x.tag === tag) || null
}

/**
 * Extract the AAC AudioSpecificConfig from the esds box.
 * ES_Descriptor → DecoderConfigDescriptor (tag 0x04) → DecoderSpecificInfo (0x05).data
 */
function getAudioSpecificConfig(file, trackId) {
  const trak = file.getTrackById(trackId)
  const entries = trak?.mdia?.minf?.stbl?.stsd?.entries || []
  for (const e of entries) {
    const esds = e.esds
    if (!esds) continue
    const esd = esds.esd || esds
    const dcd = findDesc(esd, 0x04) || (esd?.descs && esd.descs[0])
    const dsi = dcd && (findDesc(dcd, 0x05) || (dcd.descs && dcd.descs[0]))
    if (dsi && dsi.data) return new Uint8Array(dsi.data)
  }
  return null
}

/**
 * @returns {Promise<{
 *   config: { codec:string, sampleRate:number, numberOfChannels:number, description:Uint8Array|null },
 *   durationSec: number,
 *   chunks: Array<{ chunk: EncodedAudioChunk, startSample:number, numSamples:number }>
 * }>}
 */
export function demuxM4a(arrayBuffer) {
  return new Promise((resolve, reject) => {
    const file = createFile()
    let track = null
    let sr = 0
    const chunks = []
    let done = false

    const finish = () => {
      if (done) return
      done = true
      try {
        const description = getAudioSpecificConfig(file, track.id)
        resolve({
          config: {
            codec: track.codec,
            sampleRate: sr,
            numberOfChannels: track.audio?.channel_count || 2,
            description,
          },
          durationSec: track.duration / track.timescale,
          chunks,
        })
      } catch (e) { reject(e) }
    }

    file.onError = (e) => { if (!done) { done = true; reject(new Error('mp4box: ' + e)) } }
    file.onReady = (info) => {
      track = (info.audioTracks && info.audioTracks[0]) ||
              info.tracks.find(t => (t.codec || '').startsWith('mp4a') || t.type === 'audio')
      if (!track) { done = true; reject(new Error('no audio track in file')); return }
      sr = track.audio?.sample_rate || 48000
      file.setExtractionOptions(track.id, null, { nbSamples: 1e7 })
      file.start()
    }
    file.onSamples = (_id, _user, samples) => {
      for (const s of samples) {
        chunks.push({
          chunk: new EncodedAudioChunk({
            type: s.is_sync ? 'key' : 'delta',
            timestamp: Math.round((s.cts / s.timescale) * 1e6), // µs
            duration: Math.round((s.duration / s.timescale) * 1e6),
            data: s.data,
          }),
          startSample: Math.round((s.cts / s.timescale) * sr),
          numSamples: Math.max(1, Math.round((s.duration / s.timescale) * sr)),
        })
      }
    }

    const buf = MP4BoxBuffer.fromArrayBuffer(arrayBuffer, 0)
    file.appendBuffer(buf)
    file.flush()
    // For a fully in-memory file, onSamples is delivered during start()/flush();
    // resolve on the next macrotask once the sample table has been emitted.
    setTimeout(finish, 0)
  })
}

/**
 * Parse a WAV (PCM) file into a lazy reader. No decoder needed — works everywhere.
 * Holds the raw bytes and converts the requested window to Float32 on demand, so we
 * never materialise the whole song as PCM at once.
 */
export function parseWav(arrayBuffer) {
  const dv = new DataView(arrayBuffer)
  if (dv.getUint32(0, false) !== 0x52494646 /* RIFF */) throw new Error('not a RIFF/WAV file')

  let off = 12 // past 'RIFF' size 'WAVE'
  let fmt = null, dataOffset = 0, dataLength = 0
  while (off + 8 <= dv.byteLength) {
    const id = dv.getUint32(off, false)
    const size = dv.getUint32(off + 4, true)
    const body = off + 8
    if (id === 0x666d7420 /* 'fmt ' */) {
      fmt = {
        audioFormat: dv.getUint16(body, true),
        channels: dv.getUint16(body + 2, true),
        sampleRate: dv.getUint32(body + 4, true),
        bitsPerSample: dv.getUint16(body + 14, true),
      }
    } else if (id === 0x64617461 /* 'data' */) {
      dataOffset = body
      dataLength = size
    }
    off = body + size + (size & 1) // chunks are word-aligned
  }
  if (!fmt || !dataOffset) throw new Error('WAV missing fmt/data chunk')
  if (fmt.audioFormat !== 1 && fmt.audioFormat !== 0xFFFE) throw new Error('only PCM WAV supported')

  const bytesPerSample = fmt.bitsPerSample / 8
  const frameBytes = bytesPerSample * fmt.channels
  const lengthSamples = Math.floor(dataLength / frameBytes)
  const bytes = new Uint8Array(arrayBuffer)

  const scale16 = 1 / 0x8000
  function sampleAt(i, ch) {
    const base = dataOffset + i * frameBytes + ch * bytesPerSample
    if (fmt.bitsPerSample === 16) {
      let v = bytes[base] | (bytes[base + 1] << 8)
      if (v >= 0x8000) v -= 0x10000
      return v * scale16
    }
    // 24-bit
    let v = bytes[base] | (bytes[base + 1] << 8) | (bytes[base + 2] << 16)
    if (v >= 0x800000) v -= 0x1000000
    return v / 0x800000
  }

  return {
    sampleRate: fmt.sampleRate,
    numberOfChannels: fmt.channels,
    lengthSamples,
    durationSec: lengthSamples / fmt.sampleRate,
    /** Convert [fromSample, fromSample+count) to {a,b} planar Float32. */
    readRange(fromSample, count) {
      const n = Math.max(0, Math.min(count, lengthSamples - fromSample))
      const a = new Float32Array(n)
      const b = new Float32Array(n)
      const ch1 = fmt.channels > 1 ? 1 : 0
      for (let i = 0; i < n; i++) {
        a[i] = sampleAt(fromSample + i, 0)
        b[i] = sampleAt(fromSample + i, ch1)
      }
      return { a, b }
    },
  }
}
