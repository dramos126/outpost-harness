/**
 * Settings › Integrations › Hosts: the other machines Outpost copies data from, each with a
 * Test. "Machines" until the redesign, which read as this one; a host is one of the things
 * Outpost reaches, so it is on the Integrations page with the rest of them.
 *
 * Self-contained like GitHub and Jenkins: a host's access key is made or pasted in the host's
 * own form, and the host shows the public half to put on that machine. It used to be chosen
 * from what Keys and tokens already held — "generate a key first", on another page.
 */
import { addSecret, deleteEnvironment, forgetHostKey, saveEnvironment, testEnvironment } from '../../api.js'
import { escape } from './escape.js'

/**
 * The two choices in the key list that are not a key yet. `@` because no secret name can hold
 * one (the store's alphabet is lowercase letters, digits, dots, dashes and underscores). They
 * were a NUL and a word, and an HTML attribute cannot carry a NUL: the browser turned it into
 * U+FFFD, the comparisons below never matched, no key was made, and the host was saved naming
 * a key called "�new" (bugs-fixed.md).
 */
const NEW_KEY = '@new'
const PASTE_KEY = '@paste'

/**
 * A host's actions as the box shows them, one a line — `logs: read /var/log/app`,
 * `status: run docker ps` — and back. A line that is neither is kept out, and said.
 */
const actionsToText = (actions) => (actions || []).map((a) => `${a.name}: ${a.kind} ${a.target}`).join('\n')
function textToActions(text) {
  const actions = []
  const bad = []
  for (const line of String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)) {
    const m = /^([^:\s][^:]*?)\s*:\s*(read|run)\s+(.+)$/.exec(line)
    if (m) actions.push({ name: m[1], kind: m[2], target: m[3].trim() })
    else bad.push(line)
  }
  return { actions, bad }
}

/** A host's own key is named after it, in the store's alphabet: `host-docker-local`. */
const keyNameFor = (host) =>
  `host-${String(host || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')}`.slice(0, 41)

export const html = `
        <section class="group" id="g-env">
          <h3>Hosts</h3>
          <p class="lede">Other machines Outpost can reach: to copy data from before a chat starts, and to do what you allow below for chats on a repo that names the host. Make a key for a host here and put its public half in that machine's <code>~/.ssh/authorized_keys</code>. Tested, not assumed: a host is trusted the first time and refused if its identity changes, until you say otherwise.</p>
          <div class="envs"></div>
          <form class="env-form">
            <h4 class="env-form-title">Add a host</h4>
            <div class="row"><label class="sub"><span>Name</span><input class="input" name="name" placeholder="docker-local" required /></label><label class="sub"><span>Address</span><input class="input mono" name="host" placeholder="192.0.2.10" required /></label><label class="sub"><span>Log in as</span><input class="input" name="user" placeholder="deploy" /></label><label class="sub"><span>Port</span><input class="input" name="port" placeholder="22" size="4" /></label><label class="sub"><span>Access key</span><select class="select" name="key"></select></label></div>
            <textarea class="input mono" name="keyValue" rows="3" hidden placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea>
            <label class="sub"><span>What a chat may do here, one per line — <code>name: read /path</code> to read the files under a path, <code>name: run command</code> to run that command exactly. Nothing until a repo names this host.</span><textarea class="input mono" name="actions" rows="3" placeholder="For example:&#10;logs: read /var/log/app&#10;status: run docker ps --format '{{.Names}} {{.Status}}'"></textarea></label>
            <div class="row"><button class="btn primary" type="submit">Add host</button><button class="btn ghost" type="button" data-env="cancel" hidden>Cancel</button></div>
          </form>
          <div class="state env-state" data-state="off"></div>
        </section>`

/**
 * What a failed Test means in words, for the two failures every new host meets: nothing is
 * listening (the machine's SSH service is off — some NAS systems ship it off), or the key is not on it.
 */
function testHint(error) {
  const e = String(error || '')
  if (/connection refused/i.test(e)) return "Nothing answered on that port — the host's SSH service is not running, or listens on another port."
  if (/permission denied/i.test(e)) return "The host refused the key — put this host's public key in that user's ~/.ssh/authorized_keys."
  if (/timed out|no route/i.test(e)) return 'The address did not answer — check it, and that this machine can reach it.'
  return ''
}

