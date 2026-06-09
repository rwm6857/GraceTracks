import { createClient } from '@supabase/supabase-js'
import { cookieStorage } from './cookieStorage.js'

let _client = null

function getClient() {
  if (_client) return _client
  const url = import.meta.env.VITE_SUPABASE_URL
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY
  if (!url || !key) {
    throw new Error(
      'Supabase credentials missing. ' +
      'In Cloudflare Pages → Settings → Environment Variables, ' +
      'add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY for both ' +
      'Production AND Preview environments, then redeploy.'
    )
  }
  // Store the session in a cookie scoped to `.gracechords.com` so the login is
  // shared with gracechords.com (single sign-on). The default storageKey is
  // derived from the shared project ref, so both apps read the same cookie.
  _client = createClient(url, key, {
    auth: {
      storage: cookieStorage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  })
  return _client
}

// Proxy so call sites (supabase.from(...)) work unchanged,
// but the client is only constructed on first actual use.
export const supabase = new Proxy(
  {},
  { get(_, prop) { return getClient()[prop] } }
)
