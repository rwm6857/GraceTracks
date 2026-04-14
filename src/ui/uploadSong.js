import { supabase } from '../lib/supabase.js'
import { getSession, isEditorPlus } from '../lib/auth.js'

const TRACKS = [
  { id: 'drums',   label: 'Drums' },
  { id: 'perc',    label: 'Percussion' },
  { id: 'bass',    label: 'Bass' },
  { id: 'elec',    label: 'Electric Guitar' },
  { id: 'keys',    label: 'Keys / Piano' },
  { id: 'synth',   label: 'Synth' },
  { id: 'vox',     label: 'Vocals' },
  { id: 'strings', label: 'Strings' },
  { id: 'click',   label: 'Click Track' },
  { id: 'ambient', label: 'Ambient' },
]

const AUDIO_TYPES = {
  'm4a': 'audio/mp4',
  'wav': 'audio/wav',
}

// Per-tile state: { file: File | null, status: 'empty'|'selected'|'uploading'|'done'|'error', error: string }
let tileState = {}

function resetTileState() {
  tileState = Object.fromEntries(TRACKS.map(t => [t.id, { file: null, status: 'empty', error: '' }]))
}

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/['']/g, '')
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
  resetTileState()

  if (!user || !isEditorPlus(user)) {
    container.innerHTML = `
      <div class="gt-upload gt-upload--denied">
        <p class="gt-upload__denied-msg">You need editor access to upload songs.</p>
      </div>
    `
    return
  }

  container.innerHTML = `
    <div class="gt-upload">
      <header class="gt-upload__header">
        <h1 class="gt-upload__title">Upload Song</h1>
      </header>

      <section class="gt-upload__section">
        <h2 class="gt-upload__section-title">Song Details</h2>
        <form class="gt-upload__form" id="upload-form" novalidate>
          <div class="gt-upload__fields">
            <div class="gt-upload__field gt-upload__field--full">
              <label class="gt-upload__label" for="uf-title">Title <span aria-hidden="true">*</span></label>
              <input id="uf-title" class="gt-upload__input" type="text" required placeholder="Amazing Grace" />
            </div>
            <div class="gt-upload__field">
              <label class="gt-upload__label" for="uf-artist">Artist</label>
              <input id="uf-artist" class="gt-upload__input" type="text" placeholder="Traditional" />
            </div>
            <div class="gt-upload__field">
              <label class="gt-upload__label" for="uf-slug">Slug <span aria-hidden="true">*</span></label>
              <input id="uf-slug" class="gt-upload__input" type="text" required placeholder="amazing-grace"
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
          Drop <code>.m4a</code> or <code>.wav</code> files onto each track. At least one stem is required.
        </p>
        <div class="gt-upload__stems" id="stems-grid"></div>
      </section>

      <div class="gt-upload__footer">
        <p class="gt-upload__form-error" id="upload-form-error" hidden></p>
        <button class="gc-btn gc-btn--primary gt-upload__submit" id="upload-submit" disabled>
          Upload Song
        </button>
      </div>

      <div class="gt-upload__success" id="upload-success" hidden>
        <p class="gt-upload__success-msg">Song uploaded successfully!</p>
        <a class="gc-btn gc-btn--ghost" id="upload-open-mixer">Open in Mixer →</a>
      </div>
    </div>
  `

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

  // ─── Slug auto-derive ────────────────────────────────────────────────────────
  let slugManuallyEdited = false
  titleEl.addEventListener('input', () => {
    if (!slugManuallyEdited) slugEl.value = slugify(titleEl.value)
    updateSubmitState()
  })
  slugEl.addEventListener('input', () => {
    slugManuallyEdited = slugEl.value !== ''
    updateSubmitState()
  })

  // ─── Submit state ────────────────────────────────────────────────────────────
  function updateSubmitState() {
    const hasRequired = titleEl.value.trim() && slugEl.value.trim()
    const hasStem = TRACKS.some(t => tileState[t.id].file)
    submitBtn.disabled = !(hasRequired && hasStem)
  }

  // ─── Stem tiles ──────────────────────────────────────────────────────────────
  function renderTile(track) {
    const state = tileState[track.id]
    const tile = stemsGrid.querySelector(`[data-track="${track.id}"]`) ??
      (() => { const el = document.createElement('div'); el.dataset.track = track.id; stemsGrid.appendChild(el); return el })()

    tile.className = `gt-upload__stem gt-upload__stem--${state.status}`

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
        <button type="button" class="gc-btn gc-btn--ghost gc-btn--sm gt-upload__stem-remove" aria-label="Remove ${track.label} file">✕</button>
      `
    } else if (state.status === 'uploading') {
      bodyHtml = `
        <span class="gt-upload__stem-filename">${escHtml(state.file.name)}</span>
        <div class="gt-upload__progress"><div class="gt-upload__progress-bar"></div></div>
      `
    } else if (state.status === 'done') {
      bodyHtml = `
        <span class="gt-upload__stem-done">✓ Uploaded</span>
        <span class="gt-upload__stem-filename">${escHtml(state.file.name)}</span>
      `
    } else if (state.status === 'error') {
      bodyHtml = `
        <span class="gt-upload__stem-error-msg">${escHtml(state.error)}</span>
        <button type="button" class="gc-btn gc-btn--ghost gc-btn--sm gt-upload__stem-browse">Retry</button>
      `
    }

    tile.innerHTML = `
      <div class="gt-upload__stem-icon">
        <img src="/icons/channels/${track.id}.svg" alt="" width="24" height="24" />
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

    const title   = titleEl.value.trim()
    const artist  = artistEl.value.trim()
    const slug    = slugEl.value.trim()
    const tempo   = tempoEl.value ? parseInt(tempoEl.value, 10) : null
    const key     = keyEl.value.trim() || null
    const timeSig = timesigEl.value.trim() || null

    if (!title || !slug) {
      formError.textContent = 'Title and slug are required.'
      formError.hidden = false
      return
    }

    const selectedTracks = TRACKS.filter(t => tileState[t.id].file)
    if (selectedTracks.length === 0) {
      formError.textContent = 'At least one stem file is required.'
      formError.hidden = false
      return
    }

    // Check for existing slug
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

    // Get session for Bearer token
    const session = await getSession()
    if (!session?.access_token) {
      formError.textContent = 'Your session has expired. Please sign in again.'
      formError.hidden = false
      return
    }

    submitBtn.disabled = true
    submitBtn.textContent = 'Uploading…'

    // Upload each stem sequentially
    let allOk = true
    for (const track of selectedTracks) {
      const file = tileState[track.id].file
      const ext  = file.name.split('.').pop().toLowerCase()

      tileState[track.id].status = 'uploading'
      renderTile(track)

      try {
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
      submitBtn.textContent = 'Upload Song'
      return
    }

    // 3. Upsert song record in Supabase
    const gracetracksUrl = `${window.location.origin}/song/${slug}`
    const { error: dbError } = await supabase
      .from('songs')
      .upsert({
        slug,
        title,
        artist: artist || null,
        tempo,
        time_signature: timeSig,
        default_key: key,
        has_stems: true,
        stem_slug: slug,
        gracetracks_url: gracetracksUrl,
        is_deleted: false,
      }, { onConflict: 'slug' })

    if (dbError) {
      formError.textContent = `Database error: ${dbError.message}`
      formError.hidden = false
      submitBtn.disabled = false
      submitBtn.textContent = 'Upload Song'
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
