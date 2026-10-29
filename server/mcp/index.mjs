/**
 * Outpost as an MCP server to its own sessions.
 *
 * A session started in a workspace is launched with `--mcp-config` pointing at `POST /mcp` on
 * this server with a per-workspace bearer token. The tools it sees run *here*, with Outpost's
 * secrets, and hand back a result; the session never holds a credential, which is the whole
 * reason this exists rather than a token in its environment (docs/proposals/harness.md,
 * *Integrations reach a chat as tools*). Which tools a workspace gets is decided when it is
 * prepared: the recipe's list, narrowed or widened by the New chat dialog.
 *
 * The wire is MCP's streamable-HTTP shape, the stateless half of it: JSON-RPC over POST,
 * `initialize`, `tools/list`, `tools/call`, `ping`, notifications answered 202. No SSE stream
 * — nothing here needs to push to the session — so GET answers 405 and the client carries on.
 *
 * Gated like `/api/hook`: a loopback socket (`fromThisMachine`) plus a token this server minted. Tokens live in the
 * data dir, keyed by workspace, revoked when the workspace is deleted.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readJsonFile } from '../lib/fsutil.mjs'
import { search } from '../search/index.mjs'
import { DEFAULT_MODEL, listRepos, repoById, saveRepo } from '../workspaces/catalogue.mjs'
import { defaultBranch, git, mirrorPath } from '../workspaces/git.mjs'
import { githubIssue, githubPull, githubPullComments, githubPullStatus, githubRun, githubRuns, integrationsView, jobAllowed, jobBuildsRepo, jenkinsAbort, jenkinsBuild, jenkinsBuildLog, jenkinsJobInfo, jenkinsJobStatus, jenkinsTestReport, usableTools } from '../integrations.mjs'
import { describeResult, waitFor, watchBuild } from '../jenkins-results.mjs'
import { OUTPOST_ASK, awaitApproval } from '../launchers/structured.mjs'
import { hostRead, hostRun } from '../hosts.mjs'
import { notify, notifySettings } from '../notify/index.mjs'
import { describeCron, isoIn, nextMatches, parseCron, validTimezone } from '../state/cron.mjs'
import { BRANCH_CAP, DIGEST_CAP, DIGEST_MAX, COMMENTS, COMMENTS_MAX, COMMENT_CHARS, ISSUE_CHARS, ISSUE_COMMENTS, LIST_CAP, LOG_LINE_BYTES, PUBLISH_LINES, RUNS, RUN_CAP, ROUTINE_CAP, TEST_CASES, TEST_CASES_MAX, lineWindow, windowNote } from './caps.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.OUTPOST_DATA || path.join(here, '..', '..', 'data')
const TOKENS_FILE = path.join(DATA_DIR, 'mcp-tokens.json')

const PROTOCOL = '2025-06-18'
export const SERVER_NAME = 'outpost'

/** Of a write dataset's pulled files, the ones that were not simply new there. */
const pulledNote = (r) => {
  const parts = [r.behind.length ? `${r.behind.length} changed there, not here` : '', r.conflicts.length ? `${r.conflicts.length} deleted here but changed there, so brought back` : ''].filter(Boolean)
  return parts.length ? ` (${parts.join('; ')})` : ''
}

/** Changed on both sides: kept here, never sent, until the chat merges the source's version. */
const clashHead = (r) =>
  `${r.clashes.length} file${r.clashes.length === 1 ? '' : 's'} changed both here and there since, so not sent: the source's version of each is at the same path under ../.theirs-${r.dataset}/ beside the copy. Merge it into the copy's file, delete it there, and publish again`

/** Every tool, by the policy name that grants it. A workspace's `tools` is a list of these names. */
export const TOOL_GROUPS = Object.freeze({
  memory: ['memory_search', 'chats_list'],
  catalogue: ['catalogue_list', 'catalogue_read'],
  github: ['github_pull_status', 'github_pull_comments', 'github_actions', 'github_issue'],
  'jenkins:read': ['jenkins_job_status', 'jenkins_wait', 'jenkins_build_log', 'jenkins_test_report', 'jenkins_job_info'],
  'jenkins:build': ['jenkins_build', 'jenkins_abort'],
  // Not a choice in any dialog: granted by the structured launcher to its own sessions.
  approval: ['approve'],
  // Not a choice either: every workspace chat gets it, since it is how a checkout gets a
  // branch at all (workspaces-git.md, *work starts on a branch of its own*). The host tools ride
  // here too: what they reach is decided by the repo's `hosts` and each host's actions, not by
  // a tick, and they are not offered at all until some host has an action (hosts.mjs). So do
  // the routine tools: what guards them is the person's yes to each change, not a grant — and
  // `push_tag` and `github_merge_pull_request`, which ask the same way. `discord_send` too: it
  // reaches only the owner's own channel, and is held to `SENDS_PER_HOUR`.
  work: ['start_work', 'pull', 'push', 'push_tag', 'github_open_pull_request', 'github_merge_pull_request', 'add_repo', 'host_list', 'host_read', 'host_run', 'data_list', 'data_snapshot', 'data_publish', 'data_sync', 'setup_status', 'routine_list', 'routine_create', 'routine_update', 'routine_delete', 'discord_send'],
  // Not a choice: granted to a routine's run and nothing else (workspaces.md `ownGroups`).
  routine: ['routine_step', 'routine_end', 'chats_digest'],
})
/**
 * The tools that act on a named Jenkins job, each checked before it runs (`dispatch`,
 * `mayUseJob`). `jenkins_wait` is not one: it reads Outpost's own record of the chat's builds
 * and touches no job. The first four only read.
 */
const READ_JOB_TOOLS = new Set(['jenkins_job_status', 'jenkins_build_log', 'jenkins_test_report', 'jenkins_job_info'])
const JOB_TOOLS = new Set([...READ_JOB_TOOLS, 'jenkins_build', 'jenkins_abort'])

/**
 * Whether this chat may use `job` with `tool`; throws the refusal when not.
 *
 * - A job one of the chat's repos names (`jenkinsJobs`) — anything.
 * - Reading a job whose builds check out one of the chat's repos, or whose failures a repo
 *   of it watches — allowed without being named: seeing a build, its log or its tests changes
 *   nothing, and a new pipeline is readable the moment Jenkins has built it once (the
 *   owner's, 2026-10-03).
 * - Starting or stopping such a job — asked, on the chat's approval bar, at the moment it is
 *   wanted: Yes adds the job to that repo's list and the call goes on; No refuses it. A run
 *   nobody is watching — a routine's, or a chat that never asks — is refused instead.
 * - A job that builds none of the chat's repos — refused, read or write: another repo's deploy is
 *   not this chat's to start, nor to be asked about.
 */
async function mayUseJob(tool, job, grant) {
  const access = work.jenkinsAccessFor ? await work.jenkinsAccessFor(grant.workspaceId) : { jobs: [], readable: [], repos: [] }
  if (jobAllowed(job, access.jobs)) return
  if (READ_JOB_TOOLS.has(tool) && jobAllowed(job, access.readable)) return
  let builds = null
  for (const repo of access.repos) {
    if (await jobBuildsRepo(job, repo.url).catch(() => false)) {
      builds = repo
      break
    }
  }
  const refuse = (why) => {
    throw new Error(`${job || 'That job'} is not one of this chat's Jenkins jobs${why} — ${access.jobs.length ? `it may use ${access.jobs.join(', ')}` : 'its repos name none'}. The owner adds one on the repo's page in Settings › Repos.`)
  }
  if (!builds) refuse('')
  if (READ_JOB_TOOLS.has(tool)) return
  if (access.unattended) refuse(', and a run with nobody watching cannot ask the owner to add it')
  const decision = await awaitApproval(grant.workspaceId, {
    toolName: OUTPOST_ASK,
    input: {
      question: `This chat wants to ${tool === 'jenkins_abort' ? 'stop a build of' : 'start'} the Jenkins job ${job}, which builds ${builds.name} but is not one of ${builds.name}'s Jenkins jobs yet. Let ${builds.name}'s chats start and stop it?`,
      yes: `add ${job} to ${builds.name}'s jobs`,
    },
  })
  if (decision?.behavior !== 'allow') refuse(` and the owner said no to adding it`)
  const recipe = await repoById(builds.id)
  if (recipe && !jobAllowed(job, recipe.jenkinsJobs)) await saveRepo({ ...recipe, jenkinsJobs: [...(recipe.jenkinsJobs || []), job] })
}

/** The name the CLI is given for `--permission-prompt-tool`. */
export const APPROVAL_TOOL = `mcp__${SERVER_NAME}__approve`
export const DEFAULT_TOOLS = Object.freeze(['memory', 'catalogue'])

let tokens = null
let roster = null
/**
 * The workspace layer's git work — `startWork`, `pushWork`, `openPullRequest` — and what a
 * chat may do with Jenkins (`jenkinsAccessFor`), handed in rather than imported: that layer
 * imports this one. The routine store too (`routines`: list, get, save, remove, check, step,
 * end), since it imports that layer in turn.
 */
let work = {}

export function configureMcp({ roster: fn, startWork, pullWork, pushWork, tagWork, openPullRequest, mergePullRequest, githubRepoFor, addRepo, jenkinsAccessFor, hostsFor, listChatData, snapshotForChat, publishForChat, syncForChat, setupStatus, routineContextFor, routines, chatsDigest }) {
  roster = fn
  work = { startWork, pullWork, pushWork, tagWork, openPullRequest, mergePullRequest, githubRepoFor, addRepo, jenkinsAccessFor, hostsFor, listChatData, snapshotForChat, publishForChat, syncForChat, setupStatus, routineContextFor, routines, chatsDigest }
}

