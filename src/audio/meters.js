/**
 * Meters
 *
 * Drives per-channel VU meter bars using a single shared RAF loop.
 * Disabled by default — call start() to activate, stop() to deactivate.
 *
 * Usage:
 *   const meters = new Meters(engine)
 *   meters.onUpdate = (levels) => { /* levels = { drums: -12.3, bass: -6.1, ... } *\/ }
 *   meters.start()
 */
export class Meters {
  /**
   * @param {import('./engine.js').AudioEngine} engine
   */
  constructor(engine) {
    this._engine = engine
    this._rafId = null
    this._active = false
    this._dataArrays = {}
    this.onUpdate = null // callback({ [channelName]: dBFS })
  }

  start() {
    if (this._active) return
    this._active = true
    this._tick()
  }

  stop() {
    this._active = false
    if (this._rafId) {
      cancelAnimationFrame(this._rafId)
      this._rafId = null
    }
  }

  _tick() {
    if (!this._active) return

    const levels = {}
    for (const name of this._engine.getLoadedChannels()) {
      const analyser = this._engine.getAnalyser(name)
      if (!analyser) continue

      if (!this._dataArrays[name]) {
        this._dataArrays[name] = new Float32Array(analyser.frequencyBinCount)
      }
      analyser.getFloatTimeDomainData(this._dataArrays[name])

      // RMS -> dBFS
      const data = this._dataArrays[name]
      let sumSq = 0
      for (let i = 0; i < data.length; i++) sumSq += data[i] * data[i]
      const rms = Math.sqrt(sumSq / data.length)
      levels[name] = rms > 0 ? 20 * Math.log10(rms) : -Infinity
    }

    this.onUpdate?.(levels)
    this._rafId = requestAnimationFrame(() => this._tick())
  }
}
