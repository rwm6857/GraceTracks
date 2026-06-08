/**
 * StreamAudioEngine — DAW-grade streaming mixer (Option B).
 *
 * One AudioContext, one `pcm-player` AudioWorkletNode per stem:
 *   pcm-player → GainNode → AnalyserNode → masterGain → destination
 * All players share the single render-quantum clock, so they are sample-locked
 * to each other (zero drift) — and the per-stem Gain/Analyser graph means the
 * existing fader/mute/solo/meter code keeps working unchanged.
 *
 * Memory: we hold each stem's COMPRESSED bytes and decode only ~`lookahead`
 * seconds ahead of the playhead, feeding PCM to the worklet and letting consumed
 * PCM fall away. Resident PCM stays ~tens of MB regardless of song length.
 *
 * Implements the same public surface as src/audio/engine.js so ui/mixer.js and
 * ui/transport.js need no changes (the engineFactory picks between the two).
 */
import { demuxM4a, parseWav } from './demux.js'
// Import the worklet as raw text and load it via a Blob URL. addModule() with a
// Blob URL is the approach proven to work on iOS Safari (the spike used it); a
// Vite-inlined data: URL is not reliably accepted there.
import pcmPlayerSrc from './pcmPlayerProcessor.js?raw'

const LOOKAHEAD_SEC = 4
const SCHED_INTERVAL_MS = 120
const PRIME_SEC = 0.25 // buffer this much before ungating, to avoid a startup glitch

// Same fader curve as engine.js (0–0.75 → 0–unity, 0.75–1 → up to +6 dB).
function faderToLinear(v) {
  if (v <= 0) return 0
  if (v <= 0.75) return Math.pow(v / 0.75, 2)
  return 1 + ((v - 0.75) / 0.25) * 1
}

export class StreamAudioEngine {
  constructor() {
    this._ctx = null
    this._masterGain = null
    this._workletReady = null   // Promise once addModule resolves
    this._channels = {}         // name → channel record
    this._order = []
    this._playing = false
    this._looping = false
    this._duration = 0
    this._sampleRate = 48000
    this._soloedChannel = null
    this._startCtx = 0          // AudioContext time at which the playhead anchor was set
    this._startOffset = 0       // playhead seconds at that anchor
    this._pauseOffset = 0
    this._schedTimer = null
    this._rafId = null
    this._endedFired = false
    this._onPositionUpdate = null
    this._onEnded = null
    this._playGeneration = 0
    // On-screen diagnostics (no console needed on iOS). On when ?engine=stream or ?debug.
    this._diagEl = null
    try { this._diagEnabled = /[?&](engine=stream|debug)/.test(location.search) } catch { this._diagEnabled = false }
  }

  /** Append a line to an on-screen diagnostic panel (and the console). */
  _diag(msg) {
    try { console.info('[stream]', msg) } catch {}
    if (!this._diagEnabled || typeof document === 'undefined') return
    if (!this._diagEl) {
      const el = document.createElement('div')
      el.style.cssText = 'position:fixed;left:6px;right:6px;bottom:6px;max-height:40vh;overflow:auto;' +
        'z-index:99999;background:rgba(16,14,11,.92);color:#f0ebe3;font:11px ui-monospace,monospace;' +
        'padding:8px 10px;border:1px solid #2e261e;border-radius:10px;white-space:pre-wrap'
      const close = document.createElement('button')
      close.textContent = '×'
      close.style.cssText = 'position:sticky;top:0;float:right;background:none;border:none;color:#a89484;font-size:16px;cursor:pointer'
      close.onclick = () => { el.remove(); this._diagEl = null }
      el.appendChild(close)
      document.body.appendChild(el)
      this._diagEl = el
    }
    const line = document.createElement('div')
    line.textContent = msg
    this._diagEl.appendChild(line)
    this._diagEl.scrollTop = this._diagEl.scrollHeight
  }

  get context() { return this._ctx }
  get playing()  { return this._playing }
  get duration() { return this._duration }

  _ensureContext() {
    if (!this._ctx) {
      this._ctx = new AudioContext()
      this._sampleRate = this._ctx.sampleRate
      this._masterGain = this._ctx.createGain()
      this._masterGain.connect(this._ctx.destination)
    }
  }

  _ensureWorklet() {
    if (!this._workletReady) {
      const blobUrl = URL.createObjectURL(new Blob([pcmPlayerSrc], { type: 'application/javascript' }))
      this._workletReady = this._ctx.audioWorklet.addModule(blobUrl)
        .finally(() => URL.revokeObjectURL(blobUrl))
    }
    return this._workletReady
  }

