/**
 * The handoff: what a chat's session has done, what is next, which files matter and what is
 * still open, written down while its prompt cache is warm, kept by Outpost, and offered as the
 * first prompt of a fresh conversation in the same workspace (handoff.md).
 *
 * Why it exists is arithmetic (usage.md): most of what a long chat costs is it re-reading its
 * own context on every request, and a message after an idle hour rewrites all of it at full
 * price. A chat that can be set down and picked up again from a page of notes does not have to
 * be carried at 400k tokens, nor woken cold. Asking the session costs one warm request of its
 * context — a cache read, a tenth of the price — which is why it is asked while warm and only
 * when something is at stake.
 *
 * This module asks, captures and keeps. When it asks is its triggers' business, each named in
 * handoff.md; nothing here adds a word to a session's standing prompt.
 */
import { randomBytes } from 'node:crypto'
import { hookEvents } from '../state/hooks.mjs'
import { readTokens, readTranscript, scanAll, sessionIdOf } from '../scan.mjs'
import { activeLauncher } from '../launchers/index.mjs'
import { recordForSession } from '../launchers/structured.mjs'
import { markWorkspace, workspaceFor } from '../workspaces/index.mjs'
import { carryName } from '../titles.mjs'
import * as store from './store.ts'
import { awayVerdict, idleVerdict, isStale, nearLimit, offerable, parseHandoff, unshipped } from './rules.ts'
import { readUsage } from '../usage.ts'
import { writeFallback } from './fallback.ts'
import { notify } from '../notify/index.mjs'
import type { Handoff, Limits } from './rules.ts'

/** How the request's note opens in the log; what the token accounting counts handoff turns by. */
export const HANDOFF_LEAD = 'Handoff asked for'

/** A request with no answer after this long is dropped: the turn died some way no hook said. */
const PENDING_MS = 30 * 60_000
/** How often the loop looks at what is due. Its work is minutes away, never seconds. */
const TICK_MS = 60_000
/** One tick at a time: a slow roster must not let two judge the same due timer. */
let ticking = false
/** The answer's last record can land a moment after the `Stop` hook; capture looks again this often, this many times. */
const CAPTURE_RETRY_MS = 2000
const CAPTURE_TRIES = 4

/**
 * What a session is sent to write its handoff. Only ever sent when a trigger fires, never put in
 * the standing prompt (architecture.md, *A feature pays for its tokens*); ~1.2 KB, ~300 tokens,
 * held to a budget by check-token-budget. The note draws as a pill in the log and the reminder is
 * hidden (harnesses.md), so the page shows that Outpost asked, not the words it asked with.
 *
 * It never pushes, and says so in as many words: on this machine a push lands on main and
 * deploys Outpost under every chat. A work-in-progress commit is what keeps the work safe; the
 * push is the person's, later.
 *
 * `git add <new files>` is spelled out: a commit by pathspec alone fails on a file git has
 * never seen, and the first live handoff spent a call finding that out.
 */
export function handoffRequest(nonce: string, why = ''): string {
  return [
    `<outpost-note tone="info">${HANDOFF_LEAD}</outpost-note>`,
    `<system-reminder>Outpost sent this, not the person${why ? ` — ${why}` : ''}. This conversation is about to be set aside; write the handoff a fresh session in this workspace will start from.`,
    `1. Commit your work on the current branch — work in progress is fine — naming the files you changed (git add <new files>, then git commit -m "…" -- <paths>). If no work was started in a checkout you changed, call start_work first. Skip this if nothing changed or there is no checkout. Do NOT push: no push tool, no git push, no pull request — a push lands on main and deploys.`,
    `2. End your answer with the handoff, between a line "### Handoff · ${nonce}" and a line "### End of handoff · ${nonce}". In it: the goal; what is done, with commits; what is next, in order; the files that matter, with paths; decisions made and why; open questions for the person, including any you were about to ask. Under 600 words: it is all the next session will know.`,
    `Do nothing else this turn.</system-reminder>`,
  ].join('\n')
}

/**
 * The first message of a conversation started fresh from a handoff. The handoff rides in an
 * `<outpost-handoff>` block, which the reader draws under a "Fresh start from handoff" divider
 * rather than as the person's words (harnesses.md); the instructions are a reminder, hidden.
 * It asks for a short answer and a wait, not for the work: the person pressed the button and is
 * there, and a fresh session that runs off on a page of notes is a turn nobody asked for.
 */