export const methods = {
  /** The key list: this host's own new key, a pasted one, or a key the store already holds. */
  paintHostKeyChoices() {
    const sel = this.$('.env-form select[name=key]')
    const current = sel.value
    const keys = (this.secrets || []).filter((s) => s.kind === 'ssh-key')
    sel.innerHTML =
      `<option value="${NEW_KEY}">make a new key for this host</option>` +
      `<option value="${PASTE_KEY}">paste a private key</option>` +
      keys.map((s) => `<option value="${escape(s.name)}">${escape(s.name)}</option>`).join('')
    sel.value = current && [...sel.options].some((o) => o.value === current) ? current : NEW_KEY
    this.$('.env-form textarea[name=keyValue]').hidden = sel.value !== PASTE_KEY
  },

  /**
   * A host's public key, drawn inside its own row with Copy — it used to appear under the form,
   * where it read as belonging to whatever the form held next.
   */
  hostPublicKey(env) {
    const s = (this.secrets || []).find((x) => x.name === env.key)
    if (!s?.publicKey) return ''
    return (
      `<div class="env-pub">` +
      `<div class="why">Add this line to <code>~/.ssh/authorized_keys</code> for ${escape(env.user || 'the user')} on ${escape(env.host)}, then Test.</div>` +
      `<pre class="pubkey">${escape(s.publicKey)}</pre>` +
      `<div class="row"><button class="btn sm" type="button" data-env="copypub" data-key="${escape(env.key)}">Copy public key</button></div>` +
      `</div>`
    )
  },

  /** The repos that name a host — for its actions, a dataset's source, or a data copy. */
  hostUsedBy(name) {
    return (this.catalogue || [])
      .filter((r) => (r.hosts || []).includes(name) || (r.dataSources || []).some((s) => s.host === name) || (r.data || []).some((d) => d.env === name))
      .map((r) => r.name)
  },

  /** Back to "Add a host": the form empty, the heading and the button saying so. */
  resetHostForm() {
    const form = this.$('.env-form')
    form.reset()
    form.elements.keyValue.value = ''
    form.elements.name.readOnly = false
    this.editingHost = ''
    this.$('.env-form-title').textContent = 'Add a host'
    form.querySelector('button[type=submit]').textContent = 'Add host'
    form.querySelector('[data-env=cancel]').hidden = true
    this.paintHostKeyChoices()
  },

  setEnvironments(envs) {
    this.environments = envs
    this.results = this.results || new Map()
    this.paintEnvironments()
  },

  paintEnvironments() {
    const el = this.$('.envs')
    if (!(this.environments || []).length) {
      el.innerHTML = `<div class="why">No hosts yet.</div>`
      return
    }
    el.innerHTML = this.environments
      .map((e) => {
        const r = this.results.get(e.name)
        let status = ''
        if (r?.ok) status = `<span class="ok">connected · ${escape(r.hostname)}${r.tools?.length ? ` · ${escape(r.tools.join(', '))}` : ' · no sqlite3, docker or rsync'}</span>`
        else if (r) {
          const hint = testHint(r.error)
          status = `<span class="bad">${escape(r.error)}</span>${hint ? ` — ${escape(hint)}` : ''}${r.hostKeyChanged ? ` <button class="btn sm ghost" data-env="forget" data-host="${escape(e.host)}">Trust its new identity</button>` : ''}`
        }
        const used = this.hostUsedBy(e.name)
        const pubOpen = this.pubOpen === e.name
        return (
          `<div class="env-host">` +
          `<div class="env-row row between">` +
          `<span class="who"><b>${escape(e.name)}</b><small class="mono">${escape(e.user)}@${escape(e.host)}${e.port !== 22 ? `:${e.port}` : ''} · with ${escape(e.key || 'no key')}</small>` +
          `<small>${e.actions?.length ? `chats may: ${escape(e.actions.map((a) => (a.kind === 'read' ? `read ${a.target}` : `run ${a.name}`)).join(', '))}` : 'chats may do nothing here'}</small>` +
          `<small>${used.length ? `used by ${escape(used.join(', '))}` : 'no repo uses it yet'}</small>${status ? `<small>${status}</small>` : ''}${
            r?.fingerprint ? `<small class="mono">${escape(r.fingerprint)}</small>` : ''
          }</span>` +
          `<span class="row"><button class="btn sm" data-env="test" data-name="${escape(e.name)}">Test</button>${
            (this.secrets || []).some((s) => s.name === e.key && s.publicKey) ? `<button class="btn sm ghost" data-env="pub" data-name="${escape(e.name)}">${pubOpen ? 'Hide public key' : 'Public key'}</button>` : ''
          }<button class="btn sm ghost" data-env="edit" data-name="${escape(e.name)}">Edit</button><button class="btn sm ghost danger" data-env="remove" data-name="${escape(e.name)}">Remove</button></span>` +
          `</div>` +
          (pubOpen ? this.hostPublicKey(e) : '') +
          `</div>`
        )
      })
      .join('')
  },

  _wireEnvironments() {
    const g = this.$('#g-env')
    const form = g.querySelector('.env-form')
    const state = g.querySelector('.env-state')
    const say = (text, kind = 'off') => {
      state.dataset.state = kind
      state.textContent = text
    }
    const f = (n) => form.elements[n]
    f('key').addEventListener('change', () => {
      f('keyValue').hidden = f('key').value !== PASTE_KEY
    })
    // Before the store has been read the list still offers a new key or a pasted one, rather
    // than nothing — a host saved from an empty list would name no key at all.
    this.paintHostKeyChoices()
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      try {
        // The key first, if this host is getting one of its own, so the host is never saved
        // naming a key that is not there.
        let key = f('key').value
        let made = false
        if (key === NEW_KEY || key === PASTE_KEY) {
          const name = keyNameFor(f('name').value)
          const exists = (this.secrets || []).some((s) => s.name === name)
          if (key === PASTE_KEY) {
            const r = await addSecret('key', name, f('keyValue').value)
            this.setSecrets(r.secrets || [])
          } else if (!exists) {
            const r = await addSecret('generate', name)
            this.setSecrets(r.secrets || [])
            made = true
          }
          key = name
        }
        const { actions, bad } = textToActions(f('actions').value)
        if (bad.length) throw new Error(`Not an action — write "name: read /path" or "name: run command": ${bad[0]}`)
        const res = await saveEnvironment({ name: f('name').value, host: f('host').value, user: f('user').value, port: f('port').value, key, actions })
        // A new key's public half opens on the host's own row: it has to go on that machine next.
        if (made) this.pubOpen = res.environment.name
        this.setEnvironments(res.environments || [])
        this.paintDataRows(this.readDataRows())
        this.resetHostForm()
        this.onToast(made ? `${res.environment.name} saved — put its public key on the host, then test it` : `${res.environment.name} saved — test it`)
        say('')
      } catch (err) {
        say(err.message || 'Could not save that', 'err')
      }
    })
    g.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-env]')
      if (!b) return
      const act = b.dataset.env
      b.disabled = true
      try {
        if (act === 'test') {
          say(`Connecting to ${b.dataset.name}…`)
          const r = await testEnvironment(b.dataset.name)
          this.results.set(b.dataset.name, r)
          this.paintEnvironments()
          say('')
        } else if (act === 'edit') {
          const env = this.environments.find((x) => x.name === b.dataset.name)
          if (!env) return
          f('name').value = env.name
          f('host').value = env.host
          f('user').value = env.user
          f('port').value = env.port === 22 ? '' : String(env.port)
          f('key').value = env.key
          f('keyValue').hidden = f('key').value !== PASTE_KEY
          f('actions').value = actionsToText(env.actions)
          // The name is what the repos and the key go by, so an edit keeps it; a new name is a new host.
          f('name').readOnly = true
          this.editingHost = env.name
          this.$('.env-form-title').textContent = `Editing ${env.name}`
          form.querySelector('button[type=submit]').textContent = 'Save'
          form.querySelector('[data-env=cancel]').hidden = false
          f('host').focus()
        } else if (act === 'cancel') {
          this.resetHostForm()
          say('')
        } else if (act === 'remove') {
          const res = await deleteEnvironment(b.dataset.name)
          if (this.editingHost === b.dataset.name) this.resetHostForm()
          this.setEnvironments(res.environments || [])
          this.onToast(`${b.dataset.name} removed`)
        } else if (act === 'forget') {
          await forgetHostKey(b.dataset.host)
          this.onToast(`Forgot the key for ${b.dataset.host} — test again to trust the new one`)
        } else if (act === 'pub') {
          this.pubOpen = this.pubOpen === b.dataset.name ? '' : b.dataset.name
          this.paintEnvironments()
        } else if (act === 'copypub') {
          const s = (this.secrets || []).find((x) => x.name === b.dataset.key)
          try {
            await navigator.clipboard.writeText(s?.publicKey || '')
            this.onToast('Public key copied')
          } catch {
            say('Could not reach the clipboard — select the key above and copy it', 'err')
          }
        }
      } catch (err) {
        say(err.message || 'That did not work', 'err')
      } finally {
        b.disabled = false
      }
    })
  },
}