/**
 * Put a yes-or-no to the person on this chat's approval bar: true on a yes, else the sentence
 * to answer with. A chat nobody watches is refused before anything is asked, as a routine
 * tool is (`routineContext`): a routine's run never waits on a prompt.
 */
async function askPerson(grant, question, yes) {
  const ctx = work.routineContextFor ? await work.routineContextFor(grant.workspaceId) : { unattended: true }
  if (ctx.unattended) return 'A run with nobody watching cannot ask the owner, so nothing was done.'
  const decision = await awaitApproval(grant.workspaceId, { toolName: OUTPOST_ASK, input: { question, yes } })
  if (decision?.behavior === 'allow') return true
  return decision?.message === 'Nobody answered in time' ? 'Nobody answered within ten minutes; nothing was done.' : 'The owner said no; nothing was done.'
}

/**
 * `discord_send`'s limit, per chat: enough for a long task's few milestones and its result, and
 * a stop for a chat that loops on it — a channel that floods is one the owner mutes, and then
 * misses the stall that mattered (notify/index.mjs). Kept in memory: a restart forgets it, which
 * costs at most one more hour's worth.
 */
const SENDS_PER_HOUR = 10
const HOUR_MS = 60 * 60 * 1000
const sent = new Map()

/**
 * Whether a chat posted with `discord_send` since `at`: a routine's run that already told the
 * owner — a reminder — owes no `done` line repeating it (routines.md). Forgotten
 * on a restart like the limit, which errs toward the line being sent.
 */
export const discordSentSince = (workspaceId, at) => (sent.get(workspaceId) || []).some((t) => t >= at)

const shortTime = (iso) => (iso ? String(iso).slice(0, 16).replace('T', ' ') : '')

// ── routines made from a chat (routines.md) ───────────────────────────────────────────

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i
const trim = (v) => (typeof v === 'string' ? v.trim() : '')
const clockIn = (ms, tz) =>
  new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms))
/** When, in words, with the instant spelled out for a one-shot: what a change from one to the other reads as. */
const whenIn = (r) => (r.triggers.length ? r.triggers.map((t) => (t.kind === 'call' ? `On a call to "${t.name}"` : t.cron ? describeCron(t.cron) : `Once, ${clockIn(t.at, t.tz)}`)).join(' · ') : 'By hand only')
/** A routine's clock: its first trigger's, since a person writes them all in their own. */
/** A call trigger has no clock: the zone is the first time trigger's. */
const tzOf = (r) => r.triggers.find((t) => t.tz)?.tz || 'UTC'
/**
 * Whether a `needs-you` run's chat still wants the owner, by the page's rule (chats.md, `runNeedsYou`):
 * asking, errored, or come back and neither opened nor written in. The run's record says
 * `needs-you` for good, and a chat told only that kept telling the owner a dealt-with run needed them.
 */
export const runChatWaits = (threads, runId) =>
  threads.some((t) => t.routine?.runId === runId && !t.archived && (t.hasError || t.unread || (t.done && !t.routine.answered)))
/** The next three starts; a one-shot's only while ahead; none while paused, since the runner skips it. */
const upcoming = (r) =>
  r.enabled === false
    ? []
    : r.triggers
        .flatMap((t) => (t.cron ? nextMatches(parseCron(t.cron), Date.now(), t.tz, 3) : t.at > Date.now() ? [t.at] : []))
        .sort((a, b) => a - b)
        .slice(0, 3)
const stepsIn = (r) => r.steps.map((s) => s.title).join(' → ')
const gateIn = async (r) => (r.gate ? `Only if a chat was active${r.gate.repos.length ? ` or main moved on ${(await repoNames(r.gate.repos.map((id) => ({ id })))).join(', ')}` : ''} since the last run` : '')

async function repoNames(repos) {
  const all = await listRepos()
  return repos.map((r) => all.find((x) => x.id === r.id)?.name || r.id)
}

/**
 * The repos a routine names, from ids or names: the chat's own at the base it has them on,
 * any other catalogue repo at its main branch. Unknown names are refused here, before anybody
 * is asked about a routine that could never start (`createWorkspace` would refuse it then).
 */
async function routineRepos(asked, ctx) {
  if (!Array.isArray(asked)) throw new Error('repos is a list of repo ids or names')
  const all = await listRepos()
  const out = []
  for (const a of asked) {
    const want = trim(a).toLowerCase()
    let r = ctx.repos.find((x) => x.id === want || x.name.toLowerCase() === want)
    if (!r) {
      const recipe = all.find((x) => x.id === want || x.name.toLowerCase() === want)
      if (!recipe) throw new Error(`No repo "${a}" in Settings › Repos — name one of ${all.map((x) => x.name).join(', ') || 'none yet'}`)
      r = { id: recipe.id, name: recipe.name, base: recipe.baseBranch || (await defaultBranch(mirrorPath(recipe.id)).catch(() => '')) }
    }
    if (!out.some((x) => x.id === r.id)) out.push(r)
  }
  return out
}

/**
 * The routine as it would be saved: `existing` with `args` laid over it, or a new one from
 * this chat. Everything that could stop it saving is checked here — the store's own check
 * last — so the person is never asked about one that cannot be. A chat-made routine is
 * `dontAsk` and nothing else: only the person, on the page, gives a run more.
 */
async function draftRoutine(args, existing, ctx) {
  const has = (k) => args[k] !== undefined && args[k] !== null
  if (has('cron') && has('at')) throw new Error('Give cron or at, not both')
  const r = existing
    ? { ...existing, triggers: [...existing.triggers] }
    : { name: '', prompt: '', triggers: [], gate: null, steps: null, repos: ctx.repos.map(({ id, base }) => ({ id, base })), model: ctx.model, enabled: true, permissionMode: 'dontAsk' }
  if (has('name')) r.name = trim(args.name)
  if (has('prompt')) r.prompt = trim(args.prompt)
  if (!r.name) throw new Error('A routine needs a name')
  if (!r.prompt) throw new Error('A routine needs a prompt')
  let trigger = null
  if (has('cron')) {
    trigger = { kind: 'time', cron: parseCron(trim(args.cron)).expression } // throws a sentence on a bad one
  } else if (has('at')) {
    const at = trim(args.at)
    if (!ISO_WITH_OFFSET.test(at)) throw new Error(`at "${at}" is not ISO 8601 with an offset, like 2026-10-06T20:00-04:00 — a time without one is a guess at whose clock`)
    const ms = Date.parse(at)
    if (!Number.isFinite(ms)) throw new Error(`at "${at}" is not a date`)
    if (ms <= Date.now()) throw new Error(`at "${at}" is in the past`)
    trigger = { kind: 'time', at: ms }
  } else if (!existing) {
    throw new Error('Give cron (five fields: minute hour day month weekday) or at (one time)')
  }
  const tz = has('tz') ? trim(args.tz) : existing?.triggers.find((t) => t.tz)?.tz || ''
  if (trigger || has('tz')) {
    if (!tz) throw new Error("tz is needed: the person's timezone, an IANA name like America/New_York")
    if (!validTimezone(tz)) throw new Error(`"${tz}" is not a timezone this machine knows — an IANA name like America/New_York`)
    // A call trigger is the page's to make and has no clock: a new time keeps it, a new zone skips it.
    const calls = r.triggers.filter((t) => t.kind === 'call')
    r.triggers = trigger ? [{ ...trigger, tz }, ...calls] : r.triggers.map((t) => (t.kind === 'call' ? t : { ...t, tz }))
  }
  if (has('repos')) r.repos = (await routineRepos(args.repos, ctx)).map(({ id, base }) => ({ id, base }))
  if (has('model')) r.model = trim(args.model)
  if (has('enabled')) r.enabled = args.enabled !== false
  if (has('steps')) {
    if (!Array.isArray(args.steps)) throw new Error('steps is a list of { title, detail }')
    r.steps = args.steps.length ? args.steps.map((s, i) => ({ id: `s${i + 1}`, title: trim(s?.title), detail: trim(s?.detail) })) : null
  }
  // `null` removes the gate; a list, empty or not, sets one.
  if (args.gate !== undefined) r.gate = args.gate === null ? null : { kind: 'activity', repos: (await routineRepos(args.gate, ctx)).map((x) => x.id) }
  return work.routines.check(r)
}

/** Each field an update changes, in words, for the card. */
async function changesBetween(a, b) {
  const out = []
  const add = (field, from, to) => from !== to && out.push({ field, from, to })
  add('name', a.name, b.name)
  add('when', whenIn(a), whenIn(b))
  add('timezone', tzOf(a), tzOf(b))
  const repos = async (s) => (await repoNames(s.repos)).map((n, i) => `${n}${s.repos[i].base ? ` (${s.repos[i].base})` : ''}`).join(', ') || 'none'
  add('repos', await repos(a), await repos(b))
  add('model', a.model || DEFAULT_MODEL, b.model || DEFAULT_MODEL)
  add('prompt', a.prompt, b.prompt)
  add('steps', stepsIn(a), stepsIn(b))
  add('gate', (await gateIn(a)) || 'none', (await gateIn(b)) || 'none')
  add('state', a.enabled ? 'on' : 'paused', b.enabled ? 'on' : 'paused')
  return out
}

/**
 * What the approval bar draws instead of the tool's input (ui-conversation.md): the routine
 * as a card. Its shape is the page's contract — change both or neither.
 */