export function freshPrompt(text: string): string {
  return [
    `<system-reminder>Outpost sent this, not the person: this chat's earlier conversation was set aside and this one started from the handoff it left, below — the same workspace and branch, uncommitted changes as they were. Read the files it names before changing anything, and do not redo what it says is done. Answer in a few lines: where things stand and what is next. Then wait for the person.</system-reminder>`,
    `<outpost-handoff>`,
    text,
    `</outpost-handoff>`,
  ].join('\n')
}

let rosterFn: (() => Promise<any>) | null = null

/** Handed the roster once by `api.mjs`, as aging and the routine runner are. */
export function configureHandoffs({ roster }: { roster: () => Promise<any> }) {
  rosterFn = roster
}

/** The roster's thread for a session id, or null. */
async function rosterThread(sessionId: string): Promise<any> {
  if (!rosterFn || !sessionId) return null
  const { threads } = await rosterFn()
  return threads.find((t: any) => sessionIdOf(t.harness, t.ref) === sessionId) || null
}

/** The scanned thread for a session id — cheaper than the roster, enough to read its transcript. */
async function scannedThread(sessionId: string): Promise<any> {
  const { threads } = await scanAll()
  return threads.find((t: any) => sessionIdOf(t.harness, t.ref) === sessionId) || null
}

const workspaceOfSession = async (sessionId: string): Promise<string> => ((await recordForSession(sessionId)) as any)?.workspaceId || ''

/**
 * Ask the session behind `thread` (a roster thread) to write its handoff. Refused, with the
 * reason, when the session cannot be typed to, is working or waiting on the person — a request
 * then would queue behind the turn or deny the question standing — or has a request out already.
 */
export async function askSession(thread: any, trigger: string, why = ''): Promise<{ ok: boolean; error?: string; asked?: boolean }> {
  const ws = thread?.workspace?.id
  if (!ws) return { ok: false, error: 'This chat has no workspace to keep a handoff in' }
  if (!thread.canSend) return { ok: false, error: 'Its session is not running' }
  if (thread.failure) return { ok: false, error: `Its last turn stopped on ${thread.failure.label}; it cannot answer until that clears` }
  const launcher = await activeLauncher()
  const quiet = await launcher.isQuiet(thread)
  if (!quiet.quiet) return { ok: false, error: quiet.reason || quiet.error || 'It is busy' }
  const rec = await store.chat(ws)
  const sid = sessionIdOf(thread.harness, thread.ref)
  if (rec.pending && rec.pending.sessionId === sid && Date.now() - rec.pending.at < PENDING_MS) return { ok: false, error: 'A handoff has been asked for already; it is being written' }
  const nonce = randomBytes(3).toString('hex')
  const sent = await launcher.sendPrompt(thread, handoffRequest(nonce, why))
  if (!sent.ok) return { ok: false, error: sent.error || 'Could not ask the session' }
  await store.update(ws, (r) => {
    r.pending = { sessionId: sid, at: Date.now(), nonce, trigger, context: Number(thread.context) || 0 }
    r.lastError = ''
    // Asked: whatever was owed on the turn's end has been done.
    r.away = null
    r.idle = null
  })
  return { ok: true, asked: true }
}

/**
 * Chats whose handoff is being written without the session right now, by workspace id: when it
 * began and what asked, which the block in the log shows while it runs.
 */
const writing = new Map<string, { at: number; trigger: string; why: string; abort: AbortController }>()

/**
 * Hand off (the conversation's button, `POST /api/handoff`): ask the session when that is a
 * warm request, and write the handoff without it otherwise — a cold cache, a turn stopped by a
 * limit or a failure, or no session running — where asking would rewrite the whole context at
 * full price or cannot be done (fallback.ts). A current handoff is not made again: the session
 * has not worked since, so a second would say the same.
 *
 * `without` is the person's choice, from the Hand off popover, to have it written without the
 * session where it could have been asked. Never the other way: a session the rules would not
 * ask is never asked (handoff.md, *A cold, stopped or dead session is never asked*).
 */
