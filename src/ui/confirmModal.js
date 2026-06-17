/**
 * Mounts a confirmation modal overlay onto document.body. Resolves true when
 * the user confirms, false when they cancel / dismiss (overlay click or Escape).
 *
 * @param {Object} opts
 * @param {string} [opts.title] - heading text
 * @param {string} opts.message - body text (rendered as plain text)
 * @param {string} [opts.confirmLabel] - confirm button label
 * @param {string} [opts.cancelLabel] - cancel button label
 * @param {boolean} [opts.danger] - style the confirm button as destructive
 * @returns {Promise<boolean>}
 */
export function confirmModal({
  title = 'Confirm',
  message,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  danger = true,
} = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'gt-signin-overlay'
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'true')
    overlay.setAttribute('aria-label', title)

    overlay.innerHTML = `
      <div class="gt-confirm">
        <h2 class="gt-confirm__title"></h2>
        <p class="gt-confirm__message"></p>
        <div class="gt-confirm__actions">
          <button type="button" class="gc-btn gc-btn--ghost" data-cancel>${cancelLabel}</button>
          <button type="button" class="gc-btn ${danger ? 'gc-btn--danger' : 'gc-btn--primary'}" data-confirm>${confirmLabel}</button>
        </div>
      </div>
    `
    // textContent keeps song/version names safe from HTML injection.
    overlay.querySelector('.gt-confirm__title').textContent = title
    overlay.querySelector('.gt-confirm__message').textContent = message

    function done(result) {
      overlay.remove()
      document.removeEventListener('keydown', onKeyDown)
      resolve(result)
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') done(false)
    }

    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false) })
    overlay.querySelector('[data-cancel]').addEventListener('click', () => done(false))
    overlay.querySelector('[data-confirm]').addEventListener('click', () => done(true))
    document.addEventListener('keydown', onKeyDown)

    document.body.appendChild(overlay)
    overlay.querySelector('[data-confirm]').focus()
  })
}
