/**
 * Bringing back a session that stalled on the API's weather.
 *
 * hooks.md splits a dead turn three ways, and only the `transient` class reaches here: it is
 * the only one where sending the same thing again is a plan rather than a loop. An `account`
 * failure retried is five more failures against a credential that is not going to start
 * working; a `turn` failure retried is the same malformed request, five times. That the
 * classes exist is what makes automating this safe at all, which is why they landed first.
 *
 * The schedule is per kind, and programmatic wherever the machine can actually know the
 * answer rather than guess at one:
 *
 *   `rate_limit`    the plan says when the window resets, and usage.md already reads it for
 *                   the dashboard's readout. So wait for that, plus a margin — poking a
 *                   five-hour limit every ten minutes is thirty refusals and a burnt attempt
 *                   budget before the window has moved at all.
 *   `overloaded`    nobody publishes when a 529 or a 500 clears, so this is a plain cadence:
 *   `server_error`  ten minutes, up to the cap. An outage that outlasts fifty minutes is not
 *                   one a dashboard should still be hammering at.
 *
 * After `MAX_ATTEMPTS` sends it stops, says so, and waits for a person. That cap is the whole
 * safety argument for doing this unattended: the worst case is five prompts into one session
 * across the better part of an hour, not a machine that types forever.
 *
 * This module owns *when*. It does not own what a failure means (hooks.md), how a session is
 * typed to (launchers.md), or where a notification goes (resilience.md, `server/notify/`).
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJsonFile } from '../lib/fsutil.mjs'
import { hookStates } from './hooks.mjs'
import { scanAll, sessionIdOf } from '../scan.mjs'
import { activeLauncher } from '../launchers/index.mjs'
import { readUsage } from '../usage.ts'
import { notify } from '../notify/index.mjs'
import { logDecision } from './retry-log.mjs'
import { readSettings } from '../config.mjs'
import { workspaceFor } from '../workspaces/index.mjs'
import { contextLevel } from '../handoff/rules.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.OUTPOST_DATA || path.join(here, '..', '..', 'data')
const STORE_FILE = path.join(DATA_DIR, 'retries.json')

/** Sends per stall episode before it stops and asks for a person. */
export const MAX_ATTEMPTS = Number(process.env.OUTPOST_RETRY_ATTEMPTS) || 5
/** After a rate limit's window resets, the grace before trying — clocks differ, and the
 *  reset is the moment the *window* moves, not a promise the next request is served. */
const RESET_MARGIN_MS = 5 * 60 * 1000
/** A rate limit whose reset time nothing on this machine knows. Long, because the windows
 *  these come off are hours: a shorter guess just spends the budget before the window turns. */
const RATE_LIMIT_BLIND_MS = 30 * 60 * 1000
/** 529s and 500s, which nobody publishes a clearing time for. */
const OUTAGE_MS = 10 * 60 * 1000
/**
 * How long a dropped budget's spent attempts still count, after the later of its last send and
 * its last stall. A `Stop` ends an episode and drops the record, and every hook is something
 * a process on this machine can post: a `Stop` and a `StopFailure` in turn reset the count to
 * nothing each time, and five became a prompt every ten minutes for ever. Within this window a
 * new stall of the same session carries what was spent, and each stall pushes the window on.
 */
export const CARRY_MS = 60 * 60 * 1000
/** How often the supervisor looks. Fine against schedules measured in tens of minutes, and
 *  it costs nothing until something is actually due — see `tick`. */
const TICK_MS = 60 * 1000

/** @type {Map<string, object> | null} sessionId -> retry record */
let store = null
/** @type {Map<string, { attempts: number, until: number }> | null} sessionId -> attempts a dropped budget had spent (`CARRY_MS`) */
let recent = null
let timer = null
let ticking = false
let writing = Promise.resolve()

