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

## Future Work Tracking

Use this log to document:
- New schema migrations or table additions
- UI/feature changes that depend on schema changes
- Audio processing improvements and their data implications
- Deployment or infrastructure changes
- Agent-driven refactoring or optimization work

