/**
 * /api/stems — list and delete stem files in R2 (editor+ only).
 *
 * Maintenance backend for the upload page:
 *   GET    ?slug=<folder>&version=<v>           → top-level files of one version folder
 *   DELETE { slug, version?, files: [...] }     → remove specific files from a version
 *   DELETE { slug, version, scope: 'version' }  → wipe one named version's folder
 *   DELETE { slug, scope: 'song' }              → wipe every stem file for the song
 *
 * Uses the STEMS_BUCKET R2 binding rather than presigned URLs — no binary data
 * flows through here, only key listing/deletion. Database rows (songs.has_stems,
 * song_versions) are the client's responsibility, guarded by RLS.
 */
import { corsHeaders, optionsResponse, requireEditor } from './_lib.js'

const SLUG_RE = /^[a-z0-9_-]+$/
const VERSION_RE = /^[a-z0-9_-]{1,64}$/
// Basenames only — keys are composed server-side, so no '/' may appear and an
// audio extension is required. Spaces cover legacy hand-uploaded aliases
// ("2nd keys.m4a").
const FILE_RE = /^[a-z0-9 _.()-]{1,80}\.(m4a|wav)$/i
const MAX_FILES = 40

function folderFor(slug, version) {
  return version ? `tracks/${slug}/versions/${version}/` : `tracks/${slug}/`
}

// Absent or 'original' means the legacy path, mirroring presign.
function normalizeVersion(version) {
  if (version == null || version === '' || version === 'original') return { version: null }
  if (typeof version !== 'string' || !VERSION_RE.test(version)) return { error: true }
  return { version }
}

/** Delete everything under a prefix. Re-lists from the start after each batch. */
async function wipePrefix(bucket, prefix) {
  let deleted = 0
  for (;;) {
    const page = await bucket.list({ prefix })
    const keys = page.objects.map(o => o.key)
    if (keys.length === 0) return deleted
    await bucket.delete(keys)
    deleted += keys.length
    if (!page.truncated) return deleted
  }
}

export async function onRequestGet(context) {
  const { request, env } = context
  const cors = corsHeaders(request)

  const denied = await requireEditor(request, env, cors)
  if (denied) return denied
  if (!env.STEMS_BUCKET) {
    return new Response('Server misconfigured: STEMS_BUCKET R2 binding is not set.', { status: 500, headers: cors })
  }

  const params = new URL(request.url).searchParams
  const slug = params.get('slug') ?? ''
  if (!SLUG_RE.test(slug)) {
    return new Response('Bad Request: invalid slug', { status: 400, headers: cors })
  }
  const { version, error } = normalizeVersion(params.get('version'))
  if (error) {
    return new Response('Bad Request: invalid version', { status: 400, headers: cors })
  }

  // The '/' delimiter keeps versions/ subfolders out of the Original listing.
  const prefix = folderFor(slug, version)
  const files = []
  let cursor
  do {
    const page = await env.STEMS_BUCKET.list({ prefix, delimiter: '/', cursor })
    for (const obj of page.objects) {
      files.push({ name: obj.key.slice(prefix.length), size: obj.size })
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)

  return Response.json({ files }, { headers: { ...cors, 'Content-Type': 'application/json' } })
}

export async function onRequestDelete(context) {
  const { request, env } = context
  const cors = corsHeaders(request)

  const denied = await requireEditor(request, env, cors)
  if (denied) return denied
  if (!env.STEMS_BUCKET) {
    return new Response('Server misconfigured: STEMS_BUCKET R2 binding is not set.', { status: 500, headers: cors })
  }

  let body
  try {
    body = await request.json()
  } catch {
    return new Response('Bad Request: invalid JSON', { status: 400, headers: cors })
  }

  const { slug, files, scope } = body ?? {}
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    return new Response('Bad Request: invalid slug', { status: 400, headers: cors })
  }
  const { version, error } = normalizeVersion(body?.version)
  if (error) {
    return new Response('Bad Request: invalid version', { status: 400, headers: cors })
  }

  let deleted
  if (Array.isArray(files)) {
    if (
      files.length === 0 || files.length > MAX_FILES ||
      !files.every(f => typeof f === 'string' && FILE_RE.test(f))
    ) {
      return new Response('Bad Request: invalid files', { status: 400, headers: cors })
    }
    const prefix = folderFor(slug, version)
    await env.STEMS_BUCKET.delete(files.map(f => `${prefix}${f}`))
    deleted = files.length
  } else if (scope === 'version') {
    // Wiping the legacy Original folder alone isn't supported — its prefix
    // contains the versions/ subtree. Removing Original stems wholesale is
    // either per-file deletes or a full scope:'song' wipe.
    if (!version) {
      return new Response('Bad Request: scope "version" requires a named version', { status: 400, headers: cors })
    }
    deleted = await wipePrefix(env.STEMS_BUCKET, folderFor(slug, version))
  } else if (scope === 'song') {
    deleted = await wipePrefix(env.STEMS_BUCKET, folderFor(slug, null))
  } else {
    return new Response('Bad Request: provide files[] or scope', { status: 400, headers: cors })
  }

  return Response.json({ deleted }, { headers: { ...cors, 'Content-Type': 'application/json' } })
}

export async function onRequestOptions(context) {
  return optionsResponse(context.request, 'GET, DELETE, OPTIONS')
}
