/**
 * Settings › Integrations › GitHub and Jenkins: each a section of its own, each taking its own
 * token.
 *
 * They were one block with one Save, GitHub's token and Jenkins's URL in rows one under the
 * other, and it was hard to see where one ended. And a token could only be chosen, from a
 * list of what Keys and tokens already held — so setting up GitHub meant going to another
 * page to make the token first. Now the token is pasted where it is used; the server keeps it
 * in the secret store under the integration's name, and the page is told only that there is
 * one and how it ends.
 */
import { fetchSecrets, finishClaudeSignIn, generateNotifyToken, saveClaudeAuth, saveIntegrations, startClaudeSignIn, testIntegration } from '../../api.js'

/**
 * How to make each token, in the section that takes it. A year-long token is made once and
 * forgotten; the day it expires is the day nobody remembers which permissions it had. So the
 * recipe lives where the token is pasted, not in a chat or a doc somebody has to find.
 */
const HOWTO = {
  claude: `
          <details class="howto">
            <summary>Which to use, and how to get it</summary>
            <ol>
              <li><b>Your subscription</b> (Pro or Max): <b>Sign in with Claude</b> above does it all — Outpost runs <code>claude setup-token</code> itself, you sign in through the link and paste back the code, and the token it makes (a year long) goes straight into the store. Or run <code>claude setup-token</code> yourself anywhere and paste the <code>sk-ant-oat…</code> token below. Chats spend your plan's limits, as they do now.</li>
              <li><b>An API key</b>: <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a> › <b>API keys</b> › <b>Create key</b>. It starts <code>sk-ant-api</code>. Chats are billed per token and the usage panel has no plan limits to show.</li>
              <li>Paste either below — which kind it is is read off the token — then Test, which asks Claude for one word with it.</li>
              <li>A chat already running keeps the sign-in it started with until it is restarted.</li>
            </ol>
          </details>`,
  github: `
          <details class="howto">
            <summary>How to make this token</summary>
            <ol>
              <li>On GitHub: your picture › <b>Settings</b> › <b>Developer settings</b> › <b>Personal access tokens</b> › <b>Fine-grained tokens</b> › <b>Generate new token</b>.</li>
              <li><b>Name</b> it (Outpost), and pick an <b>expiration</b>. When it expires, every GitHub tool here stops until a new one is pasted; Test shows the date.</li>
              <li><b>Resource owner</b>: you. <b>Repository access</b>: <b>All repositories</b>, so repos added to Outpost later are covered — or <b>Only select repositories</b>, and add each one as it joins.</li>
              <li><b>Repository permissions</b>, and nothing else:
                <table>
                  <tr><th>Permission</th><th>Access</th><th>What Outpost uses it for</th></tr>
                  <tr><td>Contents</td><td>Read and write</td><td>clone, fetch, push</td></tr>
                  <tr><td>Pull requests</td><td>Read and write</td><td>a branch's pull request, opening one</td></tr>
                  <tr><td>Commit statuses</td><td>Read-only</td><td>the checks beside a pull request</td></tr>
                  <tr><td>Metadata</td><td>Read-only</td><td>required; GitHub sets it</td></tr>
                  <tr><td>Workflows</td><td>Read and write</td><td>only if a repo has <code>.github/workflows</code> a chat will change</td></tr>
                </table>
              </li>
              <li><b>Generate token</b>, copy it — GitHub shows it once — and paste it below. Then Test.</li>
            </ol>
          </details>`,
  jenkins: `
          <details class="howto">
            <summary>How to make this token</summary>
            <ol>
              <li>Make a Jenkins user for Outpost — <b>Manage Jenkins</b> › <b>Users</b> › <b>Create User</b>, named <code>outpost</code> — so the builds it starts read “Started by user outpost” in the history.</li>
              <li>Give it permissions — not on the user's own page, but in <b>Manage Jenkins</b> › <b>Security</b> › <b>Authorization</b>, as <b>Matrix-based security</b> (the Matrix Authorization Strategy plugin, if it is not offered). Keep your own account on <b>Overall/Administer</b> before saving, or you lock yourself out. Add the user by its ID and tick <b>Overall/Read</b>, <b>Job/Read</b>, <b>Job/Build</b> and <b>Job/Cancel</b> — nothing else.</li>
              <li>Log in as <code>outpost</code>: its name (top right) › <b>Security</b> › <b>API Token</b> › <b>Add new Token</b>. Name it (Outpost), <b>Generate</b>, copy it — Jenkins shows it once — and paste it below with the user's name and your Jenkins address. Then Test.</li>
            </ol>
          </details>`,
}

