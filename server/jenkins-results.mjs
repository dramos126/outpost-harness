/**
 * Hearing back from Jenkins: which builds a chat is owed the result of, the results as they
 * arrive, and what happens to each (docs/proposals/settings.md, phase 3, step 1).
 *
 * A **watch** is a build a chat cares about: one it started (`jenkins_build`, or a custom
 * push's Jenkins step) — followed by its queue item, then its number — or a commit its push
 * landed, which whatever job builds that commit will report. A **result** reaches here two
 * ways: Jenkins posts it to `/api/jenkins/notify` at the end of the build, and the poller asks
 * Jenkins about the builds Outpost started and the commits it pushed, so a job that does not
 * post is still heard. Either
 * may come first; a build is delivered once.
 *
 * Delivery is a rule, not a fixed act, so a later handler — a local model deciding whether a
 * result is worth a Claude turn (the proposal) — is one more branch here:
 * - a chat waiting in `jenkins_wait` gets it as the tool's answer, and no turn is spent;
 * - otherwise the repo's `jenkinsWake` decides: `failure` (the default) wakes the chat only
 *   for a build that did not succeed, `always` for any, `never` for none;
 * - a chat that was waiting when Outpost restarted — its own deploy restarts Outpost — is
 *   woken whatever the result: it asked, and its tool call died with the old server.
 *
 * Kept in `jenkins-builds.json` in the data dir, so a result posted to the new server after a
 * deploy finds the watch the old one made.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readJsonFile } from './lib/fsutil.mjs'
import { listRepos, repoById } from './workspaces/catalogue.mjs'
import { jenkinsBuildOfCommit, jenkinsBuildResult, jenkinsJobIndex, jenkinsJobInfo, jenkinsQueueItem, jobAllowed, remoteFor, repoKey } from './integrations.mjs'
import { notify } from './notify/index.mjs'
import { ensureMirror, git, mirrorPath } from './workspaces/git.mjs'
import { refreshOnBuild } from './workspaces/datasets.mjs'
import * as structured from './launchers/structured.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.OUTPOST_DATA || path.join(here, '..', 'data')
const FILE = path.join(DATA_DIR, 'jenkins-builds.json')

/** A watch nobody has heard back on in this long is let go: the build is not coming. One that
 *  has heard stays while its result is kept (`poll`). */
const WATCH_TTL_MS = 6 * 60 * 60 * 1000
/** How often the poller asks Jenkins about the builds Outpost started. */
const POLL_MS = 20 * 1000
/** Results kept, newest first: what `jenkins_wait` can answer from, and what no chat owned. */
const KEEP_RESULTS = 100
/** A wait stays inside the session's tool timeout (launchers.md: ten and a half minutes). */
export const WAIT_MS = 9 * 60 * 1000

export const WAKE_RULES = Object.freeze(['failure', 'always', 'never'])

let state = null
/** watch id -> the `jenkins_wait` calls standing on it */
const waiters = new Map()
let writing = Promise.resolve()

async function load() {
  if (state) return state
  // A file that will not parse is set aside: a lost watch costs one result, a server that will
  // not read its store costs every one after.
  const raw = await readJsonFile(FILE, { aside: true })
  state = {
    watches: Array.isArray(raw?.watches) ? raw.watches : [],
    results: Array.isArray(raw?.results) ? raw.results : [],
    announced: raw?.announced && typeof raw.announced === 'object' ? raw.announced : {},
    failureChats: raw?.failureChats && typeof raw.failureChats === 'object' ? raw.failureChats : {},
  }
  // A wait standing when the last server stopped cannot be answered by this one; the flag
  // stays, so its result wakes the chat (above).
  return state
}

