import { supabase } from './supabase.js'

const EDITOR_ROLES = ['editor', 'admin', 'owner']

export async function getSession() {
  const { data } = await supabase.auth.getSession()
  return data.session
}

// Fetch the caller's role + avatar sprite from the shared `public.users` table —
// the same source of truth GraceChords uses (its useAuth reads `users.role` and
// `users.preferences.sprite`). RLS lets a user read their own row, so this works
// with the anon key + the user session.
async function fetchProfile(userId) {
  if (!userId) return { role: null, sprite: null }
  try {
    const { data, error } = await supabase
      .from('users')
      .select('role, preferences')
      .eq('id', userId)
      .single()
    if (error) return { role: null, sprite: null }
    return { role: data?.role ?? null, sprite: data?.preferences?.sprite ?? null }
  } catch {
    return { role: null, sprite: null }
  }
}

// Attach the resolved role + sprite onto the user object so the synchronous
// `isEditorPlus(user)` checks and the navbar avatar keep working.
async function withProfile(user) {
  if (!user) return null
  const { role, sprite } = await fetchProfile(user.id)
  user.role = role
  user.sprite = sprite
  return user
}

export async function getUser() {
  const { data } = await supabase.auth.getUser()
  return withProfile(data.user ?? null)
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
    callback(await withProfile(session?.user ?? null))
  })
  return () => data.subscription.unsubscribe()
}
