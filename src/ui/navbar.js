import { icon } from './icons.js'
import { isEditorPlus, signOut } from '../lib/auth.js'
import { currentTheme, toggleTheme } from '../lib/theme.js'
import { renderSignIn } from './signIn.js'

// GraceTracks is a separate deployment; the GraceChords home + profile pages
// live on the GraceChords domain.
const GC_HOME = 'https://gracechords.com'
const GC_PROFILE = 'https://gracechords.com/profile'

// User avatar sprites are shared with GraceChords (public/sprites/<id>.webp);
// the chosen id lives in users.preferences.sprite. Mirrors SpriteAvatar.jsx.
const DEFAULT_SPRITE = 'notes'
function spriteAvatar(sprite, size = 32) {
  const id = sprite || DEFAULT_SPRITE
  return `<span class="gc-sprite-avatar" style="width:${size}px;height:${size}px">` +
    `<img src="/sprites/${id}.webp" alt="" width="${size}" height="${size}" /></span>`
}

/**
 * Builds the GraceChords-style navbar (brand, links, settings tray with the
 * theme toggle, profile dropdown, and a hamburger drawer on mobile/tablet).
 *
 * @param {{ navigate: (path: string) => void }} opts
 * @returns {{ el: HTMLElement, setUser: (user: object|null) => void, destroy: () => void }}
 */