function persist() {
  const snapshot = JSON.stringify({ version: 1, ...state }, null, 2)
  writing = writing.then(async () => {
    try {
      await fsp.mkdir(DATA_DIR, { recursive: true })
      await fsp.writeFile(`${FILE}.tmp`, snapshot)
      await fsp.rename(`${FILE}.tmp`, FILE)
    } catch (err) {
      console.warn('[outpost] could not save the Jenkins builds:', err?.message || err)
    }
  })
  return writing
}

const keyOf = (r) => `${r.job}#${r.number}`
const shortSha = (s) => String(s || '').slice(0, 7)

/** A build a chat started: followed from its queue item until it has a number and a result. */
export async function watchBuild({ workspaceId, repoId = '', repoName = '', job, queueUrl = '', number = 0 }) {
  await load()
  const w = { id: randomBytes(4).toString('hex'), workspaceId, repoId, repoName, job, queueUrl, number, at: Date.now(), heard: [] }
  state.watches.push(w)
  await persist()
  hooks.changed()
  return w
}

/** A commit a chat's push landed: any job's build of it is this chat's to hear about. */
export async function watchCommit({ workspaceId, repoId, repoName, commit, branch = '', branches = [] }) {
  await load()
  if (!/^[0-9a-f]{7,40}$/.test(String(commit || ''))) return null
  // `branches`, every branch the push updated, is where the poller looks for a build of it in a
  // multibranch job (`commitJobs`).
  const w = { id: randomBytes(4).toString('hex'), workspaceId, repoId, repoName, commit, branch, branches: branches.map(String).filter(Boolean), at: Date.now(), heard: [] }
  state.watches.push(w)
  await persist()
  hooks.changed()
  return w
}

/** The posted body, made safe to keep, or null for one missing what makes it a build. */
export function normaliseResult(raw) {
  const job = String(raw?.job || '').trim().slice(0, 200)
  const number = Number(raw?.number)
  const result = String(raw?.result || '').trim().toUpperCase().slice(0, 20)
  if (!job || !Number.isInteger(number) || number < 1 || !result) return null
  const commit = String(raw?.commit || '').trim().toLowerCase()
  return {
    job,
    number,
    result,
    commit: /^[0-9a-f]{7,40}$/.test(commit) ? commit : '',
    branch: String(raw?.branch || '').trim().slice(0, 200),
    url: /^https?:\/\//.test(String(raw?.url || '')) ? String(raw.url).slice(0, 500) : '',
    failed: (Array.isArray(raw?.failed) ? raw.failed : []).map((s) => String(s).slice(0, 100)).filter(Boolean).slice(0, 20),
  }
}

/** Which watches a result answers: the build itself, or the commit it built. */
function matches(w, r) {
  if (w.heard.includes(keyOf(r))) return false
  if (w.job) return w.job === r.job && w.number === r.number
  return Boolean(w.commit && r.commit && (r.commit.startsWith(w.commit) || w.commit.startsWith(r.commit)))
}

/**
 * A build's result, from the webhook or the poller. Kept, matched to the watches it answers,
 * and delivered to each. Answers what was done with it, for the caller's log.
 */
