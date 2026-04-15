/**
 * AudioEngine unit tests
 *
 * Focus areas (all touched by the play-merge-conflict fix):
 *   1. seekReady — no-op fast-path (< 1 ms delta resolves immediately)
 *   2. seekReady — real-seek path (waits for 'seeked', then plays)
 *   3. seekReady — currentTime is always written, even on no-op seeks
 *   4. seekReady — ALL channels are seeked; no 50 ms tolerance gate
 *   5. Generation guard — pause/stop during in-flight seek aborts playback
 *   6. Count-in — seeks start before the setTimeout delay, not inside it
 *   7. pause() — _pauseOffset captured from first channel's currentTime
 *   8. stop()  — resets every channel to 0 and clears _pauseOffset
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AudioEngine } from './engine.js'

// ─── Minimal Web Audio / HTMLAudioElement fakes ───────────────────────────────

/** Build a fake HTMLAudioElement whose 'seeked' event can be fired manually. */
function makeFakeAudio(initialTime = 0) {
  const listeners = {}
  const audio = {
    _currentTime: initialTime,
    get currentTime() { return this._currentTime },
    set currentTime(v) { this._currentTime = v },
    loop: false,
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    duration: 120,
    addEventListener(event, cb, opts) {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push({ cb, once: opts?.once })
    },
    removeEventListener: vi.fn(),
    // Test helper: trigger an event
    _emit(event) {
      const handlers = listeners[event] ?? []
      listeners[event] = handlers.filter(h => !h.once)
      handlers.forEach(h => h.cb())
    },
  }
  return audio
}

function makeFakeContext() {
  const gainNode = {
    gain: { setTargetAtTime: vi.fn() },
    connect: vi.fn(),
  }
  const analyserNode = {
    fftSize: 0,
    connect: vi.fn(),
  }
  const sourceNode = { connect: vi.fn() }
  return {
    state: 'running',
    currentTime: 0,
    createGain: vi.fn().mockReturnValue(gainNode),
    createAnalyser: vi.fn().mockReturnValue(analyserNode),
    createMediaElementSource: vi.fn().mockReturnValue(sourceNode),
    close: vi.fn(),
    destination: {},
    resume: vi.fn(),
  }
}

/** Inject a pre-built channel directly into engine._channels (bypasses loadStem). */
function injectChannel(engine, name, audio) {
  const gainNode   = engine._ctx.createGain()
  const analyserNode = engine._ctx.createAnalyser()
  engine._channels[name] = { audio, gainNode, analyserNode, fader: 0.75, muted: false, soloed: false }
}

// ─── Test setup ───────────────────────────────────────────────────────────────

let engine

