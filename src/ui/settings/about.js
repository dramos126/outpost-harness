/**
 * Settings › General › About this machine: the launcher and the harnesses found, then what
 * chats need of the box — the `claude` program, a way to sign in, the hooks — and every secret
 * or host the settings and repos name that this machine does not have (server/machine.mjs).
 * The last is the new-machine path's list: after an import it is what is left to do.
 */
import { fetchMachine } from '../../api.js'
import { escape } from './escape.js'

export const html = `
        <section class="group" id="g-about">
          <h3>About this machine</h3>
          <div class="about"></div>
          <div class="about-checks"><div class="why">Checking…</div></div>
          <div class="row"><button class="btn sm ghost" type="button" data-about="check">Check again</button></div>
        </section>`

export const methods = {
  setAbout({ launcher, harnesses }) {
    this.$('.about').innerHTML =
      `<div class="kv"><span>Launcher</span><b>${escape(launcher?.name || '—')}</b></div>` +
      (harnesses || [])
        .map((h) => `<div class="kv"><span>${escape(h.name)}</span><b>${h.detected ? 'detected' : 'not found'}</b></div>`)
        .join('')
    this.checkMachine()
  },

  /** What is still to enter on this machine, a line each with where — shared with Export and import. */
  missingHtml(missing) {
    if (!missing?.length) return `<div class="state" data-state="on">Nothing missing: every secret and host the settings and repos name is here.</div>`
    return (
      `<div class="why">${missing.length} thing${missing.length === 1 ? '' : 's'} the settings or repos name that this machine does not have:</div>` +
      `<ul class="missing">${missing.map((m) => `<li><span>${escape(m.what)}</span><small>${escape(m.where)}</small></li>`).join('')}</ul>`
    )
  },

  async checkMachine() {
    const el = this.$('.about-checks')
    let m
    try {
      m = await fetchMachine()
    } catch (err) {
      el.innerHTML = `<div class="state" data-state="err">${escape(err.message || 'Could not check this machine')}</div>`
      return
    }
    const row = (label, ok, text) => `<div class="kv"><span>${label}</span><b class="${ok ? 'ok' : 'bad'}">${escape(text)}</b></div>`
    el.innerHTML =
      row('Claude program', m.claude.ok, m.claude.ok ? m.claude.version : m.claude.error) +
      row('Chats sign in with', m.signIn.ok, m.signIn.how) +
      row(
        'Hooks',
        m.hooks.ok,
        m.hooks.ok ? 'installed for every event' : m.hooks.error || `missing ${m.hooks.missing.join(', ')} — run yarn hooks ~ in Outpost's checkout`,
      ) +
      (m.containers ? row('Containers', m.containers.ok, m.containers.how) : '') +
      this.missingHtml(m.missing)
  },

  _wireAbout() {
    this.$('[data-about=check]').addEventListener('click', () => this.checkMachine())
  },
}
