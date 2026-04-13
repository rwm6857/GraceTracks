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

// ─── Hash router ─────────────────────────────────────────────────────────────
function getRoute() {
  const hash = window.location.hash.replace(/^#/, '') || '/'
  const m = hash.match(/^\/song\/(.+)$/)
  if (m) return { view: 'mixer', slug: m[1] }
  return { view: 'picker' }
}

let currentView = null

async function render() {
  const route = getRoute()

  // Avoid full re-render if same view + same slug
  const key = route.view === 'mixer' ? `mixer:${route.slug}` : 'picker'
  if (key === currentView) return
  currentView = key

  // Clear main content
  const existing = document.getElementById('gt-main')
  if (existing) existing.remove()

  const main = document.createElement('main')
  main.id = 'gt-main'
  main.className = 'gt-main'
  app.appendChild(main)

  if (route.view === 'mixer') {
    await renderMixer(main, route.slug)
  } else {
    await renderSongPicker(main)
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
function boot() {
  // Build shell
  app.innerHTML = ''
  app.appendChild(renderNav())

  // Nav home link uses hash routing
  document.getElementById('nav-home').addEventListener('click', (e) => {
    e.preventDefault()
    window.location.hash = '#/'
  })

  window.addEventListener('hashchange', () => {
    currentView = null
    render()
  })

  render()
}

boot()
