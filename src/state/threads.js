/**
 * What the page knows about threads that the server does not say outright: which one word
 * describes a thread's state, and how the list is grouped and sorted.
 *
 * The status mapping is a strict precedence rather than a set of independent flags — errored,
 * then stalled, then running, then waiting — so a chat row can only ever be telling you one
 * thing, and the loudest true thing wins. The words are the hook store's own (hooks.md), so
 * the store, the server and the page keep agreeing on what they mean.
 */
import { handoffWaits } from './handoff.js'

/** Nothing for this long is dormant: a session that finished last Tuesday is not news. */
const STALE_MS = 3 * 24 * 60 * 60 * 1000

/** Whoever wants something first. `stalled` sits below `waiting`: stopped, but nothing to do about it here. */
export const STATUS_ORDER = ['blocked', 'waiting', 'stalled', 'working', 'celebrating', 'done', 'idle', 'sleeping']

export const STATUS_LABEL = {
  working: 'Working',
  waiting: 'Waiting on you',
  blocked: 'Blocked',
  stalled: 'Stalled',
  celebrating: 'Shipped',
  done: 'Done',
  idle: 'Idle',
  sleeping: 'Dormant',
}

/** Thread → one status word. First match wins. */
export function statusFor(thread, now = Date.now()) {
  if (thread.hasError) return 'blocked'
  // Above `running` and `unread` only because both are false whenever this is true — the hook
  // that set it ended the turn. It reads as precedence and costs nothing either way.
  if (thread.stalled) return 'stalled'
  if (thread.running) return 'working'
  if (thread.prState === 'MERGED') return 'celebrating'
  if (thread.unread) return 'waiting'
  // Dormancy is checked before `done` on purpose: leaving a permanent ✓ over a session that
  // finished days ago would bury the one that finished just now.
  if (now - thread.lastActivityAt > STALE_MS) return 'sleeping'
  if (thread.done) return 'done'
  return 'idle'
}

/** The two states that mean "a person is needed": the counter in the sidebar counts these. */
export const needsYou = (status) => status === 'waiting' || status === 'blocked'

/**
 * The routine run a thread is, `{ id, name, runId }`, or null. Only the object counts: a
 * desktop session's `routine` is a string, the CLI's own scheduled-task id (harnesses.md),
 * and is not one of Outpost's routines.
 */
export const runOf = (thread) => (thread.routine && typeof thread.routine === 'object' && thread.routine.id ? thread.routine : null)

/**
 * A routine's run that came back as a chat (routines.md): Outpost shows a run only when it
 * ended needing you, so its chat wants you until it is read — even once the session has
 * stopped and the hooks say `done`, which on any other chat is news, not a question. Opening
 * it (`markRead`, done to idle) is the answer that takes it out of Needs you. Once the person
 * has written in it (`answered`) it is a chat like any other: before that, every turn's end
 * put it back under Needs you, and nothing but archiving it cleared it.
 */
export const runNeedsYou = (thread, status) => {
  const run = runOf(thread)
  return Boolean(run) && (needsYou(status) || (status === 'done' && !run.answered))
}

/**
 * Whether a row belongs under Needs you: its session asks, it is a run that came back, or a
 * handoff the person asked for is ready to start fresh from (`handoffWaits`, state/handoff.js).
 */
export const wantsYou = (thread, status) => needsYou(status) || runNeedsYou(thread, status) || handoffWaits(thread)

/**
 * The routine a thread is a defining chat for (routines.md, *Defining chats*): `{ routineId,
 * name }`, both null while it defines nothing saved, or null for any other chat. Such a chat is
 * drawn under Routines and never under Chats.
 */
export const definesOf = (thread) => (thread?.defines && typeof thread.defines === 'object' ? thread.defines : null)

/**
 * What Chats draws from: every thread but a routine's defining chats. The list, its Needs you,
 * the header's count and the `N` key all read this; leaving one of them on the whole roster
 * counted a draft's question twice, once here and once on the Routines tab.
 */
export const chatThreads = (threads) => threads.filter((t) => !definesOf(t))

/** The composer's placeholder in a defining chat: a schedule sentence, so the first message reads as one. */
export const DEFINING_PLACEHOLDER = "Every weekday at 4:15 PM ET, check the open pull requests and tell me if anything looks stuck"