export async function handOff(thread: any, trigger = 'button', { without: chosen = false } = {}): Promise<{ ok: boolean; error?: string; asked?: boolean; writing?: boolean }> {
  const ws = thread?.workspace?.id
  if (!ws) return { ok: false, error: 'This chat has no workspace to keep a handoff in' }
  const rec = await store.peek(ws)
  if (offerable(rec?.current) && !isStale(rec.current, thread.contextAt || 0)) return { ok: false, error: 'A current handoff is kept — the session has not worked since. Start fresh from it.' }
  const cold = Boolean(thread.contextAt && Date.now() - thread.contextAt > CACHE_TTL_MS)
  const without = !thread.canSend ? 'its session is not running' : thread.failure ? `its last turn stopped on ${thread.failure.label}` : cold ? 'its cache has gone cold' : chosen ? 'you chose a summary over asking it' : ''
  if (!without) return askSession(thread, trigger)
  return writeWithout(thread, trigger, without)
}

/**
 * The block's Cancel (`POST /api/handoff/cancel`): a handoff being written without the session
 * is stopped; a request out to the session is forgotten, with no error, and `interrupt: true`
 * tells the endpoint to stop the turn writing it — work committed so far stays committed. The
 * interrupted turn's hook then finds no request to drop and says nothing.
 */
export async function cancelHandoff(thread: any): Promise<{ ok: boolean; error?: string; interrupt?: boolean }> {
  const ws = thread?.workspace?.id
  if (!ws) return { ok: false, error: 'This chat has no workspace to keep a handoff in' }
  const w = writing.get(ws)
  if (w) {
    w.abort.abort()
    return { ok: true }
  }
  const rec = await store.peek(ws)
  if (!rec?.pending || rec.pending.sessionId !== sessionIdOf(thread.harness, thread.ref)) return { ok: false, error: 'No handoff is being written' }
  await store.update(ws, (r) => {
    r.pending = null
    r.lastError = ''
  })
  return { ok: true, interrupt: true }
}

/** The fallback, in the background: the block shows it being written, then ready or why not. */
async function writeWithout(thread: any, trigger: string, why = ''): Promise<{ ok: boolean; error?: string; writing?: boolean }> {
  const ws = thread.workspace.id
  if (writing.has(ws)) return { ok: false, error: 'A handoff is being written already' }
  const abort = new AbortController()
  writing.set(ws, { at: Date.now(), trigger, why, abort })
  await store.update(ws, (r) => {
    r.lastError = ''
  })
  ;(async () => {
    try {
      const text = await writeFallback(thread, abort.signal)
      // Cancelled as it finished: the person was told it stopped, so nothing is kept or told.
      if (abort.signal.aborted) throw new Error('cancelled')
      await store.update(ws, (r) => {
        r.current = { text, at: Date.now(), how: 'fallback', context: Number(thread.context) || 0, sessionId: sessionIdOf(thread.harness, thread.ref), trigger }
        r.lastError = ''
      })
      await tellReady(sessionIdOf(thread.harness, thread.ref), trigger, 'fallback')
    } catch (err) {
      // Cancelled is not a failure: the block goes, with nothing to explain.
      await store.update(ws, (r) => {
        r.lastError = abort.signal.aborted ? '' : `No handoff written: ${(err as Error)?.message || err}`
      })
    } finally {
      // The push loop's next scan carries it: the handoff's `at` and `error` are in its signature.
      writing.delete(ws)
    }
  })()
  return { ok: true, writing: true }
}

/**
 * The session answered: find its handoff in what it said after the request, and keep it. The
 * answer is read through the harness, as the page reads it, from the transcript's tail.
 */
async function capture(ws: string, sessionId: string) {
  const rec = await store.peek(ws)
  const p = rec?.pending
  if (!p || p.sessionId !== sessionId) return
  let text = ''
  let lastAt = 0
  for (let i = 0; i < CAPTURE_TRIES && !text; i++) {
    if (i) await new Promise((r) => setTimeout(r, CAPTURE_RETRY_MS))
    const t = await scannedThread(sessionId).catch(() => null)
    if (!t) continue
    const read: any = await readTranscript(t.harness, t.ref, { after: 0 }).catch(() => null)
    if (!read?.ok) continue
    // Every assistant text since the request, as one answer: a long one is written as several
    // records, and the markers can land in different ones.
    const said = (read.messages || []).filter((m: any) => m.kind === 'text' && m.role === 'assistant' && (m.ts || 0) >= p.at - 5000)
    text = parseHandoff(said.map((m: any) => m.text).join('\n\n'), p.nonce)
    lastAt = Math.max(0, ...said.map((m: any) => m.ts || 0))
  }
  await store.update(ws, (r) => {
    if (r.pending?.nonce !== p.nonce) return
    r.pending = null
    if (!text) {
      r.lastError = 'The session answered without writing a handoff'
      return
    }
    // Stamped no earlier than the answer's own records, so the turn that wrote it cannot read as
    // work done after it (`isStale`) whatever the clocks say.
    r.current = { text, at: Math.max(Date.now(), lastAt), how: 'session', context: p.context, sessionId, trigger: p.trigger }
    r.lastError = ''
  })
  if (text) await tellReady(sessionId, p.trigger, 'session')
}