async function routineCard(action, r, { changes, next = upcoming(r), layout = null } = {}) {
  return {
    kind: 'routine',
    action,
    name: r.name,
    when: r.triggers.length ? r.triggers.map((t) => (t.kind === 'call' ? `On a call to "${t.name}"` : t.cron ? describeCron(t.cron) : 'Once')).join(' · ') : 'By hand only',
    tz: tzOf(r),
    next,
    repos: await repoNames(r.repos),
    // A blank model starts a run on DEFAULT_MODEL (`createWorkspace`): the card names that one,
    // not "default", so the person approves the model the run will actually use.
    model: r.model || DEFAULT_MODEL,
    mayDo: r.permissionMode === 'dontAsk' ? 'Never asks: anything not allowed outright is refused' : `Permission mode ${r.permissionMode}, set on the routine's page`,
    prompt: r.prompt,
    results: (await notifySettings()).configured ? 'Discord, when it is done or needs you' : 'Outpost only — no Discord webhook is saved',
    // With each step's `next`, so a routine that branches is drawn branching on the card too.
    steps: r.steps.map(({ id, title, detail, next }) => ({ id, title, ...(detail ? { detail } : {}), ...(next?.length ? { next } : {}) })),
    gate: await gateIn(r),
    ...(changes ? { changes } : {}),
    // Where its boxes were dragged to on its page, so the card draws the routine as its owner
    // laid it out (routines.md *Layouts*); a new step lands where the automatic layout puts it.
    ...(layout ? { layout } : {}),
  }
}

/**
 * The context a routine tool works in; refuses a chat nobody is watching before anything
 * else. A routine's run (or a chat that never asks) cannot put the question, and a routine
 * that made routines would be runs nobody ever said yes to.
 */
async function routineContext(grant) {
  if (!work.routines || !work.routineContextFor) throw new Error('Routines are not available on this server.')
  const ctx = await work.routineContextFor(grant.workspaceId)
  if (ctx.unattended) throw new Error('A run with nobody watching cannot make or change routines.')
  return ctx
}

/** Put the card to the person on this chat's bar; true on a yes, else the sentence to answer with. */
async function askAboutRoutine(grant, question, yes, card) {
  const decision = await awaitApproval(grant.workspaceId, { toolName: OUTPOST_ASK, input: { question, yes, card } })
  if (decision?.behavior === 'allow') return true
  const undone = card.action === 'delete' ? 'nothing was deleted' : 'nothing was saved'
  return decision?.message === 'Nobody answered in time' ? `Nobody answered within ten minutes; ${undone}.` : `The owner said no; ${undone}.`
}

/**
 * Whether this chat made the routine, in words for the card and the question. Nothing is
 * refused on it: the owner may well ask a chat to change a routine made on the page or by
 * another chat. What it prevents is that yes being given without knowing it — a chat
 * reworking another chat's run read, on the card, exactly like one tidying its own.
 */
function madeByLine(r, grant, ctx = {}) {
  // A chat made to change this routine (routines.md, *Defining chats*) is where it is defined now.
  if (ctx.defines && ctx.defines === r.id) return { mine: true, line: 'Defined in this chat' }
  const by = r.createdBy
  if (by?.workspaceId && by.workspaceId === grant.workspaceId) return { mine: true, line: 'Made by this chat' }
  if (by?.workspaceId) return { mine: false, line: 'Made by another chat, not this one' }
  if (by === 'page') return { mine: false, line: 'Made on the page, not by this chat' }
  return { mine: false, line: 'Not made by this chat as far as Outpost knows' }
}

async function existingRoutine(id) {
  const r = await work.routines.get(trim(id))
  if (!r) throw new Error(`No routine "${id}" — routine_list names them`)
  return r
}

const savedLine = (verb, r) => {
  const next = upcoming(r)[0]
  return `${verb} "${r.name}" (id ${r.id}): ${whenIn(r)}, ${tzOf(r)}${r.enabled ? '' : ', paused'}. ${next ? `Next run ${isoIn(next, tzOf(r))}.` : 'No run ahead.'}`
}

async function loadTokens() {
  if (tokens) return tokens
  // A file that will not parse is set aside, not read as "none yet": the next mint saved the
  // empty map over it. Its tokens are dead either way — nothing can check one against a file
  // nobody can read — but the file is kept, and the log says where.
  const raw = await readJsonFile(TOKENS_FILE, { aside: true })
  const loaded = new Map()
  for (const [t, rec] of Object.entries(raw?.tokens || {})) loaded.set(t, rec)
  tokens = loaded
  return tokens
}

async function saveTokens() {
  await fsp.mkdir(DATA_DIR, { recursive: true })
  const tmp = `${TOKENS_FILE}.tmp`
  await fsp.writeFile(tmp, JSON.stringify({ version: 1, tokens: Object.fromEntries(tokens) }, null, 2), { mode: 0o600 })
  await fsp.rename(tmp, TOKENS_FILE)
  await fsp.chmod(TOKENS_FILE, 0o600).catch(() => {})
}

/** A token for a workspace, with the tool groups it may use. Replaces any earlier one. */
export async function mintMcpToken(workspaceId, groups) {
  await loadTokens()
  for (const [t, rec] of tokens) if (rec.workspaceId === workspaceId) tokens.delete(t)
  const token = randomBytes(24).toString('base64url')
  tokens.set(token, { workspaceId, groups: [...groups], createdAt: Date.now() })
  await saveTokens()
  return token
}

export async function revokeMcpTokens(workspaceId) {
  await loadTokens()
  let n = 0
  for (const [t, rec] of tokens) {
    if (rec.workspaceId !== workspaceId) continue
    tokens.delete(t)
    n++
  }
  if (n) await saveTokens()
  return n
}

