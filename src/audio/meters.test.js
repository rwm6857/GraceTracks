/**
 * Meters unit tests
 *
 * The meter loop reads each loaded channel's AnalyserNode time-domain data,
 * computes an RMS, and reports it as dBFS via onUpdate. These tests drive a
 * fake engine + analysers and assert the dBFS math and lifecycle.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Meters } from './meters.js'

/** Analyser stub that fills the supplied Float32Array with `samples`. */
function makeAnalyser(samples) {
  return {
    frequencyBinCount: samples.length,
    getFloatTimeDomainData(arr) {
      for (let i = 0; i < arr.length; i++) arr[i] = samples[i] ?? 0
    },
  }
}

function makeEngine(channels) {
  return {
    getLoadedChannels: () => Object.keys(channels),
    getAnalyser: (name) => channels[name] ?? null,
  }
}

beforeEach(() => {
  global.requestAnimationFrame = vi.fn().mockReturnValue(1)
  global.cancelAnimationFrame = vi.fn()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('Meters', () => {
  it('reports 0 dBFS for a full-scale signal and -Infinity for silence', () => {
    const engine = makeEngine({
      hot: makeAnalyser([1, 1, 1, 1]),   // RMS 1.0 → 0 dBFS
      silent: makeAnalyser([0, 0, 0, 0]), // RMS 0   → -Infinity
    })
    const meters = new Meters(engine)
    const updates = []
    meters.onUpdate = (levels) => updates.push(levels)

    meters.start()

    expect(updates).toHaveLength(1)
    expect(updates[0].hot).toBeCloseTo(0, 5)
    expect(updates[0].silent).toBe(-Infinity)
    meters.stop()
  })

  it('skips channels that have no analyser', () => {
    const engine = makeEngine({ present: makeAnalyser([0.5, 0.5]), missing: null })
    const meters = new Meters(engine)
    let last = null
    meters.onUpdate = (levels) => { last = levels }

    meters.start()

    expect('present' in last).toBe(true)
    expect('missing' in last).toBe(false)
    meters.stop()
  })

  it('start() schedules the RAF loop; stop() cancels it', () => {
    const engine = makeEngine({ ch: makeAnalyser([0.1]) })
    const meters = new Meters(engine)
    meters.onUpdate = () => {}

    meters.start()
    expect(global.requestAnimationFrame).toHaveBeenCalledTimes(1)

    // A second start() is a no-op (already active).
    meters.start()
    expect(global.requestAnimationFrame).toHaveBeenCalledTimes(1)

    meters.stop()
    expect(global.cancelAnimationFrame).toHaveBeenCalled()
  })
})
