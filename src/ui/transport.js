/**
 * Transport
 *
 * Renders the transport bar and wires it to an AudioEngine instance.
 * Returns a { el, destroy } object.
 *
 * @param {object} opts
 * @param {import('../audio/engine.js').AudioEngine} opts.engine
 * @param {import('../audio/metronome.js').Metronome} opts.metronome
 * @param {import('../audio/meters.js').Meters} opts.meters
 * @param {object} opts.song - { tempo, time_signature }
 * @param {function} opts.onPlay - called when play is initiated (after count-in if enabled)
 * @param {function} opts.onPause
 * @param {function} opts.onCountInBeat - called with { beat, total } during count-in
 * @param {function} opts.onCountInEnd
 * @param {function} opts.onMetersToggle - called with boolean (active)
 */
export function createTransport({
  engine, metronome, meters, song,
  onPlay, onPause, onCountInBeat, onCountInEnd, onMetersToggle
}) {
  const bpm = song.tempo || 120
  const timeSig = parseInt(song.time_signature?.split('/')?.[0] ?? '4', 10)

  let countInEnabled = true
  let metronomeEnabled = false
  let metersActive = false

  const el = document.createElement('div')
  el.className = 'gt-transport'
  el.innerHTML = `
    <div class="gt-transport__seek-row">
      <input
        type="range"
        class="gt-transport__seek"
        min="0" max="100" value="0" step="0.1"
        aria-label="Seek"
      >
    </div>

    <div class="gt-transport__group gt-transport__group--play">
      <button class="gt-transport__play gc-btn gc-btn--primary" aria-label="Play" data-action="play">
        <svg class="gt-icon" viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5v14l11-7z"/>
        </svg>
        <span class="gt-transport__play-label">Play</span>
      </button>
    </div>

    <div class="gt-transport__group gt-transport__group--info">
      <span class="gt-transport__position" aria-live="off">0:00</span>
      <span class="gt-transport__divider">/</span>
      <span class="gt-transport__duration">0:00</span>
      <span class="gt-transport__divider">·</span>
      <span class="gt-transport__bpm">${bpm} BPM</span>
      <span class="gt-transport__divider">·</span>
      <span class="gt-transport__timesig">${song.time_signature || '4/4'}</span>
    </div>

    <div class="gt-transport__group gt-transport__group--toggles">
      <button
        class="gt-transport__toggle gc-btn gc-btn--ghost gc-btn--sm"
        data-action="countin"
        aria-pressed="true"
        title="Count-in"
      >Count-in</button>
      <button
        class="gt-transport__toggle gc-btn gc-btn--ghost gc-btn--sm"
        data-action="metronome"
        aria-pressed="false"
        title="Metronome click"
      >
        <svg class="gt-icon" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2L8 7H4l4 5-1 10h10l-1-10 4-5h-4L12 2zm0 3l2.5 3.5H14l.8 8.5H9.2L10 8.5H9.5L12 5z"/>
        </svg>
      </button>
      <button
        class="gt-transport__toggle gc-btn gc-btn--ghost gc-btn--sm"
        data-action="meters"
        aria-pressed="false"
        title="Show meters"
      >
        <svg class="gt-icon" viewBox="0 0 24 24" fill="currentColor">
          <path d="M3 18h4v-6H3v6zm0-8h4V4H3v6zm6 8h4V4H9v14zm6 0h4v-4h-4v4zm0-6h4v-2h-4v2z"/>
        </svg>
      </button>
    </div>
  `

  const playBtn = el.querySelector('[data-action="play"]')
  const posEl = el.querySelector('.gt-transport__position')
  const durationEl = el.querySelector('.gt-transport__duration')
  const seekEl = el.querySelector('.gt-transport__seek')
  const countInBtn = el.querySelector('[data-action="countin"]')
  const metronomeBtn = el.querySelector('[data-action="metronome"]')
  const metersBtn = el.querySelector('[data-action="meters"]')

  function formatTime(secs) {
    const s = Math.floor(secs)
    const m = Math.floor(s / 60)
    return `${m}:${String(s % 60).padStart(2, '0')}`
  }

  // Initialise seek bar range and total duration display
  const totalDuration = engine.duration
  seekEl.max = totalDuration || 100
  durationEl.textContent = formatTime(totalDuration)

  function updateSeekFill(t) {
    const pct = totalDuration > 0 ? (t / totalDuration) * 100 : 0
    seekEl.style.background =
      `linear-gradient(to right, var(--gc-primary) ${pct}%, var(--gc-surface-3) ${pct}%)`
  }
  updateSeekFill(0)

  // Seek bar interaction
  let isSeeking = false
  seekEl.addEventListener('pointerdown', () => { isSeeking = true })
  seekEl.addEventListener('input', () => {
    const t = parseFloat(seekEl.value)
    posEl.textContent = formatTime(t)
    updateSeekFill(t)
  })
  seekEl.addEventListener('change', () => {
    const t = parseFloat(seekEl.value)
    posEl.textContent = formatTime(t)
    updateSeekFill(t)
    engine.seekTo(t)
    isSeeking = false
  })

  function setPlayState(playing) {
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play')
    playBtn.querySelector('.gt-transport__play-label').textContent = playing ? 'Pause' : 'Play'
    playBtn.querySelector('svg').innerHTML = playing
      ? '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>'
      : '<path d="M8 5v14l11-7z"/>'
    playBtn.dataset.action = playing ? 'pause' : 'play'
  }

  // Position updates from engine RAF
  engine.onPositionUpdate = (t) => {
    posEl.textContent = formatTime(t)
    if (!isSeeking) {
      seekEl.value = t
      updateSeekFill(t)
    }
  }
  engine.onEnded = () => {
    setPlayState(false)
    seekEl.value = 0
    updateSeekFill(0)
    posEl.textContent = formatTime(0)
  }

  // — Play / Pause
  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]')
    if (!btn) return
    const action = btn.dataset.action

    if (action === 'play') {
      if (countInEnabled) {
        playBtn.disabled = true
        metronome.countIn(bpm, timeSig,
          (beatInfo) => onCountInBeat?.(beatInfo),
          (startAt) => {
            playBtn.disabled = false
            onCountInEnd?.()
            engine.play(0, startAt)
            if (metronomeEnabled) metronome.start(bpm, timeSig, startAt)
            setPlayState(true)
            onPlay?.()
          }
        )
      } else {
        engine.play(engine.currentTime)
        if (metronomeEnabled) metronome.start(bpm, timeSig)
        setPlayState(true)
        onPlay?.()
      }
    } else if (action === 'pause') {
      engine.pause()
      metronome.stop()
      setPlayState(false)
      onPause?.()
    } else if (action === 'countin') {
      countInEnabled = !countInEnabled
      countInBtn.setAttribute('aria-pressed', String(countInEnabled))
      countInBtn.classList.toggle('is-active', countInEnabled)
    } else if (action === 'metronome') {
      metronomeEnabled = !metronomeEnabled
      metronomeBtn.setAttribute('aria-pressed', String(metronomeEnabled))
      metronomeBtn.classList.toggle('is-active', metronomeEnabled)
      if (!metronomeEnabled) metronome.stop()
    } else if (action === 'meters') {
      metersActive = !metersActive
      metersBtn.setAttribute('aria-pressed', String(metersActive))
      metersBtn.classList.toggle('is-active', metersActive)
      metersActive ? meters.start() : meters.stop()
      onMetersToggle?.(metersActive)
    }
  })

  // Spacebar play / pause
  function handleKeydown(e) {
    if (e.code !== 'Space') return
    const tag = document.activeElement?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return
    e.preventDefault()
    playBtn.click()
  }
  document.addEventListener('keydown', handleKeydown)

  function destroy() {
    engine.onPositionUpdate = null
    engine.onEnded = null
    document.removeEventListener('keydown', handleKeydown)
  }

  return { el, destroy }
}
