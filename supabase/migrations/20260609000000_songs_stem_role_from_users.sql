-- =============================================================================
-- Migration: fix songs editor-write RLS to read the role from public.users
--
-- The previous policy (20260413000000) gated writes on the JWT's
-- app_metadata.role. But GraceChords never writes app_metadata — the role lives
-- in public.users.role (its useAuth reads `users.role`, and the DB ships
-- get_user_role()/has_min_role() helpers). So editors/admins/owners were being
-- denied because app_metadata.role was empty. This recreates the policy to
-- check public.users instead, matching GraceChords' source of truth.
--
-- Safe to run multiple times (idempotent).
-- =============================================================================

DROP POLICY IF EXISTS "songs_write_editor" ON songs;
CREATE POLICY "songs_write_editor"
  ON songs FOR ALL
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
