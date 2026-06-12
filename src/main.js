import './styles/main.css'
import { renderSongPicker } from './ui/songPicker.js'
import { renderMixer } from './ui/mixer.js'
import { renderUploadSong } from './ui/uploadSong.js'
import { renderRegisterSong } from './ui/registerSong.js'
import { createNavbar } from './ui/navbar.js'
import { initTheme } from './lib/theme.js'
import { getUser, onAuthStateChange } from './lib/auth.js'
import { VERSION_RE } from './lib/versions.js'

const app = document.getElementById('app')

// ─── Navbar ──────────────────────────────────────────────────────────────────
let _navbar = null

function navigate(path) {
  history.pushState({}, '', path)
  render()
}

// ─── Router ──────────────────────────────────────────────────────────────────
function getRoute() {
  const path = window.location.pathname
  if (path === '/upload') return { view: 'upload' }
  if (path === '/register') return { view: 'register' }
  const m = path.match(/^\/song\/(.+)$/)
  if (m) {
    // ?v=<version_slug> selects a stem version; bare URL = the song's default.
    const v = new URLSearchParams(window.location.search).get('v')
    return { view: 'mixer', slug: m[1], version: v && VERSION_RE.test(v) ? v : null }
  }
  return { view: 'picker' }
}

let currentView   = null
let _mixerKey     = null
let _mixerEl      = null
let _mixerCleanup = null
let _pickerEl     = null
let _uploadEl     = null
let _registerEl   = null
let _currentUser  = null

async function render() {
  const route = getRoute()
  const key = route.view === 'mixer' ? `mixer:${route.slug}|${route.version ?? ''}` : route.view
  _navbar?.setActive(window.location.pathname)
  if (key === currentView) return
  currentView = key

  // Hide all panels
  if (_pickerEl)   _pickerEl.hidden   = true
  if (_mixerEl)    _mixerEl.hidden    = true
  if (_uploadEl)   _uploadEl.hidden   = true
  if (_registerEl) _registerEl.hidden = true

  if (route.view === 'mixer') {
    // Same song + version already loaded — just show
    if (_mixerKey === key && _mixerEl) {
      _mixerEl.hidden = false
      return
    }

    // Different song or version — dispose old session
    if (_mixerCleanup) { _mixerCleanup(); _mixerCleanup = null }
    if (_mixerEl)      { _mixerEl.remove(); _mixerEl = null }
    _mixerKey = null

    _mixerEl = document.createElement('main')
    _mixerEl.id = 'gt-main'
    _mixerEl.className = 'gt-main'
    app.appendChild(_mixerEl)
    _mixerKey = key
    _mixerCleanup = await renderMixer(_mixerEl, route.slug, route.version) ?? (() => {})

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

  } else if (route.view === 'register') {
    if (_registerEl) {
      _registerEl.hidden = false
    } else {
      _registerEl = document.createElement('main')
      _registerEl.id = 'gt-main-register'
      _registerEl.className = 'gt-main'
      app.appendChild(_registerEl)
      await renderRegisterSong(_registerEl, _currentUser)
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
  initTheme()
  app.innerHTML = ''
  _navbar = createNavbar({ navigate })
  app.appendChild(_navbar.el)

  // Resolve initial auth state
  _currentUser = await getUser()
  _navbar.setUser(_currentUser)

  // Reactively update navbar on auth changes; re-render upload page if needed
  onAuthStateChange((user) => {
    _currentUser = user
    _navbar.setUser(user)

    // If upload page is visible, re-render it with new auth context
    if (_uploadEl && !_uploadEl.hidden) {
      _uploadEl.remove()
      _uploadEl = null
      currentView = null
      render()
    }

    // Same for the register page
    if (_registerEl && !_registerEl.hidden) {
      _registerEl.remove()
      _registerEl = null
      currentView = null
      render()
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
