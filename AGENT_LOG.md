# GraceTracks Agent Activity Log

Log of agent-driven development, decisions, and milestones on the GraceTracks project.

### 2026-06-17 — Upload page UX overhaul + stop-playback-on-leave

**Agent**: Claude (claude-opus-4-8)
**Branch**: `claude/awesome-mayer-3j7hiu`
**Status**: Completed

**Summary**: A batch of upload-page polish plus two app-shell fixes. Stem tiles
are now fixed squares (`aspect-ratio: 1`) that never reflow when a file/stem is
present, laid out with an `auto-fill minmax(130px)` grid so the row stays full
(no lone "Ambient" tile orphaned on its own row) and the squares are smaller.
The version selector now lists Original first (selected by default) with "Add
new version" last and its name field inline; each version has an icon-only
delete that opens a confirmation modal (deleting Original removes all
recordings). New-song creation now links out to the GraceChords editor instead
of the inline form. Leaving the mixer for any other view now disposes the audio
session so playback stops, and the navbar "Upload" action opens a fresh page
while reloads/back-forward restore the prior song+version selection.

**Changes**:
- `src/ui/uploadSong.js` — square-tile inline "Drop file or Browse"; trimmed
  hint + "Search for a Song" heading; "Change"→"Clear"; removed inline new-song
  form (now an external link to `gracechords.com/portal/editor`); version block
  reordered (Original default + inline new-version name); per-version delete via
  confirm modal; success panel reverts to the Upload button when a stem changes;
  sessionStorage persists song+version selection across reloads.
- `src/ui/confirmModal.js` — new reusable promise-based confirmation modal.
- `src/main.js` — `disposeMixer()` on leaving the mixer (stops playback);
  `navigate(path, { freshUpload })` + fresh-upload handling.
- `src/ui/navbar.js` — "Upload" actions request a fresh upload page; bolder
  nav links.
- `src/styles/components.css` — square tiles + auto-fill grid, inline browse
  link, corner delete/remove buttons, version-name input, confirm modal,
  `.gc-navlink` font-weight.

