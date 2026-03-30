import { supabase } from '../lib/supabase.js'

/**
 * Renders the song picker page into `container`.
 * Fetches songs with has_stems=true from Supabase and renders a
 * filterable list. Clicking a song navigates to the mixer via hash routing.
 */
export async function renderSongPicker(container) {
  container.innerHTML = `
    <div class="gt-picker">
      <header class="gt-picker__header">
        <h1 class="gt-picker__title">Songs</h1>
        <input
          type="search"
          class="gt-picker__search"
          placeholder="Search songs…"
          aria-label="Search songs"
        />
      </header>
      <div class="gt-picker__list-wrap">
        <ul class="gt-picker__list" role="list" aria-label="Song list"></ul>
      </div>
    </div>
  `

  const listEl = container.querySelector('.gt-picker__list')
  const searchEl = container.querySelector('.gt-picker__search')

  // — Loading state
  listEl.innerHTML = `<li class="gt-picker__loading">Loading songs…</li>`

  const { data: songs, error } = await supabase
    .from('songs')
    .select('slug, stem_slug, title, artist, tempo, time_signature, default_key, gracetracks_url')
    .eq('has_stems', true)
    .eq('is_deleted', false)
    .order('title')

  if (error) {
    listEl.innerHTML = `<li class="gt-picker__error">Failed to load songs. Please try again.</li>`
    console.error('[GraceTracks] Supabase error:', error)
    return
  }

  if (!songs || songs.length === 0) {
    listEl.innerHTML = `<li class="gt-picker__empty">No songs with stems yet.</li>`
    return
  }

  function renderList(filtered) {
    if (filtered.length === 0) {
      listEl.innerHTML = `<li class="gt-picker__empty">No results for “${searchEl.value}”</li>`
      return
    }
    listEl.innerHTML = filtered.map(song => {
      const meta = [
        song.artist,
        song.default_key ? `Key of ${song.default_key}` : null,
        song.tempo ? `${song.tempo} BPM` : null,
        song.time_signature || null,
      ].filter(Boolean).join(' · ')

      return `
        <li class="gt-picker__item" role="listitem">
          <button
            class="gt-picker__song-btn"
            data-slug="${song.slug}"
            aria-label="Open ${escHtml(song.title)}"
          >
            <span class="gt-picker__song-title">${escHtml(song.title)}</span>
            ${meta ? `<span class="gt-picker__song-meta">${escHtml(meta)}</span>` : ''}
          </button>
        </li>
      `
    }).join('')

    // Attach click handlers
    listEl.querySelectorAll('.gt-picker__song-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        window.location.hash = `#/song/${btn.dataset.slug}`
      })
    })
  }

  renderList(songs)

  // — Live search
  searchEl.addEventListener('input', () => {
    const q = searchEl.value.toLowerCase().trim()
    if (!q) { renderList(songs); return }
    const filtered = songs.filter(s =>
      s.title.toLowerCase().includes(q) ||
      (s.artist || '').toLowerCase().includes(q)
    )
    renderList(filtered)
  })
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
