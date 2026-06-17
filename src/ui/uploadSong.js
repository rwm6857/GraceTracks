import { supabase } from '../lib/supabase.js'
import { getSession, isEditorPlus } from '../lib/auth.js'
import { searchSongs } from '../lib/songSearch.js'
import { isM4aEncodeSupported, wavFileToM4a } from '../audio/encodeM4a.js'
import { icon, channelIcon } from './icons.js'
import {
  VERSION_RE,
  buildVersionList,
  fetchSongVersions,
  setDefaultVersion,
  versionUrl,
} from '../lib/versions.js'
import {
  listStemFiles,
  statStemFiles,
  deleteStemFiles,
  deleteVersionStems,
  deleteSongStems,
} from '../lib/stemsApi.js'
import { trackIdForFile } from '../audio/stems.js'
import { confirmModal } from './confirmModal.js'

// Where the inline "Create a new song" link points (the GraceChords editor).
const NEW_SONG_URL = 'https://gracechords.com/portal/editor'

// sessionStorage key for the lightweight selection snapshot (song + version
// target) so an accidental reload restores the context. File objects can't be
// serialized, so the chosen stems must be re-added after a hard reload.
const STATE_KEY = 'gt-upload-state'

const TRACKS = [
  { id: 'drums',   label: 'Drums' },
  { id: 'perc',    label: 'Percussion' },
  { id: 'bass',    label: 'Bass' },
  { id: 'elec',    label: 'Electric Guitar' },
  { id: 'keys',    label: 'Keys / Piano' },
  { id: 'synth',   label: 'Synth' },
  { id: 'vox',     label: 'Vocals' },
  { id: 'strings', label: 'Strings' },
  { id: 'md',      label: 'MD' },
  { id: 'click',   label: 'Click Track' },
  { id: 'ambient', label: 'Ambient' },
]

const AUDIO_TYPES = {
  'm4a': 'audio/mp4',
  'wav': 'audio/wav',
}

const MAX_RESULTS = 8

// Per-tile state: { file: File | null, status: 'empty'|'selected'|'uploading'|'done'|'error', error: string }
let tileState = {}

// The GraceChords song these recordings attach to, or null while creating new.
// { slug, title, artist, stem_slug, has_stems }
let selectedSong = null
// 'select' (attach to an existing song) | 'new' (create a brand-new song row)
let mode = 'select'
// Where the stems go when the selected song already has some:
// { kind: 'new', label } adds a named version; { kind: 'replace', versionSlug }
// overwrites an existing one (versionSlug null = the legacy Original stems).
let versionChoice = { kind: 'replace', versionSlug: null }
// song_versions rows for the selected song
let songVersions = []
// Files already in the targeted R2 version folder, keyed by track id
// (e.g. { drums: ['drums.m4a'] }). Only populated for "replace" targets.
let existingFiles = {}
// Bumped whenever the replace target changes so stale list responses are ignored.
let existingSeq = 0

function resetState() {
  tileState = Object.fromEntries(TRACKS.map(t => [t.id, { file: null, status: 'empty', error: '' }]))
  selectedSong = null
  mode = 'select'
  versionChoice = { kind: 'replace', versionSlug: null }
  songVersions = []
  existingFiles = {}
  existingSeq++
}

