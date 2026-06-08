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
 *
 * Keeping the stems in sync — the hard problem:
 *   Each HTMLAudioElement runs on its OWN media clock, independent of the shared
 *   AudioContext clock and of every other element. Seeking them all to the same
 *   offset and calling .play() in one tick aligns the START, but the independent
 *   clocks then drift apart by tens-to-hundreds of ms over the length of a song.
 *   No amount of start-time coordination fixes that ongoing drift — which is why
 *   earlier "seek before play" patches only ever half-solved it.
 *
 *   AudioBufferSourceNode would be sample-locked for free, but it's off the table
 *   (see memory note above). So instead we run a software phase-locked loop:
 *     • One stem (the longest) is the MASTER clock. Transport position == its
 *       currentTime.
 *     • Every other stem is a SLAVE, continuously nudged toward the master via
 *       small playbackRate adjustments (a soft, pop-free correction). A hard
 *       re-seek is only used to recover from a large gap (e.g. a decode stall).
 *   The result: all stems stay locked to a single clock for the whole song.
 */

export const STEMS = ['drums', 'perc', 'bass', 'elec', 'keys', 'synth', 'vox', 'strings', 'click', 'ambient']

// ─── Drift-correction (phase-lock) tuning ──────────────────────────────────────
// How often slaves are measured against the master and re-aligned.
const DRIFT_INTERVAL_MS = 200
// Within this much of the master a slave is considered in sync — run at 1.0×.
// 15 ms is below the threshold most listeners perceive as a flam on transients.
const DRIFT_DEADBAND    = 0.015
// Above this, a soft playbackRate nudge can't realistically catch up (the stem
// stalled or the tab was throttled in the background) — hard re-seek instead and
// accept one brief glitch in exchange for staying locked.
const DRIFT_HARD        = 0.4
// Proportional gain: playbackRate delta per second of measured drift.
// time-constant ≈ 1/GAIN ≈ 1.7 s, so a 30 ms skew is pulled to ~4 ms in ~3 s.
const DRIFT_GAIN        = 0.6
// Clamp the nudge so the transient pitch shift while converging stays subtle
// (±5% ≈ under a semitone, and only on a stem that has actually drifted).
const DRIFT_MAX_RATE    = 0.05

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
    this._correctionTimer = null  // setInterval id for the drift-correction loop
    this._masterName      = null  // channel whose currentTime is the transport clock
    this._onPositionUpdate = null
    this._onEnded          = null
    this._playGeneration   = 0  // incremented on every play/pause/stop to cancel in-flight seeks
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

    // Drift correction nudges playbackRate. Disable pitch preservation so a nudge
    // is a clean resample (a microscopic, transient pitch shift) rather than a
    // time-stretch, which smears transients and sounds worse on music. The vendor
    // prefixes cover older Safari/Firefox.
    audio.preservesPitch = false
    audio.mozPreservesPitch = false
    audio.webkitPreservesPitch = false

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
    this._masterName  = null
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

    const generation = ++this._playGeneration
    const channels = Object.values(this._channels)

    // Begin seeking ALL stems immediately — before any count-in delay fires.
    //
    // Previous bug: seeks were inside the setTimeout callback, so they only
    // started AFTER atContextTime had already passed. The seeks then added
    // another 50–500 ms on top, pushing playback later and later out of sync.
    //
    // Fix: kick off all seeks now so they complete DURING the count-in window.
    // When the delay timer fires, seekReady is already resolved (or nearly so)
    // and .play() is called as close to atContextTime as possible.
    //
    // HTMLAudioElement.currentTime is asynchronous — each element buffers/decodes
    // independently. Calling .play() before 'seeked' fires starts each stem from
    // a different indeterminate position. Awaiting 'seeked' on every stem
    // guarantees they all begin from exactly the same offset; the drift-correction
    // loop then keeps them there for the rest of the song.
    const seekReady = Promise.all(channels.map(ch => {
      ch.audio.loop = this._looping
      ch.audio.playbackRate = 1  // clear any nudge left over from a prior play
      // Check BEFORE writing, so we can detect a genuine no-op seek.
      // A no-op seek (< 1 ms delta) means the browser may silently skip the
      // 'seeked' event (observed on Safari), which would stall playback for the
      // full 2 s safety timeout. We still write currentTime to snap the position
      // precisely — unlike the discarded 50 ms gate that skipped the assignment
      // entirely and left stems up to 49 ms misaligned at resume.
      const alreadyThere = Math.abs(ch.audio.currentTime - offsetSeconds) < 0.001
      ch.audio.currentTime = offsetSeconds
      if (alreadyThere) return Promise.resolve()
      return new Promise(resolve => {
        // Safety fallback: if 'seeked' never fires resolve after 2 s.
        const t = setTimeout(resolve, 2000)
        const done = () => { clearTimeout(t); resolve() }
        ch.audio.addEventListener('seeked', done, { once: true })
        ch.audio.addEventListener('error',  done, { once: true })
      })
    }))

    const startPlayback = async () => {
      // For count-in paths seeks should already be done; for immediate play on
      // slow devices we may still need to wait a moment.
      await seekReady

      // If pause() or stop() was called while awaiting seeks, abort.
      if (this._playGeneration !== generation) return

      // Choose the clock master (longest stem) now that durations are known.
      this._recomputeMaster()

      for (const ch of channels) {
        ch.audio.playbackRate = 1
        ch.audio.play().catch(() => {})
      }
      this._applyAllGains()
      this._playing     = true
      this._pauseOffset = offsetSeconds
      this._startRaf()
      this._startDriftCorrection()

      // 'ended' on the master stands in for all (they finish together)
      const master = this._channels[this._masterName]
      if (master && !this._looping) {
        master.audio.addEventListener('ended', () => {
          if (this._playing) {
            this._playing     = false
            this._pauseOffset = 0
            this._stopRaf()
            this._stopDriftCorrection()
            for (const c of Object.values(this._channels)) c.audio.playbackRate = 1
            this._onEnded?.()
          }
        }, { once: true })
      }
    }

    if (atContextTime !== undefined) {
      const delayMs = Math.max(0, (atContextTime - this._ctx.currentTime) * 1000)
      setTimeout(startPlayback, delayMs)
    } else {
      startPlayback()
    }
  }

  pause() {
    this._playGeneration++ // cancel any in-flight doPlay awaiting seeks
    if (!this._playing) return
    this._pauseOffset = this._masterTime()
    for (const ch of Object.values(this._channels)) {
      ch.audio.pause()
      ch.audio.playbackRate = 1
    }
    this._playing = false
    this._stopDriftCorrection()
    this._stopRaf()
  }

  seekTo(seconds) {
    const offset = Math.max(0, Math.min(seconds, this._duration))
    for (const ch of Object.values(this._channels)) {
      ch.audio.currentTime = offset
      ch.audio.playbackRate = 1  // a seek invalidates any in-progress drift nudge
    }
    this._pauseOffset = offset
    if (!this._playing) this._onPositionUpdate?.(offset)
  }

  stop() {
    this._playGeneration++ // cancel any in-flight doPlay awaiting seeks
    for (const ch of Object.values(this._channels)) {
      ch.audio.pause()
      ch.audio.currentTime = 0
      ch.audio.playbackRate = 1
    }
    this._playing     = false
    this._pauseOffset = 0
    this._stopDriftCorrection()
    this._stopRaf()
  }

  get playing()  { return this._playing  }
  get duration() { return this._duration }

  get currentTime() {
    return this._playing ? this._masterTime() : this._pauseOffset
  }

  set loop(v) {
    this._looping = v
    for (const ch of Object.values(this._channels)) ch.audio.loop = v
  }

  // ─── Sync / drift correction (software phase-lock loop) ────────────────────────

  /** Pick the longest-duration loaded stem as the master clock. */
  _recomputeMaster() {
    let best = null
    let bestDuration = -1
    for (const [name, ch] of Object.entries(this._channels)) {
      const d = isFinite(ch.audio.duration) ? ch.audio.duration : 0
      if (d > bestDuration) { bestDuration = d; best = name }
    }
    this._masterName = best
  }

  /** Current transport position, read from the master stem's media clock. */
  _masterTime() {
    const master = this._channels[this._masterName]
    return master ? master.audio.currentTime : this._pauseOffset
  }

  _startDriftCorrection() {
    this._stopDriftCorrection()
    this._correctionTimer = setInterval(() => this._correctDrift(), DRIFT_INTERVAL_MS)
  }

  _stopDriftCorrection() {
    if (this._correctionTimer) {
      clearInterval(this._correctionTimer)
      this._correctionTimer = null
    }
  }

  /**
   * One pass of the phase-lock loop: pull every slave stem toward the master.
   *   • |drift| ≤ deadband      → snap rate back to 1.0× (already in sync)
   *   • deadband < |drift| ≤ hard → proportional playbackRate nudge (pop-free)
   *   • |drift| > hard          → hard re-seek (stall/background-throttle recovery)
   */
  _correctDrift() {
    if (!this._playing) return
    const master = this._channels[this._masterName]
    if (!master) return
    const masterTime = master.audio.currentTime

    for (const [name, ch] of Object.entries(this._channels)) {
      if (name === this._masterName) {
        if (ch.audio.playbackRate !== 1) ch.audio.playbackRate = 1
        continue
      }
      const drift = ch.audio.currentTime - masterTime  // >0: slave ahead of master
      const absDrift = Math.abs(drift)

      if (absDrift > DRIFT_HARD) {
        ch.audio.currentTime = masterTime
        ch.audio.playbackRate = 1
      } else if (absDrift > DRIFT_DEADBAND) {
        // Ahead of master → slow down (<1); behind → speed up (>1).
        let rate = 1 - drift * DRIFT_GAIN
        rate = Math.max(1 - DRIFT_MAX_RATE, Math.min(1 + DRIFT_MAX_RATE, rate))
        ch.audio.playbackRate = rate
      } else if (ch.audio.playbackRate !== 1) {
        ch.audio.playbackRate = 1
      }
    }
  }

  /**
   * Diagnostic snapshot of how far each slave is from the master, in ms.
   * Handy for verifying sync in the console; not used by the UI.
   */
  getSyncReport() {
    const master = this._channels[this._masterName]
    if (!master) return { master: null, drift: {} }
    const masterTime = master.audio.currentTime
    const drift = {}
    for (const [name, ch] of Object.entries(this._channels)) {
      if (name === this._masterName) continue
      drift[name] = Math.round((ch.audio.currentTime - masterTime) * 1000)
    }
    return { master: this._masterName, drift }
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