export async function recordResult(raw, { source = 'webhook' } = {}) {
  await load()
  const r = normaliseResult(raw)
  if (!r) return { ok: false, error: 'A result needs job, number and result' }
  const known = state.results.find((x) => keyOf(x) === keyOf(r))
  if (known) {
    // The second report of the same build — webhook and poller both — fills in what the first
    // lacked and is delivered to nobody again.
    if (!known.commit && r.commit) known.commit = r.commit
    if (!known.failed.length && r.failed.length) known.failed = r.failed
  } else {
    state.results.unshift({ ...r, at: Date.now(), source })
    state.results.length = Math.min(state.results.length, KEEP_RESULTS)
  }
  const delivered = []
  const kept = known || state.results[0]
  for (const w of state.watches.filter((w) => matches(w, r))) {
    w.heard.push(keyOf(r))
    if (w.job) w.done = true
    delivered.push(await deliver(w, kept))
  }
  // A build that *contains* a chat's commit rather than being it: a job that builds main one
  // build at a time takes several chats' pushes in one go, and builds the last — so the chat
  // whose push came first heard nothing and its watch quietly expired. A commit watch that has
  // heard no build yet is answered by one whose commit has it as an ancestor, asked of the
  // repo's mirror (fetched once, if it does not have the built commit yet).
  if (r.commit) {
    const seen = new Map()
    for (const w of state.watches.filter((w) => !w.job && w.commit && w.repoId && !w.heard.length)) {
      if (!(await contains(w.repoId, w.commit, r.commit, seen))) continue
      w.heard.push(keyOf(r))
      delivered.push(await deliver(w, kept, { contained: true }))
    }
  }
  // A failure no chat owns — a nightly run, a push from somewhere else — can start one.
  const started = !known && !delivered.length && FAILED.has(r.result) ? await failureChats(kept) : []
  // A job that makes a read dataset (its `refreshedBy`) succeeded: the shared copy is synced in
  // the background, so the next chat reads what it just made (workspaces/datasets.mjs).
  if (!known && r.result === 'SUCCESS') refreshOnBuild(r.job).catch(() => {})
  await persist()
  if (delivered.length || started.length) hooks.changed()
  return { ok: true, result: r, delivered, started }
}

/** Results that mean something needs looking at. ABORTED is somebody's choice, not a fault. */
const FAILED = new Set(['FAILURE', 'UNSTABLE'])

/**
 * A failed build no chat was waiting on, for each repo that asked for it
 * (`jenkinsFailureChats`, a job or a multibranch job on the repo's page): the chat already
 * looking into that job's failures is told of this one, or a new chat is started to find out
 * why — so a job failing every night is one chat, not one a night. Its permission mode is
 * `dontAsk` and nobody is there at its start, so it reads and reports; it does not push.
 * Discord hears a line either way.
 */
async function failureChats(r) {
  const out = []
  state.failureChats ||= {}
  for (const repo of await listRepos()) {
    if (!jobAllowed(r.job, repo.jenkinsFailureChats)) continue
    const key = `${repo.id}\u0000${r.job.split('/')[0]}`
    const prior = state.failureChats[key]
    const live = prior ? (await hooks.workspaces()).find((w) => w.id === prior.workspaceId && w.status === 'ready') : null
    if (live) {
      const rec = (await structured.allRecords()).filter((x) => x.workspaceId === live.id).sort((a, b) => b.startedAt - a.startedAt)[0]
      const sent = rec ? await structured.sendPrompt(rec, failureMessage(r, { again: true })) : { ok: false }
      if (sent.ok) {
        out.push({ repo: repo.name, workspaceId: live.id, how: 'told' })
        await notify({ event: 'jenkins-failure-chat', job: r.job, number: r.number, result: r.result, label: repo.name, again: true })
        continue
      }
    }
    if (!hooks.startChat) continue
    try {
      const tools = [...new Set([...(repo.tools?.length ? repo.tools : ['memory', 'catalogue']), 'jenkins:read'])]
      const m = await hooks.startChat({ name: `${r.job} #${r.number} ${r.result.toLowerCase()}`, repos: [{ id: repo.id }], prompt: failureMessage(r), permissionMode: 'dontAsk', tools })
      state.failureChats[key] = { workspaceId: m.id, at: Date.now(), build: keyOf(r) }
      out.push({ repo: repo.name, workspaceId: m.id, how: 'started' })
      await notify({ event: 'jenkins-failure-chat', job: r.job, number: r.number, result: r.result, label: repo.name })
    } catch (err) {
      console.warn(`[outpost] could not start a chat for ${keyOf(r)}: ${err?.message || err}`)
    }
  }
  return out
}

/**
 * What a failure chat is sent: the build, and to find out why and say so — not to change
 * anything yet. A note the chat draws and a reminder the session reads, as a wake is, even as
 * a new chat's first message: words of Outpost's drawn as the person's is the `/addRepo` bug.
 */
