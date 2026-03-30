import { createClient } from '@supabase/supabase-js'

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
  _client = createClient(url, key)
  return _client
}

// Proxy so call sites (supabase.from(...)) work unchanged,
// but the client is only constructed on first actual use.
export const supabase = new Proxy(
  {},
  { get(_, prop) { return getClient()[prop] } }
)