export function createNavbar({ navigate }) {
  let user = null

  // ─── Theme pill toggle (Sun "Light" / Moon "Dark") — matches SettingsCluster ─
  function themeToggleHtml() {
    const isDark = currentTheme() === 'dark'
    return `
      <button
        type="button"
        class="gc-pill-toggle gc-pill-toggle--icon-text ${isDark ? 'is-right' : 'is-left'}"
        role="switch"
        aria-checked="${isDark}"
        aria-label="Toggle dark mode"
        data-theme-toggle
      >
        <span class="gc-pill-toggle__track" aria-hidden="true">
          <span class="gc-pill-toggle__thumb"></span>
          <span class="gc-pill-toggle__option gc-pill-toggle__option--left">${icon('sun', { className: 'gt-icon' })}<span>Light</span></span>
          <span class="gc-pill-toggle__option gc-pill-toggle__option--right">${icon('moon', { className: 'gt-icon' })}<span>Dark</span></span>
        </span>
      </button>
    `
  }

  function settingsClusterHtml(orientation) {
    return `
      <div class="gc-settings-cluster gc-settings-cluster--${orientation}" role="group" aria-label="Settings">
        ${themeToggleHtml()}
      </div>
    `
  }

  // ─── Navbar markup ───────────────────────────────────────────────────────────
  const nav = document.createElement('nav')
  nav.className = 'gc-navbar'
  nav.innerHTML = `
    <div class="gc-navbar__inner">
      <a href="/" class="gc-brand" id="nav-brand" aria-label="GraceTracks home">GraceTracks</a>

      <button class="gc-hamburger" id="nav-hamburger" aria-label="Open main menu" aria-controls="gt-mobile-nav" aria-expanded="false">
        <span aria-hidden="true" class="gc-hamburger__bars"></span>
      </button>

      <div class="gc-navlinks">
        <a href="${GC_HOME}" class="gc-navlink">GraceChords</a>
        <a href="/" class="gc-navlink" id="nav-songs">Songs</a>

        <div class="gc-settings-tray-host" id="nav-settings">
          <button type="button" class="gc-settings-tray-btn" aria-label="Settings" aria-haspopup="menu" aria-expanded="false" id="nav-settings-btn">
            ${icon('settings', { className: 'gt-icon' })}
          </button>
          <div class="gc-settings-tray" role="menu" id="nav-settings-tray" hidden>
            <p class="gc-settings-tray__title">Settings</p>
            ${settingsClusterHtml('column')}
          </div>
        </div>

        <div class="gc-nav-authslot" id="nav-authslot"></div>
      </div>
    </div>
  `

  // ─── Mobile drawer (appended to <body>, like the GraceChords portal) ──────────
  const drawer = document.createElement('div')
  drawer.id = 'gt-mobile-nav'
  drawer.className = 'gc-drawer'
  drawer.dataset.open = 'false'
  drawer.setAttribute('aria-hidden', 'true')
  drawer.innerHTML = `
    <button type="button" class="gc-drawer__overlay" aria-hidden="true" tabindex="-1"></button>
    <nav class="gc-drawer__panel" role="navigation" aria-label="Mobile menu">
      <div class="gc-drawer__links">
        <a href="${GC_HOME}" class="gc-navlink">GraceChords</a>
        <a href="/" class="gc-navlink" data-drawer-songs>Songs</a>
      </div>
      <div class="gc-drawer__footer">
        ${settingsClusterHtml('column')}
        <div class="gc-drawer__authslot" id="drawer-authslot"></div>
      </div>
    </nav>
  `
  document.body.appendChild(drawer)

  // ─── Element refs ──────────────────────────────────────────────────────────
  const brand        = nav.querySelector('#nav-brand')
  const songsLink    = nav.querySelector('#nav-songs')
  const hamburger    = nav.querySelector('#nav-hamburger')
  const settingsHost = nav.querySelector('#nav-settings')
  const settingsBtn  = nav.querySelector('#nav-settings-btn')
  const settingsTray = nav.querySelector('#nav-settings-tray')
  const authSlot     = nav.querySelector('#nav-authslot')
  const drawerOverlay = drawer.querySelector('.gc-drawer__overlay')
  const drawerSongs   = drawer.querySelector('[data-drawer-songs]')
  const drawerAuthSlot = drawer.querySelector('#drawer-authslot')

  // ─── Theme toggles (desktop tray + drawer share state) ────────────────────────
  function syncThemeToggles() {
    const isDark = currentTheme() === 'dark'
    ;[nav, drawer].forEach(root => {
      root.querySelectorAll('[data-theme-toggle]').forEach(btn => {
        btn.classList.toggle('is-right', isDark)
        btn.classList.toggle('is-left', !isDark)
        btn.setAttribute('aria-checked', String(isDark))
      })
    })
  }
  function onThemeToggleClick(e) {
    const btn = e.target.closest('[data-theme-toggle]')
    if (!btn) return
    toggleTheme()
    syncThemeToggles()
  }
  nav.addEventListener('click', onThemeToggleClick)
  drawer.addEventListener('click', onThemeToggleClick)

  // ─── Settings tray open/close ──────────────────────────────────────────────
  function setSettingsOpen(open) {
    settingsTray.hidden = !open
    settingsBtn.setAttribute('aria-expanded', String(open))
  }
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    closeUserMenu()
    setSettingsOpen(settingsTray.hidden)
  })

  // ─── Profile dropdown / sign-in (desktop auth slot) ──────────────────────────
  function closeUserMenu() {
    const dd = authSlot.querySelector('.gc-user-dropdown')
    const btn = authSlot.querySelector('.gc-user-avatar-btn')
    if (dd) dd.hidden = true
    if (btn) btn.setAttribute('aria-expanded', 'false')
  }

  function renderAuthSlot() {
    const editor = isEditorPlus(user)
    if (user) {
      const name = user.email || 'Account'
      authSlot.innerHTML = `
        <div class="gc-user-menu">
          <button class="gc-user-avatar-btn" aria-haspopup="menu" aria-expanded="false" aria-label="Account menu">
            ${spriteAvatar(user.sprite, 30)}
          </button>
          <div class="gc-user-dropdown" role="menu" hidden>
            <p class="gc-user-dropdown__name" title="${name}">${name}</p>
            ${editor ? `<a href="/upload" class="gc-user-dropdown__item" role="menuitem" data-upload>Upload</a>` : ''}
            <a href="${GC_PROFILE}" class="gc-user-dropdown__item" role="menuitem">Profile</a>
            <hr class="gc-user-dropdown__divider" />
            <button class="gc-user-dropdown__item" role="menuitem" data-signout>Sign Out</button>
          </div>
        </div>
      `
      const avatarBtn = authSlot.querySelector('.gc-user-avatar-btn')
      const dropdown  = authSlot.querySelector('.gc-user-dropdown')
      avatarBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        setSettingsOpen(false)
        const willOpen = dropdown.hidden
        dropdown.hidden = !willOpen
        avatarBtn.setAttribute('aria-expanded', String(willOpen))
      })
      authSlot.querySelector('[data-upload]')?.addEventListener('click', (e) => {
        e.preventDefault(); closeUserMenu(); navigate('/upload')
      })
      authSlot.querySelector('[data-signout]')?.addEventListener('click', async () => {
        closeUserMenu(); await signOut()
      })
    } else {
      authSlot.innerHTML = `<button class="gc-nav-signin" data-signin>Sign In</button>`
      authSlot.querySelector('[data-signin]').addEventListener('click', () => {
        renderSignIn(() => {})
      })
    }
  }

  // ─── Drawer auth slot (mobile) ────────────────────────────────────────────────
  function renderDrawerAuthSlot() {
    const editor = isEditorPlus(user)
    if (user) {
      drawerAuthSlot.innerHTML = `
        ${editor ? `<button type="button" class="gc-btn gc-btn--secondary gc-drawer__profile" data-upload>Upload</button>` : ''}
        <a href="${GC_PROFILE}" class="gc-btn gc-btn--secondary gc-drawer__profile">
          ${spriteAvatar(user.sprite, 28)}
          <span class="gc-profile-link__label">${user.email || 'Profile'}</span>
          ${icon('chevron-right', { className: 'gt-icon gc-profile-link__chevron' })}
        </a>
        <button type="button" class="gc-btn gc-btn--destructive gc-drawer__signout" data-signout>
          ${icon('log-out', { className: 'gt-icon' })}<span>Sign Out</span>
        </button>
      `
      drawerAuthSlot.querySelector('[data-upload]')?.addEventListener('click', () => {
        closeDrawer(); navigate('/upload')
      })
      drawerAuthSlot.querySelector('[data-signout]')?.addEventListener('click', async () => {
        closeDrawer(); await signOut()
      })
    } else {
      drawerAuthSlot.innerHTML = `<button class="gc-nav-signin gc-drawer__signin" data-signin>Sign In</button>`
      drawerAuthSlot.querySelector('[data-signin]').addEventListener('click', () => {
        closeDrawer(); renderSignIn(() => {})
      })
    }
  }

  // ─── Hamburger drawer ──────────────────────────────────────────────────────
  function lockBodyScroll(lock) {
    try { document.body.style.overflow = lock ? 'hidden' : '' } catch {}
  }
  function openDrawer() {
    drawer.dataset.open = 'true'
    drawer.setAttribute('aria-hidden', 'false')
    hamburger.setAttribute('aria-expanded', 'true')
    lockBodyScroll(true)
  }
  function closeDrawer() {
    drawer.dataset.open = 'false'
    drawer.setAttribute('aria-hidden', 'true')
    hamburger.setAttribute('aria-expanded', 'false')
    lockBodyScroll(false)
  }
  hamburger.addEventListener('click', (e) => {
    e.preventDefault()
    drawer.dataset.open === 'true' ? closeDrawer() : openDrawer()
  })
  drawerOverlay.addEventListener('click', closeDrawer)
  drawerSongs.addEventListener('click', (e) => { e.preventDefault(); closeDrawer(); navigate('/') })

  // ─── Internal navigation ───────────────────────────────────────────────────
  brand.addEventListener('click', (e) => { e.preventDefault(); navigate('/') })
  songsLink.addEventListener('click', (e) => { e.preventDefault(); navigate('/') })

  // ─── Global dismissers ──────────────────────────────────────────────────────
  function onDocClick(e) {
    if (!settingsHost.contains(e.target)) setSettingsOpen(false)
    if (!authSlot.contains(e.target)) closeUserMenu()
  }
  function onKeyDown(e) {
    if (e.key !== 'Escape') return
    setSettingsOpen(false)
    closeUserMenu()
    if (drawer.dataset.open === 'true') closeDrawer()
  }
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKeyDown)

  // Initial paint
  renderAuthSlot()
  renderDrawerAuthSlot()
  syncThemeToggles()

  return {
    el: nav,
    setUser(next) {
      user = next
      renderAuthSlot()
      renderDrawerAuthSlot()
    },
    // Highlight the active link like GraceChords (orange pill). "Songs" is the
    // GraceTracks song list at "/".
    setActive(path) {
      const isSongs = path === '/'
      songsLink.classList.toggle('active', isSongs)
      drawerSongs.classList.toggle('active', isSongs)
    },
    destroy() {
      document.removeEventListener('click', onDocClick)
      document.removeEventListener('keydown', onKeyDown)
      drawer.remove()
      nav.remove()
    },
  }
}
