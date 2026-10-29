/**
 * Unpushed work, per chat and repo, for the chat list's chip (ui.md *Chat list*;
 * workspaces-git.md *Unpushed work*).
 *
 * A repo is unpushed when its checkout has uncommitted changes, or commits the remote does not
 * have: past `origin/<branch>` once the branch was pushed, else past `origin/<base>`. Each
 * workspace keeps `repo id -> dirtySince`: set when a check first finds the repo unpushed, back
 * to null the moment one finds it clean. The chip lights once `dirtySince` is `UNPUSHED_AFTER_MS`
 * old, worked out at each roster rather than stored, so it turns on with no timer of its own.
 *
 * Checked on the host through `worktreeStatus` — never in the session's container, where git
 * would run the checkout's own config (workspaces-git.md), and an asleep chat has none. Asked
 * for after an Edit, Write or Bash call finishes (`toolDone`, hooks.mjs), debounced so a burst
 * is one check; when a shell drawer into the chat goes quiet; and by a slow poll, for whatever
 * neither saw. A check that fails keeps the last answer: `strict` throws instead of guessing.
 *
 * Kept in Outpost's data dir, not beside the manifest: the workspace folder is mounted into
 * the chat's container, writable, and a deploy restarting the server must not restart every
 * clock.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJsonFile } from '../lib/fsutil.mjs'
import { hookEvents } from '../state/hooks.mjs'
import { worktreeStatus } from './git.mjs'
import { workspaceById, workspaceForSession, workspaceManifests } from './index.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.OUTPOST_DATA || path.join(here, '..', '..', 'data')
const STORE_FILE = path.join(DATA_DIR, 'unpushed.json')
/** How long a repo is unpushed before the chip says so: a reminder, not a running commentary. */
export const UNPUSHED_AFTER_MS = 30 * 60_000
/** A burst of edits is one check. */
const DEBOUNCE_MS = 5000
/** Catches what no hook or drawer saw. Every ready, unarchived workspace: about 40 ms a repo. */
const POLL_MS = 10 * 60_000
/** The calls that can change a checkout. */
const CHANGES = new Set(['Edit', 'Write', 'Bash'])

/** @type {Map<string, Record<string, number | null>> | null} workspace id -> repo id -> dirtySince */
let store = null
let writing = Promise.resolve()
/** @type {Map<string, NodeJS.Timeout>} workspace id -> the debounced check */
const timers = new Map()
/** @type {Map<string, Promise<void>>} workspace id -> the check running */
const running = new Map()
/** Workspace ids asked for again while their check ran. */
const again = new Set()
let poll = null

async function load() {
  if (store) return store
  // Unreadable starts empty, set aside rather than flushed over: every clock restarts, and
  // the next check per repo puts back what is unpushed now.
  const raw = await readJsonFile(STORE_FILE, { aside: true }).catch((err) => {
    console.warn(`[outpost] ${err.message}; starting with no unpushed clocks`)
    return undefined
  })
  store = new Map()
  for (const [id, repos] of Object.entries(raw?.workspaces || {})) {
    if (!repos || typeof repos !== 'object') continue
    const clean = {}
    for (const [repo, since] of Object.entries(repos)) clean[repo] = Number.isFinite(since) && since > 0 ? since : null
    store.set(id, clean)
  }
  return store
}

function flush() {
  const workspaces = Object.fromEntries(store)
  writing = writing.then(async () => {
    try {
      await fsp.mkdir(DATA_DIR, { recursive: true })
      const tmp = STORE_FILE + '.tmp'
      await fsp.writeFile(tmp, JSON.stringify({ version: 1, workspaces }, null, 2))
      await fsp.rename(tmp, STORE_FILE)
    } catch (err) {
      console.warn(`[outpost] could not save unpushed clocks: ${err.message}`)
    }
  })
  return writing
}

/**
 * Check every repo of one workspace and move its clocks. A repo whose check fails keeps the
 * clock it had; one no longer in the workspace is dropped.
 */
async function checkNow(m) {
  const map = await load()
  const before = map.get(m.id) || {}
  const after = {}
  const at = Date.now()
  for (const entry of m.repos || []) {
    const was = before[entry.id] ?? null
    try {
      const s = await worktreeStatus(entry.path, entry.base, entry.branch, { strict: true })
      after[entry.id] = !s.clean || !s.pushed ? (was ?? at) : null
    } catch {
      if (entry.id in before) after[entry.id] = was
    }
  }
  if (JSON.stringify(after) === JSON.stringify(before)) return
  if (Object.keys(after).length) map.set(m.id, after)
  else map.delete(m.id)
  await flush()
}

/** Check a workspace now. One per workspace at a time; one asked for meanwhile runs once after it. */
export async function checkUnpushed(id) {
  if (running.has(id)) {
    again.add(id)
    return running.get(id)
  }
  const job = (async () => {
    try {
      const m = await workspaceById(id)
      if (m?.status === 'ready') await checkNow(m)
    } catch (err) {
      console.warn(`[outpost] unpushed check for ${id}: ${err.message}`)
    } finally {
      running.delete(id)
      if (again.delete(id)) void checkUnpushed(id)
    }
  })()
  running.set(id, job)
  return job
}

/** A check `DEBOUNCE_MS` after the last ask for this workspace. */
export function requestCheck(id) {
  if (!id) return
  clearTimeout(timers.get(id))
  const t = setTimeout(() => {
    timers.delete(id)
    void checkUnpushed(id)
  }, DEBOUNCE_MS)
  t.unref?.()
  timers.set(id, t)
}

async function onToolDone({ sessionId, cwd, tools }) {
  if (!tools.some((t) => CHANGES.has(t))) return
  const m = await workspaceForSession(sessionId, cwd)
  if (m) requestCheck(m.id)
}

/** Every ready workspace aging has not archived, one after another; a deleted one's clocks go. */
async function pollAll() {
  const all = await workspaceManifests()
  const map = await load()
  const ids = new Set(all.map((m) => m.id))
  let dropped = false
  for (const id of [...map.keys()]) if (!ids.has(id)) dropped = map.delete(id) || dropped
  if (dropped) await flush()
  for (const m of all) if (m.status === 'ready' && !m.aged) await checkUnpushed(m.id)
}

/** Listen for finished calls and start the poll. Called once, by the API at boot. */
export function startUnpushed() {
  if (poll) return
  hookEvents.on('toolDone', (e) => {
    onToolDone(e).catch(() => {})
  })
  poll = setInterval(() => {
    pollAll().catch((err) => console.warn(`[outpost] unpushed poll: ${err.message}`))
  }, POLL_MS)
  poll.unref?.()
}

/**
 * Each repo of a workspace that has been unpushed `UNPUSHED_AFTER_MS` or longer, as
 * `repo id -> true`; any other repo is absent. Only what a check found: never a guess.
 */
export async function unpushedRepos(id, now = Date.now()) {
  const repos = (await load()).get(id) || {}
  const out = {}
  for (const [repo, since] of Object.entries(repos)) if (since && now - since >= UNPUSHED_AFTER_MS) out[repo] = true
  return out
}
