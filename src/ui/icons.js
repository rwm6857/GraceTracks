/**
 * Lucide icon helper.
 *
 * Lucide ships each icon as an array of `[tag, attrs]` child nodes (no wrapping
 * <svg>). We import only the icons we use — Vite tree-shakes the rest — and
 * render them to an SVG markup string so they drop straight into the existing
 * innerHTML template literals, keeping the vanilla-JS pattern intact.
 *
 * Icons we intentionally do NOT source from Lucide (no suitable equivalent):
 *   - count-in "1234" block  → bespoke markup in transport.js
 *   - metronome              → bespoke SVG in transport.js
 */
import {
  Play,
  Pause,
  Square,
  SkipBack,
  Waves,
  AudioLines,
  Volume1,
  Volume2,
  ChevronLeft,
  X,
} from 'lucide'

const ICONS = {
  play: Play,
  pause: Pause,
  stop: Square,
  rewind: SkipBack,
  ambient: Waves,
  meters: AudioLines,
  'volume-down': Volume1,
  'volume-up': Volume2,
  'chevron-left': ChevronLeft,
  close: X,
}

/**
 * Render a Lucide icon as an SVG markup string.
 * @param {string} name - key in ICONS
 * @param {object} [opts]
 * @param {string} [opts.className='gt-icon'] - class(es) applied to the <svg>
 * @returns {string} SVG markup
 */
export function icon(name, { className = 'gt-icon' } = {}) {
  const node = ICONS[name]
  if (!node) throw new Error(`[icons] unknown icon: ${name}`)
  const children = node
    .map(([tag, attrs]) =>
      `<${tag} ${Object.entries(attrs)
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ')}/>`
    )
    .join('')
  return (
    `<svg class="${className}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="2" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true">${children}</svg>`
  )
}