/**
 * A handoff made while the person was away — `/away`, the idle timer, the plan near its limit —
 * is told on Discord, where they are: the chat list's check is the sign for one they are there
 * for. One asked from the button is not told; Needs you has it (chats.md).
 */
async function tellReady(sessionId: string, trigger: string, how: string) {
  if (!trigger || trigger === 'button') return
  const thread = await rosterThread(sessionId).catch(() => null)
  await notify({ event: 'handoff-ready', thread, trigger, how })
}

/**
 * The person set a ready handoff aside (`POST /api/handoff/dismiss`): it stays offered, in its
 * block, but no longer lifts the chat into Needs you.
 */
export async function dismissHandoff(thread: any): Promise<{ ok: boolean; error?: string }> {
  const ws = thread?.workspace?.id
  const rec = ws ? await store.peek(ws) : null
  if (!rec || !offerable(rec.current)) return { ok: false, error: 'No handoff is kept for this chat' }
  await store.update(ws, (r) => {
    if (r.current) r.current.dismissedAt = Date.now()
  })
  return { ok: true }
}

/** The last status each session was heard at, so a `done` repeated by a later bookkeeping event is not a second turn's end. */
const lastStatus = new Map<string, string>()
/**
 * Sessions `lastStatus` holds at most, oldest-heard out first: the hook store's own cap
 * (hooks.md), so this cannot outgrow the store it shadows. Unbounded, every session id ever
 * posted to `/api/hook` stayed in it until a restart.
 */
const LAST_STATUS_CAP = 2000

function hearStatus(sessionId: string, status: string): string | undefined {
  const was = lastStatus.get(sessionId)
  // Re-inserted, so the Map's order is last-heard and the first key is the one quiet longest.
  lastStatus.delete(sessionId)
  // An ended session's next event is a `SessionStart`, never a `done`, so nothing is lost by
  // forgetting it now.
  if (status !== 'ended') lastStatus.set(sessionId, status)
  while (lastStatus.size > LAST_STATUS_CAP) lastStatus.delete(lastStatus.keys().next().value as string)
  return was
}

/**
 * A hook landed. A turn ending is a status moving *to* `done` (hooks.md: `Stop`, or the
 * `SubagentStop` a deferred one waited for); a status repeated by a later event is the same
 * turn's end heard again. A request whose turn was interrupted or died is dropped with the reason.
 */
async function onHook({ sessionId, status }: { sessionId: string; status: string }) {
  const was = hearStatus(sessionId, status)
  if (status === was) return
  const ws = await workspaceOfSession(sessionId)
  if (!ws) return
  if (status === 'done') return turnEnded(ws, sessionId, was === undefined)
  const rec = await store.peek(ws)
  if (rec?.pending?.sessionId !== sessionId) return
  if (status === 'idle' || status === 'stalled' || status === 'error' || status === 'ended') {
    const why = status === 'idle' ? 'The handoff turn was interrupted' : status === 'ended' ? 'The session ended before it wrote a handoff' : 'The handoff turn failed'
    await store.update(ws, (r) => {
      r.pending = null
      r.lastError = why
    })
  }
}

/**
 * A turn ended. The handoff turn's own end is a capture and nothing else — it arms no trigger,
 * so a handoff can never ask for another. Any other turn's end is when what was promised on it
 * is kept: a chat marked away is asked now.
 */
