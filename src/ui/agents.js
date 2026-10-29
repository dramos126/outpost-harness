/**
 * The agent map: the session on the left, every subagent it has dispatched on the right,
 * each with what it was asked to do, its model, how long it ran and how much context it is
 * carrying — and, a click deeper, the subagent's own conversation, read-only.
 *
 * A session that fans out is otherwise a spinner and a "Waiting on 3 subagents" line for
 * ten minutes. This is the view behind that line. It is read off disk — the CLI writes each
 * subagent to its own transcript beside the session's — so a finished session's map is as
 * complete as a running one's; only "still running" comes from the hooks (harnesses.md).
 */
import { fetchAgents, fetchAgentTranscript } from '../api.js'
import { renderMarkdown } from './markdown.js'
import { ICON } from './shell.js'
import { when } from './when.js'

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const tokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n || 0))

function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** The model as the CLI names it, shortened: "claude-opus-5-5" → "Opus 5.5". */
function modelName(id) {
  const m = /claude-([a-z]+)-(\d+)-(\d+)/.exec(String(id || ''))
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : String(id || '')
}

export class AgentMap {
  constructor(root) {
    this.open = false
    this.thread = null
    this.agents = []
    this.agent = null // the one whose conversation is showing, or null for the map
    this.offset = 0
    this.seen = new Set()
    this.timer = null
    this.el = document.createElement('div')
    this.el.className = 'modal agentmap'
    this.el.hidden = true
    this.el.innerHTML = `
      <div class="sheet" role="dialog" aria-labelledby="agentmap-title">
        <header class="row between">
          <div class="row">
            <button class="btn icon" data-act="back" aria-label="Back to the map" hidden>${ICON.back}</button>
            <div><h2 id="agentmap-title">Agent map</h2><div class="sub"></div></div>
          </div>
          <button class="btn icon" data-act="close" aria-label="Close">${ICON.close}</button>
        </header>
        <div class="body"></div>
      </div>`
    root.appendChild(this.el)
    this.body = this.el.querySelector('.body')
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) return this.hide()
      const b = e.target.closest('[data-act], [data-agent]')
      if (!b) return
      if (b.dataset.act === 'close') this.hide()
      else if (b.dataset.act === 'back') this.showMap()
      else if (b.dataset.agent) this.showAgent(b.dataset.agent)
    })
    document.addEventListener('keydown', (e) => {
      if (this.open && e.key === 'Escape') this.hide()
    })
  }

  async show(thread) {
    this.thread = thread
    this.open = true
    this.el.hidden = false
    this.agent = null
    this.agents = []
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

  /** The roster moved; keep "still running" honest without a fetch. */
  update(thread) {
    if (!this.open || !this.thread || thread.id !== this.thread.id) return
    this.thread = thread
    if (!this.agent) this.paintMap()
  }

  /** A running session's map changes by the second; a finished one's does not. */
  schedule() {
    clearTimeout(this.timer)
    if (!this.open) return
    this.timer = setTimeout(async () => {
      if (this.agent) await this.tail()
      else if (this.thread?.running) await this.refresh()
      this.schedule()
    }, 2500)
  }

  async refresh() {
    const t = this.thread
    try {
      const res = await fetchAgents(t)
      if (this.thread !== t || !this.open) return
      this.agents = res.agents || []
      if (!this.agent) this.paintMap()
    } catch (err) {
      this.body.innerHTML = `<div class="nothing">${escape(err.message || 'Could not read the agents')}</div>`
    }
  }

  running(id) {
    return Boolean(this.thread?.running) && (this.thread?.subagents || []).some((a) => a.id === id)
  }

  showMap() {
    this.agent = null
    this.el.querySelector('[data-act=back]').hidden = true
    this.paintMap()
  }

  paintMap() {
    const t = this.thread
    const n = this.agents.length
    this.el.querySelector('.sub').textContent = n ? `${n} agent${n === 1 ? '' : 's'} · click an agent for its conversation` : 'No subagents yet'
    const out = (this.agents.some((a) => this.running(a.id)) ? 1 : 0) && this.agents.filter((a) => this.running(a.id)).length
    this.body.innerHTML =
      `<div class="map">` +
      `<div class="parent card${t.running ? ' live' : ''}"><i class="dot"></i><div class="t">${escape(t.title || 'This chat')}</div><div class="s">${escape(
        [modelName(t.model), out ? `${out} out` : t.running ? 'working' : 'done'].filter(Boolean).join(' · ')
      )}</div></div>` +
      `<div class="agents">` +
      (n
        ? this.agents
            .map((a) => {
              const live = this.running(a.id)
              const end = live ? Date.now() : a.endedAt || a.startedAt
              const bits = [a.type, modelName(a.model), a.startedAt ? duration(end - a.startedAt) : '', a.tokens ? `${tokens(a.tokens)} tokens` : ''].filter(Boolean)
              return `<button class="agent card${live ? ' live' : ''}" data-agent="${escape(a.id)}"><i class="dot"></i><div class="t">${escape(a.description || a.id)}</div><div class="s">${escape(bits.join(' · '))}</div></button>`
            })
            .join('')
        : `<div class="nothing">This session has not dispatched a subagent.</div>`) +
      `</div></div>`
  }

  async showAgent(id) {
    const a = this.agents.find((x) => x.id === id)
    if (!a) return
    this.agent = a
    this.offset = 0
    this.seen.clear()
    this.el.querySelector('[data-act=back]').hidden = false
    this.el.querySelector('.sub').textContent = [a.description, modelName(a.model)].filter(Boolean).join(' · ')
    this.body.innerHTML = `<div class="alog"></div>`
    await this.tail()
  }

  async tail() {
    const a = this.agent
    const t = this.thread
    try {
      const res = await fetchAgentTranscript(t, a.id, this.offset)
      if (this.agent !== a || !this.open) return
      this.offset = res.offset || this.offset
      const log = this.body.querySelector('.alog')
      if (!log) return
      const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 48
      for (const it of res.messages || []) {
        if (it.kind === 'tool_result') {
          const row = log.querySelector(`[data-tool="${CSS.escape(it.id)}"]`)
          if (!row) continue
          row.classList.add('done')
          row.classList.toggle('error', it.isError)
          row.querySelector('.state').textContent = it.isError ? 'error' : 'done'
          const pre = row.querySelector('.result')
          pre.textContent = it.text
          pre.hidden = !it.text
          continue
        }
        if (this.seen.has(it.id)) continue
        this.seen.add(it.id)
        log.appendChild(it.kind === 'tool' ? this.toolRow(it) : this.bubble(it))
      }
      if (!log.children.length) log.innerHTML = `<div class="nothing">${res.missing ? 'No transcript for this agent yet.' : 'Nothing yet.'}</div>`
      if (stick) log.scrollTop = log.scrollHeight
    } catch (err) {
      this.body.innerHTML = `<div class="nothing">${escape(err.message || 'Could not read that agent')}</div>`
    }
  }

  bubble(it) {
    const el = document.createElement('div')
    el.className = `msg ${it.role}`
    el.innerHTML = `<div class="when">${escape(when(it.ts))}</div><div class="body"></div>`
    const body = el.querySelector('.body')
    // An image is named, not drawn: a subagent is handed words, and the one in the chat's own
    // log is the copy to look at.
    if (it.kind === 'image') body.textContent = '[image]'
    else if (it.kind === 'file') body.textContent = `[file: ${it.name}]`
    else if (it.role === 'assistant') body.innerHTML = renderMarkdown(it.text)
    else body.textContent = it.text
    return el
  }

  toolRow(it) {
    const el = document.createElement('details')
    el.className = 'tool'
    el.dataset.tool = it.id
    el.innerHTML = `
      <summary><span class="name"></span><span class="sum"></span><span class="state"></span></summary>
      <pre class="detail"></pre>
      <pre class="result" hidden></pre>`
    el.querySelector('.name').textContent = it.name
    el.querySelector('.sum').textContent = it.summary || ''
    el.querySelector('.detail').textContent = it.detail || ''
    return el
  }
}
