/**
 * engineFactory unit tests
 *
 * Covers capability detection (streamingSupported) and engine selection
 * (createEngine): forced overrides via ?engine= / localStorage, and the
 * "streaming where supported, phase-lock otherwise" default.
 *
 * The two concrete engines are mocked so the factory's selection logic can be
 * tested without WebCodecs / AudioWorklet / mp4box.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./stream/streamEngine.js', () => ({
  StreamAudioEngine: class { constructor() { this.kind = 'stream' } },
}))
vi.mock('./engine.js', () => ({
  AudioEngine: class { constructor() { this.kind = 'phase' } },
}))

import { streamingSupported, createEngine } from './engineFactory.js'

const ORIGINAL = {
  AudioWorkletNode: globalThis.AudioWorkletNode,
  AudioDecoder: globalThis.AudioDecoder,
  location: globalThis.location,
  localStorage: globalThis.localStorage,
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  delete globalThis.AudioWorkletNode
  delete globalThis.AudioDecoder
  delete globalThis.location
  delete globalThis.localStorage
})

afterEach(() => {
  for (const [k, v] of Object.entries(ORIGINAL)) {
    if (v === undefined) delete globalThis[k]
    else globalThis[k] = v
  }
  vi.restoreAllMocks()
})

function enableStreamingGlobals(supported = true) {
  globalThis.AudioWorkletNode = class {}
  globalThis.AudioDecoder = {
    isConfigSupported: vi.fn().mockResolvedValue({ supported }),
  }
}

describe('streamingSupported', () => {
  it('is false when AudioWorkletNode is unavailable', async () => {
    expect(await streamingSupported()).toBe(false)
  })

  it('is false when AudioDecoder is unavailable', async () => {
    globalThis.AudioWorkletNode = class {}
    expect(await streamingSupported()).toBe(false)
  })

  it('is true when AudioWorklet + WebCodecs AAC are supported', async () => {
    enableStreamingGlobals(true)
    expect(await streamingSupported()).toBe(true)
  })

  it('is false when the codec config is unsupported', async () => {
    enableStreamingGlobals(false)
    expect(await streamingSupported()).toBe(false)
  })

  it('is false when isConfigSupported throws', async () => {
    globalThis.AudioWorkletNode = class {}
    globalThis.AudioDecoder = { isConfigSupported: vi.fn().mockRejectedValue(new Error('x')) }
    expect(await streamingSupported()).toBe(false)
  })
})

describe('createEngine', () => {
  it('honours ?engine=phase even when streaming is supported', async () => {
    enableStreamingGlobals(true)
    globalThis.location = { search: '?engine=phase' }
    const engine = await createEngine()
    expect(engine.kind).toBe('phase')
  })

  it('honours ?engine=stream', async () => {
    globalThis.location = { search: '?engine=stream' }
    const engine = await createEngine()
    expect(engine.kind).toBe('stream')
  })

  it('honours a localStorage engine override', async () => {
    globalThis.localStorage = { getItem: vi.fn().mockReturnValue('phase') }
    enableStreamingGlobals(true)
    const engine = await createEngine()
    expect(engine.kind).toBe('phase')
  })

  it('defaults to the streaming engine where the browser supports it', async () => {
    enableStreamingGlobals(true)
    const engine = await createEngine()
    expect(engine.kind).toBe('stream')
  })

  it('falls back to the phase-lock engine when streaming is unsupported', async () => {
    // No streaming globals → streamingSupported() resolves false.
    const engine = await createEngine()
    expect(engine.kind).toBe('phase')
  })
})
