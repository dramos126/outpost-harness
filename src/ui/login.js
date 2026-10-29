/**
 * The login screen.
 *
 * Shown in exactly two situations: the page holds no token on a server that wants a password,
 * and a token it did hold has lapsed. Both resolve the same way — a successful login, after
 * which the overlay goes and whatever was waiting on it carries on. It never resolves any
 * other way; there is nothing useful behind it without a session.
 */
import { hasSetupToken, login, setupPassword } from '../api.js'

let active = null

/**
 * Put the form up and resolve once the user is in. A second call while one is already showing
 * returns the same promise, so an expired session hit by several polls at once still gets one
 * form.
 */
export function showLogin(user = '', { reason = '', setup = false } = {}) {
  if (active) return active

  const root = document.createElement('div')
  root.className = 'login'
  // A fresh box: the server is in setup mode and the page arrived on the link it printed, so
  // this form sets the first password instead of asking for one. Without the link there is
  // nothing to do here but say where it is.
  if (setup && !hasSetupToken()) {
    root.innerHTML = `
      <div class="inner">
        <h1>Outpost</h1>
        <p class="why">This Outpost has no password yet. Open the setup link the server printed when it started — on the machine, <code>journalctl --user -u outpost -n 20 | grep setup=</code> — to set one.</p>
      </div>`
    document.getElementById('app').appendChild(root)
    return new Promise(() => {})
  }
  root.innerHTML = `
    <form class="inner" autocomplete="on">
      <h1>Outpost</h1>
      <p class="why">${setup ? 'Set the first password for this Outpost' : reason ? escape(reason) : 'Log in to Outpost'}</p>
      <label>
        <span>Username</span>
        <input name="username" type="text" autocomplete="username" autocapitalize="off" spellcheck="false" required />
      </label>
      <label>
        <span>Password</span>
        <input name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required ${setup ? 'minlength="8"' : ''} />
      </label>
      ${setup ? `<label><span>Password again</span><input name="again" type="password" autocomplete="new-password" required /></label>` : ''}
      <p class="err" hidden></p>
      <button class="btn primary" type="submit">${setup ? 'Set password' : 'Log in'}</button>
    </form>`
  document.getElementById('app').appendChild(root)

  const form = root.querySelector('form')
  const userInput = form.elements.username
  const passInput = form.elements.password
  const err = root.querySelector('.err')
  const button = form.querySelector('button')

  if (user) userInput.value = user
  ;(user ? passInput : userInput).focus()

  active = new Promise((resolve) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      err.hidden = true
      if (setup && form.elements.again.value !== passInput.value) {
        err.textContent = 'The two passwords differ'
        err.hidden = false
        return
      }
      button.disabled = true
      button.textContent = setup ? 'Setting…' : 'Logging in…'
      try {
        if (setup) await setupPassword(userInput.value.trim(), passInput.value)
        else await login(userInput.value.trim(), passInput.value)
        root.classList.add('gone')
        setTimeout(() => root.remove(), 400)
        active = null
        resolve()
      } catch (ex) {
        err.textContent = ex.message || 'Could not log in'
        err.hidden = false
        passInput.value = ''
        passInput.focus()
      } finally {
        button.disabled = false
        button.textContent = setup ? 'Set password' : 'Log in'
      }
    })
  })
  return active
}

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