  resumeIfSuspended() {
    if (this._ctx?.state === 'suspended') return this._ctx.resume()
    return Promise.resolve()
  }

  // ─── Loading ───────────────────────────────────────────────────────────────

  /**
   * @param {string} stemName
   * @param {string} url
   * @param {Response} [preloadedResponse]
   * @returns {Promise<string|null>}
   */
  async loadStem(stemName, url, preloadedResponse) {
    this._ensureContext()
    await this._ensureWorklet()

    let res = preloadedResponse
    if (!res) {
      try { res = await fetch(url) } catch { return null }
      if (!res.ok) return null
    }
    let arrayBuffer
    try { arrayBuffer = await res.arrayBuffer() } catch { return null }

    const isWav = /\.wav(\?|$)/i.test(url)
    let ch
    try {
      ch = isWav ? await this._buildWavChannel(stemName, arrayBuffer)
                 : await this._buildAacChannel(stemName, arrayBuffer)
    } catch (e) {
      console.warn(`[GraceTracks] stream load failed for "${stemName}":`, e?.message || e)
      return null
    }
    if (!ch) return null

    // Graph: player → gain → analyser → master
    const gainNode = this._ctx.createGain()
    const analyserNode = this._ctx.createAnalyser()
    analyserNode.fftSize = 256
    ch.player.connect(gainNode)
    gainNode.connect(analyserNode)
    analyserNode.connect(this._masterGain)

    Object.assign(ch, { gainNode, analyserNode, fader: 0.75, muted: false, soloed: false })
    this._channels[stemName] = ch
    this._order.push(stemName)
    if (ch.durationSec > this._duration) this._duration = ch.durationSec
    this._diag(`loaded ${stemName} [${ch.kind}] ${ch.durationSec.toFixed(1)}s ${ch.channels}ch @${ch.sampleRate}`)
    return stemName
  }

  _newPlayer() {
    const node = new AudioWorkletNode(this._ctx, 'pcm-player', { outputChannelCount: [2] })
    node.port.onmessage = () => {} // status messages currently unused (position is clock-based)
    return node
  }

  async _buildAacChannel(name, arrayBuffer) {
    const { config, durationSec, chunks } = await demuxM4a(arrayBuffer)
    this._diag(`${name}: demux ok — codec=${config.codec} chunks=${chunks.length} ` +
      `asc=${config.description ? config.description.length + 'B' : 'NONE'} dur=${durationSec.toFixed(1)}s`)
    const decoder = new AudioDecoder({
      output: (audioData) => this._onDecoded(name, audioData),
      error: (e) => this._diag(`${name}: DECODER ERROR — ${e?.message || e}`),
    })
    const cfg = {
      codec: config.codec,
      sampleRate: config.sampleRate,
      numberOfChannels: config.numberOfChannels,
    }
    if (config.description) cfg.description = config.description
    decoder.configure(cfg)
    this._diag(`${name}: decoder.configure() ok`)

    return {
      name, kind: 'aac',
      player: this._newPlayer(),
      sampleRate: config.sampleRate,
      channels: config.numberOfChannels,
      durationSec,
      lengthSamples: Math.round(durationSec * config.sampleRate),
      chunks,
      chunkStarts: chunks.map(c => c.startSample),
      decoder,
      config: cfg,
      nextIdx: 0,
      fedThrough: 0,
    }
  }

  async _buildWavChannel(name, arrayBuffer) {
    const reader = parseWav(arrayBuffer)
    return {
      name, kind: 'wav',
      player: this._newPlayer(),
      sampleRate: reader.sampleRate,
      channels: reader.numberOfChannels,
      durationSec: reader.durationSec,
      lengthSamples: reader.lengthSamples,
      reader,
      cursor: 0,
      fedThrough: 0,
    }
  }

  _onDecoded(name, audioData) {
    const ch = this._channels[name]
    if (!ch) { audioData.close(); return }
    const frames = audioData.numberOfFrames
    const sr = audioData.sampleRate || ch.sampleRate
    const startSample = Math.round((audioData.timestamp / 1e6) * sr)
    const a = new Float32Array(frames)
    audioData.copyTo(a, { planeIndex: 0, format: 'f32-planar' })
    let b = a
    if (audioData.numberOfChannels > 1) {
      b = new Float32Array(frames)
      audioData.copyTo(b, { planeIndex: 1, format: 'f32-planar' })
    }
    audioData.close()
    const transfer = b === a ? [a.buffer] : [a.buffer, b.buffer]
    ch.player.port.postMessage({ type: 'data', startSample, a, b }, transfer)
    if (!ch._firstDecoded) { ch._firstDecoded = true; this._diag(`${name}: first PCM decoded @sample ${startSample} (${frames} frames)`) }
  }

