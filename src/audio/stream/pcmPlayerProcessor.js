/**
 * pcm-player — AudioWorkletProcessor
 *
 * Plays ONE stem's PCM, fed in chunks from the main thread. Every stem in a song
 * gets its own pcm-player node, and because all AudioWorklet processors on a single
 * AudioContext are driven by the same render-quantum clock, the players are
 * sample-locked to each other for free — this is what gives DAW-grade sync.
 *
 * Content-locking: each chunk carries its absolute start sample, and the processor
 * tracks an absolute output position. If a chunk is late (underrun) it outputs
 * silence but still advances position, and stale samples are dropped — so a stem
 * that briefly starves snaps back to the correct sample instead of drifting.
 *
 * Messages in:  {type:'data', startSample, a:Float32Array, b:Float32Array}
 *               {type:'play'} {type:'pause'} {type:'flush', pos:Number}
 * Messages out: {type:'status', pos, underruns, queued}
 *
 * Dependency-free on purpose: AudioWorklet modules can't use ES imports across
 * browsers, and Vite emits this file as a standalone asset via new URL(...).
 */
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super()
    this.queue = []        // [{ startSample, a:Float32Array, b:Float32Array, len }]
    this.pos = 0           // absolute output sample position
    this.playing = false
    this.underruns = 0
    this.report = 0
    this.port.onmessage = (e) => {
      const m = e.data
      if (m.type === 'data') {
        this.queue.push({ startSample: m.startSample, a: m.a, b: m.b, len: m.a.length })
      } else if (m.type === 'play') {
        this.playing = true
      } else if (m.type === 'pause') {
        this.playing = false
      } else if (m.type === 'flush') {
        this.queue = []
        this.pos = m.pos || 0
      }
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0]
    const L = out[0]
    const R = out[1] || out[0]
    const N = L.length

    if (!this.playing) { L.fill(0); R.fill(0); return true }

    for (let i = 0; i < N; i++) {
      // Drop any chunk that ends at/before the current position (fully consumed or stale).
      while (this.queue.length && (this.queue[0].startSample + this.queue[0].len) <= this.pos) {
        this.queue.shift()
      }
      const head = this.queue[0]
      if (head && head.startSample <= this.pos) {
        const off = this.pos - head.startSample
        L[i] = head.a[off]
        R[i] = head.b[off]
      } else {
        // Data for this position hasn't arrived yet — silence, but keep advancing
        // so we stay locked to the shared clock.
        L[i] = 0; R[i] = 0
        this.underruns++
      }
      this.pos++
    }

    this.report += N
    if (this.report >= sampleRate / 10) { // ~10 Hz status
      this.report = 0
      let queued = 0
      for (const c of this.queue) queued += c.len
      this.port.postMessage({ type: 'status', pos: this.pos, underruns: this.underruns, queued })
    }
    return true
  }
}

registerProcessor('pcm-player', PcmPlayer)