/** The file `--mcp-config` takes, pointing the session at this server with its token. */
export function mcpConfigFor({ url, token }) {
  return { mcpServers: { [SERVER_NAME]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }
}

// ── the tools ─────────────────────────────────────────────────────────────────────────

/** The parameter a cut read is continued with (caps.mjs `lineWindow`): one schema, so both reads say it alike. */
const OFFSET = { type: 'integer', description: 'First line; negative for the last lines' }

const TOOLS = {
  /**
   * The approval surface: the CLI calls this when a tool needs permission and waits for the
   * answer. The page sees the question through `/api/prompt` and answers through
   * `/api/respond`; this request stays open in between (structured.mjs `awaitApproval`).
   */
  approve: {
    description: 'Outpost asks the person whether this tool call may run. Used by the CLI as its permission prompt; not for the model to call.',
    inputSchema: {
      type: 'object',
      properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
      required: ['tool_name', 'input'],
    },
    async run({ tool_name, input, tool_use_id }, grant) {
      const decision = await awaitApproval(grant.workspaceId, { toolName: tool_name, input, toolUseId: tool_use_id })
      return JSON.stringify(decision)
    },
  },
  start_work: {
    description:
      'Bring each repo checkout (or just `repo`) up to the latest of its main branch and make a branch named for the work.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The work in a few words, like "fix toast position"' },
        repo: { type: 'string', description: 'One repo, by id or name; omit for all' },
      },
      required: ['name'],
    },
    async run({ name, repo = '' }, grant) {
      if (!work.startWork) return 'Starting work is not available on this server.'
      const r = await work.startWork(grant.workspaceId, { name, repo })
      return r.branches
        .map((b) => `${b.repo}: on ${b.branch}, ${b.fromLatest ? `from the latest ${b.base}` : `carrying your uncommitted changes (${b.base} is merged in when it is pushed)`}`)
        .join('\n')
    },
  },
  pull: {
    description:
      'Fetch the latest of main, or of `branch`, and merge it into the checkout (commit first). A conflict is left in place, its files named: resolve and commit, or git merge --abort. merge: false only fetches, for reading origin/<branch> with git log, diff or show.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'One repo, by id or name; omit for all' },
        branch: { type: 'string', description: 'Omit for main' },
        merge: { type: 'boolean', description: 'Default true' },
      },
    },
    async run({ repo = '', branch = '', merge = true }, grant) {
      if (!work.pullWork) return 'Pulling is not available on this server.'
      const r = await work.pullWork(grant.workspaceId, { repo, branch, merge })
      const commits = (n) => `${n} commit${n === 1 ? '' : 's'}`
      return r.results
        .map((x) =>
          x.fetched
            ? `${x.repo}: fetched ${x.ref} — ${commits(x.behind)} this checkout lacks, ${commits(x.ahead)} it has that ${x.ref} does not`
            : x.upToDate
              ? `${x.repo}: already has everything on ${x.ref}`
              : x.conflict
                ? `${x.repo}: merging ${x.ref} into ${x.branch} conflicts in ${x.conflict.join(', ')} — resolve and commit, or git merge --abort`
                : `${x.repo}: ${x.merged ? `merged ${x.ref} into ${x.branch}` : `moved to ${x.ref}`} (${commits(x.behind)})${x.filled ? `; ${x.filled}` : ''}`
        )
        .join('\n')
    },
  },
  push_tag: {
    description: 'Tag a commit the remote already has (default HEAD) and push the tag. Asks the person first; an existing tag is never moved.',
    inputSchema: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'Like v1.4.0' },
        commit: { type: 'string' },
        message: { type: 'string' },
        repo: { type: 'string', description: 'By id or name, when the chat has several' },
      },
      required: ['tag'],
    },
    async run({ tag, commit = '', message = '', repo = '' }, grant) {
      if (!work.tagWork) return 'Tags are not available on this server.'
      const r = await work.tagWork(grant.workspaceId, { repo, tag, commit, message }, (q, yes) => askPerson(grant, q, yes))
      return r.ok ? `${r.repo}: pushed the tag ${r.tag} at ${r.commit} ("${r.subject}")` : r.refused
    },
  },
  push: {
    description:
      "Push committed work the way the repo is set to: merges the latest main in first (a conflict stops it and names the files: resolve, commit, push again), then lands it on main, pushes the branch, or runs the owner's steps; the answer says which.",
    inputSchema: { type: 'object', properties: { repo: { type: 'string', description: 'One repo, by id or name; omit for all' } } },
    async run({ repo = '' }, grant) {
      if (!work.pushWork) return 'Pushing is not available on this server.'
      const r = await work.pushWork(grant.workspaceId, { repo })
      // Said only where a build can be heard of at all, so a chat without Jenkins is not told to wait on one.
      const j = (await integrationsView()).jenkins
      const canWait = (grant.groups || []).includes('jenkins:read')
      const follow = (j.configured || j.notifyConfigured) && r.results.some((x) => !x.nothing) ? `\nAny Jenkins build of what was pushed reports back to this chat: you are woken if it fails${canWait ? ', or call jenkins_wait to wait for it now' : ''}.` : ''
      return (
        r.results
        .map((x) =>
          x.nothing
            ? `${x.repo}: nothing to push — ${x.reason}`
            : x.mode === 'main'
              ? `${x.repo}: ${x.branch} merged with the latest ${x.base}, pushed, and landed on ${x.base}`
              : x.mode === 'custom'
                ? `${x.repo}: ${x.branch} merged with the latest ${x.base} and pushed; ${x.did.join('; ')}`
                : `${x.repo}: ${x.branch} merged with the latest ${x.base} and pushed; ${x.base} left as it is`
          )
          .map((line, i) => (r.results[i].updated ? `${line}\n  Branches updated: ${r.results[i].updated.join(', ')}` : line))
          .join('\n') + follow
      )
    },
  },
  add_repo: {
    description:
      'Check out another repo in this chat at the latest of its main branch: a catalogue repo or a git URL. One not in the catalogue is read-only: push and pull requests are refused.',
    inputSchema: { type: 'object', properties: { repo: { type: 'string', description: 'Catalogue id or name, or a git URL' } }, required: ['repo'] },
    async run({ repo }, grant) {
      if (!work.addRepo) return 'Adding a repo is not available on this server.'
      // `local: false` said outright rather than left to follow `notify`: a session must never
      // clone a path on this machine (another repo's mirror, another chat's checkout), and a
      // later `notify: true` here must not quietly allow it (workspaces-git.md).
      const r = await work.addRepo(grant.workspaceId, { repo, local: false })
      return r.line
    },
  },
  github_open_pull_request: {
    description:
      "Open a pull request for the work branch, against main or `base`. Merges the base in and pushes first; one already open for the branch is answered, not duplicated.",
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'By id or name, when the chat has several' },
        base: { type: 'string', description: 'Omit for main' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
    },
    async run({ repo = '', base = '', title = '', body = '' }, grant) {
      if (!work.openPullRequest) return 'Pull requests are not available on this server.'
      const r = await work.openPullRequest(grant.workspaceId, { repo, base, title, body })
      return `${r.pr.existing ? 'Already open' : 'Opened'}: #${r.pr.number} ${r.branch} → ${r.base}\n${r.pr.url}`
    },
  },
  github_merge_pull_request: {
    description:
      "Merge a pull request on this chat's repo: the one it opened, or `number`. Asks the person first; GitHub's own rules (reviews, checks) still apply.",
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'integer' },
        method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: "Default the first the repo allows" },
        repo: { type: 'string', description: 'By id or name, when the chat has several' },
      },
    },
    async run({ number = 0, method = '', repo = '' }, grant) {
      if (!work.mergePullRequest) return 'Merging is not available on this server.'
      const r = await work.mergePullRequest(grant.workspaceId, { repo, number, method }, (q, yes) => askPerson(grant, q, yes))
      if (r.already) return `#${r.pr.number} is already merged.`
      if (!r.ok) return r.refused
      return `Merged #${r.pr.number} ${r.pr.head} → ${r.pr.base} (${r.method}), ${String(r.sha).slice(0, 7)}.`
    },
  },
  // A repo's data (its `.outpost/data.json`, workspaces/datasets.mjs): where each dataset is for
  // this chat, a scrubbed database snapshot on request, and a write dataset published back.
  // Whether this chat's repos are set up yet (workspaces.md): the session asks rather than
  // guesses, and does not install over a setup still running.
  setup_status: {
    description:
      "Whether each repo's setup (install, data copies, .env.local) has finished, and the end of the log of one that failed.",
    inputSchema: { type: 'object', properties: {} },
    async run(_args, grant) {
      if (!work.setupStatus) return 'Setup status is not available on this server.'
      const { repos } = await work.setupStatus(grant.workspaceId, { lines: 20 })
      if (!repos.length) return 'Nothing in this chat has setup to run.'
      const word = { pending: 'waiting its turn', running: 'running', done: 'finished', failed: 'FAILED' }
      return repos
        .map((r) => `${r.name}: ${word[r.state] || r.state}${r.error ? ` — ${r.error}` : ''}${r.state === 'failed' && r.log ? `\n${r.log}` : ''}`)
        .join('\n')
    },
  },
  data_list: {
    description:
      "The datasets this chat's repos declare (.outpost/data.json): each one's variable, kind (shared read-only, this chat's writable copy, or a database snapshot) and path here.",
    inputSchema: { type: 'object', properties: {} },
    async run(_args, grant) {
      if (!work.listChatData) return 'Data is not available on this server.'
      const repos = await work.listChatData(grant.workspaceId)
      if (!repos.length) return 'No repo in this chat declares any data.'
      return repos
        .map((r) =>
          r.error
            ? `${r.repo}: ${r.error}`
            : r.datasets.length
              ? `${r.repo}:\n` +
                r.datasets
                  .map((d) => {
                    const kind = d.access === 'read' ? 'read-only, shared' : d.access === 'write' ? "this chat's own copy; data_publish sends new and changed files back" : `snapshot from ${d.sources.map((s) => s.name).join(' or ')}; data_snapshot takes one`
                    return `  ${d.name} — ${d.env} (${kind})${d.description ? `: ${d.description}` : ''}\n    ${d.here ? `here: ${d.here}${d.syncedAt ? `, synced ${new Date(d.syncedAt).toISOString()}` : ''}` : 'not here yet'}`
                  })
                  .join('\n')
              : `${r.repo}: declares no datasets`,
        )
        .join('\n')
    },
  },
  data_snapshot: {
    description:
      "Copy a database dataset from its source, scrubbed by the repo's script and checked (a failed check deletes it); .env.local then points at it. Takes a minute or so.",
    inputSchema: {
      type: 'object',
      properties: {
        dataset: { type: 'string', description: 'As data_list names it' },
        source: { type: 'string', description: 'Omit when it has one' },
        repo: { type: 'string', description: 'By id or name, when the chat has several' },
      },
      required: ['dataset'],
    },
    async run({ dataset, source = '', repo = '' }, grant) {
      if (!work.snapshotForChat) return 'Data is not available on this server.'
      const r = await work.snapshotForChat(grant.workspaceId, { repo, dataset, source })
      return `${r.repo}: ${r.dataset} from ${r.source} at ${r.path} — scrubbed, ${r.checks} check${r.checks === 1 ? '' : 's'} passed. ${r.env} in .env.local points at it; restart the app to pick it up.`
    },
  },
  data_publish: {
    description:
      "Send this chat's writable dataset back; what was deleted here is removed there only on the owner's yes.",
    inputSchema: {
      type: 'object',
      properties: {
        dataset: { type: 'string', description: 'As data_list names it' },
        path: { type: 'string', description: 'Only this folder of it' },
        empty_folders: { type: 'boolean', description: 'Also folders empty there, absent here' },
        repo: { type: 'string', description: 'By id or name, when the chat has several' },
      },
      required: ['dataset'],
    },
    async run({ dataset, path: sub = '', empty_folders = false, repo = '' }, grant) {
      if (!work.publishForChat) return 'Data is not available on this server.'
      const r = await work.publishForChat(grant.workspaceId, { repo, dataset, path: sub, emptyFolders: empty_folders === true })
      const list = (items, where = "the chat's Activity log has them all") => [...items.slice(0, PUBLISH_LINES).map((l) => `  ${l}`), ...(items.length > PUBLISH_LINES ? [`  …and ${items.length - PUBLISH_LINES} more (${where})`] : [])]
      const files = (k) => `${k} file${k === 1 ? '' : 's'}`
      const group = (items, head, where) => (items.length ? [`${head}:`, ...list(items, where)] : [])
      // What became of the files deleted or moved here: removed there on the owner's yes, or
      // kept, with why. Nothing is ever removed without that yes (workspaces-data.md).
      const n = r.pending.length
      const k = r.pendingFolders.length
      const folders = (x) => `${x} folder${x === 1 ? '' : 's'}`
      const gone = `${files(n)} deleted or moved here${k ? ` and ${folders(k)} that leaves empty` : ''}`
      const deletions = {
        removed: `${files(r.removed.length)} removed there, as the owner said`,
        kept: `${gone} kept there — the owner said no; publish again to ask again`,
        failed: `${gone} still there — the owner said yes but the source refused the removal; the Activity log says why`,
        standing: `${gone} await the owner's yes on the bar before being removed there; nothing is removed until then, and the Activity log will say`,
        later: `${gone} will be put to the owner once this run ends — carry on; nothing is removed until then`,
        nobody: `${gone} stay there: this chat never asks, so nobody can say yes`,
      }
      return [
        `${r.repo}: ${r.dataset} to ${r.to} — ${files(r.sent.length + r.same.length + r.newer.length)} compared.`,
        ...group(r.sent, `${files(r.sent.length)} sent, new or changed`),
        ...group(r.same, `${files(r.same.length)} already there, the same`, 'path narrows the list to one folder'),
        ...group(r.newer, `${files(r.newer.length)} skipped, newer there than here (changed there during this publish); publish again to compare them`),
        ...group(r.pulled, `${files(r.pulled.length)} pulled into the copy, new or changed there since${pulledNote(r)}`),
        ...group(r.clashes, clashHead(r)),
        ...group(r.dropped, `${files(r.dropped.length)} dropped from the copy, removed there since and unchanged here — not sent back`),
        ...group(r.resent, `${files(r.resent.length)} removed there since but changed here, so sent back`),
        ...(r.outcome === 'removed'
          ? [...group(r.removed, deletions.removed), ...group(r.removedFolders.map((d) => `${d}/`), `${folders(r.removedFolders.length)} removed there, left empty by that`)]
          : n || k
            ? group([...r.pending, ...r.pendingFolders.map((d) => `${d}/`)], deletions[r.outcome] || gone)
            : []),
        ...(r.partial ? [`rsync could not do everything; its errors (a file named here was not sent or not finished):`, ...list(r.errors)] : []),
      ].join('\n')
    },
  },
  data_sync: {
    description: "Bring a dataset's copy up to date from its source: a shared one refreshed, a writable one given what changed there since. Sends nothing.",
    inputSchema: {
      type: 'object',
      properties: {
        dataset: { type: 'string', description: 'As data_list names it' },
        repo: { type: 'string', description: 'By id or name, when the chat has several' },
      },
      required: ['dataset'],
    },
    async run({ dataset, repo = '' }, grant) {
      if (!work.syncForChat) return 'Data is not available on this server.'
      const r = await work.syncForChat(grant.workspaceId, { repo, dataset })
      if (r.access === 'read') return `${r.repo}: ${r.dataset} refreshed for every chat — ${r.files} files, ${(r.bytes / 1e6).toFixed(0)} MB.`
      const list = (items) => [...items.slice(0, PUBLISH_LINES).map((l) => `  ${l}`), ...(items.length > PUBLISH_LINES ? [`  …and ${items.length - PUBLISH_LINES} more (the chat's Activity log has them all)`] : [])]
      const files = (k) => `${k} file${k === 1 ? '' : 's'}`
      return [
        `${r.repo}: ${r.dataset} from ${r.from} — ${files(r.pulled.length)} pulled into the copy, new or changed there since${pulledNote(r)}.`,
        ...list(r.pulled),
        ...(r.clashes.length ? [`${clashHead(r)}:`, ...list(r.clashes)] : []),
        ...(r.dropped.length ? [`${files(r.dropped.length)} dropped from the copy, removed there since:`, ...list(r.dropped)] : []),
        ...(r.pending.length ? [`${files(r.pending.length)} deleted or moved here stay so; data_publish asks the owner whether to remove them there.`] : []),
      ].join('\n')
    },
  },
  host_list: {
    description:
      'Other machines this chat may use: the paths it may read and the commands it may run there.',
    inputSchema: { type: 'object', properties: {} },
    async run(_, grant) {
      const hosts = work.hostsFor ? await work.hostsFor(grant.workspaceId) : []
      if (!hosts.length) return "This chat may use no hosts. The owner gives a repo one on its page in Settings › Repos, and writes what a chat may do there under Integrations › Hosts."
      return hosts
        .map((h) => `${h.name} (${h.user}@${h.host})\n${h.actions.map((a) => `  ${a.kind === 'read' ? `read: ${a.target}` : `run "${a.name}": ${a.target}`}`).join('\n')}`)
        .join('\n\n')
    },
  },
  host_read: {
    description: 'Read a file or list a directory on a host, under a path host_list names. Absolute path.',
    inputSchema: { type: 'object', properties: { host: { type: 'string' }, path: { type: 'string' }, offset: OFFSET }, required: ['host', 'path'] },
    async run({ host, path: p, offset = 1 }, grant) {
      const r = await hostRead(work.hostsFor ? await work.hostsFor(grant.workspaceId) : [], host, p, { offset })
      return `${r.host}:${r.path}${r.kind === 'dir' ? ' (directory)' : ''}\n${r.text}${windowNote(r)}`
    },
  },
  host_run: {
    description: 'Run a command host_list names, exactly as written: no arguments. Answers the exit code and the end of the output.',
    inputSchema: {
      type: 'object',
      properties: { host: { type: 'string' }, action: { type: 'string' }, max_bytes: { type: 'integer', description: 'Bytes of output kept, up to 65536' } },
      required: ['host', 'action'],
    },
    async run({ host, action, max_bytes = RUN_CAP }, grant) {
      const r = await hostRun(work.hostsFor ? await work.hostsFor(grant.workspaceId) : [], host, action, { maxBytes: max_bytes })
      const head = `${r.host} · ${r.action} — ${r.timedOut ? 'stopped after two minutes' : `exit ${r.code}`}${r.cut ? ` (only the end of its output${Number(max_bytes) < 65536 ? '; max_bytes up to 65536 keeps more' : ''})` : ''}`
      return `${head}\n${r.output || '(no output)'}`
    },
  },
  routine_list: {
    description: 'Every routine: when, next run, repos, model, last run. With `id`, one with its gate, steps and prompt.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    async run({ id = '' }) {
      if (!work.routines) return 'Routines are not available on this server.'
      const all = id ? [await existingRoutine(id)] : await work.routines.list()
      if (!all.length) return 'No routines.'
      const shown = all.slice(0, ROUTINE_CAP)
      const names = await repoNames(shown.flatMap((r) => r.repos))
      const threads = shown.some((r) => r.lastRun?.outcome === 'needs-you') && roster ? (await roster()).threads : []
      let n = 0
      const blocks = []
      for (const r of shown) {
        const repos = r.repos.map((x) => `${names[n++]}${x.base ? ` (${x.base})` : ''}`).join(', ') || 'no repo'
        const last = r.lastRun
        const outcome = last?.outcome === 'needs-you' ? (runChatWaits(threads, last.runId) ? 'needs-you, its chat waiting on the owner' : 'needs-you, since dealt with in its chat') : last?.outcome
        blocks.push(
          [
            `${r.name} — id ${r.id}, ${r.enabled ? 'on' : 'paused'}`,
            `  ${whenIn(r)}, ${tzOf(r)}; ${r.next?.length ? `next ${isoIn(r.next[0], tzOf(r))}` : 'no run ahead'}`,
            `  ${repos} · model ${r.model || DEFAULT_MODEL}${r.permissionMode === 'dontAsk' ? '' : ` · mode ${r.permissionMode}`} · ${last ? `last run ${outcome} ${isoIn(last.at, tzOf(r))}` : 'never run'}`,
            ...(id ? [`  gate: ${(await gateIn(r)) || 'none'}`, `  steps: ${r.steps.map((s) => `${s.id} ${s.title}`).join('; ')}`, `  prompt: ${r.prompt}`] : []),
          ].join('\n')
        )
      }
      return blocks.join('\n') + (all.length > shown.length ? `\n…(${all.length - shown.length} more; the Routines list has them all)` : '')
    },
  },
  routine_create: {
    description: 'Make a routine: a run nobody watches, on a cron or once, that becomes a chat only if it needs the person. Asks the person first.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        prompt: { type: 'string', description: 'For a run nobody watches: it cannot ask anything, and whatever is not allowed outright is refused' },
        cron: { type: 'string', description: 'Five fields in tz, like "15 16 * * 1-5"' },
        at: { type: 'string', description: 'Once instead: ISO 8601 with an offset' },
        tz: { type: 'string', description: "The person's IANA timezone; ask them if you are not sure" },
        repos: { type: 'array', items: { type: 'string' }, description: "Ids or names; default this chat's" },
        model: { type: 'string', description: "Default this chat's" },
        steps: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, detail: { type: 'string' } } }, description: 'The plan, in order; default one step' },
        gate: { type: ['array', 'null'], items: { type: 'string' }, description: 'Run only if a chat was active, or main moved on these repos, since the last run' },
      },
      required: ['name', 'prompt', 'tz'],
    },
    async run(args, grant) {
      const ctx = await routineContext(grant)
      const r = await draftRoutine(args, null, ctx)
      const card = await routineCard('create', r)
      const answer = await askAboutRoutine(grant, `New routine "${r.name}": ${whenIn(r)}, ${tzOf(r)}. Save it?`, 'save it', card)
      if (answer !== true) return answer
      return savedLine('Saved', await work.routines.save(r, { by: { workspaceId: grant.workspaceId } }))
    },
  },
  routine_update: {
    description: 'Change the fields given; cron replaces at and at cron; gate null removes it. Asks the person first.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        prompt: { type: 'string' },
        cron: { type: 'string' },
        at: { type: 'string' },
        tz: { type: 'string' },
        repos: { type: 'array', items: { type: 'string' } },
        model: { type: 'string' },
        steps: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, detail: { type: 'string' } } } },
        gate: { type: ['array', 'null'], items: { type: 'string' } },
        enabled: { type: 'boolean' },
      },
      required: ['id'],
    },
    async run(args, grant) {
      const ctx = await routineContext(grant)
      const old = await existingRoutine(args.id)
      const r = await draftRoutine(args, old, ctx)
      const changes = await changesBetween(old, r)
      if (!changes.length) return `Nothing would change in "${old.name}".`
      const made = madeByLine(old, grant, ctx)
      const card = { ...(await routineCard('update', r, { changes, layout: await work.routines.layout?.(old.id) })), madeBy: made.line }
      const answer = await askAboutRoutine(grant, `Change routine "${old.name}"${made.mine ? '' : ` (${made.line.toLowerCase()})`}: ${changes.map((c) => c.field).join(', ')}. Save the change?`, 'save the change', card)
      if (answer !== true) return answer
      return savedLine('Changed', await work.routines.save(r, { by: { workspaceId: grant.workspaceId } }))
    },
  },
  routine_delete: {
    description: 'Delete a routine. Asks the person first.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    async run({ id }, grant) {
      const ctx = await routineContext(grant)
      const r = await existingRoutine(id)
      const made = madeByLine(r, grant, ctx)
      const card = { ...(await routineCard('delete', r, { next: r.next || [], layout: await work.routines.layout?.(r.id) })), madeBy: made.line }
      const answer = await askAboutRoutine(grant, `Delete routine "${r.name}" (${whenIn(r)}, ${tzOf(r)})${made.mine ? '' : `, ${made.line.toLowerCase()}`}?`, 'delete it', card)
      if (answer !== true) return answer
      return (await work.routines.remove(r.id, { by: { workspaceId: grant.workspaceId } })) ? `Deleted "${r.name}".` : `"${r.name}" was already gone.`
    },
  },
  // Only a routine's run is granted these (the `routine` group, workspaces.md): how it reports
  // its path and how it ended (routines.md).
  routine_step: {
    description: "Say a step of this run started or ended, by its id from the prompt's list.",
    inputSchema: { type: 'object', properties: { step: { type: 'string' }, status: { type: 'string', enum: ['started', 'done', 'failed', 'skipped'] } }, required: ['step', 'status'] },
    async run({ step, status }, grant) {
      if (!work.routines) return 'Routines are not available on this server.'
      await work.routines.step(grant.workspaceId, { step, status })
      return `Step ${trim(step)}: ${status}.`
    },
  },
  routine_end: {
    description: 'End this run, once: nothing (nothing to do), done (text: what changed) or needs-you (text: the question; the run becomes a chat).',
    inputSchema: { type: 'object', properties: { outcome: { type: 'string', enum: ['nothing', 'done', 'needs-you'] }, text: { type: 'string' } }, required: ['outcome'] },
    async run({ outcome, text = '' }, grant) {
      if (!work.routines) return 'Routines are not available on this server.'
      await work.routines.end(grant.workspaceId, { outcome, text })
      return outcome === 'needs-you' ? 'Recorded. Stop here: the owner reads this chat and answers.' : 'Recorded. Stop here: nobody reads this run.'
    },
  },
  // The day as a routine's run reads it (routines.md, *The digest*): inputs and replies, never results.
  chats_digest: {
    description: "Each chat active since a time, routine runs left out: its repos, commits, commands, files edited and final replies. Default since: this routine's last run.",
    inputSchema: {
      type: 'object',
      properties: { since: { type: 'string', description: 'ISO time with offset' }, max_bytes: { type: 'integer', minimum: 1000, maximum: DIGEST_MAX } },
    },
    async run({ since = '', max_bytes = DIGEST_CAP }, grant) {
      if (!work.chatsDigest) return 'The digest is not available on this server.'
      let from = 0
      if (trim(since)) {
        if (!ISO_WITH_OFFSET.test(trim(since))) throw new Error('since is an ISO time with an offset, like 2026-10-15T00:00:00-05:00')
        from = Date.parse(trim(since))
      }
      const cap = Math.min(DIGEST_MAX, Math.max(1000, Math.trunc(Number(max_bytes)) || DIGEST_CAP))
      return work.chatsDigest({ since: from, maxBytes: cap }, grant)
    },
  },
  discord_send: {
    description: "Post a message to the owner's Discord, as this chat, through the webhook in Outpost's settings. Only when the person asked to be told there.",
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'Markdown, read on a phone: a table is sent as a list; cut at 3,500 characters' }, title: { type: 'string', description: 'Default "From <chat>"' } },
      required: ['message'],
    },
    async run({ message, title = '' }, grant) {
      const text = trim(message)
      if (!text) throw new Error('The message is empty')
      if (!(await notifySettings()).configured) return 'No Discord webhook is saved in Settings › Notifications, so nothing was sent.'
      const now = Date.now()
      const recent = (sent.get(grant.workspaceId) || []).filter((at) => now - at < HOUR_MS)
      if (recent.length >= SENDS_PER_HOUR) return `Not sent: this chat has sent ${SENDS_PER_HOUR} in the last hour. Put what is left in one message, later.`
      const thread = roster ? (await roster()).threads.find((t) => t.workspace?.id === grant.workspaceId) : null
      const r = await notify({ event: 'chat-message', thread, label: thread ? '' : 'A chat', title: trim(title).slice(0, 200), message: text })
      if (!r.ok) throw new Error(`Discord did not take it: ${r.error}`)
      sent.set(grant.workspaceId, [...recent, now])
      return 'Sent to Discord.'
    },
  },
  memory_search: {
    description:
      "Search what was said in every chat on this machine, the per-repo memory and the catalogued repos' docs.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for' },
        kinds: { type: 'array', items: { type: 'string', enum: ['chat', 'answer', 'memory', 'doc'] }, description: 'Narrow to these; chat is prompts' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['query'],
    },
    async run({ query, kinds = [], limit = 15 }) {
      const hits = await search(query, { kinds, limit })
      if (!hits.length) return 'Nothing matched.'
      return hits
        .map((h, i) => {
          const when = h.at ? new Date(h.at).toISOString().slice(0, 10) : ''
          const where = h.kind === 'doc' ? `${h.ref?.repo || ''}:${h.ref?.path || ''}` : h.kind === 'memory' ? `memory/${h.ref?.file || ''}` : `chat ${h.ref?.sessionId?.slice(0, 8) || ''}`
          return `${i + 1}. [${h.kind}] ${h.title}${when ? ` (${when})` : ''} — ${where}\n   ${h.snippet.replace(/\s+/g, ' ')}`
        })
        .join('\n')
    },
  },
  chats_list: {
    description: 'Recent chats, newest first: title, repo, when, whether running.',
    inputSchema: { type: 'object', properties: { repo: { type: 'string', description: 'Only this repo' }, limit: { type: 'integer', minimum: 1, maximum: 100 } } },
    async run({ repo = '', limit = 20 }) {
      if (!roster) return 'The roster is not available.'
      const { threads } = await roster()
      // A routine's run not promoted to a chat is not one (routines.md).
      const all = threads.filter((t) => !t.archived && !t.workspace?.hidden && (!repo || t.project === repo))
      const rows = all.slice(0, limit)
      if (!rows.length) return 'No chats.'
      return (
        rows
          .map((t) => `- ${t.title || 'Untitled'} — ${t.project || ''}${t.gitBranch ? ` @ ${t.gitBranch}` : ''}, ${new Date(t.lastActivityAt || 0).toISOString().slice(0, 16)}${t.running ? ', running' : ''}`)
          .join('\n') + (all.length > rows.length ? `\n…(${all.length - rows.length} older; a larger limit, up to 100, lists more)` : '')
      )
    },
  },
  catalogue_list: {
    description: "The catalogue's repos, or one repo's files at its base branch, without a checkout.",
    inputSchema: {
      type: 'object',
      properties: { repo: { type: 'string', description: 'A repo id; omit to list the catalogue' }, dir: { type: 'string', description: 'A directory inside it' }, offset: { type: 'integer', description: 'Entries to skip' } },
    },
    async run({ repo = '', dir = '', offset = 0 }) {
      if (!repo) {
        const repos = await listRepos()
        return repos.length ? repos.map((r) => `- ${r.id}: ${r.name} (${r.url}${r.baseBranch ? `, base ${r.baseBranch}` : ''})`).join('\n') : 'The catalogue is empty.'
      }
      const r = await repoById(repo)
      if (!r) return `No repo "${repo}" in the catalogue.`
      const mirror = mirrorPath(r.id)
      const base = r.baseBranch || (await defaultBranch(mirror))
      const out = await git(['ls-tree', '--name-only', `origin/${base}`, dir ? `${dir.replace(/\/?$/, '/')}` : '.'], { cwd: mirror, timeout: 30000 })
      const names = out.split('\n').filter(Boolean)
      if (!names.length) return '(empty)'
      const from = Math.max(0, Math.trunc(Number(offset)) || 0)
      const shown = names.slice(from, from + LIST_CAP)
      const rest = names.length - from - shown.length
      return shown.join('\n') + (from || rest > 0 ? `\n…(entries ${from + 1}–${from + shown.length} of ${names.length}${rest > 0 ? `; call again with offset ${from + shown.length} for the rest` : ''})` : '')
    },
  },
  catalogue_read: {
    description: "Read a catalogued repo's file at its base branch, without a checkout.",
    inputSchema: { type: 'object', properties: { repo: { type: 'string' }, path: { type: 'string' }, offset: OFFSET }, required: ['repo', 'path'] },
    async run({ repo, path: file, offset = 1 }) {
      const r = await repoById(repo)
      if (!r) return `No repo "${repo}" in the catalogue.`
      const mirror = mirrorPath(r.id)
      const base = r.baseBranch || (await defaultBranch(mirror))
      const text = await git(['show', `origin/${base}:${String(file).replace(/^\/+/, '')}`], { cwd: mirror, timeout: 30000 })
      const w = lineWindow(text, offset)
      return `${w.text}${windowNote(w)}`
    },
  },
  github_pull_status: {
    description: "A catalogued repo's pull requests for a branch, or every open one: state, draft, the head's checks.",
    inputSchema: { type: 'object', properties: { repo: { type: 'string', description: 'A repo id' }, branch: { type: 'string' } }, required: ['repo'] },
    async run({ repo, branch = '' }) {
      const r = await repoById(repo)
      if (!r) return `No repo "${repo}" in the catalogue.`
      const pulls = await githubPullStatus(r.url, branch)
      if (!pulls.length) return branch ? `No pull request for ${branch}.` : 'No open pull requests.'
      return pulls.map((p) => `#${p.number} ${p.title} — ${p.state}${p.draft ? ' (draft)' : ''}, ${p.head} → ${p.base}${p.checks ? `, checks ${p.checks}` : ''}\n   ${p.url}`).join('\n')
    },
  },
  // The three below read a repo of this chat (its only one when none is named) or any
  // catalogue repo (`githubRepoFor`); what other people wrote is scrubbed as a build log is.
  github_pull_comments: {
    description: "What was said on a pull request, oldest first: reviews' verdicts, line comments with file and line, the conversation. Default this chat's own pull request.",
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'integer' },
        repo: { type: 'string', description: "Id or name; default this chat's" },
        limit: { type: 'integer', description: `The latest this many, up to ${COMMENTS_MAX}` },
      },
    },
    async run({ number = 0, repo = '', limit = COMMENTS }, grant) {
      const target = await work.githubRepoFor(grant.workspaceId, repo)
      const pr = await githubPull(target.url, { number: Number(number) || target.pr, branch: target.branch })
      const want = Math.min(Math.max(Math.trunc(Number(limit)) || COMMENTS, 1), COMMENTS_MAX)
      const c = await githubPullComments(target.url, pr.number, { limit: want, chars: COMMENT_CHARS })
      const head = `#${pr.number} ${pr.title} — ${pr.state}${pr.draft ? ' (draft)' : ''}, ${pr.head} → ${pr.base}, by ${pr.author}\n${pr.url}`
      if (!c.total) return `${head}\nNothing said on it yet.`
      const earlier = c.total - c.comments.length
      return [
        head,
        ...(earlier > 0 ? [`…(${earlier} earlier${want < COMMENTS_MAX ? `; limit up to ${COMMENTS_MAX} shows more` : ''})`] : []),
        ...c.comments.map((x) => `[${shortTime(x.at)}] ${x.who} ${x.what}${x.body ? `:\n${x.body}` : ''}`),
        ...(c.capped ? ['(only the first hundred of each kind were read; GitHub has the rest)'] : []),
      ].join('\n\n')
    },
  },
  github_actions: {
    description: "GitHub Actions runs for a branch or commit (default this chat's work branch), or with `run`, that run's jobs and the end of each failed job's log; secrets scrubbed.",
    inputSchema: {
      type: 'object',
      properties: {
        run: { type: 'integer', description: 'A run id, as the list gives it' },
        branch: { type: 'string' },
        commit: { type: 'string' },
        repo: { type: 'string', description: "Id or name; default this chat's" },
        lines: { type: 'integer', description: 'Per failed job, up to 400' },
      },
    },
    async run({ run = 0, branch = '', commit = '', repo = '', lines = 80 }, grant) {
      const target = await work.githubRepoFor(grant.workspaceId, repo)
      if (run) {
        const keep = Math.min(Math.max(Number(lines) || 80, 10), 400)
        const r = await githubRun(target.url, run, { lines: keep, bytes: keep * LOG_LINE_BYTES })
        const head = `${r.workflow} #${r.id} ${r.result} — ${r.branch} @ ${r.commit}\n${r.url}\nJobs: ${r.jobs.map((j) => `${j.name} ${j.result}`).join(', ') || 'none'}`
        const more = (f) => (f.lines < f.of ? `\n…(the last ${f.lines} of ${f.of} lines${keep < 400 ? '; lines up to 400 shows more' : ''})` : '')
        return [head, ...r.failed.map((f) => `── ${f.name} ${f.result}${f.steps.length ? ` at ${f.steps.join(', ')}` : ''} ──\n${f.text}${more(f)}`)].join('\n\n')
      }
      const on = branch || (commit ? '' : target.branch)
      const r = await githubRuns(target.url, { branch: on, commit, limit: RUNS })
      if (!r.runs.length) return `No Actions runs${on ? ` on ${on}` : ''}${commit ? ` for ${commit}` : ''}.`
      return (
        r.runs.map((x) => `${x.id} ${x.workflow} — ${x.result}${x.attempt > 1 ? ` (attempt ${x.attempt})` : ''}, ${x.branch} @ ${x.commit}, ${x.event}, ${shortTime(x.at)}${x.title && x.title !== x.workflow ? `\n   ${x.title}` : ''}`).join('\n') +
        (r.total > r.runs.length ? `\n…(${r.total - r.runs.length} older)` : '') +
        '\nCall again with run for one run\'s failed jobs and log.'
      )
    },
  },
  github_issue: {
    description: 'Read a GitHub issue (or a pull request as one): title, state, labels, its text and its latest comments.',
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'integer' },
        repo: { type: 'string', description: "Id or name; default this chat's" },
        comments: { type: 'integer', description: `The latest this many, up to ${COMMENTS_MAX}` },
      },
      required: ['number'],
    },
    async run({ number, repo = '', comments = ISSUE_COMMENTS }, grant) {
      const target = await work.githubRepoFor(grant.workspaceId, repo)
      const want = Math.min(Math.max(Math.trunc(Number(comments)) || 0, 0), COMMENTS_MAX)
      const i = await githubIssue(target.url, number, { comments: want, chars: COMMENT_CHARS, bodyChars: ISSUE_CHARS })
      const meta = [i.labels.length ? `labels ${i.labels.join(', ')}` : '', i.assignees.length ? `assigned to ${i.assignees.join(', ')}` : ''].filter(Boolean).join('; ')
      const earlier = i.total - i.comments.length
      return [
        `${i.pull ? 'Pull request' : 'Issue'} #${i.number} ${i.title} — ${i.state}, by ${i.author}${meta ? `; ${meta}` : ''}\n${i.url}`,
        i.body || '(no description)',
        ...(earlier > 0 ? [`…(${earlier} earlier comment${earlier === 1 ? '' : 's'}${want < COMMENTS_MAX ? `; comments up to ${COMMENTS_MAX} shows more` : ''})`] : []),
        ...i.comments.map((c) => `[${shortTime(c.at)}] ${c.who}:\n${c.body}`),
      ].join('\n\n')
    },
  },
  jenkins_job_status: {
    description: "A Jenkins job's last build, build `number`, or the one that built `commit`: result, time, whether another is queued.",
    inputSchema: {
      type: 'object',
      properties: {
        job: { type: 'string', description: 'Folders and branches joined by / ("app/main")' },
        number: { type: 'number' },
        commit: { type: 'string', description: 'Seven or more characters' },
      },
      required: ['job'],
    },
    async run({ job, number = 0, commit = '' }) {
      const s = await jenkinsJobStatus(job, { number, commit })
      const b = s.lastBuild
      if (!b) return `${s.job}: ${s.missing || 'no builds'}`
      return `${s.job}: #${b.number} ${b.result} at ${new Date(b.at).toISOString().slice(0, 16)}${b.url ? ` ${b.url}` : ''}${s.inQueue ? ' (another queued)' : ''}`
    },
  },
  jenkins_build_log: {
    description:
      "Which stages of a Jenkins build failed and the end of each one's output, or of the whole log; secrets scrubbed.",
    inputSchema: {
      type: 'object',
      properties: {
        job: { type: 'string' },
        number: { type: ['number', 'string'], description: 'Default lastBuild; lastFailedBuild works' },
        lines: { type: 'number', description: 'Per failed stage, up to 400' },
      },
      required: ['job'],
    },
    async run({ job, number = '', lines = 80 }) {
      const keep = Math.min(Math.max(Number(lines) || 80, 10), 400)
      const r = await jenkinsBuildLog(job, number, { lines: keep, bytes: keep * LOG_LINE_BYTES })
      const head = `${r.job} #${r.number} ${r.result}${r.failed.length ? ` — failed at ${r.failed.join(', ')}` : ''}${r.url ? `\n${r.url}` : ''}${r.cut ? '\n(the log is long; only its end was read)' : ''}`
      // Each part says when it is not all its stage printed, and how to see more of it.
      const more = (p) => (p && p.lines < p.of ? `\n…(the last ${p.lines} of ${p.of} lines${keep < 400 ? '; lines up to 400 shows more' : ''})` : '')
      const body = r.sections.length ? r.sections.map((s) => `── ${s.stage} ──\n${s.text}${more(s)}`).join('\n\n') : `── the end of the log ──\n${r.tail}${more(r.tailLines)}`
      return `${head}\n\n${body}`
    },
  },
  jenkins_test_report: {
    description: "A Jenkins build's failing tests (default the last build): counts, then each with its message and the top of its stack.",
    inputSchema: {
      type: 'object',
      properties: { job: { type: 'string' }, number: { type: ['number', 'string'] }, limit: { type: 'integer', description: `Up to ${TEST_CASES_MAX}` } },
      required: ['job'],
    },
    async run({ job, number = '', limit = TEST_CASES }) {
      const want = Math.min(Math.max(Math.trunc(Number(limit)) || TEST_CASES, 1), TEST_CASES_MAX)
      const t = await jenkinsTestReport(job, number, { limit: want })
      if (!t) return `That build published no test report (a job publishes one with a junit step).`
      const head = `${t.failCount} failed, ${t.passCount} passed, ${t.skipCount} skipped`
      if (!t.failing.length) return head
      const rest = t.failCount - t.failing.length
      return `${head}\n\n${t.failing.map((f) => `✗ ${f.name} (${f.status})\n${f.error}${f.stack ? `\n${f.stack}` : ''}`).join('\n\n')}${rest > 0 ? `\n\n…(${rest} more failing${want < TEST_CASES_MAX ? `; limit up to ${TEST_CASES_MAX} shows more` : ''})` : ''}`
    },
  },
  jenkins_job_info: {
    description: "A Jenkins job's parameters with defaults and choices, its last ten builds, and its branches if multibranch.",
    inputSchema: { type: 'object', properties: { job: { type: 'string' } }, required: ['job'] },
    async run({ job }) {
      const j = await jenkinsJobInfo(job)
      const params = j.params.length
        ? j.params.map((p) => `  ${p.name} (${p.type})${p.default !== '' ? ` = ${p.default}` : ''}${p.choices.length ? ` — one of ${p.choices.join(', ')}` : ''}${p.description ? ` — ${p.description}` : ''}`).join('\n')
        : '  none'
      const builds = j.builds.map((b) => `  #${b.number} ${b.result} ${new Date(b.at).toISOString().slice(0, 16)} (${Math.round((b.durationMs || 0) / 1000)} s)`).join('\n') || '  none'
      const branches = j.branches.slice(0, BRANCH_CAP).join(', ') + (j.branches.length > BRANCH_CAP ? ` …and ${j.branches.length - BRANCH_CAP} more` : '')
      return `${j.job}${j.buildable ? '' : ' (disabled)'}${j.inQueue ? ' (a build is queued)' : ''}\nParameters:\n${params}\nRecent builds:\n${builds}${j.branches.length ? `\nBranches (address one as ${j.job}/<branch>): ${branches}` : ''}`
    },
  },
  jenkins_abort: {
    description: 'Stop a running Jenkins build.',
    inputSchema: { type: 'object', properties: { job: { type: 'string' }, number: { type: 'number' } }, required: ['job', 'number'] },
    async run({ job, number }) {
      const b = await jenkinsAbort(job, number)
      return b.building ? `Asked ${job} #${number} to stop; it is still stopping.` : `${job} #${number}: ${b.result}`
    },
  },
  jenkins_build: {
    description: 'Start a Jenkins build. A build can deploy.',
    inputSchema: { type: 'object', properties: { job: { type: 'string' }, params: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['job'] },
    async run({ job, params = {} }, grant) {
      const r = await jenkinsBuild(job, params)
      await watchBuild({ workspaceId: grant.workspaceId, job: r.job, queueUrl: r.queueUrl }).catch(() => {})
      return `Queued a build of ${r.job}. Call jenkins_wait with job "${r.job}" for its result, or carry on — you are woken if it fails.`
    },
  },
  jenkins_wait: {
    description:
      'Wait up to nine minutes for a Jenkins build this chat started or pushed, answered the moment it reports: cheaper than being woken.',
    inputSchema: {
      type: 'object',
      properties: {
        job: { type: 'string', description: 'Omit for the latest' },
        number: { type: 'number' },
      },
    },
    async run({ job = '', number = 0 }, grant) {
      const r = await waitFor(grant.workspaceId, { job, number }, undefined, grant.signal)
      if (r.error) return r.error
      const what = r.watch.job ? `${r.watch.job}${r.watch.number ? ` #${r.watch.number}` : ''}` : `the build of ${r.watch.commit.slice(0, 7)}`
      if (!r.result) return `${what} has not reported yet after nine minutes. Call jenkins_wait again to keep waiting, or carry on — you are woken if it fails.`
      return `${describeResult(r.result)}${r.result.url ? `\n${r.result.url}` : ''}`
    },
  },
}

