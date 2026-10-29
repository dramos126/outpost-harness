/**
 * Settings › Repos: the repos a chat can check out (the catalogue, in the code and the docs),
 * and one repo's settings as a page of its own.
 *
 * Choosing a repo replaces the list with its settings, in sections, with a way back to all
 * of them. The form used to open under the list in the middle of a card, thirteen fields
 * long, pushing everything after it down the page.
 */
import { deleteCatalogueRepo, detectRepoPorts, fetchDatasets, fetchJenkinsJobs, saveCatalogueRepo, savePushDefault, syncDataset, testCustomPush, testRemote } from '../../api.js'
import { ICON } from '../shell.js'
import { escape } from './escape.js'

/** What "push" can mean (config.mjs `PUSH_MODES`), in the words the page uses. */
const PUSH_LABELS = { main: 'push to main, up to date first', remote: 'push the branch to origin only', custom: 'custom — a sentence of yours' }
const PUSH_CHOICES = Object.entries(PUSH_LABELS)
  .map(([v, l]) => `<option value="${v}">${l}</option>`)
  .join('')

/**
 * The custom push setting's sentence, its Test and what the Test found. Drawn twice: under
 * the default at the top of the page, with a Save of its own, and in a repo's form, where the
 * form's Save is the one held back.
 */
const customBox = (save) => `
            <div class="push-custom" hidden>
              <label class="sub"><span>What push should do, in a sentence</span><input class="input" name="pushSentence" placeholder="push to dev, then open a PR to main" autocomplete="off" maxlength="500" /></label>
              <div class="row"><button class="btn sm" type="button" data-push="test">Test</button>${save ? '<button class="btn sm primary" type="button" data-push="save" disabled>Save</button>' : ''}<span class="why push-say"></span></div>
              <ol class="push-steps"></ol>
            </div>`

/**
 * Wire one `customBox`. Save is allowed for the sentence as saved, or as it stood when a Test
 * last passed — and editing it clears that pass, so what is saved is what was tested (the
 * server holds the same line, custom-push.mjs). `repo()` is the repo's form for the Test, or
 * null for the default; `onChange` repaints whichever Save this box holds back.
 */
function wireCustomPush(box, { repo, onChange }) {
  const input = box.querySelector('input[name=pushSentence]')
  const say = box.querySelector('.push-say')
  const steps = box.querySelector('.push-steps')
  const test = box.querySelector('[data-push=test]')
  let saved = ''
  let passed = ''
  const value = () => input.value.trim()
  const ready = () => Boolean(value()) && (value() === saved || value() === passed)
  const hint = () => {
    say.textContent = !value() ? '' : value() === saved ? 'Saved' : ready() ? 'Passed — it can be saved' : 'Test it — it can be saved once the Test passes'
  }
  input.addEventListener('input', () => {
    if (value() !== passed) passed = ''
    steps.innerHTML = ''
    hint()
    onChange()
  })
  test.addEventListener('click', async () => {
    const sentence = value()
    if (!sentence) return input.focus()
    test.disabled = true
    steps.innerHTML = ''
    say.textContent = 'Reading the sentence, then checking each step — nothing is pushed…'
    try {
      const res = await testCustomPush(sentence, repo())
      steps.innerHTML = (res.steps || [])
        .map((s) => `<li data-ok="${s.ok ? 'yes' : 'no'}"><span>${s.ok ? '✓' : '✕'} ${escape(s.text)}</span>${s.why ? `<small>${escape(s.why)}</small>` : ''}</li>`)
        .join('')
      // A pass is for the sentence that was tested; one edited while the Test ran has none.
      if (res.ok && value() === sentence) passed = sentence
      if (res.ok) hint()
      else say.textContent = res.error || 'It cannot be saved until every step passes'
    } catch (err) {
      say.textContent = err.message || 'Could not test that'
    } finally {
      test.disabled = false
      onChange()
    }
  })
  return {
    ready,
    value,
    /** Show the box for a sentence as saved (or none), with nothing tested. */
    set(sentence) {
      saved = sentence || ''
      passed = ''
      input.value = saved
      steps.innerHTML = ''
      hint()
    },
    show(on) {
      box.hidden = !on
    },
  }
}

