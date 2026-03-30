import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl) {
  throw new Error(
    'Missing VITE_SUPABASE_URL — set it in Cloudflare Pages › Settings › Environment Variables (Production) and trigger a new deploy.'
  )
}
if (!supabaseAnonKey) {
  throw new Error(
    'Missing VITE_SUPABASE_ANON_KEY — set it in Cloudflare Pages › Settings › Environment Variables (Production) and trigger a new deploy.'
  )
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
