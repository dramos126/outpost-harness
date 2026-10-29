/**
 * Aging: getting the disk back from chats nobody is using, without ever losing work.
 *
 * Idle is measured on the chat's own activity — the latest of its session's last event, its
 * launch and its last restore. A session quiet for `endIdleHours` is ended to give its memory
 * back, its chat left on the list for a message to resume. Past `idleDays` the chat is archived. `deleteDays` after a chat was archived — by this loop or by a person — its
 * workspace is deleted **only if every checkout is clean and pushed**; until then the chat can
 * be restored from the page.
 * A workspace with uncommitted or unpushed work is never deleted by this loop: it is marked
 * so the row and the panel say why it is still here, and a person pushes or deletes it. A
 * disk budget is a second trigger with the same rule, taking the oldest clean workspaces
 * first (docs/proposals/harness.md, *Aging never deletes unpushed work*).
 *
 * The retry supervisor's shape again: one loop, a line per decision, nothing a person could
 * not have done by hand, and `force` is never this loop's word.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readSettings } from '../config.mjs'
import { WORKSPACES_DIR, deleteWorkspace, markWorkspace, promoteRun, sweepWorktrees } from '../workspaces/index.mjs'
import { MIRRORS_DIR } from '../workspaces/git.mjs'
import { logRunEvent, routineIdsOnDisk } from './routines.mjs'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.OUTPOST_DATA || path.join(here, '..', '..', 'data')
export const LOG_FILE = path.join(DATA_DIR, 'aging-log.jsonl')

/** Hourly: idle is measured in days, and a loop that looks more often is a loop that costs more than it saves. */
const TICK_MS = 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
/**
 * How long a routine's run that ended `nothing` or `done` keeps its workspace: a day to look
 * inside one from the routine's page, then it goes like any clean chat (routines.md).
 */
export const RUN_KEEP_MS = DAY_MS
const QUIET_ENDINGS = new Set(['nothing', 'done'])
/**
 * The mirrors' worktree sweep (`sweepWorktrees`): on the first pass after a start, which also
 * locks every checkout made before checkouts were locked, then daily. A stale entry costs a
 * branch nobody can check out, not disk, so a day is soon enough.
 */
const SWEEP_MS = DAY_MS
let lastSweep = 0

let roster = null
let archive = null
let archivedAt = null
let endSession = null
let endQuiet = null
let startedAt = null
let timer = null
let ticking = false
let writing = Promise.resolve()

/**
 * Handed what it needs by `api.mjs`: the roster, the archive list's writer and its stamps, the
 * launcher's kill, the kill that first asks whether the session is quiet, and when a session's
 * unit started.
 */
export function configureAging({ roster: r, archive: a, archivedAt: at, endSession: e, endQuiet: q, startedAt: s }) {
  roster = r
  archive = a
  archivedAt = at
  endSession = e
  endQuiet = q
  startedAt = s
}

/** When each thread was archived, by id. An unreadable list is nobody archived: nothing is deleted on a guess. */
const archiveStamps = async () => (archivedAt ? await archivedAt().catch(() => ({})) : {})

function logDecision(event, fields = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + '\n'
  writing = writing.then(() => fsp.mkdir(DATA_DIR, { recursive: true }).then(() => fsp.appendFile(LOG_FILE, line))).catch(() => {})
}

/** `du -sk` is the honest size of a tree with hard links and sparse files; a walk is not. */
async function sizeOf(dir) {
  try {
    const { stdout } = await execFileAsync('du', ['-sk', dir], { timeout: 60000 })
    return Number(stdout.split(/\s+/)[0]) * 1024 || 0
  } catch {
    return 0
  }
}

async function freeBytes(dir) {
  try {
    const { stdout } = await execFileAsync('df', ['-Pk', dir], { timeout: 10000 })
    const line = stdout.trim().split('\n').pop()
    return Number(line.split(/\s+/)[3]) * 1024 || 0
  } catch {
    return 0
  }
}

/**
 * Disk, for the settings page: what the workspaces and mirrors take, and what is free.
 * `measure: false` leaves the sizes out: the `du` takes seconds on a full disk (7 s over
 * 70 GB, warm), and the page's fields stayed blank waiting on numbers they do not need.
 */
export async function agingStatus({ measure = true } = {}) {
  const s = (await readSettings()).aging
  if (!measure) return { settings: s, lastTickAt: lastTick }
  return {
    settings: s,
    workspacesBytes: await sizeOf(WORKSPACES_DIR),
    mirrorsBytes: await sizeOf(MIRRORS_DIR),
    freeBytes: await freeBytes(WORKSPACES_DIR),
    lastTickAt: lastTick,
  }
}

