import { supabase } from '../lib/supabase.js'
import { getSession, isEditorPlus } from '../lib/auth.js'
import { searchSongs } from '../lib/songSearch.js'
import { isM4aEncodeSupported, wavFileToM4a } from '../audio/encodeM4a.js'
import { icon, channelIcon } from './icons.js'

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

function resetState() {
  tileState = Object.fromEntries(TRACKS.map(t => [t.id, { file: null, status: 'empty', error: '' }]))
  selectedSong = null
  mode = 'select'
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
                pattern="[a-z0-9-]+" title="Lowercase letters, numbers, and hyphens only" />
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
    updateSubmitState()
  }

  changeBtn.addEventListener('click', () => {
    selectedSong = null
    selectedEl.hidden = true
    searchWrap.hidden = false
    toggleNew.hidden = false
    searchInput.value = ''
    renderResults([])
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
    titleEl.focus()
    updateSubmitState()
  })

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
    submitBtn.disabled = !(songIsChosen() && hasStem)
  }

  // ─── Stem tiles ──────────────────────────────────────────────────────────────
  function renderTile(track) {
    const state = tileState[track.id]
    const tile = stemsGrid.querySelector(`[data-track="${track.id}"]`) ??
      (() => { const el = document.createElement('div'); el.dataset.track = track.id; stemsGrid.appendChild(el); return el })()

    tile.className = `gt-upload__stem gt-upload__stem--${state.status}`

    // What this file will be renamed to in R2 (instrument slot drives the name).
    const ext = state.file ? state.file.name.split('.').pop().toLowerCase() : ''
    const willConvert = convertWav && ext === 'wav'
    const targetName = `${track.id}.${willConvert ? 'm4a' : ext}`

    let bodyHtml = ''
    if (state.status === 'empty') {
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
        <span class="gt-upload__stem-target">→ ${escHtml(targetName)}${willConvert ? ' (converted)' : ''}</span>
        <button type="button" class="gc-btn gc-btn--ghost gc-btn--sm gt-upload__stem-remove" aria-label="Remove ${track.label} file">${icon('close')}</button>
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

    browseBtn?.addEventListener('click', () => fileInput.click())

    removeBtn?.addEventListener('click', () => {
      tileState[track.id] = { file: null, status: 'empty', error: '' }
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
      stemSlug = selectedSong.slug
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
      if (!/^[a-z0-9-]+$/.test(slug)) {
        formError.textContent = 'Slug may only contain lowercase letters, numbers, and hyphens.'
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

    // For a brand-new slug that collides with an existing row, confirm overwrite.
    if (mode === 'new') {
      const { data: existing } = await supabase
        .from('songs')
        .select('slug')
        .eq('slug', slug)
        .limit(1)
      if (existing?.length > 0) {
        const confirmed = window.confirm(
          `A song with slug "${slug}" already exists. Overwrite it?`
        )
        if (!confirmed) return
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
          body: JSON.stringify({ slug, track: track.id, ext }),
        })

        if (!presignRes.ok) {
          const msg = presignRes.status === 403
            ? 'Permission denied. Editor role required.'
            : `Presign failed (${presignRes.status})`
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
      // don't clobber GraceChords metadata.
      ;({ error: dbError } = await supabase
        .from('songs')
        .update({ has_stems: true, stem_slug: stemSlug, gracetracks_url: gracetracksUrl })
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

    if (dbError) {
      formError.textContent = `Database error: ${dbError.message}`
      formError.hidden = false
      submitBtn.disabled = false
      submitBtn.textContent = 'Upload Recordings'
      return
    }

    // Success
    submitBtn.hidden = true
    successEl.hidden = false
    openBtn.href = `/song/${slug}`
    openBtn.addEventListener('click', (e) => {
      e.preventDefault()
      history.pushState({}, '', `/song/${slug}`)
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
  })
}
