import { supabase } from '../lib/supabase.js'
import { fetchAllVersions, buildVersionList, versionUrl } from '../lib/versions.js'
import { icon } from './icons.js'

/**
 * Renders the song picker page into `container`.
 * Fetches songs with has_stems=true from Supabase and renders a
 * filterable list. Clicking a song navigates to the mixer via hash routing.
 * Songs with extra stem versions get a chevron that opens a version menu;
 * tapping the card itself opens the song's default version.
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

  // One query for every song's version rows, grouped by slug. Songs without
  // rows have a single implicit "Original" version and render as before.
  const versionsBySlug = await fetchAllVersions()

  function renderList(filtered) {
    if (filtered.length === 0) {
      listEl.innerHTML = `<li class="gt-picker__empty">No results for “${searchEl.value}”</li>`
      return
    }
    listEl.innerHTML = filtered.map(song => {
      const versionRows = versionsBySlug.get(song.slug) ?? []
      const versionList = versionRows.length ? buildVersionList(versionRows) : null
      const defaultVersion = versionList?.find(v => v.isDefault)

      const meta = [
        song.artist,
        song.default_key ? `Key of ${song.default_key}` : null,
        song.tempo ? `${song.tempo} BPM` : null,
        song.time_signature || null,
        defaultVersion ? defaultVersion.label : null,
      ].filter(Boolean).join(' · ')

      const songBtn = `
        <button
          class="gt-picker__song-btn"
          data-url="/song/${song.slug}"
          aria-label="Open ${escHtml(song.title)}"
        >
          <span class="gt-picker__song-title">${escHtml(song.title)}</span>
          ${meta ? `<span class="gt-picker__song-meta">${escHtml(meta)}</span>` : ''}
        </button>
      `

      if (!versionList) {
        return `<li class="gt-picker__item" role="listitem">${songBtn}</li>`
      }

      const defaultSlug = defaultVersion.versionSlug
      return `
        <li class="gt-picker__item" role="listitem">
          <div class="gt-picker__song-row">
            ${songBtn}
            <button class="gt-picker__version-btn" aria-haspopup="menu" aria-expanded="false"
              aria-label="Choose version of ${escHtml(song.title)}">${icon('chevron-down')}</button>
            <div class="gt-picker__version-menu" role="menu" hidden>
              ${versionList.map(v => `
                <button class="gt-picker__version-item" role="menuitem"
                  data-url="${versionUrl(song.slug, v.versionSlug, defaultSlug)}">
                  ${escHtml(v.label)}${v.isDefault ? '<span class="gt-picker__version-default">default</span>' : ''}
                </button>
              `).join('')}
            </div>
          </div>
        </li>
      `
    }).join('')
  }

  function closeVersionMenus(except = null) {
    listEl.querySelectorAll('.gt-picker__version-menu:not([hidden])').forEach(menu => {
      if (menu === except) return
      menu.hidden = true
      menu.parentElement.querySelector('.gt-picker__version-btn')?.setAttribute('aria-expanded', 'false')
    })
  }

  // Delegated click handler — survives renderList re-renders.
  listEl.addEventListener('click', (e) => {
    const verBtn = e.target.closest('.gt-picker__version-btn')
    if (verBtn) {
      const menu = verBtn.parentElement.querySelector('.gt-picker__version-menu')
      const opening = menu.hidden
      closeVersionMenus(menu)
      menu.hidden = !opening
      verBtn.setAttribute('aria-expanded', String(opening))
      return
    }
    const navBtn = e.target.closest('[data-url]')
    if (navBtn) {
      closeVersionMenus() // the picker DOM is cached and reshown on Back
      history.pushState({}, '', navBtn.dataset.url)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }
  })

  document.addEventListener('click', (e) => {
    if (!listEl.contains(e.target)) closeVersionMenus()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeVersionMenus()
  })

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