let lastTick = 0

/**
 * When a chat was last alive: its session's last event, else its launch, else its creation.
 * A restore counts — a chat brought back after aging out has said nothing new yet, and
 * without this the next pass would archive it again.
 */
function lastActivity(ws, threads) {
  let at = Math.max(ws.launch?.at || ws.createdAt || 0, ws.restoredAt || 0)
  for (const t of threads) {
    if (t.workspace?.id !== ws.id) continue
    if ((t.lastActivityAt || 0) > at) at = t.lastActivityAt
  }
  return at
}

/**
 * Since when a workspace has been archived, or 0. Every chat it carries has to be: a chat
 * that was cleared leaves its old thread beside the new one, and archiving the old one says
 * nothing about the workspace the new one is working in. The latest stamp is the one that
 * counts, so the grace runs from the last thing a person put away. A workspace whose threads
 * cannot all be vouched for falls back to this loop's own stamp.
 */
function archivedSince(ws, threads, stamps) {
  const mine = threads.filter((t) => t.workspace?.id === ws.id).map((t) => stamps[t.id] || 0)
  if (mine.length && mine.every(Boolean)) return Math.max(...mine)
  return ws.aged || 0
}

/**
 * Whether a workspace's chat holds something the person has not seen: a turn finished and not
 * yet read (`done`), or one waiting on them (`unread`). Never archived while it does — the
 * person reading it is activity (`/api/ack`), so the idle clock then starts from their look.
 */
const unseenIn = (ws, threads) => threads.some((t) => t.workspace?.id === ws.id && !t.archived && (t.done || t.unread))

/**
 * What aging thinks of each workspace, for the roster to stamp on it: how long idle, when it
 * ages out, since when it has been archived and when it goes, whether it is being kept for
 * unpushed work. Computed, never stored, so it is right whenever the list is.
 */
/**
 * The defining chats aging leaves alone, as it does a pinned one: each whose routine is still on
 * disk (routines.md, *Defining chats*). A routines folder that cannot be listed holds every chat
 * that names a routine — never read as every routine gone. An unsaved draft is not held.
 */
async function definersHeld(workspaces) {
  const ids = await routineIdsOnDisk().catch(() => null)
  return new Set(workspaces.filter((w) => w.defines?.routineId && (!ids || ids.has(w.defines.routineId))).map((w) => w.id))
}

export async function agingView(workspaces, threads) {
  const { aging } = await readSettings()
  const stamps = await archiveStamps()
  const held = await definersHeld(workspaces)
  const now = Date.now()
  const out = new Map()
  for (const ws of workspaces) {
    const at = lastActivity(ws, threads)
    const idleMs = Math.max(0, now - at)
    const live = threads.some((t) => t.workspace?.id === ws.id && (t.running || t.canSend))
    const pinned = Boolean(ws.pinned) || held.has(ws.id)
    const unseen = unseenIn(ws, threads)
    const archiveAt = aging.idleDays > 0 && !pinned && !unseen ? at + aging.idleDays * DAY_MS : 0
    const since = archivedSince(ws, threads, stamps)
    const deleteAt = !pinned && (since || archiveAt) ? (since || archiveAt) + aging.deleteDays * DAY_MS : 0
    out.set(ws.id, {
      idleDays: Math.floor(idleMs / DAY_MS),
      archiveAt,
      archivedAt: since,
      deleteAt,
      archiveDays: aging.idleDays,
      deleteDays: aging.deleteDays,
      live,
      kept: ws.kept || '',
      aged: Boolean(ws.aged),
      pinned: Boolean(ws.pinned),
      unseen,
    })
  }
  return out
}

