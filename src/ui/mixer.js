import { supabase } from '../lib/supabase.js'
import { AudioEngine, STEMS } from '../audio/engine.js'
import { resolveStemUrl } from '../audio/stems.js'
import { Metronome } from '../audio/metronome.js'
import { Meters } from '../audio/meters.js'
import { createTransport } from './transport.js'

const CHANNEL_COLORS = {
  drums:   '#ef4444',
  perc:    '#ec4899',
  bass:    '#eab308',
  elec:    '#22c55e',
  keys:    '#3b82f6',
  synth:   '#06b6d4',
  vox:     null,       // uses gc-text (inherits from theme)
  strings: '#a855f7',
  click:   '#94a3b8',
  ambient: '#818cf8',
}

const CHANNEL_LABELS = {
  drums:   'Drums',
  perc:    'Perc',
  bass:    'Bass',
  elec:    'Electric',
  keys:    'Keys',
  synth:   'Synth',
  vox:     'Vocals',
  strings: 'Strings',
  click:   'Click',
  ambient: 'Ambient',
}

/**
 * Renders the mixer page for a given song slug.
 * Looks up song in Supabase, probes each stem URL, loads available stems.
 */
export async function renderMixer(container, slug) {
  container.innerHTML = `
    <div class="gt-mixer-loading">
      <div class="gt-spinner" aria-hidden="true"></div>
      <span>Loading song…</span>
    </div>
  `

  // — Fetch song
  const { data: songs, error } = await supabase
    .from('songs')
    .select('slug, stem_slug, title, artist, tempo, time_signature, default_key, gracetracks_url')
    .eq('slug', slug)
    .eq('is_deleted', false)
    .limit(1)

  if (error || !songs?.length) {
    container.innerHTML = `
      <div class="gt-mixer-error">
        <p>Song not found.</p>
        <a href="/" class="gc-btn gc-btn--ghost">Back to songs</a>
      </div>
    `
    return () => {}
  }

  const song = songs[0]
  const stemSlug = song.stem_slug || song.slug
  const r2Base = import.meta.env.VITE_R2_PUBLIC_URL

  // — Engine setup
  const engine = new AudioEngine()

  // — Probe + load stems
  let stemsCompleted = 0
  const totalStems = STEMS.length

  const stemLoadingEl = document.createElement('div')
  stemLoadingEl.className = 'gt-mixer-loading'
  stemLoadingEl.innerHTML = `
    <span>Loading stems…</span>
    <div class="gt-loading-bar" role="progressbar" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100" aria-label="Loading stems">
      <div class="gt-loading-bar__fill"></div>
    </div>
  `
  container.innerHTML = ''
  container.appendChild(stemLoadingEl)

  const fillEl = stemLoadingEl.querySelector('.gt-loading-bar__fill')
  const barEl = stemLoadingEl.querySelector('.gt-loading-bar')

  const loadedChannels = []
  await Promise.all(
    STEMS.map(async (stem) => {
      const resolved = await resolveStemUrl(r2Base, stemSlug, stem)
      if (!resolved) {
        stemsCompleted++
        const pct = Math.round((stemsCompleted / totalStems) * 100)
        fillEl.style.width = `${pct}%`
        barEl.setAttribute('aria-valuenow', pct)
        return  // neither .m4a nor .wav exists — omit this channel
      }
      const name = await engine.loadStem(stem, resolved.url, resolved.response)
      if (name) loadedChannels.push(stem)
      stemsCompleted++
      const pct = Math.round((stemsCompleted / totalStems) * 100)
      fillEl.style.width = `${pct}%`
      barEl.setAttribute('aria-valuenow', pct)
    })
  )

  // Sort by STEMS order
  const orderedChannels = STEMS.filter(s => loadedChannels.includes(s))

  if (orderedChannels.length === 0) {
    container.innerHTML = `
      <div class="gt-mixer-error">
        <p>No stems found for this song.</p>
        <a href="/" class="gc-btn gc-btn--ghost">Back to songs</a>
      </div>
    `
    return () => {}
  }

  // Patch metronome with the now-created context
  const metro = new Metronome(engine.context, engine.context.destination)
  const metersInst = new Meters(engine)

  // — Media Session (lock screen / notification controls)
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title,
      artist: song.artist ?? '',
      artwork: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    })
    navigator.mediaSession.setActionHandler('play', () => {
      engine.resumeIfSuspended().then(() => engine.play(engine.currentTime))
      navigator.mediaSession.playbackState = 'playing'
    })
    navigator.mediaSession.setActionHandler('pause', () => {
      engine.pause()
      navigator.mediaSession.playbackState = 'paused'
    })
    navigator.mediaSession.setActionHandler('seekto', (d) => {
      if (d.seekTime != null) engine.seekTo(d.seekTime)
    })
    navigator.mediaSession.setActionHandler('seekbackward', (d) => {
      engine.seekTo(Math.max(0, engine.currentTime - (d.seekOffset ?? 10)))
    })
    navigator.mediaSession.setActionHandler('seekforward', (d) => {
      engine.seekTo(Math.min(engine.duration, engine.currentTime + (d.seekOffset ?? 10)))
    })
  }

  // — Resume AudioContext when tab returns to foreground
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') engine.resumeIfSuspended()
  }
  document.addEventListener('visibilitychange', onVisibilityChange)

  // — Build mixer UI
  container.innerHTML = ''

  // Header
  const header = document.createElement('div')
  header.className = 'gt-mixer-header'
  header.innerHTML = `
    <div class="gt-mixer-header__info">
      <h2 class="gt-mixer-header__title">${escHtml(song.title)}</h2>
      ${song.artist ? `<p class="gt-mixer-header__artist">${escHtml(song.artist)}</p>` : ''}
    </div>
    <div class="gt-mixer-header__actions">
      <a
        href="https://gracechords.com/song/${encodeURIComponent(song.slug)}"
        target="_blank"
        rel="noopener noreferrer"
        class="gc-btn gc-btn--ghost gc-btn--sm"
      >View on GraceChords ↗</a>
      <a href="/" class="gc-btn gc-btn--ghost gc-btn--sm gt-back-link">← Songs</a>
    </div>
  `
  container.appendChild(header)

  // "← Songs" uses SPA navigation instead of a full-page reload
  header.querySelector('.gt-back-link').addEventListener('click', (e) => {
    e.preventDefault()
    history.pushState({}, '', '/')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })

  // Count-in overlay
  const countInOverlay = document.createElement('div')
  countInOverlay.className = 'gt-countin-overlay'
  countInOverlay.setAttribute('aria-live', 'assertive')
  countInOverlay.hidden = true
  container.appendChild(countInOverlay)

  // Channel strips
  const stripsWrap = document.createElement('div')
  stripsWrap.className = 'gt-strips'
  stripsWrap.setAttribute('role', 'group')
  stripsWrap.setAttribute('aria-label', 'Mixer channels')

  const stripEls = {}
  const meterBarEls = {}

  for (const name of orderedChannels) {
    const color = CHANNEL_COLORS[name]
    const label = CHANNEL_LABELS[name]

    const strip = document.createElement('div')
    strip.className = 'gt-strip'
    strip.dataset.channel = name
    strip.innerHTML = `
      <div class="gt-strip__accent" style="${color ? `background:${color}` : ''}"></div>
      <div class="gt-strip__label">${escHtml(label)}</div>
      <img class="gt-strip__icon" src="/icons/channels/${name}.svg" alt="" aria-hidden="true" draggable="false"/>
      <div class="gt-strip__fader-wrap">
        <input
          type="range"
          class="gt-strip__fader"
          min="0" max="1" step="0.01" value="0.75"
          aria-label="${escHtml(label)} volume"
        />
      </div>
      <div class="gt-strip__db">0 dB</div>
      <div class="gt-strip__meter-wrap">
        <div class="gt-strip__meter-bar"></div>
      </div>
      <div class="gt-strip__btns">
        <button class="gt-strip__mute gc-btn gc-btn--sm" data-channel="${name}" data-action="mute"
          aria-pressed="false" aria-label="Mute ${escHtml(label)}">M</button>
        <button class="gt-strip__solo gc-btn gc-btn--sm" data-channel="${name}" data-action="solo"
          aria-pressed="false" aria-label="Solo ${escHtml(label)}">S</button>
      </div>
    `

    stripEls[name] = strip
    meterBarEls[name] = strip.querySelector('.gt-strip__meter-bar')
    stripsWrap.appendChild(strip)
  }
  container.appendChild(stripsWrap)

  // Master volume strip — inside stripsWrap so it sits in the same row,
  // margin-left:auto (via gt-strip--master CSS) pins it to the far right.
  const masterStrip = document.createElement('div')
  masterStrip.className = 'gt-strip gt-strip--master'
  masterStrip.innerHTML = `
    <div class="gt-strip__accent" style="background:#e2e8f0"></div>
    <div class="gt-strip__label">Master</div>
    <div class="gt-strip__fader-wrap">
      <input
        type="range"
        class="gt-strip__fader"
        min="0" max="1" step="0.01" value="0.75"
        aria-label="Master volume"
      />
    </div>
    <div class="gt-strip__db">0 dB</div>
  `
  masterStrip.querySelector('.gt-strip__fader').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value)
    engine.setMasterVolume(v)
    masterStrip.querySelector('.gt-strip__db').textContent = faderToDb(v)
  })
  stripsWrap.appendChild(masterStrip)

  // Transport
  const { el: transportEl, destroy: destroyTransport } = createTransport({
    engine,
    metronome: metro,
    meters: metersInst,
    song,
    onPlay: () => {
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'
    },
    onPause: () => {
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'
    },
    onCountInBeat: ({ beat, total }) => {
      countInOverlay.hidden = false
      countInOverlay.textContent = beat
    },
    onCountInEnd: () => {
      countInOverlay.hidden = true
    },
    onMetersToggle: (active) => {
      stripsWrap.classList.toggle('gt-strips--meters', active)
    },
  })
  container.appendChild(transportEl)

  // — Wire fader, mute, solo
  stripsWrap.addEventListener('input', (e) => {
    if (!e.target.classList.contains('gt-strip__fader')) return
    const strip = e.target.closest('[data-channel]')
    const name = strip?.dataset.channel
    if (!name) return
    const v = parseFloat(e.target.value)
    engine.setFader(name, v)
    // Update dB readout
    const db = faderToDb(v)
    strip.querySelector('.gt-strip__db').textContent = db
  })

  stripsWrap.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]')
    if (!btn) return
    const name = btn.dataset.channel
    const action = btn.dataset.action

    if (action === 'mute') {
      const muted = engine.toggleMute(name)
      btn.setAttribute('aria-pressed', String(muted))
      btn.classList.toggle('is-muted', muted)
    } else if (action === 'solo') {
      const soloed = engine.toggleSolo(name)
      // Update all solo buttons
      stripsWrap.querySelectorAll('[data-action="solo"]').forEach(b => {
        const s = b.dataset.channel === name ? soloed : false
        b.setAttribute('aria-pressed', String(s))
        b.classList.toggle('is-soloed', s)
      })
    }
  })

  // — Meter updates
  metersInst.onUpdate = (levels) => {
    for (const [name, db] of Object.entries(levels)) {
      const bar = meterBarEls[name]
      if (!bar) continue
      // Map -60..0 dBFS to 0..100%
      const pct = Math.max(0, Math.min(100, (db + 60) / 60 * 100))
      bar.style.height = `${pct}%`
      // Color: green < -12, yellow -12..-3, red > -3
      bar.style.background = db > -3 ? '#ef4444' : db > -12 ? '#eab308' : '#22c55e'
    }
  }

  // — Return cleanup function (called by main.js when navigating to a different song)
  return function cleanup() {
    engine.dispose()
    metro.stop()
    metersInst.stop()
    destroyTransport()
    document.removeEventListener('visibilitychange', onVisibilityChange)
    if ('mediaSession' in navigator) {
      for (const action of ['play', 'pause', 'seekto', 'seekbackward', 'seekforward']) {
        navigator.mediaSession.setActionHandler(action, null)
      }
    }
  }
}

function faderToDb(v) {
  if (v <= 0) return '-∞'
  let linear
  if (v <= 0.75) {
    linear = Math.pow(v / 0.75, 2)
  } else {
    linear = 1 + ((v - 0.75) / 0.25) * 1
  }
  if (linear <= 0) return '-∞'
  return `${(20 * Math.log10(linear)).toFixed(1)} dB`
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