function allowedTools(groups) {
  const names = new Set()
  for (const g of groups || []) for (const n of TOOL_GROUPS[g] || []) names.add(n)
  return [...names]
}

/**
 * The permission rule that lets a session call its granted tools without a prompt: the whole
 * server, `mcp__<server>`, which the CLI reads as every tool it offers — present and future.
 * Written into the workspace policy (workspaces.md), because a routine's run has nobody to
 * answer "Do you want to proceed?". One rule rather than a name per tool, because `tools/list`
 * already offers a chat only what its groups grant (`allowedTools`): naming them again in the
 * policy added nothing but a list that went stale, and every chat from before a new tool was
 * asked about it (2026-10-17). What it settles: an Outpost tool never relies on the CLI's own
 * prompt; one that needs a yes asks on the bar itself (`OUTPOST_ASK`, launchers.md).
 */
export const toolRulesFor = (groups) => (allowedTools(groups).length ? [`mcp__${SERVER_NAME}`] : [])

/**
 * What `initialize` tells the session about this server. The CLI puts it in the system prompt
 * of every session with Outpost's tools, so it is part of the fixed overhead (server/tokens.ts).
 */
export const MCP_INSTRUCTIONS =
  'Outpost, the harness running this session. memory_search answers from past chats, memory and repo docs, and what an earlier chat decided, without cloning anything.'

