-- =============================================================================
-- Migration: songs stem upload support
-- Ensures stem-related columns exist and configures RLS for editor+ writes.
-- Safe to run multiple times (idempotent).
-- =============================================================================

-- Ensure all stem-related columns exist
ALTER TABLE songs
  ADD COLUMN IF NOT EXISTS has_stems       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stem_slug       text,
  ADD COLUMN IF NOT EXISTS gracetracks_url text;

-- Enable Row Level Security (safe to run if already enabled)
ALTER TABLE songs ENABLE ROW LEVEL SECURITY;

-- Public read: only songs marked ready (preserves existing app behavior)
-- DROP + CREATE so the policy body is always up to date on re-run
DROP POLICY IF EXISTS "songs_read_public" ON songs;
CREATE POLICY "songs_read_public"
  ON songs FOR SELECT
  USING (is_deleted = false AND has_stems = true);

-- Editor+ write: insert + update if JWT app_metadata.role matches
DROP POLICY IF EXISTS "songs_write_editor" ON songs;
CREATE POLICY "songs_write_editor"
  ON songs FOR ALL
  USING (
    (auth.jwt() -> 'app_metadata' ->> 'role') IN ('editor', 'admin', 'owner')
  )
  WITH CHECK (
    (auth.jwt() -> 'app_metadata' ->> 'role') IN ('editor', 'admin', 'owner')
  );