async function turnEnded(ws: string, sessionId: string, firstHeard = false) {
  const rec = await store.peek(ws)
  if (rec?.pending?.sessionId === sessionId) return capture(ws, sessionId)
  if (rec?.away) {
    await store.update(ws, (r) => {
      r.away = null
    })
    // Judged again now, not on the word of the moment it was marked: the turn may have shipped
    // the work, and a request then is a turn bought for nothing.
    const f = await facts()
    const t = f.threads.find((x: any) => sessionIdOf(x.harness, x.ref) === sessionId)
    const v = t ? awayVerdict(chatState(t, f, rec)) : { ask: false, why: 'its session is no longer listed' }
    const asked = t && v.ask ? await askSession(t, 'away', AWAY_WHY) : { ok: false, error: v.why }
    if (asked.ok) return
    // Said on the card, not dropped: a banner that vanished with no handoff and no reason read
    // as Away having been switched off by something else.
    await store.update(ws, (r) => {
      r.lastError = `Away: no handoff was asked for when the turn ended — ${asked.error || 'it was not worth one'}`
    })
  }
  // The plan nearly spent: the turn's own stream has just reported the windows (usage.md), so
  // this reading is free and current. A chat worth a handoff writes it now, once per window,
  // before a limit stops it cold mid-work.
  const usage: any = await readUsage().catch(() => null)
  const key = usage?.ok ? nearLimit(usage.limits, rec?.limitWindow || '', PRE_LIMIT_PERCENT) : ''
  if (key) {
    const f = await facts()
    const t = f.threads.find((x: any) => sessionIdOf(x.harness, x.ref) === sessionId)
    if (t && awayVerdict(chatState(t, f, rec)).ask) {
      const asked = await askSession(t, 'limit', `the plan's usage window is ${PRE_LIMIT_PERCENT}% spent, and a limit would stop this chat where it stands`)
      if (asked.ok) {
        await store.update(ws, (r) => {
          r.limitWindow = key
        })
        console.log(`[outpost] handoff: ${ws} asked before the plan limit (${key})`)
        return
      }
    }
  }
  // The idle timer, armed on every turn's end and judged when it comes due (`tick`): one per
  // idle stretch, since the next turn's end re-arms it and the handoff turn's never does. The
  // first status heard after Outpost starts may be a turn's end heard again; a timer already on
  // disk for the session is the true one and is kept.
  if (firstHeard && rec?.idle?.sessionId === sessionId) return
  await store.update(ws, (r) => {
    r.idle = { sessionId, dueAt: Date.now() + IDLE_HANDOFF_MS, contextAt: Date.now() }
  })
}

/**
 * How long a chat sits idle before the timer asks for its handoff. The CLI writes its cache
 * with a one-hour lifetime (every main-conversation request of 47 Outpost chats, measured
 * 2026-10-05), so at fifty minutes the request is still a cache read, and ten minutes covers a
 * minute's tick, a slow scan and the turn itself. Past the hour the request would rewrite the
 * whole context — the cost this exists to avoid — so it is not sent.
 */
export const IDLE_HANDOFF_MS = 50 * 60_000
/**
 * How spent the active plan window is before a chat worth a handoff is asked for one at its
 * turn's end. At 90% a few more turns of a long chat can finish it; the handoff written now is
 * one turn of warm cache, against a chat stopped cold mid-work and woken after the reset.
 */
export const PRE_LIMIT_PERCENT = 90
/** The prompt cache's lifetime (usage.md `cold`). */
const CACHE_TTL_MS = 60 * 60_000

/**
 * The cache lifetime a chat's recent requests wrote with: '1h', '5m', or '' when none of the
 * last few wrote anything. A chat on five minutes was cold long before the timer, and asking it
 * would be the full-price rewrite the timer exists to avoid.
 */
async function cacheTtlOf(t: any): Promise<string> {
  const read: any = await readTokens(t.harness, t.ref, {}).catch(() => null)
  const writers = (read?.requests || []).filter((q: any) => q.cacheWrite > 0).slice(-5)
  if (!writers.length) return ''
  return writers.some((q: any) => q.cacheWrite1h > 0) ? '1h' : '5m'
}