/**
 * The tools `groups` grant, as the model is shown them: the CLI's name, the description and
 * the input schema. For measuring what a grant costs a session (server/tokens.ts); `tools/list`
 * may offer fewer, since `usableTools` drops what is not configured.
 */
export const offeredTools = (groups) =>
  allowedTools(groups).map((n) => ({ name: `mcp__${SERVER_NAME}__${n}`, description: TOOLS[n].description, input_schema: TOOLS[n].inputSchema }))

// ── the wire ──────────────────────────────────────────────────────────────────────────

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0:0:0:0:0:0:0:1'])
const hostOf = (v) => String(v || '').replace(/^\[/, '').replace(/\]?:\d+$/, '').toLowerCase()

/** A socket address on this machine's loopback: 127/8, `::1`, or 127/8 as IPv4-mapped IPv6 (a dual-stack bind). */
export const loopbackAddress = (addr) => {
  const a = String(addr || '').toLowerCase().replace(/^::ffff:/, '')
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a)
}

/** Headers a proxy adds when it relays somebody else's request (hooks.md). */
const FORWARDED_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip']

/**
 * Whether a request came from a process on this machine, for the two callers that are not
 * the page: hooks (`/api/hook`) and sessions calling tools (`/mcp`). Judged on the socket's
 * real address, never the `Host` header alone — `Host` is written by the client, so anything on
 * the LAN could send `Host: 127.0.0.1` and pass. Every real caller connects to `127.0.0.1`: a
 * session on the host directly, a container on the host network the same, and a `private`
 * container through pasta's `-T` forward, which opens its own connection to the host's
 * loopback (containers/index.mjs). A proxy running here also connects from loopback while
 * relaying the LAN, so a request carrying any forwarding header is not from this machine.
 * The loopback `Host` stays required too: a page in a browser here, pointed at a rebinding
 * name, arrives from loopback with that name as its `Host`.
 */
