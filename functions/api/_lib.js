/**
 * Shared helpers for the /api/* Pages Functions: CORS headers and the
 * editor-role gate. No onRequest* exports — this file is not a route.
 */

const EDITOR_ROLES = new Set(['editor', 'admin', 'owner'])

export function corsHeaders(request) {
  return {
    'Access-Control-Allow-Origin': request.headers.get('Origin') ?? '',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  }
}

/** Standard OPTIONS preflight response for an /api route. */
export function optionsResponse(request, methods) {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': request.headers.get('Origin') ?? '',
      'Access-Control-Allow-Methods': methods,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  })
}

/**
 * Verify the caller's Supabase JWT and require an editor+ role.
 * Returns an error Response the route should send back as-is, or null when
 * the caller may proceed.
 *
 * The role is NOT in auth app_metadata — GraceChords stores it on
 * public.users.role, so we look it up via PostgREST using the caller's token
 * (RLS lets a user read their own row).
 */
export async function requireEditor(request, env, cors) {
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
      { status: 500, headers: cors }
    )
  }

  const authHeader = request.headers.get('Authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (!token) {
    return new Response('Unauthorized', { status: 401, headers: cors })
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
      return new Response('Unauthorized', { status: 401, headers: cors })
    }
    user = await res.json()
  } catch {
    return new Response('Unauthorized', { status: 401, headers: cors })
  }

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
    return new Response('Forbidden: editor role required', { status: 403, headers: cors })
  }

  return null
}
