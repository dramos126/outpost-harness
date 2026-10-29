/**
 * Settings → Secrets: the store's public view, and the three ways to put something in it.
 */
import { addSecret, removeSecret } from '../../api.js'
import { escape } from './escape.js'

export const html = `
        <section class="group" id="g-secrets">
          <h3>Secrets</h3>
          <p class="lede">Kept on this machine only and never shown again. An access key made here never leaves it: give its public half to a machine or to GitHub and Outpost can reach them. Lost with the machine, by design.</p>
          <div class="secrets"></div>
          <div class="row">
            <input class="input" name="secret-name" placeholder="a name, e.g. outpost-key" />
            <button class="btn" data-secret="generate">Make an access key</button>
            <button class="btn ghost" data-secret="token">Add a token</button>
            <button class="btn ghost" data-secret="key">Paste an existing key</button>
          </div>
          <textarea class="input mono" name="secret-value" rows="3" hidden placeholder=""></textarea>
          <div class="row" hidden data-secret-confirm><button class="btn primary" data-secret="save">Save</button><button class="btn ghost" data-secret="cancel">Cancel</button></div>
          <div class="state" data-state="off"></div>
        </section>`

export const methods = {
  setSecrets(secrets) {
    this.secrets = secrets
    this.paintSecrets()
    if (this.integrations) this.setIntegrations(this.integrations)
    this.paintHostKeyChoices()
  },

  paintSecrets() {
    const el = this.$('.secrets')
    if (!(this.secrets || []).length) {
      el.innerHTML = `<div class="why">Nothing yet. Make an access key so this Outpost can reach your machines and GitHub.</div>`
      return
    }
    el.innerHTML = this.secrets
      .map(
        (s) =>
          `<div class="secret">` +
          `<div class="row between"><span class="who"><b>${escape(s.name)}</b><small>${s.kind === 'ssh-key' ? (s.generated ? 'access key · made here' : 'access key · pasted') : 'token'} · ${escape(s.hint)}${s.fingerprint ? ` · ${escape(s.fingerprint)}` : ''}</small></span>` +
          `<span class="row">${s.publicKey ? `<button class="btn sm" data-secret="copy" data-name="${escape(s.name)}">Copy public key</button>` : ''}<button class="btn sm ghost danger" data-secret="remove" data-name="${escape(s.name)}">Remove</button></span></div>` +
          (s.publicKey ? `<pre class="pubkey">${escape(s.publicKey)}</pre>` : '') +
          `</div>`
      )
      .join('')
  },

  _wireSecrets() {
    const g = this.$('#g-secrets')
    const name = g.querySelector('input[name=secret-name]')
    const value = g.querySelector('textarea[name=secret-value]')
    const confirm = g.querySelector('[data-secret-confirm]')
    const state = g.querySelector('.state')
    const say = (text, kind = 'off') => {
      state.dataset.state = kind
      state.textContent = text
    }
    let mode = ''
    g.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-secret]')
      if (!b) return
      const act = b.dataset.secret
      try {
        if (act === 'generate') {
          b.disabled = true
          const res = await addSecret('generate', name.value)
          this.setSecrets(res.secrets || [])
          this.paintAuthChoices(this.$('.cat-form select[name=auth]').value)
          name.value = ''
          this.onToast(`Key ${res.secret.name} generated — copy its public half where it needs to go`)
          say('')
        } else if (act === 'token' || act === 'key') {
          mode = act
          value.hidden = false
          value.placeholder = act === 'token' ? 'the token' : '-----BEGIN OPENSSH PRIVATE KEY-----'
          confirm.hidden = false
          value.focus()
        } else if (act === 'cancel') {
          mode = ''
          value.hidden = true
          value.value = ''
          confirm.hidden = true
        } else if (act === 'save') {
          b.disabled = true
          const res = await addSecret(mode, name.value, value.value)
          this.setSecrets(res.secrets || [])
          this.paintAuthChoices(this.$('.cat-form select[name=auth]').value)
          name.value = ''
          value.value = ''
          value.hidden = true
          confirm.hidden = true
          this.onToast(`${res.secret.name} saved`)
          say('')
        } else if (act === 'copy') {
          const s = this.secrets.find((x) => x.name === b.dataset.name)
          if (!s) return
          try {
            await navigator.clipboard.writeText(s.publicKey)
            this.onToast('Public key copied')
          } catch {
            say('Could not reach the clipboard — select the key below and copy it', 'err')
          }
        } else if (act === 'remove') {
          const res = await removeSecret(b.dataset.name)
          this.setSecrets(res.secrets || [])
          this.paintAuthChoices(this.$('.cat-form select[name=auth]').value)
          this.onToast(`${b.dataset.name} removed`)
        }
      } catch (err) {
        say(err.message || 'That did not work', 'err')
      } finally {
        b.disabled = false
      }
    })
  },
}
