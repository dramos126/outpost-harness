/**
 * Workspaces: where a chat's work lives. One directory per chat under `~/.outpost/workspaces`,
 * holding a manifest, a checkout per chosen repo, and the preparation log.
 *
 * A workspace is the fourth axis beside harness, launcher and hooks (architecture.md): it
 * *produces* the directory a session is started in and the arguments it is started with, and
 * that is the whole of its contract with the other three. The session does not know it is in
 * one; the launcher is handed a folder as it always was; the hooks report as they always did.
 *
 * Every byte under a workspace was put there by Outpost, which is what makes deleting one safe
 * to offer — and the one thing that is never deleted on Outpost's own say-so is a checkout
 * with uncommitted or unpushed work.
 */
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { DEFAULT_MODEL, idFor, listRepos, nameFromUrl, repoById, testRemote } from './catalogue.mjs'
import { detectEnv, detectPackages, detectSetup } from './scan.mjs'
import {
  addDetachedWorktree,
  defaultBranch,
  ensureMirror,
  excludeGenerated,
  fetchBranch,
  fillCheckout,
  freeBranchName,
  git,
  startWorkBranch,
  mergeBase,
  mergeInto,
  mirrorPath,
  pushBranch,
  pushTag,
  pushToBase,
  remoteHasBranch,
  remoteHasTag,
  removeWorktree,
  sweepMirror,
  MIRRORS_DIR,
  validBranchName,
  worktreeStatus,
  heldWork,
} from './git.mjs'
import { describeStep } from './push-steps.mjs'
import { watchBuild, watchCommit } from '../jenkins-results.mjs'
import { hostsNamed } from '../hosts.mjs'
import { githubCreatePull, githubMergePull, githubPull, integrationsView, jenkinsBuild, jobAllowed, listJenkinsJobs, remoteFor, repoKey } from '../integrations.mjs'
import { readSettings } from '../config.mjs'
import { GENERATED, writePointerFile, writePolicy } from './policy.mjs'
import { copySource, writeEnvLocal } from './data.mjs'
import { DATASETS_DIR, datasetNamed, manifestOf, provisionData, publishWrite, readState, removeFromSource, syncRead, syncWrite, takeSnapshot } from './datasets.mjs'
import { FORWARDED_PORTS, containerPlan, removeContainerFiles, removeContainers, runInContainer } from '../containers/index.mjs'
import { assignHostPorts, detectPorts } from '../containers/ports.mjs'
import { hookStates } from '../state/hooks.mjs'
import { envVars } from './environment.mjs'
import { APPROVAL_TOOL, DEFAULT_TOOLS, TOOL_GROUPS, mcpConfigFor, mintMcpToken, revokeMcpTokens, toolRulesFor } from '../mcp/index.mjs'
import * as structured from '../launchers/structured.mjs'
import { PORT } from '../auth.mjs'
import { trustDirectory } from '../trust.mjs'

export const WORKSPACES_DIR = process.env.OUTPOST_WORKSPACES || path.join(os.homedir(), '.outpost', 'workspaces')

const MANIFEST = 'workspace.json'
const LOG = 'prepare.log'
/** A setup command that has not finished in this long is not going to. */
const SETUP_TIMEOUT_MS = 15 * 60 * 1000
/** git status per checkout is cheap but not free; the roster asks every few seconds. */
const STATUS_TTL_MS = 8000
/**
 * What a free-Bash chat may run without asking (launchers.md). WebFetch and WebSearch ride with
 * Bash because `curl` in the same box already reaches the web unprompted: asking for them there
 * fences nothing and only stalls the chat on the bar.
 */
const FREE_BASH_ALLOW = ['Bash', 'WebFetch', 'WebSearch']

/** @type {Map<string, object>} id -> manifest, as last read or written */
const manifests = new Map()
let loaded = false
/** @type {Map<string, { at: number, status: object }>} checkout path -> git status */
const statusCache = new Map()
/** @type {Map<string, Promise<void>>} id -> the preparation in flight */
const preparing = new Map()

const now = () => Date.now()
const dirFor = (id) => path.join(WORKSPACES_DIR, id)

export function slugify(text, fallback = 'chat') {
  const s = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 6)
    .join('-')
  return s.slice(0, 40).replace(/-+$/, '') || fallback
}

/** A short name for a chat from its first prompt, or the repos, or the date. */
function nameFor(spec, repos) {
  const prompt = String(spec.prompt || '').trim()
  if (prompt) {
    const words = prompt.split(/\s+/).slice(0, 8).join(' ')
    return words.length < prompt.length ? `${words}…` : words
  }
  if (repos.length) return repos.map((r) => r.name).join(' + ')
  return `Chat ${new Date().toLocaleDateString([], { day: 'numeric', month: 'short' })}`
}

async function load() {
  if (loaded) return
  loaded = true
  let ids = []
  try {
    ids = await fsp.readdir(WORKSPACES_DIR)
  } catch {
    return
  }
  for (const id of ids) {
    try {
      const m = JSON.parse(await fsp.readFile(path.join(dirFor(id), MANIFEST), 'utf8'))
      if (m && m.id === id) manifests.set(id, m)
    } catch {
      /* a directory without a manifest is not a workspace */
    }
  }
  await forgetStranded(new Set(ids)).catch((err) => console.warn('[outpost] could not clear stranded session records:', err?.message || err))
  // A restart owed for /addRepo when Outpost last stopped (remountWhenIdle).
  for (const m of manifests.values()) for (const name of Array.isArray(m.remountOwed) ? m.remountOwed : []) remountWhenIdle(m, name)
  // A publish's deletions still waiting on the person when Outpost last stopped: asked again.
  for (const m of manifests.values()) armPendingDeletes(m)
}

/**
 * Session records whose workspace folder is gone, forgotten once at load. A delete takes its
 * records with it now (`deleteWorkspace`), but one deleted before that did, or removed by
 * hand, left a record and a stream folder nothing would ever come back for.
 *
 * Judged on the folder, not the manifest: a workspace whose manifest will not parse is still
 * there, and its record is what Resume starts from. And only ever with a listing that worked
 * — `load` returns before this when the workspaces folder cannot be read, since an unreadable
 * folder would otherwise look like every workspace gone.
 */
async function forgetStranded(present) {
  const gone = new Set()
  for (const rec of await structured.allRecords()) {
    if (rec.workspaceId && !present.has(rec.workspaceId)) gone.add(rec.workspaceId)
  }
  for (const id of gone) {
    const n = await structured.forgetWorkspace(id)
    if (n) console.log(`[outpost] forgot ${n} session record${n === 1 ? '' : 's'} of workspace ${id}, which is no longer on disk`)
  }
}

/**
 * One chat's manifest writes, one after another. Two at once shared the temp file, and the
 * second rename found it gone: with setup running beside the session, a write from setup's
 * queue and one from its runner crossed, the runner threw before its first line, and setup
 * sat "running" forever (2026-10-04). Each write now waits for the last.
 */
const writing = new Map()

function write(m) {
  m.updatedAt = now()
  manifests.set(m.id, m)
  const next = (writing.get(m.id) || Promise.resolve()).catch(() => {}).then(async () => {
    const dir = dirFor(m.id)
    await fsp.mkdir(dir, { recursive: true })
    const file = path.join(dir, MANIFEST)
    const tmp = `${file}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(m, null, 2) + '\n')
    await fsp.rename(tmp, file)
  })
  writing.set(m.id, next)
  return next
}

function logger(id) {
  const file = path.join(dirFor(id), LOG)
  let chain = Promise.resolve()
  return (line) => {
    const stamp = new Date().toISOString().slice(11, 19)
    chain = chain.then(() => fsp.appendFile(file, `${stamp}  ${line}\n`)).catch(() => {})
    return chain
  }
}

/**
 * How a session launched from the dashboard handles permissions, unless a caller says
 * otherwise. Set rather than inherited on purpose: a session you drive from another machine
 * should not behave differently depending on how the box hosting it happens to be
 * configured, and this is also the switch that decides how often a chat ends up waiting on
 * you.
 *
 * `acceptEdits`, not `default`: a session is launched into a checkout Outpost has just seeded
 * trust on, and asking permission to edit the files of the repo it was started in is a
 * question with one answer. Every edit was a prompt, and a prompt is an interruption for
 * whoever is holding a phone. The mode covers file edits and the common filesystem commands
 * (`mkdir`, `touch`, `mv`, `cp`) for paths *in the working directory*, so an edit outside the
 * repo still asks; other commands still ask, which is why this is not `bypassPermissions`.
 * `OUTPOST_PERMISSION_MODE` overrides it, and the modes the CLI accepts are `acceptEdits`,
 * `auto`, `bypassPermissions`, `manual`, `dontAsk` and `plan`.
 */
export const DEFAULT_PERMISSION_MODE = process.env.OUTPOST_PERMISSION_MODE || 'acceptEdits'

/**
 * The modes a chat's spec or a repo's entry may name: what the page's selects offer (Settings ›
 * Repos, a routine's own). They reach `--permission-mode` as an argument, so anything else —
 * a typo, or a value shaped like another flag — is dropped for the next default, never passed.
 */
const OFFERED_MODES = new Set(['default', 'acceptEdits', 'plan', 'dontAsk'])
/** Every mode the CLI takes; the caller's default (code, or the owner's OUTPOST_PERMISSION_MODE) may be any. */
const CLI_MODES = new Set([...OFFERED_MODES, 'manual', 'auto', 'bypassPermissions'])
const FALLBACK_MODE = 'acceptEdits'

/**
 * The groups Outpost gives rather than a person: `approval` to every session, `work` to every
 * workspace chat, and `routine` (routine_step, routine_end) to a routine's run and nothing
 * else — a chat that could call `routine_end` would be saying how a run it is not ended.
 */
const CHOSEN_BY_OUTPOST = new Set(['approval', 'work', 'routine'])
const ownGroups = (m) => ['work', ...(m.routine ? ['routine'] : [])]

/** A spec's `routine`, kept only whole: which routine, its name, which run. */
function runOf(r) {
  const id = String(r?.id || '').trim()
  const runId = String(r?.runId || '').trim()
  return id && runId ? { id, name: String(r?.name || '').trim(), runId } : null
}

/**
 * Nobody is there to ask: a routine's run until it is promoted to a chat, a schedule's from
 * before routines, or a chat told never to ask.
 */
const unattended = (m) => Boolean((m.routine && !m.routine.promoted) || m.schedule) || m.permissionMode === 'dontAsk'

/** The chat's mode: the spec's, else the first repo's, if offered; else the caller's default. */
export function permissionModeFor(spec, recipe, defaultMode) {
  for (const v of [spec?.permissionMode, recipe?.permissionMode]) {
    const mode = String(v || '').trim()
    if (OFFERED_MODES.has(mode)) return mode
  }
  return CLI_MODES.has(defaultMode) ? defaultMode : FALLBACK_MODE
}

/**
 * A new workspace from a spec: `{ repos: [{ id, base? }], prompt?, name?, model?,
 * permissionMode? }`. Returns the manifest at once; preparation runs on, and its progress
 * is in the manifest's `status` and `step` and in the log.
 *
 * `defines` and `lead` are the caller's, never the spec's: a routine's defining chat
 * (routines.md, *Defining chats*) is `defines: { routineId }`, and `lead` is held on the manifest
 * (`heldNote`) to ride in front of the person's first message, once, as setup's note does.
 */
export async function createWorkspace(spec, { permissionMode: defaultMode, defines = null, lead = '' }) {
  await load()
  const wanted = Array.isArray(spec.repos) ? spec.repos : []
  const repos = []
  for (const w of wanted) {
    const recipe = await repoById(w.id)
    if (!recipe) throw new Error(`No repo "${w.id}" in the catalogue`)
    repos.push({ recipe, base: String(w.base || '').trim() })
  }
  const id = randomBytes(4).toString('hex')
  const name = String(spec.name || '').trim() || nameFor(spec, repos.map((r) => r.recipe))
  const slug = slugify(name)
  // The first repo is the session's cwd. Its recipe decides the defaults the spec did not.
  const first = repos[0]?.recipe
  const m = {
    id,
    name,
    slug,
    createdAt: now(),
    updatedAt: now(),
    prompt: String(spec.prompt || '').trim(),
    model: String(spec.model || '').trim() || DEFAULT_MODEL,
    permissionMode: permissionModeFor(spec, first, defaultMode),
    status: 'preparing',
    step: 'Starting',
    error: '',
    repos: repos.map(({ recipe, base }) => ({
      id: recipe.id,
      name: recipe.name,
      url: recipe.url,
      path: path.join(dirFor(id), recipe.id),
      base: base || recipe.baseBranch || '',
      branch: '',
      finish: recipe.finish || 'push',
    })),
    primary: repos.length ? path.join(dirFor(id), repos[0].recipe.id) : dirFor(id),
    launch: null,
    sessionIds: [],
    // The routine run this is, if one: `{ id, name, runId }`, and once settled `outcome`,
    // `endedAt` and `promoted` (routines.md). The roster hides a run until it is promoted.
    routine: runOf(spec.routine),
    // A chat that defines a routine (routines.md): `{ routineId }`, null until its routine_create
    // is approved. Kept off the Chats list by the page, and out of aging while its routine exists.
    ...(defines ? { defines: { routineId: String(defines.routineId || '').trim() || null } } : {}),
    ...(lead ? { heldNote: String(lead) } : {}),
    // Which tool groups the session gets from Outpost's MCP server: the spec's list if it
    // gave one, else the first recipe's, else the default. Unknown names are dropped, and so
    // are the groups nobody chooses (`ownGroups`).
    tools: (Array.isArray(spec.tools) ? spec.tools : first?.tools?.length ? first.tools : [...DEFAULT_TOOLS]).filter((g) => TOOL_GROUPS[g] && !CHOSEN_BY_OUTPOST.has(g)),
  }
  await write(m)
  const job = prepare(m, repos).finally(() => preparing.delete(id))
  preparing.set(id, job)
  return m
}

async function prepare(m, repos) {
  const log = logger(m.id)
  const step = async (text) => {
    m.step = text
    await write(m)
    await log(text)
  }
  try {
    await log(`Preparing "${m.name}" (${m.id})`)
    for (let i = 0; i < repos.length; i++) {
      const { recipe } = repos[i]
      const entry = m.repos[i]
      await step(`Fetching ${recipe.name}`)
      const remote = await remoteFor(recipe)
      const mirror = await ensureMirror(recipe, log, remote)
      if (!entry.base) entry.base = await defaultBranch(mirror)
      // On the base's latest, with no branch: one is made when work starts, named for the
      // work (`startWork`). It used to be made here, named for the chat's first message, so a
      // chat started with none was `outpost/outpost-9` and a second piece of work in the same
      // chat went on the first one's branch.
      entry.branch = ''
      await step(`Checking out ${recipe.name} at the latest ${entry.base}`)
      await addDetachedWorktree(mirror, entry.path, entry.base, log)
      const filled = await fillCheckout(entry.path, remote)
      if (filled) await log(`${recipe.name}: ${filled}`)
      await excludeGenerated(mirror, GENERATED)
      await write(m)
    }
    await step('Writing the permission policy')
    // Free-Bash chats (launchers.md): Bash runs without asking, through an allow rule in the
    // policy rather than bypassing permissions, so the deny list and the approval tool for
    // other tools and questions keep working. The setting can only be `free` with narrow mounts
    // and the private network (config.mjs), which is what makes the policy tamper-proof and the
    // network fenced; so reading it here is enough — no second guard.
    const bashFree = (await readSettings()).containers.bash === 'free'
    if (!repos.length) await fsp.mkdir(m.primary, { recursive: true })
    await writePolicies(m, bashFree)
    if (m.repos.length) {
      await writePointerFile(m.primary, { workspaceName: m.name, others: m.repos.slice(1) })
    }
    // Every chat in a container of its own, a plain one too, and none on this machine
    // (containers/index.mjs): without the runtime or a sign-in of Outpost's, it does not start.
    await step('Making its container')
    const plan = await containerPlan({ repos: m.repos, recipes: repos.map((r) => r.recipe), workspaceDir: dirFor(m.id), cwd: m.primary, mirrorPath, datasetsDir: DATASETS_DIR, log })
    if (!plan.use) throw new Error(plan.why)
    m.container = { image: plan.image }
    const publish = await assignChatPorts(m, plan)
    await write(m)
    await log(`Runs in a container (${plan.image})${plan.network === 'private' ? ', private network' : ''}`)
    // The repo's Environment now, so a secret it needs is there from the session's first
    // moment; data paths join it once setup has copied the data.
    for (let i = 0; i < repos.length; i++) await writeChatEnv(m.repos[i], repos[i].recipe, log)
    await step('Trusting the checkout')
    const trusted = await trustDirectory(m.primary)
    if (!trusted.ok) throw new Error(trusted.error)
    // Outpost's own tools, through a per-workspace token the session carries in its MCP
    // config and never sees as anything but a header (mcp/index.mjs) — and the approval
    // tool, which is the session's only way to ask anybody anything.
    let mcpArgs = []
    const groups = [...new Set([...m.tools, 'approval', ...ownGroups(m)])]
    {
      const token = await mintMcpToken(m.id, groups)
      const file = path.join(dirFor(m.id), 'mcp.json')
      await fsp.writeFile(file, JSON.stringify(mcpConfigFor({ url: `http://127.0.0.1:${PORT}/mcp`, token }), null, 2) + '\n', { mode: 0o600 })
      mcpArgs = ['--mcp-config', file]
      await log(`Tools: ${m.tools.join(', ') || 'none'} (and the approval surface)`)
    }
    await step('Starting the session')
    // A manifest written before modes were checked may hold anything; it is never passed as is.
    const extra = [...mcpArgs, '--permission-mode', CLI_MODES.has(m.permissionMode) ? m.permissionMode : FALLBACK_MODE]
    // Always a model: a chat given none runs on the default, never on whatever the CLI's own
    // settings happen to say on this machine.
    extra.push('--model', (m.model || DEFAULT_MODEL).split(/\s+/)[0].toLowerCase())
    for (const entry of m.repos.slice(1)) extra.push('--add-dir', entry.path)
    // Setup runs alongside the session, not before it (the owner's): the chat is there to read
    // and plan in as soon as its checkouts are, and the session is told setup is still running
    // so it neither trips over a half-installed tree nor installs over the setup.
    // Only the repos that have something to set up: a repo with no setup commands and no data
    // has no setup, no "do not install" and no note — Outpost's own had none, and its chat was
    // told to wait for an install that never came, then that it had finished (2026-10-04).
    const needing = []
    for (const r of m.repos.filter((x) => !x.oneOff)) if (await hasSetup(await repoById(r.id))) needing.push(r)
    const toSetUp = needing.map((r) => r.name)
    const started = await structured.start({
      dir: m.primary,
      args: extra,
      workspaceId: m.id,
      approvalTool: APPROVAL_TOOL,
      rules: [WORK_RULE, portsRule(m), toSetUp.length ? setupNotice(toSetUp) : ''].filter(Boolean).join('\n\n'),
      container: { image: plan.image, mounts: plan.mounts, env: plan.env, network: plan.network, publish },
      bashFree,
    })
    if (!started.ok) throw new Error(started.error)
    m.launch = { target: started.target, at: now() }
    m.status = 'ready'
    m.step = ''
    await write(m)
    await log(`Session started (unit ${started.record.unit})`)
    if (m.prompt) {
      // The FIFO buffers: a prompt written before the CLI reads is read when it does.
      const sent = await structured.sendPrompt(started.record, m.prompt)
      m.promptSentAt = sent.ok ? now() : 0
      m.promptError = sent.ok ? '' : sent.error
      await write(m)
      await log(sent.ok ? 'First prompt sent' : `First prompt not sent: ${sent.error}`)
    }
    if (needing.length) setUp(m, needing.map((r) => r.id))
  } catch (err) {
    m.status = 'failed'
    m.error = String(err?.message || err)
    await write(m)
    await log(`FAILED: ${m.error}`)
  }
}

