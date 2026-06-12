/**
 * resolveStemUrl unit tests
 *
 * Verifies the format-fallback and alias-probing order:
 *   - for each candidate id, .m4a is tried before .wav
 *   - the canonical id is tried before its aliases
 *   - the first 200 response wins (url + Response returned)
 *   - network errors on one candidate don't abort the search
 *   - null is returned (with a warning) when nothing resolves
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolveStemUrl } from './stems.js'

const BASE = 'https://assets.example'
const SLUG = 'song-slug'

/** Make a fetch stub that returns ok for the given set of URLs. */
function okFor(...okUrls) {
  const set = new Set(okUrls)
  return vi.fn(async (url) => ({ ok: set.has(String(url)), url: String(url) }))
}

function urlFor(id, ext) {
  return `${BASE}/tracks/${SLUG}/${encodeURIComponent(id)}.${ext}`
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveStemUrl', () => {
  it('returns the .m4a URL when it exists (preferred over .wav)', async () => {
    global.fetch = okFor(urlFor('bass', 'm4a'), urlFor('bass', 'wav'))
    const res = await resolveStemUrl(BASE, SLUG, 'bass')
    expect(res?.url).toBe(urlFor('bass', 'm4a'))
    // .wav must never be requested once .m4a hits
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('falls back to .wav when .m4a is missing', async () => {
    global.fetch = okFor(urlFor('bass', 'wav'))
    const res = await resolveStemUrl(BASE, SLUG, 'bass')
    expect(res?.url).toBe(urlFor('bass', 'wav'))
    expect(global.fetch).toHaveBeenCalledTimes(2) // m4a (miss) then wav (hit)
  })

  it('probes aliases only after the canonical id, preserving m4a→wav order', async () => {
    // canonical "vox" 404s in both formats; alias "vocals" has a wav.
    global.fetch = okFor(urlFor('vocals', 'wav'))
    const res = await resolveStemUrl(BASE, SLUG, 'vox')
    expect(res?.url).toBe(urlFor('vocals', 'wav'))
    // vox.m4a, vox.wav, vocals.m4a, vocals.wav
    expect(global.fetch).toHaveBeenCalledTimes(4)
    expect(global.fetch).toHaveBeenNthCalledWith(1, urlFor('vox', 'm4a'))
    expect(global.fetch).toHaveBeenNthCalledWith(3, urlFor('vocals', 'm4a'))
  })

  it('keeps trying after a network error on one candidate', async () => {
    global.fetch = vi.fn(async (url) => {
      if (String(url) === urlFor('drums', 'm4a')) throw new Error('network')
      return { ok: String(url) === urlFor('drums', 'wav'), url: String(url) }
    })
    const res = await resolveStemUrl(BASE, SLUG, 'drums')
    expect(res?.url).toBe(urlFor('drums', 'wav'))
  })

  it('returns null and warns when no candidate resolves', async () => {
    global.fetch = okFor() // nothing ok
    const res = await resolveStemUrl(BASE, SLUG, 'click')
    expect(res).toBeNull()
    expect(console.warn).toHaveBeenCalled()
  })
})