**Follow-up fixes (same PR #68)**:
- Fixed the upload-submit "nothing happens" bug: the auth listener rebuilt the
  upload page on *every* auth event. `getSession()` during submit can trigger a
  TOKEN_REFRESHED event, which tore down the in-flight page and reset the form.
  Now `main.js` only rebuilds editor pages when the editor status actually
  changes (gated on `authKey(user)`), not on token refresh / initial-session.
- Shortened upload-tile labels: "Electric Guitar"→"Elec", "Keys / Piano"→"Keys",
  "Click Track"→"Click".

### 2026-06-15 — Fix: replacements corrupt stems (overwrite → delete-then-write)

**Agent**: Claude (claude-opus-4-8)
**Branch**: `claude/friendly-darwin-jgibva`
**Status**: Completed

**Summary**: Root cause of the "replaced stem won't play" reports. Diagnosed via
controlled tests: the same WAV uploaded to a new song works, but used as a
replacement is corrupt at the R2 *origin* (dashboard download broken), at about
the same byte size. So the converter, source file, and CDN are all clean — the
trigger is **overwriting an existing R2 object via the presigned PUT**; writing
the identical bytes to a fresh (never-used) key is always fine. Reworked the
upload to never overwrite: delete-then-write.

**Changes**:
- `src/ui/uploadSong.js` — per-track upload is now: (1) delete existing file(s)
  for the track, (2) `waitUntilGone` polls R2 until they're confirmed gone, (3)
  convert/rename, (4) presign + PUT to the now-empty key, (5) `confirmUploaded`
  verifies the stored object's byte size matches what was sent. Replaces the old
  overwrite + post-upload stale-sibling cleanup.
- `src/lib/stemsApi.js` — `statStemFiles()` returns `[{name,size}]` from the S3
  listing (origin, no CDN); `listStemFiles` now derives names from it. Used by
  both confirmation steps.

### 2026-06-15 — Fix: Safari WAV→M4A conversion produced silent/corrupt stems

**Agent**: Claude (claude-opus-4-8)
**Branch**: `claude/friendly-darwin-jgibva`
**Status**: Completed

**Summary**: Follow-up to the cache fix. After confirming the replaced stem was
written to R2 (updated timestamp, no 404) but played silent in-app and wouldn't
play when downloaded, traced it to the in-browser WAV→M4A converter on Safari/Mac,
not caching or a delete/upload race (the stale-file cleanup provably never targets
the just-uploaded key; R2 overwrites are atomic). Safari's WebCodecs `AudioEncoder`
omits `decoderConfig.description`, so mp4-muxer wrote an MP4 with no AAC codec
config → an undecodable/silent file that still uploaded fine.

**Changes** (`src/audio/encodeM4a.js`):
- `buildAacAsc()` — synthesizes the 2-byte AAC-LC AudioSpecificConfig and injects
  it into the encoder output's `decoderConfig.description` only when the browser
  omits it, so the muxer writes a valid esds (Chrome's real description untouched).
- `verifyPlayableM4a()` — after finalize, decodes the M4A and asserts it's
  non-empty, ~full-length, and non-silent; throws otherwise. The uploader's
  existing try/catch then falls back to uploading the raw WAV (mixer supports it),
  so a corrupt file can no longer reach R2. On re-upload the stale-sibling cleanup
  removes the broken .m4a.

### 2026-06-15 — Fix: replaced stems served stale (service-worker CacheFirst)

**Agent**: Claude (claude-opus-4-8)
**Branch**: `claude/friendly-darwin-jgibva`
**Status**: Completed

**Summary**: Replacing a stem in the uploader writes fresh bytes to R2, but the
file overwrites the same R2 key — so its URL is byte-for-byte identical. The PWA
service worker caches `.m4a`/`.wav` with `CacheFirst` (90-day TTL), so the mixer
kept serving the old audio even after a hard reload (the SW answers before the
network). Verified the upload/delete data paths are internally consistent (same
keys the mixer reads), confirming this is caching, not an R2-write failure.

Fixed with a per-song cache-bust token: a new `songs.stems_updated_at` column is
bumped on every stem upload/replace/delete; the mixer appends it to stem URLs as
`?t=<epoch>`, giving the replaced file a fresh URL / cache entry (old entries age
out via the route's `maxEntries` LRU). One token per song over-invalidates across
versions — accepted as safe.

**Changes**:
- `supabase/migrations/20260615000000_songs_stems_updated_at.sql` — idempotent
  `ADD COLUMN IF NOT EXISTS stems_updated_at timestamptz` (GraceTracks-owned, same
  pattern as the existing has_stems/stem_slug columns).
- `src/audio/stems.js` — `resolveStemUrl` takes an optional `cacheToken`, appended
  as `?t=<token>` to each candidate URL.
- `src/ui/mixer.js` — selects `stems_updated_at`, derives the token, passes it.
- `vite.config.js` — stem route regex `→ /\.(wav|m4a)(\?.*)?$/i` so the busted URL
  still matches (otherwise it would bypass the cache entirely).
- `src/ui/uploadSong.js` — bumps `stems_updated_at` on upload submit (both attach
  and new-song paths) and on per-stem / version deletes (new `touchStems` helper).

### 2026-06-12 — Fix: /api/stems used the (unconfigured) R2 binding

**Agent**: Claude (claude-opus-4-8)
**Branch**: `claude/song-version-management-wsz89v`
**Status**: Completed

**Summary**: The stem-maintenance backend listed/deleted via the `STEMS_BUCKET`
R2 binding, which isn't reliably configured in Pages (presign deliberately uses
R2 API credentials for this reason; `wrangler.toml` only stubs the binding to the
wrong bucket for local dev). In production the listing returned 500, the uploader
swallowed it, and "Replace <version>" tiles showed nothing on the server with no
per-file delete. Rewrote `functions/api/stems.js` to talk to R2 over the S3 API
with the same credentials presign uses (`R2_ACCOUNT_ID` / `R2_BUCKET_NAME` /
`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`): ListObjectsV2 (delimiter '/' to keep
versions/ out of the Original listing, continuation-token paging) for GET, and
per-key DELETE (404 = already gone) for the files[]/version/song delete paths.
Now works in exactly the environments presign works, no extra binding needed.

**Changes**: `functions/api/stems.js` — S3-API list/delete via aws4fetch; clearer
500 (missing creds) / 502 (R2 error) responses. No frontend change.

**Build/verify**: `npm test` 66/66; `npm run build` clean.

### 2026-06-12 — Expand audio unit-test coverage

**Agent**: Claude
**Branch**: `claude/festive-hawking-tzjaqx`
**Status**: Completed

**Summary**: The only existing suite covered the phase-lock fallback engine; the surrounding
audio modules had no tests. Added focused unit tests for stem resolution, VU metering, the
metronome/count-in scheduler, and runtime engine selection. No production code changed.

**Changes**:
- `src/audio/stems.test.js` — `resolveStemUrl` m4a→wav format order, canonical-before-alias
  probing, network-error resilience, null + warning when nothing resolves.
- `src/audio/meters.test.js` — RMS→dBFS math (0 dBFS full-scale, -Infinity silence), skips
  channels without an analyser, RAF start/stop lifecycle.
- `src/audio/metronome.test.js` — count-in schedules one click per beat (accent on the
  downbeat) and fires onBeat/onReady on schedule; start/stop halts the lookahead loop.
- `src/audio/engineFactory.test.js` — `streamingSupported` capability detection and
  `createEngine` selection (?engine= / localStorage overrides, streaming-where-supported
  default, phase-lock fallback); concrete engines mocked.
- Suite now 49/49 (was 28).

### 2026-06-10 — Persist transport preferences in localStorage

**Agent**: Claude (claude-opus-4-8)
**Branch**: `claude/user-prefs-local-storage-i93wv5`
**Status**: Completed

**Summary**: Remember the user's global transport control choices across sessions so the mixer
reopens the way they left it. Persisted: count-in on/off, click track on/off, click volume, and
meters on/off. Theme (dark/light) was already persisted via `src/lib/theme.js`. Per-song track
state (faders, mutes, solos) is intentionally left untouched since it differs song to song.

**Changes**:
- Added `src/lib/prefs.js` — small namespaced (`gracetracks.prefs.*`) localStorage helper with
  `getBool`/`getNumber`/`setBool`/`setNumber`, all try/catch-wrapped so disabled/full storage
  (Safari private mode) silently falls back to in-memory defaults.
- `src/ui/transport.js`: initialize `countInEnabled` / `clickEnabled` / `clickVolume` /
  `metersActive` from prefs (defaults unchanged); on mount, sync restored values into the toggle
  button states and the audio engine (click fader + meters start); write each value back on
  toggle/adjustment.

**Build/verify**: `npm run build` clean; `npm test` 28/28.

**Agent**: Claude (claude-opus-4-8)
**Branch**: `claude/tender-volta-4u2cqz`
**Status**: Completed

**Summary**: On iPhone, locking the screen and returning to the open tab left playback dead —
the user had to reload the tracks to play again. Root cause: when iOS locks the screen it
suspends or (Safari-specifically) *interrupts* the AudioContext, but nothing told the engine,
so `_playing` stayed `true`. `play()` early-returns while `_playing`, so even tapping play /
MediaSession did nothing; the transport still showed "Pause"; and `resumeIfSuspended()` only
handled the standard `'suspended'` state, never iOS's `'interrupted'`. For the streaming engine
the WebCodecs decoders were also torn down while backgrounded.

**Changes**:
- `src/audio/stream/streamEngine.js` + `src/audio/engine.js`: wire `AudioContext.onstatechange`
  in `_ensureContext`; new `_handleStateChange()` treats a `suspended`/`interrupted` transition
  during playback as a clean self-pause — captures the playhead into `_pauseOffset`, pauses the
  worklets / `<audio>` elements, stops timers, and fires a new `onInterrupted` callback.
  `resumeIfSuspended()` now resumes from `'interrupted'` too; `onstatechange` cleared on dispose.
- `src/ui/transport.js`: wire `engine.onInterrupted` to flip the play button back to "Play"
  (and clear count-in state) so a single tap resumes from where it stopped; cleared in `destroy()`.
- `src/ui/mixer.js`: `.catch(() => {})` on `resumeIfSuspended()` calls (iOS may reject an
  interrupted-context resume outside a user gesture).
- `src/audio/engine.test.js`: 7 new tests covering suspend/interrupt self-pause, playhead
  capture, `onInterrupted` firing, paused/running no-ops, and `resumeIfSuspended()` state matrix.

**Build/verify**: `npm test` 28/28; `npm run build` clean.

### 2026-06-09 — Fix upload presign 401 (resilient Supabase env resolution)

**Agent**: Claude (claude-opus-4-8)
**Branch**: `claude/youthful-davinci-ehmodg`
**Status**: Completed

**Summary**: The new upload page returned `Presign failed (401)` on every stem while the
user was signed in. The Pages Function verifies the JWT against
`${env.SUPABASE_URL}/auth/v1/user`; when only the `VITE_`-prefixed Supabase vars were set
in the Pages deployment (the frontend needs those to boot), `env.SUPABASE_URL` was
`undefined`, so the verify fetch failed and the Function returned a misleading 401 for
every request.

**Changes**:
- `functions/api/presign.js` — resolve `SUPABASE_URL`/`SUPABASE_ANON_KEY` with a fallback to
  the `VITE_`-prefixed names (both are exposed to Functions at runtime in Pages); used for
  both the JWT verify and the PostgREST role lookup. Genuinely-missing config now returns a
  clear `500` instead of a misleading `401`.
- `src/ui/uploadSong.js` — clearer per-tile messages: `401` → "Session expired — sign out and
  back in.", `500` → "Server auth not configured.".

**Build/verify**: `npm test` 21/21, `npm run build` clean.

### 2026-06-09 — Add "MD" (Music Director) stem

**Agent**: Claude (claude-opus-4-8)
**Branch**: `claude/sharp-albattani-l44ptt`
**Status**: Completed

**Summary**: Added a new `md` (Music Director / talkback) stem. It renders as a normal
mixer channel strip — last strip before Master — with its own fader, mute/solo, meter,
a light-brown/orange accent (`#cd9b6a`), and an upload slot. Stem files resolve from
`md` and the aliases `talkback` / `director` / `musicdirector` (.m4a → .wav).

**Changes**:
- `src/audio/engine.js` — `STEMS` adds `md` after `strings` (so it's the last strip;
  click/ambient are excluded from strips).
- `src/audio/stems.js` — `md` alias group: `talkback`, `director`, `musicdirector`.
- `src/ui/mixer.js` — `CHANNEL_COLORS.md = #cd9b6a`, `CHANNEL_LABELS.md = 'MD'`.
- `src/ui/uploadSong.js` — `TRACKS` adds the `md` upload slot.
- `functions/api/presign.js` — `VALID_TRACKS` adds `md` (server-side upload validation).
- `src/assets/channels/md.svg` (new) — `X32-icons/md.bmp` traced with `potrace -i` (same
  pipeline as the other X32 icons) to a `currentColor` SVG; wired into `X32_ICONS` in
  `src/ui/icons.js`.

**Build/verify**: `npm run build` clean; `npm test` 21/21.

---

### 2026-06-09 — Fix unreachable Upload button on the upload view

**Agent**: Claude
**Branch**: `claude/cool-ptolemy-egt3ee`
**Status**: Completed

**Summary**: The app shell clips overflow (`#app` and `.gt-main` are `overflow:hidden`), so each view must own its scrolling. `.gt-upload` had no scroll container, so once a stem tile held a file its taller selected-state body grew the grid row and pushed the footer past the clip boundary — the "Upload Recordings" button became unreachable. Made `.gt-upload` flex to fill height and scroll internally (`flex:1; min-height:0; overflow-y:auto`).

**Changes**: `src/styles/components.css` — `.gt-upload` is now a self-scrolling flex item. No JS change; confirmed existing select-mode upload already fills only the provided stem slots and never deletes existing stems.

---

## Format

Each entry includes:
- **Date**: When the work was performed
- **Agent**: Claude or other agent name
- **Branch**: Feature/fix branch name
- **Summary**: Brief description of work
- **Changes**: Files modified and key decisions
- **Status**: Completed, In Progress, or Blocked

---

### 2026-06-09 — Navbar: shared user sprites + active-page highlight

**Agent**: Claude (claude-opus-4-8)
**Branch**: `claude/grace-tracks-sprites-navbar-match`
**Status**: Completed

**Summary**: Made the GraceTracks navbar match GraceChords visually. The profile
dropdown avatar now uses the same user sprite the person picked on GraceChords
(stored in `users.preferences.sprite`), and the active nav link gets the same
orange-pill highlight.

**Changes**:
- `public/sprites/*.webp` — copied the 15 shared sprite assets from GraceChords.
- `src/lib/auth.js` — `fetchProfile()` now also reads `preferences.sprite` and
  attaches it as `user.sprite`.
- `src/ui/navbar.js` — `spriteAvatar()` helper (mirrors GraceChords' SpriteAvatar,
  `/sprites/<id>.webp`, default `notes`); used in the desktop avatar button and
  the drawer profile link; added `setActive(path)` to highlight the Songs link.
- `src/main.js` — calls `navbar.setActive()` on each route render.
- `src/styles/components.css` — `.gc-sprite-avatar` styles; avatar button made
  transparent/padded so the round sprite sits cleanly.

**Build/verify**: `npm run build` clean (15 sprites bundled); `npm test` 21/21.

---

### 2026-06-09 — Fix role check: read from public.users.role (not app_metadata)

**Agent**: Claude (claude-opus-4-8)
**Branch**: `claude/grace-tracks-upload-auth-ifwppq`
**Status**: Completed

**Summary**: Owners/admins/editors were denied the upload button, page, presign,
and DB write because GraceTracks gated everything on `app_metadata.role`, which
GraceChords never populates. GraceChords' source of truth is `public.users.role`
(its `useAuth` reads `users.role`; the DB has `get_user_role()`/`has_min_role()`).
Re-pointed all three GraceTracks layers at `public.users.role`.

**Changes**:
- `src/lib/auth.js` — `getUser()`/`onAuthStateChange()` now fetch the role from
  `public.users` (self-select under RLS) and attach it as `user.role`;
  `isEditorPlus()` reads `user.role` (falls back to app_metadata).
- `functions/api/presign.js` — role check now queries
  `/rest/v1/users?id=eq.<uid>&select=role` with the caller's token instead of
  reading `app_metadata.role`.
- `supabase/migrations/20260609000000_songs_stem_role_from_users.sql` (new) —
  recreates the `songs_write_editor` policy to gate on a `public.users` subquery
  instead of JWT `app_metadata.role`. **Must be applied** (Supabase SQL editor or
  `supabase db push`) for uploads to write the song row.
- `CLAUDE.md` — corrected constraint #6 + DB rule to state the role lives in
  `public.users.role`.

**Build/verify**: `npm run build` clean; `npm test` 21/21.

---

### 2026-06-09 — GraceChords-style navbar (theme toggle, profile + settings dropdowns, drawer)

**Agent**: Claude (claude-opus-4-8)
**Branch**: `claude/grace-tracks-upload-auth-ifwppq`
**Status**: Completed

**Summary**: Replaced the simple GraceTracks navbar with a vanilla-JS port of the
GraceChords navbar so the two sites match. Desktop shows the brand, two links
(GraceChords home + GraceTracks song list), a gear "settings" dropdown, and a
profile dropdown. The settings tray contains a dark/light theme pill toggle
(GraceChords' iOS-style segmented control, Sun/Moon), persisted to localStorage
and applied via `<html data-theme>`. The profile dropdown holds the editor-only
Upload link (in place of GraceChords' song editor), a link to the GraceChords
profile page, and Sign Out; signed-out users get a Sign In button. On ≤820px a
hamburger opens a slide-in drawer with the same links/settings/auth, matching the
GraceChords breakpoints (hamburger ≤820px, larger touch targets ≤640px). Only
toggles relevant to GraceTracks are included (theme only — no locale/chord-style).

**Changes**:
- `src/lib/theme.js` (new) — theme apply/toggle/init ported from GraceChords
  (`gracetracks.theme` storage key, defaults dark).
- `src/ui/navbar.js` (new) — `createNavbar({ navigate })` factory: brand, links,
  settings tray, profile dropdown, hamburger drawer; outside-click + Esc dismiss;
  body-scroll lock; `setUser()` updates auth slots and editor-gated Upload.
- `src/ui/icons.js` — added Settings/Sun/Moon/LogOut/ChevronRight/User lucide icons.
- `src/main.js` — boots `initTheme()` + `createNavbar`; removed the old
  `renderNav`/`updateNavAuth` and their click wiring.
- `src/styles/components.css` — ported gc-navbar / settings-tray / pill-toggle /
  user-dropdown / drawer styles + `gc-btn--secondary`/`--destructive`.
- `src/styles/main.css` — removed old `.gt-navbar*`; added bridge tokens
  (`--primary`, `--primary-text`, `--safe-b`, `--drawer-surface`, `--drawer-text`)
  that the shared nav styles expect (kept tokens.css verbatim).

**Build/verify**: `npm run build` clean; `npm test` 21/21. (No headless browser in
the sandbox, so not visually screenshotted.)

---

### 2026-06-09 — Upload page: song search, WAV→M4A, instrument-slot rename

**Agent**: Claude (claude-opus-4-8)
**Branch**: `claude/grace-tracks-upload-auth-ifwppq`
**Status**: Completed

**Summary**: Reworked the editor-only upload page so recordings attach to an
existing GraceChords song chosen via a search bar that mirrors the GraceChords
word-prefix search ranking, with a "create a new song" fallback. Up to 10 stems
slot into fixed instrument tiles (each file is renamed to its instrument slot in
R2). WAV files are converted to M4A in-browser before upload where WebCodecs AAC
encoding is available, falling back to uploading the raw WAV otherwise. Auth
gating (editor/admin/owner) and the role-gated nav Upload button already existed
and were left intact — no new database values added.

**Changes**:
- `src/lib/songSearch.js` (new) — trimmed copy of the GraceChords word-prefix
  search ranking (title + artist), returns best-match-first.
- `src/audio/encodeM4a.js` (new) — `isM4aEncodeSupported()` + `wavFileToM4a()`
  using WebCodecs `AudioEncoder` (mp4a.40.2) + `mp4-muxer`. Upload-time only;
  graceful fallback to raw WAV where unsupported (iOS Safari/Firefox).
- `src/ui/uploadSong.js` — song-search combobox (loads full catalog; editors can
  read all rows via the editor RLS policy), selected-song card + "new song"
  toggle; per-tile target-filename hint; WAV→M4A on submit; existing songs get an
  `update` of only stem fields (no metadata clobber), new songs `upsert`.
- `src/styles/components.css` — search dropdown / selected-song card / new-song
  toggle styles; upload-slot scribble-strip icon resized 24→36px (downsized from
  the mixer's 44px) per request.
- `package.json` — added `mp4-muxer`.

**Build/verify**: `npm run build` clean; `npm test` 21/21.

---

### 2026-06-09 — X32 instrument icons (BMP → SVG)

**Agent**: Claude (claude-opus-4-8)
**Branch**: `claude/sharp-albattani-l44ptt`
**Status**: Completed

**Summary**: Replaced the Lucide instrument icons with the Behringer X32 scribble-strip
set (drums, perc, bass, elec, keys, synth, vox, strings). The source 64×64 BMPs (white
line-art on black) were vectorised with `potrace -i` and rewritten to `currentColor` so
they inherit the theme. Lucide still backs `click`/`ambient`/`master` and all transport/UI
icons.

**Changes**:
- `X32-icons/*.bmp` — source bitmaps (from github.com/mamarguerat/behringer-icons, Apache-2.0).
- `scripts/convert-x32-icons.sh` — reproducible potrace pipeline (BMP → currentColor SVG).
- `src/assets/channels/*.svg` — 8 vendored instrument icons + `ATTRIBUTION.md` (Apache-2.0).
- `src/ui/icons.js` — `channelIcon()` returns the X32 SVG (Vite `?raw` import, class
  injected) for the 8 instruments; falls back to Lucide for click/ambient/master.
- License is compatible: GraceTracks is Apache-2.0, same as the icon source.

**Build/verify**: `npm run build` clean; `npm test` 21/21; rendered preview confirmed all 8
trace cleanly on the dark theme.

**Note**: the old `public/icons/channels/*.svg` are now unused (kept for now; safe to remove).

---

### 2026-06-09 — Lucide icons + Stop/Rewind transport button

**Agent**: Claude (claude-opus-4-8)
**Branch**: `claude/sharp-albattani-l44ptt`
**Status**: Completed

**Summary**: Migrated the hand-rolled inline SVG icons to Lucide (matching GraceChords'
icon system) and added a second transport button that acts as Stop while playing (halt +
reset to start) and Rewind while stopped (reset to start only).

**Changes**:
- Added `lucide` dependency. New `src/ui/icons.js` helper imports only the icons we use
  (tree-shaken) and renders them to SVG-string markup so they drop into the existing
  innerHTML template literals — no framework, no runtime DOM scanning.
- `src/ui/transport.js`: play/pause, ambient (→ Waves), meters (→ AudioLines), click
  volume down/up (→ Volume1/Volume2) now use Lucide. Added Stop/Rewind button
  (`data-action="stop"`) left of play; `setPlayState` swaps its icon (Square ↔ SkipBack)
  and label with play state. Play button now selected by class (data-action toggles).
- `src/ui/mixer.js`: back-link arrow → Lucide ChevronLeft.
- `src/ui/uploadSong.js`: stem remove "✕" → Lucide X.
- `src/styles/components.css`: `.gt-transport__stop` (secondary surface fill) + icon size.
- Kept bespoke (no suitable Lucide equivalent): count-in "1234" block, metronome glyph,
  per-stem channel artwork in `public/icons/channels/`. Volume down/up use level icons
  (Volume1/Volume2) as the closest approximation to decrement/increment.

**Build/verify**: `npm run build` clean; `npm test` 21/21.

---

## Entries

### 2026-03-30 — Schema Documentation & Agent Logging Setup

**Agent**: Claude
**Branch**: `claude/schema-docs-agent-log-YtCEH`
**Status**: Completed

**Summary**:
Documented GraceTracks database schema and created this agent activity log to track future Claude and agent-driven work.

**Changes**:
- Updated `README.md` with comprehensive schema documentation including:
  - Songs table structure (slug, stem_slug, title, artist, tempo, time_signature, default_key, gracetracks_url, has_stems, is_deleted)
  - Stem file storage location (Cloudflare R2)
  - Architecture overview (Vite, Web Audio API, Supabase, R2)
  - Development setup instructions
  - Environment variable requirements
- Created `AGENT_LOG.md` to track agent activity and decisions

**Reasoning**:
The project was missing documented schema details despite using a structured database. This makes it harder for agents to understand data relationships and constraints. Adding comprehensive documentation helps:
1. Onboard new agents with context about data models
2. Track architectural decisions and their rationale
3. Maintain clarity on what database fields map to UI elements
4. Reference stem file organization for audio loading

---

---

### 2026-04-13 — Stem Upload & Song Creation

**Agent**: Claude (claude-sonnet-4-6)
**Branch**: `claude/stem-upload-song-creation-YYi3i`
**Status**: Completed

**Summary**:
Implemented the full stem upload pipeline: Supabase auth, role-gated upload UI, Cloudflare Pages Function for presigned R2 URLs, and migration SQL for RLS policies.

**Changes**:

- `supabase/migrations/20260413000000_songs_stem_upload.sql` — Idempotent migration: ensures `has_stems`, `stem_slug`, `gracetracks_url` columns exist; enables RLS; creates `songs_read_public` (anon SELECT) and `songs_write_editor` (editor/admin/owner INSERT+UPDATE) policies keyed on `auth.jwt() -> 'app_metadata' ->> 'role'`
- `src/lib/auth.js` — New auth module: `getUser`, `getSession`, `signIn`, `signOut`, `isEditorPlus`, `onAuthStateChange`
- `src/ui/signIn.js` — Modal overlay component for email/password auth; dismisses on ESC or backdrop click
- `src/ui/uploadSong.js` — Upload page: song metadata form, 10 drag-and-drop stem tiles (drums/perc/bass/elec/keys/synth/vox/strings/click/ambient), sequential R2 upload via presigned URLs, Supabase upsert
- `functions/api/presign.js` — Cloudflare Pages Function: verifies Supabase JWT, checks editor+ role, generates presigned R2 PUT URL using `aws4fetch`; handles CORS
- `src/main.js` — Added `/upload` route; auth-reactive navbar with Sign In/Out and Upload buttons; upload page mounted/unmounted on auth changes
- `src/styles/components.css` — New styles for `.gt-signin-overlay`, `.gt-signin`, `.gt-upload`, `.gt-upload__stems` grid, per-tile states (empty/selected/uploading/done/error), indeterminate progress animation
- `wrangler.toml` — Added `[[r2_buckets]]` binding for local dev
- `.env.example` — Documented new Pages Function secrets (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`)
- `README.md` — Updated schema docs; added upload pipeline and Pages Function setup sections
- `package.json` / `package-lock.json` — Added `aws4fetch` dependency

**Key Decisions**:
- Used presigned R2 PUT URLs (client uploads directly to R2) rather than proxying through the Worker to avoid memory limits on large audio files
- Sequential stem uploads (not parallel) to avoid simultaneous large requests on mobile
- Auth state managed in `main.js` with `onAuthStateChange`; upload page re-renders when auth changes
- Slug validated as `[a-z0-9-]+` in both frontend and Pages Function

**Manual Setup Required**:
1. Run migration SQL in Supabase SQL Editor
2. Create R2 API token with Object Read & Write permissions
3. Set Pages Function secrets in Cloudflare Pages dashboard
4. Add R2 bucket binding in Pages → Settings → Functions

---

### 2026-06-07 — Register Existing Stems (metadata-only song registration)

**Agent**: Claude
**Branch**: `claude/pensive-hamilton-3wi8p`
**Status**: Completed

**Summary**:
Closed the gap where stems uploaded to R2 by hand never appeared in GraceTracks because nothing wrote the `songs` row. Added a `/register` page that writes song metadata only (no file upload) after probing R2 to confirm the stem folder exists, plus a one-off SQL script to register three already-uploaded songs.

**Changes**:
- `supabase/seed/register-existing-stems.sql` — Idempotent upsert (on conflict slug) registering Great is the Lord, Let Us Sing to the Lord, In the Name of the Lord. slug = kebab URL key; stem_slug = snake_case R2 folder. Includes pre-flight SELECT to reconcile with any existing GraceChords rows.
- `src/ui/registerSong.js` — New editor+ page: metadata form, slug → snake_case stem_slug auto-derive, "Check R2 folder" that probes `STEMS` via `resolveStemUrl` and requires ≥1 found stem before enabling Register, then upserts the `songs` row with `has_stems = true`.
- `src/main.js` — Added `/register` route, navbar link (editor+), panel mount/hide, and auth-change re-render guard mirroring the upload page.
- `src/styles/components.css` — Added `.gt-register__check-result` styles; otherwise reuses `.gt-upload*` layout.

**Key Decisions**:
- Kept registration separate from `/upload` (which couples file upload + DB write) rather than overloading it.
- Require a successful R2 probe before allowing registration so empty songs can't be registered.
- `stem_slug` is its own field (defaults to slug with hyphens → underscores) because the hand-uploaded folders are snake_case while slugs stay kebab-case.

---

### 2026-06-08 — Stem sync rework: master-clock phase-lock loop

**Agent**: Claude
**Branch**: `claude/nifty-shannon-lWyhl`
**Status**: Completed

**Summary**:
Reworked the audio engine to eliminate inter-stem drift. The previous patches
only ever fixed *start* alignment (seek-before-play, no-op seek gate); they never
addressed the real cause — each `HTMLMediaElement` runs on its own media clock,
independent of the AudioContext and of every other element, so the stems drifted
apart over the length of a song. `AudioBufferSourceNode` (sample-locked for free)
stays off the table because of the iOS-OOM "streaming only" constraint, so instead
the engine now runs a software phase-lock loop.

**Changes**:
- `src/audio/engine.js`:
  - Designates the longest-loaded stem as the **master clock**; transport position
    (`currentTime`) is read from it rather than from a synthetic clock.
  - Added a 200 ms drift-correction loop (`_correctDrift`) that nudges every other
    stem's `playbackRate` toward the master — proportional (gain 0.6, capped ±5%)
    above a 15 ms deadband for pop-free convergence, with a hard re-seek only past a
    400 ms gap (stall/background-throttle recovery).
  - `loadStem` now sets `preservesPitch=false` (+ vendor prefixes) so nudges are a
    clean resample rather than a transient-smearing time-stretch.
  - `pause`/`stop`/`seekTo` reset all `playbackRate`s to 1.0; `dispose`/`stop` stop
    the correction loop. Added `getSyncReport()` for console diagnostics.
- `src/audio/engine.test.js`:
  - Added single-step correction tests (9a–9f: ahead/behind nudge, deadband reset,
    hard-seek recovery, master never adjusted, no-op when paused).
  - Added "no drift over time" convergence simulations (9g–9j): converges a 120 ms
    start skew into the deadband within ~5 s, and holds a continuously ±0.4%-skewing
    clock under ~16 ms for a 4-min (and 10-min) song — proving error stays bounded
    instead of accumulating. Full suite: 21 passing.

**Key Decisions**:
- Kept the streaming `MediaElementAudioSourceNode` architecture (no `decodeAudioData`,
  no framework) per project constraints — the fix is a control loop, not a rewrite.
- Click/ambient stems keep rolling at gain 0 when "off," so toggling them mid-playback
  is an instant in-sync unmute; the corrector keeps them locked like any other stem.
- Soft `playbackRate` correction over hard re-seeks to avoid audible pops during normal
  playback; hard seek reserved for large-gap recovery.

---

### 2026-06-08 — DAW-sync investigation: on-device spike + Option B plan

**Agent**: Claude
**Branch**: `claude/nifty-shannon-lWyhl`
**Status**: In Progress (planning + validation harness)

**Summary**:
Investigated what it takes for playback to behave like a DAW (sample-locked, zero
drift). Built a self-contained on-device spike (`public/stem-spike.html`) to measure
whether full-decode is viable, then wrote a full implementation plan for the streaming
AudioWorklet engine (Option B) and added an on-device streaming test to the spike page.

**Spike findings** (iPhone, iOS 18.7 / Safari 26.5, `great_is_the_lord`: 8 stems, 6.24 min,
48 kHz stereo):
- Decode is fast (1.75 s for all 8). Single-clock sample-locked playback sounds tight on iOS.
- Int16 PCM total: 548 MB (too heavy to keep resident on constrained devices).
- Float32 hold: 1.10 GB → **tab force-refresh (OOM) even on a flagship**.
- Conclusion: `AudioBuffer` is always Float32 and `AudioBufferSourceNode` needs the whole
  buffer resident, so full-decode (Option A) is non-viable for real-length songs. The path
  is Option B — one clock, but stream PCM into it.

**Changes**:
- `docs/STREAMING_ENGINE_PLAN.md` — full Option B plan: architecture (R2 → mp4box demux →
  WebCodecs `AudioDecoder` → per-stem ring buffers → `AudioWorklet` mixer under one clock),
  ~12 MB bounded memory model, seek/loop/transport design, browser-support matrix + fallback
  (WAV-PCM streaming or today's phase-lock engine), API compatibility (keep `engine.js`
  surface so the UI is untouched), milestones M0–M5, risks, and the on-device validation plan.
- `public/stem-spike.html` — added an "Option B — Streaming worklet test": a WebCodecs AAC
  capability probe and an `AudioWorklet` "stem-mixer" that plays the decoded stems fed in
  200 ms chunks at a configurable lookahead, reporting underruns (glitches) and peak ring
  (playback) memory, plus a seek test. Results merge into the existing JSON export.

**Key Decisions**:
- Killed Option A with hard on-device evidence before building it (the spike's purpose).
- v1 streaming feeds the worklet via `postMessage` transfer (no `SharedArrayBuffer`) to avoid
  forcing COOP/COEP + CORP headers on the cross-origin R2.
- Keep the phase-lock `MediaElement` engine as the fallback for browsers without WebCodecs audio.

---

### 2026-06-08 — Streaming engine (Option B) — production build, gated

**Agent**: Claude
**Branch**: `claude/nifty-shannon-lWyhl`
**Status**: In Progress (built + build-verified; awaiting on-device runtime validation)

**Summary**:
After M0 passed on-device (worklet sample-locked, 0 underruns, 12.3 MB ring, WebCodecs
AAC supported), built the production streaming engine. It is gated behind `?engine=stream`
so production behaviour is unchanged (phase-lock stays the default) until validated on a
real device.

**Changes**:
- `src/audio/stream/pcmPlayerProcessor.js` — `pcm-player` AudioWorkletProcessor: one per
  stem, content-locked via absolute sample positions (self-heals on underrun). All players
  share the AudioContext render-quantum clock → sample-locked to each other.
- `src/audio/stream/demux.js` — mp4box (2.3.0) MP4 demux → AAC `EncodedAudioChunk`s + the
  `AudioSpecificConfig` (WebCodecs `description`) + per-chunk absolute sample positions;
  plus a lazy WAV PCM reader fallback.
- `src/audio/stream/streamEngine.js` — orchestrator: per-stem `pcm-player → gain → analyser
  → master` graph (so existing fader/mute/solo/meter code is unchanged); WebCodecs decode-
  ahead scheduler that only decodes ~4 s past the playhead (resident PCM ~tens of MB);
  clock-based transport (play/pause/seek/loop/count-in). Implements the exact public API of
  `engine.js`. Worklet loaded via a Blob URL (`?raw` import) — the iOS-proven path.
- `src/audio/engineFactory.js` — capability detection + `?engine=stream|phase` override;
  dynamic-imports the streaming engine so mp4box (~195 KB) is code-split out of the default path.
- `src/ui/mixer.js` — construct the engine via `createEngine()` instead of `new AudioEngine()`.
- `package.json` — added `mp4box` dependency.

**Build/verify**: `npm run build` clean (streaming engine code-split to its own chunk);
`npm test` 21/21. Runtime path (mp4box demux/ASC extraction, WebCodecs decode, seek) is
NOT yet validated in a browser — to be confirmed on-device via `?engine=stream`.

**Key Decisions**:
- Per-stem player worklets (not one mixer worklet) to preserve the Gain/Analyser graph and
  thus all existing fader/mute/solo/metering code.
- Default stays phase-lock; streaming is opt-in until on-device validation, then flip
  `_defaultToStreaming()` in the factory to capability detection.

---

### 2026-06-08 — Streaming engine validated on-device + made the default

**Agent**: Claude
**Branch**: `claude/nifty-shannon-lWyhl`
**Status**: Completed

**Summary**:
Validated the streaming engine end-to-end on real devices and made it the default.
On iPhone (iOS 18.7 / Safari 26.5) and macOS Safari & Chrome, the full pipeline works:
all 8 stems demux (mp4a.40.2, real 2-byte ASC) → `AudioDecoder` configures → decode-ahead
→ per-stem `pcm-player` worklets play sample-locked. Scrub (while playing and paused),
click/ambient toggles, and pause all stay tight. Resident PCM ~tens of MB.

**Changes**:
- `src/audio/engineFactory.js` — `_defaultToStreaming()` now returns `streamingSupported()`,
  so browsers with AudioWorklet + WebCodecs AAC get the streaming engine automatically;
  others fall back to the phase-lock `MediaElement` engine. `?engine=phase` / `?engine=stream`
  still override.
- `CLAUDE.md` / `CODEX_CONTEXT.md` — rewrote constraint #2 to describe the two-engine setup
  (stream-decode in bounded chunks; never hold a whole song of PCM); added the new modules
  to the codebase map.

**Build/verify**: `npm run build` clean (streaming engine code-split); `npm test` 21/21.

**Remaining (optional)**: broaden device matrix (Android Chrome / Firefox / older iOS — all
covered by capability detection + fallback); decide whether to remove the `stem-spike.html`
diagnostic page; consider SW-precache tuning for the streaming chunk.

---

### 2026-06-12 — Song versions: multiple named stem sets per song

**Agent**: Claude
**Branch**: `claude/song-version-management-wsz89v`
**Status**: Completed

**Summary**: A song can now have multiple named stem versions (e.g. AGMC2026 / HQ / GA2024).
New `song_versions` table (FK → `songs.slug`); a song with no rows keeps a single implicit
"Original" version at the legacy R2 path — zero data/R2 migration, single-version songs are
byte-identical to before. Named versions upload to `tracks/<stem_slug>/versions/<version_slug>/`.
URLs: `/song/<slug>` opens the editor-set default (partial unique index allows ≤1
`is_default` row; none = Original), `?v=<version_slug>` or `?v=original` addresses a version
explicitly. The picker shows a chevron + dropdown on multi-version cards; the mixer header
gets a version chip whose menu switches versions via router navigation (pushState →
dispose/remount, so engine cleanup is the existing proven path). The uploader, when a
selected song already has stems, shows a version block: add a new named version
(free-form label, slugified), replace Original or any existing version, plus a
"Make default" affordance.

**Changes**:
- `supabase/migrations/20260612000000_song_versions.sql` — table, ≤1-default partial unique
  index, reserved-slug CHECK, RLS (public read gated on parent song visibility; editor+ write
  via `public.users.role`).
- `src/lib/versions.js` (+ `versions.test.js`) — `versionFolder`, `buildVersionList`,
  `resolveActiveVersion`, `versionUrl`, fetchers, `setDefaultVersion`.
- `functions/api/presign.js` — optional `version` body param (`[a-z0-9_-]{1,64}`;
  absent/`original` = legacy key).
- `src/main.js` — `?v=` route parsing; mixer cache key is now slug+version.
- `src/ui/mixer.js` — version resolution (unknown `?v=` canonicalized via replaceState),
  stems probed from the version folder (`stems.js` unchanged — it never encoded the folder),
  header switcher, versioned Media Session title.
- `src/ui/songPicker.js` — one grouped `song_versions` query; split card row with version menu
  (single-version cards render exactly as before).
- `src/ui/uploadSong.js` — version block, slug-collision flow now lands in the version chooser
  instead of blind overwrite, `song_versions` upsert after upload. Also fixed a latent bug:
  select-mode uploads now target `selectedSong.stem_slug || slug` (previously always `slug`,
  which would have forked snake_case-folder songs into a second folder and clobbered
  `stem_slug`); `stem_slug` is only written on a song's first stems.
- `src/styles/main.css` / `components.css` — picker + mixer dropdowns (gc-user-dropdown
  recipe), upload version block. `src/ui/icons.js` — chevron-down.
- Docs: `CLAUDE.md` DB rules, `CODEX_CONTEXT.md` schema/R2/routing/presign sections.

**Build/verify**: `npm test` 41/41 (engine + new version helpers); `npm run build` clean.
Migration needs to be applied to Supabase (SQL editor or CLI) before deploying.

---

### 2026-06-12 — Stem maintenance: existing-stem display, per-stem delete, version/song deletion

**Agent**: Claude (claude-fable-5)
**Branch**: `claude/song-version-management-wsz89v`
**Status**: Completed

**Summary**: Maintenance features for the upload page. Targeting "Replace <version>"
now lists what's already in that R2 folder: populated tiles show the server filename
with a trash button (per-stem delete), empty tiles accept retroactive uploads into a
song that already `has_stems`. Named versions get a per-row delete, and a song-level
"Delete all stems" wipes every stem file + `song_versions` row and flips
`has_stems = false` — the GraceChords `songs` row itself is untouched. All R2 key
operations go through a new `/api/stems` Pages Function using the `STEMS_BUCKET`
binding (no binary data proxied; presigned URLs remain upload-only).

**Changes**:
- `functions/api/stems.js` (new) — editor-gated `GET` (list one version folder,
  delimiter keeps `versions/` out of the Original listing) and `DELETE` (explicit
  `files[]`, `scope: 'version'` wipe, `scope: 'song'` recursive wipe with re-list
  batching). Requires the `STEMS_BUCKET` R2 binding in Pages settings (already
  stubbed in `wrangler.toml`).
- `functions/api/_lib.js` (new) — shared CORS + JWT/role gate extracted from
  `presign.js`; `presign.js` refactored to use it (behavior unchanged).
- `src/lib/stemsApi.js` (new) — client wrappers (`listStemFiles`, `deleteStemFiles`,
  `deleteVersionStems`, `deleteSongStems`).
- `src/audio/stems.js` — exported `STEM_IDS`/`STEM_ALIASES`, added `trackIdForFile`
  reverse-alias lookup (maps `drum.m4a`, `2nd keys.wav` → canonical tile).
- `src/ui/uploadSong.js` — existing-file tile state fetched per replace target
  (seq-guarded against stale responses), trash-with-confirm per tile, version-row
  delete + "Delete all stems" danger button. Replacing a stem now also removes stale
  siblings (old extension/alias names) that would shadow the new file in the mixer's
  m4a-first alias probing. Deleting all stems keeps `stem_slug` so re-uploads land in
  the same folder; defaults revert to Original automatically when a flagged version
  row is deleted.
- `src/ui/icons.js` — trash (Lucide Trash2). `src/styles/components.css` — existing/
  deleting tile states, version action cluster, danger row.
- `src/audio/stems.test.js` (new) — `trackIdForFile` cases.

**Build/verify**: `npm test` 45/45; `npm run build` clean. No new migration —
`song_versions` editor policy is `FOR ALL` (delete covered) and `songs` editor
policy already permits the `has_stems`/`gracetracks_url` reset.

---

### 2026-07-20 — Migrate to Signal Blue palette

**Agent**: Claude (claude-opus-4-8)
**Branch**: `claude/gracetracks-signal-blue-myw25x`
**Status**: Completed

**Summary**: Migrated GraceTracks from the warm worship palette to the Signal
Blue palette, matching the GraceChords migration (PR #427). Theming is fully
centralized in `--gc-*` CSS custom properties (verbatim token set shared with
GraceChords), so this was a value-only swap — token names unchanged, so every
reference re-themes globally. Channel-strip colors (`CHANNEL_COLORS` + meter
thresholds in `src/ui/mixer.js`) and functional status colors
(success/warning/danger, plus the industry-convention mute-red / solo-yellow /
done-green in `components.css`) were left untouched.

**Changes**:
- `src/styles/tokens.css` — value-only swap of accent, surfaces, text,
  separator, selection-bg, and shadows in both light and dark. Added
  `--gc-text-accent` (light `#15619A`, dark `#6FB6EA`) for AA-contrast links and
  re-pointed `--gc-link` at it. Re-tinted warm shadows to cool-neutral
  `rgba(20, 28, 38, α)`.
- `index.html` + `public/manifest.webmanifest` — PWA chrome color `#100e0b` →
  new dark bg `#14171A` (default theme stays dark).
- `src/audio/stream/streamEngine.js` — re-themed the hardcoded warm hexes in the
  stream-log debug overlay to Signal Blue dark equivalents.
- `scripts/generate-icons.js` — updated placeholder-icon color constants to
  Signal Blue (PNGs not regenerated here — `canvas` native dep can't build in
  this environment; icons are being replaced separately).

**Verify**: `npm test` 66/66; `npm run build` clean. Grepped the working tree —
no old warm brand/neutral hex remains outside the whitelisted channel-strip
colors.

---

### 2026-07-20 — Adopt Signal Blue "GC" favicon / PWA icons

**Agent**: Claude (claude-opus-4-8)
**Branch**: `claude/gracetracks-signal-blue-myw25x`
**Status**: Completed

**Summary**: Replaced the placeholder "GT" app icons with the shared Signal Blue
"GC" brand mark that was published to the GraceChords repo (`NEW ASSETS/`,
`apps/web/public/icons/v2/`). Per owner confirmation, GraceTracks adopts the same
brand mark rather than a distinct "GT" variant. Sourced from the dark full-bleed
1024px master; the dark `#1E2227` field matches the Signal Blue dark surface, so
it sits naturally in the dark-default app.

**Changes**:
- `public/favicon.svg` — vector master (dark "GC" mark).
- `public/favicon.ico` — 16/32/48 multi-res.
- `public/icons/` — `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` (180),
  `favicon-16x16.png`, `favicon-32x32.png` (all full-bleed "any"); plus
  `icon-maskable-512.png` (logo inset to the ~80% safe zone for Android masking).
- `index.html` — favicon bundle links (svg + png 16/32 + ico + apple-touch).
- `public/manifest.webmanifest` — icons restructured to full-bleed `any` (192/512)
  + dedicated `maskable` (512), replacing the old `any maskable` placeholders.
- `scripts/generate-icons.js` — marked deprecated (placeholder generator that
  would clobber the real brand icons if re-run).

**Verify**: `npm run build` clean (precache 18 → 24 entries, all favicon assets
emitted to `dist/`); `npm test` 66/66.

---

## Future Work Tracking

Use this log to document:
- New schema migrations or table additions
- UI/feature changes that depend on schema changes
- Audio processing improvements and their data implications
- Deployment or infrastructure changes
- Agent-driven refactoring or optimization work

