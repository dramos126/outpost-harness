/**
 * The commands map: every command the session sent to the background, on the left, and the one
 * picked on the right — its command, how long it ran, how it ended, its output and Stop. The
 * agent map's look without its tree, since a command has no parent or children to draw.
 *
 * Running ones are pinned on top, then the rest newest first, so what is still going is never
 * scrolled past. The list is read off the transcript (harnesses.md `readCommands`), so one that
 * ended stays with its exit code; only "still running" comes from the hooks (`backgroundTasks`).
 */
import { fetchCommands, fetchTaskOutput, stopBackgroundTask } from '../api.js'
import { ICON } from './shell.js'

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/**
 * How one ended, in a word. Past 128 an exit code is a signal's (128 + n): someone stopped it —
 * the timers that read "failed with exit code 144" had been stopped, not broken.
 */
function ending(c) {
  if (c.running) return 'running'
  if (c.status === 'killed' || c.status === 'stopped' || c.exitCode > 128) return 'stopped'
  if (c.status === 'completed' && !c.exitCode) return 'done'
  if (c.status) return 'failed'
  return 'ended'
}

export class CommandMap {
  constructor(root, { onToast } = {}) {
    this.onToast = onToast || (() => {})
    this.open = false
    this.thread = null
    this.commands = []
    this.picked = ''
    this.output = null // { id, text, missing } for the picked one
    this.stopping = new Set()
    this.timer = null
    this.el = document.createElement('div')
    this.el.className = 'modal agentmap cmdmap'
    this.el.hidden = true
    this.el.innerHTML = `
      <div class="sheet" role="dialog" aria-labelledby="cmdmap-title">
        <header class="row between">
          <div><h2 id="cmdmap-title">Commands</h2><div class="sub"></div></div>
          <button class="btn icon" data-act="close" aria-label="Close">${ICON.close}</button>
        </header>
        <div class="body"><div class="cmap"><div class="cmds"></div><div class="detail"></div></div></div>
      </div>`
    root.appendChild(this.el)
    this.listEl = this.el.querySelector('.cmds')
    this.detailEl = this.el.querySelector('.detail')
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) return this.hide()
      const b = e.target.closest('[data-act], [data-cmd], [data-stop]')
      if (!b) return
      if (b.dataset.act === 'close') this.hide()
      else if (b.dataset.stop) this.stop(b.dataset.stop)
      else if (b.dataset.cmd) this.pick(b.dataset.cmd)
    })
    document.addEventListener('keydown', (e) => {
      if (this.open && e.key === 'Escape') this.hide()
    })
  }

  async show(thread) {
    this.thread = thread
    this.open = true
    this.el.hidden = false
    this.commands = []
    this.picked = ''
    this.output = null
    this.listEl.innerHTML = `<div class="nothing">Reading…</div>`
    this.detailEl.innerHTML = ''
    await this.refresh()
    this.schedule()
  }

  hide() {
    this.open = false
    this.el.hidden = true
    clearTimeout(this.timer)
    this.timer = null
  }

  /** The ids the hooks say are still running; none on an asleep chat, whose session is gone. */
  live() {
    const t = this.thread
    const asleep = t?.structured && !t.canSend
    return new Set(!t || asleep || !Array.isArray(t.backgroundTasks) ? [] : t.backgroundTasks.map((c) => c.id))
  }

  /** The roster moved: one that stopped running needs its ending read, the rest only a repaint. */
  update(thread) {
    if (!this.open || !this.thread || thread.id !== this.thread.id) return
    const before = this.live()
    this.thread = thread
    const now = this.live()
    if ([...before].some((id) => !now.has(id)) || [...now].some((id) => !before.has(id))) this.refresh()
    else this.paint()
  }

  /** While anything runs the list and the picked one's output move; once all have ended they do not. */
  schedule() {
    clearTimeout(this.timer)
    if (!this.open) return
    this.timer = setTimeout(async () => {
      const busy = this.thread?.running || this.live().size > 0
      if (busy) await this.refresh()
      this.schedule()
    }, 2500)
  }

  async refresh() {
    const t = this.thread
    try {
      const res = await fetchCommands(t)
      if (this.thread !== t || !this.open) return
      this.commands = res.commands || []
      this.paint()
      await this.tail()
    } catch (err) {
      this.listEl.innerHTML = `<div class="nothing">${escape(err.message || 'Could not read the commands')}</div>`
    }
  }

  /**
   * The commands as shown: running first, then newest first. One the hooks list that the
   * transcript does not have yet is drawn from the hook's own entry.
   */
  rows() {
    const live = this.live()
    const rows = this.commands.map((c) => ({ ...c, running: live.has(c.id) }))
    for (const h of this.thread?.backgroundTasks || []) {
      if (live.has(h.id) && !rows.some((c) => c.id === h.id)) rows.push({ id: h.id, description: h.description || '', command: '', startedAt: h.since || 0, running: true })
    }
    return rows.sort((a, b) => Number(b.running) - Number(a.running) || (b.startedAt || 0) - (a.startedAt || 0))
  }

  paint() {
    const rows = this.rows()
    const live = rows.filter((c) => c.running).length
    this.el.querySelector('.sub').textContent = rows.length
      ? `${rows.length} command${rows.length === 1 ? '' : 's'}${live ? ` · ${live} running` : ''}`
      : 'No commands yet'
    if (!rows.some((c) => c.id === this.picked)) this.picked = rows[0]?.id || ''
    const now = Date.now()
    this.listEl.innerHTML = rows.length
      ? rows
          .map((c) => {
            const word = ending(c)
            const ran = c.startedAt ? duration((c.running ? now : c.endedAt || c.startedAt) - c.startedAt) : ''
            const bits = [word, ran].filter(Boolean).join(' · ')
            return `<button type="button" class="card ${word}${c.running ? ' live' : ''}${c.id === this.picked ? ' picked' : ''}" data-cmd="${escape(c.id)}"><i class="dot"></i><div class="t">${escape(c.description || c.command.split('\n')[0] || c.id)}</div><div class="s">${escape(bits)}</div></button>`
          })
          .join('')
      : `<div class="nothing">This session has not sent a command to the background.</div>`
    this.paintDetail()
  }

  paintDetail() {
    const c = this.rows().find((x) => x.id === this.picked)
    if (!c) {
      this.detailEl.innerHTML = ''
      return
    }
    const word = ending(c)
    const ran = c.startedAt ? duration((c.running ? Date.now() : c.endedAt || c.startedAt) - c.startedAt) : ''
    const meta = [word, ran, c.exitCode != null ? `exit ${c.exitCode}` : ''].filter(Boolean).join(' · ')
    const stopping = this.stopping.has(c.id)
    const out = this.output?.id === c.id ? this.output : null
    const pre = this.detailEl.querySelector('pre.out')
    // Keep the reader where they are unless they were already at the bottom.
    const stick = !pre || pre.scrollHeight - pre.scrollTop - pre.clientHeight < 48
    const top = pre?.scrollTop || 0
    this.detailEl.innerHTML =
      `<div class="row between"><div class="meta ${word}">${escape(meta)}</div>` +
      (c.running ? `<button type="button" class="btn ghost" data-stop="${escape(c.id)}"${stopping ? ' disabled' : ''}>${stopping ? 'Stopping…' : 'Stop'}</button>` : '') +
      `</div>` +
      (c.command ? `<div class="label">Command</div><pre class="cmd"></pre>` : '') +
      `<div class="label">Output${out?.truncated ? ' · the last 64 KB' : ''}</div><pre class="out"></pre>`
    if (c.command) this.detailEl.querySelector('pre.cmd').textContent = c.command
    const el = this.detailEl.querySelector('pre.out')
    el.textContent = !out ? 'Reading…' : out.missing ? 'The output went with the session’s container.' : out.text || 'No output yet.'
    el.scrollTop = stick ? el.scrollHeight : top
  }

  pick(id) {
    if (id === this.picked) return
    this.picked = id
    this.output = null
    this.paint()
    this.tail()
  }

  /** The picked one's output: read again while it runs, once after it has ended. */
  async tail() {
    const c = this.rows().find((x) => x.id === this.picked)
    if (!c?.outputFile) {
      if (c) {
        this.output = { id: c.id, text: '', missing: false }
        this.paintDetail()
      }
      return
    }
    if (this.output?.id === c.id && this.output.final) return
    const t = this.thread
    try {
      const res = await fetchTaskOutput(t, c.id, c.outputFile)
      if (this.thread !== t || !this.open || this.picked !== c.id) return
      this.output = { id: c.id, text: res.text || '', truncated: res.truncated, missing: res.missing, final: !c.running }
    } catch (err) {
      this.output = { id: c.id, text: err.message || 'Could not read its output', missing: false }
    }
    this.paintDetail()
  }

  /** Stop one. Its process gets a few seconds to exit before it is killed (launchers.md). */
  async stop(id) {
    const t = this.thread
    if (!t || this.stopping.has(id)) return
    this.stopping.add(id)
    this.paintDetail()
    try {
      await stopBackgroundTask(t, id)
      this.onToast('Command stopped', 'ok')
    } catch (err) {
      this.onToast(`Could not stop it: ${err.message}`, 'error')
    } finally {
      this.stopping.delete(id)
      if (this.open) await this.refresh()
    }
  }
}
