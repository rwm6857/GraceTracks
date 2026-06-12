/**
 * Metronome unit tests
 *
 * Focus:
 *   - countIn schedules one click per beat (accent on beat 1) and fires the
 *     onBeat/onReady callbacks at the right times
 *   - start() schedules the first beat via the lookahead loop; stop() halts it
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Metronome } from './metronome.js'

/** Fake AudioContext recording oscillator scheduling. */
function makeCtx() {
  const oscillators = []
  return {
    currentTime: 0,
    destination: {},
    createOscillator() {
      const osc = {
        frequency: { value: 0 },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      }
      oscillators.push(osc)
      return osc
    },
    createGain() {
      return {
        gain: {
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
      }
    },
    _oscillators: oscillators,
  }
}

let ctx
let metro

beforeEach(() => {
  vi.useFakeTimers()
  ctx = makeCtx()
  metro = new Metronome(ctx, ctx.destination)
})
afterEach(() => {
  metro.stop()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Metronome.countIn', () => {
  it('schedules one click per beat with an accent on the downbeat', () => {
    metro.countIn(120, 4, () => {}, () => {})
    // 4 beats → 4 oscillators
    expect(ctx._oscillators).toHaveLength(4)
    // beat 1 is the accent (1000 Hz), the rest are 800 Hz
    expect(ctx._oscillators[0].frequency.value).toBe(1000)
    expect(ctx._oscillators[1].frequency.value).toBe(800)
    // first click is scheduled at the +0.1s buffer
    expect(ctx._oscillators[0].start).toHaveBeenCalledWith(0.1)
    // each subsequent beat is one beat-duration (0.5s @ 120bpm) later
    expect(ctx._oscillators[1].start).toHaveBeenCalledWith(0.6)
  })

  it('fires onBeat per beat and onReady once after the count-in', () => {
    const onBeat = vi.fn()
    const onReady = vi.fn()
    metro.countIn(120, 4, onBeat, onReady)

    // Nothing has fired yet (callbacks are on setTimeout).
    expect(onBeat).not.toHaveBeenCalled()

    // Advance past the whole count-in: 0.1 + 4*0.5 = 2.1s → 2100ms.
    vi.advanceTimersByTime(2100)

    expect(onBeat).toHaveBeenCalledTimes(4)
    expect(onBeat).toHaveBeenNthCalledWith(1, { beat: 1, total: 4 })
    expect(onBeat).toHaveBeenNthCalledWith(4, { beat: 4, total: 4 })
    // onReady gets the AudioContext time at which playback should begin.
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(onReady).toHaveBeenCalledWith(2.1)
  })
})

describe('Metronome start/stop', () => {
  it('schedules the first beat on start() and stops scheduling on stop()', () => {
    const onBeat = vi.fn()
    metro.onBeat = onBeat

    metro.start(120, 4)
    // The lookahead loop schedules the beat at currentTime (0) immediately.
    expect(onBeat).toHaveBeenCalledWith(1)
    expect(ctx._oscillators.length).toBeGreaterThanOrEqual(1)

    const scheduledBefore = ctx._oscillators.length
    metro.stop()
    // After stop, advancing the scheduler interval must not schedule more.
    vi.advanceTimersByTime(500)
    expect(ctx._oscillators.length).toBe(scheduledBefore)
  })
})