function failureMessage(r, { again = false } = {}) {
  const why = again
    ? 'The Jenkins job this chat looks into has failed again.'
    : 'No chat was waiting on this Jenkins build, so Outpost started this chat to find out why it failed.'
  return [
    `<outpost-note tone="failure">Jenkins: ${describeResult(r)}</outpost-note>`,
    `<system-reminder>Outpost sent this, not the person. ${why} ${describeResult(r)}.${r.url ? ` ${r.url}` : ''} Read the failure with jenkins_build_log and jenkins_test_report, look at the code it points to, and say in a few lines what failed, why, and what would fix it. Do not change or push anything — the person decides what happens next.</system-reminder>`,
  ].join('\n')
}

/**
 * Whether `commit` has `ancestor` in its history, in this repo's mirror. A commit the mirror
 * does not have is fetched for once per result (`seen`); one it still does not have afterwards
 * is not this repo's, and contains nothing of it.
 */
async function contains(repoId, ancestor, commit, seen) {
  const dir = mirrorPath(repoId)
  const has = () => git(['cat-file', '-e', `${commit}^{commit}`], { cwd: dir }).then(() => true, () => false)
  if (!seen.has(repoId)) {
    let ok = await has()
    if (!ok) {
      const recipe = await repoById(repoId)
      if (recipe) await ensureMirror(recipe, () => {}, await remoteFor(recipe)).catch(() => {})
      ok = await has()
    }
    seen.set(repoId, ok)
  }
  if (!seen.get(repoId)) return false
  return git(['merge-base', '--is-ancestor', ancestor, commit], { cwd: dir }).then(() => true, () => false)
}

/** The line a result is told in: `webapp-deploy #42 FAILURE — failed at Test`. */
export function describeResult(r) {
  return `${r.job} #${r.number} ${r.result}${r.failed?.length ? ` — failed at ${r.failed.join(', ')}` : ''}`
}

async function deliver(w, r, { contained = false } = {}) {
  const standing = waiters.get(w.id)
  if (standing?.length) {
    waiters.delete(w.id)
    w.waiting = false
    for (const resolve of standing) resolve(r)
    return { watch: w.id, to: 'wait' }
  }
  const recipe = w.repoId ? await repoById(w.repoId) : null
  const rule = WAKE_RULES.includes(recipe?.jenkinsWake) ? recipe.jenkinsWake : 'failure'
  const wake = w.waiting || rule === 'always' || (rule === 'failure' && r.result !== 'SUCCESS')
  if (!wake) return { watch: w.id, to: 'none', rule }
  const asked = Boolean(w.waiting)
  w.waiting = false
  const rec = (await structured.allRecords()).filter((x) => x.workspaceId === w.workspaceId).sort((a, b) => b.startedAt - a.startedAt)[0]
  if (!rec) return { watch: w.id, to: 'none', error: 'no session in that chat' }
  const sent = await structured.sendPrompt(rec, wakeMessage(w, r, { asked, contained }))
  return { watch: w.id, to: sent.ok ? 'wake' : 'none', error: sent.error }
}

/**
 * What a woken chat is sent. The note is what the chat shows — the reader draws it as a note,
 * never as a message of the person's (harnesses.md); the reminder is what the session reads
 * and the reader hides.
 */
