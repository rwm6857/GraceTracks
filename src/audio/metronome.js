/**
 * Metronome
 *
 * Generates an audible click track using the Web Audio API.
 * Supports an optional count-in that fires a visual callback before
 * triggering the engine to start.
 */
export class Metronome {
  /**
   * @param {AudioContext} ctx - shared AudioContext from AudioEngine
   * @param {AudioNode} destination - where to route click audio (e.g. ctx.destination)
   */
  constructor(ctx, destination) {
    this._ctx = ctx
    this._dest = destination
    this._schedulerTimer = null
    this._nextBeatTime = 0
    this._beatIndex = 0
    this._bpm = 120
    this._timeSig = 4
    this._active = false
    this._onBeat = null // callback(beatIndex) — 1-indexed within measure
  }

  set onBeat(fn) { this._onBeat = fn }

  /**
   * Start the click track.
   * @param {number} bpm
   * @param {number} timeSig - beats per measure
   * @param {number} [startAtTime] - AudioContext time to start (defaults to now)
   */
  start(bpm, timeSig, startAtTime) {
    if (this._active) this.stop()
    this._bpm = bpm
    this._timeSig = timeSig
    this._beatIndex = 0
    this._nextBeatTime = startAtTime ?? this._ctx.currentTime
    this._active = true
    this._schedule()
  }

  stop() {
    this._active = false
    if (this._schedulerTimer) {
      clearTimeout(this._schedulerTimer)
      this._schedulerTimer = null
    }
  }

  /**
   * Play N count-in beats, then call onReady with the exact AudioContext timestamp
   * when audio playback should begin. Visual beat updates via onBeat callback.
   * @param {number} bpm
   * @param {number} timeSig
   * @param {function} onBeat - called each beat with { beat, total } (1-indexed)
   * @param {function} onReady - called with AudioContext playback start time
   */
  countIn(bpm, timeSig, onBeat, onReady) {
    const beatDuration = 60 / bpm
    const startTime = this._ctx.currentTime + 0.1 // small scheduling buffer

    for (let i = 0; i < timeSig; i++) {
      const beatTime = startTime + i * beatDuration
      const isAccent = i === 0
      this._scheduleClick(beatTime, isAccent)

      // Visual beat callback via setTimeout (approximate)
      const delay = (beatTime - this._ctx.currentTime) * 1000
      setTimeout(() => onBeat({ beat: i + 1, total: timeSig }), delay)
    }

    // onReady fires at the end of the count-in
    const readyTime = startTime + timeSig * beatDuration
    const readyDelay = (readyTime - this._ctx.currentTime) * 1000
    setTimeout(() => onReady(readyTime), readyDelay)
  }

  // ─── Internal scheduler (lookahead pattern) ───────────────────────────────

  _schedule() {
    if (!this._active) return
    const lookahead = 0.1  // seconds to schedule ahead
    const scheduleInterval = 50 // ms between scheduler calls

    while (this._nextBeatTime < this._ctx.currentTime + lookahead) {
      const beat = (this._beatIndex % this._timeSig) + 1
      this._scheduleClick(this._nextBeatTime, beat === 1)
      this._onBeat?.(beat)
      this._beatIndex++
      this._nextBeatTime += 60 / this._bpm
    }

    this._schedulerTimer = setTimeout(() => this._schedule(), scheduleInterval)
  }

  _scheduleClick(time, isAccent) {
    const osc = this._ctx.createOscillator()
    const env = this._ctx.createGain()

    osc.frequency.value = isAccent ? 1000 : 800
    env.gain.setValueAtTime(0, time)
    env.gain.linearRampToValueAtTime(0.4, time + 0.002)
    env.gain.exponentialRampToValueAtTime(0.001, time + 0.06)

    osc.connect(env)
    env.connect(this._dest)
    osc.start(time)
    osc.stop(time + 0.1)
  }
}
