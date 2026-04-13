/**
 * AudioEngine
 *
 * Manages loading, playback, and mixing of per-channel stems.
 *
 * Channel signal flow:
 *   HTMLAudioElement → MediaElementAudioSourceNode → GainNode → AnalyserNode → masterGain → destination
 *
 * Why MediaElementAudioSourceNode instead of AudioBufferSourceNode:
 *   decodeAudioData inflates a compressed M4A (~30 MB) into raw float32 PCM
 *   (~300 MB for a 15-minute stereo stem at 44.1 kHz). With 6–8 stems that
 *   exceeds iOS Safari's per-tab memory limit, crashing the WebKit process.
 *   MediaElementAudioSourceNode connects an <audio> element directly into the
 *   Web Audio graph; the browser streams and decodes on the fly so memory stays
 *   near the compressed file size. Full 44.1 kHz stereo is preserved.
 */

export const STEMS = ['drums', 'perc', 'bass', 'elec', 'keys', 'synth', 'vox', 'strings', 'click', 'ambient']

// Fader scale: 0-1 input range maps to:
//   0    → -∞ dB (silence)
//   0.75 →  0 dB (unity, 1.0 linear)
//   1.0  → +6 dB (~2.0 linear)
function faderToLinear(v) {
  if (v <= 0) return 0
  if (v <= 0.75) return Math.pow(v / 0.75, 2)
  return 1 + ((v - 0.75) / 0.25) * 1
}

export class AudioEngine {
  constructor() {
    this._ctx         = null
    this._masterGain  = null
    // Per-channel: { audio, blobUrl, sourceNode, gainNode, analyserNode, fader, muted, soloed }
    this._channels    = {}
    this._playing     = false
    this._pauseOffset = 0
    this._looping     = false
    this._duration    = 0
    this._soloedChannel   = null
    this._rafId           = null
    this._onPositionUpdate = null
    this._onEnded          = null
  }

  // ─── Context ─────────────────────────────────────────────────────────────────

  _ensureContext() {
    if (!this._ctx) {
      this._ctx = new AudioContext()
      this._masterGain = this._ctx.createGain()
      this._masterGain.connect(this._ctx.destination)
    }
  }

  get context() { return this._ctx }

  /**
   * Resume a suspended AudioContext.
   * Must be called from a user-gesture handler before the first play() so that
   * iOS Safari allows subsequent audio.play() calls (even from setTimeout).
   */
  resumeIfSuspended() {
    if (this._ctx?.state === 'suspended') return this._ctx.resume()
    return Promise.resolve()
  }

  // ─── Loading ─────────────────────────────────────────────────────────────────

  /**
   * Load a stem via a Blob-backed <audio> element.
   *
   * The fetch result is stored as a Blob (~30 MB compressed) and assigned to an
   * HTMLAudioElement as a blob: URL.  createMediaElementSource wires it into the
   * Web Audio graph.  No decodeAudioData — no PCM inflation.
   *
   * @param {string}   stemName
   * @param {string}   url
   * @param {Response} [preloadedResponse]
   * @returns {Promise<string|null>} stemName on success, null on failure
   */
  async loadStem(stemName, url, preloadedResponse) {
    this._ensureContext()

    let res = preloadedResponse
    if (!res) {
      try { res = await fetch(url) } catch { return null }
      if (!res.ok) return null
    }

    let blob
    try { blob = await res.blob() } catch { return null }

    const blobUrl = URL.createObjectURL(blob)
    const audio   = new Audio(blobUrl)
    audio.preload = 'auto'

    // Wait for metadata (gives us audio.duration).
    // Blob URLs are local — no network restriction applies, so this fires quickly
    // even on iOS where network-URL preloading is blocked without a user gesture.
    await new Promise(resolve => {
      audio.addEventListener('loadedmetadata', resolve, { once: true })
      audio.addEventListener('error',          resolve, { once: true })
      audio.load()
    })

    let source
    try {
      source = this._ctx.createMediaElementSource(audio)
    } catch {
      URL.revokeObjectURL(blobUrl)
      return null
    }

    const gainNode     = this._ctx.createGain()
    const analyserNode = this._ctx.createAnalyser()
    analyserNode.fftSize = 256
    source.connect(gainNode)
    gainNode.connect(analyserNode)
    analyserNode.connect(this._masterGain)

    this._channels[stemName] = {
      audio, blobUrl, sourceNode: source,
      gainNode, analyserNode,
      fader: 0.75, muted: false, soloed: false,
    }

    if (isFinite(audio.duration) && audio.duration > this._duration) {
      this._duration = audio.duration
    }

    return stemName
  }

  dispose() {
    this.stop()
    for (const ch of Object.values(this._channels)) {
      ch.audio.pause()
      ch.audio.src = ''
      URL.revokeObjectURL(ch.blobUrl)
    }
    if (this._ctx) { this._ctx.close(); this._ctx = null }
    this._channels    = {}
    this._duration    = 0
    this._pauseOffset = 0
    this._soloedChannel = null
  }

  // ─── Playback ─────────────────────────────────────────────────────────────────

