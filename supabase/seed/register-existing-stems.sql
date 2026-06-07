-- =============================================================================
-- One-off: make three EXISTING songs visible to GraceTracks
-- =============================================================================
-- These rows already exist (GraceChords created them). We are ONLY updating the
-- GraceTracks-owned columns so the songs show up in the picker — no new rows.
--
-- GraceTracks shows a song when has_stems = true AND is_deleted = false, then
-- probes R2 at /tracks/<stem_slug>/<stem>.<m4a|wav>. The stems were uploaded to
-- snake_case folders, so stem_slug MUST be set to the snake_case folder name
-- (otherwise the probe falls back to the kebab `slug` and finds nothing).
--
-- Run in the Supabase SQL Editor (superuser — bypasses RLS).

-- 1) Confirm the rows and see their current state / exact titles first:
select slug, title, has_stems, is_deleted, stem_slug
from songs
where title ilike any (array[
  'Great is the Lord',
  'Let Us Sing to the Lord',
  'In the Name of the Lord'
]);

-- 2) Update only the GraceTracks columns. Matched by title so no new rows are
--    created; adjust the WHERE titles if step 1 shows different spellings.
update songs set has_stems = true, is_deleted = false, stem_slug = 'great_is_the_lord'
where title = 'Great is the Lord';

update songs set has_stems = true, is_deleted = false, stem_slug = 'let_us_sing_to_the_lord'
where title = 'Let Us Sing to the Lord';

update songs set has_stems = true, is_deleted = false, stem_slug = 'in_the_name_of_the_lord'
where title = 'In the Name of the Lord';

-- 3) Verify:
select slug, title, has_stems, is_deleted, stem_slug
from songs
where title ilike any (array[
  'Great is the Lord',
  'Let Us Sing to the Lord',
  'In the Name of the Lord'
]);
