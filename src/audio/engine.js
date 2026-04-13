/**
 * AudioEngine
 *
 * Manages loading, playback, and mixing of per-channel stem buffers.
 * All gain changes are smooth (no audio restart) via setTargetAtTime.
 *
 * Channel signal flow:
 *   AudioBufferSourceNode -> GainNode (volume) -> AnalyserNode -> masterGain -> destination
 *
 * iOS memory note:
 * Decoded AudioBuffers are uncompressed float32 PCM. A typical 5-minute stereo
 * stem at 44100 Hz ≈ 100 MB; 8 stems ≈ 800 MB, which exceeds iOS Safari's
 * per-tab memory limit and causes a WebKit process crash ("webpage crashed").
 * On iOS we therefore: (a) request a 22050 Hz AudioContext to halve buffer
 * sizes during decoding, and (b) downmix stereo → mono after decoding to halve
 * again. Combined: up to 4× reduction (800 MB → ~200 MB).
 */

export const STEMS = ['drums', 'perc', 'bass', 'elec', 'keys', 'synth', 'vox', 'strings', 'click', 'ambient']

// Detect iOS / iPadOS (covers iPhone, iPod, and iPad on iOS 13+ which
// reports 'MacIntel' platform but has touch points).
const _isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

// Fader scale: 0-1 input range maps to:
//   0   → -∞ dB (silence)
//   0.75 →  0 dB (unity, 1.0 linear)
//   1.0  → +6 dB (~2.0 linear)
function faderToLinear(v) {
  if (v <= 0) return 0
  if (v <= 0.75) {
    // 0 → 0.75 maps to 0.0001 → 1.0 on a log curve
    return Math.pow(v / 0.75, 2)
  }
  // 0.75 → 1.0 maps to 1.0 → 2.0
  return 1 + ((v - 0.75) / 0.25) * 1
}

export class AudioEngine {
  constructor() {
    this._ctx = null
    this._masterGain = null
    // Per-channel state: { buffer, sourceNode, gainNode, analyserNode, fader, muted, soloed }
    this._channels = {}
    this._playing = false
    this._startTime = 0     // AudioContext time when play was called
    this._pauseOffset = 0   // Seconds into the track when paused
    this._looping = false
    this._duration = 0      // Duration of the longest loaded stem
    this._soloedChannel = null
    this._rafId = null
    this._onPositionUpdate = null // callback(seconds)
    this._onEnded = null          // callback()
  }

  // ─── Context ─────────────────────────────────────────────────────────────────
  _ensureContext() {
    if (!this._ctx) {
      // On iOS request 22050 Hz to halve the decoded PCM buffer sizes.
      // iOS may ignore the hint and use the hardware rate (44100/48000 Hz),
      // in which case the mono downmix in loadStem still gives a 2× reduction.
      const ctxOpts = _isIOS ? { sampleRate: 22050 } : {}
      this._ctx = new AudioContext(ctxOpts)
      this._masterGain = this._ctx.createGain()
      this._masterGain.connect(this._ctx.destination)
    }
  }

  get context() {
    return this._ctx
  }

  /** Resume a browser-suspended AudioContext (e.g. after tab backgrounding). */
  resumeIfSuspended() {
    if (this._ctx?.state === 'suspended') return this._ctx.resume()
    return Promise.resolve()
  }

  // ─── Loading ────────────────────────────────────────────────────────────────

  /**
   * Try to load a stem. Returns the channel name if loaded, null if 404.
   * @param {string} stemName
   * @param {string} url
   * @param {Response} [preloadedResponse] - already-fetched Response to use instead of re-fetching
   */
  async loadStem(stemName, url, preloadedResponse) {
    this._ensureContext()

    let res = preloadedResponse
    if (!res) {
      try {
        res = await fetch(url)
      } catch {
        return null
      }
      if (!res.ok) return null
    }

    const arrayBuffer = await res.arrayBuffer()
    let audioBuffer
    try {
      // Use callback form for iOS Safari compatibility — the Promise-based
      // overload has known bugs on older iOS versions.
      audioBuffer = await new Promise((resolve, reject) => {
        this._ctx.decodeAudioData(arrayBuffer, resolve, reject)
      })
    } catch {
      return null
    }

    // On iOS, downmix stereo → mono to halve the AudioBuffer memory footprint.
    // A stereo stem at 44100 Hz, 5 min ≈ 100 MB decoded; mono ≈ 50 MB.
    // Combined with the 22050 Hz context request this yields up to 4× savings.
    // The loop runs once per stem (sequential load), so peak extra memory is
    // just one additional buffer at a time before the stereo one is GC'd.
    if (_isIOS && audioBuffer.numberOfChannels === 2) {
      const mono = this._ctx.createBuffer(1, audioBuffer.length, audioBuffer.sampleRate)
      const dst = mono.getChannelData(0)
      const l   = audioBuffer.getChannelData(0)
      const r   = audioBuffer.getChannelData(1)
      for (let i = 0; i < audioBuffer.length; i++) {
        dst[i] = (l[i] + r[i]) * 0.5
      }
      audioBuffer = mono  // stereo buffer can now be GC'd
    }

    // Create audio graph for this channel
    const gainNode = this._ctx.createGain()
    const analyserNode = this._ctx.createAnalyser()
    analyserNode.fftSize = 256
    gainNode.connect(analyserNode)
    analyserNode.connect(this._masterGain)

    this._channels[stemName] = {
      buffer: audioBuffer,
      sourceNode: null,
      gainNode,
      analyserNode,
      fader: 0.75,   // unity by default
      muted: false,
      soloed: false,
    }

    if (audioBuffer.duration > this._duration) {
      this._duration = audioBuffer.duration
    }

    return stemName
  }