async function load() {
  if (store) return store
  // Starts empty rather than failing the boot when the file is unreadable — but set aside
  // first, not left to be written over: the attempt counts in it are the cap, and a person
  // can still read what they were.
  const raw = await readJsonFile(STORE_FILE, { aside: true }).catch((err) => {
    console.warn(`[outpost] ${err.message}; starting with no retry budgets`)
    return undefined
  })
  const loaded = new Map()
  for (const [id, rec] of Object.entries(raw?.retries || {})) {
    if (rec && typeof rec === 'object') loaded.set(id, rec)
  }
  const now = Date.now()
  recent = new Map()
  for (const [id, r] of Object.entries(raw?.recent || {})) {
    if (r && Number(r.attempts) > 0 && Number(r.until) > now) recent.set(id, { attempts: Number(r.attempts), until: Number(r.until) })
  }
  store = loaded
  return store
}

/** What a dropped budget for this session still has spent, or 0 once its window has passed. */
function carried(sessionId) {
  const r = recent.get(sessionId)
  if (!r) return 0
  if (r.until <= Date.now()) {
    recent.delete(sessionId)
    return 0
  }
  return r.attempts
}

/** Remember what a budget being dropped had spent; nothing spent is nothing to remember. */
function remember(rec) {
  if (!rec?.attempts) return
  recent.set(rec.sessionId, { attempts: rec.attempts, until: Math.max(rec.lastAttemptAt || 0, rec.at || 0) + CARRY_MS })
}

/**
 * Written through on every change rather than on a timer, unlike the hook store: this one
 * changes a handful of times an hour, and the thing it is protecting is the attempt count.
 * Losing that to a restart is how a cap of five becomes a cap of nothing.
 */
function persist() {
  const retries = Object.fromEntries(store)
  const now = Date.now()
  const kept = Object.fromEntries([...recent].filter(([, r]) => r.until > now))
  writing = writing.then(async () => {
    try {
      await fsp.mkdir(DATA_DIR, { recursive: true })
      const tmp = STORE_FILE + '.tmp'
      await fsp.writeFile(tmp, JSON.stringify({ version: 1, retries, recent: kept }, null, 2))
      await fsp.rename(tmp, STORE_FILE)
    } catch {
      /* a lost write costs an attempt count, never a request */
    }
  })
  return writing
}

/**
 * The part of the usage payload that explains a schedule: every window, not only the one that
 * won.
 *
 * Which window Outpost picks as "soonest future reset" and which window actually gated the turn
 * are the two things both open schedule bugs turn on, and nothing but the whole list, as it read
 * at the moment of the decision, can separate them afterwards. Kept small deliberately — this is
 * the diagnostic, not a copy of the payload — and it carries no token, no plan name and no
 * account detail, because it is written to a file that outlives the episode.
 */
function usageSnapshot(usage) {
  if (!usage) return { ok: false, error: 'no answer' }
  return {
    ok: Boolean(usage.ok),
    stale: Boolean(usage.stale),
    error: usage.error || '',
    limits: (usage.limits || []).map((l) => ({
      label: l.label,
      percent: l.percent,
      resetsAt: l.resetsAt,
      active: Boolean(l.active),
    })),
  }
}

/**
 * When the plan's current window resets, in epoch ms — 0 if this machine cannot say — and the
 * payload that answer came out of, for the log.
 *
 * Read off the same `/api/usage` answer the dashboard's readout draws, which is cached — so
 * asking here is nearly always free, and the snapshot rides along for nothing. The
 * *soonest* future reset wins rather than the active limit's: whichever window turns first is
 * the one that lets a session move again, and being early costs a refused send while being late
 * costs an idle hour.
 */
async function planReset() {
  try {
    const usage = await readUsage()
    const seen = usageSnapshot(usage)
    if (!usage?.ok) return { at: 0, usage: seen }
    const now = Date.now()
    const times = (usage.limits || [])
      .map((l) => (l?.resetsAt ? Date.parse(l.resetsAt) : NaN))
      .filter((t) => Number.isFinite(t) && t > now)
    return { at: times.length ? Math.min(...times) : 0, usage: seen }
  } catch (err) {
    return { at: 0, usage: { ok: false, error: String(err?.message || err) } }
  }
}

