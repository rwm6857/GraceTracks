# GraceTracks — Claude Code Agent Instructions

## What This Project Is

GraceTracks is a **vanilla JS PWA stem-mixer** for worship musicians. It is a companion to GraceChords, sharing the same Supabase project but deployed as a **separate Cloudflare Pages site** with its own Pages Function worker and its own R2 bucket.

See `CODEX_CONTEXT.md` for full project context (architecture, schema, file tree, how the audio engine works).

---

## Critical Constraints (Read Before Making Any Change)

1. **No JS framework.** The codebase is intentional vanilla JS. Do not introduce React, Vue, Svelte, or any component framework.
2. **Streaming audio only.** Never use `decodeAudioData` for stems — use `MediaElementAudioSourceNode`. iOS Safari OOMs with decoded buffers across many large files.
3. **Sequential stem uploads.** Stem uploads run one-at-a-time (not `Promise.all`) to avoid simultaneous large reads on mobile.
4. **Presigned URLs only.** The Pages Function (`functions/api/presign.js`) issues a signed R2 URL; the browser uploads directly. Never proxy binary data through a Worker.
5. **Separate from GraceChords.** They share one Supabase project but are entirely separate Cloudflare deployments. Never modify GraceChords code from this repo.
6. **Roles are read-only here.** `app_metadata.role` is written by GraceChords. GraceTracks only reads it; never write to `app_metadata`.
7. **PWA must stay in prompt mode.** `registerType: 'prompt'` in `vite.config.js`. Do not change to `autoUpdate` — it breaks iOS Safari installs.

---

## Development Commands

```bash
npm install
npm run dev        # Vite dev server — localhost:5173
npm run build      # Production build → dist/
npm run preview    # Serve dist/ locally
npm test           # Vitest unit tests (src/audio/engine.test.js)
```

---

## Git Workflow

- Work on feature branches; name them descriptively
- Commit messages: imperative, lowercase, concise (`fix: ...`, `feat: ...`, `test: ...`)
- Push to `origin` with `-u` flag: `git push -u origin <branch>`
- Log agent work in `AGENT_LOG.md` (append a new entry per session)

---

## Codebase Map (Quick Reference)

| Path | Purpose |
|---|---|
| `src/main.js` | App entry, SPA router, navbar, auth state |
| `src/audio/engine.js` | AudioContext mixer — load/play/pause/seek/fader/mute/solo |
| `src/audio/metronome.js` | Lookahead click scheduler with count-in |
| `src/audio/meters.js` | RAF-based VU metering via AnalyserNode |
| `src/audio/stems.js` | Stem URL probing + format fallback (m4a → wav) |
| `src/lib/supabase.js` | Lazy Supabase client (Proxy pattern) |
| `src/lib/auth.js` | Auth wrappers + `isEditorPlus()` role check |
| `src/ui/mixer.js` | Mixer page: channel strips, master, transport |
| `src/ui/transport.js` | Play/pause/seek bar + toggle buttons |
| `src/ui/songPicker.js` | Song browser with live search |
| `src/ui/uploadSong.js` | Drag-and-drop stem upload form (editor+ only) |
| `src/ui/signIn.js` | Email/password auth modal |
| `functions/api/presign.js` | Cloudflare Pages Function — presigned R2 PUT URLs |
| `supabase/migrations/` | SQL migrations — run via Supabase CLI or SQL Editor |
| `src/styles/tokens.css` | Shared design tokens (verbatim copy from GraceChords) |
| `src/styles/main.css` | App shell layout |
| `src/styles/components.css` | Component styles |

---

## Design System

### Tokens (`src/styles/tokens.css`)

Tokens are a **verbatim copy from GraceChords** — do not edit directly. Copy changes from the GraceChords repo.

#### Color Palette

| Token | Light | Dark | Use |
|---|---|---|---|
| `--gc-primary` | `#b8610a` | `#d4843a` | Buttons, accents, active states |
| `--gc-primary-hover` | `#9e5209` | `#e0923f` | Hover on primary |
| `--gc-bg` | `#faf7f2` | `#100e0b` | Page background |
| `--gc-surface-1` | `#ffffff` | `#1a1612` | Cards, strips |
| `--gc-surface-2` | `#f5f1ea` | `#231e18` | Transport bar, inputs |
| `--gc-surface-3` | `#ede8de` | `#2e271f` | Active toggle bg, track |
| `--gc-text` | `#1c1410` | `#f0ebe3` | Body text |
| `--gc-text-secondary` | `#6b5c4e` | `#a89484` | Labels, meta |
| `--gc-text-tertiary` | `#9c8878` | `#6e5e52` | Hints, dB readout |
| `--gc-separator` | `#ddd5c8` | `#2e261e` | Borders |
| `--gc-danger` | `#FF3B30` | `#FF453A` | Mute active, errors |
| `--gc-success` | `#34C759` | `#30D158` | Done state |
| `--gc-yellow` | `#FFCC00` | `#FFD60A` | Solo active |

