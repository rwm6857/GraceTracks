/**
 * Lucide icon helper.
 *
 * Lucide ships each icon as an array of `[tag, attrs]` child nodes (no wrapping
 * <svg>). We import only the icons we use — Vite tree-shakes the rest — and
 * render them to an SVG markup string so they drop straight into the existing
 * innerHTML template literals, keeping the vanilla-JS pattern intact.
 *
 * The only bespoke (non-Lucide) icon left is the count-in "1234" block in
 * transport.js — Logic-Pro-style ascending numerals have no Lucide equivalent.
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
  Metronome,
  ExternalLink,
  ArrowRight,
  Check,
  Drum,
  Piano,
  KeyboardMusic,
  Speaker,
  Guitar,
  MicVocal,
  Music4,
} from 'lucide'

const ICONS = {
  play: Play,
  pause: Pause,
  stop: Square,
  rewind: SkipBack,
  ambient: Waves,
  meters: AudioLines,
  metronome: Metronome,
  'volume-down': Volume1,
  'volume-up': Volume2,
  'chevron-left': ChevronLeft,
  close: X,
  'external-link': ExternalLink,
  'arrow-right': ArrowRight,
  check: Check,
}

/** Per-channel / per-stem icons, shared by the mixer strips and upload tiles. */
const CHANNEL_ICONS = {
  drums: Drum,
  perc: Music4,
  bass: Guitar,
  elec: Guitar,
  keys: Piano,
  synth: KeyboardMusic,
  vox: MicVocal,
  strings: Music4,
  click: Metronome,
  ambient: Waves,
  master: Speaker,
}

function renderSvg(node, className) {
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

/**
 * Render a Lucide UI icon as an SVG markup string.
 * @param {string} name - key in ICONS
 * @param {object} [opts]
 * @param {string} [opts.className='gt-icon'] - class(es) applied to the <svg>
 * @returns {string} SVG markup
 */
export function icon(name, { className = 'gt-icon' } = {}) {
  const node = ICONS[name]
  if (!node) throw new Error(`[icons] unknown icon: ${name}`)
  return renderSvg(node, className)
}

/**
 * Render a channel/stem icon as an SVG markup string.
 * @param {string} name - key in CHANNEL_ICONS (e.g. 'drums', 'vox', 'master')
 * @param {object} [opts]
 * @param {string} [opts.className='gt-strip__icon'] - class(es) applied to the <svg>
 * @returns {string} SVG markup
 */
export function channelIcon(name, { className = 'gt-strip__icon' } = {}) {
  const node = CHANNEL_ICONS[name]
  if (!node) throw new Error(`[icons] unknown channel icon: ${name}`)
  return renderSvg(node, className)
}