export function fromThisMachine(req) {
  if (!loopbackAddress(req.socket?.remoteAddress)) return false
  if (!LOOPBACK.has(hostOf(req.headers.host))) return false
  return !FORWARDED_HEADERS.some((h) => req.headers[h] !== undefined)
}
const equals = (a, b) => {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

function reply(res, status, body) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

async function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('Body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export async function handleMcp(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { error: 'POST only' })
  if (!fromThisMachine(req)) return reply(res, 403, { error: 'Not from this machine' })
  const auth = String(req.headers.authorization || '')
  const presented = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  await loadTokens()
  let grant = null
  for (const [t, rec] of tokens) {
    if (equals(t, presented)) {
      grant = rec
      break
    }
  }
  if (!grant) return reply(res, 401, { error: 'No such token' })

  let msg
  try {
    msg = JSON.parse(await readBody(req))
  } catch {
    return reply(res, 400, rpcError(null, -32700, 'Parse error'))
  }
  // The caller hanging up before the answer — an interrupted turn, a session ended — aborts
  // anything that would otherwise wait on its behalf: `jenkins_wait` withdraws its wait, so the
  // result goes by the repo's rule instead of to a call nobody is holding. A server that is
  // stopping runs none of this (nothing here handles SIGTERM), which is what lets a wait cut
  // off by a restart still wake its chat (jenkins-results.mjs).
  const hangUp = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) hangUp.abort()
  })
  const call = { ...grant, signal: hangUp.signal }
  // A batch is answered one by one; a notification (no id) is accepted and answered with nothing.
  const messages = Array.isArray(msg) ? msg : [msg]
  const answers = []
  for (const m of messages) {
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
      answers.push(rpcError(m?.id, -32600, 'Invalid request'))
      continue
    }
    if (m.id === undefined) continue
    answers.push(await dispatch(m, call))
  }
  if (!answers.length) return reply(res, 202)
  return reply(res, 200, Array.isArray(msg) ? answers : answers[0])
}