export function wakeMessage(w, r, { asked = false, contained = false } = {}) {
  const ok = r.result === 'SUCCESS'
  const why = w.job
    ? 'the build you started'
    : contained
      ? `a build of ${shortSha(r.commit)}, which includes your push of ${shortSha(w.commit)}${w.branch ? ` from ${w.branch}` : ''} with later work on top,`
      : `the build of ${shortSha(w.commit)}${w.branch ? ` on ${w.branch}` : ''} that your push triggered`
  const tone = ok ? 'success' : 'failure'
  const ask = ok
    ? 'Tell the person in a line; nothing else is needed.'
    : 'Find out what failed — jenkins_build_log and jenkins_test_report if this chat has them, else the console — and fix it if it is your work; if it is not something you can fix, say so in a line.'
  return [
    `<outpost-note tone="${tone}">Jenkins: ${describeResult(r)}</outpost-note>`,
    `<system-reminder>Outpost sent this, not the person: ${why} has finished — ${describeResult(r)}.${r.url ? ` ${r.url}` : ''}${asked ? ' You were waiting on it when Outpost restarted, so your wait was cut off; this is its answer.' : ''} ${ask}</system-reminder>`,
  ].join('\n')
}

/**
 * The `jenkins_wait` tool: the result of one of this chat's builds, as soon as it is known.
 * `job` (and `number`) pick the watch; with neither, the chat's most recent. A result already
 * in — delivered while the chat was not waiting — is answered at once. Resolves null after
 * `WAIT_MS`, or the moment `signal` aborts — the call that is waiting hung up (an interrupted
 * turn) — with the watch left standing and the wait withdrawn. Before that withdrawal, a
 * dropped call kept its place and the result was handed to nobody: no answer, and no wake.
 */
export async function waitFor(workspaceId, { job = '', number = 0 } = {}, ms = WAIT_MS, signal = null) {
  await load()
  const ours = state.watches
    .filter((w) => w.workspaceId === workspaceId && (!job || w.job === job) && (!number || w.number === Number(number)))
    .sort((a, b) => b.at - a.at)
  const w = ours[0]
  if (!w) return { error: job ? `This chat has started or pushed nothing that ${job} builds` : 'This chat has started no build and pushed nothing to wait on' }
  const heard = state.results.find((r) => w.heard.includes(keyOf(r)))
  if (heard) return { watch: w, result: heard }
  if (signal?.aborted) return { watch: w, result: null }
  w.waiting = true
  await persist()
  let mine
  let timer
  const result = await new Promise((resolve) => {
    mine = resolve
    waiters.set(w.id, [...(waiters.get(w.id) || []), resolve])
    timer = setTimeout(() => resolve(null), ms)
    signal?.addEventListener('abort', () => resolve(null), { once: true })
  })
  clearTimeout(timer)
  if (!result) {
    // Timed out or hung up: this wait is withdrawn, and the watch reverts to the repo's rule
    // unless another wait still stands on it.
    const rest = (waiters.get(w.id) || []).filter((f) => f !== mine)
    if (rest.length) waiters.set(w.id, rest)
    else {
      waiters.delete(w.id)
      w.waiting = false
      await persist()
    }
  }
  return { watch: w, result }
}

/** One pass of the poller: each build Outpost started that has no result yet, asked about. */
export async function poll() {
  await load()
  const now = Date.now()
  let changed = false
  for (const w of state.watches) {
    if (!w.job || w.done || now - w.at > WATCH_TTL_MS) continue
    try {
      if (!w.number && w.queueUrl) {
        const q = await jenkinsQueueItem(w.queueUrl)
        if (q.cancelled) {
          w.done = true
          changed = true
          continue
        }
        if (q.number) {
          w.number = q.number
          changed = true
        }
      }
      if (!w.number) continue
      const b = await jenkinsBuildResult(w.job, w.number)
      if (b.result) await recordResult(b, { source: 'poll' })
    } catch {
      /* Jenkins unreachable or not configured: the webhook may still answer, and the next pass tries */
    }
  }
  await pollCommits(now)
  const before = state.watches.length
  // A watch that has its result is kept as long as the result is: `jenkins_wait` answers from
  // it, and the chat's Builds list is drawn from it — let go with the rest at six hours, every
  // chat's list emptied six hours after its last push. Only one still unheard expires.
  const kept = new Set(state.results.map(keyOf))
  state.watches = state.watches.filter((w) => (w.heard.length ? w.heard.some((k) => kept.has(k)) : now - w.at <= WATCH_TTL_MS))
  if (changed || state.watches.length !== before) {
    await persist()
    hooks.changed()
  }
}

