import { supabase } from './supabase.js'

const EDITOR_ROLES = ['editor', 'admin', 'owner']

export async function getSession() {
  const { data } = await supabase.auth.getSession()
  return data.session
}

// Fetch the caller's role from the shared `public.users` table — the same
// source of truth GraceChords uses (its useAuth reads `users.role`). The role
// is NOT stored in auth `app_metadata`, so we must look it up here. RLS lets a
// user read their own row, so this works with the anon key + the user session.
async function fetchRole(userId) {
  if (!userId) return null
  try {
    const { data, error } = await supabase
      .from('users')
      .select('role')
      .eq('id', userId)
      .single()
    if (error) return null
    return data?.role ?? null
  } catch {
    return null
  }
}

// Attach the resolved role onto the user object as `.role` so the synchronous
// `isEditorPlus(user)` checks throughout the app keep working.
async function withRole(user) {
  if (!user) return null
  user.role = await fetchRole(user.id)
  return user
}

export async function getUser() {
  const { data } = await supabase.auth.getUser()
  return withRole(data.user ?? null)
}

export async function signIn(email, password) {
  return supabase.auth.signInWithPassword({ email, password })
}

export async function signOut() {
  return supabase.auth.signOut()
}

export function isEditorPlus(user) {
  // Prefer the role fetched from `users`; fall back to app_metadata for safety.
  const role = user?.role ?? user?.app_metadata?.role
  return EDITOR_ROLES.includes(role)
}

// Returns an unsubscribe function. Callback receives (user | null) with `.role`
// already resolved.
export function onAuthStateChange(callback) {
  const { data } = supabase.auth.onAuthStateChange(async (_event, session) => {
    callback(await withRole(session?.user ?? null))
  })
  return () => data.subscription.unsubscribe()
}