/**
 * How long to wait before the next send, and what to call that decision afterwards.
 *
 * The `why` is kept because it is the only thing that explains a wait to a person: "22:40,
 * when your limit resets" and "ten minutes from now, because nobody publishes when a 529
 * clears" are the same number to the scheduler and completely different news.
 */
async function scheduleFor(kind) {
  if (kind === 'rate_limit') {
    const { at, usage } = await planReset()
    if (at) return { at: at + RESET_MARGIN_MS, why: 'when the plan limit resets', blind: false, usage }
    return { at: Date.now() + RATE_LIMIT_BLIND_MS, why: 'a guess — no reset time is published to this machine', blind: true, usage }
  }
  return { at: Date.now() + OUTAGE_MS, why: 'the API should have recovered by then', blind: false, usage: null }
}

/**
 * A rate limit scheduled blind gets another go at learning the real reset time on every tick.
 *
 * Rarer now that usage is read off the chats' streams rather than an endpoint that answered 429
 * at exactly the moment a session had been rate limited — but a machine whose streams hold no
 * reading yet still schedules blind, and a schedule computed once would keep a half-hour guess
 * for the rest of the episode even after another chat's turn published the real answer.
 *
 * Free when it matters: `readUsage` caches, so this is a map lookup on most ticks, and it only
 * runs for a session actually waiting out a limit.
 */
async function refineSchedule(rec) {
  if (!rec.blind || rec.kind !== 'rate_limit') return false
  const { at, usage } = await planReset()
  if (!at) return false
  const was = rec.nextAt
  rec.nextAt = at + RESET_MARGIN_MS
  rec.why = 'when the plan limit resets'
  rec.blind = false
  logDecision('refine', { session: rec.sessionId, was, nextAt: rec.nextAt, why: rec.why, usage })
  return true
}

/** How the restart prompt opens; what the token accounting (server/tokens.ts) counts them by. */
export const RESTART_LEAD = '[Outpost] Your previous turn was cut short by the API'

/**
 * What gets typed back into the session.
 *
 * It names the failure, because the session is about to be asked to carry on with no idea why
 * it stopped — its own last turn simply ended — and a bare "continue" invites it to re-plan
 * from scratch or, worse, redo work it had already finished. It says plainly that this came
 * from Outpost rather than from the person, so nothing in the transcript reads as an
 * instruction they gave. And it asks for the work, not a summary of the work.
 */
export function restartPrompt(failure, attempt) {
  // The label only, never `failure.detail`: that is the payload's `error_details` verbatim, and
  // a hook is something any process on this machine can post. Typed into the session, it was
  // text of anybody's choosing arriving as Outpost's own words. It stays on the record for a
  // person to hover (hooks.md); the label comes from the fixed table there.
  return [
    `${RESTART_LEAD}, not by anything you did: ${failure.label}.`,
    `This is an automatic restart — attempt ${attempt} of ${MAX_ATTEMPTS} — sent by the Outpost dashboard, not typed by a person.`,
    `Please pick up exactly where you left off. Check what you had already finished before redoing any of it.`,
  ].join('\n\n')
}

/** Every retry record, for stamping the roster. */
export async function retryStates() {
  await load()
  return store
}

/**
 * Forget a session's retry budget. Called when a turn completes, when the session ends, and
 * when a person restarts it by hand — all three mean the episode this budget belonged to is
 * over, and the next stall deserves its own five.
 */
export async function clearRetry(sessionId) {
  await load()
  const rec = store.get(sessionId)
  // A person's clear is a fresh five, carried attempts included.
  const forgot = recent.delete(sessionId)
  if (!store.delete(sessionId)) {
    if (forgot) await persist()
    return false
  }
  logDecision('drop', { session: sessionId, reason: 'a person cleared the budget', attempts: rec?.attempts || 0, kind: rec?.kind || '' })
  await persist()
  return true
}

/**
 * Send the restart now, whatever the schedule said. This is the manual path — the panel's
 * button — and it deliberately shares everything below the decision to send: a person
 * clicking is still subject to "is it running" and "is it quiet", because those refuse for
 * reasons a click cannot overcome. It differs in one way: it is allowed past an exhausted
 * budget, and resets it.
 */
