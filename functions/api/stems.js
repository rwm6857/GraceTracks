/**
 * /api/stems — list and delete stem files in R2 (editor+ only).
 *
 * Maintenance backend for the upload page:
 *   GET    ?slug=<folder>&version=<v>           → top-level files of one version folder
 *   DELETE { slug, version?, files: [...] }     → remove specific files from a version
 *   DELETE { slug, version, scope: 'version' }  → wipe one named version's folder
 *   DELETE { slug, scope: 'song' }              → wipe every stem file for the song
 *
 * Talks to R2 over the S3 API with the same credentials presign uses
 * (R2_ACCOUNT_ID / R2_BUCKET_NAME / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY) —
 * NOT the STEMS_BUCKET binding, which isn't reliably configured in Pages. No
 * binary data flows through here, only key listing/deletion. Database rows
 * (songs.has_stems, song_versions) are the client's responsibility, guarded by
 * RLS.
 */
import { AwsClient } from 'aws4fetch'
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

// ─── R2 (S3 API) plumbing ─────────────────────────────────────────────────
function r2Config(env) {
  const accountId = env.R2_ACCOUNT_ID
  const bucket = env.R2_BUCKET_NAME
  if (!accountId || !bucket || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) return null
  return {
    client: new AwsClient({
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      region: 'auto',
      service: 's3',
    }),
    base: `https://${accountId}.r2.cloudflarestorage.com/${bucket}`,
  }
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Path-style URL for a key, with each segment percent-encoded (slashes kept). */
function keyUrl(base, key) {
  return `${base}/${key.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * ListObjectsV2, following continuation tokens. With delimiter '/', objects in
 * deeper subfolders (e.g. versions/) collapse into CommonPrefixes and are
 * excluded from the returned Contents.
 * @returns {Promise<Array<{key: string, size: number}>>}
 */
async function listObjects({ client, base }, prefix, { delimiter } = {}) {
  const out = []
  let token
  do {
    const u = new URL(base)
    u.searchParams.set('list-type', '2')
    u.searchParams.set('prefix', prefix)
    if (delimiter) u.searchParams.set('delimiter', delimiter)
    if (token) u.searchParams.set('continuation-token', token)

    const res = await client.fetch(u.toString(), { method: 'GET' })
    if (!res.ok) throw new Error(`R2 list failed (${res.status})`)
    const xml = await res.text()

    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const block = m[1]
      const key = decodeEntities((block.match(/<Key>([\s\S]*?)<\/Key>/) ?? [])[1] ?? '')
      const size = Number((block.match(/<Size>(\d+)<\/Size>/) ?? [])[1] ?? 0)
      if (key) out.push({ key, size })
    }

    const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/.test(xml)
    token = truncated
      ? decodeEntities((xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/) ?? [])[1] ?? '')
      : null
  } while (token)
  return out
}

/** Delete the given keys. Treats a 404 as already-gone. */
async function deleteKeys({ client, base }, keys) {
  await Promise.all(keys.map(async (key) => {
    const res = await client.fetch(keyUrl(base, key), { method: 'DELETE' })
    if (!res.ok && res.status !== 404) throw new Error(`R2 delete failed (${res.status})`)
  }))
  return keys.length
}

async function wipePrefix(r2, prefix) {
  const objs = await listObjects(r2, prefix) // recursive (no delimiter)
  if (objs.length === 0) return 0
  return deleteKeys(r2, objs.map(o => o.key))
}

export async function onRequestGet(context) {
  const { request, env } = context
  const cors = corsHeaders(request)

  const denied = await requireEditor(request, env, cors)
  if (denied) return denied
  const r2 = r2Config(env)
  if (!r2) {
    return new Response('Server misconfigured: R2 credentials are not set.', { status: 500, headers: cors })
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
  let files
  try {
    const objs = await listObjects(r2, prefix, { delimiter: '/' })
    files = objs.map(o => ({ name: o.key.slice(prefix.length), size: o.size }))
  } catch (err) {
    return new Response(`R2 error: ${err.message}`, { status: 502, headers: cors })
  }

  return Response.json({ files }, { headers: { ...cors, 'Content-Type': 'application/json' } })
}

export async function onRequestDelete(context) {
  const { request, env } = context
  const cors = corsHeaders(request)

  const denied = await requireEditor(request, env, cors)
  if (denied) return denied
  const r2 = r2Config(env)
  if (!r2) {
    return new Response('Server misconfigured: R2 credentials are not set.', { status: 500, headers: cors })
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
  try {
    if (Array.isArray(files)) {
      if (
        files.length === 0 || files.length > MAX_FILES ||
        !files.every(f => typeof f === 'string' && FILE_RE.test(f))
      ) {
        return new Response('Bad Request: invalid files', { status: 400, headers: cors })
      }
      const prefix = folderFor(slug, version)
      deleted = await deleteKeys(r2, files.map(f => `${prefix}${f}`))
    } else if (scope === 'version') {
      // Wiping the legacy Original folder alone isn't supported — its prefix
      // contains the versions/ subtree. Removing Original stems wholesale is
      // either per-file deletes or a full scope:'song' wipe.
      if (!version) {
        return new Response('Bad Request: scope "version" requires a named version', { status: 400, headers: cors })
      }
      deleted = await wipePrefix(r2, folderFor(slug, version))
    } else if (scope === 'song') {
      deleted = await wipePrefix(r2, folderFor(slug, null))
    } else {
      return new Response('Bad Request: provide files[] or scope', { status: 400, headers: cors })
    }
  } catch (err) {
    return new Response(`R2 error: ${err.message}`, { status: 502, headers: cors })
  }

  return Response.json({ deleted }, { headers: { ...cors, 'Content-Type': 'application/json' } })
}

export async function onRequestOptions(context) {
  return optionsResponse(context.request, 'GET, DELETE, OPTIONS')
}
