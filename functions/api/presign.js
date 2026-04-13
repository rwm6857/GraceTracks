import { AwsClient } from 'aws4fetch'

const VALID_TRACKS = new Set(['drums','perc','bass','elec','keys','synth','vox','strings','click','ambient'])
const VALID_EXTS   = new Set(['m4a', 'wav'])
const EDITOR_ROLES = new Set(['editor', 'admin', 'owner'])

// Presigned R2 PUT URL expires in 5 minutes
const PRESIGN_TTL_SECONDS = 300

export async function onRequestPost(context) {
  const { request, env } = context

  // ─── CORS preflight (handled by Cloudflare Pages, but be explicit) ────────
  const origin = request.headers.get('Origin') ?? ''
  const corsHeaders = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  }

  // ─── 1. Extract and verify JWT ────────────────────────────────────────────
  const authHeader = request.headers.get('Authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (!token) {
    return new Response('Unauthorized', { status: 401, headers: corsHeaders })
  }

  let user
  try {
    const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: env.SUPABASE_ANON_KEY,
      },
    })
    if (!res.ok) {
      return new Response('Unauthorized', { status: 401, headers: corsHeaders })
    }
    user = await res.json()
  } catch {
    return new Response('Unauthorized', { status: 401, headers: corsHeaders })
  }

  // ─── 2. Check editor+ role ────────────────────────────────────────────────
  const role = user?.app_metadata?.role
  if (!EDITOR_ROLES.has(role)) {
    return new Response('Forbidden: editor role required', { status: 403, headers: corsHeaders })
  }

  // ─── 3. Parse and validate request body ───────────────────────────────────
  let slug, track, ext
  try {
    ;({ slug, track, ext } = await request.json())
  } catch {
    return new Response('Bad Request: invalid JSON', { status: 400, headers: corsHeaders })
  }

  if (!slug || typeof slug !== 'string' || !/^[a-z0-9-]+$/.test(slug)) {
    return new Response('Bad Request: invalid slug', { status: 400, headers: corsHeaders })
  }
  if (!VALID_TRACKS.has(track)) {
    return new Response('Bad Request: invalid track', { status: 400, headers: corsHeaders })
  }
  if (!VALID_EXTS.has(ext)) {
    return new Response('Bad Request: invalid extension', { status: 400, headers: corsHeaders })
  }

  // ─── 4. Generate presigned PUT URL for R2 ─────────────────────────────────
  const r2 = new AwsClient({
    accessKeyId:     env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    region:          'auto',
    service:         's3',
  })

  const key        = `tracks/${slug}/${track}.${ext}`
  const bucketUrl  = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${key}`
  const expiry     = new Date(Date.now() + PRESIGN_TTL_SECONDS * 1000).toISOString()

  const signedReq = await r2.sign(
    new Request(bucketUrl, { method: 'PUT' }),
    { aws: { signQuery: true, allHeaders: false, datetime: expiry } }
  )

  return Response.json(
    { url: signedReq.url, method: 'PUT', expiresIn: PRESIGN_TTL_SECONDS },
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
}

// Handle OPTIONS preflight
export async function onRequestOptions(context) {
  const origin = context.request.headers.get('Origin') ?? ''
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  })
}