/**
 * Give this chat's declared ports (containers/index.mjs `plan.ports`) their host ports and
 * record them on the manifest's `container.ports`, answering the `publish` list for the launcher.
 *
 * On the private network each internal port is published to a free host port from the configured
 * range (containers/ports.mjs), reused across restarts so a link stays put, and a host port
 * another live chat holds is skipped. On the host network nothing is published — a dev server's
 * port is already on the host — so the host port *is* the internal port and `publish` is empty;
 * the panel shows the ports either way. Two repos declaring the same internal port cannot both
 * bind in one container, so the second is marked `clash` and left unpublished. A declared port
 * that is one of Outpost's own (`FORWARDED_PORTS`) is a clash too, marked `reserved`: inside a
 * private chat it is the forward to the live Outpost, and publishing it would bind a host port on
 * every interface that leads there from the LAN; on the host network it is Outpost itself.
 */
async function assignChatPorts(m, plan) {
  const { containers } = await readSettings()
  const seen = new Set()
  const toPublish = []
  const entries = []
  for (const p of plan.ports || []) {
    const reserved = FORWARDED_PORTS.includes(p.internal)
    const clash = reserved || seen.has(p.internal)
    if (!clash) {
      seen.add(p.internal)
      toPublish.push(p.internal)
    }
    entries.push({ repo: p.repo, repoName: p.repoName, label: p.label, internal: p.internal, host: 0, clash, ...(reserved ? { reserved } : {}) })
  }
  if (plan.network !== 'private') {
    // Host network: the internal port is reachable at itself; publish nothing (`-p` is invalid
    // with `--network host`).
    for (const e of entries) if (!e.clash) e.host = e.internal
    m.container = { ...(m.container || {}), ports: entries }
    return []
  }
  const used = new Set()
  for (const [id, other] of manifests) if (id !== m.id) for (const e of other.container?.ports || []) if (e.host) used.add(e.host)
  const have = {}
  for (const e of m.container?.ports || []) if (e.host && !e.clash) have[e.internal] = e.host
  const { assigned } = await assignHostPorts(toPublish, { from: containers.portFrom, to: containers.portTo, used, have })
  for (const e of entries) e.host = e.clash ? 0 : assigned[e.internal] || 0
  m.container = { ...(m.container || {}), ports: entries }
  return toPublish.filter((i) => assigned[i]).map((i) => ({ host: assigned[i], internal: i }))
}

// ── a repo's setup, alongside the session ───────────────────────────────────────────────
//
// What a checkout needs that the session can do without for a minute: the repo's setup
// commands (its install), its data copies and datasets, and the `.env.local` naming them. Run
// after the session starts, in the background, one repo at a time per chat, each in a
// throwaway container from the chat's image — never on this machine: it is the repo's own
// code and every dependency's install scripts. Preparation and /addRepo both come here, so
// they cannot drift apart. Its state is on the manifest (`setup.repos`: `{ id, name, state:
// pending|running|done|failed, error, startedAt, endedAt }`), each repo's output in its own
// log, and the session is told when it is over.

/**
 * Whether a repo has setup to run: setup commands, data copies, or datasets its `data.json`
 * declares. One with none has nothing to wait for, and is not made to look as if it had.
 */
async function hasSetup(recipe) {
  if (!recipe) return false
  if (recipe.setup?.length || recipe.data?.length) return true
  const declared = await manifestOf(recipe).catch(() => ({ ok: false }))
  return Boolean(declared.ok && declared.datasets?.length)
}

/** What a finished setup actually did, said as it was — not "dependencies installed" for a repo that runs no install. */
function ranFor(recipe) {
  const did = []
  if (recipe?.setup?.length) did.push(`ran ${recipe.setup.map((c) => `\`${c}\``).join(', ')}`)
  if (recipe?.data?.length) did.push('copied its data')
  did.push('wrote .env.local with its data paths and Environment')
  return did.join(', ')
}

/** The line the session starts with while its repos are being set up. */
export function setupNotice(names) {
  return `Setup is still running for ${names.join(' and ')}: its dependencies are being installed and its data copied, in the background. Do not install dependencies yourself (no yarn install, npm install or the like) — two installs at once corrupt each other. Read, plan and answer in the meantime; Outpost tells you in a note when setup has finished, and setup_status says where it is.`
}

const setupLogFile = (id, repoId) => path.join(dirFor(id), `setup-${repoId}.log`)

function setupLogger(id, repoId) {
  const file = setupLogFile(id, repoId)
  let chain = Promise.resolve()
  return (line) => {
    const stamp = new Date().toISOString().slice(11, 19)
    chain = chain.then(() => fsp.appendFile(file, `${stamp}  ${line}\n`)).catch(() => {})
    return chain
  }
}

/** One chat's setups run one after another: two installs into one cache at once is asking for trouble. */
const setupJobs = new Map()

/**
 * Queue the named repos of a chat for setup and start the queue if it is idle. Answers at once;
 * the work goes on. A repo set up again (Try again) starts over, its log too.
 */
function setUp(m, repoIds) {
  m.setup ||= { repos: [] }
  for (const rid of repoIds) {
    const entry = m.repos.find((r) => r.id === rid)
    if (!entry || entry.oneOff) continue
    const item = { id: rid, name: entry.name, state: 'pending', error: '', startedAt: 0, endedAt: 0 }
    const prev = m.setup.repos.find((s) => s.id === rid)
    if (prev) Object.assign(prev, item)
    else m.setup.repos.push(item)
  }
  write(m).catch(() => {})
  const job = (setupJobs.get(m.id) || Promise.resolve()).then(() => runSetups(m)).catch(() => {})
  setupJobs.set(m.id, job)
  // Gone once the last queued job settles, so `setupJobs.has` means one is in flight
  // (`retryWorkspace` waits for none to be) — the manifest's states outlive a restart.
  job.finally(() => {
    if (setupJobs.get(m.id) === job) setupJobs.delete(m.id)
  })
  return job
}

async function runSetups(m) {
  const finished = []
  for (;;) {
    // A chat deleted while its setup ran: stop, and write nothing back.
    if (manifests.get(m.id) !== m) return
    const item = m.setup.repos.find((s) => s.state === 'pending')
    if (!item) break
    item.state = 'running'
    item.startedAt = now()
    // Everything from here is inside the try: a throw anywhere ends as "failed" with why, never
    // as a "running" that nothing will finish.
    try {
      await write(m)
      await setUpRepo(m, item.id)
      item.state = 'done'
    } catch (err) {
      item.state = 'failed'
      item.error = String(err?.message || err)
    }
    item.endedAt = now()
    if (manifests.get(m.id) !== m) return
    await write(m)
    finished.push(item)
  }
  if (finished.length) await tellSetup(m, finished).catch(() => {})
}

/** One repo's setup: its commands in a throwaway container, then its data and `.env.local`. */
async function setUpRepo(m, repoId) {
  const entry = m.repos.find((r) => r.id === repoId)
  const recipe = await repoById(repoId)
  if (!entry || !recipe) throw new Error('It is no longer in Settings › Repos')
  await fsp.writeFile(setupLogFile(m.id, repoId), '')
  const log = setupLogger(m.id, repoId)
  const chatLog = logger(m.id)
  await chatLog(`Setting up ${recipe.name}`)
  // The chat's own image and mounts, with this repo's mirror among them even when the
  // session's container predates it (an /addRepo). No sign-in: no session runs here.
  await log('Preparing the container')
  const recipes = (await Promise.all(m.repos.filter((r) => !r.oneOff).map((r) => repoById(r.id)))).filter(Boolean)
  const plan = await containerPlan({ repos: m.repos, recipes, workspaceDir: dirFor(m.id), cwd: m.primary, mirrorPath, datasetsDir: DATASETS_DIR, log, signIn: false })
  if (!plan.use) throw new Error(plan.why)
  await log(`In ${plan.image}`)
  for (const cmd of recipe.setup) {
    await log(`$ ${cmd}`)
    await runInContainer({
      plan,
      workdir: entry.path,
      cmd,
      workspaceId: m.id,
      // No prompt can be answered here: corepack's "download yarn?" would hang the install.
      env: { CI: '1', GIT_TERMINAL_PROMPT: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
      timeoutMs: SETUP_TIMEOUT_MS,
      onLine: (line) => log(`  ${line}`),
    })
  }
  // Data copies after the install, so a setup command cannot clobber a copy; then the repo's
  // datasets (datasets.mjs); and the `.env.local` that names them all, with its Environment.
  const vars = {}
  if (recipe.data.length) entry.data = []
  for (const source of recipe.data) {
    await log(`Copying ${source.kind} from ${source.env || 'here'}`)
    const copied = await copySource(source, { checkoutDir: entry.path, workspaceId: m.id, log })
    const rel = path.relative(entry.path, copied.to)
    // A copy is generated, not work: excluded like the policy file, or the checkout reads as
    // dirty forever and the delete guard refuses a workspace nobody changed.
    await excludeGenerated(mirrorPath(entry.id), [`/${rel}`])
    entry.data.push({ env: source.env, kind: source.kind, from: source.from, to: rel, bytes: copied.bytes, at: now() })
    if (source.envVar) vars[source.envVar] = copied.to
  }
  entry.copyVars = vars
  await log('Data and environment')
  entry.dataVars = (await provisionData(recipe, dirFor(m.id), log)).vars
  await writeChatEnv(entry, recipe, log)
  await log('Done')
  await chatLog(`${recipe.name} set up`)
}

/**
 * The session is told setup is over, as a Jenkins result is told (jenkins-results.mjs): a note
 * the chat draws — "✓ webapp setup finished" — and a reminder the session reads, with the
 * end of the log when it failed.
 *
 * Not before the person has said anything. A prompt is a turn, and a session given a turn
 * with nothing to answer invents something: one answered "setup finished" by writing a request
 * in the person's voice from the newest commit message, then answering it (2026-10-04). Until
 * then the note waits on the manifest (`heldNote`) and rides with their first message
 * (`withHeldNote`); the page draws it in the log meanwhile.
 */
async function tellSetup(m, items) {
  const rec = (await structured.allRecords()).filter((r) => r.workspaceId === m.id).sort((a, b) => b.startedAt - a.startedAt)[0]
  if (!rec) return
  const failed = items.filter((i) => i.state === 'failed')
  const names = (list) => list.map((i) => i.name).join(' and ')
  let tail = ''
  for (const i of failed) {
    const text = await fsp.readFile(setupLogFile(m.id, i.id), 'utf8').catch(() => '')
    tail += `\n--- ${i.name}: ${i.error}\n${text.split('\n').filter(Boolean).slice(-15).join('\n')}`
  }
  // No ✓ or ✗ in the words: the note's tone draws one, and both showed "✓ ✓" (the owner's
  // screenshot, 2026-10-04).
  const note = failed.length ? `<outpost-note tone="failure">${names(failed)} setup failed</outpost-note>` : `<outpost-note tone="success">${names(items)} setup finished</outpost-note>`
  const reminder = failed.length
    ? `<system-reminder>Outpost sent this, not the person: setup failed for ${names(failed)}.${tail}\nTell the person in a line what failed. Do not run the install yourself unless they ask; Try again on the chat's setup is theirs.</system-reminder>`
    : `<system-reminder>Outpost sent this, not the person: setup has finished for ${names(items)}. ${(await Promise.all(items.map(async (i) => `${i.name}: ${ranFor(await repoById(i.id))}`))).join('; ')}. Installing and running are fine now. If you were waiting on it, carry on; otherwise there is nothing to say about it.</system-reminder>`
  if (!m.promptSentAt && !m.spokenAt) {
    // A later setup (Try again) replaces an earlier one's note: only the latest is true. The
    // page draws `heldNoteView` at the top of the log meanwhile, so the confirmation is there
    // without a turn; the transcript's own copy takes over once it is sent.
    m.heldNote = `${note}\n${reminder}`
    m.heldNoteView = failed.length ? { tone: 'failure', text: `${names(failed)} setup failed` } : { tone: 'success', text: `${names(items)} setup finished` }
    await write(m)
    return
  }
  await structured.sendPrompt(rec, `${note}\n${reminder}`)
}

