/**
 * Word-prefix song search — a trimmed copy of the GraceChords search ranking
 * (src/utils/songs/search.js) so the upload picker behaves like the search
 * bars across the GraceChords site. A result is included only when the query
 * (or each of its space-separated tokens) matches the START of at least one
 * word in the title or artist — never an arbitrary mid-word position.
 *
 * Scoring (lower = better):
 *   0 – normalized title starts with the full query
 *   1 – every query token is a word-prefix in the title
 *   2 – any query token is a word-prefix in the title
 *   4 – any query token is a word-prefix in the artist
 *
 * Returns Array<song> sorted best-match first. Returns [] for a blank query
 * (callers should show the full list themselves).
 */

function norm(str) {
  return (str || '')
    .toLowerCase()
    .replace(/['‘’ʼ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function wordList(str) {
  return norm(str).split(' ').filter(Boolean)
}

function anyWordStartsWith(words, token) {
  for (let i = 0; i < words.length; i++) {
    if (words[i].startsWith(token)) return true
  }
  return false
}

function scoreItem(item, q, tokens) {
  const titleNorm = norm(item.title)
  const titleWords = wordList(item.title)

  if (titleNorm.startsWith(q)) return 0
  if (tokens.every(t => anyWordStartsWith(titleWords, t))) return 1
  if (tokens.some(t => anyWordStartsWith(titleWords, t))) return 2

  const artistWords = wordList(item.artist)
  if (tokens.some(t => anyWordStartsWith(artistWords, t))) return 4

  return Infinity
}

export function searchSongs(items, query) {
  const q = norm(query)
  if (!q) return []
  const tokens = q.split(' ').filter(Boolean)

  const scored = []
  for (let i = 0; i < items.length; i++) {
    const score = scoreItem(items[i], q, tokens)
    if (score < Infinity) scored.push({ item: items[i], score })
  }

  // Stable-ish: equal scores fall back to alphabetical title order.
  scored.sort((a, b) => a.score - b.score || norm(a.item.title).localeCompare(norm(b.item.title)))
  return scored.map(s => s.item)
}