export async function restartNow(sessionId) {
  await load()
  const hooks = await hookStates()
  const hook = hooks.get(sessionId)
  if (!hook) return { ok: false, error: 'No live state for that session' }
  if (!hook.failure) return { ok: false, error: 'That session has not stopped on a failure' }

  const rec = store.get(sessionId) || newRecord(sessionId, hook.failure)
  logDecision('manual', {
    session: sessionId,
    cwd: hook.cwd || '',
    kind: hook.failure.kind,
    // What the person overrode. A budget going from four to zero with no other trace is how a
    // cap looks like it failed open when in fact somebody chose to spend another one.
    attempts: rec.attempts,
    wasExhausted: Boolean(rec.exhausted),
    wasHeld: Boolean(rec.held),
    wasDueAt: rec.nextAt || 0,
  })
  rec.attempts = 0
  rec.exhausted = false
  recent.delete(sessionId)
  // A person resuming a held chat has chosen the rewrite; the hold is theirs to lift.
  rec.held = false
  store.set(sessionId, rec)
  const result = await attempt(sessionId, hook, rec, { manual: true })
  await persist()
  return result
}

function newRecord(sessionId, failure) {
  return {
    sessionId,
    kind: failure.kind,
    class: failure.class,
    // When the stall this record is scheduled against happened. A later `StopFailure` of the
    // same kind is a *new* stall inside the same episode and needs a new wait; without this
    // the record kept the `nextAt: 0` a send leaves behind and was never due again.
    at: failure.at || 0,
    attempts: 0,
    nextAt: 0,
    why: '',
    // True while `nextAt` is a guess rather than a published reset time — see `refineSchedule`.
    blind: false,
    exhausted: false,
    lastAttemptAt: 0,
    lastError: '',
  }
}

/**
 * One send. Every refusal here leaves the schedule alone so the next tick tries again — the
 * session being busy this minute says nothing about the next one — except the two that are
 * permanent for this episode, which stop it.
 */
