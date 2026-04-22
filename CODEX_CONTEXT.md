# GraceTracks — Codex Project Context

> Feed this file to ChatGPT Codex (or any AI coding agent) as project context before asking it to work on this codebase.

---

## What GraceTracks Is

GraceTracks is a **web-based stem-mixing practice tool** for worship musicians. It lets users play back isolated audio stems (drums, bass, keys, vocals, etc.) for a song, with per-stem volume faders, mute/solo, a configurable metronome with count-in, and real-time VU metering.

It is a **companion app to GraceChords** (a separate Cloudflare Pages project with its own Worker). GraceTracks and GraceChords share the **same Supabase project** (same database, same auth system), but each has its own:

- Cloudflare Pages project and deployment
- Cloudflare Pages Function (server-side worker code in `functions/`)
- Cloudflare R2 bucket (GraceTracks uses a dedicated stems bucket)
- Domain / CNAME

**Important:** Do not conflate GraceTracks with GraceChords. They are separate apps sharing one Supabase backend.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla JavaScript (no framework), Vite 5.4 bundler |
| Audio | Web Audio API (`MediaElementAudioSourceNode` streaming) |
| Auth & DB | Supabase (PostgreSQL + Supabase Auth) |
| Storage | Cloudflare R2 (audio stem files) |
| Hosting | Cloudflare Pages (static site + Pages Functions) |
| PWA | `vite-plugin-pwa` with service worker caching |
| Tests | Vitest 4.1 |
| R2 signing | `aws4fetch` library (S3-compatible presigned URLs) |

---

## Repository File Structure

```
GraceTracks/
├── index.html                      # HTML shell, mounts #app
├── package.json                    # v0.1.0, scripts: dev/build/preview/test
├── vite.config.js                  # Vite + VitePWA config
├── wrangler.toml                   # Cloudflare Pages / R2 binding for local dev
├── .env.example                    # All required env vars documented
├── README.md                       # Schema, architecture, setup instructions
├── AGENT_LOG.md                    # History of agent-driven development work
│
├── functions/
│   └── api/
│       └── presign.js              # Cloudflare Pages Function — presigned R2 PUT URLs
│
├── src/
│   ├── main.js                     # App entry: routing, navbar, auth state
│   │
│   ├── audio/
│   │   ├── engine.js               # AudioContext mixer (load/play/pause/seek/fader/mute/solo)
│   │   ├── engine.test.js          # Vitest unit tests for engine.js
│   │   ├── metronome.js            # Lookahead click track scheduler with count-in
│   │   ├── meters.js               # RAF-based VU meter using AnalyserNode
│   │   └── stems.js                # Stem URL resolution + format probing (m4a → wav fallback)
│   │
│   ├── lib/
│   │   ├── supabase.js             # Lazy Supabase client (Proxy pattern)
│   │   └── auth.js                 # Auth wrappers + role check (isEditorPlus)
│   │
│   ├── ui/
│   │   ├── mixer.js                # Main mixer page: channel strips, master, transport
│   │   ├── transport.js            # Play/pause/seek bar + toggle buttons
│   │   ├── songPicker.js           # Song browser with live search
│   │   ├── uploadSong.js           # Stem upload form (editor+ only)
│   │   └── signIn.js               # Auth modal
│   │
│   └── styles/
│       ├── tokens.css              # Design tokens (colors, spacing, type)
│       ├── main.css                # App-level layout
│       └── components.css          # Per-component styles
│
├── supabase/
│   └── migrations/
│       └── 20260413000000_songs_stem_upload.sql   # Migration: has_stems, stem_slug, RLS policies
│
└── public/
    ├── manifest.webmanifest        # PWA manifest (name: GraceTracks)
    ├── _redirects                  # SPA fallback: /* → /index.html 200
    ├── _headers                    # HTTP security/cache headers
    └── icons/                      # App icons + per-stem SVGs
```

---

## Database Schema (Supabase — shared with GraceChords)

The `songs` table lives in the shared Supabase project. GraceTracks reads and writes only the columns it owns.

### `songs` table