  /** Remove all channels and reset state (call before loading a new song). */
  dispose() {
    this.stop()
    if (this._ctx) {
      this._ctx.close()
      this._ctx = null
    }
    this._channels = {}
    this._duration = 0
    this._pauseOffset = 0
    this._soloedChannel = null
  }

  // ─── Playback ────────────────────────────────────────────────────────────────

  /**
   * Start playback of all loaded channels simultaneously.
   * @param {number} [offsetSeconds=0] - where in the track to start
   * @param {number} [atContextTime] - AudioContext.currentTime to start at (for count-in sync)
   */
  play(offsetSeconds = 0, atContextTime) {
    if (!this._ctx) return
    if (this._playing) return

    const startAt = atContextTime ?? this._ctx.currentTime
    this._startTime = startAt - offsetSeconds
    this._pauseOffset = offsetSeconds

    for (const [name, ch] of Object.entries(this._channels)) {
      const src = this._ctx.createBufferSource()
      src.buffer = ch.buffer
      src.loop = this._looping
      src.connect(ch.gainNode)
      src.start(startAt, offsetSeconds)
      ch.sourceNode = src
    }

    this._applyAllGains()
    this._playing = true
    this._startRaf()

    // Schedule ended callback from the first source (they all end together)
    const firstCh = Object.values(this._channels)[0]
    if (firstCh?.sourceNode && !this._looping) {
      firstCh.sourceNode.onended = () => {
        if (this._playing) {
          this._playing = false
          this._pauseOffset = 0
          this._stopRaf()
          this._onEnded?.()
        }
      }
    }
  }

  /** Pause playback, holding current position. */
  pause() {
    if (!this._playing) return
    this._pauseOffset = this.currentTime
    this._stopSources()
    this._playing = false
    this._stopRaf()
  }

  /**
   * Seek to a specific position. Works whether playing or paused.
   * @param {number} seconds
   */
  seekTo(seconds) {
    const offset = Math.max(0, Math.min(seconds, this._duration))
    if (this._playing) {
      this._stopSources()
      this._playing = false
      this._pauseOffset = offset
      this.play(offset)
    } else {
      this._pauseOffset = offset
      this._onPositionUpdate?.(offset)
    }
  }

  /** Stop and reset position to 0. */
  stop() {
    if (!this._ctx) return
    this._stopSources()
    this._playing = false
    this._pauseOffset = 0
    this._stopRaf()
  }

  _stopSources() {
    for (const ch of Object.values(this._channels)) {
      if (ch.sourceNode) {
        try { ch.sourceNode.stop() } catch { /* already stopped */ }
        ch.sourceNode.disconnect()
        ch.sourceNode = null
      }
    }
  }

  get playing() { return this._playing }
  get duration() { return this._duration }

  get currentTime() {
    if (!this._ctx) return 0
    if (!this._playing) return this._pauseOffset
    return this._ctx.currentTime - this._startTime
  }

  set loop(v) {
    this._looping = v
    for (const ch of Object.values(this._channels)) {
      if (ch.sourceNode) ch.sourceNode.loop = v
    }
  }

  // ─── Gain / Mute / Solo ─────────────────────────────────────────────────────

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
      // Release solo
      this._soloedChannel = null
      ch.soloed = false
    } else {
      // Un-solo previous
      if (this._soloedChannel) {
        this._channels[this._soloedChannel].soloed = false
      }
      this._soloedChannel = name
      ch.soloed = true
    }
    this._applyAllGains()
    return ch.soloed
  }

  _applyChannelGain(name) {
    const ch = this._channels[name]
    if (!ch || !this._ctx) return
    const effective = this._effectiveGain(name)
    ch.gainNode.gain.setTargetAtTime(effective, this._ctx.currentTime, 0.01)
  }

  _applyAllGains() {
    for (const name of Object.keys(this._channels)) {
      this._applyChannelGain(name)
    }
  }

  _effectiveGain(name) {
    const ch = this._channels[name]
    if (!ch) return 0
    // Solo takes precedence: if any channel is soloed, only that channel plays
    if (this._soloedChannel !== null) {
      return this._soloedChannel === name ? faderToLinear(ch.fader) : 0
    }
    if (ch.muted) return 0
    return faderToLinear(ch.fader)
  }

  getChannelState(name) {
    const ch = this._channels[name]
    if (!ch) return null
    return { fader: ch.fader, muted: ch.muted, soloed: ch.soloed }
  }

  getLoadedChannels() {
    return Object.keys(this._channels)
  }

  getAnalyser(name) {
    return this._channels[name]?.analyserNode ?? null
  }

  // ─── RAF position ticker ────────────────────────────────────────────────────────

  _startRaf() {
    const tick = () => {
      if (!this._playing) return
      this._onPositionUpdate?.(this.currentTime)
      this._rafId = requestAnimationFrame(tick)
    }
    this._rafId = requestAnimationFrame(tick)
  }

  _stopRaf() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId)
      this._rafId = null
    }
  }

  set onPositionUpdate(fn) { this._onPositionUpdate = fn }
  set onEnded(fn) { this._onEnded = fn }
}
