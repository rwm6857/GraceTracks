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
  deleteStemFiles,
  deleteVersionStems,
  deleteSongStems,
} from '../lib/stemsApi.js'
import { trackIdForFile } from '../audio/stems.js'

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
export async function renderUploadSong(container, user) {
  resetState()

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
        <h2 class="gt-upload__section-title">Song</h2>
        <p class="gt-upload__hint">
          Search the GraceChords library to attach these recordings to an existing song.
        </p>

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
          <button type="button" class="gc-btn gc-btn--ghost gc-btn--sm" id="selected-change">Change</button>
        </div>

        <div class="gt-upload__version-block" id="version-block" hidden></div>

        <button type="button" class="gt-upload__newlink" id="toggle-new">
          Can’t find it? Create a new song
        </button>

        <form class="gt-upload__form" id="new-song-form" novalidate hidden>
          <div class="gt-upload__fields">
            <div class="gt-upload__field gt-upload__field--full">
              <label class="gt-upload__label" for="uf-title">Title <span aria-hidden="true">*</span></label>
              <input id="uf-title" class="gt-upload__input" type="text" placeholder="Amazing Grace" />
            </div>
            <div class="gt-upload__field">
              <label class="gt-upload__label" for="uf-artist">Artist</label>
              <input id="uf-artist" class="gt-upload__input" type="text" placeholder="Traditional" />
            </div>
            <div class="gt-upload__field">
              <label class="gt-upload__label" for="uf-slug">Slug <span aria-hidden="true">*</span></label>
              <input id="uf-slug" class="gt-upload__input" type="text" placeholder="amazing-grace"
                pattern="[a-z0-9_-]+" title="Lowercase letters, numbers, hyphens, and underscores only" />
            </div>
            <div class="gt-upload__field">
              <label class="gt-upload__label" for="uf-tempo">Tempo (BPM)</label>
              <input id="uf-tempo" class="gt-upload__input" type="number" min="20" max="300" placeholder="120" />
            </div>
            <div class="gt-upload__field">
              <label class="gt-upload__label" for="uf-key">Key</label>
              <input id="uf-key" class="gt-upload__input" type="text" placeholder="G Major" />
            </div>
            <div class="gt-upload__field">
              <label class="gt-upload__label" for="uf-timesig">Time Signature</label>
              <input id="uf-timesig" class="gt-upload__input" type="text" placeholder="4/4" />
            </div>
          </div>
        </form>
      </section>

      <section class="gt-upload__section">
        <h2 class="gt-upload__section-title">Stems</h2>
        <p class="gt-upload__hint">
          Drop a <code>.m4a</code> or <code>.wav</code> file onto each instrument — up to ${TRACKS.length}.
          Each file is renamed to its instrument slot on upload${convertWav ? ', and WAV files are converted to M4A automatically' : ''}.
          At least one stem is required.
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
  const toggleNew   = container.querySelector('#toggle-new')
  const newForm     = container.querySelector('#new-song-form')

  const titleEl   = container.querySelector('#uf-title')
  const artistEl  = container.querySelector('#uf-artist')
  const slugEl    = container.querySelector('#uf-slug')
  const tempoEl   = container.querySelector('#uf-tempo')
  const keyEl     = container.querySelector('#uf-key')
  const timesigEl = container.querySelector('#uf-timesig')

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
    searchInput.placeholder = 'Could not load songs — create a new one below'
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

  function selectSong(song) {
    selectedSong = song
    mode = 'select'
    selTitleEl.textContent = song.title
    selMetaEl.textContent = [song.artist, song.has_stems ? 'already has stems' : null]
      .filter(Boolean).join(' · ')
    selectedEl.hidden = false
    searchWrap.hidden = true
    toggleNew.hidden = true
    newForm.hidden = true
    resultsEl.hidden = true
    formError.hidden = true

    // Songs that already have stems pick a version target; first-time uploads
    // go straight to the legacy path as the implicit Original.
    songVersions = []
    versionChoice = song.has_stems
      ? { kind: 'new', label: '' }
      : { kind: 'replace', versionSlug: null }
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
    toggleNew.hidden = false
    searchInput.value = ''
    renderResults([])
    clearVersionBlock()
    refreshExistingStems()
    searchInput.focus()
    updateSubmitState()
  })

  toggleNew.addEventListener('click', () => {
    mode = 'new'
    selectedSong = null
    selectedEl.hidden = true
    searchWrap.hidden = true
    toggleNew.hidden = true
    newForm.hidden = false
    clearVersionBlock()
    refreshExistingStems()
    titleEl.focus()
    updateSubmitState()
  })

  // ─── Version block (existing songs with stems) ───────────────────────────────
  function renderVersionBlock() {
    if (!selectedSong?.has_stems) { clearVersionBlock(); return }
    const versionList = buildVersionList(songVersions)
    const isNew = versionChoice.kind === 'new'

    versionBlock.innerHTML = `
      <span class="gt-upload__label">Version</span>
      <div class="gt-upload__versions" role="radiogroup" aria-label="Version target">
        <div class="gt-upload__version-row">
          <label class="gt-upload__version-pick">
            <input type="radio" name="version-choice" value="new" ${isNew ? 'checked' : ''} />
            <span>Add new version</span>
          </label>
        </div>
        <div class="gt-upload__version-label-wrap" ${isNew ? '' : 'hidden'}>
          <input id="version-label" class="gt-upload__input" type="text" placeholder="AGMC2026"
            aria-label="New version name" value="${escHtml(versionChoice.label ?? '')}" />
          <span class="gt-upload__version-hint" id="version-hint"></span>
        </div>
        ${versionList.map(v => `
          <div class="gt-upload__version-row">
            <label class="gt-upload__version-pick">
              <input type="radio" name="version-choice" value="replace:${v.versionSlug ?? 'original'}"
                ${!isNew && (versionChoice.versionSlug ?? null) === v.versionSlug ? 'checked' : ''} />
              <span>Replace ${escHtml(v.label)}</span>
            </label>
            <div class="gt-upload__version-actions">
              ${v.isDefault
                ? '<span class="gt-upload__version-badge">default</span>'
                : `<button type="button" class="gc-btn gc-btn--ghost gc-btn--sm gt-upload__version-make-default"
                     data-v="${v.versionSlug ?? ''}">Make default</button>`}
              ${v.versionSlug
                ? `<button type="button" class="gc-btn gc-btn--ghost gc-btn--sm gt-upload__version-delete"
                     data-v="${escHtml(v.versionSlug)}" title="Delete version"
                     aria-label="Delete version ${escHtml(v.label)}">${icon('trash')}</button>`
                : ''}
            </div>
          </div>
        `).join('')}
      </div>
      <div class="gt-upload__danger">
        <button type="button" class="gc-btn gc-btn--danger gc-btn--sm" id="delete-song-stems">
          ${icon('trash')} Delete all stems
        </button>
        <span class="gt-upload__version-hint">
          Removes every stem file and version from GraceTracks. The GraceChords song entry is unaffected.
        </span>
      </div>
    `

    const labelInput = versionBlock.querySelector('#version-label')
    const hintEl = versionBlock.querySelector('#version-hint')
    const updateHint = () => {
      const vs = slugify(labelInput.value)
      hintEl.textContent = vs ? `Saved as “${vs}”` : ''
    }
    updateHint()
    labelInput.addEventListener('input', () => {
      versionChoice.label = labelInput.value
      updateHint()
      updateSubmitState()
    })

    versionBlock.querySelectorAll('input[name="version-choice"]').forEach(input => {
      input.addEventListener('change', () => {
        if (input.value === 'new') {
          versionChoice = { kind: 'new', label: versionChoice.label ?? '' }
        } else {
          const v = input.value.slice('replace:'.length)
          versionChoice = { kind: 'replace', versionSlug: v === 'original' ? null : v }
        }
        renderVersionBlock() // shows/hides the new-version name input
        refreshExistingStems()
        updateSubmitState()
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
        const vSlug = btn.dataset.v
        const row = songVersions.find(r => r.version_slug === vSlug)
        if (!row) return
        const ok = window.confirm(
          `Permanently delete version “${row.label}” of “${selectedSong.title}”? ` +
          `All of its stem files are removed from storage.`
        )
        if (!ok) return
        btn.disabled = true
        formError.hidden = true
        try {
          await deleteVersionStems(r2Folder(), vSlug)
          const { error } = await supabase
            .from('song_versions')
            .delete()
            .eq('song_slug', selectedSong.slug)
            .eq('version_slug', vSlug)
          if (error) throw new Error(error.message)
        } catch (err) {
          formError.textContent = `Could not delete version: ${err.message}`
          formError.hidden = false
          btn.disabled = false
          return
        }
        // If the deleted version was flagged default, no row is flagged now,
        // which correctly falls back to Original.
        if (versionChoice.kind === 'replace' && versionChoice.versionSlug === vSlug) {
          versionChoice = { kind: 'new', label: '' }
        }
        songVersions = await fetchSongVersions(selectedSong.slug)
        renderVersionBlock()
        refreshExistingStems()
        updateSubmitState()
      })
    })

    versionBlock.querySelector('#delete-song-stems')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget
      const ok = window.confirm(
        `Permanently delete ALL stems for “${selectedSong.title}”? Every version and ` +
        `stem file is removed from GraceTracks. The GraceChords song entry is not affected.`
      )
      if (!ok) return
      btn.disabled = true
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
        btn.disabled = false
        return
      }
      // The song now behaves like a first-time upload target (stem_slug is
      // kept so a re-upload lands back in the same R2 folder).
      selectedSong.has_stems = false
      const catRow = catalog.find(s => s.slug === selectedSong.slug)
      if (catRow) catRow.has_stems = false
      selMetaEl.textContent = selectedSong.artist ?? ''
      clearVersionBlock()
      refreshExistingStems()
      updateSubmitState()
    })
  }

  // ─── New-song slug auto-derive ───────────────────────────────────────────────
  let slugManuallyEdited = false
  titleEl.addEventListener('input', () => {
    if (!slugManuallyEdited) slugEl.value = slugify(titleEl.value)
    updateSubmitState()
  })
  slugEl.addEventListener('input', () => {
    slugManuallyEdited = slugEl.value !== ''
    updateSubmitState()
  })

  // ─── Submit gating ───────────────────────────────────────────────────────────
  function songIsChosen() {
    if (mode === 'select') return !!selectedSong
    return Boolean(titleEl.value.trim() && slugEl.value.trim())
  }
  function updateSubmitState() {
    const hasStem = TRACKS.some(t => tileState[t.id].file)
    // Adding a new version requires a name that survives slugification.
    const needsLabel = mode === 'select' && selectedSong?.has_stems && versionChoice.kind === 'new'
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
        <button type="button" class="gc-btn gc-btn--ghost gc-btn--sm gt-upload__stem-delete"
          aria-label="Delete ${track.label} stem from server" title="Delete from server">${icon('trash')}</button>
      `
    } else if (state.status === 'empty') {
      bodyHtml = `
        <span class="gt-upload__stem-drop-hint">Drop file or</span>
        <button type="button" class="gc-btn gc-btn--ghost gc-btn--sm gt-upload__stem-browse">Browse</button>
      `
    } else if (state.status === 'selected') {
      bodyHtml = `
        <span class="gt-upload__stem-filename" title="${escHtml(state.file.name)}">
          ${escHtml(state.file.name)}
        </span>
        <span class="gt-upload__stem-size">${formatBytes(state.file.size)}</span>
        <span class="gt-upload__stem-target">→ ${escHtml(targetName)}${willConvert ? ' (converted)' : ''}${existing.length ? ' — replaces existing' : ''}</span>
        <button type="button" class="gc-btn gc-btn--ghost gc-btn--sm gt-upload__stem-remove" aria-label="Remove ${track.label} file">${icon('close')}</button>
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
        <button type="button" class="gc-btn gc-btn--ghost gc-btn--sm gt-upload__stem-browse">Retry</button>
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

  function handleFile(trackId, file) {
    const ext = file.name.split('.').pop().toLowerCase()
    if (!['m4a', 'wav'].includes(ext)) {
      tileState[trackId] = { file: null, status: 'error', error: 'Only .m4a or .wav files allowed.' }
    } else {
      tileState[trackId] = { file, status: 'selected', error: '' }
    }
    renderTile(TRACKS.find(t => t.id === trackId))
    updateSubmitState()
  }

  // Initial render of all tiles
  TRACKS.forEach(renderTile)

  // ─── Submit ──────────────────────────────────────────────────────────────────
  submitBtn.addEventListener('click', async () => {
    formError.hidden = true

    // Resolve the target song + metadata.
    let slug, title, artist, tempo, key, timeSig, stemSlug
    if (mode === 'select' && selectedSong) {
      slug     = selectedSong.slug
      title    = selectedSong.title
      artist   = selectedSong.artist ?? null
      // Keep uploading into the song's existing R2 folder — old hand-uploaded
      // folders (snake_case stem_slug) must not fork into a second folder.
      stemSlug = selectedSong.stem_slug || selectedSong.slug
      tempo = key = timeSig = undefined // leave existing row metadata untouched
    } else {
      title   = titleEl.value.trim()
      artist  = artistEl.value.trim() || null
      slug    = slugEl.value.trim()
      tempo   = tempoEl.value ? parseInt(tempoEl.value, 10) : null
      key     = keyEl.value.trim() || null
      timeSig = timesigEl.value.trim() || null
      stemSlug = slug
      if (!title || !slug) {
        formError.textContent = 'Choose a song or enter a title and slug.'
        formError.hidden = false
        return
      }
      if (!/^[a-z0-9_-]+$/.test(slug)) {
        formError.textContent = 'Slug may only contain lowercase letters, numbers, hyphens, and underscores.'
        formError.hidden = false
        return
      }
    }

    const selectedTracks = TRACKS.filter(t => tileState[t.id].file)
    if (selectedTracks.length === 0) {
      formError.textContent = 'At least one stem file is required.'
      formError.hidden = false
      return
    }

    // A brand-new slug that collides with an existing song becomes a version
    // decision: switch into select mode for that song and let the version
    // block (preselected "Add new version") drive the choice.
    if (mode === 'new') {
      const { data: existing } = await supabase
        .from('songs')
        .select('slug')
        .eq('slug', slug)
        .limit(1)
      if (existing?.length > 0) {
        const row = catalog.find(s => s.slug === slug)
        if (row) {
          selectSong(row)
          formError.textContent = `“${row.title}” already exists — choose below whether these stems become a new version or replace existing ones, then upload again.`
          formError.hidden = false
          return
        }
        // Not in the catalog (e.g. a soft-deleted row) — keep the explicit confirm.
        const confirmed = window.confirm(
          `A song with slug "${slug}" already exists. Overwrite it?`
        )
        if (!confirmed) return
      }
    }

    // Resolve the target version. Only songs that already have stems pick one;
    // everything else lands on the legacy path as the implicit Original.
    let versionSlug = null
    let versionLabel = null
    if (mode === 'select' && selectedSong?.has_stems) {
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
        // Convert WAV → M4A where the browser supports it; fall back to WAV.
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

        tileState[track.id].status = 'uploading'
        renderTile(track)

        // 1. Get presigned URL
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

        // 2. Upload file directly to R2
        const uploadRes = await fetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': AUDIO_TYPES[ext] ?? 'application/octet-stream' },
          body: file,
        })

        if (!uploadRes.ok) throw new Error(`Upload failed (${uploadRes.status})`)

        // When replacing, remove stale siblings left at an old name/extension
        // (e.g. drums.wav after uploading drums.m4a, or an aliased drum.m4a) —
        // the mixer probes m4a-first and aliases, so a leftover would shadow
        // the new file. Best effort: a failure leaves an extra file behind,
        // not a broken song.
        const uploadedName = `${track.id}.${ext}`
        const stale = (existingFiles[track.id] ?? []).filter(n => n !== uploadedName)
        if (stale.length > 0) {
          try {
            await deleteStemFiles(stemSlug, versionSlug, stale)
          } catch (cleanupErr) {
            console.warn(`[GraceTracks] could not remove old ${track.id} files:`, cleanupErr)
          }
          existingFiles[track.id] = [uploadedName]
        }

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

    // 3. Persist the song row.
    const gracetracksUrl = `${window.location.origin}/song/${slug}`
    let dbError
    if (mode === 'select') {
      // Attach stems to an existing song — touch only stem-related fields so we
      // don't clobber GraceChords metadata. stem_slug is only set the first time
      // a song gets stems; later uploads must not move its R2 folder.
      const update = { has_stems: true, gracetracks_url: gracetracksUrl }
      if (!selectedSong.has_stems) update.stem_slug = stemSlug
      ;({ error: dbError } = await supabase
        .from('songs')
        .update(update)
        .eq('slug', slug))
    } else {
      ;({ error: dbError } = await supabase
        .from('songs')
        .upsert({
          slug,
          title,
          artist,
          tempo,
          time_signature: timeSig,
          default_key: key,
          has_stems: true,
          stem_slug: stemSlug,
          gracetracks_url: gracetracksUrl,
          is_deleted: false,
        }, { onConflict: 'slug' }))
    }

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
    const mixerUrl = mode === 'select' && selectedSong?.has_stems
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
  })
}