  /**
   * Start playback of all channels.
   * @param {number} [offsetSeconds=0]
   * @param {number} [atContextTime] - AudioContext time to begin (used by count-in).
   *   Converted to a wall-clock setTimeout so the audio elements start in sync.
   *   resumeIfSuspended() MUST have been called first (within the user gesture)
   *   so iOS allows the delayed audio.play() call.
   */
  play(offsetSeconds = 0, atContextTime) {
    if (!this._ctx || this._playing) return

    const doPlay = () => {
      for (const ch of Object.values(this._channels)) {
        ch.audio.currentTime = offsetSeconds
        ch.audio.loop = this._looping
        ch.audio.play().catch(() => {})
      }
      this._applyAllGains()
      this._playing     = true
      this._pauseOffset = offsetSeconds
      this._startRaf()

      // 'ended' on the first channel stands in for all (they finish together)
      const firstCh = Object.values(this._channels)[0]
      if (firstCh && !this._looping) {
        firstCh.audio.addEventListener('ended', () => {
          if (this._playing) {
            this._playing     = false
            this._pauseOffset = 0
            this._stopRaf()
            this._onEnded?.()
          }
        }, { once: true })
      }
    }

    if (atContextTime !== undefined) {
      const delayMs = Math.max(0, (atContextTime - this._ctx.currentTime) * 1000)
      setTimeout(doPlay, delayMs)
    } else {
      doPlay()
    }
  }

  pause() {
    if (!this._playing) return
    const firstCh = Object.values(this._channels)[0]
    this._pauseOffset = firstCh?.audio.currentTime ?? this._pauseOffset
    for (const ch of Object.values(this._channels)) ch.audio.pause()
    this._playing = false
    this._stopRaf()
  }

  seekTo(seconds) {
    const offset = Math.max(0, Math.min(seconds, this._duration))
    for (const ch of Object.values(this._channels)) ch.audio.currentTime = offset
    this._pauseOffset = offset
    if (!this._playing) this._onPositionUpdate?.(offset)
  }

  stop() {
    for (const ch of Object.values(this._channels)) {
      ch.audio.pause()
      ch.audio.currentTime = 0
    }
    this._playing     = false
    this._pauseOffset = 0
    this._stopRaf()
  }

  get playing()  { return this._playing  }
  get duration() { return this._duration }

  get currentTime() {
    if (this._playing) {
      const firstCh = Object.values(this._channels)[0]
      return firstCh?.audio.currentTime ?? this._pauseOffset
    }
    return this._pauseOffset
  }

  set loop(v) {
    this._looping = v
    for (const ch of Object.values(this._channels)) ch.audio.loop = v
  }

  // ─── Gain / Mute / Solo ──────────────────────────────────────────────────────

  setMasterVolume(value) {
    if (!this._masterGain || !this._ctx) return
    const linear = faderToLinear(Math.max(0, Math.min(1, value)))
    this._masterGain.gain.setTargetAtTime(linear, this._ctx.currentTime, 0.01)
  }

  setFader(name, value) {
    const ch = this._channels[name]
    if (!ch) return
    ch.fader = Math.max(0, Math.min(1, value))
    this._applyChannelGain(name)
  }

  toggleMute(name) {
    const ch = this._channels[name]
    if (!ch) return
    ch.muted = !ch.muted
    this._applyChannelGain(name)
    return ch.muted
  }

  toggleSolo(name) {
    const ch = this._channels[name]
    if (!ch) return
    if (this._soloedChannel === name) {
      this._soloedChannel = null
      ch.soloed = false
    } else {
      if (this._soloedChannel) this._channels[this._soloedChannel].soloed = false
      this._soloedChannel = name
      ch.soloed = true
    }
    this._applyAllGains()
    return ch.soloed
  }

  _applyChannelGain(name) {
    const ch = this._channels[name]
    if (!ch || !this._ctx) return
    ch.gainNode.gain.setTargetAtTime(this._effectiveGain(name), this._ctx.currentTime, 0.01)
  }

  _applyAllGains() {
    for (const name of Object.keys(this._channels)) this._applyChannelGain(name)
  }

  _effectiveGain(name) {
    const ch = this._channels[name]
    if (!ch) return 0
    if (this._soloedChannel !== null) return this._soloedChannel === name ? faderToLinear(ch.fader) : 0
    if (ch.muted) return 0
    return faderToLinear(ch.fader)
  }

  getChannelState(name) {
    const ch = this._channels[name]
    if (!ch) return null
    return { fader: ch.fader, muted: ch.muted, soloed: ch.soloed }
  }

  getLoadedChannels() { return Object.keys(this._channels) }
  getAnalyser(name)   { return this._channels[name]?.analyserNode ?? null }

  // ─── RAF position ticker ──────────────────────────────────────────────────────

  _startRaf() {
    const tick = () => {
      if (!this._playing) return
      this._onPositionUpdate?.(this.currentTime)
      this._rafId = requestAnimationFrame(tick)
    }
    this._rafId = requestAnimationFrame(tick)
  }

  _stopRaf() {
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null }
  }

  set onPositionUpdate(fn) { this._onPositionUpdate = fn }
  set onEnded(fn)          { this._onEnded = fn }
}
