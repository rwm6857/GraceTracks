import { signIn } from '../lib/auth.js'

/**
 * Mounts a sign-in modal overlay onto document.body.
 * @param {Function} onSuccess - called after a successful sign-in
 */
export function renderSignIn(onSuccess) {
  const overlay = document.createElement('div')
  overlay.className = 'gt-signin-overlay'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', 'Sign in')

  overlay.innerHTML = `
    <div class="gt-signin">
      <h2 class="gt-signin__title">Sign In</h2>
      <form class="gt-signin__form" novalidate>
        <label class="gt-signin__label" for="signin-email">Email</label>
        <input
          id="signin-email"
          class="gt-signin__input"
          type="email"
          autocomplete="email"
          required
          placeholder="you@example.com"
        />
        <label class="gt-signin__label" for="signin-password">Password</label>
        <input
          id="signin-password"
          class="gt-signin__input"
          type="password"
          autocomplete="current-password"
          required
          placeholder="••••••••"
        />
        <p class="gt-signin__error" hidden></p>
        <button type="submit" class="gc-btn gc-btn--primary gt-signin__submit">
          Sign In
        </button>
      </form>
    </div>
  `

  const form     = overlay.querySelector('.gt-signin__form')
  const emailEl  = overlay.querySelector('#signin-email')
  const passEl   = overlay.querySelector('#signin-password')
  const errorEl  = overlay.querySelector('.gt-signin__error')
  const submitEl = overlay.querySelector('.gt-signin__submit')

  function dismiss() {
    overlay.remove()
    document.removeEventListener('keydown', onKeyDown)
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') dismiss()
  }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) dismiss()
  })

  document.addEventListener('keydown', onKeyDown)

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    errorEl.hidden = true
    submitEl.disabled = true
    submitEl.textContent = 'Signing in…'

    const { error } = await signIn(emailEl.value.trim(), passEl.value)

    if (error) {
      errorEl.textContent = error.message ?? 'Sign-in failed. Please try again.'
      errorEl.hidden = false
      submitEl.disabled = false
      submitEl.textContent = 'Sign In'
      emailEl.focus()
      return
    }

    dismiss()
    onSuccess()
  })

  document.body.appendChild(overlay)
  emailEl.focus()
}
