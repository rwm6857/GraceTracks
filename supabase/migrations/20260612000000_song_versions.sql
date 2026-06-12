-- =============================================================================
-- Migration: song versions
--
-- A song (songs.slug) can have multiple named stem sets ("versions"), e.g.
-- AGMC2026 / HQ / GA2024 from different conferences. Legacy stems at
-- tracks/<stem_slug>/<stem>.<ext> are the implicit "Original" version — songs
-- with no rows here behave exactly as before (no backfill needed). Versioned
-- stems live at tracks/<stem_slug>/versions/<version_slug>/<stem>.<ext>.
--
-- Default resolution: at most one row per song may have is_default = true
-- (partial unique index below); when no row is flagged, Original is the
-- default. The slug 'original' is reserved for the legacy path and may not be
-- used as a version_slug.
--
-- Safe to run multiple times (idempotent).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.song_versions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  song_slug    text        NOT NULL REFERENCES public.songs(slug)
                             ON UPDATE CASCADE ON DELETE CASCADE,
  version_slug text        NOT NULL,
  label        text        NOT NULL,
  is_default   boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT song_versions_slug_format   CHECK (version_slug ~ '^[a-z0-9_-]{1,64}$'),
  CONSTRAINT song_versions_slug_reserved CHECK (version_slug <> 'original'),
  CONSTRAINT song_versions_unique        UNIQUE (song_slug, version_slug)
);

-- At most one explicit default per song; no flagged row = Original is default.
CREATE UNIQUE INDEX IF NOT EXISTS song_versions_one_default
  ON public.song_versions (song_slug) WHERE is_default;

CREATE INDEX IF NOT EXISTS song_versions_song_idx
  ON public.song_versions (song_slug);

ALTER TABLE public.song_versions ENABLE ROW LEVEL SECURITY;

-- Public read: only versions of publicly visible songs (mirrors songs_read_public).
DROP POLICY IF EXISTS "song_versions_read_public" ON public.song_versions;
CREATE POLICY "song_versions_read_public"
  ON public.song_versions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.songs s
      WHERE s.slug = song_versions.song_slug
        AND s.has_stems = true
        AND s.is_deleted = false
    )
  );

-- Editor+ full access. The role lives in public.users.role (GraceChords'
-- source of truth — see 20260609000000); FOR ALL's USING also grants editors
-- SELECT on versions of songs that aren't publicly visible yet.
DROP POLICY IF EXISTS "song_versions_write_editor" ON public.song_versions;
CREATE POLICY "song_versions_write_editor"
  ON public.song_versions FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid()
        AND u.role IN ('editor', 'admin', 'owner')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid()
        AND u.role IN ('editor', 'admin', 'owner')
    )
  );
