/**
 * The Routines tab's list (routines.md *In the sidebar, beside chats*): one row per routine,
 * shaped like a chat's — a mark for its last run, its name, and a second line of its trigger in
 * words, the last outcome and its next run — in sections (`groupRoutines`): the drafts, chats
 * defining a routine not saved yet, first; the ones whose run is waiting on you under Needs you,
 * the question quoted; then Active, Paused and One-offs done.
 *
 * Rebuilt whole on every roster, as the chat list is (ui.md): a handful of rows.
 */
import { STATUS_LABEL, statusFor, wantsYou } from '../state/threads.js'
import { when } from './chat-list.js'
import { statusMark } from './marks.js'

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** A run's ending in the list's words. */
export const OUTCOME_WORDS = { running: 'running', nothing: 'nothing to do', done: 'done', 'needs-you': 'needs you', failed: 'failed' }

/**
 * A row's word for its last run. A `needs-you` run whose chat no longer wants you (`waits`
 * false: opened, answered, archived or gone) needed you: the run's record never changes, and
 * "needs you" on a routine whose chat was dealt with read as a question still open.
 */
const lastRunWords = (outcome, waits) => (outcome === 'needs-you' && !waits ? 'needed you' : OUTCOME_WORDS[outcome] || outcome)

/**
 * The dot for a routine's last run, in the chat list's own status classes so the colours are
 * the same words: grey nothing (or never run), green done, amber needs you, red failed, the
 * accent while running. Amber only while the run's chat still wants you (`waits`, the row is
 * under Needs you); after that it is a run that ended, as a done one is.
 */
export function dotClass(r, waits = false) {
  if (r.running || r.lastRun?.outcome === 'running') return 'working'
  if (r.lastRun?.outcome === 'needs-you') return waits ? 'waiting' : 'done'
  return { done: 'done', failed: 'blocked' }[r.lastRun?.outcome] || ''
}

/**
 * A routine row's mark slot (marks.js). `dotClass`'s word, but a run that finished fine earns
 * none: a check means something new to read, and a done run is hidden, never a chat to open, so
 * every healthy routine wore one for good. A paused routine with nothing else to say keeps its
 * hollow ring (`m-ring`), in the slot so its title lines up with the rest.
 */
export function routineMark(r, waits = false) {
  const status = dotClass(r, waits)
  if (status && status !== 'done') return statusMark(status)
  return r.enabled === false ? '<i class="mark idle m-ring"><i class="dot"></i></i>' : statusMark('')
}

