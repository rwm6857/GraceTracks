# GraceTracks

Companion web app to GraceChords, GraceTracks is a personal practice mixer using audio stems.

## Features

- **Song Browser**: Search and filter songs that have available audio stems
- **Multi-stem Mixer**: Adjust volume, mute, and solo individual instrument stems
- **Metronome**: Configurable count-in and playback click
- **Metering**: Visual level meters for each stem with peak detection
- **Audio Export**: Record practice sessions (prepared infrastructure)

## Schema

GraceTracks uses Supabase PostgreSQL with a `songs` table structured as follows:

### Songs Table

| Column | Type | Description |
|--------|------|-------------|
| `slug` | `text` | Unique identifier for the song (URL-friendly) |
| `stem_slug` | `text` | Subdirectory name for stem files (defaults to `slug` if null) |
| `title` | `text` | Song title displayed in UI |
| `artist` | `text` | Artist/composer name |
| `tempo` | `integer` | Beats per minute (BPM) |
| `time_signature` | `text` | Time signature (e.g., "4/4", "3/4") |
| `default_key` | `text` | Musical key (e.g., "C", "G Major") |
| `gracetracks_url` | `text` | Full URL to the GraceTracks mixer page |
| `has_stems` | `boolean` | Filter flag—only songs with `true` appear in the app |
| `is_deleted` | `boolean` | Soft-delete flag—`false` = active |

Apply the migration to ensure columns exist and configure RLS:

```sql
-- supabase/migrations/20260413000000_songs_stem_upload.sql
```

Run via Supabase CLI (`supabase db push`) or paste into the SQL Editor.

### Stem Files

Audio stems are stored in Cloudflare R2 at:
```
{R2_PUBLIC_URL}/tracks/{stem_slug}/{stem_name}.{ext}
```

Where `stem_name` is one of: `drums`, `perc`, `bass`, `elec`, `keys`, `synth`, `vox`, `strings`, `click`, `ambient`  
And `ext` is `m4a` or `wav` (m4a tried first).

## Architecture

- **Frontend**: Vanilla JS with Vite bundler, PWA support via service worker
- **Audio**: Web Audio API for real-time mixing, gain control, metering
- **Database**: Supabase (PostgreSQL) for song metadata; auth roles via GraceChords webhook
- **Storage**: Cloudflare R2 for audio stem files
- **Hosting**: Cloudflare Pages with Pages Functions for server-side upload auth

## Upload Pipeline

Users with **editor, admin, or owner** roles (set in Supabase `app_metadata.role` by the GraceChords auth webhook) can upload stems at `/upload`:

1. Sign in via the navbar → Supabase Auth session stored in localStorage
2. Fill song metadata (title, artist, slug, tempo, key, time signature)
3. Drop `.m4a` or `.wav` files onto each stem tile
4. Click **Upload Song**:
   - For each stem: fetches a presigned R2 PUT URL from `POST /api/presign` (Pages Function verifies JWT + role)
   - Uploads file directly to R2 at `tracks/{slug}/{track}.{ext}`
   - Upserts the songs record in Supabase with `has_stems = true`

### Cloudflare Pages Function Setup

After deploying, configure in Cloudflare Pages → Settings:

**Environment Variables** (Production + Preview):
| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anon key |
| `R2_ACCOUNT_ID` | Cloudflare account ID |
| `R2_BUCKET_NAME` | R2 bucket name (e.g. `gracetracks-stems`) |
| `R2_ACCESS_KEY_ID` | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret |

**R2 Bucket Binding** (Functions → R2 bucket bindings):
- Variable name: `STEMS_BUCKET`
- Bucket: your stems bucket

Create the R2 API token at Cloudflare dashboard → R2 → Manage R2 API tokens with **Object Read & Write** on the bucket.

## Development

```bash
npm install
npm run dev      # Start Vite dev server
npm run build    # Build for production
npm run preview  # Preview production build
```

### Environment Variables

Copy `.env.example` to `.env` and fill in values. See the file for full documentation.

Frontend (Vite build-time, `VITE_` prefix):
- `VITE_SUPABASE_URL` - Supabase project URL
- `VITE_SUPABASE_ANON_KEY` - Supabase anonymous key
- `VITE_R2_PUBLIC_URL` - Cloudflare R2 public URL

Pages Function secrets (set in Cloudflare dashboard, no `VITE_` prefix):
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