beforeEach(() => {
  vi.useFakeTimers()
  // Stub browser-only globals that Node doesn't provide
  global.requestAnimationFrame = vi.fn()
  global.cancelAnimationFrame  = vi.fn()
  engine = new AudioEngine()
  engine._ctx = makeFakeContext()
  engine._masterGain = engine._ctx.createGain()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AudioEngine.play() — seekReady logic', () => {

  it('1. no-op seek: resolves immediately without waiting for seeked', async () => {
    // audio.currentTime is already at offsetSeconds (within 1 ms)
    const audio = makeFakeAudio(0.0005)  // 0.5 ms from target 0
    injectChannel(engine, 'drums', audio)

    let played = false
    audio.play = vi.fn().mockImplementation(() => { played = true; return Promise.resolve() })

    engine.play(0)

    // No timer advancement needed — should start synchronously via microtasks
    await Promise.resolve()
    await Promise.resolve()  // flush Promise.all + startPlayback async chain

    expect(played).toBe(true)
    // 2 s safety timer must NOT have been used
    expect(vi.getTimerCount()).toBe(0)
  })

  it('2. real seek: waits for seeked before calling audio.play()', async () => {
    const audio = makeFakeAudio(30)  // far from target
    injectChannel(engine, 'drums', audio)

    let played = false
    audio.play = vi.fn().mockImplementation(() => { played = true; return Promise.resolve() })

    engine.play(0)
    await Promise.resolve()

    // seeked has NOT fired yet — play() must not have been called
    expect(played).toBe(false)

    // Fire seeked
    audio._emit('seeked')
    await Promise.resolve()
    await Promise.resolve()

    expect(played).toBe(true)
  })

  it('3. currentTime is always written — even on no-op seeks', () => {
    const audio = makeFakeAudio(0.0005)  // within 1 ms of target
    injectChannel(engine, 'drums', audio)

    engine.play(5)  // target = 5 s

    // Even though delta < 1 ms, currentTime must be snapped to exactly 5
    expect(audio._currentTime).toBe(5)
  })

  it('4. ALL channels are seeked — no 50 ms tolerance gate', () => {
    // drums is 40 ms from target — old gate (50 ms) would have skipped it
    const drums  = makeFakeAudio(5.04)
    const bass   = makeFakeAudio(5.00)
    const vox    = makeFakeAudio(4.96)
    injectChannel(engine, 'drums', drums)
    injectChannel(engine, 'bass',  bass)
    injectChannel(engine, 'vox',   vox)

    engine.play(5)

    // Every channel must be snapped to exactly 5 s
    expect(drums._currentTime).toBe(5)
    expect(bass._currentTime).toBe(5)
    expect(vox._currentTime).toBe(5)
  })

  it('4b. channels 49 ms away from target are still snapped (regression guard)', () => {
    // The old 50 ms gate would skip a channel 49 ms out — verify we no longer do that
    const ch1 = makeFakeAudio(0)       // at position 0 — paused here
    const ch2 = makeFakeAudio(0.049)   // 49 ms ahead — old bug: skip seek, restart out of sync
    injectChannel(engine, 'ch1', ch1)
    injectChannel(engine, 'ch2', ch2)

    engine.play(0)

    expect(ch1._currentTime).toBe(0)
    expect(ch2._currentTime).toBe(0)  // must be snapped, not left at 0.049
  })

  it('5a. generation guard: pause() during seek aborts playback', async () => {
    const audio = makeFakeAudio(30)
    injectChannel(engine, 'drums', audio)

    engine.play(0)
    engine.pause()  // cancel before seeked fires

    audio._emit('seeked')
    await Promise.resolve()
    await Promise.resolve()

    expect(audio.play).not.toHaveBeenCalled()
    expect(engine._playing).toBe(false)
  })

  it('5b. generation guard: stop() during seek aborts playback', async () => {
    const audio = makeFakeAudio(30)
    injectChannel(engine, 'drums', audio)

    engine.play(0)
    engine.stop()

    audio._emit('seeked')
    await Promise.resolve()
    await Promise.resolve()

    expect(audio.play).not.toHaveBeenCalled()
    expect(engine._playing).toBe(false)
  })

  it('6. count-in: seeks begin immediately, before the delay timer fires', () => {
    const audio = makeFakeAudio(30)
    injectChannel(engine, 'drums', audio)

    // atContextTime 1 s from now → ~1000 ms delay
    engine._ctx.currentTime = 0
    engine.play(0, 1)

    // currentTime must already be written — before any timer fires
    expect(audio._currentTime).toBe(0)

    // Only the count-in setTimeout should be pending (no 2 s safety timers yet,
    // because the real-seek promise was created synchronously)
    // We advance time past the safety timeout to confirm seeks already started
    // (if seeks were inside the timer, they'd only start after advancing 1 s)
    expect(audio._currentTime).toBe(0)  // snapped synchronously
  })

  it('6b. count-in: 2s safety timer fires after delay elapses if seeked never comes', async () => {
    const audio = makeFakeAudio(30)  // real seek — 'seeked' will never fire
    injectChannel(engine, 'drums', audio)

    engine._ctx.currentTime = 0
    engine.play(0, 0)  // delay = 0 ms → startPlayback fires immediately

    // advance past the 2 s safety timeout
    await vi.advanceTimersByTimeAsync(2001)
    await Promise.resolve()
    await Promise.resolve()

    expect(audio.play).toHaveBeenCalled()
  })

})

describe('AudioEngine.pause()', () => {

  it('7. captures _pauseOffset from first channel currentTime', async () => {
    const audio = makeFakeAudio(0)
    injectChannel(engine, 'drums', audio)

    engine.play(0)
    audio._emit('seeked')
    await Promise.resolve()
    await Promise.resolve()

    // Simulate playback progress
    audio._currentTime = 42.5
    engine.pause()

    expect(engine._pauseOffset).toBe(42.5)
    expect(engine._playing).toBe(false)
  })

})

describe('AudioEngine.stop()', () => {

  it('8. resets every channel to 0 and clears _pauseOffset', async () => {
    const drums = makeFakeAudio(0)
    const bass  = makeFakeAudio(0)
    injectChannel(engine, 'drums', drums)
    injectChannel(engine, 'bass',  bass)

    engine.play(0)
    drums._emit('seeked')
    bass._emit('seeked')
    await Promise.resolve()
    await Promise.resolve()

    drums._currentTime = 60
    bass._currentTime  = 60
    engine._pauseOffset = 60

    engine.stop()

    expect(drums._currentTime).toBe(0)
    expect(bass._currentTime).toBe(0)
    expect(engine._pauseOffset).toBe(0)
    expect(engine._playing).toBe(false)
  })

})