/**
 * A person's message to a chat, with the note held for their first one as its `lead` block
 * (`sendPrompt`), and the chat marked as spoken in so nothing is held again. `commit` is called
 * once the message is delivered: a send that fails keeps the note for the next try.
 */
async function withHeldNote(m, text) {
  return {
    text,
    lead: m.heldNote || '',
    async commit() {
      if (m.spokenAt && !m.heldNote) return
      m.spokenAt ||= now()
      m.heldNote = ''
      m.heldNoteView = null
      await write(m)
    },
  }
}

/** `withHeldNote` for a session by its id, for a send that knows only the thread; null outside a workspace. */
export async function personMessage(sessionId, text) {
  await load()
  const rec = sessionId ? await structured.recordForSession(sessionId) : null
  const m = rec ? manifests.get(rec.workspaceId) : null
  return m ? withHeldNote(m, text) : null
}

// ── /addRepo into a running container ───────────────────────────────────────────────────
//
// Podman cannot add a mount to a running container, so a repo added to a containerised chat
// has its checkout in the workspace but its mirror outside the box, and git in it does not
// resolve until the session is restarted (launchers.md). So the chat is restarted for it — in
// place, the conversation resumed as an effort change or Resume does, into a container that
// mounts the new mirror too — once it is idle, never mid-turn and never while it waits on the
// person; and a note in the chat says so (the owner's, 2026-10-04: noticeable, not a new
// chat). Mounting every mirror into every chat from the start was the alternative: no
// restart, but every chat able to write every repo's history.

/** How the note after such a restart opens; what the token accounting (server/tokens.ts) counts them by. */
export const REMOUNT_LEAD = '↻ Restarted to bring'

const IDLE_POLL_MS = 5000
/** A chat that never goes idle is left as it is after this long; the next restart picks it up. */
const IDLE_WAIT_MS = 2 * 60 * 60 * 1000
/** An add's note that never shows as a turn (lost, or the session never took it) is waited on this long. */
const TURN_HEARD_MS = 2 * 60 * 1000
const remounts = new Map()

/**
 * The restart is owed on the manifest (`remountOwed`, the repos' names) as well as waited for
 * here, and `load` picks it up: a deploy — often the chat's own push to main — restarts Outpost
 * mid-wait, and a wait kept only in memory was dropped with git left broken in the added checkout.
 * Cleared however the wait ends, since each end either restarted the chat or left it to its next
 * restart, which mounts every repo anyway.
 */
/**
 * A container for restarting this chat as its repos and Settings are now: `{ plan, container }`,
 * `container` null when the plan says not to use one (`plan.why`).
 */
async function freshContainer(m, log) {
  const recipes = (await Promise.all(m.repos.filter((r) => !r.oneOff).map((r) => repoById(r.id)))).filter(Boolean)
  const plan = await containerPlan({ repos: m.repos, recipes, workspaceDir: dirFor(m.id), cwd: m.primary, mirrorPath, datasetsDir: DATASETS_DIR, log })
  if (!plan.use) return { plan, container: null }
  const publish = await assignChatPorts(m, plan)
  return { plan, container: { image: plan.image, mounts: plan.mounts, env: plan.env, network: plan.network, publish } }
}

/**
 * `since` is when the add's note went to the session (`addRepo`, `notify`), 0 if none did: the
 * restart waits for the turn that note starts to end. Without it the session still read idle
 * the instant after the add — the note's turn not begun — and was restarted under it, the note
 * and its answer lost; two adds back to back restarted it twice at once and left it stopped
 * (bugs-fixed.md).
 */
function remountWhenIdle(m, name, since = 0) {
  const owe = (names) => {
    m.remountOwed = [...names]
    write(m).catch(() => {})
  }
  const pending = remounts.get(m.id)
  if (pending?.restarting) {
    // Mid-restart: its container was planned without this repo, so another restart follows it.
    owe([...pending.names, name])
    pending.done.finally(() => remountWhenIdle(m, name, since))
    return
  }
  if (pending) {
    // One restart takes every repo added while it waited, after the last add's turn.
    pending.names.push(name)
    pending.since = Math.max(pending.since, since)
    owe(pending.names)
    return
  }
  const job = { names: [name], since, restarting: false, done: Promise.resolve() }
  remounts.set(m.id, job)
  owe(job.names)
  job.done = (async () => {
    const log = logger(m.id)
    const latest = async () => (await structured.allRecords()).filter((r) => r.workspaceId === m.id && !r.endedAt).sort((a, b) => b.startedAt - a.startedAt)[0]
    const end = Date.now() + IDLE_WAIT_MS
    for (;;) {
      if (manifests.get(m.id) !== m) return
      const rec = await latest()
      if (!rec) return
      const state = rec.sessionId ? (await hookStates()).get(rec.sessionId) : null
      // The add's note has had its turn: one ended, or failed, after it was sent.
      const heard = !job.since || Math.max(state?.turnEndedAt || 0, state?.failure?.at || 0) >= job.since || Date.now() - job.since > TURN_HEARD_MS
      // Idle, or never spoken: nothing is lost by a restart. Running is a turn; waiting is a
      // question or a permission the person has not answered — a restart would deny it.
      if (heard && (!state || (state.status !== 'running' && state.status !== 'waiting'))) break
      if (Date.now() > end) {
        await log(`Not restarted for ${job.names.join(' and ')}: the chat was never idle; git in it waits for its next restart`)
        return
      }
      await new Promise((r) => setTimeout(r, IDLE_POLL_MS))
    }
    // Held in `remounts` until the restart is over, so an add meanwhile queues behind it
    // rather than restarting the same session alongside it.
    job.restarting = true
    const names = job.names.join(' and ')
    const rec = await latest()
    // A repo added may bring ports of its own; `freshContainer` assigns them so the remount
    // publishes them too, reusing what the chat already holds.
    const { plan, container } = await freshContainer(m, log)
    if (!container) {
      await log(`Not restarted for ${names}: ${plan.why}`)
      return
    }
    // Every checkout the session was not given yet, beside the ones it was.
    const addArgs = m.repos.filter((r) => r.path !== m.primary && !(rec.args || []).includes(r.path)).flatMap((r) => ['--add-dir', r.path])
    let r = await structured.restart(rec, { container, addArgs })
    if (!r.ok && /not spoken/.test(r.error || '')) {
      // Nothing said yet, so nothing to resume: a fresh session in the new container.
      await structured.kill(rec).catch(() => {})
      r = await structured.start({ dir: rec.cwd, args: [...(rec.args || []), ...addArgs], workspaceId: m.id, approvalTool: APPROVAL_TOOL, rules: [WORK_RULE, portsRule(m)].filter(Boolean).join('\n\n'), container, bashFree: Boolean(rec.bashFree) })
    }
    if (!r.ok) {
      await log(`Restart for ${names} failed: ${r.error}`)
      return
    }
    m.container = { ...m.container, image: plan.image }
    m.launch = { target: r.target, at: now() }
    await write(m)
    // The unit is made before the container in it runs: a resume that died at start was logged
    // as restarted, and its note sent to nothing (bugs-fixed.md). The panel's Try again shows it.
    const up = await structured.awaitStart(r.target)
    if (!up.ok) {
      await log(`Restart for ${names} failed: ${up.error}`)
      return
    }
    await log(`Restarted for ${names}: git works in it from the session now`)
    const latestRec = r.record
    await structured
      .sendPrompt(
        latestRec,
        // A plain tone: a restart is not a success to tick, and the tone would add a ✓ to the ↻.
        `<outpost-note tone="info">${REMOUNT_LEAD} ${names} into this chat's container</outpost-note>\n<system-reminder>Outpost sent this, not the person: the session was restarted in place, the conversation resumed, so that ${names} — added to this chat — is mounted in its container and git works in it. Nothing to do about it; carry on with what you were doing, or say nothing if you were done.</system-reminder>`,
      )
      .catch(() => {})
  })()
    .catch(async (err) => {
      await logger(m.id)(`Restart for ${job.names.join(' and ')} failed: ${err?.message || err}`)
    })
    .finally(() => {
      if (remounts.get(m.id) === job) remounts.delete(m.id)
      if (manifests.get(m.id) === m && !remounts.has(m.id)) {
        delete m.remountOwed
        write(m).catch(() => {})
      }
    })
}

/**
 * The tracked paths under `src/main` on a mirror's base, for `detectPorts` to find a JVM entry
 * point whose folder is its package. Only `src/main`: a whole tree's listing is not worth reading
 * for a suggestion.
 */
const listFor = (mirror, base) => async () =>
  (await git(['-C', mirror, 'ls-tree', '-r', '--name-only', `origin/${base}`, '--', 'src/main']).catch(() => '')).split('\n').filter(Boolean)

/**
 * The ports a repo probably serves on, read from its mirror (containers/ports.mjs) so the
 * catalogue form can pre-fill the Ports editor — a suggestion the owner confirms or edits. Reads
 * files off the base's latest with `git show`, no worktree needed; `scanned: false` when there
 * is no mirror yet (a repo not used in a chat), where the owner simply types the ports.
 */
export async function detectRepoPorts(id) {
  const recipe = await repoById(id)
  if (!recipe) throw new Error('No such repo in Settings › Repos')
  const mirror = mirrorPath(recipe.id)
  if (!(await fsp.stat(mirror).then(() => true, () => false))) return { ports: [], scanned: false }
  let base = recipe.baseBranch
  if (!base) base = await defaultBranch(mirror).catch(() => 'main')
  const read = async (rel) => git(['-C', mirror, 'show', `origin/${base}:${rel}`]).catch(() => null)
  return { ports: await detectPorts(read, listFor(mirror, base)), scanned: true }
}

/**
 * `/registerRepo <url>`: a catalogue entry for a repo not in it yet, read off the repo — reached
 * as a catalogued one would be with no secret named (the GitHub integration, else this machine),
 * its mirror cloned, and its ports, setup and Environment read from the base's latest with
 * `git show` (scan.mjs). Nothing is saved: the page shows it on a card, and Register saves it.
 * The mirror stays, so a second try or the add that follows is a fetch.
 */
export async function scanForRegister(url) {
  const asked = String(url || '').trim()
  if (!looksLikeUrl(asked)) throw new Error('Give a git URL: /registerRepo <url>')
  const all = await listRepos()
  const same = all.find((r) => r.url === asked || repoKey(r.url) === repoKey(asked))
  if (same) throw new Error(`${same.name} is in Settings › Repos already — /addRepo ${same.id} adds it to this chat`)
  const name = nameFromUrl(asked)
  const id = idFor(name)
  if (!id) throw new Error('Could not read a repo name from that URL')
  if (all.some((r) => r.id === id)) throw new Error(`Settings › Repos has a different repo called ${name} — add this one there under another name`)
  const remote = await remoteFor({ url: asked, auth: '' })
  const reach = await testRemote(remote.url, remote.env)
  if (!reach.ok) throw new Error(`Could not reach it ${remote.via === 'github' ? 'with the GitHub token' : 'from this machine'}: ${reach.error} — add it in Settings › Repos with a key or token`)
  const mirror = await ensureMirror({ id, name, url: asked }, () => {}, remote)
  const base = reach.defaultBranch || (await defaultBranch(mirror))
  const found = await readRepoFor(mirror, base, asked)
  return {
    // What Register saves, in the catalogue's own shape (catalogue.mjs `normalise`).
    repo: {
      name,
      url: asked,
      // Empty follows the remote's HEAD, as a repo added in Settings does; `base` says what it is now.
      baseBranch: '',
      auth: '',
      setup: found.setup,
      ports: found.ports,
      env: found.env,
      packages: found.packages,
      ...(found.jobs ? { jenkinsJobs: found.jobs } : {}),
      ...(found.jobs?.length ? { tools: [...DEFAULT_TOOLS, 'jenkins:read'] } : {}),
    },
    base,
    via: remote.via,
    envFrom: found.envFrom,
  }
}

/**
 * What a scan reads off a mirror's base (scan.mjs, `detectPorts`) and, with Jenkins set up, the
 * jobs that build its URL — `jobs` null when Jenkins is not, so "none build it" is told from
 * "not asked". Jenkins not answering is no jobs: a suggestion is never worth a failed scan.
 */
async function readRepoFor(mirror, base, url) {
  const read = async (rel) => git(['-C', mirror, 'show', `origin/${base}:${rel}`]).catch(() => null)
  const env = await detectEnv(read)
  const v = await integrationsView().catch(() => null)
  const jobs = v?.jenkins?.configured && v.jenkins.url ? (await listJenkinsJobs(url).catch(() => [])).filter((j) => j.builds).map((j) => j.name) : null
  return { setup: await detectSetup(read), ports: await detectPorts(read, listFor(mirror, base)), env: env.env, envFrom: env.from, jobs, packages: await detectPackages(read) }
}

/**
 * `/rescanRepo <name>`: a catalogued repo read again, and what the scan would change in its
 * entry. Only additions and replacements are proposed, never a removal: a field the scan found
 * nothing for is left as the owner has it, an Environment name already there keeps its value,
 * and a job already listed stays. Nothing is saved; the card's Update does (`applyRescan`).
 */
export async function scanForRescan(name) {
  const asked = String(name || '').trim().toLowerCase()
  if (!asked) throw new Error('Which repo? /rescanRepo <name from Settings › Repos>')
  const recipe = (await listRepos()).find((r) => r.id === asked || r.name.toLowerCase() === asked)
  if (!recipe) throw new Error(`No repo "${name}" in Settings › Repos — /registerRepo <url> adds one`)
  const remote = await remoteFor(recipe)
  const mirror = await ensureMirror(recipe, () => {}, remote)
  const base = recipe.baseBranch || (await defaultBranch(mirror))
  const found = await readRepoFor(mirror, base, recipe.url)
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const changes = {}
  if (found.setup.length && !same(found.setup, recipe.setup)) changes.setup = { from: recipe.setup, to: found.setup }
  const portsOf = (list) => list.map((p) => p.port).sort((a, b) => a - b)
  if (found.ports.length && !same(portsOf(found.ports), portsOf(recipe.ports))) changes.ports = { from: recipe.ports, to: found.ports }
  const envAdd = found.env.filter((e) => !recipe.env.some((x) => x.name === e.name)).map((e) => e.name)
  if (envAdd.length) changes.envAdd = envAdd
  const jobsAdd = (found.jobs || []).filter((j) => !(recipe.jenkinsJobs || []).includes(j))
  if (jobsAdd.length) changes.jobsAdd = jobsAdd
  // An image of the owner's own is used as named, packages and all: what it should carry is
  // said, not proposed.
  const packagesAdd = found.packages.filter((p) => !recipe.packages.includes(p))
  if (packagesAdd.length && !recipe.containerImage) changes.packagesAdd = packagesAdd
  const needs = recipe.containerImage ? found.packages : []
  return { id: recipe.id, name: recipe.name, base, envFrom: found.envFrom, changes, image: recipe.containerImage, needs }
}

