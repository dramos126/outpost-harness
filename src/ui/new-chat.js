/**
 * The New chat dialog: what to do, which repos to check out, and how the session should run.
 *
 * A plain chat is the default — type and start, in an empty workspace. Ticking a repo adds a
 * checkout of it at its base branch's head; `start_work` makes the branch. There is no choice
 * of branch, tools or what the chat may do without asking: Outpost has one owner, so a chat
 * started here gets every tool and edits freely (the owner's, 2026-10-07).
 */
import { ICON } from './shell.js'

/** A coarse pointer and no hover: a phone or a tablet (as in conversation.js). */
const TOUCH = typeof matchMedia === 'function' && matchMedia('(pointer: coarse) and (hover: none)').matches

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/**
 * Every tool group a chat can be given (mcp/index.mjs TOOL_GROUPS). A group whose integration is
 * not set up is not offered to the session anyway (integrations.md, *Only tools that can work*),
 * and a Jenkins job the chat's repos do not name is still refused or asked about.
 */
const ALL_TOOLS = ['memory', 'catalogue', 'github', 'jenkins:read', 'jenkins:build']

/** The model a chat gets when none is chosen (catalogue.mjs DEFAULT_MODEL). */
const DEFAULT_MODEL = 'Opus'

/** Most picked first, then most recently, then the catalogue's own order. */
const byUse = (a, b) => (b.use?.chats || 0) - (a.use?.chats || 0) || (b.use?.at || 0) - (a.use?.at || 0)

export class NewChat {
  /**
   * `onStart(spec)` receives `{ repos: [{ id }], prompt, model, tools }` — a repo starts from its base branch; work makes the branch.
   * `getModels()` is the list of models a chat can start on.
   */
  constructor(root, { onStart, getModels }) {
    this.onStart = onStart
    this.getModels = getModels
    this.catalogue = []
    this.open = false
    this.el = document.createElement('div')
    this.el.className = 'modal'
    this.el.hidden = true
    this.el.innerHTML = `
      <div class="sheet" role="dialog" aria-labelledby="newchat-title">
        <header class="row between">
          <h2 id="newchat-title">New chat</h2>
          <button class="btn icon" data-act="close" aria-label="Close">${ICON.close}</button>
        </header>
        <div class="body">
          <label class="field">
            <span class="label">What do you want to do?</span>
            <textarea rows="3" autocomplete="off" placeholder="Optional — the first message, sent once the session is up"></textarea>
          </label>
          <section class="field">
            <div class="row between"><span class="label">Work on code</span><span class="why">optional — a chat with no code starts in seconds</span></div>
            <div class="repos"></div>
            <span class="why">Getting a repo ready takes a moment: the chat appears in the list while that happens.</span>
          </section>
        </div>
        <footer class="row between">
          <select class="select" name="model" aria-label="Model" title="Model"><option value="">${DEFAULT_MODEL} (default)</option></select>
          <span class="row"><button class="btn ghost" data-act="close">Cancel</button><button class="btn primary" data-act="start">Start chat</button></span>
        </footer>
      </div>`
    root.appendChild(this.el)
    this.$ = (sel) => this.el.querySelector(sel)
    this._wire()
  }

  _wire() {
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) return this.hide()
      const b = e.target.closest('button[data-act]')
      if (!b) return
      if (b.dataset.act === 'close') this.hide()
      else if (b.dataset.act === 'start') this.start()
    })
    window.addEventListener('keydown', (e) => {
      if (this.open && e.key === 'Escape') this.hide()
    })
  }

  setCatalogue(repos) {
    this.catalogue = repos
    this.paintRepos()
  }

  paintRepos() {
    const el = this.$('.repos')
    if (!this.catalogue.length) {
      el.innerHTML = `<div class="why">No repos in the catalogue yet — add one in Settings to check it out per chat.</div>`
      return
    }
    el.innerHTML = [...this.catalogue]
      .sort(byUse)
      .map(
        (r) =>
          `<div class="repo" data-id="${escape(r.id)}">` +
          `<label class="row" title="${escape(r.url)}"><input type="checkbox" /><b>${escape(r.name)}</b></label>` +
          `</div>`
      )
      .join('')
  }

  async show() {
    this.open = true
    this.el.hidden = false
    // On a phone the keyboard would cover the sheet before you have seen it; tap to type.
    if (!TOUCH) this.$('textarea').focus()
    const models = await this.getModels()
    const sel = this.$('select[name=model]')
    const current = sel.value
    // The default once, by name: the empty value is it, so its own entry is not listed again.
    sel.innerHTML =
      `<option value="">${DEFAULT_MODEL} (default)</option>` +
      models
        .filter((m) => !/^default\b/i.test(m.label || '') && m.label !== DEFAULT_MODEL)
        .map((m) => `<option value="${escape(m.label)}">${escape(m.label)}</option>`)
        .join('')
    sel.value = current
  }

  /**
   * Open with a first prompt written and repos ticked: a routine's Change…, or Make a routine
   * of this on a chat's Workspace. The person reads it and presses Start; nothing is sent unasked.
   */
  prefill({ prompt = '', repos = [] } = {}) {
    this.$('textarea').value = prompt
    const ids = new Set(repos.map((r) => r.id))
    for (const r of this.el.querySelectorAll('.repo')) r.querySelector('input[type=checkbox]').checked = ids.has(r.dataset.id)
    this.show()
  }

  hide() {
    this.open = false
    this.el.hidden = true
  }

  spec() {
    const repos = [...this.el.querySelectorAll('.repo')]
      .filter((r) => r.querySelector('input[type=checkbox]').checked)
      .map((r) => ({ id: r.dataset.id }))
    return {
      prompt: this.$('textarea').value.trim(),
      repos,
      model: this.$('select[name=model]').value,
      tools: ALL_TOOLS,
    }
  }

  start() {
    const spec = this.spec()
    this.hide()
    this.$('textarea').value = ''
    for (const box of this.el.querySelectorAll('.repo input[type=checkbox]')) box.checked = false
    this.onStart(spec)
  }

}