async function attempt(sessionId, hook, rec, { manual = false } = {}) {
  // Every line below carries `manual`, because "why did it send then" has a completely
  // different answer for a person's click than for a schedule coming due, and the two are
  // otherwise indistinguishable in the log a minute later.
  const note = (event, fields) => logDecision(event, { session: sessionId, cwd: hook.cwd || '', manual, ...fields })

  const launcher = await activeLauncher()
  if (!launcher.canSend) {
    rec.lastError = `The ${launcher.name} launcher cannot send prompts`
    rec.exhausted = true
    note('gave-up', { reason: rec.lastError })
    return { ok: false, error: rec.lastError }
  }

  // The roster is the only place a session id becomes something the launcher can reach.
  //
  // Asked through the harness rather than by reading `ref.cliSessionId`: that field is Claude
  // Code's, and a supervisor that knows the shape of one harness's ref is a supervisor that
  // silently restarts nothing for the second one — no error, just sessions that never come
  // back, which is the worst way to find out. `sessionIdOf` is in the adapter contract for
  // exactly this (harnesses.md), `/api/restart` already resolves through it, and an adapter
  // that does not implement it falls through to `id` as before.
  const { threads, failed } = await scanAll()
  const thread = threads.find((t) => (sessionIdOf(t.harness, t.ref) || t.id) === sessionId)
  // A harness whose scan threw is missing from the list, and a list with it missing looks
  // exactly like the session having gone. Read as gone, one bad scan wrote a stalled session
  // off for good — `gave-up` is terminal — so it is a refusal instead: nothing spent, and the
  // next tick looks again.
  if (!thread && failed.length) {
    rec.lastError = `The scan skipped ${failed.join(', ')}; the roster is partial`
    note('refused', { reason: rec.lastError, spent: false, attempts: rec.attempts })
    return { ok: false, error: rec.lastError, retryable: true }
  }
  if (!thread) {
    rec.lastError = 'That session is no longer in the roster'
    note('gave-up', { reason: rec.lastError })
    return { ok: false, error: rec.lastError }
  }

  const quiet = await launcher.isQuiet(thread)
  if (!quiet.quiet) {
    // `error` is the launcher's answer when it has no record of the session at all, which
    // carries no `reason`; the log line used to read `reason: undefined`.
    rec.lastError = quiet.reason || quiet.error || 'The session is not quiet'
    // No attempt is spent here, and the log says so in as many words: a run of these is what a
    // busy session looks like from the supervisor's side, and reading them as spent attempts would
    // send a diagnosis off after the wrong thing entirely.
    note('refused', { reason: rec.lastError, spent: false, attempts: rec.attempts })
    return { ok: false, error: rec.lastError, retryable: true }
  }

  rec.attempts += 1
  rec.lastAttemptAt = Date.now()
  const sent = await launcher.sendPrompt(thread, restartPrompt(hook.failure, rec.attempts))
  if (!sent.ok) {
    rec.lastError = sent.error || 'The send failed'
    note('refused', { reason: rec.lastError, spent: true, attempts: rec.attempts })
    // The attempt is spent whether or not it landed, so the cap is counted here too. Only a
    // send that worked used to set `exhausted`: a session whose unit had gone failed every
    // send, spent one a minute, and ran past five without ever stopping.
    if (rec.attempts >= MAX_ATTEMPTS) {
      rec.exhausted = true
      return { ok: false, error: rec.lastError }
    }
    return { ok: false, error: rec.lastError, retryable: true }
  }

  rec.lastError = ''
  // Nothing is scheduled after a send: the session is running again, and the next schedule is
  // computed from the *next* StopFailure if there is one. A timer set now would fire into a
  // working session.
  rec.nextAt = 0
  rec.why = ''
  if (rec.attempts >= MAX_ATTEMPTS) rec.exhausted = true
  note('send', {
    attempt: rec.attempts,
    max: MAX_ATTEMPTS,
    kind: hook.failure?.kind || '',
    // The stall this send answers. A send is the moment `nextAt` goes back to 0, so without the
    // failure's own stamp beside it there is nothing in the log to measure the wait against —
    // which is the exact question both open schedule bugs ask.
    stallAt: hook.failure?.at || 0,
    waitedMs: hook.failure?.at ? Date.now() - hook.failure.at : 0,
  })
  await notify({
    event: 'restarted',
    thread,
    failure: hook.failure,
    attempt: rec.attempts,
    max: MAX_ATTEMPTS,
    manual,
  })
  return { ok: true, attempts: rec.attempts, exhausted: rec.exhausted }
}

/**
 * Whether a session stopped by a plan limit is held rather than sent on when the limit resets:
 * `{ context, window }` when its context is above red (the header's red band, ui-conversation.md), null when
 * it resumes as ever. Never for an unattended chat — a routine's run or one told never to ask
 * (`dontAsk`) has nobody to choose, and a routine's run never waits on a prompt (routines.md) —
 * and never on a reading that fails: a hold is a person's call made for them, so any doubt
 * resumes, as before.
 */
async function holdFor(sessionId) {
  try {
    const { threads } = await scanAll()
    const thread = threads.find((t) => (sessionIdOf(t.harness, t.ref) || t.id) === sessionId)
    if (!thread?.context) return null
    const ws = await workspaceFor(thread.cwd)
    if (!ws || ws.routine || ws.schedule || ws.permissionMode === 'dontAsk') return null
    const launcher = await activeLauncher()
    await launcher.annotate([thread])
    const limits = (await readSettings()).context
    if (contextLevel(thread.context, thread.contextWindow || 0, limits) !== 'alert') return null
    return { context: thread.context, window: thread.contextWindow || 0 }
  } catch {
    return null
  }
}

/**
 * One pass. Cheap in the normal case: it reads the hook store, finds nothing stalled, and
 * stops — the roster scan and the quiet check only happen for a session actually due.
 */