/**
 * The routine a defining chat has just saved, from the thread as the last roster had it and as
 * this one does: its `defines.routineId` went from null to an id. Else ''. A chat first seen
 * already linked has saved nothing in front of this page.
 */
export function savedFrom(was, thread) {
  const before = definesOf(was)
  const after = definesOf(thread)
  return before && !before.routineId && after?.routineId ? after.routineId : ''
}

/** A defining chat's header, from its `defines`: the routine it is making or changing, and what to say. */
export function definingWords(defines) {
  if (!defines) return null
  return {
    head: defines.routineId ? `Changing ${defines.name || 'a routine'}` : 'Defining a routine',
    hint: 'Say when it runs and what it should do; it will ask you to approve the routine.',
  }
}

/**
 * The states the list's bulk archive may pick: a chat at rest. Working, waiting, blocked and
 * stalled still want something, and a bulk archive is the easy way to end one by accident.
 */
export const restingStatus = (status) => status === 'idle' || status === 'done' || status === 'sleeping' || status === 'celebrating'

/** Per thread, the `lastActivityAt` it had the last time this page saw it not running. */
const settledAt = new Map()

/**
 * When a thread last reached a stopping point, which is what the list sorts on. A running
 * session bumps `lastActivityAt` on every tool call, so sorting on that had several working
 * chats trading the top spot after each step — hundreds of moves in a long task. A running
 * thread keeps the place it had when it started; it rises when its turn ends. One first seen
 * running (a new chat, or any after a reload) is placed by what it has then, and held there.
 */
export function orderAt(thread) {
  const at = thread.lastActivityAt || 0
  if (!thread.running || !settledAt.has(thread.id)) settledAt.set(thread.id, at)
  return settledAt.get(thread.id)
}

/** Not archived, most recently settled first. */
export function visibleThreads(threads) {
  return threads.filter((t) => !t.archived).sort((a, b) => orderAt(b) - orderAt(a))
}

/** Archived, the one that goes soonest first — the order a person scanning for a mistake wants. */
export function archivedThreads(threads) {
  const goes = (t) => t.workspace?.aging?.deleteAt || Infinity
  return threads.filter((t) => t.archived).sort((a, b) => goes(a) - goes(b))
}

/**
 * The list, in sections by when each thread last settled (`orderAt`), so a section agrees with
 * the order inside it. Recency alone, not status: a row's dot says what wants you, and
 * reordering the list under your thumb every time a hook fires is how you tap the wrong chat.
 * The one exception, Needs you, is lifted out before this (`liftNeedsYou`).
 */
export function groupByDay(threads, now = Date.now()) {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const today = start.getTime()
  const day = 24 * 60 * 60 * 1000
  const buckets = [
    { label: 'Today', from: today },
    { label: 'Yesterday', from: today - day },
    { label: 'This week', from: today - 6 * day },
    { label: 'Earlier', from: -Infinity },
  ]
  const out = buckets.map((b) => ({ label: b.label, threads: [] }))
  for (const t of threads) {
    const at = orderAt(t)
    const i = buckets.findIndex((b) => at >= b.from)
    out[i < 0 ? out.length - 1 : i].threads.push(t)
  }
  return out.filter((g) => g.threads.length)
}

/**
 * The list's one exception to recency (chats.md, 2026-10-14): every thread that needs you
 * (`wantsYou`) lifted into a section of its own above the rest, kept in the order it came in —
 * the list's, most recently settled first. Everything else stays where recency puts it. A row
 * moves here only when its session asks, which is rare; a Working group would move on every turn.
 */
export function liftNeedsYou(threads, now = Date.now()) {
  const needs = []
  const rest = []
  for (const t of threads) (wantsYou(t, statusFor(t, now)) ? needs : rest).push(t)
  return { needs, rest }
}

/** Case-insensitive match on the words a row shows: title, repo, branch, model, the routine a run came from. */
export function matchesFilter(thread, filter) {
  const q = String(filter || '').trim().toLowerCase()
  if (!q) return true
  const hay = [thread.title, thread.preview, thread.project, thread.gitBranch, thread.worktree, thread.model, runOf(thread)?.name]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return q.split(/\s+/).every((word) => hay.includes(word))
}