/**
 * Jenkins's second half: the token it presents when it reports a build. Generated here, not
 * pasted — shown once with a Copy button and the steps to put it in Jenkins, the way GitHub
 * shows a token it has just made — and then only its last four characters, ever (setup.md).
 */
const NOTIFY = `
          <div class="int-sub notify">
            <h4>Build results</h4>
            <p class="why">Jenkins tells Outpost when a build finishes, so the chat whose work it was hears — woken on a failure, or answered while it waits. Jenkins proves it is Jenkins with a token of its own.</p>
            <div class="state notify-status" data-state="off"></div>
            <div class="row"><button class="btn" type="button" data-notify="generate">Generate a token</button><button class="btn ghost" type="button" data-notify="clear" hidden>Remove it</button></div>
            <div class="notify-once" hidden>
              <p class="why"><b>Copy it now — Outpost will not show it again.</b> If it is lost, generate a new one.</p>
              <div class="row"><code class="mono notify-value"></code><button class="btn sm" type="button" data-notify="copy">Copy</button></div>
              <ol class="notify-steps">
                <li>In Jenkins: <b>Manage Jenkins</b> › <b>Credentials</b> › <b>System</b> › <b>Global credentials (unrestricted)</b> › <b>Add Credentials</b>.</li>
                <li><b>Kind</b>: Secret text. <b>Scope</b>: Global. <b>Secret</b>: paste the token. <b>ID</b>: <code>OUTPOST_NOTIFY_TOKEN</code> — the Jenkinsfile looks it up by that name. <b>Description</b>: Outpost notify token. <b>Create</b>.</li>
                <li>If it replaces an earlier one: open that credential instead, <b>Update</b>, and paste the new secret — the old one stopped working the moment this was generated.</li>
                <li>Outpost's own Jenkinsfile already posts its results. For any other job, add the step below.</li>
              </ol>
              <button class="btn sm" type="button" data-notify="done">Done — I have copied it</button>
            </div>
            <details class="howto">
              <summary>The step a Jenkinsfile needs</summary>
              <p>At the end of the job — in its <code>finally</code> or <code>post { always }</code>, so it runs whether the build passed or not. Wrapped in a <code>try</code>, so Outpost being down never fails a build:</p>
<pre class="mono">try {
  withCredentials([string(credentialsId: 'OUTPOST_NOTIFY_TOKEN', variable: 'OUTPOST_NOTIFY')]) {
    writeFile file: 'outpost-result.json', text: groovy.json.JsonOutput.toJson([
      job: env.JOB_NAME, number: env.BUILD_NUMBER,
      result: currentBuild.currentResult, commit: env.GIT_COMMIT ?: '',
      url: env.BUILD_URL, failed: []  // names of the stages that failed, if you track them
    ])
    sh 'curl -fsS -m 10 --retry 5 --retry-connrefused --retry-delay 2 -H "Authorization: Bearer $OUTPOST_NOTIFY" -H "Content-Type: application/json" --data @outpost-result.json <span class="notify-url"></span>'
  }
} catch (e) { echo "Outpost was not told: \${e}" }</pre>
              <p>A job that does not post is still followed for the builds Outpost starts itself — it asks Jenkins until they finish — but a build a push triggered is heard of only this way.</p>
            </details>
          </div>`

