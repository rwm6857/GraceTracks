// User preference persistence — remembers transport control choices across
// sessions so the mixer reopens the way the user left it. These are global
// UI preferences (count-in, click track, click volume, meters), NOT per-song
// state: track faders/mutes/solos are intentionally left alone since they
// differ song to song. Theme persistence lives separately in theme.js.
//
// All access is wrapped in try/catch: localStorage can throw when storage is
// disabled or full (e.g. Safari private mode), in which case we silently fall
// back to the in-memory defaults the caller supplies.

const PREFIX = 'gracetracks.prefs.'

function read(key) {
  try {
    return localStorage.getItem(PREFIX + key)
  } catch {
    return null
  }
}

function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, value)
  } catch {
    // Storage unavailable/full — preference simply won't persist this session.
  }
}

/** Read a stored boolean, falling back to `fallback` when unset/unparseable. */
export function getBool(key, fallback) {
  const v = read(key)
  if (v === 'true') return true
  if (v === 'false') return false
  return fallback
}

/** Read a stored number clamped to [min, max], falling back when unset/NaN. */
export function getNumber(key, fallback, { min = -Infinity, max = Infinity } = {}) {
  const v = read(key)
  if (v === null) return fallback
  const n = parseFloat(v)
  if (Number.isNaN(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export function setBool(key, value) {
  write(key, value ? 'true' : 'false')
}

export function setNumber(key, value) {
  write(key, String(value))
}