/** How often a pushed commit that has heard nothing is looked for: each look is a call per job and branch. */
const COMMIT_POLL_MS = 60 * 1000
/** job -> whether it is multibranch, asked once per server: a job does not change kind. */
const multibranch = new Map()

/**
 * The jobs a commit watch's build could be under: each job its repo names, and for a
 * multibranch job, the branches the push updated (`docs-site/main`). A job that names a
 * branch already is taken as it is.
 */
async function commitJobs(repo, w) {
  const out = []
  for (const job of repo?.jenkinsJobs || []) {
    if (job.includes('/')) {
      out.push(job)
      continue
    }
    if (!multibranch.has(job)) multibranch.set(job, (await jenkinsJobInfo(job)).branches.length > 0)
    if (!multibranch.get(job)) out.push(job)
    else for (const b of w.branches?.length ? w.branches : [w.branch].filter(Boolean)) out.push(`${job}/${encodeURIComponent(b)}`)
  }
  return out
}

/**
 * A push to a job that does not post its result was heard only by a wait that asked Jenkins
 * itself; with no wait, the chat never heard. So the poller also looks, once a minute, for a
 * build of each pushed commit that has heard nothing, on the jobs its repo names. Whatever
 * finds a build first — this or the webhook — delivers it; `recordResult` delivers once.
 */
async function pollCommits(now) {
  for (const w of state.watches) {
    if (w.job || w.heard.length || !w.commit || !w.repoId || now - w.at > WATCH_TTL_MS) continue
    if (now - (w.polledAt || 0) < COMMIT_POLL_MS) continue
    w.polledAt = now
    try {
      for (const job of await commitJobs(await repoById(w.repoId), w)) {
        const number = await jenkinsBuildOfCommit(job, w.commit)
        if (!number || state.results.some((r) => r.job === job && r.number === number)) continue
        const b = await jenkinsBuildResult(job, number)
        if (b.result) await recordResult({ ...b, commit: w.commit }, { source: 'poll' })
        if (w.heard.length) break
      }
    } catch {
      /* as above: the webhook may still answer, and the next pass tries */
    }
  }
}

/** How often Jenkins is asked whether a job has started building a repo that does not name it. */
const DISCOVER_MS = 60 * 60 * 1000

/**
 * New pipelines, told once: a job whose builds check out a catalogued repo that does not name
 * it among its Jenkins jobs gets one Discord message — its builds and logs are readable by that
 * repo's chats already, and starting it waits for the owner (integrations-ci.md). Remembered in
 * the store (`announced`, `repoId -> jobs`), so a job is raised once, not every hour; a job
 * the repo has since named needs no message. Answers what it raised.
 */
export async function discoverJobs() {
  await load()
  let index
  try {
    index = await jenkinsJobIndex()
  } catch {
    return [] // Jenkins unreachable or not set up: the next pass asks again
  }
  state.announced ||= {}
  const raised = []
  for (const repo of await listRepos()) {
    const key = repoKey(repo.url)
    const told = new Set(state.announced[repo.id] || [])
    for (const job of index.filter((j) => j.repos.includes(key)).map((j) => j.name)) {
      if (jobAllowed(job, repo.jenkinsJobs) || told.has(job)) continue
      told.add(job)
      raised.push({ repo: repo.name, job })
      await notify({ event: 'jenkins-new-job', job, label: repo.name })
    }
    state.announced[repo.id] = [...told]
  }
  if (raised.length) await persist()
  return raised
}