/** The idle timer came due for a chat: ask, or say in the log why not. */
async function idleDue(ws: string, rec: store.ChatHandoff) {
  const due = rec.idle
  await store.update(ws, (r) => {
    r.idle = null
  })
  if (!due) return
  const f = await facts()
  const t = f.threads.find((x: any) => sessionIdOf(x.harness, x.ref) === due.sessionId)
  if (!t) return
  const launcher = await activeLauncher()
  const quiet = t.canSend ? await launcher.isQuiet(t) : { quiet: true }
  const v = idleVerdict(
    { ...chatState(t, f, rec), now: Date.now(), running: Boolean(t.running), asking: !quiet.quiet && !t.running, cacheTtl: await cacheTtlOf(t), current: rec.current },
    { idleMs: IDLE_HANDOFF_MS, cacheMs: CACHE_TTL_MS }
  )
  if (!v.ask) {
    console.log(`[outpost] handoff: ${ws} idle, not asked — ${v.why}`)
    return
  }
  const asked = await askSession(t, 'idle', 'the chat has sat idle for fifty minutes, and its prompt cache expires at the hour')
  console.log(`[outpost] handoff: ${ws} idle — ${asked.ok ? 'asked for its handoff' : `could not ask: ${asked.error}`}`)
}

/** What the request says of an away chat: the person has gone, so the handoff is all there will be. */
const AWAY_WHY = 'the person has stepped away'

/** The roster once, with what the triggers judge a chat by: its workspace's git status and the thresholds. */
async function facts(): Promise<{ threads: any[]; wsById: Map<string, any>; limits: Limits | null }> {
  if (!rosterFn) return { threads: [], wsById: new Map(), limits: null }
  const r = await rosterFn()
  return { threads: r.threads || [], wsById: new Map((r.workspaces || []).map((w: any) => [w.id, w])), limits: r.contextLimits || null }
}

function chatState(t: any, f: { wsById: Map<string, any>; limits: Limits | null }, rec: store.ChatHandoff | null) {
  return {
    context: Number(t.context) || 0,
    window: Number(t.contextWindow) || 0,
    limits: f.limits,
    unshipped: unshipped(f.wsById.get(t.workspace?.id)?.repos),
    canSend: Boolean(t.canSend),
    current: rec?.current || null,
    contextAt: Number(t.contextAt) || 0,
  }
}

export type AwayOutcome = { id: string; title: string; outcome: 'asked' | 'marked' | 'skipped' | 'refused'; why: string }

/**
 * `/away` (handoff.md): the person is going. A chat in orange or red with work not shipped is
 * asked for its handoff now if it is quiet, or marked and asked the moment its turn ends;
 * anything else is left alone and said why. `all` is every chat with a running session.
 */
export async function away({ sessionId = '', all = false }: { sessionId?: string; all?: boolean }): Promise<{ ok: boolean; error?: string; results: AwayOutcome[] }> {
  const f = await facts()
  const chosen = all ? f.threads.filter((t: any) => t.canSend && t.workspace?.id && !t.archived) : f.threads.filter((t: any) => sessionIdOf(t.harness, t.ref) === sessionId)
  if (!all && !chosen.length) return { ok: false, error: 'That chat is not one Outpost is running', results: [] }
  const launcher = await activeLauncher()
  const results: AwayOutcome[] = []
  for (const t of chosen) {
    const ws = t.workspace.id
    const rec = await store.peek(ws)
    const said = (outcome: AwayOutcome['outcome'], why = '') => results.push({ id: t.id, title: t.title || '', outcome, why })
    if (rec?.pending) {
      said('skipped', 'a handoff is being written already')
      continue
    }
    const v = awayVerdict(chatState(t, f, rec))
    if (!v.ask) {
      said('skipped', v.why)
      continue
    }
    const quiet = await launcher.isQuiet(t)
    if (!quiet.quiet) {
      await store.update(ws, (r) => {
        r.away = { at: Date.now() }
      })
      said('marked', quiet.reason || 'it is busy')
      continue
    }
    const asked = await askSession(t, 'away', AWAY_WHY)
    said(asked.ok ? 'asked' : 'refused', asked.error || '')
  }
  return { ok: true, results }
}

/**
 * The person is back before the turns ended: take the away marks down — one chat's, or every
 * chat's — and say how many there were. A handoff already asked for is left to finish; it costs
 * nothing more and goes stale by itself when work carries on.
 */
