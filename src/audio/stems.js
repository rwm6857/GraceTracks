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
 *
 * @param {string} r2Base   - Base URL, e.g. https://assets.gracechords.com
 * @param {string} stemSlug - Subdirectory for this song's stems
 * @param {string} stemId   - Canonical stem ID (drums, perc, bass, …, vox, click, ambient)
 * @returns {Promise<{url: string, response: Response}|null>}
 */

const STEM_ALIASES = {
  drums: ['drum'],
  perc:  ['percussion'],
  synth: ['2nd', '2nd keys', '2nd-keys'],
  vox:   ['vocals', 'vocal'],
}

export async function resolveStemUrl(r2Base, stemSlug, stemId) {
  const candidates = [stemId, ...(STEM_ALIASES[stemId] ?? [])]

  for (const id of candidates) {
    for (const ext of ['m4a', 'wav']) {
      const url = `${r2Base}/tracks/${stemSlug}/${encodeURIComponent(id)}.${ext}`
      try {
        const res = await fetch(url)
        if (res.ok) return { url, response: res }
      } catch { /* network error — keep trying */ }
    }
  }

  return null
}