export async function tick({ reason = 'timer' } = {}) {
  if (ticking || !roster) return { ok: false, error: 'busy' }
  ticking = true
  const done = { ended: [], archived: [], deleted: [], kept: [], budget: [], swept: [] }
  try {
    const { aging } = await readSettings()
    lastTick = Date.now()
    const now = Date.now()
    // A roster that could not be read is not a machine with nothing running. With no threads
    // every chat's last activity falls back to its launch, so a failed scan used to make a
    // chat somebody was in the middle of look idle since the day it started — archived now,
    // and deleted a grace later if it happened to be clean. The pass is skipped instead, and
    // the catch below writes down why.
    const [snapshot, stamps] = await Promise.all([roster(), archiveStamps()])
    if (snapshot.scanFailed?.length) throw new Error(`The scan skipped ${snapshot.scanFailed.join(', ')}; nothing is aged on a partial roster`)
    // The roster's own list, rather than a second read beside it: one moment, one answer.
    const workspaces = snapshot.workspaces
    const threads = snapshot.threads || []
    const held = await definersHeld(workspaces)
    for (const ws of workspaces) {
      if (ws.status === 'preparing') continue
      const at = lastActivity(ws, threads)
      const idleMs = now - at
      const mine = threads.filter((t) => t.workspace?.id === ws.id)
      let since = archivedSince(ws, threads, stamps)
      // A routine's run that ended with nothing for the person: deleted a day after it ended,
      // under the same rule as every delete here — clean and pushed only. One that is not is
      // promoted to a chat instead, so work nobody saw is never kept where nobody can see it.
      // Until then it is aged as any chat is: its quiet session ended after `endIdleHours`.
      if (ws.routine && !ws.routine.promoted && QUIET_ENDINGS.has(ws.routine.outcome) && now - (ws.routine.endedAt || 0) >= RUN_KEEP_MS) {
        const res = await remove(ws, threads)
        if (res.ok) {
          done.deleted.push(ws.id)
          logDecision('deleted', { workspace: ws.id, name: ws.name, routine: ws.routine.id, run: ws.routine.runId, reason })
          logRunEvent(ws.routine.id, ws.routine.runId, 'deleted', { workspace: ws.id })
        } else {
          await markWorkspace(ws.id, { kept: res.error })
          // A chat now, so watched like one: its next message resumes it out of `dontAsk`.
          await promoteRun(ws.id).catch(() => {})
          done.kept.push(ws.id)
          logDecision('kept', { workspace: ws.id, name: ws.name, because: res.error, routine: ws.routine.id, promoted: true })
          logRunEvent(ws.routine.id, ws.routine.runId, 'promoted', { reason: 'kept', because: res.error })
        }
        continue
      }
      // End: a session quiet for `endIdleHours` gives its memory back, and its chat stays on the
      // list; the person's next message resumes it (launchers.md). Its prompt cache went cold an
      // hour after its last turn, so the resume costs nothing that waiting had not already.
      if (!since && aging.endIdleHours > 0 && endQuiet) {
        for (const t of mine) {
          if (!t.canSend || t.running) continue
          // A restart the supervisor has scheduled, or a handoff being written, is work in hand.
          if ((t.retry && !t.retry.exhausted) || t.handoff?.asking) continue
          // So is a command it left running in the background (hooks.md `backgroundTasks`): ending
          // the session takes the process with it — a dev server gone from under the person.
          if (t.backgroundTasks?.length) continue
          const quietAt = Math.max(at, startedAt ? await startedAt(t).catch(() => 0) : 0)
          if (now - quietAt < aging.endIdleHours * HOUR_MS) continue
          const r = await endQuiet(t).catch((err) => {
            failed('end-error', ws)(err)
            return { ended: false }
          })
          if (!r.ended) continue
          done.ended.push(ws.id)
          logDecision('ended', { workspace: ws.id, name: ws.name, quietHours: Math.floor((now - quietAt) / HOUR_MS), reason })
        }
      }
      // A pinned chat is the person's to put away: never archived or deleted here, whoever
      // archived it. Its quiet session was still ended above; that loses nothing.
      // So is a chat that defines a routine still there (routines.md): Change… reopens it.
      if (ws.pinned || held.has(ws.id)) continue
      // Archive: end a session that is sitting idle, and take its row off the list. Never a
      // session that is working — idle is measured on activity, so a working one is not idle.
      // One a person already archived is left alone: its grace started when they did.
      // A result the person has not seen holds the archive; its session above was still ended.
      if (!since && aging.idleDays > 0 && idleMs >= aging.idleDays * DAY_MS && !unseenIn(ws, threads)) {
        for (const t of mine) {
          if (t.running) continue
          if (t.canSend && endSession) await endSession(t).catch(failed('end-error', ws))
        }
        if (archive && mine.length) await archive(mine.map((t) => t.id)).catch(failed('archive-error', ws))
        await markWorkspace(ws.id, { aged: now })
        since = now
        done.archived.push(ws.id)
        logDecision('archived', { workspace: ws.id, name: ws.name, idleDays: Math.floor(idleMs / DAY_MS), reason })
      }
      // Delete: only clean and pushed, and only after the second grace, counted from the
      // archive whoever made it. The refusal is the store's, with its reason; it is written on
      // the manifest so the row can say it.
      if (since && now - since >= aging.deleteDays * DAY_MS) {
        const res = await remove(ws, threads)
        if (res.ok) {
          done.deleted.push(ws.id)
          logDecision('deleted', { workspace: ws.id, name: ws.name, idleDays: Math.floor(idleMs / DAY_MS), archivedDays: Math.floor((now - since) / DAY_MS), reason })
        } else {
          if (ws.kept !== res.error) await markWorkspace(ws.id, { kept: res.error })
          done.kept.push(ws.id)
          logDecision('kept', { workspace: ws.id, name: ws.name, because: res.error })
        }
      }
    }
    // The disk budget: oldest-idle first, clean and pushed only, until under.
    if (aging.diskBudgetGB > 0) {
      let used = await sizeOf(WORKSPACES_DIR)
      const budget = aging.diskBudgetGB * 1024 * 1024 * 1024
      if (used > budget) {
        const candidates = workspaces
          .filter((w) => w.status !== 'preparing' && !w.pinned && !held.has(w.id) && !done.deleted.includes(w.id))
          .map((w) => ({ ws: w, at: lastActivity(w, threads) }))
          .sort((a, b) => a.at - b.at)
        for (const { ws } of candidates) {
          if (used <= budget) break
          const live = threads.some((t) => t.workspace?.id === ws.id && t.running)
          if (live) continue
          const size = await sizeOf(ws.dir)
          const res = await remove(ws, threads)
          if (res.ok) {
            used -= size
            done.budget.push(ws.id)
            logDecision('budget', { workspace: ws.id, name: ws.name, freedBytes: size, reason })
          } else {
            logDecision('kept', { workspace: ws.id, name: ws.name, because: res.error, budget: true })
          }
        }
      }
    }
    // After this pass's deletes, so an entry one of them left is freed now rather than tomorrow.
    if (now - lastSweep >= SWEEP_MS) {
      lastSweep = now
      const swept = await sweepWorktrees().catch((err) => [{ mirror: '', error: String(err?.message || err) }])
      for (const s of swept) {
        if (s.error) logDecision('sweep-error', { mirror: s.mirror, error: s.error })
        else logDecision('swept', { mirror: s.mirror, locked: s.locked.length, freed: s.freed, ...(s.failed.length ? { failed: s.failed } : {}), reason })
        done.swept.push(s.mirror)
      }
    }
    return { ok: true, ...done }
  } catch (err) {
    logDecision('tick-error', { error: String(err?.message || err) })
    return { ok: false, error: String(err?.message || err) }
  } finally {
    ticking = false
  }
}