export const html = `
        <section class="group" id="g-catalogue">
          <h3>Repos</h3>
          <p class="lede cat-lede">The repos a chat can check out, and each repo's settings: the branch to start from, what to run once it is checked out, what a chat there may do without asking.</p>
          <div class="push-default">
            <label class="sub"><span>When a chat pushes, by default</span><select class="select" name="push-default">${PUSH_CHOICES}</select></label>${customBox(true)}
            <span class="why">Whichever it is, the latest main is merged into the work branch first, so it is up to date and a conflict is found before anything is pushed. A repo can choose differently on its own page.</span>
          </div>
          <div class="cat-list"></div>
          <form class="cat-form" hidden>
            <button class="btn ghost sm cat-back" type="button" data-cat="cancel">‹ All repos</button>
            <h4 class="cat-title"></h4>
            <div class="sect"><h5>Basics</h5>
              <div class="row"><label class="sub grow"><span>Name</span><input class="input" name="name" required /></label><label class="sub grow"><span>Clone URL</span><input class="input mono" name="url" placeholder="git@github.com:you/repo.git" required /></label></div>            </div>
            <div class="sect"><h5>Branches</h5>
              <div class="row"><label class="sub"><span>A chat starts from</span><input class="input" name="baseBranch" placeholder="the repo's main branch" /></label><label class="sub grow"><span>Its work branches are named</span><input class="input mono" name="branchTemplate" placeholder="outpost/{slug}" /></label></div>
              <span class="why">A chat starts on the latest of that branch and makes a branch for each piece of work, named from this pattern — <code>{slug}</code> is the work's name.</span>
            </div>
            <div class="sect"><h5>Pushing</h5>
              <div class="row"><label class="sub"><span>When a chat pushes its work</span><select class="select" name="push"><option value="">the default</option>${PUSH_CHOICES}</select></label></div>${customBox(false)}
              <div class="row"><label class="sub"><span>The Workspace section's Finish button offers first</span><select class="select" name="finish"><option value="push">merge and push to the branch it started from</option><option value="pr">open a pull request</option></select></label></div>
            </div>
            <div class="sect"><h5>Access</h5>
              <div class="row"><label class="sub"><span>Outpost reaches the repo with</span><select class="select" name="auth"><option value="">the GitHub integration</option></select></label></div>
              <span class="why">The GitHub integration is the token under Integrations, and travels with an export. "This machine's own access" is the ssh setup on this box, and does not.</span>
            </div>
            <div class="sect"><h5>What a chat may do</h5>
              <div class="row"><label class="sub"><span>Without asking</span><select class="select" name="permissionMode"><option value="">edit its own files (default)</option><option value="acceptEdits">edit its own files</option><option value="default">nothing — ask first</option><option value="plan">plan only</option><option value="dontAsk">never ask; refuse instead</option></select></label></div>
              <div class="row"><label class="sub grow"><span>Always allowed, one rule per line</span><textarea class="input mono" name="allow" rows="3" placeholder="Bash(yarn *)&#10;Bash(git *)"></textarea></label><label class="sub grow"><span>Never allowed, one rule per line</span><textarea class="input mono" name="deny" rows="3" placeholder="Bash(git push origin main*)"></textarea></label></div>
            </div>
            <div class="sect"><h5>Container</h5>
              <div class="row"><label class="sub grow"><span>Image a chat's container starts from</span><input class="input mono" name="containerImage" placeholder="Outpost's own: node, git, curl and build tools" /></label></div>
              <div class="row"><label class="sub grow"><span>Extra packages for Outpost's image, Debian names</span><input class="input mono" name="packages" placeholder="openjdk-17-jdk-headless" /></label></div>
              <span class="why">Every chat runs in a container of its own: it sees its own checkout, its repo's data and nothing else of this machine, and its setup commands run in one too. An image named here must have git and curl. Extra packages are built into Outpost's own image instead, on any machine, the first time a chat needs them; they do nothing when an image is named. With no Claude sign-in under Integrations › Claude, or no Podman, a chat does not start, and says which.</span>
            </div>
            <div class="sect"><h5>Ports</h5>
              <span class="why">The ports a chat on this repo serves on. With the private network on (Settings › General › Containers) each is published to a host port; the chat's Workspace panel links to it. Scan fills these in from the repo; edit as you like. Not 5274: inside a chat that is Outpost's own port, so it is never published.</span>
              <div class="cat-ports">${Array.from({ length: 5 }, () => `<div class="row"><label class="sub grow"><span>Label</span><input class="input" name="portLabel" placeholder="App" maxlength="24" /></label><label class="sub"><span>Port</span><input class="input mono" name="portNum" size="6" inputmode="numeric" /></label></div>`).join('')}</div>
              <div class="row"><button class="btn sm" type="button" data-cat="scanports">Scan the repo</button><span class="why cat-ports-say"></span></div>
            </div>
            <div class="sect cat-jenkins"><h5>Jenkins</h5>
              <span class="why">A chat can read any job whose builds check this repo out. It can start and stop only the jobs ticked here — and is asked before one that is not.</span>
              <div class="cat-jobs"></div><span class="why cat-jobs-say"></span>
              <div class="row"><label class="sub"><span>When a Jenkins build of a chat's work finishes, wake the chat</span><select class="select" name="jenkinsWake"><option value="">if it failed (default)</option><option value="always">always</option><option value="never">never</option></select></label></div>
              <span class="why">A wake is a turn — about what a one-line message costs. A chat still working can wait for the result instead, which costs none.</span>
            </div>
            <div class="sect"><h5>Hosts</h5>
              <span class="why">Other machines a chat here may use — only what each host allows, set under Integrations › Hosts.</span>
              <div class="cat-hosts"></div>
            </div>
            <div class="sect"><h5>Environment</h5>
              <span class="why">Variables every chat on this repo gets in its <code>.env.local</code>. A secret is kept in the store and shown only by its end. A locked entry asks for your password before it changes.</span>
              <div class="var-rows"></div>
              <button class="btn sm ghost" type="button" data-cat="addenv">${ICON.plus}Add a variable</button>
            </div>
            <div class="sect cat-data"><h5>Data</h5>
              <span class="why">What the repo says it needs, in its <code>.outpost/data.json</code>, and where each comes from on this machine.</span>
              <div class="data-sets"></div>
            </div>
            <div class="sect"><h5>Setup</h5>
              <label class="sub"><span>Commands to run once the repo is checked out, one per line</span><textarea class="input mono" name="setup" rows="2" placeholder="corepack yarn install --immutable"></textarea></label>
              <div class="sub"><span>Files to copy in before the chat starts</span>
                <div class="data-rows"></div>
                <button class="btn sm ghost" type="button" data-cat="adddata">${ICON.plus}Add a source</button>
              </div>
            </div>
            <div class="state" data-state="off"></div>
            <div class="row lock-confirm" hidden><label class="sub grow"><span>This changes a locked variable — your Outpost password to confirm</span><input class="input" name="lockPassword" type="password" autocomplete="current-password" /></label></div>
            <div class="row"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-cat="test">Test URL</button><button class="btn ghost" type="button" data-cat="cancel">Cancel</button><button class="btn ghost danger" type="button" data-cat="delete" hidden>Remove</button></div>
          </form>
        </section>`

