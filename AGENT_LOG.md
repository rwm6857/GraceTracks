# GraceTracks Agent Activity Log

Log of agent-driven development, decisions, and milestones on the GraceTracks project.

## Format

Each entry includes:
- **Date**: When the work was performed
- **Agent**: Claude or other agent name
- **Branch**: Feature/fix branch name
- **Summary**: Brief description of work
- **Changes**: Files modified and key decisions
- **Status**: Completed, In Progress, or Blocked

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

## Future Work Tracking

Use this log to document:
- New schema migrations or table additions
- UI/feature changes that depend on schema changes
- Audio processing improvements and their data implications
- Deployment or infrastructure changes
- Agent-driven refactoring or optimization work

