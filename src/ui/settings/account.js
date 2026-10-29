/**
 * Settings → Account: who is logged in, Log out, changing the password, and the git identity
 * every workspace commits as.
 */
import { changePassword, saveGitIdentity } from '../../api.js'
import { escape } from './escape.js'

export const html = `
        <section class="group" id="g-account">
          <h3>Account</h3>
          <div class="account"></div>
          <form class="pw-form" hidden>
            <p class="lede">Change the password. Every other device is logged out; this one stays in.</p>
            <div class="row"><label class="sub grow"><span>Current password</span><input class="input" name="current" type="password" autocomplete="current-password" required /></label></div>
            <div class="row"><label class="sub grow"><span>New password</span><input class="input" name="password" type="password" autocomplete="new-password" minlength="8" required /></label><label class="sub grow"><span>Again</span><input class="input" name="again" type="password" autocomplete="new-password" minlength="8" required /></label></div>
            <div class="row"><button class="btn primary" type="submit">Change password</button></div>
            <div class="state pw-state" data-state="off"></div>
          </form>
          <form class="git-form">
            <p class="lede">Who commits in a workspace. Every chat's checkout commits as this; empty takes your global git identity, or the machine's user as a last resort.</p>
            <div class="row"><label class="sub grow"><span>Name</span><input class="input" name="name" /></label><label class="sub grow"><span>Email</span><input class="input" name="email" type="email" /></label><button class="btn primary" type="submit">Save</button></div>
            <div class="state git-state" data-state="off"></div>
          </form>
        </section>`

export const methods = {
  setAccount(account) {
    this.account = account
    const el = this.$('.account')
    el.innerHTML = account.passwordAuth
      ? `<div class="row between"><span>Logged in as <b>${escape(account.user || 'you')}</b></span><button class="btn ghost" data-act="logout">Log out</button></div>` +
        `<p class="why">Log out leaves other devices logged in.</p>`
      : `<p class="why">No password is set on this server; it answers only to the token link.</p>`
    // There is a password to change only where password auth is on.
    this.$('.pw-form').hidden = !account.passwordAuth
  },

  setGitIdentity({ settings: s, effective: e }) {
    const form = this.$('.git-form')
    form.elements.name.value = s?.name || ''
    form.elements.email.value = s?.email || ''
    form.elements.name.placeholder = e?.name || ''
    form.elements.email.placeholder = e?.email || ''
    const state = form.querySelector('.git-state')
    state.dataset.state = e?.from === 'host' ? 'err' : 'on'
    state.textContent = e ? `Commits as ${e.name} <${e.email}> (${e.from === 'settings' ? 'from here' : e.from === 'global' ? 'your global git config' : 'a guess from the machine — set one'})` : ''
  },

  _wireAccount() {
    this.$('.account').addEventListener('click', (e) => {
      if (e.target.closest('[data-act=logout]')) this.onLogout()
    })
    const pw = this.$('.pw-form')
    const pwSay = (text, kind = 'off') => {
      const el = pw.querySelector('.pw-state')
      el.dataset.state = kind
      el.textContent = text
    }
    pw.addEventListener('submit', async (e) => {
      e.preventDefault()
      const f = pw.elements
      if (f.password.value !== f.again.value) return pwSay('The two new passwords do not match', 'err')
      const b = pw.querySelector('button[type=submit]')
      b.disabled = true
      try {
        await changePassword(f.current.value, f.password.value)
        pw.reset()
        pwSay('Password changed — every other device is logged out', 'on')
      } catch (err) {
        pwSay(err.message || 'Could not change it', 'err')
      } finally {
        b.disabled = false
      }
    })
    const form = this.$('.git-form')
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      try {
        const res = await saveGitIdentity({ name: form.elements.name.value, email: form.elements.email.value })
        this.setGitIdentity(res)
        this.onToast('Git identity saved')
      } catch (err) {
        form.querySelector('.git-state').textContent = err.message || 'Could not save that'
      }
    })
  },
}
