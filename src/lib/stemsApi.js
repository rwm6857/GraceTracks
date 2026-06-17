/**
 * Client for the /api/stems Pages Function — listing and deleting stem files
 * in R2. Editor+ only (the server re-checks the role); used by the upload
 * page's maintenance features. Database rows (songs.has_stems, song_versions)
 * are updated separately via Supabase.
 */
import { getSession } from './auth.js'

async function stemsFetch(path, opts = {}) {
  const session = await getSession()
  if (!session?.access_token) {
    throw new Error('Your session has expired. Please sign in again.')
  }
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
  })
  if (!res.ok) {
    let msg
    if (res.status === 403) {
      msg = 'Permission denied. Editor role required.'
    } else if (res.status === 401) {
      msg = 'Session expired — sign out and back in.'
    } else if (res.status === 500) {
      msg = 'Server not configured.'
    } else {
      msg = `Request failed (${res.status})`
    }
    throw new Error(msg)
  }
  return res.json()
}

/**
 * Files with sizes (e.g. [{ name: 'drums.m4a', size: 12914872 }]) in one
 * version folder, read straight from R2 via the S3 API (origin, no CDN).
 * versionSlug null = the legacy Original path.
 * @returns {Promise<Array<{name: string, size: number}>>}
 */
export async function statStemFiles(stemSlug, versionSlug) {
  const params = new URLSearchParams({ slug: stemSlug })
  if (versionSlug) params.set('version', versionSlug)
  const { files } = await stemsFetch(`/api/stems?${params}`)
  return files ?? []
}

/**
 * Filenames (e.g. ['drums.m4a', 'vocals.wav']) currently in one version
 * folder. versionSlug null = the legacy Original path.
 * @returns {Promise<string[]>}
 */
export async function listStemFiles(stemSlug, versionSlug) {
  return (await statStemFiles(stemSlug, versionSlug)).map(f => f.name)
}

/** Delete specific files from one version folder. */
export function deleteStemFiles(stemSlug, versionSlug, files) {
  return stemsFetch('/api/stems', {
    method: 'DELETE',
    body: JSON.stringify({
      slug: stemSlug,
      ...(versionSlug ? { version: versionSlug } : {}),
      files,
    }),
  })
}

/** Delete every file of one named version (not Original). */
export function deleteVersionStems(stemSlug, versionSlug) {
  return stemsFetch('/api/stems', {
    method: 'DELETE',
    body: JSON.stringify({ slug: stemSlug, version: versionSlug, scope: 'version' }),
  })
}

/** Delete every stem file for a song — Original and all named versions. */
export function deleteSongStems(stemSlug) {
  return stemsFetch('/api/stems', {
    method: 'DELETE',
    body: JSON.stringify({ slug: stemSlug, scope: 'song' }),
  })
}
