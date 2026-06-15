/**
 * resolveStemUrl
 *
 * Fetches the best available format of a stem file.
 * For each filename candidate (canonical ID first, then known aliases) it
 * tries .m4a before .wav, returning the first URL + Response that comes back
 * 200. Using a real GET (not HEAD) avoids CDN/R2 configurations that return
 * 404 for HEAD even when the object exists, and lets the service worker cache
 * the response so the audio engine can read it without a second download.
 * Returns null if nothing is found — the mixer will omit that channel strip.
 *
 * Alias map covers real-world R2 uploads that pre-date the canonical IDs:
 *   drums → drum
 *   perc  → percussion
 *   vox   → vocals / vocal
 *   md    → talkback / director / musicdirector
 *
 * @param {string} r2Base   - Base URL, e.g. https://assets.gracechords.com
 * @param {string} stemSlug - Subdirectory for this song's stems
 * @param {string} stemId   - Canonical stem ID (drums, perc, bass, …, vox, click, ambient)
 * @param {string|number|null} cacheToken - Optional cache-bust token appended as
 *   ?t=<token>; changes when stems are replaced so a new file isn't shadowed by
 *   the service worker's CacheFirst entry for the old one
 * @returns {Promise<{url: string, response: Response}|null>}
 */

export const STEM_IDS = ['drums', 'perc', 'bass', 'elec', 'keys', 'synth', 'vox', 'strings', 'md', 'click', 'ambient']

export const STEM_ALIASES = {
  drums: ['drum'],
  perc:  ['percussion'],
  synth: ['2nd', '2nd keys', '2nd-keys'],
  vox:   ['vocals', 'vocal'],
  md:    ['talkback', 'director', 'musicdirector'],
}

/**
 * Reverse lookup for maintenance UIs: map an R2 filename (e.g. "drum.m4a",
 * "2nd keys.wav") back to its canonical stem ID, or null if unrecognized.
 */
export function trackIdForFile(filename) {
  const base = String(filename).replace(/\.[^.]+$/, '').toLowerCase()
  for (const id of STEM_IDS) {
    if (base === id || (STEM_ALIASES[id] ?? []).includes(base)) return id
  }
  return null
}

export async function resolveStemUrl(r2Base, stemSlug, stemId, cacheToken = null) {
  const candidates = [stemId, ...(STEM_ALIASES[stemId] ?? [])]
  // A replaced stem overwrites the same R2 key, so its URL is byte-for-byte
  // identical — the service worker's CacheFirst rule would then keep serving
  // the old audio. Appending a token that changes when stems are replaced
  // (songs.stems_updated_at) gives the new file a fresh URL / cache entry.
  const suffix = cacheToken ? `?t=${encodeURIComponent(cacheToken)}` : ''

  for (const id of candidates) {
    for (const ext of ['m4a', 'wav']) {
      const url = `${r2Base}/tracks/${stemSlug}/${encodeURIComponent(id)}.${ext}${suffix}`
      try {
        const res = await fetch(url)
        if (res.ok) return { url, response: res }
      } catch { /* network error — keep trying */ }
    }
  }

  console.warn(`[GraceTracks] stem "${stemId}" not found in "${stemSlug}" — channel will be omitted`)
  return null
}
