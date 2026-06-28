/**
 * Lucide icon helper.
 *
 * Lucide ships each icon as an array of `[tag, attrs]` child nodes (no wrapping
 * <svg>). We import only the icons we use — Vite tree-shakes the rest — and
 * render them to an SVG markup string so they drop straight into the existing
 * innerHTML template literals, keeping the vanilla-JS pattern intact.
 *
 * Non-Lucide icons: the per-instrument channel icons come from the Behringer X32
 * scribble-strip set (see channelIcon below + src/assets/channels/ATTRIBUTION.md),
 * and the count-in "1234" block in transport.js is bespoke (Logic-Pro-style
 * ascending numerals have no Lucide equivalent).
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
  Speaker,
  Settings,
  Sun,
  Moon,
  LogOut,
  ChevronRight,
  ChevronDown,
  User,
  Trash2,
} from 'lucide'

// X32 scribble-strip instrument icons (Behringer-icons, Apache-2.0; traced from the
// original BMPs to currentColor SVGs — see src/assets/channels/ATTRIBUTION.md).
import drumsSvg from '../assets/channels/drums.svg?raw'
import percSvg from '../assets/channels/perc.svg?raw'
import bassSvg from '../assets/channels/bass.svg?raw'
import elecSvg from '../assets/channels/elec.svg?raw'
import keysSvg from '../assets/channels/keys.svg?raw'
import synthSvg from '../assets/channels/synth.svg?raw'
import voxSvg from '../assets/channels/vox.svg?raw'
import stringsSvg from '../assets/channels/strings.svg?raw'
import mdSvg from '../assets/channels/md.svg?raw'

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
  settings: Settings,
  sun: Sun,
  moon: Moon,
  'log-out': LogOut,
  'chevron-right': ChevronRight,
  'chevron-down': ChevronDown,
  user: User,
  trash: Trash2,
}

/** X32 instrument icons (raw SVG strings, already `currentColor` + 0 0 64 64). */
const X32_ICONS = {
  drums: drumsSvg,
  perc: percSvg,
  bass: bassSvg,
  elec: elecSvg,
  keys: keysSvg,
  synth: synthSvg,
  vox: voxSvg,
  strings: stringsSvg,
  md: mdSvg,
}

/** Lucide fallbacks for channels with no X32 icon (transport-only stems + master). */
const CHANNEL_ICONS = {
  click: Metronome,
  ambient: Waves,
  master: Speaker,
}

function renderSvg(node, className, color) {
  const children = node
    .map(([tag, attrs]) =>
      `<${tag} ${Object.entries(attrs)
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ')}/>`
    )
    .join('')
  const style = color ? ` style="color:${color}"` : ''
  return (
    `<svg class="${className}"${style} viewBox="0 0 24 24" fill="none" ` +
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
 * @param {string} [opts.color] - CSS color for the icon (resolves `currentColor`);
 *   pass the channel accent so the icon matches the strip.
 * @returns {string} SVG markup
 */
export function channelIcon(name, { className = 'gt-strip__icon', color } = {}) {
  const style = color ? ` style="color:${color}"` : ''
  const x32 = X32_ICONS[name]
  if (x32) return x32.replace('<svg', `<svg class="${className}"${style}`)
  const node = CHANNEL_ICONS[name]
  if (!node) throw new Error(`[icons] unknown channel icon: ${name}`)
  return renderSvg(node, className, color)
}
