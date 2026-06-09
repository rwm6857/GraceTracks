/**
 * engineFactory — choose the playback engine at runtime.
 *
 *   • StreamAudioEngine (Option B) — WebCodecs + AudioWorklet streaming mixer,
 *     sample-locked and memory-bounded. Requires AudioWorklet + WebCodecs AAC.
 *   • AudioEngine (phase-lock)      — the MediaElement engine; works everywhere.
 *
 * The streaming engine and its mp4box dependency are loaded with a DYNAMIC import
 * so they are code-split into a separate chunk — the default (phase-lock) path
 * never downloads them.
 *
 * Rollout: the streaming engine is now the DEFAULT on browsers that support
 * AudioWorklet + WebCodecs AAC (validated on iOS/macOS Safari & Chrome); everything
 * else falls back to the phase-lock MediaElement engine. `?engine=phase` forces the
 * fallback, `?engine=stream` forces streaming (and shows the on-screen diagnostics).
 */

export async function streamingSupported() {
  if (typeof AudioWorkletNode === 'undefined') return false
  if (typeof AudioDecoder === 'undefined') return false
  try {
    const r = await AudioDecoder.isConfigSupported({
      codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2,
    })
    return !!r.supported
  } catch { return false }
}

function _forcedChoice() {
  let q = null
  try { q = new URLSearchParams(location.search).get('engine') } catch {}
  if (q === 'stream' || q === 'phase') return q
  try { return localStorage.getItem('gt.engine') } catch { return null }
}

// Streaming is the default wherever the browser can support it.
async function _defaultToStreaming() { return streamingSupported() }

export async function createEngine() {
  const forced = _forcedChoice()
  const useStream = forced === 'stream' || (forced !== 'phase' && await _defaultToStreaming())

  if (useStream) {
    try {
      const { StreamAudioEngine } = await import('./stream/streamEngine.js')
      console.info('[GraceTracks] using StreamAudioEngine (Option B)')
      return new StreamAudioEngine()
    } catch (e) {
      console.warn('[GraceTracks] streaming engine failed to load, falling back:', e?.message || e)
    }
  }
  const { AudioEngine } = await import('./engine.js')
  return new AudioEngine()
}