| Column | Type | Description |
|---|---|---|
| `slug` | `text` | Primary URL key (e.g. `amazing-grace`) |
| `stem_slug` | `text` | R2 subdirectory name; falls back to `slug` if null |
| `title` | `text` | Display title |
| `artist` | `text` | Artist / composer |
| `tempo` | `integer` | BPM |
| `time_signature` | `text` | e.g. `"4/4"`, `"3/4"` |
| `default_key` | `text` | e.g. `"G"`, `"C Major"` |
| `gracetracks_url` | `text` | Full URL to the GraceTracks mixer page |
| `has_stems` | `boolean` | `true` = song appears in GraceTracks song list |
| `is_deleted` | `boolean` | Soft-delete; `false` = active |

### RLS Policies (applied by migration)

- **`songs_read_public`**: Any user (including anon) can SELECT where `has_stems = true AND is_deleted = false`
- **`songs_write_editor`**: Authenticated users with `app_metadata.role` in `('editor','admin','owner')` can INSERT and UPDATE

### Auth & Roles

Auth is Supabase Auth (email + password). Roles are stored in `user.app_metadata.role` — set by the GraceChords auth webhook, **not** by GraceTracks directly.

Role values that grant upload access: `editor`, `admin`, `owner`.

---

## Audio Stem Files (Cloudflare R2)

**Separate R2 bucket from GraceChords.** Path pattern:

```
{VITE_R2_PUBLIC_URL}/tracks/{stem_slug}/{stem_name}.{ext}
```

- `stem_slug` — from DB (or falls back to `slug`)
- `stem_name` — one of: `drums`, `perc`, `bass`, `elec`, `keys`, `synth`, `vox`, `strings`, `click`, `ambient`
- `ext` — `.m4a` tried first, falls back to `.wav`

**Aliases handled in `stems.js`** (so old files with variant names still work):
- `drums` ← `drum`
- `perc` ← `percussion`
- `vox` ← `vocal`, `vocals`
- `synth` ← `2nd`, `2nd keys`

---

## How the App Works

### Routing (`src/main.js`)

Client-side SPA routing using `history.pushState` / `popstate`:

| Path | View |
|---|---|
| `/` | Song picker (`songPicker.js`) |
| `/song/:slug` | Mixer (`mixer.js`) |
| `/upload` | Upload form (`uploadSong.js`, editor+ only) |

Navbar shows **Sign In** button when logged out, **Sign Out + Upload** when logged in as editor+.

### Mixer Flow (`src/ui/mixer.js`)

1. Fetch song metadata from Supabase by slug
2. Probe R2 for available stems (`stems.js` — checks HEAD, builds URL list)
3. Load each available stem into `AudioEngine` (`engine.js`)
4. Render per-channel strips (fader, mute, solo, meter, label)
5. Render transport bar (`transport.js`) with play/pause, seek slider, timecode
6. Start meter RAF loop (`meters.js`)
7. Return cleanup function (disposes engine, metronome, meters, event listeners)

### AudioEngine (`src/audio/engine.js`)

Signal flow per stem:
```
HTMLAudioElement → MediaElementAudioSourceNode → GainNode → AnalyserNode → masterGain → AudioContext.destination
```

**Key design choices:**
- `MediaElementAudioSourceNode` (streaming) instead of `decodeAudioData` (decoded buffer) — prevents 300+ MB memory use on iOS with many stems
- Fader curve: `0–0.75` maps to `0–1.0` linear gain; `0.75–1.0` adds up to +6 dB boost
- Seek-before-play: all stems fire `seekTo()` and wait for `seeked` events before `play()` is called, preventing desync
- Safety timeout on `seeked` wait (500 ms) to avoid stall on fast/no-op seeks

### Metronome (`src/audio/metronome.js`)

- Lookahead scheduler (50 ms intervals) using `AudioContext.currentTime`
- Accent on beat 1; visual beat callbacks
- Count-in mode: fires `onCountInBeat` N times, then calls `onReady` at the exact scheduled AudioContext time

### Upload Pipeline

1. User signs in (Supabase Auth)
2. `/upload` page shows song metadata form + 10 stem drop tiles
3. On submit, for each stem with a file selected:
   - `POST /api/presign` (Pages Function) — verifies JWT, checks role, returns presigned R2 PUT URL (5-min TTL)
   - Browser uploads file directly to R2 (bypasses Worker, avoids memory limits)