async function dispatch(m, grant) {
  // What the workspace was granted, less what cannot work right now: a GitHub tool with no
  // GitHub token, a Jenkins tool with no Jenkins. Asked per call, so configuring one in
  // Settings reaches running chats without a restart.
  const names = await usableTools(allowedTools(grant.groups))
  switch (m.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id: m.id,
        result: {
          protocolVersion: typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: '1' },
          instructions: MCP_INSTRUCTIONS,
        },
      }
    case 'ping':
      return { jsonrpc: '2.0', id: m.id, result: {} }
    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id: m.id,
        result: { tools: names.map((n) => ({ name: n, description: TOOLS[n].description, inputSchema: TOOLS[n].inputSchema })) },
      }
    case 'tools/call': {
      const name = String(m.params?.name || '')
      if (!names.includes(name)) return rpcError(m.id, -32602, `Unknown tool "${name}"`)
      try {
        // A Jenkins tool reaches only the jobs this chat may use (integrations-ci.md): asked here,
        // once, rather than in each tool, so a tool added later cannot forget it.
        if (JOB_TOOLS.has(name)) await mayUseJob(name, String(m.params?.arguments?.job || ''), grant)
        const text = await TOOLS[name].run(m.params?.arguments || {}, grant)
        return { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: String(text) }] } }
      } catch (err) {
        return { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `Error: ${String(err?.message || err)}` }], isError: true } }
      }
    }
    default:
      return rpcError(m.id, -32601, `Method not found: ${m.method}`)
  }
}
