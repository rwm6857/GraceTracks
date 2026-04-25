import './styles/main.css'
import { renderSongPicker } from './ui/songPicker.js'
import { renderMixer } from './ui/mixer.js'
import { renderUploadSong } from './ui/uploadSong.js'
import { renderSignIn } from './ui/signIn.js'
import { getUser, isEditorPlus, signOut, onAuthStateChange } from './lib/auth.js'

const app = document.getElementById('app')

// ─── Navbar ──────────────────────────────────────────────────────────────────
let _navEl = null

function renderNav() {
  const nav = document.createElement('nav')
  nav.className = 'gt-navbar'
  nav.innerHTML = `
    <div class="gt-navbar__actions">
      <a
        href="https://gracechords.com"
        target="_blank"
        rel="noopener noreferrer"
        class="gc-btn gc-btn--ghost gc-btn--sm gt-navbar__gc-link"
      >GraceChords</a>
      <a href="/upload" class="gc-btn gc-btn--ghost gc-btn--sm gt-navbar__upload" id="nav-upload" hidden>
        Upload
      </a>
      <button class="gc-btn gc-btn--ghost gc-btn--sm gt-navbar__auth" id="nav-auth">Sign In</button>
    </div>
  `
  _navEl = nav
  return nav
}

function updateNavAuth(user) {
  if (!_navEl) return
  const authBtn    = _navEl.querySelector('#nav-auth')
  const uploadLink = _navEl.querySelector('#nav-upload')

  if (user) {
    authBtn.textContent = 'Sign Out'
    uploadLink.hidden = !isEditorPlus(user)
  } else {
    authBtn.textContent = 'Sign In'
    uploadLink.hidden = true
  }
}

// ─── Router ──────────────────────────────────────────────────────────────────
function getRoute() {
  const path = window.location.pathname
  if (path === '/upload') return { view: 'upload' }
  const m = path.match(/^\/song\/(.+)$/)
  if (m) return { view: 'mixer', slug: m[1] }
  return { view: 'picker' }
}

let currentView   = null
let _mixerSlug    = null
let _mixerEl      = null
let _mixerCleanup = null
let _pickerEl     = null
let _uploadEl     = null
let _currentUser  = null

async function render() {
  const route = getRoute()
  const key = route.view === 'mixer' ? `mixer:${route.slug}` : route.view
  if (key === currentView) return
  currentView = key

  // Hide all panels
  if (_pickerEl) _pickerEl.hidden = true
  if (_mixerEl)  _mixerEl.hidden  = true
  if (_uploadEl) _uploadEl.hidden = true

  if (route.view === 'mixer') {
    // Same song already loaded — just show
    if (_mixerSlug === route.slug && _mixerEl) {
      _mixerEl.hidden = false
      return
    }

    // Different song — dispose old session
    if (_mixerCleanup) { _mixerCleanup(); _mixerCleanup = null }
    if (_mixerEl)      { _mixerEl.remove(); _mixerEl = null }
    _mixerSlug = null

    _mixerEl = document.createElement('main')
    _mixerEl.id = 'gt-main'
    _mixerEl.className = 'gt-main'
    app.appendChild(_mixerEl)
    _mixerSlug = route.slug
    _mixerCleanup = await renderMixer(_mixerEl, route.slug) ?? (() => {})

  } else if (route.view === 'upload') {
    if (_uploadEl) {
      _uploadEl.hidden = false
    } else {
      _uploadEl = document.createElement('main')
      _uploadEl.id = 'gt-main-upload'
      _uploadEl.className = 'gt-main'
      app.appendChild(_uploadEl)
      await renderUploadSong(_uploadEl, _currentUser)
    }

  } else {
    if (_pickerEl) {
      _pickerEl.hidden = false
    } else {
      _pickerEl = document.createElement('main')
      _pickerEl.id = 'gt-main-picker'
      _pickerEl.className = 'gt-main'
      app.appendChild(_pickerEl)
      await renderSongPicker(_pickerEl)
    }
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  app.innerHTML = ''
  app.appendChild(renderNav())

  // Resolve initial auth state
  _currentUser = await getUser()
  updateNavAuth(_currentUser)

  // Reactively update navbar on auth changes; re-render upload page if needed
  onAuthStateChange((user) => {
    _currentUser = user
    updateNavAuth(user)

    // If upload page is visible, re-render it with new auth context
    if (_uploadEl && !_uploadEl.hidden) {
      _uploadEl.remove()
      _uploadEl = null
      currentView = null
      render()
    }
  })

  // Navbar navigation
  _navEl.querySelector('#nav-upload').addEventListener('click', (e) => {
    e.preventDefault()
    history.pushState({}, '', '/upload')
    render()
  })

  _navEl.querySelector('#nav-auth').addEventListener('click', async () => {
    if (_currentUser) {
      await signOut()
      // onAuthStateChange will fire and update state
    } else {
      renderSignIn(() => {
        // onAuthStateChange handles the rest
      })
    }
  })

  window.addEventListener('popstate', () => render())

  render()
}

// Guard: run boot() only once per cold start. ES modules execute once per page
// load anyway, but this flag makes the intent explicit. On iOS Safari bfcache
// restores the module does NOT re-execute — window.__gtInitialized is preserved
// in memory, and the pageshow handler in mixer.js resumes the AudioContext if
// it was suspended while the page was in the bfcache.
if (!window.__gtInitialized) {
  window.__gtInitialized = true
  boot()
}
