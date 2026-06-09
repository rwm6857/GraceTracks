import { AwsClient } from 'aws4fetch'

const VALID_TRACKS = new Set(['drums','perc','bass','elec','keys','synth','vox','strings','md','click','ambient'])
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

  // ─── 0. Resolve Supabase config ───────────────────────────────────────────
  // The Function ideally reads the non-prefixed SUPABASE_URL / SUPABASE_ANON_KEY
  // secrets, but the same project's frontend requires the VITE_-prefixed ones to
  // be set in Pages. Both are exposed to Functions at runtime, so fall back to
  // the VITE_ names — that way a deployment that only set the frontend vars still
  // authenticates instead of returning a misleading 401.
  const supabaseUrl = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const supabaseAnonKey = env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response(
      'Server misconfigured: set SUPABASE_URL and SUPABASE_ANON_KEY (or the VITE_ equivalents) in the Pages Function environment.',
      { status: 500, headers: corsHeaders }
    )
  }

  // ─── 1. Extract and verify JWT ────────────────────────────────────────────
  const authHeader = request.headers.get('Authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (!token) {
    return new Response('Unauthorized', { status: 401, headers: corsHeaders })
  }

  let user
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: supabaseAnonKey,
      },
    })
    if (!res.ok) {
      return new Response('Unauthorized', { status: 401, headers: corsHeaders })
    }
    user = await res.json()
  } catch {
    return new Response('Unauthorized', { status: 401, headers: corsHeaders })
  }

  // ─── 2. Check editor+ role (from the shared public.users table) ───────────
  // The role is NOT in auth app_metadata — GraceChords stores it on
  // public.users.role, so we look it up via PostgREST using the caller's token
  // (RLS lets a user read their own row).
  let role = null
  try {
    const roleRes = await fetch(
      `${supabaseUrl}/rest/v1/users?id=eq.${user.id}&select=role`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: supabaseAnonKey,
        },
      }
    )
    if (roleRes.ok) {
      const rows = await roleRes.json()
      role = rows?.[0]?.role ?? null
    }
  } catch {
    role = null
  }
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

  if (!slug || typeof slug !== 'string' || !/^[a-z0-9_-]+$/.test(slug)) {
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