Theme is set via `[data-theme="dark"]` attribute on the root element. The app defaults to dark (PWA manifest theme is `#100e0b`).

#### Typography

| Token | Value | Use |
|---|---|---|
| `--gc-font-family` | system-ui stack | Body, UI |
| `--gc-font-mono` | ui-monospace stack | dB readout, timecode, code |
| `--gc-font-brand` | Oswald, sans-serif | Navbar brand, count-in overlay |
| `--gc-font-title` | `clamp(32px, 4vw, 36px)` | Page titles |
| `--gc-font-h2` | `20px` | Section headings |
| `--gc-font-body` | `16px` | Body text |
| `--gc-font-sub` | `14px` | Labels, metadata |
| `--gc-font-cap` | `12px` | Caps, strip labels, dB |

#### Spacing Scale

`--space-1` (4px) → `--space-2` (8px) → `--space-3` (12px) → `--space-4` (16px) → `--space-5` (24px) → `--space-6` (32px)

#### Radii

| Token | Value |
|---|---|
| `--radius-sm` | 10px |
| `--radius-md` | 12px |
| `--radius-lg` | 16px |
| `--radius-pill` | 999px |

#### Controls

- Standard height: `--gc-control-h` (36px); mobile: `--gc-control-h-mobile` (44px)
- Button class: `.gc-btn` — variants: `--primary`, `--ghost`, `--danger`, `--sm`, `--lg`
- Active/toggle state: `.is-active` or `aria-pressed="true"` → `background: var(--gc-surface-3); color: var(--gc-primary); border-color: var(--gc-primary)`
- Transport toggles override: when `aria-pressed="true"` → `background: var(--gc-primary); color: #fff`

#### Motion

- `--gc-dur-quick`: 180ms — hover/focus transitions
- `--gc-dur`: 220ms — layout transitions
- `--gc-ease`: `cubic-bezier(0.2, 0.8, 0.2, 1)`
- `prefers-reduced-motion` sets both to 0ms

### CSS Class Naming

- App prefix: `gt-` (GraceTracks-specific)
- Shared component prefix: `gc-` (shared with GraceChords — buttons, cards)
- BEM-style: `.gt-strip__fader`, `.gt-transport__play-icon`
- State modifiers: `.is-muted`, `.is-soloed`, `.is-active`, `.gt-upload__stem--done`

### Responsive Breakpoints

| Breakpoint | What changes |
|---|---|
| `max-width: 700px` | Upload stems grid: 5-col → 2-col; metadata fields: 2-col → 1-col |
| `max-width: 640px` | Buttons grow to 44px height; mixer header cleans up; back link becomes icon-only |
| `max-width: 480px` | Navbar/transport/header tighten padding; channel strips narrow to 64px |

---

## Database Rules

- Query only the `songs` table
- Always filter: `has_stems = true` and `is_deleted = false` for public reads
- `stem_slug` can be null — fall back to `slug` when resolving R2 paths
- Never write to `app_metadata` — that belongs to GraceChords
- RLS is enforced by Supabase — trust it; don't re-implement in the client

---

## Audio Engine Rules

- Always load stems via `engine.loadStem(name, url)` — the engine manages `HTMLAudioElement` lifecycle
- Never call `play()` on a stem directly — always go through `engine.play()`
- Fader range is 0–1 (UI slider value) — the engine applies the gain curve internally
- Meter updates arrive via `meters.onUpdate` callback — do not read `AnalyserNode` directly from UI code
- `engine.cleanup()` must be called when leaving the mixer view — it disposes all audio nodes and elements

---

## Cloudflare Pages Function Rules

- The function lives at `functions/api/presign.js` — this maps to `POST /api/presign`
- It validates JWT via Supabase, checks role, validates inputs, then signs the R2 URL
- Environment variables are set in the Cloudflare Pages dashboard (not in code or `.env`)
- The `STEMS_BUCKET` R2 binding is set in Pages → Settings → Functions → R2 bindings
- For local dev with `wrangler dev`, the `wrangler.toml` provides the R2 binding stub

---

## Environment Variables

Frontend (set in `.env` locally, Cloudflare Pages dashboard for production):

| Variable | Description |
|---|---|
| `VITE_SUPABASE_URL` | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon key |
| `VITE_R2_PUBLIC_URL` | R2 bucket public URL (GraceTracks bucket, not GraceChords) |

Pages Function secrets (Cloudflare dashboard only):

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anon key |
| `R2_ACCOUNT_ID` | Cloudflare account ID |
| `R2_BUCKET_NAME` | Stems bucket name |
| `R2_ACCESS_KEY_ID` | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret |

---

## Agent Log

Append an entry to `AGENT_LOG.md` after each significant agent-driven session. Format:

```markdown
### YYYY-MM-DD — Short Title

**Agent**: Claude (model-id)
**Branch**: `branch-name`
**Status**: Completed | In Progress | Blocked

**Summary**: One paragraph.

**Changes**: Bullet list of files + key decisions.
```