export const methods = {
  /** The instance-wide push default, `{ mode, custom? }`, at the top of the Repos page. */
  setPushDefault(push) {
    this.pushDefault = push?.mode || 'main'
    this.pushDefaultSentence = push?.custom?.sentence || ''
    this.$('select[name=push-default]').value = this.pushDefault
    this.pushBoxes?.default.set(this.pushDefaultSentence)
    this.pushBoxes?.default.show(this.pushDefault === 'custom')
    this.paintPushDefault()
  },

  /** A repo's "the default" says what the default is, so choosing it is not a guess. */
  paintPushDefault() {
    const opt = this.$('.cat-form select[name=push] option[value=""]')
    const mode = this.pushDefault || 'main'
    if (opt) opt.textContent = `the default (${mode === 'custom' ? `custom: ${this.pushDefaultSentence}` : PUSH_LABELS[mode]})`
  },

  /**
   * A new repo's form filled in with what `/registerRepo` read off it (ui-settings.md), for
   * the fields its card does not show. Called straight after Settings opens on General.
   */
  prefillRepo(draft) {
    if (this.page !== 'repos') this.openPage('repos')
    this.openRepoForm({ ...draft, id: '' })
  },

  setCatalogue(repos) {
    this.catalogue = repos
    this.paintCatalogue()
    // Each host says which repos use it, so the hosts are repainted with the repos.
    if (this.environments) this.paintEnvironments()
  },

  paintCatalogue() {
    const el = this.$('.cat-list')
    const rows = (this.catalogue || []).map(
      (r) =>
        `<button class="cat-row" data-id="${escape(r.id)}"><span class="who"><b>${escape(r.name)}</b><small class="mono">${escape(r.url)}</small></span>` +
        `<span class="why">${escape([r.baseBranch || 'default branch', r.setup.length ? `${r.setup.length} setup` : ''].filter(Boolean).join(' · '))}</span></button>`
    )
    rows.push(`<button class="btn ghost" data-id="">${ICON.plus}Add a repo</button>`)
    el.innerHTML = rows.join('')
  },

  _wireCatalogue() {
    const list = this.$('.cat-list')
    const form = this.$('.cat-form')
    const state = form.querySelector('.state')
    const f = (name) => form.elements[name]
    const lines = (v) => String(v || '').split('\n').map((l) => l.trim()).filter(Boolean)
    const say = (text, kind = 'off') => {
      state.dataset.state = kind
      state.textContent = text
    }
    // The list and the one repo's page take turns: a repo's settings replace the list, and
    // closing them — Cancel, Save, Remove, or "All repos" — brings the list back.
    const showList = (on) => {
      list.hidden = !on
      this.$('.cat-lede').hidden = !on
      this.$('.push-default').hidden = !on
      form.hidden = on
    }
    const defaultBox = this.$('.push-default .push-custom')
    const defaultSave = defaultBox.querySelector('[data-push=save]')
    const submit = form.querySelector('button[type=submit]')
    this.pushBoxes = {
      default: wireCustomPush(defaultBox, {
        repo: () => null,
        onChange: () => (defaultSave.disabled = !this.pushBoxes.default.ready()),
      }),
      // A repo's own: its form as it stands is what the Test checks, and the form's Save is
      // off while the choice is custom and its sentence has not passed.
      repo: wireCustomPush(form.querySelector('.push-custom'), {
        repo: () => ({ name: f('name').value, url: f('url').value, auth: f('auth').value, baseBranch: f('baseBranch').value, branchTemplate: f('branchTemplate').value, jenkinsJobs: this.readJobs() }),
        onChange: () => paintSubmit(),
      }),
    }
    const paintSubmit = () => {
      const custom = f('push').value === 'custom'
      this.pushBoxes.repo.show(custom)
      submit.disabled = custom && !this.pushBoxes.repo.ready()
    }
    f('push').addEventListener('change', paintSubmit)
    // The jobs that build a repo are known only once its URL is: a new repo's list was drawn
    // when the form opened, before the URL was typed, so it suggested nothing and its first Save
    // stored "chose none" for good. Asked again when the URL changes — a list not yet chosen
    // ticks the new suggestions; one already chosen keeps what is ticked now.
    f('url').addEventListener('change', () => {
      const failing = [...form.querySelectorAll('input[name=jenkinsFailureChats]:checked')].map((b) => b.value)
      this.paintJobs({ url: f('url').value, ...(this.jobsChosen ? { jenkinsJobs: this.readJobs() } : {}), jenkinsFailureChats: failing })
    })
    const saveDefault = async (mode, sentence) => {
      try {
        const res = await savePushDefault(mode, sentence)
        this.setPushDefault(res.push)
        defaultSave.disabled = true
        this.onToast(`When a chat pushes: ${res.push.mode === 'custom' ? res.push.custom.sentence : PUSH_LABELS[res.push.mode]}`)
      } catch (err) {
        this.onToast(err.message || 'Could not save that', 'err')
      }
    }
    // The default saves on change: one choice, nothing to batch with it. Custom is the
    // exception — choosing it opens its sentence, and it is saved by its own Save once the
    // Test has passed; until then the default is still what it was.
    this.$('select[name=push-default]').addEventListener('change', (e) => {
      const custom = e.target.value === 'custom'
      this.pushBoxes.default.show(custom)
      if (custom) defaultSave.disabled = !this.pushBoxes.default.ready()
      else saveDefault(e.target.value)
    })
    defaultSave.addEventListener('click', () => saveDefault('custom', this.pushBoxes.default.value()))
    const closeForm = () => showList(true)
    const openForm = (repo) => {
      this.editing = repo?.id || ''
      form.querySelector('.cat-title').textContent = repo?.name || 'A new repo'
      f('name').value = repo?.name || ''
      f('url').value = repo?.url || ''
      f('baseBranch').value = repo?.baseBranch || ''
      f('branchTemplate').value = repo?.branchTemplate || ''
      f('permissionMode').value = repo?.permissionMode || ''
      f('finish').value = repo?.finish || 'push'
      f('push').value = repo?.push || ''
      f('jenkinsWake').value = repo?.jenkinsWake || ''
      this.paintJobs(repo)
      this.paintRepoHosts(repo?.hosts || [])
      this.pushBoxes.repo.set(repo?.pushCustom?.sentence || '')
      paintSubmit()
      this.paintPushDefault()
      this.paintAuthChoices(repo?.auth || '')
      this.paintDataRows(repo?.data || [])
      this.paintEnvRows(repo?.env || [])
      this.paintDatasets(repo)
      this.lockPassword = ''
      form.querySelector('.lock-confirm').hidden = true
      f('setup').value = (repo?.setup || []).join('\n')
      f('containerImage').value = repo?.containerImage || ''
      f('packages').value = (repo?.packages || []).join(' ')
      this.fillPortRows(repo?.ports || [])
      form.querySelector('.cat-ports-say').textContent = ''
      f('allow').value = (repo?.allow || []).join('\n')
      f('deny').value = (repo?.deny || []).join('\n')
      // A /registerRepo draft has no id yet: a new repo, nothing to remove.
      form.querySelector('[data-cat=delete]').hidden = !this.editing
      say('')
      showList(false)
      this.$('.set-pages').scrollTop = 0
      f('name').focus()
    }
    // `/registerRepo`'s Edit in Settings opens the form on its draft (`prefillRepo`).
    this.openRepoForm = openForm
    list.addEventListener('click', (e) => {
      const b = e.target.closest('[data-id]')
      if (!b) return
      openForm(b.dataset.id ? this.catalogue.find((r) => r.id === b.dataset.id) : null)
    })
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      const entry = {
        id: this.editing,
        name: f('name').value,
        url: f('url').value,
        baseBranch: f('baseBranch').value,
        branchTemplate: f('branchTemplate').value,
        permissionMode: f('permissionMode').value,
        setup: lines(f('setup').value),
        allow: lines(f('allow').value),
        deny: lines(f('deny').value),
        auth: f('auth').value,
        finish: f('finish').value,
        push: f('push').value,
        jenkinsWake: f('jenkinsWake').value,
        jenkinsJobs: this.readJobs(),
        hosts: [...form.querySelectorAll('input[name=hosts]:checked')].map((b) => b.value),
        jenkinsFailureChats: [...form.querySelectorAll('input[name=jenkinsFailureChats]:checked')].map((b) => b.value),
        // The sentence alone: the server keeps the steps its Test passed with.
        ...(f('push').value === 'custom' ? { pushCustom: { sentence: this.pushBoxes.repo.value() } } : {}),
        data: this.readDataRows(),
        containerImage: f('containerImage').value,
        packages: f('packages').value.split(/[\s,]+/).filter(Boolean),
        ports: this.readPortRows(),
        env: this.readEnvRows(),
        dataSources: this.readDataSources(),
        // Only asked for, and only sent, when a locked variable changes (the server says).
        ...(f('lockPassword').value ? { password: f('lockPassword').value } : {}),
      }
      try {
        const res = await saveCatalogueRepo(entry)
        f('lockPassword').value = ''
        this.onCatalogue(res.repos || [])
        closeForm()
        this.onToast(`${entry.name || 'Repo'} saved`)
      } catch (err) {
        // A locked variable changed: the password field opens, and Save sends it next time.
        if (/locked variable/i.test(err.message || '')) {
          form.querySelector('.lock-confirm').hidden = false
          f('lockPassword').focus()
        }
        say(err.message || 'Could not save that', 'err')
      }
    })
    form.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-cat]')
      if (!b) return
      if (b.dataset.cat === 'cancel') closeForm()
      else if (b.dataset.cat === 'scanports') {
        const sayPorts = (t) => (form.querySelector('.cat-ports-say').textContent = t)
        if (!this.editing) return sayPorts('Save the repo first — the scan reads its clone')
        b.disabled = true
        sayPorts('Scanning the repo…')
        try {
          const r = await detectRepoPorts(this.editing)
          if (!r.ok) sayPorts(r.error || 'Could not scan it')
          else if (!r.scanned) sayPorts('No clone yet — start a chat on it once, then scan, or type the ports')
          else if (!r.ports.length) sayPorts('Nothing obvious found — type the ports if you know them')
          else {
            // Fill only the empty rows, so a port the owner typed is not overwritten.
            const have = this.readPortRows()
            const merged = [...have]
            for (const p of r.ports) if (!merged.some((x) => x.port === p.port) && merged.length < 5) merged.push(p)
            this.fillPortRows(merged)
            sayPorts(`Found ${r.ports.length} — check them and Save`)
          }
        } catch (err) {
          sayPorts(err.message || 'Could not scan it')
        } finally {
          b.disabled = false
        }
      } else if (b.dataset.cat === 'addenv') this.paintEnvRows([...this.readEnvRows(), { name: '', value: '', secret: false, locked: false }])
      else if (b.dataset.cat === 'delenv') {
        const rows = this.readEnvRows()
        rows.splice(Number(b.dataset.index), 1)
        this.paintEnvRows(rows)
      } else if (b.dataset.cat === 'syncdata') {
        b.disabled = true
        b.textContent = 'Syncing…'
        try {
          const r = await syncDataset(this.editing, b.dataset.name)
          this.onToast(r.ok ? `${b.dataset.name}: ${r.summary}` : r.error, r.ok ? '' : 'err')
          this.paintDatasets(this.catalogue.find((x) => x.id === this.editing))
        } catch (err) {
          this.onToast(err.message || 'Could not sync it', 'err')
        } finally {
          b.disabled = false
        }
      } else if (b.dataset.cat === 'adddata') this.paintDataRows([...this.readDataRows(), { env: '', kind: 'sqlite-backup', from: '', to: '', envVar: '' }])
      else if (b.dataset.cat === 'deldata') {
        const rows = this.readDataRows()
        rows.splice(Number(b.dataset.index), 1)
        this.paintDataRows(rows)
      } else if (b.dataset.cat === 'test') {
        b.disabled = true
        say('Checking…')
        try {
          const res = await testRemote(f('url').value, f('auth').value)
          // Which way it was reached, so "reachable" is never read as "reachable with the
          // token" when it went over this machine's own access.
          const via = { github: 'the GitHub integration', machine: "this machine's own access", secret: 'the chosen key or token' }[res.via] || ''
          say(res.ok ? `Reachable${via ? ` through ${via}` : ''} — default branch ${res.defaultBranch || 'unknown'}` : res.error, res.ok ? 'on' : 'err')
        } catch (err) {
          say(err.message || 'Could not test that', 'err')
        } finally {
          b.disabled = false
        }
      } else if (b.dataset.cat === 'delete') {
        if (!this.editing) return
        try {
          const res = await deleteCatalogueRepo(this.editing)
          this.onCatalogue(res.repos || [])
          closeForm()
          this.onToast('Removed from the catalogue — mirrors and workspaces are left alone')
        } catch (err) {
          say(err.message || 'Could not remove that', 'err')
        }
      }
    })
  },

  // ── the catalogue form's secret and data fields ──────────────────────────────────────

  /**
   * The ways to reach a repo: the GitHub integration (the empty choice, and the default),
   * this machine's own ssh setup — named as not travelling, since it is the one choice that
   * stops working on another box — or a key or token from the store (integrations.mjs
   * `remoteFor`).
   */
  paintAuthChoices(current) {
    const sel = this.$('.cat-form select[name=auth]')
    sel.innerHTML =
      `<option value="">the GitHub integration</option>` +
      `<option value="@machine">this machine's own access (does not travel)</option>` +
      (this.secrets || []).map((s) => `<option value="${escape(s.name)}">${escape(s.name)} · ${s.kind}</option>`).join('')
    sel.value = current
    if (sel.value !== current) sel.value = ''
  },


  /**
   * The repo's Jenkins jobs: every job Jenkins lists, ticked if the repo names it. A repo that
   * names none yet has the jobs that build it ticked for it — read off which repo each job's
   * builds checked out — and nothing is kept until Save. A job the repo names that Jenkins no
   * longer lists stays, ticked and marked, so a Jenkins that cannot be reached right now never
   * costs the repo its list.
   */
  async paintJobs(repo) {
    const box = this.$('.cat-jobs')
    const say = this.$('.cat-jobs-say')
    const chosen = Array.isArray(repo?.jenkinsJobs)
    this.jobsChosen = chosen
    const saved = repo?.jenkinsJobs || []
    const draw = (jobs) => {
      const names = new Set(jobs.map((j) => j.name))
      // A job the repo names, either way, stays on the list when Jenkins no longer has it, so
      // a Save never drops it unseen.
      const kept = [...new Set([...saved, ...(repo?.jenkinsFailureChats || [])])].filter((n) => !names.has(n))
      const rows = [...jobs, ...kept.map((name) => ({ name, gone: true }))]
      box.innerHTML = rows
        .map((j) => {
          const on = chosen ? saved.includes(j.name) : Boolean(j.builds)
          // A job that builds this repo is readable by its chats either way; ticked, they may
          // start and stop it too (integrations-ci.md).
          const note = j.gone ? 'not in Jenkins' : j.builds ? (on ? 'builds this repo' : 'builds this repo · chats can read it, not start it') : j.kind === 'multibranch' ? `${j.branches.length} branches` : ''
          const watch = (repo?.jenkinsFailureChats || []).includes(j.name)
          return (
            `<div class="job-row"><label class="check"><input type="checkbox" name="jenkinsJobs" value="${escape(j.name)}"${on ? ' checked' : ''} /> ${escape(j.name)}${note ? ` <span class="tool-note">${escape(note)}</span>` : ''}</label>` +
            `<label class="check job-fail" title="When a build of it fails and no chat was waiting on it — a nightly run — start a chat on this repo to find out why"><input type="checkbox" name="jenkinsFailureChats" value="${escape(j.name)}"${watch ? ' checked' : ''} /> a failure starts a chat</label></div>`
          )
        })
        .join('')
    }
    draw([])
    const i = this.integrations || {}
    if (!(i.jenkins?.configured && i.jenkins?.url)) {
      say.textContent = saved.length ? 'Jenkins is not set up under Integrations, so these cannot be reached yet.' : 'Jenkins is not set up under Integrations.'
      return
    }
    say.textContent = 'Asking Jenkins…'
    // A repo opened after this one was asked for wins; this answer is dropped.
    const asked = (this.jobsAsked = (this.jobsAsked || 0) + 1)
    try {
      const res = await fetchJenkinsJobs(repo?.url || '')
      if (asked !== this.jobsAsked) return
      if (!res.ok) {
        say.textContent = `Jenkins did not answer: ${res.error}`
        return
      }
      draw(res.jobs)
      const suggested = res.jobs.filter((j) => j.builds).map((j) => j.name)
      say.textContent = chosen
        ? ''
        : suggested.length
          ? `Ticked: the jobs whose builds check this repo out. Kept when you Save.`
          : 'No job here builds this repo that Jenkins can tell. Tick any a chat here should use.'
    } catch (err) {
      if (asked === this.jobsAsked) say.textContent = err.message || 'Could not ask Jenkins'
    }
  },

  /**
   * The repo's hosts: a box for every host, ticked where the repo names it, each saying what
   * a chat could do there — so ticking one reads as granting exactly that. A host the repo
   * names that is gone stays, marked, so a Save never drops it unseen.
   */
  paintRepoHosts(names) {
    const envs = this.environments || []
    const known = new Set(envs.map((e) => e.name))
    const rows = [...envs, ...names.filter((n) => !known.has(n)).map((name) => ({ name, gone: true }))]
    const box = this.$('.cat-hosts')
    if (!rows.length) {
      box.innerHTML = `<span class="why">No hosts yet — add one under Integrations › Hosts.</span>`
      return
    }
    box.innerHTML = rows
      .map((e) => {
        const note = e.gone ? 'not a host any more' : e.actions?.length ? e.actions.map((a) => (a.kind === 'read' ? `read ${a.target}` : `run ${a.name}`)).join(', ') : 'allows nothing yet'
        return `<label class="check"><input type="checkbox" name="hosts" value="${escape(e.name)}"${names.includes(e.name) ? ' checked' : ''} /> ${escape(e.name)} <span class="tool-note">${escape(note)}</span></label>`
      })
      .join('')
  },

  /**
   * The repo's Environment, a row each: name, value, secret, locked, remove. A saved secret
   * shows its end in the placeholder and an empty box — typing replaces it, leaving it empty
   * keeps it; the value never comes back from the server (setup.md).
   */
  paintEnvRows(rows) {
    this.$('.var-rows').innerHTML = rows
      .map(
        (v, i) =>
          `<div class="var-row" data-index="${i}">` +
          `<input class="input mono" name="envName" placeholder="NAME" value="${escape(v.name || '')}" />` +
          (v.secret
            ? `<input class="input mono" name="envValue" type="password" autocomplete="off" placeholder="${v.hint ? `saved — ending ${escape(v.hint)}; type to replace` : v.name ? 'not set yet — left out of .env.local until it is' : 'the secret'}" />`
            : `<input class="input mono" name="envValue" placeholder="value" value="${escape(v.value || '')}" />`) +
          `<label class="check"><input type="checkbox" name="envSecret"${v.secret ? ' checked' : ''} /> secret</label>` +
          `<label class="check"><input type="checkbox" name="envLocked"${v.locked ? ' checked' : ''} /> locked</label>` +
          `<button class="btn icon sm ghost" type="button" data-cat="delenv" data-index="${i}" aria-label="Remove">${ICON.close}</button>` +
          `</div>`
      )
      .join('')
    // What each row was when drawn, so a secret left empty is "keep", not "clear".
    this.envDrawn = rows
  },

  /** Put a repo's declared ports into the five fixed rows, the rest left blank. */
  fillPortRows(ports) {
    const labels = this.el.querySelectorAll('.cat-ports input[name=portLabel]')
    const nums = this.el.querySelectorAll('.cat-ports input[name=portNum]')
    for (let i = 0; i < labels.length; i++) {
      labels[i].value = ports[i]?.label || ''
      nums[i].value = ports[i]?.port ? String(ports[i].port) : ''
    }
  },

  /** The non-empty port rows as `{ label, port }`; the server drops a duplicate or a bad number. */
  readPortRows() {
    const labels = this.el.querySelectorAll('.cat-ports input[name=portLabel]')
    const nums = this.el.querySelectorAll('.cat-ports input[name=portNum]')
    const out = []
    for (let i = 0; i < nums.length; i++) {
      const port = Number(String(nums[i].value).replace(/[^\d]/g, ''))
      if (port) out.push({ label: labels[i].value.trim(), port })
    }
    return out
  },

  readEnvRows() {
    return [...this.el.querySelectorAll('.var-rows .var-row')].map((row) => {
      const drawn = (this.envDrawn || [])[Number(row.dataset.index)] || {}
      const secret = row.querySelector('input[name=envSecret]').checked
      const value = row.querySelector('input[name=envValue]').value
      return {
        name: row.querySelector('input[name=envName]').value.trim(),
        secret,
        locked: row.querySelector('input[name=envLocked]').checked,
        // A secret's value is sent only when typed; a plain one always. `hint` keeps a saved
        // secret's end on the row if the list is redrawn before Save.
        ...(secret ? (value ? { value } : {}) : { value }),
        ...(drawn.hint ? { hint: drawn.hint } : {}),
      }
    })
  },

  /**
   * What the repo says it needs (its `.outpost/data.json`, read from the mirror) and where each
   * dataset comes from on this machine: a host and a path, a source each for a snapshot.
   */
  async paintDatasets(repo) {
    const box = this.$('.data-sets')
    const asked = (this.dataAsked = (this.dataAsked || 0) + 1)
    // Until the rows are drawn, Save keeps what is saved: a repo whose data.json could not be
    // read right now must not lose every source it had.
    this.dataSaved = repo?.dataSources || []
    this.dataDrawn = false
    if (!repo?.id) {
      box.innerHTML = `<span class="why">Save the repo first — its datasets are read from its main branch.</span>`
      return
    }
    box.innerHTML = `<span class="why">Reading the repo's data.json…</span>`
    let res
    try {
      res = await fetchDatasets(repo.id)
    } catch (err) {
      res = { ok: false, error: err.message }
    }
    if (asked !== this.dataAsked) return
    if (!res.ok) {
      box.innerHTML = `<span class="why">${escape(res.error || 'Could not read it')}</span>`
      return
    }
    if (!res.datasets.length) {
      box.innerHTML = `<span class="why">This repo declares no data. A project that needs some adds <code>.outpost/data.json</code>: a <code>datasets</code> list, each with a <code>name</code>, the <code>env</code> variable chats read it from, and <code>access</code> of read, write or snapshot.</span>`
      return
    }
    const hosts = (this.environments || []).map((e) => e.name)
    const opts = (cur) => `<option value="">choose a host</option>` + hosts.map((h) => `<option value="${escape(h)}"${h === cur ? ' selected' : ''}>${escape(h)}</option>`).join('')
    const sourceRow = (ds, source, label) => {
      const s = (res.sources || []).find((x) => x.dataset === ds.name && (x.source || '') === source) || {}
      return (
        `<div class="row data-source" data-dataset="${escape(ds.name)}" data-source="${escape(source)}">` +
        `${label ? `<span class="why">${escape(label)}</span>` : ''}` +
        `<label class="sub"><span>Host</span><select class="select" name="dsHost">${opts(s.host)}</select></label>` +
        `<label class="sub grow"><span>Path there</span><input class="input mono" name="dsPath" placeholder="/mnt/…" value="${escape(s.path || '')}" /></label></div>`
      )
    }
    box.innerHTML = res.datasets
      .map((ds) => {
        const st = res.state?.[ds.name] || {}
        const what = { read: 'chats read a shared copy', write: 'each chat writes its own, published back', snapshot: 'a scrubbed copy, on request' }[ds.access]
        const synced = st.at ? `synced ${new Date(st.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}${st.files ? ` · ${st.files} files` : ''}` : st.error ? '' : 'not synced yet'
        return (
          `<div class="dataset"><div class="head"><b>${escape(ds.name)}</b><span class="mono why">${escape(ds.env)}</span><span class="why">${what}</span></div>` +
          (ds.description ? `<span class="why">${escape(ds.description)}</span>` : '') +
          (ds.access === 'snapshot' ? ds.sources.map((src) => sourceRow(ds, src, src)).join('') : sourceRow(ds, '', '')) +
          (ds.access === 'read'
            ? `<div class="row"><span class="why">${escape(st.error ? `Last sync failed: ${st.error}` : synced)}</span><button class="btn sm ghost" type="button" data-cat="syncdata" data-name="${escape(ds.name)}">Sync now</button></div>`
            : '') +
          `</div>`
        )
      })
      .join('')
    this.dataDrawn = true
  },

  readDataSources() {
    if (!this.dataDrawn) return this.dataSaved || []
    return [...this.el.querySelectorAll('.data-sets .data-source')].map((row) => ({
      dataset: row.dataset.dataset,
      source: row.dataset.source || '',
      host: row.querySelector('select[name=dsHost]').value,
      path: row.querySelector('input[name=dsPath]').value.trim(),
    }))
  },

  readJobs() {
    return [...this.el.querySelectorAll('.cat-form input[name=jenkinsJobs]:checked')].map((b) => b.value)
  },

  paintDataRows(rows) {
    const envs = (this.environments || []).map((e) => `<option value="${escape(e.name)}">${escape(e.name)}</option>`).join('')
    this.$('.data-rows').innerHTML = rows
      .map(
        (d, i) =>
          `<div class="data-row row" data-index="${i}">` +
          `<select class="select" name="kind"><option value="sqlite-backup"${d.kind === 'sqlite-backup' ? ' selected' : ''}>database snapshot (SQLite)</option><option value="rsync"${d.kind === 'rsync' ? ' selected' : ''}>copy files</option><option value="command"${d.kind === 'command' ? ' selected' : ''}>run a command</option></select>` +
          `<select class="select" name="env"><option value="">this machine</option>${envs}</select>` +
          `<input class="input mono" name="from" placeholder="path on that machine, or the command" value="${escape(d.from || '')}" />` +
          `<input class="input mono" name="to" placeholder="where in the repo" value="${escape(d.to || '')}" />` +
          `<input class="input mono" name="envVar" placeholder="tell the app via VARIABLE" value="${escape(d.envVar || '')}" />` +
          `<button class="btn icon sm ghost" type="button" data-cat="deldata" data-index="${i}" aria-label="Remove">${ICON.close}</button>` +
          `</div>`
      )
      .join('')
    rows.forEach((d, i) => {
      const row = this.$(`.data-row[data-index="${i}"]`)
      if (row) row.querySelector('select[name=env]').value = d.env || ''
    })
  },

  readDataRows() {
    return [...this.el.querySelectorAll('.data-row')].map((row) => ({
      kind: row.querySelector('select[name=kind]').value,
      env: row.querySelector('select[name=env]').value,
      from: row.querySelector('input[name=from]').value.trim(),
      to: row.querySelector('input[name=to]').value.trim(),
      envVar: row.querySelector('input[name=envVar]').value.trim(),
    }))
  },
}