export async function back({ sessionId = '', all = false }: { sessionId?: string; all?: boolean }): Promise<{ ok: boolean; cleared: number }> {
  const only = all ? '' : await workspaceOfSession(sessionId)
  let cleared = 0
  for (const [ws, rec] of await store.all()) {
    if (!rec.away || (!all && ws !== only)) continue
    await store.update(ws, (r) => (r.away = null))
    cleared++
  }
  return { ok: true, cleared }
}

/** A message into a chat takes its away mark down: the person is back. */
export async function clearAway(sessionId: string) {
  const ws = await workspaceOfSession(sessionId)
  const rec = ws ? await store.peek(ws) : null
  if (rec?.away) await store.update(ws, (r) => (r.away = null))
}

/**
 * Every minute: drop a request nothing ever answered — its turn died some way no hook reported —
 * and judge the idle timers that have come due. Due times are on disk, so a deploy in between
 * does not cancel them; one that came due while Outpost was down past the cache's hour is
 * judged too late and not sent (`idleVerdict`).
 */
export async function tick() {
  if (ticking) return
  ticking = true
  try {
    const now = Date.now()
    for (const [ws, rec] of await store.all()) {
      if (rec.pending && now - rec.pending.at > PENDING_MS) {
        await store.update(ws, (r) => {
          r.pending = null
          r.lastError = 'The session never finished writing a handoff'
        })
        continue
      }
      if (rec.idle && rec.idle.dueAt <= now && !rec.pending) await idleDue(ws, rec)
    }
  } finally {
    ticking = false
  }
}

/**
 * The roster's view of each chat's handoff, stamped on its thread as `handoff`: what the card
 * and the header need, never the text — that is fetched when the card is opened.
 */
export async function stampHandoffs(threads: any[]) {
  for (const t of threads) {
    const ws = t.workspace?.id
    const rec = ws ? await store.peek(ws) : null
    if (!rec) {
      t.handoff = null
      continue
    }
    const h = offerable(rec.current) ? rec.current : null
    const w = writing.get(ws)
    t.handoff = {
      ...(h ? { at: h.at, how: h.how, context: h.context, chars: h.text.length, stale: isStale(h, t.contextAt || 0), dismissed: Boolean(h.dismissedAt) } : {}),
      asking: Boolean(rec.pending) || Boolean(w),
      askedAt: rec.pending?.at || w?.at || 0,
      // What asked — `button`, `away`, `idle` or `limit` — for the one being written, else the
      // kept one's: the block in the log says it, the trace of an automatic handoff.
      trigger: rec.pending?.trigger || w?.trigger || h?.trigger || '',
      // Being written without the session (fallback.ts) rather than by it, and why not by it.
      without: Boolean(w),
      withoutWhy: w?.why || '',
      away: Boolean(rec.away),
      error: rec.lastError || '',
    }
  }
  return threads
}

/** The kept handoff of a chat, text and all, for the card; null when there is none to offer. */
export async function handoffOf(ws: string): Promise<(Handoff & { stale: boolean }) | null> {
  const rec = await store.peek(ws)
  if (!rec || !offerable(rec.current)) return null
  const t = await rosterThreadOfWorkspace(ws)
  return { ...rec.current, stale: isStale(rec.current, t?.contextAt || 0) }
}

async function rosterThreadOfWorkspace(ws: string): Promise<any> {
  if (!rosterFn) return null
  const { threads } = await rosterFn()
  return threads.find((t: any) => t.workspace?.id === ws && !t.archived) || null
}

/**
 * Start fresh: a new conversation in the same chat — workspace, checkout, branch, container and
 * name — with the kept handoff as its first message (handoff.md). The old session's unit is
 * stopped; its id goes on the manifest's `previousSessions`, which is how the roster keeps one
 * row for the chat and the page shows the earlier conversation above the new one.
 *
 * A stale handoff, or one written without the session, needs `confirmed`: the page asks first.
 * Refused while the session is working or asking, as a restart is (launchers.md).
 */
