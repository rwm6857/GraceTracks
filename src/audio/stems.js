/**
 * resolveStemUrl
 *
 * Probes for the best available format of a stem file.
 * Tries .m4a first (smaller / AAC), falls back to .wav.
 * Returns the resolved URL string, or null if neither format exists.
 *
 * @param {string} r2Base   - Base URL, e.g. https://assets.gracechords.com
 * @param {string} stemSlug - Subdirectory for this song's stems
 * @param {string} stemId   - Canonical stem ID (drums, perc, bass, …, vox, click, ambient)
 * @returns {Promise<string|null>}
 */
export async function resolveStemUrl(r2Base, stemSlug, stemId) {
  const m4aUrl = `${r2Base}/tracks/${stemSlug}/${stemId}.m4a`
  const wavUrl = `${r2Base}/tracks/${stemSlug}/${stemId}.wav`

  try {
    const res = await fetch(m4aUrl, { method: 'HEAD' })
    if (res.ok) return m4aUrl
  } catch { /* network error — try wav */ }

  try {
    const res = await fetch(wavUrl, { method: 'HEAD' })
    if (res.ok) return wavUrl
  } catch { /* network error */ }

  return null
}
