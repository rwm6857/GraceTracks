/**
 * Song versions — shared helpers.
 *
 * A song can have multiple named stem sets ("versions", e.g. AGMC2026 / HQ /
 * GA2024). Rows live in the song_versions table; a song with no rows has a
 * single implicit "Original" version whose stems sit at the legacy R2 path
 * tracks/<stem_slug>/<stem>.<ext>. Versioned stems live under
 * tracks/<stem_slug>/versions/<version_slug>/<stem>.<ext>.
 *
 * Default resolution: at most one row per song carries is_default = true
 * (enforced by a partial unique index); when no row is flagged, Original is
 * the default. The reserved slug 'original' never appears in the table — it
 * is only used in URLs (?v=original) and presign requests to mean "legacy
 * path".
 */
import { supabase } from './supabase.js'

export const VERSION_RE = /^[a-z0-9_-]{1,64}$/
export const ORIGINAL_PARAM = 'original'

/**
 * R2 folder for a version, passed as the `stemSlug` arg of resolveStemUrl
 * (which only URL-encodes the stem filename, so the embedded slash is fine).
 * @param {string} stemSlug - the song's R2 folder (songs.stem_slug || slug)
 * @param {string|null} versionSlug - null = Original (legacy path)
 */
export function versionFolder(stemSlug, versionSlug) {
  return versionSlug ? `${stemSlug}/versions/${versionSlug}` : stemSlug
}

/**
 * Normalized version list for one song: Original first, then DB rows in
 * created_at order. Exactly one entry has isDefault = true.
 * @param {Array<{version_slug: string, label: string, is_default: boolean}>} rows
 * @returns {Array<{versionSlug: string|null, label: string, isDefault: boolean}>}
 */
export function buildVersionList(rows = []) {
  return [
    { versionSlug: null, label: 'Original', isDefault: !rows.some(r => r.is_default) },
    ...rows.map(r => ({ versionSlug: r.version_slug, label: r.label, isDefault: r.is_default })),
  ]
}

/**
 * Resolve which version a `?v=` request maps to.
 * 'original' → Original; a known slug → that version; absent/unknown → the
 * default entry.
 */
export function resolveActiveVersion(list, requested) {
  if (requested === ORIGINAL_PARAM) return list[0]
  if (requested) {
    const match = list.find(v => v.versionSlug === requested)
    if (match) return match
  }
  return list.find(v => v.isDefault) ?? list[0]
}

/**
 * Mixer URL for a version. The bare URL means "default version", so the
 * default gets no query param; non-default Original is addressed explicitly
 * as ?v=original.
 * @param {string|null} defaultVersionSlug - version_slug of the is_default
 *   row, or null when Original is the default
 */
export function versionUrl(songSlug, versionSlug, defaultVersionSlug = null) {
  if ((versionSlug ?? null) === (defaultVersionSlug ?? null)) return `/song/${songSlug}`
  if (versionSlug == null) return `/song/${songSlug}?v=${ORIGINAL_PARAM}`
  return `/song/${songSlug}?v=${versionSlug}`
}

/** All version rows for one song, oldest first. Errors degrade to []. */
export async function fetchSongVersions(songSlug) {
  const { data, error } = await supabase
    .from('song_versions')
    .select('version_slug, label, is_default')
    .eq('song_slug', songSlug)
    .order('created_at')
  if (error) {
    console.error('[GraceTracks] failed to load song versions:', error)
    return []
  }
  return data ?? []
}

/**
 * Version rows for every visible song (RLS hides the rest), grouped by
 * song_slug — one query for the whole picker. Errors degrade to an empty Map.
 * @returns {Promise<Map<string, Array>>}
 */
export async function fetchAllVersions() {
  const { data, error } = await supabase
    .from('song_versions')
    .select('song_slug, version_slug, label, is_default')
    .order('created_at')
  if (error) {
    console.error('[GraceTracks] failed to load song versions:', error)
    return new Map()
  }
  const bySlug = new Map()
  for (const row of data ?? []) {
    if (!bySlug.has(row.song_slug)) bySlug.set(row.song_slug, [])
    bySlug.get(row.song_slug).push(row)
  }
  return bySlug
}

/**
 * Make one version the song's default (null = Original). Two sequential
 * updates rather than a transaction; the partial unique index keeps the
 * "≤1 default" invariant, and the worst interruption leaves no flagged row,
 * which safely means "Original is default".
 */
export async function setDefaultVersion(songSlug, versionSlug) {
  const { error: clearError } = await supabase
    .from('song_versions')
    .update({ is_default: false })
    .eq('song_slug', songSlug)
  if (clearError) return clearError
  if (versionSlug == null) return null
  const { error } = await supabase
    .from('song_versions')
    .update({ is_default: true })
    .eq('song_slug', songSlug)
    .eq('version_slug', versionSlug)
  return error
}