export async function startFresh(thread: any, { confirmed = false } = {}): Promise<{ ok: boolean; error?: string; confirm?: boolean }> {
  const ws = thread?.workspace?.id
  if (!ws) return { ok: false, error: 'This chat has no workspace' }
  const rec = await store.peek(ws)
  const h = rec?.current
  if (!offerable(h)) return { ok: false, error: 'There is no handoff to start from' }
  if (rec?.pending) return { ok: false, error: 'A handoff is being written; wait for it' }
  const stale = isStale(h, thread.contextAt || 0)
  if ((stale || h.how === 'fallback') && !confirmed) {
    return {
      ok: false,
      confirm: true,
      error: stale
        ? 'The session has worked since this handoff was written, so it misses the latest. The fresh conversation starts from it all the same.'
        : 'This handoff was written from the conversation\'s tail and the branch, not by the session. Read it first: the fresh conversation knows only what it says.',
    }
  }
  const launcher = await activeLauncher()
  if (thread.canSend) {
    const quiet = await launcher.isQuiet(thread)
    if (!quiet.quiet) return { ok: false, error: `${quiet.reason || 'It is busy'} — starting fresh ends this session, so let it finish first` }
  }
  const sid = sessionIdOf(thread.harness, thread.ref)
  const started = await launcher.startFresh(thread, freshPrompt(h.text))
  // The old unit is stopped before the new one is asked for, so a failed start leaves the chat
  // with no session running: said, with the way back.
  if (!started.ok) return { ok: false, error: `${started.error || 'The new conversation did not start'} — if the session stopped, Resume brings it back` }
  const m: any = await workspaceFor(thread.cwd)
  await markWorkspace(ws, {
    previousSessions: [...(m?.previousSessions || []), { sessionId: sid, endedAt: Date.now(), handoffAt: h.at }],
    // So the list keeps a "Starting" row for the chat until the new session has written a line.
    launch: { target: started.target, at: Date.now() },
  })
  await store.update(ws, (r) => {
    if (r.current) r.current.usedAt = Date.now()
    r.away = null
    r.idle = null
  })
  return { ok: true }
}

/**
 * One row per chat, however many conversations it has had: a thread whose session the chat has
 * set aside (`previousSessions`, by `startFresh`) is taken off the list and hung on the chat's
 * current thread as `earlier` — oldest first, each `{ id, harness, ref, createdAt,
 * lastActivityAt }` — which the page reads to draw the earlier conversation above the divider and
 * the token lines sum. The current thread takes the earlier one's name.
 */
export async function stitchEarlier(threads: any[]): Promise<any[]> {
  const byWs = new Map<string, { previous: string[]; earlier: any[]; current: any[] }>()
  for (const t of threads) {
    const ws = t.workspace?.id
    if (!ws) continue
    let g = byWs.get(ws)
    if (!g) {
      const m: any = await workspaceFor(t.cwd)
      g = { previous: (m?.previousSessions || []).map((p: any) => p.sessionId), earlier: [], current: [] }
      byWs.set(ws, g)
    }
    if (!g.previous.length) continue
    const sid = sessionIdOf(t.harness, t.ref)
    if (g.previous.includes(sid)) g.earlier.push(t)
    else g.current.push(t)
  }
  const drop = new Set<any>()
  for (const g of byWs.values()) {
    if (!g.earlier.length) continue
    for (const t of g.earlier) drop.add(t)
    const order = (t: any) => g.previous.indexOf(sessionIdOf(t.harness, t.ref))
    const earlier = [...g.earlier].sort((a, b) => order(a) - order(b))
    for (const t of g.current) {
      t.earlier = earlier.map((e) => ({ id: e.id, harness: e.harness, ref: e.ref, createdAt: e.createdAt || 0, lastActivityAt: e.lastActivityAt || 0 }))
      await carryName(earlier[earlier.length - 1].id, t.id).catch(() => false)
    }
  }
  return threads.filter((t) => !drop.has(t))
}

/** The roster thread for a page's `{ harness, ref }`. */
export async function threadFor(harness: string, ref: unknown): Promise<any> {
  return rosterThread(sessionIdOf(harness, ref))
}

let timer: ReturnType<typeof setInterval> | null = null

/** Start listening for turns' ends and the loop. From `serve.mjs` only: tools import the API and must ask nobody anything. */
export function startHandoffs() {
  if (timer) return
  hookEvents.on('event', (e: { sessionId: string; status: string }) => {
    onHook(e).catch((err) => console.warn('[outpost] handoff:', err?.message || err))
  })
  const run = () => tick().catch((err) => console.warn('[outpost] handoff tick:', err?.message || err))
  timer = setInterval(run, TICK_MS)
  timer.unref?.()
  // Not at once: the hook store and the roster are cold for the first seconds after a start.
  setTimeout(run, 15_000).unref?.()
}