  // ─── Feeding / decode-ahead ──────────────────────────────────────────────────

  _feed(ch, targetSample) {
    if (ch.kind === 'aac') {
      while (ch.fedThrough < targetSample && ch.nextIdx < ch.chunks.length) {
        const c = ch.chunks[ch.nextIdx++]
        try { ch.decoder.decode(c.chunk) } catch { /* decoder may be resetting */ }
        ch.fedThrough = c.startSample + c.numSamples
      }
    } else {
      const chunk = Math.round(0.2 * ch.sampleRate)
      while (ch.cursor < targetSample && ch.cursor < ch.lengthSamples) {
        const n = Math.min(chunk, ch.lengthSamples - ch.cursor)
        const { a, b } = ch.reader.readRange(ch.cursor, n)
        const transfer = b === a ? [a.buffer] : [a.buffer, b.buffer]
        ch.player.port.postMessage({ type: 'data', startSample: ch.cursor, a, b }, transfer)
        ch.cursor += n
        ch.fedThrough = ch.cursor
      }
    }
  }

  /** Re-anchor a channel's decode position to `sample` and flush its player. */
  _seekChannel(ch, sample) {
    ch.player.port.postMessage({ type: 'flush', pos: sample })
    if (ch.kind === 'aac') {
      try { ch.decoder.reset(); ch.decoder.configure(ch.config) } catch { /* */ }
      // Start a couple frames early so the AAC filterbank is primed; the player
      // drops samples before `sample` automatically.
      let idx = this._chunkIndexAt(ch, sample)
      idx = Math.max(0, idx - 2)
      ch.nextIdx = idx
      ch.fedThrough = ch.chunks[idx] ? ch.chunks[idx].startSample : sample
    } else {
      ch.cursor = sample
      ch.fedThrough = sample
    }
  }

