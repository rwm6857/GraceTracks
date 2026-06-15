-- =============================================================================
-- Migration: songs.stems_updated_at (stem cache-bust token)
-- Adds a GraceTracks-owned timestamp, bumped whenever stems are uploaded,
-- replaced, or deleted. The mixer appends it to stem URLs (?t=<token>) so a
-- replaced stem — which reuses its R2 key, and so its URL — gets a fresh URL.
-- Without it the service worker's CacheFirst rule on .m4a/.wav would keep
-- serving the old audio for up to 90 days even after a hard reload.
-- Safe to run multiple times (idempotent).
-- =============================================================================

ALTER TABLE songs
  ADD COLUMN IF NOT EXISTS stems_updated_at timestamptz;