export async function tick() {
  if (ticking) return
  ticking = true
  try {
    await load()
    const hooks = await hookStates()
    let dirty = false

    // The episode ends when the *failure* does, not when the status moves off `stalled`.
    // `Stop` clears `failure` on a turn that completed and `SessionEnd` on one that is over,
    // which are the two things that actually mean this budget has nothing left to guard.
    //
    // Keyed on the status, as it was, any event that names a status while a stall stands threw
    // the budget away — a `Notification` for a permission prompt reads `waiting`, which is
    // neither `stalled` nor `error` — and the next pass then rebuilt the record from scratch.
    // That is how one stall spent two attempts and reported `attempt 1 of 5` for both.
    for (const sessionId of [...store.keys()]) {
      const hook = hooks.get(sessionId)
      if (!hook || !hook.failure || hook.status === 'ended') {
        // Which of the three, in the log. A budget vanishing is the single most confusing thing
        // this module does after the fact — two sends on one stall both said `attempt 1 of 5`
        // because of a drop nobody could see — so the reason is written down before the record
        // that would have explained it is gone.
        const rec = store.get(sessionId)
        logDecision('drop', {
          session: sessionId,
          reason: !hook ? 'no live state for that session' : hook.status === 'ended' ? 'the session ended' : 'the failure cleared',
          attempts: rec?.attempts || 0,
          kind: rec?.kind || '',
        })
        remember(rec)
        store.delete(sessionId)
        dirty = true
      }
    }

    const launcher = await activeLauncher()
    for (const [sessionId, hook] of hooks) {
      if (!hook.failure) continue
      // Hooks are installed per user, so a session somebody started by hand reports its
      // failures here too. Nothing can send to one: tracked, it got a "Restarting
      // automatically at…" message for a restart that could never happen, and a refusal in
      // the log every minute after. Only a session Outpost started is supervised.
      if (launcher.owns && !(await launcher.owns(sessionId))) continue
      // The class decides this and nothing else. It is set once from the failure the API
      // reported and never moves; the status is a single field that any later event overwrites
      // while `failure` stands. Requiring `stalled` here read a rate limit sitting under a
      // permission prompt as a failure Outpost will never retry, and the branch below wrote it
      // off as `broken` with `exhausted: true` and nothing spent — permanently, because the
      // kind never changes and so no new episode is ever opened for it. A whole session's
      // budget, lost to a notification.
      const transient = hook.failure.class === 'transient'

      // A failure nothing here will ever retry still deserves one message — an account
      // problem is more urgent than a rate limit, not less, and being silent about the
      // failures we cannot fix would be an odd way to run a supervisor. The record exists
      // only so that "one message" does not become one per minute.
      if (!transient) {
        if (store.has(sessionId)) continue
        const rec = { ...newRecord(sessionId, hook.failure), exhausted: true }
        store.set(sessionId, rec)
        dirty = true
        logDecision('broken', {
          session: sessionId,
          cwd: hook.cwd || '',
          kind: hook.failure.kind,
          class: hook.failure.class,
          reason: 'this class is never retried',
        })
        await notify({ event: 'broken', sessionId, cwd: hook.cwd, failure: hook.failure })
        continue
      }

      let rec = store.get(sessionId)
      // `rec.at || 0` rather than `rec.at`: a record written before `at` existed compares
      // against `undefined`, which is false for `>` and would strand exactly the sessions this
      // is meant to rescue. A missing stamp reads as a re-stall and gets a fresh schedule.
      if (!rec || rec.kind !== hook.failure.kind || hook.failure.at > (rec.at || 0)) {
        // A first stall, a different failure than the one being tracked, or the same one
        // again — each needs a schedule of its own, keeping whatever budget has already been
        // spent so the cap still counts the episode rather than the stall.
        //
        // The third case is why `at` is on the record. A send leaves `nextAt: 0` behind on
        // purpose, since the session is running again and a timer set then would fire into a
        // working one; but a restart that lands while the limit is still up stalls again
        // immediately, and without this the record kept that `0` and was never due again. Only
        // the old status-keyed cleanup above — dropping the budget and rebuilding it — was
        // getting those sessions restarted at all, which is the bug this pairs with.
        // A record dropped within `CARRY_MS` hands its spent attempts on: the stall after a
        // quick `Stop` is the same episode as far as the cap is concerned.
        const carry = rec ? 0 : carried(sessionId)
        if (carry) recent.delete(sessionId)
        const spent = rec?.attempts || carry
        const restall = Boolean(rec) && rec.kind === hook.failure.kind
        rec = { ...newRecord(sessionId, hook.failure), attempts: spent }
        const next = await scheduleFor(hook.failure.kind)
        rec.nextAt = next.at
        rec.why = next.why
        rec.blind = next.blind
        rec.exhausted = spent >= MAX_ATTEMPTS
        store.set(sessionId, rec)
        dirty = true
        logDecision('stall', {
          session: sessionId,
          cwd: hook.cwd || '',
          kind: hook.failure.kind,
          class: hook.failure.class,
          detail: hook.failure.detail || '',
          stallAt: hook.failure.at || 0,
          // A second stall of the same kind is a new wait inside the same episode, not a new
          // episode — the attempts carried over are the difference, and the cap counts them.
          restall,
          carried: carry,
          attempts: spent,
          max: MAX_ATTEMPTS,
          nextAt: rec.nextAt,
          inMs: rec.nextAt - Date.now(),
          why: rec.why,
          blind: rec.blind,
          exhausted: rec.exhausted,
          // The whole payload the schedule above was computed from. Null for a 529 or a 500,
          // which are on a flat cadence and ask the usage endpoint nothing.
          usage: next.usage,
        })
        await notify({
          event: 'stalled',
          sessionId,
          cwd: hook.cwd,
          failure: hook.failure,
          nextAt: rec.exhausted ? 0 : rec.nextAt,
          why: rec.why,
        })
        continue
      }

      if (rec.exhausted || !rec.nextAt) continue
      if (await refineSchedule(rec)) dirty = true
      if (rec.nextAt > Date.now()) continue

      // A limit has reset over a chat whose context is above red: sending it on rewrites the
      // whole context at full price, a cost a person should choose, against starting it fresh
      // from its handoff (handoff.md). Held, never sent by the timer; the panel offers both.
      if (rec.kind === 'rate_limit') {
        const hold = await holdFor(sessionId)
        if (hold) {
          rec.held = true
          rec.heldContext = hold.context
          rec.nextAt = 0
          rec.why = 'held: the context is above red'
          dirty = true
          logDecision('held', { session: sessionId, cwd: hook.cwd || '', kind: hook.failure.kind, context: hold.context, window: hold.window, attempts: rec.attempts })
          await notify({ event: 'held', sessionId, cwd: hook.cwd, failure: hook.failure, context: hold.context })
          continue
        }
      }

      const before = rec.attempts
      const result = await attempt(sessionId, hook, rec)
      dirty = true
      if (!result.ok && result.retryable) {
        // Nothing was sent — look again on the next tick rather than burning the schedule.
        if (rec.attempts === before) rec.nextAt = Date.now() + TICK_MS
        continue
      }
      if (!result.ok) {
        rec.exhausted = true
        await notify({ event: 'gave-up', sessionId, cwd: hook.cwd, failure: hook.failure, reason: rec.lastError })
        continue
      }
      if (rec.exhausted) {
        logDecision('exhausted', { session: sessionId, cwd: hook.cwd || '', attempts: rec.attempts, max: MAX_ATTEMPTS })
        await notify({ event: 'exhausted', sessionId, cwd: hook.cwd, failure: hook.failure, attempts: rec.attempts })
      }
    }

    if (dirty) await persist()
  } catch (err) {
    // A supervisor that throws is a supervisor that stops. Nothing here is worth the loop.
    console.warn('[outpost] retry tick failed:', err?.message || err)
  } finally {
    ticking = false
  }
}

/** Start the loop. Called once from `serve.mjs`; safe to call twice. */
export function startRetrySupervisor() {
  if (timer) return
  timer = setInterval(tick, TICK_MS)
  timer.unref?.()
  // Not on the boot tick: a server that has just come up has a cold hook store and a roster
  // nobody has scanned, and the first thing it would do is decide about sessions it has not
  // seen yet.
  setTimeout(tick, 10_000).unref?.()
}

export function stopRetrySupervisor() {
  if (!timer) return
  clearInterval(timer)
  timer = null
}