4. Supabase upsert: `songs` row with `has_stems = true`

### Pages Function (`functions/api/presign.js`)

- Validates `Authorization: Bearer <jwt>` via Supabase `/auth/v1/user`
- Rejects if role not in `['editor','admin','owner']`
- Validates: slug format `[a-z0-9-]+`, track name in allowed set, extension `.m4a` or `.wav`
- Generates AWS4-signed presigned URL for R2 using `aws4fetch`
- Handles CORS preflight (`OPTIONS`)

---

## Environment Variables

### Frontend (Vite build-time, `VITE_` prefix)

Set in `.env` locally; set in Cloudflare Pages dashboard for production:

| Variable | Description |
|---|---|
| `VITE_SUPABASE_URL` | Supabase project URL (same project as GraceChords) |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon key |
| `VITE_R2_PUBLIC_URL` | GraceTracks R2 bucket public URL (different from GraceChords) |

### Pages Function secrets (Cloudflare Pages dashboard only, no `VITE_` prefix)

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Same Supabase project URL |
| `SUPABASE_ANON_KEY` | Same Supabase anon key |
| `R2_ACCOUNT_ID` | Cloudflare account ID |
| `R2_BUCKET_NAME` | GraceTracks stems bucket name |
| `R2_ACCESS_KEY_ID` | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret |

Also required in Cloudflare Pages → Functions → R2 bucket bindings:
- Variable name: `STEMS_BUCKET` → GraceTracks stems bucket

---

## Development

```bash
npm install
npm run dev        # Vite dev server (localhost:5173)
npm run build      # Production build → dist/
npm run preview    # Serve dist/ locally
npm test           # Vitest unit tests
```

For Pages Function local dev, `wrangler.toml` defines the R2 binding.

---

## PWA Notes

- `vite-plugin-pwa` generates the service worker
- `registerType: 'prompt'` — **not** autoUpdate, to prevent forced reloads on iOS Safari
- `clientsClaim: false`, `navigateFallback: null` — avoids iOS bfcache / redirect loops
- Stem files cached `CacheFirst`, 90-day max-age, max 200 entries
- App icons at `public/icons/` (192px and 512px PNG); per-stem SVG icons in `public/icons/channels/`

---

## Recent Development History

| Date | Work |
|---|---|
| 2026-04-22 | Codex context file created |
| 2026-04-13 | Full stem upload pipeline: auth module, sign-in modal, upload UI, Pages Function, RLS migration, `aws4fetch` dependency |
| ~2026-04-15 | Mobile UI polish + scrub bar seek reliability fixes |
| ~2026-04-17 | Metronome button toggle; click/ambient controls moved to transport bar |
| ~2026-04-18 | Fix stem desync: seek all stems before play, skip seeked-wait on no-op seeks |
| 2026-03-30 | Schema documentation + AGENT_LOG.md created |

Full git log: `git log --oneline`

---

## Key Architectural Constraints

1. **No framework** — the codebase is intentional vanilla JS. Do not introduce React, Vue, Svelte, etc.
2. **Streaming audio only** — never use `decodeAudioData` for stems. iOS Safari will OOM with multiple large files decoded into buffers. Always use `MediaElementAudioSourceNode`.
3. **Sequential uploads** — stem uploads are done one at a time (not `Promise.all`) to avoid exhausting mobile memory with simultaneous large file reads.
4. **Presigned URLs, not proxy** — the Pages Function only issues a signed URL; the browser uploads directly to R2. Never proxy binary upload through a Worker.
5. **Shared Supabase, separate Cloudflare** — GraceTracks and GraceChords share one Supabase project but are entirely separate Cloudflare Pages deployments with separate R2 buckets and separate Pages Functions.
6. **Roles from GraceChords** — `app_metadata.role` is written by the GraceChords auth webhook. GraceTracks only reads it; never write to `app_metadata` from GraceTracks.
7. **PWA prompt mode** — keep `registerType: 'prompt'`. Changing to `autoUpdate` breaks iOS Safari installs.
