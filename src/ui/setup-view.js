/**
 * A chat's setup, as a window of its own — what the setup pill beside the agents count opens,
 * the way that count opens the agent map (the owner's, 2026-10-04: the pill first opened the
 * details column, which read as nothing happening). Each repo: how its setup went, how long
 * it took, its error, Try again on a failure, and its log, kept fresh while any is running.
 * The Workspace section no longer carries any of it (ui-details.md).
 */
import { fetchSetup, retrySetup } from '../api.js'
import { ICON } from './shell.js'

const POLL_MS = 2000

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const WORD = { pending: 'waiting its turn', running: 'running', done: 'finished', failed: 'failed' }

export class SetupView {
  constructor(root, { onToast } = {}) {
    this.onToast = onToast || (() => {})
    this.open = false
    this.ws = null
    this.repos = []
    this.timer = null
    this.el = document.createElement('div')
    this.el.className = 'modal setupview'
    this.el.hidden = true
    this.el.innerHTML = `
      <div class="sheet" role="dialog" aria-labelledby="setupview-title">
        <header class="row between">
          <div><h2 id="setupview-title">Setup</h2><div class="sub"></div></div>
          <button class="btn icon" data-act="close" aria-label="Close">${ICON.close}</button>
        </header>
        <div class="body"></div>
      </div>`
    root.appendChild(this.el)
    this.body = this.el.querySelector('.body')
    this.el.addEventListener('click', async (e) => {
      if (e.target === this.el) return this.hide()
      const b = e.target.closest('[data-act]')
      if (!b) return
      if (b.dataset.act === 'close') this.hide()
      else if (b.dataset.act === 'retry') {
        b.disabled = true
        try {
          await retrySetup(this.ws.id, b.dataset.repo)
          await this.refresh()
          this.schedule()
        } catch (err) {
          this.onToast(err.message || 'Could not start it again', 'err')
          b.disabled = false
        }
      }
    })
    document.addEventListener('keydown', (e) => {
      if (this.open && e.key === 'Escape') this.hide()
    })
  }

  /** Open on a chat's workspace. */
  async show(ws) {
    if (!ws) return
    this.ws = ws
    this.open = true
    this.el.hidden = false
    this.el.querySelector('.sub').textContent = ws.name
    this.body.innerHTML = `<div class="nothing">Reading…</div>`
    await this.refresh()
    this.schedule()
  }

  hide() {
    this.open = false
    this.el.hidden = true
    clearTimeout(this.timer)
    this.timer = null
  }

  /** Fresh while anything is running; still once everything has finished. */
  schedule() {
    clearTimeout(this.timer)
    if (!this.open || !this.repos.some((r) => r.state === 'running' || r.state === 'pending')) return
    this.timer = setTimeout(async () => {
      await this.refresh()
      this.schedule()
    }, POLL_MS)
  }

  async refresh() {
    const id = this.ws?.id
    if (!id) return
    try {
      const res = await fetchSetup(id)
      if (!this.open || this.ws?.id !== id) return
      this.repos = res.repos || []
      this.paint()
    } catch (err) {
      this.body.innerHTML = `<div class="nothing">${escape(err.message || 'Could not read the setup')}</div>`
    }
  }

  paint() {
    // Logs at the bottom already stay at the bottom as lines come in; one scrolled up to read
    // stays where it was.
    const stick = new Map([...this.body.querySelectorAll('pre.log')].map((p) => [p.dataset.repo, p.scrollTop + p.clientHeight >= p.scrollHeight - 8]))
    if (!this.repos.length) {
      this.body.innerHTML = `<div class="nothing">Nothing in this chat has setup to run.</div>`
      return
    }
    // Each repo's mark is `.sym`, not `.mark`: that is the page's logo, and a finished repo's ✓
    // drew as it in the first cut (the owner's screenshot, 2026-10-04).
    this.body.innerHTML = this.repos
      .map((r) => {
        const mark = r.state === 'done' ? '✓' : r.state === 'failed' ? '✗' : '<span class="spin"></span>'
        const took = r.endedAt && r.startedAt ? ` · ${Math.max(1, Math.round((r.endedAt - r.startedAt) / 1000))} s` : ''
        return (
          `<section class="setup-repo" data-state="${escape(r.state)}">` +
          `<div class="row head"><span class="sym">${mark}</span><b>${escape(r.name)}</b><span class="why">${escape(WORD[r.state] || r.state)}${took}</span>` +
          (r.state === 'failed' ? `<button class="btn sm" data-act="retry" data-repo="${escape(r.id)}">Try again</button>` : '') +
          `</div>` +
          (r.error ? `<div class="why bad">${escape(r.error)}</div>` : '') +
          `<pre class="log" data-repo="${escape(r.id)}">${escape(r.log || '(nothing yet)')}</pre>` +
          `</section>`
        )
      })
      .join('')
    for (const p of this.body.querySelectorAll('pre.log')) if (stick.get(p.dataset.repo) !== false) p.scrollTop = p.scrollHeight
  }
}