/**
 * The rescan card's Update: the ticked changes onto the entry as it is saved now. `setup` and
 * `ports` replace; `packagesAdd` adds to the image's packages; `envAdd` adds each name as a
 * secret with no value, and `jobsAdd` each job,
 * with `jenkins:read` among the tools if no Jenkins group is (`scanForRegister` does the same).
 * Every other field is kept as saved. Returns the entry to save; the caller saves it.
 */
export async function applyRescan(id, { setup, ports, envAdd, jobsAdd, packagesAdd } = {}) {
  const recipe = await repoById(String(id || ''))
  if (!recipe) throw new Error('No such repo in Settings › Repos')
  const next = { ...recipe }
  if (Array.isArray(setup)) next.setup = setup
  if (Array.isArray(ports)) next.ports = ports
  if (Array.isArray(packagesAdd)) next.packages = [...new Set([...recipe.packages, ...packagesAdd.map(String)])]
  if (Array.isArray(envAdd)) for (const n of envAdd) if (!next.env.some((e) => e.name === n)) next.env = [...next.env, { name: String(n), value: '', secret: true, locked: false }]
  if (Array.isArray(jobsAdd) && jobsAdd.length) {
    next.jenkinsJobs = [...new Set([...(recipe.jenkinsJobs || []), ...jobsAdd.map(String)])]
    const tools = recipe.tools.length ? recipe.tools : [...DEFAULT_TOOLS]
    if (!tools.some((t) => t.startsWith('jenkins'))) next.tools = [...tools, 'jenkins:read']
  }
  return next
}

/** A short connect to a host port on loopback: true if something answers. Cheap, not polled fast. */
function listening(hostPort) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: hostPort })
    const done = (v) => {
      s.destroy()
      resolve(v)
    }
    s.setTimeout(400)
    s.once('connect', () => done(true))
    s.once('timeout', () => done(false))
    s.once('error', () => done(false))
  })
}

/**
 * Which of a chat's published ports have something listening right now (workspace.js dims a port
 * until one does). Each is probed on the host port it was published to (containers/ports.mjs);
 * a clash, unpublished, is never listening.
 */
export async function portStatus(id) {
  await load()
  const m = manifests.get(id)
  const ports = m?.container?.ports || []
  return Promise.all(ports.map(async (p) => ({ repo: p.repo, label: p.label, internal: p.internal, host: p.host, listening: !p.clash && p.host ? await listening(p.host) : false })))
}

/** `setup_status`, and the page's setup log: each repo's state and the end of its log. */
export async function setupStatus(id, { lines = 200 } = {}) {
  await load()
  const m = manifests.get(id)
  if (!m) throw new Error('No such workspace')
  const repos = []
  for (const s of m.setup?.repos || []) {
    const text = await fsp.readFile(setupLogFile(id, s.id), 'utf8').catch(() => '')
    repos.push({ ...s, log: text.split('\n').slice(-lines).join('\n') })
  }
  return { repos }
}

/** Try again on one repo's failed setup, or all of them. */
export async function retrySetup(id, repoId = '') {
  await load()
  const m = manifests.get(id)
  if (!m) throw new Error('No such workspace')
  if (m.status !== 'ready') throw new Error('The chat is not running — Try again on its preparation instead')
  const ids = (m.setup?.repos || []).filter((s) => (repoId ? s.id === repoId : s.state === 'failed')).map((s) => s.id)
  if (!ids.length) throw new Error('Nothing to set up again')
  if (ids.some((rid) => m.setup.repos.find((s) => s.id === rid)?.state === 'running')) throw new Error('Setup is running for it already')
  setUp(m, ids)
  return { ok: true, setup: m.setup }
}

/** `fresh: false` takes any cached status, however old: a checkout nothing is working in has not moved. */
async function statusOf(entry, { fresh = true } = {}) {
  const hit = statusCache.get(entry.path)
  if (hit && (!fresh || now() - hit.at < STATUS_TTL_MS)) return hit.status
  const status = await worktreeStatus(entry.path, entry.base, entry.branch)
  statusCache.set(entry.path, { at: now(), status })
  return status
}

/**
 * Every workspace, newest first, each repo stamped with its git status. With `active`, a set
 * of workspace ids, only those are re-checked on the timer and the rest keep their last status:
 * re-checking every checkout every few seconds was ~500 git processes a pass at a hundred
 * chats, seconds per roster scan, for a line the page shows for one chat at a time.
 */
export async function listWorkspaces({ active = null } = {}) {
  await load()
  const out = []
  for (const m of manifests.values()) {
    const repos = []
    const fresh = !active || active.has(m.id)
    for (const entry of m.repos) repos.push({ ...entry, git: m.status === 'ready' ? await statusOf(entry, { fresh }) : null })
    out.push({ ...m, repos, dir: dirFor(m.id) })
  }
  out.sort((a, b) => b.createdAt - a.createdAt)
  return out
}

/**
 * Forget the git status of the chat a session belongs to, so the next roster reads it afresh.
 * Called when a chat is opened: the one change the activity rule cannot see is a person
 * editing a checkout by hand while its chat sits idle.
 */
export async function forgetStatusForSession(sessionId) {
  const rec = sessionId ? await structured.recordForSession(sessionId) : null
  await load()
  const m = rec?.workspaceId ? manifests.get(rec.workspaceId) : null
  for (const entry of m?.repos || []) statusCache.delete(entry.path)
}

/** The workspace a session's cwd is inside, or null. */
export async function workspaceFor(cwd) {
  await load()
  const p = String(cwd || '')
  if (!p.startsWith(WORKSPACES_DIR + path.sep)) return null
  const id = p.slice(WORKSPACES_DIR.length + 1).split(path.sep)[0]
  return manifests.get(id) || null
}

/** The workspace a session belongs to: one that has carried it, else the one its cwd is in. */
export async function workspaceForSession(sessionId, cwd) {
  await load()
  for (const m of manifests.values()) if (sessionId && m.sessionIds?.includes(sessionId)) return m
  return workspaceFor(cwd)
}

/** A workspace's manifest by id, or null; no git status (`listWorkspaces` has that). */
export async function workspaceById(id) {
  await load()
  return manifests.get(id) || null
}

/** Every workspace's manifest, no git status. */
export async function workspaceManifests() {
  await load()
  return [...manifests.values()]
}

export async function readLog(id) {
  try {
    return await fsp.readFile(path.join(dirFor(id), LOG), 'utf8')
  } catch {
    return ''
  }
}

export async function pushWorkspaceRepo(id, repoId) {
  await load()
  const m = manifests.get(id)
  if (!m) throw new Error('No such workspace')
  const entry = m.repos.find((r) => r.id === repoId)
  if (!entry) throw new Error('That repo is not in this workspace')
  if (entry.oneOff) return { ok: false, error: `${entry.name} is not in Settings › Repos — it was added to be read, so it is not pushed` }
  if (!entry.branch) return { ok: false, error: `No work has been started in ${entry.name} — there is no branch to push` }
  const recipe = await repoById(entry.id)
  await pushBranch(entry.path, entry.branch, await remoteFor(recipe || { url: entry.url }))
  statusCache.delete(entry.path)
  return { ok: true, branch: entry.branch }
}

/**
 * Start a piece of work: for each checkout asked for — every one in the chat when none is
 * named — bring the base's latest down, and make a branch named for the work from it
 * (git.mjs `startWorkBranch`). The session calls this as the `start_work` tool before its
 * first change, as its standing instructions say (`WORK_RULE`); a chat that moves on to a
 * second piece of work calls it again and gets a second branch, from main as it is then.
 *
 * The name goes through the repo's branch template — `outpost/{slug}` unless the repo says
 * otherwise — and a name already taken gets a number, as a chat's did.
 */
export async function startWork(id, { name = '', repo = '' } = {}) {
  await load()
  const m = manifests.get(id)
  if (!m) throw new Error('No such workspace')
  const title = String(name || '').trim()
  if (!title) throw new Error('Name the work: a few words, like "fix toast position"')
  const wanted = String(repo || '').trim().toLowerCase()
  const entries = wanted ? m.repos.filter((r) => r.id === wanted || r.name.toLowerCase() === wanted) : m.repos
  if (!entries.length) throw new Error(wanted ? `No repo "${repo}" in this chat` : 'This chat has no repo to start work in')
  const log = logger(m.id)
  const slug = slugify(title, 'work')
  const out = []
  for (const entry of entries) {
    const recipe = await repoById(entry.id)
    const remote = await remoteFor(recipe || { url: entry.url })
    const mirror = mirrorPath(entry.id)
    await fetchBranch(entry.path, entry.base, remote)
    const template = recipe?.branchTemplate || 'outpost/{slug}'
    const branch = await freeBranchName(mirror, template.replace('{slug}', slug).replace('{id}', m.id))
    if (!(await validBranchName(branch))) throw new Error(`"${branch}" is not a name git accepts for a branch — fix "Name chat branches" for ${entry.name} in Settings`)
    const status = await worktreeStatus(entry.path, entry.base, entry.branch)
    await startWorkBranch(entry.path, entry.base, branch, { clean: status.clean })
    const filled = status.clean ? await fillCheckout(entry.path, remote) : ''
    if (entry.branch) entry.earlier = [...(entry.earlier || []), entry.branch]
    entry.branch = branch
    entry.work = title
    statusCache.delete(entry.path)
    await log(`Work started in ${entry.name}: ${branch}${status.clean ? ` from the latest ${entry.base}` : `, carrying ${status.changed} uncommitted change${status.changed === 1 ? '' : 's'} (${entry.base} is merged in when it is pushed)`}${filled ? `; ${filled}` : ''}`)
    out.push({ repo: entry.name, branch, base: entry.base, fromLatest: status.clean, filled })
  }
  await write(m)
  return { ok: true, branches: out }
}

/** A git address, rather than a catalogue name: an scp-style `user@host:path`, or a URL. */
const looksLikeUrl = (s) => /^(?:[\w.-]+@[\w.-]+:|(?:https?|ssh|git|file):\/\/|\/)/.test(s)

/**
 * A path or `file://` on this machine. Only a person may add one: a session's `add_repo` naming
 * one would clone another repo's mirror (every chat's unpushed branches) or another checkout.
 */
export const isLocalAddress = (s) => /^(?:file:\/\/|\/)/i.test(String(s).trim())

/**
 * A one-off repo's id, from its address: `ext-<owner>-<repo>`. Prefixed so it can never be a
 * catalogue entry's id and so share a mirror with a different repo of the same name.
 */
function oneOffId(url) {
  const tail = String(url).replace(/\.git\/?$/, '').replace(/\/+$/, '').split(/[/:]/).slice(-2).join('-')
  return `ext-${slugify(tail, 'repo')}`
}

/**
 * The chat a repo can be added to now, or why not. `/registerRepo`'s Register asks before it
 * saves, so a chat that cannot take the repo does not leave it catalogued and not added.
 */
export async function addableChat(id) {
  await load()
  const m = manifests.get(id)
  if (!m) throw new Error('No such workspace')
  if (m.status !== 'ready') throw new Error('The chat is still being prepared — add the repo once it is ready')
  return m
}

/**
 * Add a repo to a running chat (`/addRepo <name or URL>` in the message box, or the
 * `add_repo` tool): fetch it, check it out in the chat's workspace at the latest of its main
 * branch with no branch — as preparation does — give it the policy, trust it, and rewrite the
 * pointer file so the session knows where it is. A chat started with no repo gains its first
 * this way.
 *
 * `repo` is a catalogue entry, by id or name, or a git address. An address that is not in the
 * catalogue is a checkout for this chat only and is *not* added to the catalogue (the owner's
 * call: most repos that are not the owner's are cloned to be reviewed) — reached over the GitHub
 * token if it is on GitHub, else as this machine can, with no push setting, so the push tools
 * refuse it. `notify` sends the session a line saying so, for when a person added it rather
 * than the session itself.
 *
 * `local` allows a path or `file://` address that is not catalogued; it follows `notify`, since
 * only the page's `/addRepo` (a person) sets that, and the `add_repo` tool (the session) sets
 * neither.
 */
export async function addRepo(id, { repo = '', notify = false, said = '', local = notify } = {}) {
  const m = await addableChat(id)
  const asked = String(repo || '').trim()
  if (!asked) throw new Error('Name a repo from Settings › Repos, or give a git URL')
  const all = await listRepos()
  const lower = asked.toLowerCase()
  let recipe = all.find((r) => r.id === lower || r.name.toLowerCase() === lower || r.url === asked)
  let oneOff = false
  if (!recipe) {
    if (!looksLikeUrl(asked)) throw new Error(`No repo "${asked}" in Settings › Repos — name one of ${all.map((r) => r.name).join(', ') || 'none yet'}, or give a git URL`)
    if (!local && isLocalAddress(asked)) throw new Error(`A repo on this machine is added by a person (/addRepo in the message box), not by the session — give an https or ssh URL, or name one from Settings › Repos`)
    oneOff = true
    const rid = oneOffId(asked)
    recipe = { id: rid, name: asked.replace(/\.git\/?$/, '').split(/[/:]/).pop() || rid, url: asked, auth: '', baseBranch: '', allow: [], deny: [], setup: [], data: [] }
  }
  if (m.repos.some((r) => r.id === recipe.id)) throw new Error(`${recipe.name} is already in this chat`)
  const log = logger(m.id)
  await log(`Adding ${recipe.name}${oneOff ? ' (not in the catalogue — this chat only)' : ''}`)
  const remote = await remoteFor(recipe)
  const mirror = await ensureMirror(recipe, log, remote)
  const base = recipe.baseBranch || (await defaultBranch(mirror))
  const entry = { id: recipe.id, name: recipe.name, url: recipe.url, path: path.join(dirFor(m.id), recipe.id), base, branch: '', finish: recipe.finish || 'push', ...(oneOff ? { oneOff: true } : {}) }
  await addDetachedWorktree(mirror, entry.path, base, log)
  const filled = await fillCheckout(entry.path, remote)
  if (filled) await log(`${recipe.name}: ${filled}`)
  await excludeGenerated(mirror, GENERATED)
  // Every checkout's policy, the new one's included: each carries every repo's rules, as
  // preparation writes them. The Bash mode follows the chat (launchers.md): read off the running
  // session's record, not a setting that may have changed since it started.
  await writePolicies(m, await chatBashFree(m), [...m.repos, entry])
  // Its Environment now; its install, data and data paths in the background, as preparation
  // gives a checkout (setUp). A repo added to be read has none of them: an unknown repo's
  // install scripts are not run, on purpose (`setup: []` above).
  if (!oneOff) await writeChatEnv(entry, recipe, log)
  const trusted = await trustDirectory(entry.path)
  if (!trusted.ok) await log(`Could not trust ${entry.path}: ${trusted.error}`)
  m.repos.push(entry)
  await write(m)
  // The pointer file lists every checkout but the one the session runs in.
  await writePointerFile(m.primary, { workspaceName: m.name, others: m.repos.filter((r) => r.path !== m.primary) })
  await log(`${recipe.name} checked out at ${entry.path}, on the latest ${base}`)
  const setting = !oneOff && (await hasSetup(recipe))
  if (setting) setUp(m, [entry.id])
  // Git in it from inside this chat's container waits for a restart: the running container
  // was made before its mirror was a mount (launchers.md). The restart comes once the chat is
  // idle (remountWhenIdle).
  const inBox = Boolean(m.container?.image)
  // Owed now, so a deploy before the note is sent still restarts it (`load`); started below,
  // once the note's send time is known.
  if (inBox) {
    m.remountOwed = [...new Set([...(m.remountOwed || []), entry.name])]
    await write(m)
  }
  // Two repos in one chat declaring the same internal port cannot both bind in one container;
  // the second is left unpublished (assignChatPorts) and the owner is told at add time, as the
  // Workspace panel shows it after the remount (launchers.md).
  let clashNote = ''
  if (!oneOff && recipe.ports?.length) {
    const others = new Set()
    for (const r of m.repos.filter((x) => x.id !== recipe.id && !x.oneOff)) for (const p of (await repoById(r.id))?.ports || []) others.add(p.port)
    const clashes = recipe.ports.filter((p) => others.has(p.port)).map((p) => p.port)
    if (clashes.length) clashNote = ` Note: port ${clashes.join(', ')} is already declared by another repo in this chat and cannot be published twice — give one of them a different port in Settings › Repos.`
  }
  const line =
    `${recipe.name} has been added to this chat at ${entry.path}, on the latest ${base} with no branch yet. Call start_work with repo "${recipe.id}" before you change it.` +
    (oneOff
      ? ' It is not in the catalogue, so it is here to be read: push and pull requests are refused for it, and its setup is not run.'
      : setting
        ? ` ${setupNotice([recipe.name])}`
        : ' It has no setup commands in Outpost, so nothing is installed for it — install what you need yourself.') +
    (inBox
      ? ` git commands inside ${entry.path} will not work from this session until Outpost restarts it, which it does by itself as soon as this turn ends — the conversation carries on, and a note says so. start_work and push work before that, since Outpost runs them.`
      : '') +
    clashNote
  let since = 0
  if (notify) {
    // The person's own words are the message, and what Outpost did is a reminder beside them,
    // which the transcript reader hides (harnesses.md) — so the chat shows what was typed and
    // the session's answer to it. It used to send "[Outpost] Webapp has been
    // added…" as the message itself, which drew as a bubble of the person's that they never
    // wrote, and nothing they did write.
    const rec = (await structured.allRecords()).filter((r) => r.workspaceId === m.id).sort((a, b) => b.startedAt - a.startedAt)[0]
    const msg = await withHeldNote(
      m,
      `<system-reminder>Outpost just did this at the person's request, before this message reached you: ${line} Answer the person briefly that it is there${oneOff ? '' : ' and being set up'}; do not start work in it until they ask.</system-reminder>\n\n${String(said || `/addRepo ${asked}`).trim()}`,
    )
    // A restart under way would take the note down with the session it is sent to: it goes to
    // the session that restart leaves.
    const pending = remounts.get(m.id)
    if (pending?.restarting) await pending.done.catch(() => {})
    const to = pending?.restarting ? (await structured.allRecords()).filter((r) => r.workspaceId === m.id).sort((a, b) => b.startedAt - a.startedAt)[0] : rec
    const sentAt = Date.now()
    if (to && (await structured.sendPrompt(to, msg.text, { lead: msg.lead }).catch(() => ({ ok: false }))).ok) {
      since = sentAt
      await msg.commit()
    }
  }
  if (inBox) remountWhenIdle(m, entry.name, since)
  return { ok: true, repo: entry.name, id: entry.id, path: entry.path, base, oneOff, line }
}