/** "next 11:00 PM", "next tomorrow", "next Thu", "next 12 Oct" — the shortest that places it. */
export function nextWords(ms, now = Date.now()) {
  if (!ms) return ''
  const d = new Date(ms)
  const day = (t) => new Date(t).setHours(0, 0, 0, 0)
  const days = Math.round((day(ms) - day(now)) / 86400000)
  if (days <= 0) return `next ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
  if (days === 1) return 'next tomorrow'
  if (days < 7) return `next ${d.toLocaleDateString([], { weekday: 'short' })}`
  return `next ${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}`
}

/** Case-insensitive match on a routine's name and its trigger in words. */
const matches = (r, filter) => {
  const q = String(filter || '').trim().toLowerCase()
  if (!q) return true
  const hay = `${r.name || ''} ${r.when || ''}`.toLowerCase()
  return q.split(/\s+/).every((w) => hay.includes(w))
}

/**
 * A draft's one status word (routines.md *Defining chats*): its chat's, as any chat's is worked
 * out (`statusFor`), once its session is up (`thread`, the roster's thread for `threadId`);
 * before that `working` while it starts, and `blocked` when its workspace failed.
 */
export function draftStatus(draft, now = Date.now()) {
  if (draft.status === 'failed') return 'blocked'
  if (!draft.thread) return 'working'
  return statusFor(draft.thread, now)
}

/** Whether a draft's chat wants you, as a chat under Chats' Needs you would: it counts toward the Routines tab's badge. */
export const draftWaiting = (draft, now = Date.now()) => Boolean(draft.thread) && wantsYou(draft.thread, draftStatus(draft, now))

/**
 * The list's sections, in order (ui.md *Routines list*): Drafts — the defining chats not saved
 * yet (`drafts`, the roster's, each with its `thread` when the session is up) — then Needs you,
 * a routine whose run came back as a chat that still wants you (`waiting`), then Active,
 * Paused, and One-offs done, a routine whose every trigger is a one-shot that has fired (the
 * server's `finished`). Finished is read before paused: a one-off that ran is done whether or
 * not it was paused after. A server from before `finished` leaves such a routine under Active
 * or Paused. Empty sections are left out. Each is `{ key, label, routines }`, a draft section's
 * rows being drafts.
 */
export function groupRoutines(routines, waiting = new Map(), drafts = []) {
  const groups = [
    { key: 'drafts', label: 'Drafts', routines: [...drafts] },
    { key: 'needs', label: 'Needs you', routines: [] },
    { key: 'active', label: 'Active', routines: [] },
    { key: 'paused', label: 'Paused', routines: [] },
    { key: 'finished', label: 'One-offs done', routines: [] },
  ]
  const by = Object.fromEntries(groups.map((g) => [g.key, g]))
  for (const r of routines) {
    const key = waiting.has(r.id) ? 'needs' : r.finished === true ? 'finished' : r.enabled === false ? 'paused' : 'active'
    by[key].routines.push(r)
  }
  return groups.filter((g) => g.routines.length)
}

export class RoutineList {
  /**
   * `onPick(id, runId)`: a routine's page, with `runId` chosen on it when the row is a run waiting
   * on you. `onDraft(workspaceId)`: a draft's chat.
   */
  constructor(el, { onPick, onDraft }) {
    this.el = el
    this.onPick = onPick
    this.onDraft = onDraft
    this.filter = ''
    this.el.addEventListener('click', (e) => {
      const draft = e.target.closest('[data-draft]')
      if (draft) return this.onDraft(draft.dataset.draft)
      const row = e.target.closest('[data-routine]')
      if (row) this.onPick(row.dataset.routine, row.dataset.run || '')
    })
  }

  setFilter(text) {
    this.filter = text
  }

  /**
   * `routines` are the roster's (`roster.routines`); `waiting` maps a routine's id to the chat
   * its run became that is still waiting on you (main.js, `runNeedsYou`), whose question leads
   * its row. `selected` is what the main pane shows: `{ routine }`, the routine whose page or
   * defining chat is open, or `{ draft }`, the workspace of the draft whose chat is. `drafts` are
   * the roster's, each with its `thread` (main.js).
   */
  set(routines, waiting, selected = {}, drafts = []) {
    const now = Date.now()
    const shown = routines.filter((r) => matches(r, this.filter))
    const shownDrafts = drafts.filter((d) => matches({ name: d.title }, this.filter))
    const parts = []
    for (const g of groupRoutines(shown, waiting, shownDrafts)) {
      const needs = g.key === 'needs'
      parts.push(`<div class="sec${needs ? ' needs' : ''}">${escape(g.label)}${needs ? ` · ${g.routines.length}` : ''}</div>`)
      if (g.key === 'drafts') for (const d of g.routines) parts.push(this.draftRow(d, selected.draft, now))
      else for (const r of g.routines) parts.push(this.row(r, needs ? waiting.get(r.id) : null, selected.routine, now))
    }
    if (!parts.length) {
      parts.push(
        `<div class="nothing">${this.filter ? 'No routines match that.' : 'No routines yet. New routine starts a chat that makes one: work that runs itself, and is a chat only when it needs you.'}</div>`
      )
    }
    this.el.innerHTML = parts.join('')
  }

  /**
   * A routine still being defined: its chat's title, its status in the chat list's words and
   * mark, and when it wants you the question quoted, as a Needs-you row's is.
   */
  draftRow(d, selectedWs, now) {
    const status = draftStatus(d, now)
    const waits = draftWaiting(d, now)
    const ask = waits ? d.thread?.ask || d.ask : null
    const word =
      d.status === 'failed' ? `Failed: ${d.error || 'unknown error'}` : !d.thread ? 'Starting…' : waits && ask?.head ? '' : STATUS_LABEL[status] || status
    const sub = ['Draft', word].filter(Boolean)
    const cls = ['chat', 'routine', 'draft', status, waits ? 'needs' : ''].filter(Boolean).join(' ')
    return (
      `<button class="${cls}" data-draft="${escape(d.workspaceId)}" aria-pressed="${d.workspaceId === selectedWs}">` +
      statusMark(status) +
      `<div class="text"><div class="t">${escape(d.title || 'New routine')}</div><div class="s">${sub.map((s) => `<span>${escape(s)}</span>`).join('<span class="sep">·</span>')}</div>${
        ask?.head ? `<div class="q${ask.kind === 'permission' ? ' perm' : ''}">“${escape(ask.head)}”</div>` : ''
      }</div>` +
      `<span class="stamp"><span class="when">${escape(when(d.thread?.lastActivityAt || d.lastActivityAt, now))}</span></span>` +
      `</button>`
    )
  }

  row(r, thread, selectedId, now) {
    const last = r.lastRun
    const outcome = r.running ? 'running' : last?.outcome || ''
    const paused = r.enabled === false
    const sub = [
      r.when,
      outcome ? lastRunWords(outcome, Boolean(thread)) : 'never run',
      paused ? 'paused' : nextWords(r.next?.[0], now),
    ].filter(Boolean)
    // The question, in the run's words: the chat's own ask when it has one, else what the run
    // said as it ended.
    const quote = thread ? thread.ask?.head || (last?.outcome === 'needs-you' ? last.text : '') || '' : ''
    const cls = ['chat', 'routine', dotClass(r, Boolean(thread)), thread ? 'needs' : '', paused ? 'paused' : ''].filter(Boolean).join(' ')
    return (
      `<button class="${cls}" data-routine="${escape(r.id)}"${thread?.routine?.runId ? ` data-run="${escape(thread.routine.runId)}"` : ''} aria-pressed="${r.id === selectedId}">` +
      routineMark(r, Boolean(thread)) +
      `<div class="text"><div class="t">${escape(r.name || 'Untitled routine')}</div><div class="s">${sub.map((s) => `<span>${escape(s)}</span>`).join('<span class="sep">·</span>')}</div>${
        quote ? `<div class="q">“${escape(quote)}”</div>` : ''
      }</div>` +
      `<span class="stamp"><span class="when">${escape(r.running ? 'now' : when(last?.at, now))}</span></span>` +
      `</button>`
    )
  }
}