/** `sub` heads the connection's half where a section has a second (Jenkins); `after` is that second half. */
const section = (which, title, lede, fields, { sub = '', after = '' } = {}) => `
        <section class="group${sub ? ' halves' : ''}" id="g-${which}">
          <h3>${title}</h3>
          <p class="lede">${lede}</p>
          <div class="int-sub">${sub ? `<h4>${sub}</h4>` : ''}${HOWTO[which] || ''}
          <div class="state int-status" data-state="off"></div>
          <form class="int-form" data-which="${which}">
            ${fields}
            <div class="row"><label class="sub grow"><span>Token</span><input class="input mono" name="token" type="password" autocomplete="off" spellcheck="false" /></label></div>
            <div class="row"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-int="test">Test</button><button class="btn ghost" type="button" data-int="clear" hidden>Remove the token</button></div>
            <div class="state int-say" data-state="off"></div>
          </form>
          </div>${after}
        </section>`

export const html =
  section(
    'claude',
    'Claude',
    'How chats sign in to Claude: your subscription, through a token made for Outpost, or an API key. With neither, they use this machine’s own <code>claude</code> login — which works, but stays behind if Outpost moves, and a chat in a container cannot use it.',
    // Sign in with Claude: Outpost runs `claude setup-token` itself and keeps the token it
    // prints; nobody copies a token out of a terminal (claude-auth.mjs).
    `<div class="claude-signin">
              <div class="row"><button class="btn primary" type="button" data-signin="start">Sign in with Claude</button></div>
              <div class="signin-step" hidden>
                <ol class="why">
                  <li><a class="signin-link" target="_blank" rel="noopener">Open this link</a> and sign in to your Claude account.</li>
                  <li>Claude shows a code. Copy it, paste it here, and Finish.</li>
                </ol>
                <div class="row"><label class="sub grow"><span>Code</span><input class="input mono" name="signinCode" autocomplete="off" autocapitalize="off" spellcheck="false" /></label><button class="btn primary" type="button" data-signin="finish">Finish</button><button class="btn ghost" type="button" data-signin="cancel">Cancel</button></div>
              </div>
              <div class="state signin-say" data-state="off"></div>
              <p class="why">Or paste a subscription token or an API key yourself:</p>
            </div>`
  ) +
  section(
    'github',
    'GitHub',
    'For a repo on GitHub: whether a branch has a pull request and how its checks went, and opening one when work is finished. One fine-grained token from GitHub, pasted here.',
    ''
  ) +
  section(
    'jenkins',
    'Jenkins',
    'A job’s builds for a chat to look at, starting a build where a repo allows it, and hearing when one finishes.',
    `<div class="row"><label class="sub grow"><span>Jenkins URL</span><input class="input mono" name="url" placeholder="https://jenkins.lan" /></label><label class="sub"><span>User</span><input class="input" name="user" placeholder="outpost" /></label></div>`,
    { sub: 'Connection', after: NOTIFY }
  )

