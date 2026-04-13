import './styles/main.css'
import { renderSongPicker } from './ui/songPicker.js'
import { renderMixer } from './ui/mixer.js'

const app = document.getElementById('app')

// ─── Navbar ──────────────────────────────────────────────────────────────────
function renderNav() {
  const nav = document.createElement('nav')
  nav.className = 'gt-navbar'
  nav.innerHTML = `
    <a href="/" class="gt-navbar__brand" id="nav-home">GraceTracks</a>
    <a
      href="https://gracechords.com"
      target="_blank"
      rel="noopener noreferrer"
      class="gc-btn gc-btn--ghost gc-btn--sm gt-navbar__gc-link"
    >GraceChords</a>
  `
  return nav
}

// ─── Router ──────────────────────────────────────────────────────────────────
function getRoute() {
  const path = window.location.pathname
  const m = path.match(/^\/song\/(.+)$/)
  if (m) return { view: 'mixer', slug: m[1] }
  return { view: 'picker' }
}

let currentView  = null
let _mixerSlug    = null  // slug of the currently-loaded mixer session
let _mixerEl      = null  // mixer <main> element (kept in DOM, hidden when picker is shown)
let _mixerCleanup = null  // cleanup fn returned by renderMixer
let _pickerEl     = null  // picker <main> element (kept in DOM, hidden when mixer is shown)

async function render() {
  const route = getRoute()
  const key = route.view === 'mixer' ? `mixer:${route.slug}` : 'picker'
  if (key === currentView) return
  currentView = key

  if (route.view === 'mixer') {
    // Hide picker while mixer is shown
    if (_pickerEl) _pickerEl.hidden = true

    // Same song already loaded — just show the existing mixer, no reload
    if (_mixerSlug === route.slug && _mixerEl) {
      _mixerEl.hidden = false
      return
    }

    // Different song — dispose old session and remove its element
    if (_mixerCleanup) { _mixerCleanup(); _mixerCleanup = null }
    if (_mixerEl)      { _mixerEl.remove(); _mixerEl = null }
    _mixerSlug = null

    _mixerEl = document.createElement('main')
    _mixerEl.id = 'gt-main'
    _mixerEl.className = 'gt-main'
    app.appendChild(_mixerEl)
    _mixerSlug = route.slug
    _mixerCleanup = await renderMixer(_mixerEl, route.slug) ?? (() => {})

  } else {
    // Hide mixer while picker is shown
    if (_mixerEl) _mixerEl.hidden = true

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
function boot() {
  // Build shell
  app.innerHTML = ''
  app.appendChild(renderNav())

  document.getElementById('nav-home').addEventListener('click', (e) => {
    e.preventDefault()
    history.pushState({}, '', '/')
    render()
  })

  window.addEventListener('popstate', () => render())

  render()
}

boot()
