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
import { icon } from './icons.js'

export function createTransport({
  engine, metronome, meters, song,
  onPlay, onPause, onCountInBeat, onCountInEnd, onMetersToggle
}) {
  const bpm = song.tempo || 120
  const timeSig = parseInt(song.time_signature?.split('/')?.[0] ?? '4', 10)

  const hasClick   = engine.getLoadedChannels().includes('click')
  const hasAmbient = engine.getLoadedChannels().includes('ambient')

  let countInEnabled = true
  let clickEnabled   = false
  let clickVolume    = 0.75   // unity gain; adjusted by vol up/down buttons
  let ambientEnabled = false
  let metersActive   = false

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
      <button class="gt-transport__stop gc-btn" aria-label="Rewind to start" data-action="stop">
        ${icon('rewind', { className: 'gt-icon gt-transport__stop-icon' })}
      </button>
      <button class="gt-transport__play gc-btn gc-btn--primary" aria-label="Play" data-action="play">
        ${icon('play', { className: 'gt-icon gt-transport__play-icon' })}
      </button>
    </div>

    <div class="gt-transport__group gt-transport__group--info">
      <span class="gt-transport__position" aria-live="off">0:00</span>
      <span class="gt-transport__divider">/</span>
      <span class="gt-transport__duration">0:00</span>
    </div>

    <div class="gt-transport__group gt-transport__group--toggles">
      <button
        class="gt-transport__toggle gc-btn gc-btn--sm"
        data-action="countin"
        aria-pressed="true"
        title="Count-in"
      >
        <span class="gt-transport__countin-icon" aria-hidden="true">
          <span class="gt-transport__countin-nums">1234</span>
          <svg width="8" height="5" viewBox="0 0 8 5" fill="currentColor" class="gt-transport__countin-caret"><path d="M0 0l4 5 4-5z"/></svg>
        </span>
      </button>
      ${hasClick ? `
      <button
        class="gt-transport__toggle gc-btn gc-btn--sm"
        data-action="metronome"
        aria-pressed="false"
        title="Click track"
      >
        <svg class="gt-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 21h12l2.5-18H3.5L6 21z" stroke-width="1.5"/>
          <line x1="12" y1="5.5" x2="17" y2="17.5" stroke-width="2"/>
        </svg>
      </button>
      <button
        class="gt-transport__toggle gc-btn gc-btn--sm"
        data-action="click-vol-down"
        title="Click volume down"
        aria-label="Click volume down"
      >
        ${icon('volume-down')}
      </button>
      <button
        class="gt-transport__toggle gc-btn gc-btn--sm"
        data-action="click-vol-up"
        title="Click volume up"
        aria-label="Click volume up"
      >
        ${icon('volume-up')}
      </button>
      ` : ''}
      ${hasAmbient ? `
      <button
        class="gt-transport__toggle gc-btn gc-btn--sm"
        data-action="ambient"
        aria-pressed="false"
        title="Ambient"
      >
        ${icon('ambient')}
      </button>
      ` : ''}
      <button
        class="gt-transport__toggle gc-btn gc-btn--sm"
        data-action="meters"
        aria-pressed="false"
        title="Show meters"
      >
        ${icon('meters')}
      </button>
    </div>
  `

  const playBtn      = el.querySelector('.gt-transport__play')
  const stopBtn      = el.querySelector('.gt-transport__stop')
  const posEl        = el.querySelector('.gt-transport__position')
  const durationEl   = el.querySelector('.gt-transport__duration')
  const seekEl       = el.querySelector('.gt-transport__seek')
  const countInBtn   = el.querySelector('[data-action="countin"]')
  const metronomeBtn = el.querySelector('[data-action="metronome"]')  // null if no click stem
  const ambientBtn   = el.querySelector('[data-action="ambient"]')    // null if no ambient stem
  const metersBtn    = el.querySelector('[data-action="meters"]')

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
  let resumeAfterSeek = false

  seekEl.addEventListener('pointerdown', () => {
    isSeeking = true
    resumeAfterSeek = engine.playing
    if (resumeAfterSeek) {
      engine.pause()
      metronome.stop()
    }
  })

  seekEl.addEventListener('input', () => {
    // Visual-only update during drag.
    //
    // Root cause of the scrub desync: calling engine.seekTo() on every input
    // event triggers audio.currentTime = offset on each HTMLAudioElement in a
    // tight loop. HTMLAudioElements process seek requests asynchronously (each
    // element buffers/decodes independently). Rapid reassignments race against
    // in-flight seeks so different stems land at different positions when play
    // resumes — producing a timing offset that accumulates.
    //
    // Fix: update only the UI here; commit the single authoritative seek once
    // on pointerup in endSeek() so all stems receive one seek command while idle.
    const t = parseFloat(seekEl.value)
    posEl.textContent = formatTime(t)
    updateSeekFill(t)
  })

  function endSeek() {
    if (!isSeeking) return
    isSeeking = false
    const t = parseFloat(seekEl.value)
    posEl.textContent = formatTime(t)
    updateSeekFill(t)
    if (resumeAfterSeek && playBtn.dataset.action === 'pause') {
      // play(t) seeks all stems internally, waits for every 'seeked' event,
      // then starts playback — no separate seekTo() needed here. Calling
      // seekTo() first would start async seeks on every element, then play(t)
      // would immediately cancel them with a second set of seeks before either
      // batch completes, worsening the desync instead of fixing it.
      engine.resumeIfSuspended().then(() => {
        engine.play(t)
      })
    } else {
      // Not resuming — just update the stored position without playing.
      engine.seekTo(t)
    }
    resumeAfterSeek = false
  }

  function cancelSeek() {
    if (!isSeeking) return
    isSeeking = false
    resumeAfterSeek = false
  }

  document.addEventListener('pointerup', endSeek)
  document.addEventListener('pointercancel', cancelSeek)

  function setPlayState(playing) {
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play')
    playBtn.innerHTML = icon(playing ? 'pause' : 'play', { className: 'gt-icon gt-transport__play-icon' })
    playBtn.dataset.action = playing ? 'pause' : 'play'

    // Second button: Stop (pause + reset to start) while playing,
    // Rewind (reset to start only) while stopped.
    stopBtn.setAttribute('aria-label', playing ? 'Stop' : 'Rewind to start')
    stopBtn.innerHTML = icon(playing ? 'stop' : 'rewind', { className: 'gt-icon gt-transport__stop-icon' })
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
      // resumeIfSuspended must run inside the user-gesture handler so iOS
      // unlocks the AudioContext (and subsequent audio.play() calls) before
      // the count-in setTimeout fires engine.play().
      await engine.resumeIfSuspended()
      if (countInEnabled) {
        playBtn.disabled = true
        const startPos = engine.currentTime
        metronome.countIn(bpm, timeSig,
          (beatInfo) => onCountInBeat?.(beatInfo),
          (startAt) => {
            playBtn.disabled = false
            onCountInEnd?.()
            engine.play(startPos, startAt)
            setPlayState(true)
            onPlay?.()
          }
        )
      } else {
        engine.play(engine.currentTime)
        setPlayState(true)
        onPlay?.()
      }
    } else if (action === 'pause') {
      engine.pause()
      metronome.stop()
      setPlayState(false)
      onPause?.()
    } else if (action === 'stop') {
      // Acts as Stop while playing (halt + reset to start) and as Rewind while
      // stopped (reset to start only). Either way the playhead returns to 0.
      const wasPlaying = playBtn.dataset.action === 'pause'
      const wasCountingIn = playBtn.disabled
      engine.pause()
      metronome.stop()
      playBtn.disabled = false
      if (wasCountingIn) onCountInEnd?.()
      if (wasPlaying) onPause?.()
      setPlayState(false)
      engine.seekTo(0)
      seekEl.value = 0
      updateSeekFill(0)
      posEl.textContent = formatTime(0)
    } else if (action === 'countin') {
      countInEnabled = !countInEnabled
      countInBtn.setAttribute('aria-pressed', String(countInEnabled))
      countInBtn.classList.toggle('is-active', countInEnabled)
    } else if (action === 'metronome') {
      // Toggle click track stem (audio file), not the oscillator generator
      clickEnabled = !clickEnabled
      metronomeBtn.setAttribute('aria-pressed', String(clickEnabled))
      metronomeBtn.classList.toggle('is-active', clickEnabled)
      engine.setFader('click', clickEnabled ? clickVolume : 0)
    } else if (action === 'click-vol-down') {
      clickVolume = Math.max(0, Math.round((clickVolume - 0.1) * 10) / 10)
      if (clickEnabled) engine.setFader('click', clickVolume)
    } else if (action === 'click-vol-up') {
      clickVolume = Math.min(1, Math.round((clickVolume + 0.1) * 10) / 10)
      if (clickEnabled) engine.setFader('click', clickVolume)
    } else if (action === 'ambient') {
      ambientEnabled = !ambientEnabled
      ambientBtn.setAttribute('aria-pressed', String(ambientEnabled))
      ambientBtn.classList.toggle('is-active', ambientEnabled)
      engine.setFader('ambient', ambientEnabled ? 0.75 : 0)
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
    document.removeEventListener('pointerup', endSeek)
    document.removeEventListener('pointercancel', cancelSeek)
  }

  return { el, destroy }
}
