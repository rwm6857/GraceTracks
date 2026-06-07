import { supabase } from '../lib/supabase.js'
import { isEditorPlus } from '../lib/auth.js'
import { STEMS } from '../audio/engine.js'
import { resolveStemUrl } from '../audio/stems.js'

// Registers a song whose stem files already live in R2 (uploaded out-of-band).
// Unlike the upload page this writes metadata only — no presign, no PUT. It
// probes R2 for the stem folder so you can't register a song with nothing
// behind it, then upserts the `songs` row with has_stems = true.

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Renders the register-existing-stems page into `container`.
 * @param {HTMLElement} container
 * @param {import('../lib/auth.js').User | null} user
 */
export async function renderRegisterSong(container, user) {
  if (!user || !isEditorPlus(user)) {
    container.innerHTML = `
      <div class="gt-upload gt-upload--denied">
        <p class="gt-upload__denied-msg">You need editor access to register songs.</p>
      </div>
    `
    return
  }

  const r2Base = import.meta.env.VITE_R2_PUBLIC_URL

  container.innerHTML = `
    <div class="gt-upload">
      <header class="gt-upload__header">
        <h1 class="gt-upload__title">Register Existing Stems</h1>
      </header>

      <section class="gt-upload__section">
        <p class="gt-upload__hint">
          For songs whose stems are already in R2 (under <code>/tracks/&lt;folder&gt;/</code>).
          This adds the database row so the song appears in the picker — it does not upload any files.
        </p>
        <form class="gt-upload__form" id="register-form" novalidate>
          <div class="gt-upload__fields">
            <div class="gt-upload__field gt-upload__field--full">
              <label class="gt-upload__label" for="rf-title">Title <span aria-hidden="true">*</span></label>
              <input id="rf-title" class="gt-upload__input" type="text" required placeholder="Great is the Lord" />
            </div>
            <div class="gt-upload__field">
              <label class="gt-upload__label" for="rf-slug">Slug (URL key) <span aria-hidden="true">*</span></label>
              <input id="rf-slug" class="gt-upload__input" type="text" required placeholder="great-is-the-lord"
                pattern="[a-z0-9-]+" title="Lowercase letters, numbers, and hyphens only" />
            </div>
            <div class="gt-upload__field">
              <label class="gt-upload__label" for="rf-stemslug">R2 folder (stem_slug) <span aria-hidden="true">*</span></label>
              <input id="rf-stemslug" class="gt-upload__input" type="text" required placeholder="great_is_the_lord"
                pattern="[a-z0-9_-]+" title="The folder name under /tracks/ — lowercase, numbers, hyphens or underscores" />
            </div>
            <div class="gt-upload__field">
              <label class="gt-upload__label" for="rf-artist">Artist</label>
              <input id="rf-artist" class="gt-upload__input" type="text" placeholder="Traditional" />
            </div>
            <div class="gt-upload__field">
              <label class="gt-upload__label" for="rf-tempo">Tempo (BPM)</label>
              <input id="rf-tempo" class="gt-upload__input" type="number" min="20" max="300" placeholder="120" />
            </div>
            <div class="gt-upload__field">
              <label class="gt-upload__label" for="rf-key">Key</label>
              <input id="rf-key" class="gt-upload__input" type="text" placeholder="G Major" />
            </div>
            <div class="gt-upload__field">
              <label class="gt-upload__label" for="rf-timesig">Time Signature</label>
              <input id="rf-timesig" class="gt-upload__input" type="text" placeholder="4/4" />
            </div>
          </div>
        </form>
      </section>

      <section class="gt-upload__section">
        <h2 class="gt-upload__section-title">Stems in R2</h2>
        <p class="gt-upload__hint">Check the folder before registering so you don't add an empty song.</p>
        <button class="gc-btn gc-btn--ghost" id="register-check" type="button" disabled>Check R2 folder</button>
        <p class="gt-register__check-result" id="register-check-result" hidden></p>
      </section>

      <div class="gt-upload__footer">
        <p class="gt-upload__form-error" id="register-form-error" hidden></p>
        <button class="gc-btn gc-btn--primary gt-upload__submit" id="register-submit" disabled>
          Register Song
        </button>
      </div>

      <div class="gt-upload__success" id="register-success" hidden>
        <p class="gt-upload__success-msg">Song registered successfully!</p>
        <a class="gc-btn gc-btn--ghost" id="register-open-mixer">Open in Mixer →</a>
      </div>
    </div>
  `

  const titleEl    = container.querySelector('#rf-title')
  const slugEl     = container.querySelector('#rf-slug')
  const stemSlugEl = container.querySelector('#rf-stemslug')
  const artistEl   = container.querySelector('#rf-artist')
  const tempoEl    = container.querySelector('#rf-tempo')
  const keyEl      = container.querySelector('#rf-key')
  const timesigEl  = container.querySelector('#rf-timesig')
  const checkBtn   = container.querySelector('#register-check')
  const checkResEl = container.querySelector('#register-check-result')
  const submitBtn  = container.querySelector('#register-submit')
  const formError  = container.querySelector('#register-form-error')
  const successEl  = container.querySelector('#register-success')
  const openBtn    = container.querySelector('#register-open-mixer')

  // Track whether the last check found at least one stem for the current folder.
  let foundStems = []
  let checkedFolder = null

  // ─── Field auto-derive ─────────────────────────────────────────────────────
  // Slug derives from title; stem_slug derives from slug (snake_case default,
  // matching the hand-uploaded R2 folders) until either is edited by hand.
  let slugEdited = false
  let stemSlugEdited = false

  titleEl.addEventListener('input', () => {
    if (!slugEdited) {
      slugEl.value = slugify(titleEl.value)
      if (!stemSlugEdited) stemSlugEl.value = slugEl.value.replace(/-/g, '_')
    }
    onFolderChanged()
  })
  slugEl.addEventListener('input', () => {
    slugEdited = slugEl.value !== ''
    if (!stemSlugEdited) stemSlugEl.value = slugEl.value.replace(/-/g, '_')
    onFolderChanged()
  })
  stemSlugEl.addEventListener('input', () => {
    stemSlugEdited = stemSlugEl.value !== ''
    onFolderChanged()
  })

  function onFolderChanged() {
    // Folder changed since the last check — invalidate it.
    foundStems = []
    checkedFolder = null
    checkResEl.hidden = true
    checkBtn.disabled = !stemSlugEl.value.trim()
    updateSubmitState()
  }

  function updateSubmitState() {
    const hasRequired = titleEl.value.trim() && slugEl.value.trim() && stemSlugEl.value.trim()
    // Require a successful check that found stems for the current folder.
    const verified = checkedFolder === stemSlugEl.value.trim() && foundStems.length > 0
    submitBtn.disabled = !(hasRequired && verified)
  }

  // ─── Check R2 ──────────────────────────────────────────────────────────────
  checkBtn.addEventListener('click', async () => {
    const folder = stemSlugEl.value.trim()
    if (!folder) return

    checkBtn.disabled = true
    checkBtn.textContent = 'Checking…'
    checkResEl.hidden = true

    const found = []
    for (const stem of STEMS) {
      const resolved = await resolveStemUrl(r2Base, folder, stem)
      if (resolved) found.push(stem)
    }

    foundStems = found
    checkedFolder = folder
    checkBtn.disabled = false
    checkBtn.textContent = 'Check R2 folder'

    checkResEl.hidden = false
    if (found.length > 0) {
      checkResEl.classList.remove('gt-register__check-result--error')
      checkResEl.textContent = `Found ${found.length} stem${found.length === 1 ? '' : 's'}: ${found.join(', ')}`
    } else {
      checkResEl.classList.add('gt-register__check-result--error')
      checkResEl.textContent = `No stems found under /tracks/${folder}/. Check the folder name and that the files are .m4a or .wav.`
    }
    updateSubmitState()
  })

  // ─── Submit ──────────────────────────────────────────────────────────────────
  submitBtn.addEventListener('click', async () => {
    formError.hidden = true

    const title    = titleEl.value.trim()
    const slug     = slugEl.value.trim()
    const stemSlug = stemSlugEl.value.trim()
    const artist   = artistEl.value.trim() || null
    const tempo    = tempoEl.value ? parseInt(tempoEl.value, 10) : null
    const key      = keyEl.value.trim() || null
    const timeSig  = timesigEl.value.trim() || null

    if (!title || !slug || !stemSlug) {
      formError.textContent = 'Title, slug, and R2 folder are required.'
      formError.hidden = false
      return
    }

    // Don't clobber an existing song without consent.
    const { data: existing } = await supabase
      .from('songs')
      .select('slug')
      .eq('slug', slug)
      .limit(1)

    if (existing?.length > 0) {
      const confirmed = window.confirm(
        `A song with slug "${slug}" already exists. Update it to point at these stems?`
      )
      if (!confirmed) return
    }

    submitBtn.disabled = true
    submitBtn.textContent = 'Registering…'

    const gracetracksUrl = `${window.location.origin}/song/${slug}`
    const { error: dbError } = await supabase
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
      }, { onConflict: 'slug' })

    if (dbError) {
      formError.textContent = `Database error: ${dbError.message}`
      formError.hidden = false
      submitBtn.disabled = false
      submitBtn.textContent = 'Register Song'
      return
    }

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