  _chunkIndexAt(ch, sample) {
    // last chunk whose startSample <= sample (binary search)
    const a = ch.chunkStarts
    let lo = 0, hi = a.length - 1, ans = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (a[mid] <= sample) { ans = mid; lo = mid + 1 } else hi = mid - 1
    }
    return ans
  }

  _playheadSec() {
    if (!this._playing) return this._pauseOffset
    const t = this._startOffset + (this._ctx.currentTime - this._startCtx)
    return Math.max(0, Math.min(t, this._duration))
  }

  get currentTime() { return this._playheadSec() }

  // ─── Transport ───────────────────────────────────────────────────────────────

  play(offsetSeconds = 0, atContextTime) {
    if (!this._ctx || this._playing) return
    const generation = ++this._playGeneration
    const offset = Math.max(0, Math.min(offsetSeconds, this._duration))
    const channels = this._order.map(n => this._channels[n])

    // Anchor decode position + prime the lookahead now (before the start delay).
    for (const ch of channels) {
      this._seekChannel(ch, Math.round(offset * ch.sampleRate))
      this._feed(ch, Math.round((offset + LOOKAHEAD_SEC) * ch.sampleRate))
    }

    const startTime = atContextTime !== undefined ? atContextTime : this._ctx.currentTime + PRIME_SEC
    const delayMs = Math.max(0, (startTime - this._ctx.currentTime) * 1000)

    const begin = () => {
      if (this._playGeneration !== generation) return // cancelled by pause/stop
      this._diag(`play @${offset.toFixed(1)}s (${channels.length} stems)`)
      for (const ch of channels) ch.player.port.postMessage({ type: 'play' })
      this._startCtx = this._ctx.currentTime
      this._startOffset = offset
      this._pauseOffset = offset
      this._playing = true
      this._endedFired = false
      this._startScheduler()
      this._startRaf()
    }
    if (delayMs > 0) setTimeout(begin, delayMs)
    else begin()
  }

  pause() {
    this._playGeneration++
    if (!this._playing) return
    this._pauseOffset = this._playheadSec()
    for (const ch of this._order.map(n => this._channels[n])) ch.player.port.postMessage({ type: 'pause' })
    this._playing = false
    this._stopScheduler()
    this._stopRaf()
  }

  seekTo(seconds) {
    const offset = Math.max(0, Math.min(seconds, this._duration))
    const wasPlaying = this._playing
    for (const ch of this._order.map(n => this._channels[n])) {
      this._seekChannel(ch, Math.round(offset * ch.sampleRate))
      this._feed(ch, Math.round((offset + LOOKAHEAD_SEC) * ch.sampleRate))
    }
    if (wasPlaying) {
      // Re-anchor the clock; players keep playing from the new position.
      this._startCtx = this._ctx.currentTime
      this._startOffset = offset
    } else {
      this._pauseOffset = offset
      this._onPositionUpdate?.(offset)
    }
  }

  stop() {
    this._playGeneration++
    for (const ch of this._order.map(n => this._channels[n])) {
      ch.player.port.postMessage({ type: 'pause' })
      this._seekChannel(ch, 0)
    }
    this._playing = false
    this._pauseOffset = 0
    this._stopScheduler()
    this._stopRaf()
  }

  set loop(v) { this._looping = v }

  // ─── Scheduler (decode-ahead) + RAF position ─────────────────────────────────

  _startScheduler() {
    this._stopScheduler()
    const tick = () => {
      if (!this._playing) return
      const head = this._playheadSec()
      for (const name of this._order) {
        const ch = this._channels[name]
        this._feed(ch, Math.round((head + LOOKAHEAD_SEC) * ch.sampleRate))
      }
      if (!this._looping && !this._endedFired && head >= this._duration - 0.05) {
        this._endedFired = true
        this._playing = false
        this._pauseOffset = 0
        this._stopScheduler()
        this._stopRaf()
        for (const n of this._order) this._channels[n].player.port.postMessage({ type: 'pause' })
        this._onEnded?.()
      }
    }
    this._schedTimer = setInterval(tick, SCHED_INTERVAL_MS)
    tick()
  }
  _stopScheduler() { if (this._schedTimer) { clearInterval(this._schedTimer); this._schedTimer = null } }

  _startRaf() {
    const tick = () => {
      if (!this._playing) return
      this._onPositionUpdate?.(this._playheadSec())
      this._rafId = requestAnimationFrame(tick)
    }
    this._rafId = requestAnimationFrame(tick)
  }
  _stopRaf() { if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null } }

  // ─── Gain / mute / solo (same semantics as engine.js) ─────────────────────────

  setMasterVolume(value) {
    if (!this._masterGain || !this._ctx) return
    this._masterGain.gain.setTargetAtTime(faderToLinear(Math.max(0, Math.min(1, value))), this._ctx.currentTime, 0.01)
  }
  setFader(name, value) {
    const ch = this._channels[name]; if (!ch) return
    ch.fader = Math.max(0, Math.min(1, value)); this._applyChannelGain(name)
  }
  toggleMute(name) {
    const ch = this._channels[name]; if (!ch) return
    ch.muted = !ch.muted; this._applyChannelGain(name); return ch.muted
  }
  toggleSolo(name) {
    const ch = this._channels[name]; if (!ch) return
    if (this._soloedChannel === name) { this._soloedChannel = null; ch.soloed = false }
    else { if (this._soloedChannel) this._channels[this._soloedChannel].soloed = false; this._soloedChannel = name; ch.soloed = true }
    this._applyAllGains(); return ch.soloed
  }
  _effectiveGain(name) {
    const ch = this._channels[name]; if (!ch) return 0
    if (this._soloedChannel !== null) return this._soloedChannel === name ? faderToLinear(ch.fader) : 0
    if (ch.muted) return 0
    return faderToLinear(ch.fader)
  }
  _applyChannelGain(name) {
    const ch = this._channels[name]; if (!ch || !this._ctx) return
    ch.gainNode.gain.setTargetAtTime(this._effectiveGain(name), this._ctx.currentTime, 0.01)
  }
  _applyAllGains() { for (const n of Object.keys(this._channels)) this._applyChannelGain(n) }

  getChannelState(name) {
    const ch = this._channels[name]; if (!ch) return null
    return { fader: ch.fader, muted: ch.muted, soloed: ch.soloed }
  }
  getLoadedChannels() { return this._order.slice() }
  getAnalyser(name) { return this._channels[name]?.analyserNode ?? null }

  set onPositionUpdate(fn) { this._onPositionUpdate = fn }
  set onEnded(fn) { this._onEnded = fn }

  dispose() {
    this._playGeneration++
    this._stopScheduler()
    this._stopRaf()
    for (const ch of Object.values(this._channels)) {
      try { ch.player.port.postMessage({ type: 'pause' }); ch.player.disconnect() } catch {}
      if (ch.kind === 'aac') { try { ch.decoder.close() } catch {} }
    }
    if (this._ctx) { try { this._ctx.close() } catch {} ; this._ctx = null }
    this._channels = {}
    this._order = []
    this._duration = 0
    this._pauseOffset = 0
    this._soloedChannel = null
    this._workletReady = null
  }
}
