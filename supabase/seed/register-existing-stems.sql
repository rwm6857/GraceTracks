-- =============================================================================
-- One-off: register songs whose stems were uploaded to R2 by hand
-- =============================================================================
-- Run this in the Supabase SQL Editor (it runs as a superuser, so it bypasses
-- the songs_write_editor RLS policy — no editor JWT needed).
--
-- Why this is needed: GraceTracks shows a song only when a `songs` row has
-- has_stems = true AND is_deleted = false. The mixer then probes R2 at
-- /tracks/<stem_slug>/<stem>.<m4a|wav> at runtime. Uploading stems straight to
-- R2 never writes that row, so the song stays invisible until this runs.
--
-- IMPORTANT — slug vs. stem_slug:
--   * slug      = the URL key (/song/<slug>) and the upsert conflict key.
--   * stem_slug = the R2 folder under /tracks/. These three were uploaded with
--                 snake_case folder names, so stem_slug is snake_case while the
--                 slug stays kebab-case.
--
-- BEFORE RUNNING: GraceChords shares this table. If a song already has a row,
-- confirm its existing slug matches the kebab slug below — the ON CONFLICT
-- target is `slug`, so a mismatch would insert a duplicate instead of updating.
-- Check first:
--   select slug, title, has_stems, stem_slug from songs
--   where title ilike any (array['Great is the Lord','Let Us Sing to the Lord','In the Name of the Lord']);
-- Adjust the `slug` values below to match whatever is already there.
-- =============================================================================

insert into songs (slug, stem_slug, title, has_stems, is_deleted)
values
  ('great-is-the-lord',       'great_is_the_lord',       'Great is the Lord',       true, false),
  ('let-us-sing-to-the-lord', 'let_us_sing_to_the_lord', 'Let Us Sing to the Lord', true, false),
  ('in-the-name-of-the-lord', 'in_the_name_of_the_lord', 'In the Name of the Lord', true, false)
on conflict (slug) do update
  set stem_slug = excluded.stem_slug,
      has_stems = true,
      is_deleted = false;

-- Optional: fill in metadata you know (these are nullable; the mixer/picker
-- just shows whatever is present). Example:
--   update songs set artist = '...', tempo = 72, default_key = 'G', time_signature = '4/4'
--   where slug = 'great-is-the-lord';

-- Verify:
--   select slug, stem_slug, title, has_stems, is_deleted from songs
--   where slug in ('great-is-the-lord','let-us-sing-to-the-lord','in-the-name-of-the-lord');