/**
 * A checkout's `.env.local` block, whole: the recipe's data copies, the repo's datasets, any
 * snapshots the chat took, then the repo's Environment — last, so a variable the owner set
 * there wins over a path Outpost chose. Secrets are read from the store now, so a value
 * changed in Settings lands at the next write (`refreshEnvFor`). Paths only are kept on the
 * manifest; a secret is never written anywhere but this file.
 */
async function writeChatEnv(entry, recipe, log = async () => {}) {
  const vars = { ...(entry.copyVars || {}), ...(entry.dataVars || {}), ...(entry.snapshotVars || {}), ...(recipe ? await envVars(recipe) : {}) }
  if (Object.keys(vars).length) await log(`Writing .env.local in ${entry.name}: ${Object.keys(vars).join(', ')}`)
  await writeEnvLocal(entry.path, vars)
}

/**
 * A repo's Environment or data sources changed in Settings: every ready chat with a checkout of
 * it gets its `.env.local` block rewritten now, so the next start of its app reads the new
 * values. A running app keeps what it read at its own start.
 */
export async function refreshEnvFor(repoId) {
  await load()
  const recipe = await repoById(repoId)
  if (!recipe) return 0
  let n = 0
  for (const m of manifests.values()) {
    if (m.status !== 'ready') continue
    for (const entry of m.repos.filter((r) => r.id === repoId && !r.oneOff)) {
      await writeChatEnv(entry, recipe).catch(() => {})
      n++
    }
  }
  return n
}

/** The checkout and workspace a data tool acts on: the repo named, or the chat's only one. */
function dataEntry(m, repo) {
  const entries = entriesFor(m, repo).filter((e) => !e.oneOff)
  if (entries.length !== 1) throw new Error(entries.length ? `Name the repo: this chat has ${entries.map((e) => e.name).join(' and ')}` : 'This chat has no repo with data')
  return entries[0]
}

/** `data_list`: what each repo of the chat declares, and where it is for this chat. */
export async function listChatData(id) {
  await load()
  const m = manifests.get(id)
  if (!m) throw new Error('No such workspace')
  const out = []
  for (const entry of m.repos.filter((r) => !r.oneOff)) {
    const recipe = await repoById(entry.id)
    if (!recipe) continue
    const manifest = await manifestOf(recipe)
    const state = await readState(recipe.id)
    out.push({
      repo: entry.name,
      error: manifest.ok ? '' : manifest.error,
      datasets: (manifest.datasets || []).map((d) => ({
        ...d,
        here: (entry.dataVars || {})[d.env] || (entry.snapshotVars || {})[d.env] || '',
        syncedAt: state[d.name]?.at || 0,
      })),
    })
  }
  return out
}

/** `data_snapshot`: a scrubbed, checked copy for this chat; its `.env.local` points the app at it. */
export async function snapshotForChat(id, { repo = '', dataset, source = '' }) {
  await load()
  const m = manifests.get(id)
  if (!m) throw new Error('No such workspace')
  const entry = dataEntry(m, repo)
  const recipe = await repoById(entry.id)
  const log = logger(m.id)
  await log(`Snapshot of ${recipe.name}'s ${dataset}${source ? ` (${source})` : ''} asked for`)
  const r = await takeSnapshot(recipe, dataset, source, { checkoutDir: entry.path, workspaceDir: dirFor(m.id) })
  entry.snapshotVars = { ...(entry.snapshotVars || {}), [r.env]: r.path }
  await writeChatEnv(entry, recipe, log)
  await write(m)
  await log(`Snapshot of ${r.dataset} from ${r.source} at ${r.path}, scrubbed and ${r.checks} check${r.checks === 1 ? '' : 's'} passed`)
  return { ...r, repo: entry.name }
}

/**
 * `data_publish`: this chat's write dataset back to its source. The files the chat deleted or
 * moved away (`pending`) are not removed here: they are written on the repo entry
 * (`pendingDeletes`) and put to the person as a standing question on the bar
 * (`armPendingDeletes`); a yes removes them. In a watched chat the call waits for the answer as
 * long as any prompt does, then answers that the question still stands; in a run nobody
 * watches it is asked once the run has ended (state/routines.mjs). `outcome` says which:
 * `removed`, `kept`, `failed` (a yes the source refused; the Activity log says why),
 * `standing`, `later` (the run's end) or `nobody` (a chat that never asks). The folders those
 * removals would empty (`pendingFolders`) ride in the same question and the same yes;
 * `emptyFolders` adds the ones already empty there and absent here (datasets.mjs).
 */
export async function publishForChat(id, { repo = '', dataset, path: sub = '', emptyFolders = false }) {
  await load()
  const m = manifests.get(id)
  if (!m) throw new Error('No such workspace')
  const entry = dataEntry(m, repo)
  const recipe = await repoById(entry.id)
  const r = await publishWrite(recipe, dataset, dirFor(m.id), sub, { emptyToo: Boolean(emptyFolders) })
  const log = logger(m.id)
  // Every line, here: the tool's answer to the chat is capped, and this is where the rest is.
  await log(`Published ${r.dataset} to ${r.to}: ${r.sent.length} sent, ${r.same.length} already there, ${r.newer.length} newer there, ${r.pulled.length} pulled in${r.partial ? `; rsync could not do everything (${r.errors.length} error line${r.errors.length === 1 ? '' : 's'})` : ''}`)
  // The unchanged files are a count only: a whole dataset's would be thousands of lines.
  for (const f of r.sent) await log(`  sent ${f}`)
  for (const f of r.newer) await log(`  newer there ${f}`)
  for (const f of r.pulled) await log(`  pulled in ${f}${pulledWhy(r, f)}`)
  for (const f of r.clashes) await log(`  not sent ${f} (changed here and there; theirs saved beside the copy)`)
  for (const f of r.dropped) await log(`  dropped here ${f} (removed there since)`)
  for (const f of r.resent) await log(`  sent back ${f} (removed there since, changed here)`)
  for (const line of r.errors) await log(`  ${line}`)
  let outcome = ''
  let removed = []
  let removedFolders = []
  if (r.pending.length || r.pendingFolders.length) {
    // A second publish before the first's question was answered replaces it: the list is the
    // copy's state now, and two questions about one dataset would answer each other's files.
    const was = entry.pendingDeletes
    const standing = armed.get(m.id)
    entry.pendingDeletes = { dataset: r.dataset, to: r.to, files: r.pending, folders: r.pendingFolders, at: now() }
    await write(m)
    await log(`${filesAndFolders(r.pending.length, r.pendingFolders.length)} deleted or moved here await the owner's yes before ${r.to} loses them`)
    for (const f of r.pending) await log(`  would remove ${f}`)
    for (const d of r.pendingFolders) await log(`  would remove folder ${d}/`)
    if (unattended(m)) {
      outcome = m.routine && !m.routine.promoted ? 'later' : 'nobody'
    } else {
      if (was && standing) {
        structured.withdraw(m.id, standing.id)
        armed.delete(m.id)
      }
      const asked = armPendingDeletes(m)
      // Bounded like any prompt: a tool call left waiting an hour is one the CLI gave up on.
      const answer = await Promise.race([asked, new Promise((resolve) => setTimeout(() => resolve(null), structured.ASK_TIMEOUT_MS).unref())])
      if (!answer) outcome = 'standing'
      else {
        outcome = answer.error ? 'failed' : answer.removed ? 'removed' : 'kept'
        removed = answer.files
        removedFolders = answer.folders || []
      }
    }
  }
  return { ...r, repo: entry.name, outcome, removed, removedFolders }
}

/** Why a file was pulled, for the log: new there says nothing. */
const pulledWhy = (r, f) => (r.conflicts.includes(f) ? ' (deleted here, changed there since)' : r.behind.includes(f) ? ' (changed there since, not here)' : '')

