// Theme handling — ports GraceChords' src/utils/app/theme.js so the dark/light
// toggle behaves identically across the two sites. Theme is applied to
// <html data-theme="…">; the choice persists in localStorage. GraceTracks
// defaults to dark (matching the PWA manifest theme) when nothing is stored.

const STORAGE_KEY = 'gracetracks.theme'

export function getStoredTheme() {
  const v = localStorage.getItem(STORAGE_KEY)
  return v === 'dark' || v === 'light' ? v : null
}

export function currentTheme() {
  return document.documentElement.getAttribute('data-theme') || 'dark'
}

/** Apply theme to <html data-theme="…">. Optionally persist. */
export function applyTheme(theme, { persist = false } = {}) {
  const t = theme === 'light' ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', t)
  if (persist) localStorage.setItem(STORAGE_KEY, t)
}

/** Initialize: use the stored value or fall back to dark (without persisting). */
export function initTheme() {
  applyTheme(getStoredTheme() || 'dark', { persist: false })
}

/** Toggle and persist. Returns the new theme. */
export function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark'
  applyTheme(next, { persist: true })
  return next
}