export const methods = {
  /** Paint both sections from the server's view: `{ github, jenkins }`, each with `configured` and `hint`. */
  setIntegrations(i) {
    this.integrations = i
    for (const which of ['claude', 'github', 'jenkins']) {
      const g = this.$(`#g-${which}`)
      const it = i?.[which] || {}
      const status = g.querySelector('.int-status')
      status.dataset.state = it.configured ? 'on' : 'off'
      status.textContent =
        which === 'claude'
          ? it.configured
            ? `${it.kind === 'api' ? 'API key' : 'Subscription token'} saved — ending ${it.hint}. Chats sign in with it.`
            : it.named
              ? 'The settings name a token this machine does not have — paste it again. Until then chats use this machine’s own login.'
              : 'Nothing saved — chats use this machine’s own claude login'
          : it.configured
            ? `Token saved — ending ${it.hint}`
            : 'No token yet'
      const form = g.querySelector('.int-form')
      form.elements.token.value = ''
      form.elements.token.placeholder = it.configured
        ? 'Paste a new token to replace it'
        : { claude: 'Paste a subscription token (sk-ant-oat…) or an API key (sk-ant-api…)', github: 'Paste a GitHub token', jenkins: 'Paste a Jenkins API token' }[which]
      form.querySelector('[data-int=clear]').hidden = !it.configured
      if (which === 'jenkins') {
        form.elements.url.value = it.url || ''
        form.elements.user.value = it.user || ''
        const n = g.querySelector('.notify-status')
        n.dataset.state = it.notifyConfigured ? 'on' : 'off'
        n.textContent = it.notifyConfigured ? `Token made — ending ${it.notifyHint}` : 'No token yet — Jenkins cannot report builds'
        g.querySelector('[data-notify=generate]').textContent = it.notifyConfigured ? 'Generate a new one' : 'Generate a token'
        g.querySelector('[data-notify=clear]').hidden = !it.notifyConfigured
        // Where the Jenkinsfile posts: this page's own address, which is how Jenkins reaches it too.
        for (const el of g.querySelectorAll('.notify-url')) el.textContent = `${location.origin}/api/jenkins/notify`
      }
    }
  },

  _wireIntegrations() {
    for (const form of this.el.querySelectorAll('.int-form')) {
      const which = form.dataset.which
      const name = { claude: 'Claude', github: 'GitHub', jenkins: 'Jenkins' }[which]
      // Claude's sign-in is its own route: a pasted credential whose kind the server reads.
      const save = (body) => (which === 'claude' ? saveClaudeAuth(body) : saveIntegrations({ which, ...body }))
      const say = (text, kind = 'off') => {
        const el = form.querySelector('.int-say')
        el.dataset.state = kind
        el.textContent = text
      }
      // The store gained or lost a token; Keys and tokens lists it, so it is read again.
      const saved = (res) => {
        this.setIntegrations(res.integrations)
        fetchSecrets()
          .then((r) => this.setSecrets(r.secrets || []))
          .catch(() => {})
      }
      form.addEventListener('submit', async (e) => {
        e.preventDefault()
        const body = { token: form.elements.token.value }
        if (which === 'jenkins') Object.assign(body, { url: form.elements.url.value, user: form.elements.user.value })
        try {
          saved(await save(body))
          say(`${name} saved`, 'on')
        } catch (err) {
          say(err.message || 'Could not save that', 'err')
        }
      })
      // Enter in the sign-in's code box is Finish, not the form's Save of an empty token field.
      form.elements.signinCode?.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return
        e.preventDefault()
        form.querySelector('[data-signin=finish]').click()
      })
      form.addEventListener('click', async (e) => {
        const sb = e.target.closest('button[data-signin]')
        if (sb) return this._claudeSignIn(form, sb, say, saved)
        const b = e.target.closest('button[data-int]')
        if (!b) return
        if (b.dataset.int === 'clear') {
          try {
            saved(await save({ clear: true }))
            say('Token removed')
          } catch (err) {
            say(err.message || 'Could not remove it', 'err')
          }
          return
        }
        b.disabled = true
        say(`Testing ${name}…`)
        try {
          const r = await testIntegration(which)
          // The expiry is the one thing about a token nobody can see on GitHub's page without
          // going looking, and the thing that stops everything when it passes.
          const expires = r.expiresAt ? ` · token expires ${new Date(r.expiresAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}` : r.expires ? ` · token expires ${r.expires}` : ''
          const ok =
            which === 'claude'
              ? `Claude answered “${r.answer}”, signed in with ${r.via}`
              : which === 'github'
                ? `Connected — logged in as ${r.login}${expires}`
                : `Connected — ${r.jobs?.length} job${r.jobs?.length === 1 ? '' : 's'} visible`
          say(r.ok ? ok : which === 'claude' ? `${r.error} (signed in with ${r.via})` : r.error, r.ok ? 'on' : 'err')
        } catch (err) {
          say(err.message || 'That did not work', 'err')
        } finally {
          b.disabled = false
        }
      })
    }
    this._wireJenkinsNotify()
  },

  /**
   * Sign in with Claude: Start answers the link to sign in with, the code Claude then shows is
   * pasted back, and the server saves the token it gets — the page never holds it.
   */
  async _claudeSignIn(form, b, _formSay, saved) {
    const step = form.querySelector('.signin-step')
    // Said beside the button that was pressed: the form's own line is under the token field,
    // off the screen of a phone, and a sign-in that ended with no word was the first report.
    const out = form.querySelector('.signin-say')
    const say = (text, kind = 'off') => {
      out.dataset.state = kind
      out.textContent = text
    }
    const act = b.dataset.signin
    if (act === 'cancel') {
      step.hidden = true
      say('')
      return
    }
    b.disabled = true
    try {
      if (act === 'start') {
        say('Asking Claude for a sign-in link…')
        step.hidden = true
        const r = await startClaudeSignIn()
        if (!r.ok) return say(r.error || 'Could not start a sign-in', 'err')
        form.querySelector('.signin-link').href = r.url
        form.elements.signinCode.value = ''
        step.hidden = false
        say('')
      } else if (act === 'finish') {
        say('Finishing the sign-in — this can take a few seconds…')
        const r = await finishClaudeSignIn(form.elements.signinCode.value)
        if (!r.ok) {
          // The program ends on a refusal: the link is spent, so the step goes and Start is again the way.
          step.hidden = true
          this.onToast('Sign-in did not finish', 'err')
          return say(r.error || 'That did not work', 'err')
        }
        step.hidden = true
        saved(r)
        const c = r.integrations?.claude || {}
        this.onToast(`Signed in to Claude — token ending ${c.hint}`)
        say(`Signed in — subscription token saved, ending ${c.hint}. New chats sign in with it; press Test below to check it answers.`, 'on')
      }
    } catch (err) {
      say(err.message || 'That did not work', 'err')
    } finally {
      b.disabled = false
    }
  },

  /**
   * Jenkins's Build results: Generate, the token shown once with Copy and the steps for
   * Jenkins, Done to put it away, and Remove. A token already made is replaced only on a
   * second press, because the copy in Jenkins stops working the moment it is.
   */
  _wireJenkinsNotify() {
    const g = this.$('#g-jenkins .notify')
    const once = g.querySelector('.notify-once')
    const value = g.querySelector('.notify-value')
    const status = g.querySelector('.notify-status')
    const say = (text, kind = 'off') => {
      status.dataset.state = kind
      status.textContent = text
    }
    const putAway = () => {
      once.hidden = true
      value.textContent = ''
    }
    let armed = null
    g.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-notify]')
      if (!b) return
      const act = b.dataset.notify
      if (act === 'generate') {
        if (this.integrations?.jenkins?.notifyConfigured && armed !== b) {
          armed = b
          b.textContent = 'Replace it? Jenkins’s copy stops working'
          setTimeout(() => {
            if (armed !== b) return
            armed = null
            b.textContent = 'Generate a new one'
          }, 6000)
          return
        }
        armed = null
        b.disabled = true
        try {
          const res = await generateNotifyToken()
          this.setIntegrations(res.integrations)
          value.textContent = res.token
          once.hidden = false
          say(`Token made — ending ${res.integrations.jenkins.notifyHint}. Copy it below; it is not shown again.`, 'on')
        } catch (err) {
          say(err.message || 'Could not make a token', 'err')
        } finally {
          b.disabled = false
        }
      } else if (act === 'copy') {
        try {
          await copyText(value)
          b.textContent = 'Copied'
          setTimeout(() => (b.textContent = 'Copy'), 1500)
        } catch {
          say('Could not reach the clipboard — select the token and copy it', 'err')
        }
      } else if (act === 'done') {
        putAway()
      } else if (act === 'clear') {
        try {
          putAway()
          this.setIntegrations((await saveIntegrations({ which: 'jenkins', clearNotify: true })).integrations)
          say('Token removed — Jenkins can no longer report builds')
        } catch (err) {
          say(err.message || 'Could not remove it', 'err')
        }
      }
    })
  },
}

/**
 * Put an element's text on the clipboard: `navigator.clipboard` on a secure origin, and the old
 * select-and-copy on plain http over the LAN, where the page usually is (markdown.js does the
 * same for code blocks).
 */
export async function copyText(el) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(el.textContent)
  const range = document.createRange()
  range.selectNodeContents(el)
  const sel = window.getSelection()
  sel.removeAllRanges()
  sel.addRange(range)
  const ok = document.execCommand('copy')
  if (!ok) throw new Error('copy refused')
}