/** "3947 files and 29 folders", either part left out at none. */
export function filesAndFolders(files, folders) {
  const n = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`
  return [files ? n(files, 'file') : '', folders ? n(folders, 'folder') : ''].filter(Boolean).join(' and ') || '0 files'
}

/**
 * `data_sync`: a dataset of this chat's brought up to date from its source. A shared read copy
 * is refreshed for every chat (`syncRead`, what Sync now on the repo's page does); a write
 * copy takes in what was added on the source since, sending nothing (`syncWrite`). A snapshot
 * is taken, not synced (`data_snapshot`).
 */
export async function syncForChat(id, { repo = '', dataset }) {
  await load()
  const m = manifests.get(id)
  if (!m) throw new Error('No such workspace')
  const entry = dataEntry(m, repo)
  const recipe = await repoById(entry.id)
  const ds = await datasetNamed(recipe, dataset)
  const log = logger(m.id)
  if (ds.access === 'read') {
    const r = await syncRead(recipe, ds)
    await log(`Synced ${ds.name} from its source: ${r.files} files`)
    return { repo: entry.name, dataset: ds.name, access: 'read', files: r.files, bytes: r.bytes, pulled: [], conflicts: [], dropped: [], resent: [], pending: [] }
  }
  if (ds.access !== 'write') throw new Error(`${ds.name} is a snapshot dataset; data_snapshot takes one`)
  const r = await syncWrite(recipe, ds.name, dirFor(m.id))
  await log(`Synced ${r.dataset} from ${r.from}: ${r.pulled.length} pulled in, ${r.clashes.length} changed on both sides, ${r.dropped.length} dropped as removed there, ${r.pending.length} deleted here still to confirm`)
  for (const f of r.pulled) await log(`  pulled in ${f}${pulledWhy(r, f)}`)
  for (const f of r.clashes) await log(`  kept ${f} (changed here and there; theirs saved beside the copy)`)
  for (const f of r.dropped) await log(`  dropped here ${f} (removed there since)`)
  return { repo: entry.name, access: 'write', ...r }
}

/**
 * The standing questions about a chat's deletions, one per workspace: `{ id, done }`, `done`
 * resolving to `{ removed, files }` once the person has answered — or never, for a question
 * withdrawn. In memory only; `load` asks again from the manifests after a restart.
 */
const armed = new Map()

/**
 * Put a chat's pending deletions (`publishForChat`) to the person as a standing question on
 * its bar, unless nobody can answer there (`unattended`) or one already stands. A yes removes
 * exactly the files listed from the dataset's source and clears the entry; a no clears it, so
 * the next publish asks afresh about whatever is still gone here. Answers the question's
 * promise, or null when none was put.
 */
function armPendingDeletes(m) {
  const entry = m.repos.find(hasPendingDeletes)
  if (!entry || unattended(m)) return null
  if (armed.has(m.id)) return armed.get(m.id).done
  const p = entry.pendingDeletes
  const folders = p.folders || []
  const what = filesAndFolders(p.files.length, folders.length)
  const input = {
    question: `This chat deleted or moved files in its copy of ${p.dataset}. Remove ${what} from ${p.to} too?`,
    yes: 'remove them there',
    // Folders after the files, marked with a trailing slash: one list, one yes.
    card: { kind: 'files', title: `${what} to remove from ${p.to}`, files: [...p.files, ...folders.map((d) => `${d}/`)] },
  }
  const id = `deletes-${m.id}-${p.at}`
  const done = structured.awaitApproval(m.id, { toolName: structured.OUTPOST_ASK, input, toolUseId: id, standing: true }).then(async (decision) => {
    // Only its own place: a withdrawn question's successor is armed before this runs.
    if (armed.get(m.id)?.id === id) armed.delete(m.id)
    if (decision?.message === 'withdrawn') return null
    return applyPendingDeletes(m.id, entry.id, decision?.behavior === 'allow')
  })
  armed.set(m.id, { id, done })
  return done
}

/** The person answered: the files removed on a yes, the entry cleared either way, both logged. */
async function applyPendingDeletes(id, repoId, yes) {
  await load()
  const m = manifests.get(id)
  const entry = m?.repos.find((r) => r.id === repoId)
  const p = entry?.pendingDeletes
  if (!p) return { removed: false, files: [], folders: [] }
  const log = logger(m.id)
  let files = []
  let folders = []
  let error = ''
  try {
    if (yes) {
      const recipe = await repoById(entry.id)
      ;({ files, folders } = await removeFromSource(recipe, p.dataset, dirFor(m.id), p.files, p.folders || []))
      await log(`Removed ${filesAndFolders(files.length, folders.length)} from ${p.to}, as you said`)
      for (const f of files) await log(`  removed ${f}`)
      for (const d of folders) await log(`  removed folder ${d}/`)
      const left = (p.folders || []).filter((d) => !folders.includes(d))
      for (const d of left) await log(`  left folder ${d}/: not empty by the time it was reached`)
    } else await log(`Kept ${filesAndFolders(p.files.length, (p.folders || []).length)} on ${p.to}: you said no`)
  } catch (err) {
    error = String(err?.message || err)
    await log(`Could not remove from ${p.to}: ${error}`)
  } finally {
    delete entry.pendingDeletes
    await write(m)
  }
  return { removed: yes && files.length + folders.length > 0, files, folders, error }
}

const hasPendingDeletes = (r) => Boolean(r.pendingDeletes?.files?.length || r.pendingDeletes?.folders?.length)

/**
 * What a run's publish left for the person to confirm, for the runner to promote the run on
 * (state/routines.mjs): `[{ repo, dataset, to, files, folders }]`, empty for none.
 */
export async function pendingDeletesOf(id) {
  await load()
  const m = manifests.get(id)
  return (m?.repos || []).filter(hasPendingDeletes).map((r) => ({ repo: r.name, ...r.pendingDeletes }))
}

/**
 * The checkouts a push or a pull request is for: the one named, by id or name, or every
 * checkout in the chat.
 */
function entriesFor(m, repo) {
  const wanted = String(repo || '').trim().toLowerCase()
  const entries = wanted ? m.repos.filter((r) => r.id === wanted || r.name.toLowerCase() === wanted) : m.repos
  if (!entries.length) throw new Error(wanted ? `No repo "${repo}" in this chat` : 'This chat has no repo')
  return entries
}

/**
 * A checkout with commits and no branch gets one where it stands, named from its last commit
 * — the net under a session that committed without calling `start_work`, so the push is never
 * of a detached HEAD whose commits nothing names. Never moved first: the commits are the work.
 */
async function ensureWorkBranch(m, entry, log) {
  if (entry.branch) return
  const subject = (await git(['log', '-1', '--format=%s'], { cwd: entry.path }).catch(() => '')).trim()
  const recipe = await repoById(entry.id)
  const template = recipe?.branchTemplate || 'outpost/{slug}'
  const branch = await freeBranchName(mirrorPath(entry.id), template.replace('{slug}', slugify(subject, 'work')).replace('{id}', m.id))
  await startWorkBranch(entry.path, entry.base, branch, { clean: false })
  entry.branch = branch
  entry.work = entry.work || subject
  await log(`No work had been started in ${entry.name}; its commits are now on ${branch}`)
}

/**
 * The `push` tool: land a chat's work, the way this repo's setting says (`push`, else the
 * instance-wide default — config.mjs `PUSH_MODES`).
 *
 * Every mode merges the latest base into the work branch first, so the branch is up to date
 * and a conflict shows up here and not on GitHub: a conflict stops the push and names the
 * files, for the session to resolve and push again. Then `main` pushes the branch and lands it
 * on the base, `remote` pushes the branch alone, and `custom` pushes the branch and carries
 * out the owner's steps (`carryOutSteps`). Never a force push, and never a branch but the
 * chat's own work branch, its base, and one a custom setting names. Uncommitted changes
 * refuse it.
 */
export async function pushWork(id, { repo = '' } = {}) {
  await load()
  const m = manifests.get(id)
  if (!m) throw new Error('No such workspace')
  const log = logger(m.id)
  const settings = await readSettings()
  const results = []
  const asked = entriesFor(m, repo)
  // A repo added from an address outside the catalogue is here to be read (`addRepo`).
  const outside = asked.filter((e) => e.oneOff)
  if (outside.length && (repo || outside.length === asked.length)) throw new Error(`${outside.map((e) => e.name).join(', ')} is not in Settings › Repos, so it has no push setting — add it there to push it`)
  for (const entry of asked.filter((e) => !e.oneOff)) {
    const before = await worktreeStatus(entry.path, entry.base, entry.branch)
    if (!before.exists) throw new Error(`The checkout of ${entry.name} is gone`)
    if (!before.clean) throw new Error(`${before.changed} uncommitted change${before.changed === 1 ? '' : 's'} in ${entry.name} — commit them first`)
    if (!entry.branch && !before.ahead) {
      results.push({ repo: entry.name, nothing: true, reason: 'no work started' })
      continue
    }
    await ensureWorkBranch(m, entry, log)
    if (!before.ahead) {
      results.push({ repo: entry.name, branch: entry.branch, nothing: true, reason: `nothing on ${entry.branch} that ${entry.base} does not have` })
      continue
    }
    const recipe = await repoById(entry.id)
    const mode = recipe?.push || settings.push.mode
    const remote = await remoteFor(recipe || { url: entry.url })
    await log(`Push (${mode}): merging origin/${entry.base} into ${entry.branch}`)
    await mergeBase(entry.path, entry.base, remote)
    await pushBranch(entry.path, entry.branch, remote)
    await log(`Pushed ${entry.branch}`)
    // Every branch this push moved on the remote, in order, for the answer: a repo that ships
    // main and dev together was pushed to main alone, and the answer did not say so (2026-10-05).
    const updated = [entry.branch]
    let did
    if (mode === 'main') {
      await pushToBase(entry.path, entry.base, remote)
      updated.push(entry.base)
      entry.landedAt = now()
      await log(`Landed ${entry.branch} on ${entry.base}`)
    } else if (mode === 'custom') {
      const steps = (recipe?.push === 'custom' ? recipe.pushCustom : settings.push.custom)?.steps || []
      try {
        did = await carryOutSteps(m, entry, steps, remote, log, updated)
      } catch (err) {
        // What the steps before the failed one did is on the manifest whatever happens next.
        statusCache.delete(entry.path)
        await write(m)
        throw err
      }
    }
    statusCache.delete(entry.path)
    // Whatever Jenkins job builds what was just pushed reports to this chat (jenkins-results.mjs).
    const commit = (await git(['rev-parse', 'HEAD'], { cwd: entry.path }).catch(() => '')).trim()
    await watchCommit({ workspaceId: m.id, repoId: entry.id, repoName: entry.name, commit, branch: entry.branch, branches: updated }).catch(() => {})
    results.push({ repo: entry.name, branch: entry.branch, base: entry.base, mode, commit, updated, ...(did ? { did } : {}) })
  }
  await write(m)
  return { ok: true, results }
}

/**
 * The steps of a custom push setting, in order, after the merge and the push every mode does
 * (push-steps.mjs has the shapes; custom-push.mjs is the Test they passed before they could be
 * saved). Answers what each step did, in words. A step that fails stops the rest and says
 * what was done before it: nothing here can be taken back, so the session is told exactly
 * where it stands.
 *
 * A push to a named branch that already exists merges that branch into the work branch first,
 * as main was — "up to date first" for every target, and the only way the push is a
 * fast-forward. Never a force push. A Jenkins job is started on the owner's say-so, which is
 * the setting itself: the chat needs no Jenkins tool of its own for it.
 */
async function carryOutSteps(m, entry, steps, remote, log, updated = []) {
  const did = []
  const name = (b) => (b === '$WORK' ? entry.branch : b === '$MAIN' ? entry.base : b)
  for (const step of steps) {
    const text = describeStep(step, { main: entry.base })
    try {
      if (step.kind === 'push') {
        if (step.force) throw new Error('the push tool never force pushes')
        const target = name(step.to)
        if (target === entry.branch) {
          did.push(`pushed ${entry.branch}`)
          continue
        }
        if (target !== entry.base && (await remoteHasBranch(entry.path, target, remote))) {
          await mergeBase(entry.path, target, remote)
          await pushBranch(entry.path, entry.branch, remote)
        }
        await pushToBase(entry.path, target, remote)
        if (!updated.includes(target)) updated.push(target)
        if (target === entry.base) entry.landedAt = now()
        did.push(`landed on ${target}`)
      } else if (step.kind === 'pr') {
        const [from, to] = [name(step.from), name(step.to)]
        if (from !== entry.branch) await fetchBranch(entry.path, from, remote)
        await fetchBranch(entry.path, to, remote)
        const ahead = Number((await git(['rev-list', '--count', `origin/${to}..origin/${from}`], { cwd: entry.path })).trim())
        if (!ahead) {
          did.push(`no pull request opened — ${from} has nothing ${to} does not already have`)
        } else {
          const pr = await githubCreatePull(entry.url, { head: from, base: to, title: entry.work || m.name, body: `From the Outpost chat "${m.name}".` })
          if (from === entry.branch) entry.pr = { number: pr.number, url: pr.url, at: now() }
          did.push(`${pr.existing ? 'pull request already open' : 'opened pull request'} #${pr.number} (${from} → ${to}): ${pr.url}`)
        }
      } else if (step.kind === 'jenkins') {
        // Its Test checked the job was on the list; the list may have changed since.
        const recipe = await repoById(entry.id)
        if (!jobAllowed(step.job, recipe?.jenkinsJobs)) throw new Error(`${step.job} is not one of ${entry.name}'s Jenkins jobs any more — add it on the repo's page in Settings › Repos`)
        const params = Object.fromEntries(Object.entries(step.params || {}).map(([k, v]) => [k, String(v).replaceAll('$WORK', entry.branch).replaceAll('$MAIN', entry.base)]))
        const b = await jenkinsBuild(step.job, params)
        await watchBuild({ workspaceId: m.id, repoId: entry.id, repoName: entry.name, job: step.job, queueUrl: b.queueUrl }).catch(() => {})
        did.push(`started the ${step.job} Jenkins job`)
      } else {
        throw new Error('Outpost does not know this step')
      }
      await log(`Push (custom): ${did[did.length - 1]}`)
    } catch (err) {
      await log(`Push (custom): could not ${text}: ${err.message}`)
      throw new Error(`${entry.name}: ${entry.branch} was merged with the latest ${entry.base} and pushed${did.length ? `; ${did.join('; ')}` : ''} — then could not ${text}: ${err.message}`)
    }
  }
  return did
}

/**
 * The `github_open_pull_request` tool: the chat's work branch to `base` — the repo's main
 * branch unless the request names another ("open a PR against dev"). The base is merged in
 * and the branch pushed first, as for a push; an open pull request for the branch already is
 * answered rather than duplicated.
 */
export async function openPullRequest(id, { repo = '', base = '', title = '', body = '' } = {}) {
  await load()
  const m = manifests.get(id)
  if (!m) throw new Error('No such workspace')
  const entries = entriesFor(m, repo)
  if (entries.length > 1) throw new Error(`Name the repo: this chat has ${entries.map((e) => e.name).join(' and ')}`)
  const entry = entries[0]
  if (entry.oneOff) throw new Error(`${entry.name} is not in Settings › Repos — it was added to be read, so pull requests are refused for it; add it there first`)
  const log = logger(m.id)
  const status = await worktreeStatus(entry.path, entry.base, entry.branch)
  if (!status.clean) throw new Error(`${status.changed} uncommitted change${status.changed === 1 ? '' : 's'} in ${entry.name} — commit them first`)
  if (!entry.branch && !status.ahead) throw new Error(`No work has been started in ${entry.name} — there is nothing to open a pull request for`)
  await ensureWorkBranch(m, entry, log)
  const target = String(base || '').trim() || entry.base
  const recipe = await repoById(entry.id)
  const remote = await remoteFor(recipe || { url: entry.url })
  await mergeBase(entry.path, target, remote)
  // A branch with nothing the target lacks has nothing to review, and GitHub answers that
  // with a bare 422. It is what a branch looks like after `push` landed it on main — the first
  // real use of this tool did exactly that — so it is said here, in words.
  const ahead = Number((await git(['rev-list', '--count', `origin/${target}..HEAD`], { cwd: entry.path })).trim())
  if (!ahead) throw new Error(`${entry.branch} has nothing ${target} does not already have — if it was pushed to ${target}, the work has landed and there is nothing to review. Make a commit, or open it against another branch.`)
  await pushBranch(entry.path, entry.branch, remote)
  const pr = await githubCreatePull(entry.url, {
    head: entry.branch,
    base: target,
    title: String(title || '').trim() || entry.work || m.name,
    body: String(body || '').trim() || `From the Outpost chat "${m.name}".`,
  })
  await log(`${pr.existing ? 'Pull request already open' : 'Opened pull request'} #${pr.number} (${entry.branch} → ${target}): ${pr.url}`)
  entry.pr = { number: pr.number, url: pr.url, at: now() }
  statusCache.delete(entry.path)
  await write(m)
  return { ok: true, repo: entry.name, branch: entry.branch, base: target, pr }
}

/** The one checkout a tool is for: the one named, or the chat's only one. */
function oneEntry(m, repo) {
  const entries = entriesFor(m, repo)
  if (entries.length > 1) throw new Error(`Name the repo: this chat has ${entries.map((e) => e.name).join(' and ')}`)
  return entries[0]
}

const commitsIn = async (dir, range) => Number((await git(['rev-list', '--count', range], { cwd: dir })).trim())

/**
 * The `pull` tool: bring the remote's latest of the base, or of a named branch, into a checkout.
 * Fetched here, since the session's container holds no credential and its own `git fetch` or
 * `git pull` cannot reach the remote (workspaces.md). Then: a checkout the branch is simply
 * ahead of moves to it; one with commits of its own gets the branch merged in, on a work branch
 * (`ensureWorkBranch`) so the merge is not made on a detached HEAD. A conflict is left for the
 * session to resolve, its files named. `merge: false` only fetches, so `origin/<branch>` can be
 * read with git log, diff and show — how a chat looks at somebody else's branch. Uncommitted
 * changes refuse a merge, as they refuse a push.
 */