/**
 * The delete path's hook: end every session this workspace carries, through the launcher.
 * A session that will not stop is thrown, which refuses the delete — it used to be logged and
 * the folder removed anyway, out from under a process still running in it. No look at
 * `canSend`: `endSession` asks the launcher whether the unit is alive, and a session skipped
 * here is one left running in a directory that is about to go.
 */
const endSessions = (threads) => async (m) => {
  if (!endSession) return
  for (const t of threads) {
    if (t.workspace?.id !== m.id) continue
    await endSession(t).catch((err) => {
      throw new Error(`Its session would not stop: ${String(err?.message || err)}`)
    })
  }
}

/**
 * One workspace's delete, as an answer and never a throw: a refusal from the store, or a
 * session that would not stop, is that workspace kept with its reason, and the pass goes on
 * to the next one.
 */
async function remove(ws, threads) {
  try {
    return await deleteWorkspace(ws.id, { force: false, endSession: endSessions(threads) })
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
}

/**
 * A step that failed inside a pass goes in the log and the pass carries on: one session that
 * would not stop must not strand every workspace after it. It used to be dropped, and the
 * log then read `archived` over a chat whose session was still running.
 */
const failed = (event, ws) => (err) => logDecision(event, { workspace: ws.id, name: ws.name, error: String(err?.message || err) })

/** Called from `serve.mjs` and nowhere else. The first tick is a minute in, after the hook store is warm. */
export function startAging() {
  if (timer) return
  setTimeout(() => tick(), 60 * 1000)
  timer = setInterval(() => tick(), TICK_MS)
}

export function stopAging() {
  clearInterval(timer)
  timer = null
}

export async function readAgingLog({ limit = 200 } = {}) {
  try {
    const text = await fsp.readFile(LOG_FILE, 'utf8')
    return text.split('\n').filter(Boolean).slice(-limit)
  } catch {
    return []
  }
}