// ─── Selection persistence (survives reload / back-forward) ───────────────────
// Only the song slug + version target are saved; chosen files can't be
// serialized and must be re-added after a hard reload.
function saveSelection() {
  try {
    if (!selectedSong) { sessionStorage.removeItem(STATE_KEY); return }
    sessionStorage.setItem(STATE_KEY, JSON.stringify({
      slug: selectedSong.slug,
      versionChoice,
    }))
  } catch { /* private mode / quota — non-fatal */ }
}
function loadSelection() {
  try {
    const raw = sessionStorage.getItem(STATE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}
function clearSelection() {
  try { sessionStorage.removeItem(STATE_KEY) } catch { /* non-fatal */ }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// Poll the version folder until the named files no longer appear. R2 is strongly
// consistent so this usually passes on the first check; the retries just absorb
// any propagation hiccup. Throws if they never clear.
async function waitUntilGone(stemSlug, versionSlug, names, { tries = 8, delayMs = 350 } = {}) {
  for (let i = 0; i < tries; i++) {
    const present = await statStemFiles(stemSlug, versionSlug)
    if (!present.some(f => names.includes(f.name))) return
    await sleep(delayMs)
  }
  throw new Error('Timed out waiting for the old stem to delete — try again')
}

// Confirm a freshly-uploaded object is present at the expected byte size (R2
// stores the body verbatim, so the stored size must equal what we sent — a
// mismatch means a partial/failed write). Throws if it can't be confirmed.
async function confirmUploaded(stemSlug, versionSlug, name, expectedSize, { tries = 8, delayMs = 350 } = {}) {
  for (let i = 0; i < tries; i++) {
    const f = (await statStemFiles(stemSlug, versionSlug)).find(x => x.name === name)
    if (f) {
      if (expectedSize && f.size !== expectedSize) {
        throw new Error(`Uploaded ${name} size mismatch on server (${f.size} vs ${expectedSize} bytes)`)
      }
      if (f.size > 0) return f.size
    }
    await sleep(delayMs)
  }
  throw new Error(`Could not confirm ${name} on the server after upload`)
}

// Bump the song's cache-bust token (best effort) so the mixer re-fetches stems
// after a change instead of serving the service worker's cached copies.
async function touchStems(slug) {
  if (!slug) return
  const { error } = await supabase
    .from('songs')
    .update({ stems_updated_at: new Date().toISOString() })
    .eq('slug', slug)
  if (error) console.warn('[GraceTracks] could not bump stems_updated_at:', error)
}

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Renders the upload page into `container`.
 * @param {HTMLElement} container
 * @param {import('../lib/auth.js').User | null} user - current signed-in user
 */
export async function renderUploadSong(container, user, { fresh = false } = {}) {
  resetState()
  if (fresh) clearSelection()

  if (!user || !isEditorPlus(user)) {
    container.innerHTML = `
      <div class="gt-upload gt-upload--denied">
        <p class="gt-upload__denied-msg">You need editor access to upload songs.</p>
      </div>
    `
    return
  }

  const convertWav = isM4aEncodeSupported()

  container.innerHTML = `
    <div class="gt-upload">
      <header class="gt-upload__header">
        <h1 class="gt-upload__title">Upload Recordings</h1>
      </header>

      <section class="gt-upload__section">
        <h2 class="gt-upload__section-title">Search for a Song</h2>

        <div class="gt-upload__song-search" id="song-search">
          <input
            type="search"
            class="gt-upload__input gt-upload__search-input"
            id="song-search-input"
            placeholder="Search songs…"
            aria-label="Search songs"
            autocomplete="off"
          />
          <ul class="gt-upload__search-results" id="song-search-results" role="listbox" hidden></ul>
        </div>

        <div class="gt-upload__selected" id="selected-song" hidden>
          <div class="gt-upload__selected-info">
            <span class="gt-upload__selected-title" id="selected-title"></span>
            <span class="gt-upload__selected-meta" id="selected-meta"></span>
          </div>
          <button type="button" class="gc-btn gc-btn--ghost gc-btn--sm" id="selected-change">Clear</button>
        </div>

        <div class="gt-upload__version-block" id="version-block" hidden></div>

        <a class="gt-upload__newlink" id="new-song-link" href="${NEW_SONG_URL}" target="_blank" rel="noopener">
          Can’t find it? Create a new song in the editor
        </a>
      </section>

      <section class="gt-upload__section">
        <h2 class="gt-upload__section-title">Stems</h2>
        <p class="gt-upload__hint">
          Drop a <code>.m4a</code> or <code>.wav</code> file onto each instrument. At least one stem is required.
        </p>
        <div class="gt-upload__stems" id="stems-grid"></div>
      </section>

      <div class="gt-upload__footer">
        <p class="gt-upload__form-error" id="upload-form-error" hidden></p>
        <button class="gc-btn gc-btn--primary gt-upload__submit" id="upload-submit" disabled>
          Upload Recordings
        </button>
      </div>

      <div class="gt-upload__success" id="upload-success" hidden>
        <p class="gt-upload__success-msg">Recordings uploaded successfully!</p>
        <a class="gc-btn gc-btn--ghost" id="upload-open-mixer">Open in Mixer ${icon('arrow-right')}</a>
      </div>
    </div>
  `

  // ─── Element refs ──────────────────────────────────────────────────────────
  const searchWrap  = container.querySelector('#song-search')
  const searchInput = container.querySelector('#song-search-input')
  const resultsEl   = container.querySelector('#song-search-results')
  const selectedEl  = container.querySelector('#selected-song')
  const selTitleEl  = container.querySelector('#selected-title')
  const selMetaEl   = container.querySelector('#selected-meta')
  const changeBtn   = container.querySelector('#selected-change')

  const versionBlock = container.querySelector('#version-block')
  const stemsGrid = container.querySelector('#stems-grid')
  const submitBtn = container.querySelector('#upload-submit')
  const formError = container.querySelector('#upload-form-error')
  const successEl = container.querySelector('#upload-success')
  const openBtn   = container.querySelector('#upload-open-mixer')

  // ─── Load the GraceChords catalog for search ─────────────────────────────────
  // Editors can read every song (the editor RLS policy grants SELECT for all
  // rows), so unlike the public picker we don't filter on has_stems here — the
  // whole point is to attach stems to songs that may not have any yet.
  let catalog = []
  const { data: songs, error: catErr } = await supabase
    .from('songs')
    .select('slug, title, artist, has_stems, stem_slug')
    .eq('is_deleted', false)
    .order('title')
  if (catErr) {
    console.error('[GraceTracks] failed to load song catalog:', catErr)
    searchInput.placeholder = 'Could not load songs — try reloading'
    searchInput.disabled = true
  } else {
    catalog = songs ?? []
  }

  // ─── Song search combobox ────────────────────────────────────────────────────
  function renderResults(list) {
    if (list.length === 0) {
      resultsEl.hidden = true
      resultsEl.innerHTML = ''
      return
    }
    resultsEl.innerHTML = list.map(s => {
      const meta = [s.artist, s.has_stems ? 'has stems' : null].filter(Boolean).join(' · ')
      return `
        <li class="gt-upload__search-item" role="option" data-slug="${escHtml(s.slug)}">
          <span class="gt-upload__search-title">${escHtml(s.title)}</span>
          ${meta ? `<span class="gt-upload__search-meta">${escHtml(meta)}</span>` : ''}
        </li>
      `
    }).join('')
    resultsEl.hidden = false

    resultsEl.querySelectorAll('.gt-upload__search-item').forEach(li => {
      li.addEventListener('click', () => {
        const song = catalog.find(s => s.slug === li.dataset.slug)
        if (song) selectSong(song)
      })
    })
  }

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim()
    if (!q) { renderResults([]); return }
    renderResults(searchSongs(catalog, q).slice(0, MAX_RESULTS))
  })

  // Hide the dropdown when focus leaves the search area.
  document.addEventListener('click', (e) => {
    if (searchWrap && !searchWrap.contains(e.target)) resultsEl.hidden = true
  })

  function selectSong(song, restoredChoice = null) {
    selectedSong = song
    mode = 'select'
    selTitleEl.textContent = song.title
    selMetaEl.textContent = [song.artist, song.has_stems ? 'already has stems' : null]
      .filter(Boolean).join(' · ')
    selectedEl.hidden = false
    searchWrap.hidden = true
    resultsEl.hidden = true
    formError.hidden = true

    // Songs that already have stems pick a version target — defaulting to the
    // Original. First-time uploads go straight to the legacy path as Original.
    songVersions = []
    versionChoice = restoredChoice
      ?? { kind: 'replace', versionSlug: null }
    versionBlock.hidden = !song.has_stems
    if (song.has_stems) {
      versionBlock.innerHTML = `<p class="gt-upload__hint">Loading versions…</p>`
      fetchSongVersions(song.slug).then(rows => {
        if (selectedSong?.slug !== song.slug) return // selection changed meanwhile
        songVersions = rows
        renderVersionBlock()
        updateSubmitState()
      })
    }
    refreshExistingStems()
    updateSubmitState()
    saveSelection()
  }

  function clearVersionBlock() {
    songVersions = []
    versionChoice = { kind: 'replace', versionSlug: null }
    versionBlock.hidden = true
    versionBlock.innerHTML = ''
  }

  // ─── Existing stems on the server (replace targets only) ─────────────────────
  // The song's R2 folder (stem_slug survives a full stem deletion so re-uploads
  // land back in the same folder).
  function r2Folder() {
    return selectedSong ? (selectedSong.stem_slug || selectedSong.slug) : null
  }

  function replaceTargetLabel() {
    if (versionChoice.versionSlug == null) return 'Original'
    return songVersions.find(r => r.version_slug === versionChoice.versionSlug)?.label
      ?? versionChoice.versionSlug
  }

  // Refresh which files already sit in the targeted version folder, so tiles
  // can show them (and offer per-stem deletion). Anything that isn't a
  // replace target — new version, new song, no selection — just clears.
  async function refreshExistingStems() {
    const seq = ++existingSeq
    existingFiles = {}
    const isReplaceTarget = mode === 'select' && selectedSong?.has_stems && versionChoice.kind === 'replace'
    TRACKS.forEach(renderTile)
    if (!isReplaceTarget) return
    try {
      const names = await listStemFiles(r2Folder(), versionChoice.versionSlug)
      if (seq !== existingSeq) return // target changed meanwhile
      for (const name of names) {
        const id = trackIdForFile(name)
        if (id) (existingFiles[id] ??= []).push(name)
      }
      TRACKS.forEach(renderTile)
    } catch (err) {
      console.warn('[GraceTracks] could not list existing stems:', err)
    }
  }

  changeBtn.addEventListener('click', () => {
    selectedSong = null
    selectedEl.hidden = true
    searchWrap.hidden = false
    searchInput.value = ''
    renderResults([])
    clearVersionBlock()
    refreshExistingStems()
    searchInput.focus()
    updateSubmitState()
    clearSelection()
  })

  // ─── Version block (existing songs with stems) ───────────────────────────────
  // Delete every stem + version for the song (triggered by deleting Original,
  // the base recording). The GraceChords song row is left intact; stem_slug is
  // kept so a later re-upload lands back in the same R2 folder.
  async function deleteAllStems() {
    formError.hidden = true
    try {
      await deleteSongStems(r2Folder())
      let { error } = await supabase
        .from('song_versions')
        .delete()
        .eq('song_slug', selectedSong.slug)
      if (error) throw new Error(error.message)
      ;({ error } = await supabase
        .from('songs')
        .update({ has_stems: false, gracetracks_url: null })
        .eq('slug', selectedSong.slug))
      if (error) throw new Error(error.message)
    } catch (err) {
      formError.textContent = `Could not delete stems: ${err.message}`
      formError.hidden = false
      return
    }
    selectedSong.has_stems = false
    const catRow = catalog.find(s => s.slug === selectedSong.slug)
    if (catRow) catRow.has_stems = false
    selMetaEl.textContent = selectedSong.artist ?? ''
    clearVersionBlock()
    refreshExistingStems()
    updateSubmitState()
    saveSelection()
  }

  // Delete a single named version (its stem files + DB row).
  async function deleteNamedVersion(vSlug) {
    formError.hidden = true
    try {
      await deleteVersionStems(r2Folder(), vSlug)
      const { error } = await supabase
        .from('song_versions')
        .delete()
        .eq('song_slug', selectedSong.slug)
        .eq('version_slug', vSlug)
      if (error) throw new Error(error.message)
      await touchStems(selectedSong.slug)
    } catch (err) {
      formError.textContent = `Could not delete version: ${err.message}`
      formError.hidden = false
      return
    }
    // If the deleted version was the target or the flagged default, fall back
    // to Original (no flagged row safely means Original is default).
    if (versionChoice.kind === 'replace' && versionChoice.versionSlug === vSlug) {
      versionChoice = { kind: 'replace', versionSlug: null }
    }
    songVersions = await fetchSongVersions(selectedSong.slug)
    renderVersionBlock()
    refreshExistingStems()
    updateSubmitState()
    saveSelection()
  }

  function renderVersionBlock() {
    if (!selectedSong?.has_stems) { clearVersionBlock(); return }
    const versionList = buildVersionList(songVersions)
    const isNew = versionChoice.kind === 'new'

    versionBlock.innerHTML = `
      <span class="gt-upload__label">Version</span>
      <div class="gt-upload__versions" role="radiogroup" aria-label="Version target">
        ${versionList.map(v => {
          const isOriginal = v.versionSlug == null
          const checked = !isNew && (versionChoice.versionSlug ?? null) === v.versionSlug
          return `
            <div class="gt-upload__version-row">
              <label class="gt-upload__version-pick">
                <input type="radio" name="version-choice" value="replace:${v.versionSlug ?? 'original'}" ${checked ? 'checked' : ''} />
                <span>${escHtml(v.label)}</span>
              </label>
              <div class="gt-upload__version-actions">
                ${v.isDefault
                  ? '<span class="gt-upload__version-badge">default</span>'
                  : `<button type="button" class="gc-btn gc-btn--ghost gc-btn--sm gt-upload__version-make-default"
                       data-v="${v.versionSlug ?? ''}">Make default</button>`}
                <button type="button" class="gt-upload__version-delete"
                  data-v="${escHtml(v.versionSlug ?? '')}" data-original="${isOriginal}"
                  title="Delete" aria-label="Delete ${escHtml(v.label)}">${icon('trash')}</button>
              </div>
            </div>
          `
        }).join('')}
        <div class="gt-upload__version-row">
          <label class="gt-upload__version-pick">
            <input type="radio" name="version-choice" value="new" ${isNew ? 'checked' : ''} />
            <span>Add new version</span>
          </label>
          <input id="version-label" class="gt-upload__input gt-upload__version-name" type="text"
            placeholder="AGMC2026" aria-label="New version name"
            value="${escHtml(versionChoice.label ?? '')}" ${isNew ? '' : 'hidden'} />
        </div>
      </div>
    `

    const labelInput = versionBlock.querySelector('#version-label')
    labelInput.addEventListener('input', () => {
      versionChoice.label = labelInput.value
      updateSubmitState()
      saveSelection()
    })

    versionBlock.querySelectorAll('input[name="version-choice"]').forEach(input => {
      input.addEventListener('change', () => {
        if (input.value === 'new') {
          versionChoice = { kind: 'new', label: versionChoice.label ?? '' }
        } else {
          const v = input.value.slice('replace:'.length)
          versionChoice = { kind: 'replace', versionSlug: v === 'original' ? null : v }
        }
        renderVersionBlock() // shows/hides the inline new-version name input
        refreshExistingStems()
        updateSubmitState()
        saveSelection()
      })
    })

    versionBlock.querySelectorAll('.gt-upload__version-make-default').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true
        const err = await setDefaultVersion(selectedSong.slug, btn.dataset.v || null)
        if (err) {
          formError.textContent = `Could not set default: ${err.message}`
          formError.hidden = false
          btn.disabled = false
          return
        }
        songVersions = await fetchSongVersions(selectedSong.slug)
        renderVersionBlock()
      })
    })

    versionBlock.querySelectorAll('.gt-upload__version-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        const isOriginal = btn.dataset.original === 'true'
        const vSlug = btn.dataset.v
        if (isOriginal) {
          const ok = await confirmModal({
            title: 'Delete recordings',
            message: `This action will remove all recordings of “${selectedSong.title}” and its versions from GraceTracks. Proceed?`,
          })
          if (!ok) return
          btn.disabled = true
          await deleteAllStems()
        } else {
          const row = songVersions.find(r => r.version_slug === vSlug)
          if (!row) return
          const ok = await confirmModal({
            title: 'Delete version',
            message: `Do you really want to delete ${selectedSong.title} – ${row.label}?`,
          })
          if (!ok) return
          btn.disabled = true
          await deleteNamedVersion(vSlug)
        }
      })
    })
  }

  // ─── Submit gating ───────────────────────────────────────────────────────────
  function songIsChosen() {
    return !!selectedSong
  }
  function updateSubmitState() {
    const hasStem = TRACKS.some(t => tileState[t.id].file)
    // Adding a new version requires a name that survives slugification.
    const needsLabel = selectedSong?.has_stems && versionChoice.kind === 'new'
    const versionOk = !needsLabel || Boolean(slugify(versionChoice.label ?? ''))
    submitBtn.disabled = !(songIsChosen() && hasStem && versionOk)
  }

  // ─── Stem tiles ──────────────────────────────────────────────────────────────
  function renderTile(track) {
    const state = tileState[track.id]
    const tile = stemsGrid.querySelector(`[data-track="${track.id}"]`) ??
      (() => { const el = document.createElement('div'); el.dataset.track = track.id; stemsGrid.appendChild(el); return el })()

    const existing = existingFiles[track.id] ?? []
    const hasExisting = state.status === 'empty' && existing.length > 0
    tile.className = `gt-upload__stem gt-upload__stem--${state.status}` +
      (hasExisting ? ' gt-upload__stem--existing' : '')

    // What this file will be renamed to in R2 (instrument slot drives the name).
    const ext = state.file ? state.file.name.split('.').pop().toLowerCase() : ''
    const willConvert = convertWav && ext === 'wav'
    const targetName = `${track.id}.${willConvert ? 'm4a' : ext}`

    let bodyHtml = ''
    if (hasExisting) {
      bodyHtml = `
        <span class="gt-upload__stem-existing">${icon('check', { className: 'gt-icon' })} On server</span>
        <span class="gt-upload__stem-filename" title="${escHtml(existing.join(', '))}">${escHtml(existing.join(', '))}</span>
        <span class="gt-upload__stem-drop-hint">Drop a file to replace</span>
        <button type="button" class="gt-upload__stem-corner gt-upload__stem-delete"
          aria-label="Delete ${track.label} stem from server" title="Delete from server">${icon('trash')}</button>
      `
    } else if (state.status === 'empty') {
      bodyHtml = `
        <span class="gt-upload__stem-drop-hint">Drop file or <button type="button" class="gt-upload__stem-browse">Browse</button></span>
      `
    } else if (state.status === 'selected') {
      bodyHtml = `
        <span class="gt-upload__stem-filename" title="${escHtml(state.file.name)}">
          ${escHtml(state.file.name)}
        </span>
        <span class="gt-upload__stem-size">${formatBytes(state.file.size)}</span>
        <span class="gt-upload__stem-target">→ ${escHtml(targetName)}${willConvert ? ' (converted)' : ''}${existing.length ? ' — replaces existing' : ''}</span>
        <button type="button" class="gt-upload__stem-corner gt-upload__stem-remove" aria-label="Remove ${track.label} file">${icon('close')}</button>
      `
    } else if (state.status === 'deleting') {
      bodyHtml = `
        <span class="gt-upload__stem-drop-hint">Deleting…</span>
        <div class="gt-upload__progress"><div class="gt-upload__progress-bar"></div></div>
      `
    } else if (state.status === 'converting') {
      bodyHtml = `
        <span class="gt-upload__stem-filename">${escHtml(state.file.name)}</span>
        <span class="gt-upload__stem-drop-hint">Converting to M4A…</span>
        <div class="gt-upload__progress"><div class="gt-upload__progress-bar"></div></div>
      `
    } else if (state.status === 'uploading') {
      bodyHtml = `
        <span class="gt-upload__stem-filename">${escHtml(state.file.name)}</span>
        <div class="gt-upload__progress"><div class="gt-upload__progress-bar"></div></div>
      `
    } else if (state.status === 'done') {
      bodyHtml = `
        <span class="gt-upload__stem-done">${icon('check', { className: 'gt-icon' })} Uploaded</span>
        <span class="gt-upload__stem-filename">${escHtml(targetName)}</span>
      `
    } else if (state.status === 'error') {
      bodyHtml = `
        <span class="gt-upload__stem-error-msg">${escHtml(state.error)}</span>
        <button type="button" class="gt-upload__stem-browse">Retry</button>
      `
    }

    tile.innerHTML = `
      <div class="gt-upload__stem-icon">
        ${channelIcon(track.id, { className: 'gt-upload__stem-icon-svg' })}
      </div>
      <span class="gt-upload__stem-label">${track.label}</span>
      <div class="gt-upload__stem-body">${bodyHtml}</div>
      <input type="file" class="gt-upload__stem-input" accept=".m4a,.wav,audio/mp4,audio/wav" hidden />
    `

    const fileInput = tile.querySelector('.gt-upload__stem-input')
    const browseBtn = tile.querySelector('.gt-upload__stem-browse')
    const removeBtn = tile.querySelector('.gt-upload__stem-remove')
    const deleteBtn = tile.querySelector('.gt-upload__stem-delete')

    browseBtn?.addEventListener('click', () => fileInput.click())

    removeBtn?.addEventListener('click', () => {
      tileState[track.id] = { file: null, status: 'empty', error: '' }
      renderTile(track)
      updateSubmitState()
    })

    deleteBtn?.addEventListener('click', async () => {
      const files = existingFiles[track.id] ?? []
      if (files.length === 0 || !selectedSong) return
      const ok = window.confirm(
        `Permanently delete the ${track.label} stem (${files.join(', ')}) from ` +
        `“${selectedSong.title}” — ${replaceTargetLabel()}?`
      )
      if (!ok) return
      tileState[track.id] = { file: null, status: 'deleting', error: '' }
      renderTile(track)
      try {
        await deleteStemFiles(r2Folder(), versionChoice.versionSlug, files)
        await touchStems(selectedSong.slug)
        delete existingFiles[track.id]
        tileState[track.id] = { file: null, status: 'empty', error: '' }
      } catch (err) {
        tileState[track.id] = { file: null, status: 'error', error: err.message ?? 'Delete failed' }
      }
      renderTile(track)
      updateSubmitState()
    })

    fileInput.addEventListener('change', () => {
      if (fileInput.files[0]) handleFile(track.id, fileInput.files[0])
    })

    // Drag-and-drop
    tile.addEventListener('dragover', (e) => {
      e.preventDefault()
      tile.classList.add('gt-upload__stem--dragover')
    })
    tile.addEventListener('dragleave', () => {
      tile.classList.remove('gt-upload__stem--dragover')
    })
    tile.addEventListener('drop', (e) => {
      e.preventDefault()
      tile.classList.remove('gt-upload__stem--dragover')
      const file = e.dataTransfer?.files[0]
      if (file) handleFile(track.id, file)
    })
  }

  // After a successful upload the submit button is replaced by the success
  // panel. Touching a stem again means there's more to send, so bring the
  // Upload button back (and leave the "uploaded" message until they re-submit).
  function revertSuccess() {
    if (successEl.hidden) return
    successEl.hidden = true
    submitBtn.hidden = false
    submitBtn.textContent = 'Upload Recordings'
  }

  function handleFile(trackId, file) {
    const ext = file.name.split('.').pop().toLowerCase()
    if (!['m4a', 'wav'].includes(ext)) {
      tileState[trackId] = { file: null, status: 'error', error: 'Only .m4a or .wav files allowed.' }
    } else {
      tileState[trackId] = { file, status: 'selected', error: '' }
    }
    revertSuccess()
    renderTile(TRACKS.find(t => t.id === trackId))
    updateSubmitState()
  }

  // Initial render of all tiles
  TRACKS.forEach(renderTile)

  // Restore a saved song + version selection after an accidental reload (the
  // chosen files can't be persisted, so they must be re-added). Skipped when
  // the page was opened fresh (e.g. via the navbar "Upload" action).
  if (!fresh) {
    const saved = loadSelection()
    const song = saved?.slug && catalog.find(s => s.slug === saved.slug)
    if (song) selectSong(song, saved.versionChoice ?? null)
  }

  // ─── Submit ──────────────────────────────────────────────────────────────────
  submitBtn.addEventListener('click', async () => {
    formError.hidden = true

    // Resolve the target song. Stems always attach to a song picked from the
    // GraceChords library (new songs are created in the GraceChords editor).
    if (!selectedSong) {
      formError.textContent = 'Search for and choose a song first.'
      formError.hidden = false
      return
    }
    const slug   = selectedSong.slug
    const title  = selectedSong.title
    const artist = selectedSong.artist ?? null
    // Keep uploading into the song's existing R2 folder — old hand-uploaded
    // folders (snake_case stem_slug) must not fork into a second folder.
    const stemSlug = selectedSong.stem_slug || selectedSong.slug

    const selectedTracks = TRACKS.filter(t => tileState[t.id].file)
    if (selectedTracks.length === 0) {
      formError.textContent = 'At least one stem file is required.'
      formError.hidden = false
      return
    }

    // Resolve the target version. Only songs that already have stems pick one;
    // everything else lands on the legacy path as the implicit Original.
    let versionSlug = null
    let versionLabel = null
    if (selectedSong?.has_stems) {
      if (versionChoice.kind === 'new') {
        versionLabel = versionChoice.label.trim()
        versionSlug = slugify(versionLabel)
        if (!versionSlug || !VERSION_RE.test(versionSlug) || versionSlug === 'original') {
          formError.textContent = 'Enter a version name (e.g. AGMC2026). “Original” is reserved.'
          formError.hidden = false
          return
        }
        if (songVersions.some(r => r.version_slug === versionSlug)) {
          formError.textContent = `Version “${versionLabel}” already exists — pick its “Replace” option instead.`
          formError.hidden = false
          return
        }
      } else {
        versionSlug = versionChoice.versionSlug
      }
    }

    // Get session for Bearer token
    const session = await getSession()
    if (!session?.access_token) {
      formError.textContent = 'Your session has expired. Please sign in again.'
      formError.hidden = false
      return
    }

    submitBtn.disabled = true
    submitBtn.textContent = 'Uploading…'

    // Upload each stem sequentially (one large read at a time on mobile).
    let allOk = true
    for (const track of selectedTracks) {
      const original = tileState[track.id].file
      let file = original
      let ext = file.name.split('.').pop().toLowerCase()

      try {
        // 1–2. Replace = delete first, then write — never overwrite. Overwriting
        // an existing R2 object corrupts the stored bytes (confirmed: the same
        // bytes written to a fresh key are fine, an overwrite is not). Delete
        // every existing file for this track (canonical name + any alias/other
        // extension) and wait until R2 confirms they're gone, leaving an empty
        // key. New-song / new-version uploads have nothing here, so this is a
        // no-op for them.
        const existing = existingFiles[track.id] ?? []
        if (existing.length > 0) {
          tileState[track.id].status = 'deleting'
          renderTile(track)
          await deleteStemFiles(stemSlug, versionSlug, existing)
          await waitUntilGone(stemSlug, versionSlug, existing)
          existingFiles[track.id] = []
        }

        // 3. Convert WAV → M4A where the browser supports it; fall back to WAV,
        //    then rename to the instrument slot.
        if (ext === 'wav' && convertWav) {
          tileState[track.id].status = 'converting'
          renderTile(track)
          try {
            file = await wavFileToM4a(original)
            ext = 'm4a'
          } catch (convErr) {
            console.warn(`[GraceTracks] WAV→M4A failed for ${track.id}, uploading WAV:`, convErr)
            file = original
            ext = 'wav'
          }
        }
        const uploadedName = `${track.id}.${ext}`

        tileState[track.id].status = 'uploading'
        renderTile(track)

        // 4a. Get presigned URL for the now-empty key.
        const presignRes = await fetch('/api/presign', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            slug: stemSlug, // R2 folder, not necessarily the song slug
            track: track.id,
            ext,
            ...(versionSlug ? { version: versionSlug } : {}),
          }),
        })

        if (!presignRes.ok) {
          let msg
          if (presignRes.status === 403) {
            msg = 'Permission denied. Editor role required.'
          } else if (presignRes.status === 401) {
            msg = 'Session expired — sign out and back in.'
          } else if (presignRes.status === 500) {
            msg = 'Server auth not configured.'
          } else {
            msg = `Presign failed (${presignRes.status})`
          }
          throw new Error(msg)
        }

        const { url } = await presignRes.json()

        // 4b. Upload file directly to R2.
        const uploadRes = await fetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': AUDIO_TYPES[ext] ?? 'application/octet-stream' },
          body: file,
        })

        if (!uploadRes.ok) throw new Error(`Upload failed (${uploadRes.status})`)

        // 5. Confirm the new object actually landed at the right size.
        await confirmUploaded(stemSlug, versionSlug, uploadedName, file.size)
        existingFiles[track.id] = [uploadedName]

        tileState[track.id].status = 'done'
        renderTile(track)
      } catch (err) {
        tileState[track.id].status = 'error'
        tileState[track.id].error = err.message ?? 'Upload failed'
        renderTile(track)
        allOk = false
      }
    }

    if (!allOk) {
      formError.textContent = 'Some stems failed to upload. Check the tiles above.'
      formError.hidden = false
      submitBtn.disabled = false
      submitBtn.textContent = 'Upload Recordings'
      return
    }

    // 3. Persist the song row. Attach stems to the existing song — touch only
    // stem-related fields so we don't clobber GraceChords metadata. stem_slug
    // is only set the first time a song gets stems; later uploads must not move
    // its R2 folder. stems_updated_at bumps the mixer's cache-bust token so the
    // replaced stem (same R2 key) isn't shadowed by the service worker's cache.
    const gracetracksUrl = `${window.location.origin}/song/${slug}`
    const update = { has_stems: true, gracetracks_url: gracetracksUrl, stems_updated_at: new Date().toISOString() }
    if (!selectedSong.has_stems) update.stem_slug = stemSlug
    let { error: dbError } = await supabase
      .from('songs')
      .update(update)
      .eq('slug', slug)

    // Record the new version (upsert so retrying after a partial stem failure
    // is idempotent). Original stays default until the editor flips it.
    if (!dbError && versionLabel) {
      ;({ error: dbError } = await supabase
        .from('song_versions')
        .upsert({
          song_slug: slug,
          version_slug: versionSlug,
          label: versionLabel,
          is_default: false,
        }, { onConflict: 'song_slug,version_slug' }))
    }

    if (dbError) {
      formError.textContent = `Database error: ${dbError.message}`
      formError.hidden = false
      submitBtn.disabled = false
      submitBtn.textContent = 'Upload Recordings'
      return
    }

    // Success — link straight to the uploaded version
    const defaultVersionSlug = songVersions.find(r => r.is_default)?.version_slug ?? null
    const mixerUrl = selectedSong?.has_stems
      ? versionUrl(slug, versionSlug, defaultVersionSlug)
      : `/song/${slug}`
    submitBtn.hidden = true
    successEl.hidden = false
    openBtn.href = mixerUrl
    openBtn.addEventListener('click', (e) => {
      e.preventDefault()
      history.pushState({}, '', mixerUrl)
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    // The song now has stems, so further uploads in this session target versions.
    selectedSong.has_stems = true
    const catRow = catalog.find(s => s.slug === slug)
    if (catRow) catRow.has_stems = true
    saveSelection()
  })
}
