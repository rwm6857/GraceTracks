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

### Stem Files

Audio stems are stored in Cloudflare R2 at:
```
{R2_PUBLIC_URL}/tracks/{stem_slug}/{stem_name}.wav
```

Where `stem_name` is one of: `drums`, `perc`, `bass`, `elec`, `keys`, `synth`, `vocals`, `strings`

## Architecture

- **Frontend**: Vanilla JS with Vite bundler, PWA support via service worker
- **Audio**: Web Audio API for real-time mixing, gain control, metering
- **Database**: Supabase (PostgreSQL) for song metadata
- **Storage**: Cloudflare R2 for audio stem files
- **Hosting**: Cloudflare Pages with Workers integration

## Development

```bash
npm install
npm run dev      # Start Vite dev server
npm run build    # Build for production
npm run preview  # Preview production build
```

### Environment Variables

Required for Cloudflare Pages deployment:
- `VITE_SUPABASE_URL` - Supabase project URL
- `VITE_SUPABASE_ANON_KEY` - Supabase anonymous key
- `VITE_R2_PUBLIC_URL` - Cloudflare R2 public URL
