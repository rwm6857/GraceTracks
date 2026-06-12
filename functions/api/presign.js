import { AwsClient } from 'aws4fetch'
import { corsHeaders as buildCorsHeaders, optionsResponse, requireEditor } from './_lib.js'

const VALID_TRACKS = new Set(['drums','perc','bass','elec','keys','synth','vox','strings','md','click','ambient'])
const VALID_EXTS   = new Set(['m4a', 'wav'])

// Presigned R2 PUT URL expires in 5 minutes
const PRESIGN_TTL_SECONDS = 300

export async function onRequestPost(context) {
  const { request, env } = context

  // CORS preflight (handled by Cloudflare Pages, but be explicit)
  const corsHeaders = buildCorsHeaders(request)

  // ─── 1–2. Verify JWT + editor role ────────────────────────────────────────
  const denied = await requireEditor(request, env, corsHeaders)
  if (denied) return denied

  // ─── 3. Parse and validate request body ───────────────────────────────────
  let slug, track, ext, version
  try {
    ;({ slug, track, ext, version } = await request.json())
  } catch {
    return new Response('Bad Request: invalid JSON', { status: 400, headers: corsHeaders })
  }

  if (!slug || typeof slug !== 'string' || !/^[a-z0-9_-]+$/.test(slug)) {
    return new Response('Bad Request: invalid slug', { status: 400, headers: corsHeaders })
  }
  if (!VALID_TRACKS.has(track)) {
    return new Response('Bad Request: invalid track', { status: 400, headers: corsHeaders })
  }
  if (!VALID_EXTS.has(ext)) {
    return new Response('Bad Request: invalid extension', { status: 400, headers: corsHeaders })
  }
  // `version` selects a named stem set under tracks/<slug>/versions/<version>/.
  // Absent or 'original' targets the legacy path ('original' is accepted so the
  // uploader can overwrite Original stems through one uniform code path).
  if (version == null || version === '' || version === 'original') {
    version = null
  } else if (typeof version !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(version)) {
    return new Response('Bad Request: invalid version', { status: 400, headers: corsHeaders })
  }

  // ─── 4. Generate presigned PUT URL for R2 ─────────────────────────────────
  const r2 = new AwsClient({
    accessKeyId:     env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    region:          'auto',
    service:         's3',
  })

  const key = version
    ? `tracks/${slug}/versions/${version}/${track}.${ext}`
    : `tracks/${slug}/${track}.${ext}`
  const bucketUrl = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${key}`

  // Presign as query params. aws4fetch fills X-Amz-Date itself (correct compact
  // SigV4 format); the URL's X-Amz-Expires sets the TTL. Passing a `datetime`
  // here would have to be the AWS basic format — an ISO string corrupts both the
  // timestamp and the credential scope, so we let aws4fetch handle it.
  const signUrl = new URL(bucketUrl)
  signUrl.searchParams.set('X-Amz-Expires', String(PRESIGN_TTL_SECONDS))

  const signedReq = await r2.sign(signUrl.toString(), {
    method: 'PUT',
    aws: { signQuery: true, allHeaders: false },
  })

  return Response.json(
    { url: signedReq.url, method: 'PUT', expiresIn: PRESIGN_TTL_SECONDS },
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
}

// Handle OPTIONS preflight
export async function onRequestOptions(context) {
  return optionsResponse(context.request, 'POST, OPTIONS')
}
