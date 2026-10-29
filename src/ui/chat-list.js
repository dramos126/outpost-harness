/**
 * The chat list: one row per thread, in sections by day under the ones that need you, with a
 * status mark (marks.js) that says what it wants.
 *
 * Rebuilt whole on every change. The list is a few dozen rows of text and the roster arrives
 * a few times a minute at most, so diffing it would be more code than the paint it saves —
 * and a whole repaint is what keeps the selection, the filter and the sections honest without
 * three separate update paths.
 */
import { STATUS_LABEL, groupByDay, liftNeedsYou, matchesFilter, restingStatus, runOf, statusFor, wantsYou } from '../state/threads.js'
import { statusMark } from './marks.js'
import { handoffWaits } from '../state/handoff.js'
import { modelLabel } from './models.js'
import { ICON } from './shell.js'

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** "now", "4m", "2h", "Tue", "12 Sep" — the shortest thing that places a row in time. */
export function when(ts, now = Date.now()) {
  if (!ts) return ''
  const s = (now - ts) / 1000
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  const d = new Date(ts)
  if (s < 6 * 86400) return d.toLocaleDateString([], { weekday: 'short' })
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

export class ChatList {
  constructor(el, { onPick, onRestore, onToggle, onPin }) {
    this.el = el
    this.onPick = onPick
    this.onRestore = onRestore
    this.onToggle = onToggle
    this.onPin = onPin || (() => {})
    this.filter = ''
    /** The roster's routines by id: a run's chat quotes what its run said when it has no ask of its own. */
    this.routines = new Map()
    /** The bulk archive's picks while it is on, else null: a tap then picks a row instead of opening it. */
    this.picking = null
    this.el.addEventListener('click', (e) => {
      const restore = e.target.closest('[data-restore]')
      if (restore) return this.onRestore(restore.dataset.restore)
      // The pin sits inside the row's button, so it is caught first and the row is not opened.
      const pin = e.target.closest('[data-pin]')
      if (pin && !this.picking) {
        e.stopPropagation()
        // Turned here, on the element clicked, so its transition plays: the list is rebuilt
        // whole on every roster, and a rebuilt pin arrives already turned.
        const next = pin.dataset.pinned !== 'true'
        pin.classList.toggle('on', next)
        pin.dataset.pinned = String(next)
        return this.onPin(pin.dataset.pin, next)
      }
      const row = e.target.closest('[data-id], [data-ws]')
      if (!row) return
      if (this.picking) return row.dataset.id && !row.disabled && this.onToggle(row.dataset.id)
      if (row.dataset.ws) this.onPick(null, row.dataset.ws)
      else this.onPick(row.dataset.id)
    })
  }

  setFilter(text) {
    this.filter = text
  }

  setRoutines(routines = []) {
    this.routines = new Map(routines.map((r) => [r.id, r]))
  }

  /**
   * `workspaces` are the ones with no session yet, each a row of its own under "Starting".
   * `picking` is the bulk archive's set of picked ids while it is on: a chat at rest can be
   * picked and shows orange, anything else is dimmed and cannot be.
   */
  set(threads, selectedId, workspaces = [], picking = null) {
    this.picking = picking
    const now = Date.now()
    const shown = threads.filter((t) => matchesFilter(t, this.filter))
    // Needs you first, the one exception to recency (chats.md): a row moves only when its
    // session asks, and back when it is answered.
    const { needs, rest } = liftNeedsYou(shown, now)
    const groups = groupByDay(rest, now)
    const parts = []
    if (needs.length) {
      parts.push(`<div class="sec needs">Needs you · ${needs.length}</div>`)
      for (const t of needs) parts.push(this.row(t, selectedId, now))
    }
    // Workspaces with no session yet — preparing, or failed before one started — are rows
    // too: the chat exists from the moment it was asked for, and a failure has to be seen.
    if (workspaces.length) {
      parts.push(`<div class="sec">Starting</div>`)
      for (const w of workspaces) {
        const failed = w.status === 'failed'
        // Ready, but its conversation is not on the list yet — a session shows once it has
        // spoken. It said "Preparing…" with a spinner, read as stuck, and was deleted 17 s after
        // a healthy start (2026-10-04).
        const ready = w.status === 'ready'
        // One line, cut short like every row's second: a failure's whole text is in the hover.
        const step = failed ? `Failed: ${w.error || 'unknown error'}` : ready ? 'Ready — the session is starting up' : w.step || 'Preparing…'
        parts.push(
          `<button class="chat ws ${failed ? 'blocked' : 'working'}" data-ws="${escape(w.id)}" aria-pressed="${w.id === selectedId}"${picking ? ' disabled' : ''}>` +
            // The mark's spinner is the one spinner: a second at the row's end said "busy" twice.
            `${lead(statusMark(failed ? 'blocked' : 'working'), '')}<div class="text"><div class="t">${escape(w.name)}</div><div class="s"><span class="w" title="${escape(step)}">${escape(
              step
            )}</span></div></div></button>`
        )
      }
    }
    for (const g of groups) {
      parts.push(`<div class="sec">${escape(g.label)}</div>`)
      for (const t of g.threads) parts.push(this.row(t, selectedId, now))
    }
    if (!parts.length) {
      parts.push(
        `<div class="nothing">${
          this.filter ? 'No chats match that.' : threads.length ? '' : 'No sessions yet. Start one with New chat.'
        }</div>`
      )
    }
    this.el.innerHTML = parts.join('')
  }

  /**
   * The archived chats, in place of the live ones: what each was, when its workspace goes,
   * and the one way back. A row is not a button — an archived chat has no session to open,
   * so the only thing to press is Restore.
   */
  setArchived(threads) {
    const now = Date.now()
    const shown = threads.filter((t) => matchesFilter(t, this.filter))
    const parts = [`<div class="sec">Archived</div>`]
    for (const t of shown) {
      const a = t.workspace?.aging
      const fate = a?.kept ? 'kept' : a?.deleteAt ? `workspace deleted ${untilDays(a.deleteAt, now)}` : ''
      parts.push(
        `<div class="chat archived" title="${escape(t.preview || '')}">` +
          `<div class="text"><div class="t">${escape(t.title || 'Untitled')}</div><div class="s">${whereChips(t)}${fate ? `<span class="w">${escape(fate)}</span>` : ''}</div></div>` +
          `<button class="btn ghost" data-restore="${escape(t.id)}" title="Put this chat back on the list and resume its session">Restore</button>` +
          `</div>`
      )
    }
    if (!shown.length) parts.push(`<div class="nothing">${this.filter ? 'No archived chats match that.' : 'Nothing archived.'}</div>`)
    this.el.innerHTML = parts.join('')
  }

  row(t, selectedId, now) {
    const status = statusFor(t, now)
    const needs = wantsYou(t, status)
    // What a chat that needs you is asking, in its own words (`ask`, harnesses.md), on a line of
    // its own: enough to decide whether to open it. Without one the status words say it. A
    // routine's run that came back says its question as it ends (`routine_end`), not as an ask.
    const run = runOf(t)
    const ran = run ? this.routines.get(run.id)?.lastRun : null
    // A ready handoff the person asked for is the decision it waits on (`handoffWaits`).
    const quote = !needs ? '' : t.ask?.head || (ran?.outcome === 'needs-you' && ran.text) || (handoffWaits(t) ? 'Handoff ready — start fresh?' : '')
    // What it is doing, beside the time on the first line: a working thread names it; a thread
    // that wants you says so in words rather than only in the mark. Short, since it
    // shares the line with the title; the whole of it is in its hover.
    const what = statusWords(t, status, quote, now)
    const model = t.model ? `${t.modelAssumed ? '~' : ''}${modelLabel(t.model)}` : ''
    // Ageing out soon is an ⌛ on the time, the words in its hover: within its last day, or the
    // last third of the idle time when archiving is quicker than three days. A fixed three-day
    // window put one on every row a day old once archiving was set to three days. Kept and aged
    // out are standing states, and as an ⌛ they put one on nearly every older row, which said
    // nothing. They are in the row's hover instead.
    const a = t.workspace?.aging
    const DAY = 24 * 60 * 60 * 1000
    const soon = Math.min(DAY, ((a?.archiveDays || 3) * DAY) / 3)
    let age = ''
    let standing = ''
    if (a?.kept) standing = 'Kept — has unpushed work, so it is not aged out'
    else if (a?.aged) standing = 'Aged out'
    else if (a?.archiveAt && a.archiveAt - now <= soon) age = `idle ${a.idleDays}d · ages out ${untilDays(a.archiveAt, now)}`
    const right =
      (what.short ? `<span class="w" title="${escape(what.full)}">${escape(what.short)}</span><span class="sep">·</span>` : '') +
      (age ? `<span class="age" title="${escape(age)}">⌛</span>` : '') +
      `<span class="when">${escape(when(t.lastActivityAt, now))}</span>`
    const sub =
      // The routine a run came from, before where it ran: it is why the chat exists.
      (run?.name ? `<span class="chip r" title="A run of the routine ${escape(run.name)}">↻ ${escape(run.name)}</span>` : '') +
      whereChips(t) +
      this.pinMark(t)
    // Asleep: a session Outpost started whose unit has gone — aging ends quiet ones; the next
    // message wakes it (launchers.md). Said in the hover only: its mark is its status's, and a
    // "zz" over the slot was a second glyph to learn for something a message undoes.
    const asleep = t.structured && !t.canSend && !t.archived
    // The row's hover: what the chat was about, the model it runs on, which has no place on the
    // row, and whether it is asleep.
    const tip = [t.preview, model, standing, asleep && 'Asleep — its session has ended; your next message wakes it'].filter(Boolean).join('\n')
    // A merged PR's row keeps its own class, but its mark is what the turn says: a merge is not
    // a state that wants anything, so it shows the finished turn's check until opened, and nothing after.
    const markStatus = status === 'celebrating' ? (t.done ? 'done' : 'idle') : status
    // Picking for the bulk archive, the row says whether it is picked rather than whether it is open.
    // A pinned chat is never archived by hand, so it cannot be picked.
    const pick = this.picking ? (restingStatus(status) && !t.workspace?.pinned ?` data-pick="${this.picking.has(t.id)}"` : ' disabled') : ''
    const pressed = this.picking ? false : t.id === selectedId
    return (
      `<button class="chat ${status}${needs ? ' needs' : ''}" data-id="${escape(t.id)}" aria-pressed="${pressed}"${pick} title="${escape(tip)}">` +
      lead(statusMark(markStatus), this.bgMark(t)) +
      `<div class="text"><div class="l1"><span class="t">${escape(t.title || 'Untitled')}</span><span class="trail">${right}</span></div><div class="s">${sub}</div>${
        // A permission's head is a tool and its command (launchers.md), so it reads as code.
        // A routine run's quote comes with no ask at all: `t.ask.kind` there threw and drew no list.
        quote ? `<div class="q${t.ask?.kind === 'permission' ? ' perm' : ''}">“${escape(quote)}”</div>` : ''
      }</div>` +
      `</button>`
    )
  }

  /**
   * The shell slot's terminal, under the mark, while the session has commands running in the background (hooks.md
   * `backgroundTasks`): a chat at rest can still be holding cores, and this is where to look
   * when the machine is. Not on an asleep chat — its session, and what it ran, are gone.
   */
  bgMark(t) {
    const list = Array.isArray(t.backgroundTasks) ? t.backgroundTasks : []
    if (!list.length || (t.structured && !t.canSend)) return ''
    const n = list.length
    const tip = `${n} running in the background:\n${list.map((b) => `• ${b.description || b.id}`).join('\n')}`
    return `<span class="bg-mark" title="${escape(tip)}" aria-label="${n} background command${n === 1 ? '' : 's'}">${ICON.term}${n > 1 ? `<b>${n}</b>` : ''}</span>`
  }

  /**
   * The pin at the second line's end, under the time: a span, since the row is a button and cannot hold another. Always
   * drawn — an outline, filled on a pinned chat — so every row's pin is one tap away.
   */
  pinMark(t) {
    const ws = t.workspace?.id
    if (!ws || this.picking) return ''
    const on = Boolean(t.workspace.pinned)
    const tip = on ? 'Pinned — not archived or deleted until unpinned. Click to unpin.' : 'Pin — not archived or deleted until unpinned'
    return `<span class="pin${on ? ' on' : ''}" role="button" tabindex="-1" data-pin="${escape(ws)}" data-pinned="${on}" title="${tip}" aria-label="${on ? 'Unpin' : 'Pin'}">${ICON.pin}</span>`
  }
}

/**
 * The left column: the agent's mark over the shell's slot, 12 px each, on every row and empty
 * when nothing runs in the background — a terminal that came and went in the gutter would
 * otherwise be the one thing on the row with no place of its own.
 */
function lead(mark, shell) {
  return `<span class="lead">${mark}${shell || '<i class="bg-mark"></i>'}</span>`
}

/**
 * The first line's status words, `short` on the row and `full` in its hover; both '' when the
 * time says enough. A subagent's description and the subagent's type are the long halves, so
 * they go to the hover: the line is the title's too.
 */
export function statusWords(t, status, quote, now = Date.now()) {
  const say = (short, full = short) => ({ short, full })
  // No hook has ever reported it: `working` is a guess that outlives the turn by 30 minutes (hooks.md).
  if (status === 'working' && t.noHooks) return say('No hooks', 'No hooks · may have stopped')
  if (status === 'working' && t.activity) {
    const a = String(t.activity)
    const ran = /^Running ([^:]+):/.exec(a)
    if (ran) return say(`Running ${ran[1]}`, a)
    if (/^Waiting on the .+ subagent$/.test(a)) return say('Waiting on subagent', a)
    return say(a)
  }
  if (status === 'waiting' && !quote) return say('Waiting', STATUS_LABEL.waiting)
  if (status === 'blocked' && !quote) return say(t.failure?.label || 'Error')
  if (status === 'stalled') return say(t.retry?.nextAt ? `Stalled · restarts ${until(t.retry.nextAt, now).replace(/^in /, '')}` : 'Stalled')
  return say('')
}

/**
 * Where the chat lives: the first repo as a small mono chip, then "+N" for the rest, each repo
 * with its branch in the hover. One line, never a branch on the row — the row is two lines
 * high, and the branch chip and model wrapped it to three. A chat with no repo says nothing
 * here: the roster makes its `project` the chat's own name (`fullRoster`), not a place. A session with no
 * Outpost workspace has only `project` and `gitBranch` to go on. A repo unpushed half an hour
 * (`unpushed`, workspaces-git.md) is outlined, and "+N" is when any repo it hides is: a
 * reminder in the chip's own shape, never amber fill, which is Needs you's.
 */
function whereChips(t) {
  const repos = t.workspace
    ? (t.workspace.repos || []).map((r) => ({ id: r.id || r.name, branch: r.branch, unpushed: Boolean(r.unpushed) }))
    : t.project
      ? [{ id: t.project, branch: t.worktree ? `⑂ ${t.worktree}` : t.gitBranch }]
      : []
  if (!repos.length) return ''
  const tip = repos.map((r) => `${r.id} @ ${r.branch || 'no branch yet'}`).join('\n')
  const more = repos.slice(1).some((r) => r.unpushed)
  return (
    `<span class="where" title="${escape(tip)}"><span class="chip${repos[0].unpushed ? ' unpushed' : ''}">${escape(repos[0].id)}</span>` +
    (repos.length > 1 ? `<span class="chip more${more ? ' unpushed' : ''}">+${repos.length - 1}</span>` : '') +
    `</span>`
  )
}

/** "today", "tomorrow", "in 3d" — aging is measured in days. */
function untilDays(ts, now = Date.now()) {
  const d = Math.ceil((ts - now) / 86400000)
  if (d <= 0) return 'today'
  if (d === 1) return 'tomorrow'
  return `in ${d}d`
}

/** "in 42m", "in 2h 10m" — a wait measured in tens of minutes, so seconds are noise. */
export function until(ts, now = Date.now()) {
  const mins = Math.max(0, Math.round((ts - now) / 60000))
  if (mins < 1) return 'any moment'
  if (mins < 60) return `in ${mins}m`
  return `in ${Math.floor(mins / 60)}h ${mins % 60}m`
}