let timer = null
let discoverTimer = null
/** Started by `serve.mjs` alone, like the other supervisors: only a running server polls. */
export function startJenkinsPoller() {
  if (timer) return
  timer = setInterval(() => poll().catch(() => {}), POLL_MS)
  timer.unref?.()
  discoverTimer = setInterval(() => discoverJobs().catch(() => {}), DISCOVER_MS)
  discoverTimer.unref?.()
  // And once soon after a start, so a pipeline made while Outpost was down is not an hour late.
  setTimeout(() => discoverJobs().catch(() => {}), 60 * 1000).unref?.()
}

/** The results and the watches, for the page and for a person reading the store. */
export async function jenkinsState() {
  await load()
  return { watches: state.watches, results: state.results }
}

/** How many builds a chat's Workspace section is handed; it shows three and folds the rest. */
const BUILDS_SHOWN = 10

/** commit -> its subject line, read once from a mirror: the roster asks every few seconds. */
const subjects = new Map()

/** A commit's subject, from the repo's mirror, or `''` for one the mirror does not have (yet). */
async function subjectOf(repoId, commit) {
  if (!repoId || !commit) return ''
  const key = `${repoId}:${commit}`
  if (subjects.has(key)) return subjects.get(key)
  const s = (await git(['log', '-1', '--format=%s', commit], { cwd: mirrorPath(repoId) }).catch(() => '')).trim()
  // A miss is not cached: the mirror may fetch the commit on the next push or start.
  if (s) subjects.set(key, s)
  return s
}

/**
 * A chat's builds, for its Workspace section: newest first, the last ten — it shows three and
 * folds the rest. A build it started shows from the moment it is queued; a push shows as
 * "waiting for a build" until a job builds it, then as each build that did — the waiting row
 * only where the push's repo names a job. `[{ job, number,
 * result, url, commit, subject, why, at }]` — `result` `QUEUED` or `RUNNING` until there is
 * one, `why` `started` or `push`, `subject` the commit's first line where the mirror has it.
 */
export async function buildsFor(workspaceId) {
  await load()
  const out = []
  for (const w of state.watches.filter((x) => x.workspaceId === workspaceId)) {
    const heard = state.results.filter((r) => w.heard.includes(keyOf(r)))
    const why = w.job ? 'started' : 'push'
    if (heard.length) {
      for (const r of heard) out.push({ job: r.job, number: r.number, result: r.result, url: r.url, commit: r.commit || w.commit || '', repoId: w.repoId, why, at: r.at })
    } else if (w.heard.length) {
      // Heard, and the result has since left the hundred kept: not a build still running.
      continue
    } else if (w.job) {
      out.push({ job: w.job, number: w.number || 0, result: w.number ? 'RUNNING' : 'QUEUED', url: '', commit: '', repoId: w.repoId, why, at: w.at })
    } else if ((await repoById(w.repoId))?.jenkinsJobs?.length) {
      // A repo that names no job has nothing to wait for: the row would wait out the watch's
      // six hours. The watch itself stays, so a build from a job it does not name still lands.
      out.push({ job: '', number: 0, result: 'WAITING', url: '', commit: w.commit, repoId: w.repoId, why, at: w.at })
    }
  }
  // A build that contained several of the chat's pushes answered each of them; it is one build.
  const seen = new Set()
  const once = out.filter((b) => {
    if (!b.job) return true
    const k = `${b.job}#${b.number}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  const shown = once.sort((a, b) => b.at - a.at).slice(0, BUILDS_SHOWN)
  for (const b of shown) {
    b.subject = await subjectOf(b.repoId, b.commit)
    delete b.repoId
  }
  return shown
}

/**
 * What the rest of the server is handed in rather than imported, since it imports this:
 * `changed()` when a chat's builds moved (the events loop pushes a fresh roster), and
 * `startChat(spec)` to start one (the workspace layer's `createWorkspace`).
 */
let hooks = { changed: () => {}, startChat: null, workspaces: async () => [] }
export function configureJenkins(next) {
  hooks = { ...hooks, ...next }
}