export async function pullWork(id, { repo = '', branch = '', merge = true } = {}) {
  await load()
  const m = manifests.get(id)
  if (!m) throw new Error('No such workspace')
  const named = String(branch || '').trim()
  const entries = named ? [oneEntry(m, repo)] : entriesFor(m, repo)
  if (named && !(await validBranchName(named))) throw new Error(`"${named}" is not a branch name`)
  const log = logger(m.id)
  const results = []
  for (const entry of entries) {
    const from = named || entry.base
    const ref = `origin/${from}`
    const recipe = await repoById(entry.id)
    const remote = await remoteFor(recipe || { url: entry.url })
    try {
      await fetchBranch(entry.path, from, remote)
    } catch (err) {
      if (named && !(await remoteHasBranch(entry.path, from, remote).catch(() => true))) throw new Error(`${entry.name} has no branch "${from}" on its remote`)
      throw err
    }
    const behind = await commitsIn(entry.path, `HEAD..${ref}`)
    const ahead = await commitsIn(entry.path, `${ref}..HEAD`)
    if (merge === false) {
      results.push({ repo: entry.name, ref, fetched: true, behind, ahead })
      continue
    }
    if (!behind) {
      results.push({ repo: entry.name, ref, upToDate: true })
      continue
    }
    const status = await worktreeStatus(entry.path, entry.base, entry.branch)
    if (!status.clean) throw new Error(`${status.changed} uncommitted change${status.changed === 1 ? '' : 's'} in ${entry.name} — commit them first`)
    if (!ahead) {
      await git(['merge', '--ff-only', '--quiet', ref], { cwd: entry.path, timeout: 60000 })
    } else {
      await ensureWorkBranch(m, entry, log)
      const { conflict } = await mergeInto(entry.path, ref)
      statusCache.delete(entry.path)
      if (conflict.length) {
        await log(`Pull: merging ${ref} into ${entry.branch} conflicts in ${conflict.join(', ')}; left for the chat`)
        results.push({ repo: entry.name, ref, branch: entry.branch, conflict })
        continue
      }
    }
    const filled = await fillCheckout(entry.path, remote)
    statusCache.delete(entry.path)
    await log(`Pulled ${ref} into ${entry.branch || `${entry.name}'s checkout`} (${behind} commit${behind === 1 ? '' : 's'})${filled ? `; ${filled}` : ''}`)
    results.push({ repo: entry.name, ref, branch: entry.branch, behind, merged: Boolean(ahead), filled })
  }
  await write(m)
  return { ok: true, results }
}

/**
 * The `push_tag` tool: tag a commit the remote already has and push the tag. A tag can start
 * a release, so the person is asked first (`ask`, from the MCP layer, which refuses a run
 * nobody watches); a tag the remote has is never moved; and a commit only this checkout has is
 * refused, since pushing its tag would publish work no push or pull request has taken out.
 */
export async function tagWork(id, { repo = '', tag = '', commit = '', message = '' } = {}, ask) {
  await load()
  const m = manifests.get(id)
  if (!m) throw new Error('No such workspace')
  const entry = oneEntry(m, repo)
  if (entry.oneOff) throw new Error(`${entry.name} is not in Settings › Repos — it was added to be read, so nothing is pushed to it`)
  const name = String(tag || '').trim()
  await git(['check-ref-format', `refs/tags/${name}`]).catch(() => {
    throw new Error(`"${name}" is not a tag name git accepts`)
  })
  const sha = (await git(['rev-parse', '--verify', `${String(commit || '').trim() || 'HEAD'}^{commit}`], { cwd: entry.path }).catch(() => {
    throw new Error(`No commit "${commit}" in ${entry.name}`)
  })).trim()
  const recipe = await repoById(entry.id)
  const remote = await remoteFor(recipe || { url: entry.url })
  await fetchBranch(entry.path, entry.base, remote)
  if (entry.branch && (await remoteHasBranch(entry.path, entry.branch, remote))) await fetchBranch(entry.path, entry.branch, remote)
  const on = (await git(['branch', '-r', '--contains', sha], { cwd: entry.path })).trim()
  if (!on) throw new Error(`${sha.slice(0, 7)} is not on ${entry.name}'s remote yet — push it first, then tag it`)
  if (await remoteHasTag(entry.path, name, remote)) throw new Error(`${entry.name} already has a tag ${name}; a tag is never moved — choose another name`)
  const subject = (await git(['log', '-1', '--format=%s', sha], { cwd: entry.path })).trim()
  const answer = await ask(`Push the tag ${name} on ${entry.name} at ${sha.slice(0, 7)} ("${subject}")? A tag can start a release.`, `push ${name}`)
  if (answer !== true) return { ok: false, refused: answer }
  await pushTag(entry.path, name, sha, String(message || '').trim() || name, remote)
  await logger(m.id)(`Pushed the tag ${name} at ${sha.slice(0, 7)} ("${subject}")`)
  return { ok: true, repo: entry.name, tag: name, commit: sha.slice(0, 7), subject }
}

/**
 * The repo a GitHub reading tool is about: one of this chat's, by id or name (its only one when
 * none is named), else any catalogue repo — with the chat's work branch and the pull request it
 * opened, so "this chat's pull request" needs no number.
 */
export async function githubRepoFor(id, repo = '') {
  await load()
  const m = manifests.get(id)
  const wanted = String(repo || '').trim().toLowerCase()
  const mine = (m?.repos || []).filter((r) => !wanted || r.id === wanted || r.name.toLowerCase() === wanted)
  if (mine.length === 1) {
    const e = mine[0]
    return { name: e.name, url: e.url, branch: e.branch || '', pr: e.pr?.number || 0 }
  }
  if (!wanted) throw new Error(mine.length ? `Name the repo: this chat has ${mine.map((e) => e.name).join(' and ')}` : 'Name the repo')
  const r = (await listRepos()).find((x) => x.id === wanted || x.name.toLowerCase() === wanted)
  if (!r) throw new Error(`No repo "${repo}" in this chat or in Settings › Repos`)
  return { name: r.name, url: r.url, branch: '', pr: 0 }
}

/**
 * The `github_merge_pull_request` tool: merge a pull request on one of this chat's repos — the
 * one it opened unless a number is given — once the person says yes (`ask`). GitHub holds the
 * branch protection, required reviews and checks, and its refusal is answered as it gave it.
 * The base is fetched after, and a merge of this chat's own branch counts as landing it; the
 * merge commit is watched for a Jenkins build as a push's is.
 */
export async function mergePullRequest(id, { repo = '', number = 0, method = '' } = {}, ask) {
  await load()
  const m = manifests.get(id)
  if (!m) throw new Error('No such workspace')
  const entry = oneEntry(m, repo)
  if (entry.oneOff) throw new Error(`${entry.name} is not in Settings › Repos — it was added to be read, so nothing is merged on it`)
  const pr = await githubPull(entry.url, { number: Number(number) || entry.pr?.number || 0, branch: entry.branch })
  if (pr.state === 'merged') return { ok: true, already: true, pr }
  if (pr.state !== 'open') throw new Error(`#${pr.number} is ${pr.state}`)
  if (pr.draft) throw new Error(`#${pr.number} is a draft — mark it ready for review on GitHub first`)
  if (pr.mergeable === false) throw new Error(`#${pr.number} conflicts with ${pr.base} — call pull, resolve, commit and push, then merge`)
  const answer = await ask(`Merge pull request #${pr.number} "${pr.title}" (${pr.head} → ${pr.base}) on ${entry.name}?`, `merge #${pr.number}`)
  if (answer !== true) return { ok: false, refused: answer }
  const done = await githubMergePull(entry.url, pr.number, { method, sha: pr.headSha })
  const log = logger(m.id)
  await log(`Merged pull request #${pr.number} (${pr.head} → ${pr.base}) by ${done.method}`)
  const recipe = await repoById(entry.id)
  await fetchBranch(entry.path, pr.base, await remoteFor(recipe || { url: entry.url })).catch(() => {})
  if (pr.head === entry.branch && pr.base === entry.base) entry.landedAt = now()
  await watchCommit({ workspaceId: m.id, repoId: entry.id, repoName: entry.name, commit: done.sha, branch: pr.base, branches: [pr.base] }).catch(() => {})
  statusCache.delete(entry.path)
  await write(m)
  return { ok: true, pr, ...done }
}

/**
 * What every session in a workspace is told about its checkouts. Appended to its system
 * prompt beside the one-command rule (launchers.md), so it holds after a restart too.
 *
 * Only what a session needs before it has loaded the tools: when to call them, and the rules
 * about git they replace. What each tool does is its own description's — the CLI defers
 * Outpost's tools until a session fetches one, so a description is paid by the chats that use
 * the tool and this rule by every request of every chat (integrations.md). Each fact is in one
 * of the two, never both.
 */
export const WORK_RULE =
  "This chat's repo checkouts start at the latest commit of their main branch, on no branch of their own. Before your first change in a checkout, call Outpost's `start_work` tool, and again when you move on to different work; commit on the branch it makes, and do not create or switch branches yourself. To ship, commit and call Outpost's `push` tool, never `git push`, or `github_open_pull_request` for a pull request. Bring in main or another branch with `pull`; `git fetch` and `git pull` hold no credential here. Commit often, each step that stands on its own, but push only when the whole piece of work, or a whole section of it, is finished and verified, or when the person asks: a push can start a build and a deploy, so a fix found along the way goes out with the section's push rather than on its own. Keep scratch files in the checkout's `temp/`, which git ignores, and leave them there: they last the chat, handoffs included."

/**
 * Told to a session at launch, and again on every restart, only when its chat declares ports
 * (containers/ports.mjs) — a lean rule nothing without ports pays for (integrations.md). It
 * names each internal port so the session runs its servers there and gets them published, and
 * says to bind all interfaces or the published port shows nothing. The outside address per port
 * is the Workspace panel's, not injected into every request.
 */
export function portsRule(m) {
  const ports = (m?.container?.ports || []).filter((p) => !p.clash)
  if (!ports.length) return ''
  const list = ports.map((p) => `${p.label} on ${p.internal}`).join(', ')
  return `This chat's container publishes these ports to the outside, so run its servers on them and nowhere else: ${list}. Bind each to 0.0.0.0, not only localhost, or nothing reaches the published port. The Workspace panel shows each port's outside address.`
}

// The standing instructions a workspace session gets at launch and keeps across every restart:
// the work rule, and the ports rule when its chat has ports. Keyed by workspace so a restart —
// an effort change, a resume, an /addRepo remount — reads the ports as they are now.
structured.setStandingRules((workspaceId) => [WORK_RULE, portsRule(workspaceId ? manifests.get(workspaceId) : null)].filter(Boolean).join('\n\n'))
structured.setBeforeLaunch(refreshPolicies)

/**
 * The policy every checkout of a chat gets (workspaces.md *The policy*): Outpost's tools
 * pre-approved as one rule for the whole server (`toolRulesFor`) — a prompt for `catalogue_read`
 * is one a routine's run can never answer, and a person should not be asked to approve a tool
 * they chose in the dialog — then every repo's own allow and deny, then the Bash allow of a
 * free-Bash chat. Written to each checkout (`entries`, the manifest's unless a repo is being
 * added), or to the primary of a chat with no repo.
 */
async function writePolicies(m, bashFree, entries = m.repos) {
  const allow = [...toolRulesFor([...m.tools, ...ownGroups(m)])]
  const deny = []
  for (const entry of entries) {
    const recipe = await repoById(entry.id)
    allow.push(...(recipe?.allow || []))
    deny.push(...(recipe?.deny || []))
  }
  if (bashFree) allow.push(...FREE_BASH_ALLOW)
  const dirs = entries.length ? entries.map((e) => e.path) : [m.primary]
  for (const dir of dirs) await writePolicy(dir, { workspaceDir: dirFor(m.id), allow, deny })
}

/** Whether the chat's running session is a free-Bash one, off its newest record. */
async function chatBashFree(m) {
  const rec = (await structured.allRecords()).filter((r) => r.workspaceId === m.id).sort((a, b) => b.startedAt - a.startedAt)[0]
  return Boolean(rec?.bashFree)
}

/**
 * The launcher's `beforeLaunch`: a ready chat's policies written again as the rules are now,
 * just before a session of it is restarted — so a recipe's rule changed in Settings, a new
 * default deny, or a tool added since reaches a chat that already exists, with the restart
 * that makes its session read the file; a chat that is not live is never touched.
 */
async function refreshPolicies(id) {
  await load()
  const m = manifests.get(id)
  if (!m || m.status !== 'ready') return
  await writePolicies(m, await chatBashFree(m))
}

/**
 * Finish a checkout's work: bring the base in, push the branch, then either fast-forward the
 * base to it (`push`) or open a pull request (`pr`). The explicit act the plan asks for — a
 * chat works on its own branch and nothing lands on `main` or `dev` until a person presses
 * this (docs/proposals/harness.md). Refused with the reason while there is uncommitted work
 * or nothing to land; a merge conflict is left for the chat to resolve.
 */
export async function finishWorkspaceRepo(id, repoId, mode) {
  await load()
  const m = manifests.get(id)
  if (!m) throw new Error('No such workspace')
  const entry = m.repos.find((r) => r.id === repoId)
  if (!entry) throw new Error('That repo is not in this workspace')
  const recipe = await repoById(entry.id)
  const remote = await remoteFor(recipe || { url: entry.url })
  const log = logger(m.id)
  if (entry.oneOff) return { ok: false, error: `${entry.name} is not in Settings › Repos — it was added to be read, so it is not pushed` }
  if (!entry.branch) return { ok: false, error: `No work has been started in ${entry.name} — there is no branch to finish` }
  const before = await worktreeStatus(entry.path, entry.base, entry.branch)
  if (!before.exists) return { ok: false, error: 'The checkout is gone' }
  if (!before.clean) return { ok: false, error: `${before.changed} uncommitted change${before.changed === 1 ? '' : 's'} — commit or discard them in the chat first` }
  if (!before.ahead && !before.behind) return { ok: false, error: `Nothing on ${entry.branch} that ${entry.base} does not have` }
  await log(`Finish (${mode}): merging origin/${entry.base} into ${entry.branch}`)
  await mergeBase(entry.path, entry.base, remote)
  await pushBranch(entry.path, entry.branch, remote)
  await log(`Pushed ${entry.branch}`)
  statusCache.delete(entry.path)
  if (mode === 'pr') {
    const pr = await githubCreatePull(entry.url, { head: entry.branch, base: entry.base, title: m.name, body: m.prompt ? `From the Outpost chat "${m.name}".\n\n${m.prompt}` : `From the Outpost chat "${m.name}".` })
    await log(`${pr.existing ? 'Pull request already open' : 'Opened pull request'} #${pr.number}: ${pr.url}`)
    entry.pr = { number: pr.number, url: pr.url, at: now() }
    await write(m)
    return { ok: true, mode, branch: entry.branch, pr }
  }
  await pushToBase(entry.path, entry.base, remote)
  await log(`Fast-forwarded ${entry.base} to ${entry.branch}`)
  entry.landedAt = now()
  await write(m)
  statusCache.delete(entry.path)
  return { ok: true, mode, branch: entry.branch, base: entry.base }
}

/**
 * Every write dataset this workspace holds a folder for, sent back to its source as
 * `data_publish` would. Answers what could not be, one `<repo>'s <dataset> (<why>)` each.
 */
async function publishBeforeDelete(m) {
  const failed = []
  for (const entry of m.repos.filter((r) => !r.oneOff)) {
    const recipe = await repoById(entry.id)
    if (!recipe) continue
    const manifest = await manifestOf(recipe)
    if (!manifest.ok) continue
    for (const ds of manifest.datasets.filter((d) => d.access === 'write')) {
      if (!(await fsp.stat(path.join(dirFor(m.id), 'data', recipe.id, ds.name)).catch(() => null))) continue
      try {
        const r = await publishWrite(recipe, ds.name, dirFor(m.id))
        if (r.partial) failed.push(`${entry.name}'s ${ds.name} (${r.errors[0] || 'rsync could not send everything'})`)
      } catch (err) {
        failed.push(`${entry.name}'s ${ds.name} (${err?.message || err})`)
      }
    }
  }
  return failed
}

/**
 * Every folder under `dir` made writable by its owner again, so what is in it can be removed. A
 * link is never followed and a file never touched: a session's test left a read-only config
 * folder holding a link to the owner's real `~/.claude/.credentials.json`.
 */
async function writableFolders(dir) {
  const st = await fsp.lstat(dir).catch(() => null)
  if (!st?.isDirectory()) return
  if ((st.mode & 0o700) !== 0o700) await fsp.chmod(dir, st.mode | 0o700).catch(() => {})
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory()) await writableFolders(path.join(dir, e.name))
  }
}

/**
 * Remove a folder this module made, whatever a session left in it. A read-only folder refuses the
 * removal of what is inside it, and the delete then stopped halfway: the worktree already gone from
 * the mirror, a checkout of only `temp/` left behind and kept by aging for good (2026-10-14). On
 * a refusal the folders are made writable; what is still refused was written as a container's
 * root, which `removeContainerFiles` removes as that root.
 */
export async function removeTree(dir) {
  const denied = (err) => err?.code === 'EACCES' || err?.code === 'EPERM'
  try {
    return await fsp.rm(dir, { recursive: true, force: true })
  } catch (err) {
    if (!denied(err)) throw err
  }
  await writableFolders(dir)
  try {
    return await fsp.rm(dir, { recursive: true, force: true })
  } catch (err) {
    if (!denied(err)) throw err
  }
  await removeContainerFiles(dir)
  await fsp.rm(dir, { recursive: true, force: true })
}

