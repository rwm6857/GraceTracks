import { supabase } from './supabase.js'

const EDITOR_ROLES = ['editor', 'admin', 'owner']

export async function getSession() {
  const { data } = await supabase.auth.getSession()
  return data.session
}

export async function getUser() {
  const { data } = await supabase.auth.getUser()
  return data.user ?? null
}

export async function signIn(email, password) {
  return supabase.auth.signInWithPassword({ email, password })
}

export async function signOut() {
  return supabase.auth.signOut()
}

export function isEditorPlus(user) {
  return EDITOR_ROLES.includes(user?.app_metadata?.role)
}

// Returns an unsubscribe function. Callback receives (user | null).
export function onAuthStateChange(callback) {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    callback(session?.user ?? null)
  })
  return () => data.subscription.unsubscribe()
}
