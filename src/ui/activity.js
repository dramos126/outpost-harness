/**
 * The Activity panel: every tool call a session made, out of the conversation and into a
 * column of its own, grouped under the time each run of calls began.
 *
 * A session's transcript is mostly tool traffic. Drawn inline, forty Bash rows bury the two
 * sentences the model actually said; drawn here, the chat reads as a chat and the work is one
 * tab away, still in order and still timed. The conversation panel owns the grouping — a
 * group is the run of calls between two things somebody said — and leaves a "N steps" marker
 * in the log where the run was, so a reader can get from a message to the work behind it.
 *
 * A row is flat: a dot (accent until its result arrives, grey after, red on a failure), the
 * tool, the summary; "done" is not written, being what nearly every row is.
 *
 * An Edit, Write or MultiEdit row carries the change itself as a diff, collapsed like every
 * other row: the input JSON of an edit is the diff with the structure in the way.
 */
import { renderMarkdown } from './markdown.js'
import { when } from './when.js'

/** How near the foot counts as "at the foot"; the conversation log's measure. */
const STICK_PX = 48

/**
 * A call's one-line summary: what its Activity row says and what the log's inline steps say
 * (conversation.js), from here alone so the two never read differently.
 */
export const callSummary = (it) => it.summary || ''

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export class ActivityPanel {
  constructor(el) {
    this.el = el
    this.el.innerHTML = `<div class="body"><div class="nothing">Nothing done yet.</div></div>`
    this.body = this.el.querySelector('.body')
    this.rows = new Map() // tool-use id -> row, for patching results in
    this.groups = new Map() // group id -> { el, n, ids }
    // tool-use id -> { id, name, summary, ts, end }: what the log's inline steps list (`steps`).
    this.calls = new Map()
    this.stuck = true
    this.visible = false
    this.body.addEventListener('scroll', () => this.atFoot(), { passive: true })
  }

  reset() {
    this.rows.clear()
    this.groups.clear()
    this.calls.clear()
    this.stuck = true
    this.body.innerHTML = `<div class="nothing">Nothing done yet.</div>`
  }

  /**
   * Whether the reader is at the foot, so a new call should pull the view down with it. Asked
   * before anything is added. A hidden panel has no height to measure and keeps the last
   * answer it had — calls arrive on the Workspace tab and with the column shut too.
   */
  atFoot() {
    const b = this.body
    if (b.clientHeight) this.stuck = b.scrollHeight - b.scrollTop - b.clientHeight < STICK_PX
    return this.stuck
  }

  toFoot() {
    this.body.scrollTop = this.body.scrollHeight
  }

  /**
   * Told on every paint whether the tab is up. A hidden panel cannot be scrolled, so the
   * following is caught up on the way in — and only on the way in, or a repaint would yank
   * the view off a row somebody had just opened at the foot.
   */
  shown(visible) {
    if (visible && !this.visible && this.stuck) this.toFoot()
    this.visible = visible
  }

  /** Whether a call's row is drawn. */
  has(id) {
    return this.rows.has(id)
  }

  /** The first group drawn: where a page of older calls goes in before (`add`'s `at`). */
  head() {
    return this.body.querySelector('.group')
  }

  /**
   * Draw a page of older calls above the rest without moving what the reader is looking at;
   * one following the foot stays there.
   */
  above(draw) {
    const b = this.body
    const height = b.scrollHeight
    const top = b.scrollTop
    draw()
    if (this.stuck) this.toFoot()
    else if (b.clientHeight) b.scrollTop = top + (b.scrollHeight - height)
  }

  /**
   * A tool call, into the group it belongs to; the group is made on its first call, at the
   * foot, or before the group `at` for a page read upwards.
   */
  add(it, groupId, at = null) {
    const stick = this.atFoot()
    let g = this.groups.get(groupId)
    if (!g) {
      this.body.querySelector('.nothing')?.remove()
      const el = document.createElement('section')
      el.className = 'group'
      el.dataset.group = groupId
      el.innerHTML = `<div class="g-head"><span class="g-when">${escape(when(it.ts))}</span><span class="g-n"></span></div>`
      this.body.insertBefore(el, at?.isConnected ? at : null)
      g = { el, n: 0, ids: [] }
      this.groups.set(groupId, g)
    }
    g.n += 1
    g.ids.push(it.id)
    this.calls.set(it.id, { id: it.id, name: it.name, summary: callSummary(it), ts: it.ts || 0, end: 0 })
    g.el.querySelector('.g-n').textContent = `${g.n} step${g.n === 1 ? '' : 's'}`
    g.el.appendChild(this.row(it))
    if (stick) this.toFoot()
  }

  row(it) {
    const el = document.createElement('details')
    el.className = 'tool'
    el.innerHTML = `
      <summary><span class="dot"></span><span class="name"></span><span class="sum"></span><span class="state"></span></summary>
      <pre class="detail"></pre>
      <pre class="result" hidden></pre>`
    el.querySelector('.name').textContent = it.name
    el.querySelector('.sum').textContent = callSummary(it)
    const detail = el.querySelector('.detail')
    if (it.diff) {
      detail.className = 'diff'
      detail.innerHTML =
        (it.diff.file ? `<span class="l file">${escape(it.diff.file)}</span>` : '') +
        it.diff.lines.map((l) => `<span class="l ${{ '+': 'add', '-': 'del', '@': 'gap' }[l[0]] || 'ctx'}">${escape(l)}</span>`).join('') +
        (it.diff.truncated ? `<span class="l gap">… (the rest is in the transcript)</span>` : '')
    } else {
      detail.textContent = it.detail || ''
    }
    this.rows.set(it.id, el)
    return el
  }

  /**
   * The result for a call drawn earlier; nothing to do if the call is not here. An agent's row
   * that already holds its report keeps it: read upwards, the "launched" result of its call
   * arrives after the completion. Answers the call's group id, '' when nothing was patched.
   */
  patch(it) {
    const row = this.rows.get(it.id)
    if (!row || row.classList.contains('finished')) return ''
    const call = this.calls.get(it.id)
    if (call && it.ts) call.end = it.ts
    const stick = this.atFoot()
    row.classList.toggle('error', it.isError)
    row.classList.add('done')
    // Done is what nearly every row is, so it is not said; only a failure is (the dot says the rest).
    row.querySelector('.state').textContent = it.isError ? 'error' : ''
    const pre = row.querySelector('.result')
    pre.textContent = it.text + (it.truncated ? '\n…' : '')
    pre.hidden = !it.text
    if (stick) this.toFoot()
    return row.closest('.group')?.dataset.group || ''
  }

  /**
   * A background agent's completion, against the Agent row that dispatched it: the row's
   * state becomes finished (or the status the CLI gave), and the agent's report replaces the
   * "launched" result, as Markdown — it is a written report, not tool output. If the row is
   * not here (the tail started after the call), a row of its own under a new group stands
   * in. Answers the group's id, for the marker the log draws.
   */
  finishAgent(it, at = null) {
    const stick = this.atFoot()
    let row = this.rows.get(it.toolUseId)
    if (!row) {
      this.add({ id: it.toolUseId || it.id, ts: it.ts, name: 'Agent', summary: it.summary, detail: '' }, it.id, at)
      row = this.rows.get(it.toolUseId || it.id)
    }
    const ok = it.status === 'completed'
    row.classList.add('done', 'finished')
    row.classList.toggle('error', !ok)
    row.querySelector('.state').textContent = ok ? '' : it.status
    const call = this.calls.get(it.toolUseId || it.id)
    if (call) {
      if (it.summary) call.summary = callSummary(it)
      if (it.ts) call.end = it.ts
    }
    if (it.summary) row.querySelector('.sum').textContent = callSummary(it)
    let out = row.querySelector('.result')
    if (out.tagName !== 'DIV') {
      const div = document.createElement('div')
      div.className = 'result md'
      out.replaceWith(div)
      out = div
    }
    out.innerHTML = renderMarkdown(it.text || '')
    out.hidden = !it.text
    if (stick) this.toFoot()
    return row.closest('.group')?.dataset.group || ''
  }

  /**
   * A group's calls for the log's inline steps, in order: `{ calls, start, end }`, `start` the
   * first call's time and `end` the latest result's (0 while none has one). Null for a group
   * not drawn here.
   */
  steps(groupId) {
    const g = this.groups.get(groupId)
    if (!g) return null
    const calls = g.ids.map((id) => this.calls.get(id)).filter(Boolean)
    const start = calls.find((c) => c.ts)?.ts || 0
    const end = calls.reduce((m, c) => Math.max(m, c.end || 0), 0)
    return { calls, start, end }
  }

  /**
   * The landing of a press in the log: a group scrolled into view and lit for a moment, or —
   * given a call's id, from a line of the inline steps — that call's row, opened to its input
   * and result.
   */
  reveal(groupId, id = '') {
    const row = id ? this.rows.get(id) : null
    const el = row || this.groups.get(groupId)?.el
    if (!el) return
    if (row) row.open = true
    el.scrollIntoView({ block: row ? 'center' : 'start', behavior: 'smooth' })
    el.classList.add('lit')
    setTimeout(() => el.classList.remove('lit'), 1400)
  }
}