/** What each checkout of a workspace holds that its remote does not (`heldWork`), for Settings › Workspaces. */
export async function heldWorkOf(id) {
  await load()
  const m = manifests.get(id)
  if (!m) return { ok: false, error: 'No such workspace' }
  const repos = []
  for (const entry of m.repos) repos.push({ id: entry.id, name: entry.name, branch: entry.branch || '', ...(await heldWork(entry.path, entry.base)) })
  return { ok: true, repos }
}

/**
 * Every mirror's entries swept on the host (`sweepMirror`): checkouts locked, and the entries of
 * checkouts no workspace holds any more removed — a workspace folder deleted outside Outpost
 * leaves its locked entry otherwise forever. Held is a workspace with a manifest, in memory or
 * on disk, so one being prepared or deleted right now is never touched. Run daily by aging.
 * Answers `[{ mirror, locked, freed, failed }]` for the mirrors where something changed or
 * failed, and `{ mirror, error }` for one that could not be listed; the rest still are swept.
 */
export async function sweepWorktrees() {
  await load()
  const names = (await fsp.readdir(MIRRORS_DIR).catch(() => [])).filter((n) => n.endsWith('.git')).sort()
  const keep = async (id) => manifests.has(id) || (await fsp.stat(path.join(dirFor(id), MANIFEST)).then(() => true, () => false))
  const out = []
  for (const name of names) {
    const mirror = path.join(MIRRORS_DIR, name)
    try {
      const { locked, freed, failed } = await sweepMirror(mirror, { root: WORKSPACES_DIR, keep })
      if (locked.length || freed.length || failed.length) out.push({ mirror: name, locked, freed, failed })
    } catch (err) {
      out.push({ mirror: name, error: String(err?.message || err) })
    }
  }
  return out
}

/**
 * Delete a workspace. Refused while any checkout has uncommitted or unpushed work, or a write
 * dataset could not be published, unless `force` — and `force` is a person's word, never a
 * timer's; a forced delete still publishes what it can. The session is ended first,
 * because a session whose working directory has been pulled out from under it is worse
 * than one that was told to stop.
 */
export async function deleteWorkspace(id, { force = false, endSession } = {}) {
  await load()
  const m = manifests.get(id)
  if (!m) throw new Error('No such workspace')
  if (!force && m.status === 'ready') {
    for (const entry of m.repos) {
      const s = await worktreeStatus(entry.path, entry.base, entry.branch)
      if (s.exists && s.broken) return { ok: false, error: `${entry.name}'s checkout is no longer a git repo. Look inside it first, or delete anyway.` }
      if (s.exists && (!s.clean || !s.pushed)) {
        const why = !s.clean ? `${s.changed} uncommitted change${s.changed === 1 ? '' : 's'}` : 'commits that are not pushed'
        return { ok: false, error: `${entry.name} has ${why}. Push the branch first, or delete anyway.` }
      }
    }
  }
  if (endSession) await endSession(m)
  // After the session has stopped, so nothing it writes last is left behind. A write dataset's
  // folder is outside every checkout, so the git guard above never saw it: a chat's run output
  // went with its workspace, never published (2026-10-05).
  const unpublished = await publishBeforeDelete(m)
  if (!force && unpublished.length) return { ok: false, error: `Could not publish ${unpublished.join('; ')}. Publish it first, or delete anyway.` }
  // A container whose unit was stopped hard can be left behind stopped; the workspace's go with
  // it, and are gone before the folder is — see removeContainers.
  // Every chat: a chat that ran on this machine before containers were for every chat still
  // had its setups run in throwaway ones.
  {
    await removeContainers(id)
    // Anything a container wrote as its own root is not the user's to `rm`.
    await removeContainerFiles(path.join(dirFor(id), 'home'))
  }
  for (const entry of m.repos) {
    const s = await worktreeStatus(entry.path, entry.base, entry.branch).catch(() => ({ pushed: false }))
    await removeWorktree(mirrorPath(entry.id), entry.path, entry.branch, { deleteBranch: Boolean(s.pushed) }).catch(() => {})
    statusCache.delete(entry.path)
  }
  await removeTree(dirFor(id))
  manifests.delete(id)
  // A question about its deletions has nothing left to act on.
  if (armed.has(id)) {
    structured.withdraw(id, armed.get(id).id)
    armed.delete(id)
  }
  await revokeMcpTokens(id).catch(() => {})
  // The sessions this workspace carried have nothing left to resume into (launchers.md).
  await structured.forgetWorkspace(id).catch(() => {})
  return { ok: true }
}

/**
 * Run a failed preparation again, from the top, with the repos' settings as they are now —
 * which is the point: the fix for most failures is in Settings, and without this the only
 * way to apply it was to delete the chat and make another. Whatever the first attempt left
 * behind — a checkout, a branch — is removed first, so the retry starts where a new chat
 * would. Refused for anything but a failed workspace, or a ready one whose session never
 * started: any other ready one has a session in it.
 */
export async function retryWorkspace(id) {
  await load()
  const m = manifests.get(id)
  if (!m) throw new Error('No such workspace')
  // A ready chat whose session never started counts as failed: preparation said `ready` the
  // moment the unit was made, before the container in it had run (`startFailure`).
  const startFailed = await startFailureOf(m)
  const failed = m.status === 'failed' || Boolean(startFailed)
  if (!failed) return { ok: false, error: 'Only a failed preparation can be tried again' }
  if (preparing.has(id)) return { ok: false, error: 'Already preparing' }
  // A restart that died at start, of a conversation that had spoken: its checkouts hold work,
  // so it is restarted — the conversation resumed, into a container as Settings are now —
  // never prepared again, which removes them.
  if (startFailed?.resumed) return restartFailed(m)
  // Its checkouts are about to be removed, and a setup still installing into one would write
  // into the retry's fresh checkout of the same path.
  if (setupJobs.has(id)) return { ok: false, error: 'Setup is still running; try again when it has finished' }
  const repos = []
  for (const entry of m.repos) {
    const recipe = await repoById(entry.id)
    if (!recipe) return { ok: false, error: `${entry.name} is no longer in the catalogue` }
    repos.push({ recipe, base: entry.base })
  }
  for (const entry of m.repos) {
    // A checkout with no branch is a worktree all the same, and the mirror has to forget it or
    // the retry's own checkout of the same path is refused.
    await removeWorktree(mirrorPath(entry.id), entry.path, entry.branch, { deleteBranch: Boolean(entry.branch) }).catch(() => {})
    await removeTree(entry.path)
    statusCache.delete(entry.path)
    entry.branch = ''
    entry.data = undefined
  }
  await revokeMcpTokens(id).catch(() => {})
  m.status = 'preparing'
  m.step = 'Starting again'
  m.error = ''
  m.launch = null
  m.updatedAt = now()
  await write(m)
  const job = prepare(m, repos).finally(() => preparing.delete(id))
  preparing.set(id, job)
  return { ok: true, workspace: m }
}

/**
 * Why a ready chat's session never started, `{ at, log }`, or `null` (launchers.md). Read when
 * asked, never stored: the unit and its error log are the record, and a manifest saying
 * `failed` would outlive a retry that fixed it.
 */
export async function startFailureOf(m) {
  if (m?.status !== 'ready' || !m.launch?.target) return null
  // The newest session, not the launch's: a restart (an effort change, /addRepo, a resilience
  // restart) makes a new record that can die at start just the same.
  const latest = await structured.latestForWorkspace(m.id)
  return structured.startFailure(latest?.id || m.launch.target)
}

/** `retryWorkspace` for a restart that never started: restart it again, as Settings are now. */
async function restartFailed(m) {
  const log = logger(m.id)
  const rec = await structured.latestForWorkspace(m.id)
  if (!rec) return { ok: false, error: 'No session to restart' }
  const { container } = rec.container ? await freshContainer(m, log) : { container: null }
  const r = await structured.restart(rec, container ? { container } : {})
  if (!r.ok) {
    await log(`Restart after a failed start failed: ${r.error}`)
    return r
  }
  if (container) m.container = { ...m.container, image: container.image }
  m.launch = { target: r.target, at: now() }
  await write(m)
  await log('Restarted after a failed start; the conversation carries on')
  return { ok: true, workspace: m }
}

/**
 * What a chat may do with Jenkins: `{ jobs, repos }` — every job its repos' settings name
 * (`jenkinsJobs`), and those repos as the catalogue has them, for asking which of them a job
 * builds. Read at the moment of the call, so a change in Settings reaches a running chat. A
 * repo added from an address outside the catalogue counts for neither.
 */
export async function jenkinsAccessFor(id) {
  await load()
  const m = manifests.get(id)
  if (!m) return { jobs: [], readable: [], repos: [], unattended: true }
  const jobs = new Set()
  const readable = new Set()
  const repos = []
  for (const entry of m.repos.filter((r) => !r.oneOff)) {
    const recipe = await repoById(entry.id)
    if (!recipe) continue
    repos.push(recipe)
    for (const j of recipe.jenkinsJobs || []) jobs.add(j)
    // A job whose failures the repo watches is one its chats must be able to read — the chat
    // started to find out why it failed, first — whatever its builds check out.
    for (const j of recipe.jenkinsFailureChats || []) readable.add(j)
  }
  // Nobody to ask: a routine's run never waits on a prompt (routines.md), nor a chat told
  // never to ask.
  return { jobs: [...jobs], readable: [...readable], repos, unattended: unattended(m) }
}

/**
 * The hosts a chat may use (server/hosts.mjs): every host its repos name (`hosts`), with the
 * actions written for it, read at the call so a change in Settings reaches a running chat. A
 * repo added from outside the catalogue names none.
 */
export async function hostsFor(id) {
  await load()
  const m = manifests.get(id)
  if (!m) return []
  const names = []
  for (const entry of m.repos.filter((r) => !r.oneOff)) names.push(...((await repoById(entry.id))?.hosts || []))
  return hostsNamed(names)
}

/**
 * What a routine made from this chat starts from (routines.md): its catalogue repos at their
 * bases, its model, and whether anybody is there to be asked — the same test as
 * `jenkinsAccessFor`, so a routine's run, which never waits on a prompt, cannot make another
 * routine. A repo added from outside the catalogue is left out: a run starts from the
 * catalogue, and could not check it out.
 */
export async function routineContextFor(id) {
  await load()
  const m = manifests.get(id)
  if (!m) return { repos: [], model: '', unattended: true }
  return {
    repos: m.repos.filter((r) => !r.oneOff).map((r) => ({ id: r.id, name: r.name, base: r.base })),
    model: m.model || '',
    unattended: unattended(m),
    // The routine this chat defines, if it is a defining chat that has saved one (routines.md).
    defines: m.defines?.routineId || null,
  }
}

/**
 * Where main is now on a catalogue repo: its mirror fetched, the base branch's commit. What a
 * routine's gate compares with the last run's (routines.md); throws when it cannot be read.
 */
export async function mainHeadOf(repoId) {
  const recipe = await repoById(repoId)
  if (!recipe) throw new Error('not in the catalogue')
  const mirror = await ensureMirror(recipe, () => {}, await remoteFor(recipe))
  const base = recipe.baseBranch || (await defaultBranch(mirror))
  return (await git(['rev-parse', `refs/remotes/origin/${base}`], { cwd: mirror })).trim()
}

/**
 * The commits a chat made since `since`, for a routine run's record and execution log and for
 * the digest of the day (routines.md): in each checkout, twenty at most, with each one's subject
 * and whether the remote has it.
 */
export async function runCommitsOf(id, since) {
  await load()
  const m = manifests.get(id)
  if (!m) return []
  const out = []
  for (const entry of m.repos) {
    const lines = (await git(['log', '--max-count=20', `--since=@${Math.floor(since / 1000)}`, '--format=%H%x1f%s', 'HEAD'], { cwd: entry.path }).catch(() => '')).split('\n').filter(Boolean)
    for (const line of lines) {
      const [sha, subject = ''] = line.split('\x1f')
      const remote = await git(['branch', '-r', '--contains', sha], { cwd: entry.path }).catch(() => '')
      out.push({ repo: entry.id, sha, subject, pushed: Boolean(remote.trim()) })
    }
  }
  return out
}

/** The jobs alone (`jenkinsAccessFor`). */
export const jenkinsJobsFor = async (id) => (await jenkinsAccessFor(id)).jobs

/** Stamp a manifest with what aging decided: `aged` (when its session was ended) or `kept` (why it stays). */
export async function markWorkspace(id, fields) {
  await load()
  const m = manifests.get(id)
  if (!m) return null
  Object.assign(m, fields)
  await write(m)
  return m
}

/**
 * A routine's run made a chat (routines.md): `fields` (its outcome, `endedAt`, …) on the
 * manifest's `routine` with `promoted`, and from the next message on it is watched. It ran
 * `dontAsk`, so the person answering it would have every call nobody allowed refused; its mode
 * becomes the one a chat on its first repo starts in — never `dontAsk`, which is no chat's to
 * answer — and its session is ended, so the person's next message resumes it in that mode
 * (`switchMode`, launchers.md). Answers the mode, or null for a workspace that is not a run.
 */
export async function promoteRun(id, fields = {}) {
  await load()
  const m = manifests.get(id)
  if (!m?.routine) return null
  const recipe = m.repos[0] ? await repoById(m.repos[0].id) : null
  let mode = permissionModeFor({}, recipe, DEFAULT_PERMISSION_MODE)
  if (mode === 'dontAsk') mode = DEFAULT_PERMISSION_MODE !== 'dontAsk' && CLI_MODES.has(DEFAULT_PERMISSION_MODE) ? DEFAULT_PERMISSION_MODE : FALLBACK_MODE
  m.routine = { ...m.routine, ...fields, promoted: true }
  m.permissionMode = mode
  await write(m)
  const switched = await structured.switchMode(id, mode)
  if (!switched.ok) await logger(id)(`Promoted to a chat, but its session did not stop: ${switched.error}`)
  // Watched now, so what its publish left to confirm can be asked (after the switch, whose
  // restart denies what stands; a standing question survives it, but there is no need to lean on that).
  armPendingDeletes(m)
  return { mode, ended: switched.ended }
}

/**
 * Every chat that defines a routine (routines.md, *Defining chats*), from the manifests alone —
 * no git, so the roster and aging can ask on every pass: `{ id, routineId, status, createdAt }`.
 */
export async function definingChats() {
  await load()
  return [...manifests.values()].filter((m) => m.defines).map((m) => ({ id: m.id, routineId: m.defines.routineId || null, status: m.status, createdAt: m.createdAt }))
}

/**
 * Make a defining chat the one that defines `routineId`: its routine_create or routine_update was
 * approved (routines.md). Only a chat that defines nothing yet — or a routine `live` no longer
 * has — and only when no other chat defines that routine: a chat that makes a second routine
 * keeps its first, and a routine keeps the chat it already has. True when it linked.
 */
export async function linkDefiningChat(id, routineId, { live = null } = {}) {
  await load()
  const m = manifests.get(id)
  if (!m?.defines || !routineId) return false
  const current = m.defines.routineId
  if (current && (!live || live.has(current))) return false
  if ([...manifests.values()].some((o) => o.id !== id && o.defines?.routineId === routineId)) return false
  m.defines = { routineId }
  await write(m)
  return true
}

/** Remember which sessions a workspace has carried, so a `/clear` or a resume still belongs to it. */
export async function noteSession(id, sessionId) {
  await load()
  const m = manifests.get(id)
  if (!m || !sessionId || m.sessionIds.includes(sessionId)) return
  m.sessionIds.push(sessionId)
  await write(m)
}
