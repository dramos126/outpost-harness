import fsp from 'node:fs/promises'
import path from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { SETUP_TOKEN, checkApiRequest, checkRequestOrigin, lanAddress, passwordAuthEnabled, setupRequired } from './auth.mjs'
import { deleteEnvironment, listEnvironments, readAppearance, readSettings, saveAging, saveAppearance, saveContainers, saveContextLimits, saveEnvironment, saveGitIdentity, savePushDefault, writeSettings } from './config.mjs'
import { identityFor } from './workspaces/git.mjs'
import { agingStatus, agingView, configureAging, readAgingLog, tick as agingTick } from './state/aging.mjs'
import { testEnvironment } from './environments.mjs'
import { saveIntegrations } from './config.mjs'
import { generateNotifyToken, integrationsView, jenkinsNotifyAllowed, listJenkinsJobs, remoteFor, saveIntegration, testGithub, testJenkins } from './integrations.mjs'
import { buildsFor, configureJenkins, describeResult, recordResult } from './jenkins-results.mjs'
import { configureMcp, discordSentSince, fromThisMachine, handleMcp } from './mcp/index.mjs'
import { indexStats, search } from './search/index.mjs'
import {
  configureRoutines,
  deleteRoutine,
  endRun,
  exportRoutines,
  getRoutine,
  importRoutines,
  listRoutines,
  normalise as normaliseRoutine,
  noteRunTool,
  runByCall,
  previousRunStart,
  readLayout,
  readRoutineLog,
  routineSummaries,
  runLogOf,
  stampDefining,
  runNow,
  runsOf,
  saveLayout,
  saveRoutine,
  startDefining,
  stepRun,
  withLayouts,
} from './state/routines.mjs'
import { addKey, addToken, forgetHost, generateKey, listSecrets, removeSecret } from './secrets/index.mjs'
import {
  clearFailedLogins,
  configuredUser,
  createSession,
  hasCredentials,
  loginAllowed,
  noteFailedLogin,
  revokeSession,
  sessionDays,
  setPassword,
  verifyLoginAsync,
} from './credentials.mjs'
import { activeLauncher } from './launchers/index.mjs'
import { readTaskOutput, stopBackgroundTask } from './launchers/tasks.mjs'
import { dropBackgroundTask, dropSubagent, hookEvents, hookStates, recordHookEvent } from './state/hooks.mjs'
import { configureEvents, heldRoster, noteChange, openEventStream } from './events.mjs'
import { deleteRepo as deleteCatalogueRepo, envSecretName, idFor, listRepos, nameFromUrl, repoById, saveRepo, testRemote } from './workspaces/catalogue.mjs'
import { EnvRefusal, acceptEnv, envView } from './workspaces/environment.mjs'
import { datasetNamed, manifestOf, readState as readDatasetState, syncRead } from './workspaces/datasets.mjs'

import { saveClaudeAuth, claudeAuthView, finishClaudeSignIn, startClaudeSignIn, testClaude, writeClaudeEnvFile } from './claude-auth.mjs'
import { machineChecks, missingOnThisMachine } from './machine.mjs'
import { closeShell, defaultAccount, listShells, openShell, resizeShell, shellEvents, streamShell, writeShell } from './shell/index.mjs'
import { requestCheck, startUnpushed, unpushedRepos } from './workspaces/unpushed.mjs'
import os from 'node:os'

/** Every integration the page draws, Claude's sign-in with them. */
async function allIntegrations() {
  return { ...(await integrationsView()), claude: await claudeAuthView() }
}

/**
 * The catalogue as the page sees it: each repo's Environment with its secrets reduced to their
 * ends, and how often New chat has picked it (`use`, repo-use.mjs) to order the dialog's list.
 */
async function reposView() {
  const use = await repoUse()
  return Promise.all((await listRepos()).map(async (r) => ({ ...r, env: await envView(r), use: use[r.id] || { chats: 0, at: 0 } })))
}
import { customForSave, scopeFor, testCustomPush } from './workspaces/custom-push.mjs'
import { noteRepoUse, repoUse } from './workspaces/repo-use.mjs'
import {
  addRepo,
  addableChat,
  DEFAULT_PERMISSION_MODE,
  createWorkspace,
  deleteWorkspace,
  detectRepoPorts,
  finishWorkspaceRepo,
  forgetStatusForSession,
  portStatus,
  hostsFor,
  jenkinsAccessFor,
  listChatData,
  listWorkspaces,
  markWorkspace,
  heldWorkOf,
  noteSession,
  publishForChat,
  pushWorkspaceRepo,
  readLog,
  githubRepoFor,
  mergePullRequest,
  openPullRequest,
  personMessage,
  pullWork,
  pushWork,
  tagWork,
  refreshEnvFor,
  scanForRegister,
  scanForRescan,
  applyRescan,
  retrySetup,
  retryWorkspace,
  routineContextFor,
  runCommitsOf,
  startFailureOf,
  setupStatus,
  snapshotForChat,
  syncForChat,
  startWork,
  workspaceFor,
} from './workspaces/index.mjs'
import { privateNetworkReady } from './containers/index.mjs'
import { MAX_ATTEMPTS, clearRetry, restartNow, retryStates } from './state/retry.mjs'
import { notifySettings, saveNotifySettings, testNotify } from './notify/index.mjs'
import { saveUpload, MAX_BYTES } from './uploads.mjs'
import { applyTitles, setName } from './titles.mjs'
import { readUsage } from './usage.ts'
import { chatTokens, fixedOverhead, sumChatTokens } from './tokens.ts'
import { away, back, cancelHandoff, clearAway, configureHandoffs, dismissHandoff, handOff, handoffOf, stampHandoffs, startFresh, stitchEarlier, threadFor } from './handoff/index.ts'
import { readSystem, readSystemDetail } from './system.mjs'
import { buildDigest } from './state/digest.mjs'
import { CALL_BODY_LIMIT, CALL_NAME, callAllowed, makeCallToken } from './state/triggers.mjs'
import { commandNeedsWorkspace, outpostCommandText } from './outpost-commands.mjs'
import { harnessStatus, messagesOf, noteIdle, readAgents, readCommands, readFileVersion, readFiles, readImage, readTranscript, scanAll, sessionIdOf, setThreadArchived } from './scan.mjs'
import { BIN_BYTES, DOWNLOAD_BYTES, placeFiles, readWorkspaceBytes, readWorkspaceFile, workspaceDir as workspaceDirOf } from './workspaces/files.mjs'
import { containerRoot, containerStart, findInWorkspace, listTmpDir, listWorkspaceDir, readTmpBytes, readTmpFile } from './workspaces/browse.mjs'
import { isAlive as unitAlive, latestForWorkspace } from './launchers/structured.mjs'
import { previews, servePreview } from './lib/preview.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.OUTPOST_DATA || path.join(here, '..', 'data')
const STATE_FILE = path.join(DATA_DIR, 'colony.json')
/** Attachments from the page. Beside the page state, so the unit's OUTPOST_DATA covers it. */
const UPLOAD_DIR = process.env.OUTPOST_UPLOADS || path.join(DATA_DIR, 'uploads')

const STATE_VERSION = 1

/**
 * Which build of the page is on disk, as `vite build` stamped it (`vite.config.js`), or ''
 * when there is none. Read per roster rather than once: `dist/` is served off disk on every
 * request, so a build that lands under a running server is already the page a reload gets.
 */
const BUILD_FILE = path.join(here, '..', 'dist', 'build.json')
async function pageBuild() {
  try {
    const b = JSON.parse(await fsp.readFile(BUILD_FILE, 'utf8'))
    return { build: String(b.build || ''), buildCommit: String(b.commit || ''), buildSubject: String(b.subject || '') }
  } catch {
    return { build: '', buildCommit: '', buildSubject: '' }
  }
}

/**
 * Outpost's own state: what you archived, and when. The file is still `colony.json` — the
 * name is what is on disk, not a description — and the archive list is all it holds: the
 * map's `opened`, `plots`, `seen` and `settings` went with `/api/state`, which the page had
 * stopped calling, and a file that still carries them loses them on its next write. The
 * threads themselves stay read-only: nothing here ever writes to a harness's data except
 * the one archive flag.
 */
const emptyState = () => ({
  version: STATE_VERSION,
  archived: [],
  archivedAt: {},
  updatedAt: 0,
})

const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const asArray = (v) => (Array.isArray(v) ? v : [])

/**
 * No file is the normal case — nothing archived yet — and reads as empty. A file that is
 * there and will not parse is a different thing, and the two used to be one `catch`: the
 * list read as empty, every archived chat came back, and the next archive wrote that empty
 * list over whatever was on disk. So a read for the roster says so in the log, once per
 * distinct failure, and carries on with nothing archived; a read that is about to be written
 * back (`strict`) throws instead, and the file is left for a person to mend.
 */
let stateComplaint = ''
async function readState({ strict = false } = {}) {
  let text
  try {
    text = await fsp.readFile(STATE_FILE, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return emptyState()
    return unreadableState(`${STATE_FILE} is not readable: ${err.message}`, strict)
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return unreadableState(`${STATE_FILE} is not valid JSON (${err.message})`, strict)
  }
  stateComplaint = ''
  return {
    version: STATE_VERSION,
    archived: asArray(raw?.archived),
    archivedAt: asObject(raw?.archivedAt),
    updatedAt: Number(raw?.updatedAt) || 0,
  }
}

function unreadableState(why, strict) {
  if (strict) throw new Error(`${why}; the archive list was not changed`)
  if (why !== stateComplaint) console.warn(`[outpost] ${why}; reading the archive list as empty`)
  stateComplaint = why
  return emptyState()
}

/**
 * Read, change, write — one at a time. An archive and a restore are both read-modify-write on
 * the same file, and two of them interleaved is one of them lost.
 *
 * The list has two writers, both saying what they mean: `archiveIds` (an archive from the
 * page, or aging's) and `unarchiveId` (a restore). No page ever writes it whole: when one
 * did, a stale tab's copy reverted an archive made on another device (bugs-fixed.md).
 */
let stateWrites = Promise.resolve()
function mutateState(change) {
  const run = stateWrites.then(async () => {
    const state = change(await readState({ strict: true }))
    await fsp.mkdir(DATA_DIR, { recursive: true })
    const tmp = STATE_FILE + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2))
    await fsp.rename(tmp, STATE_FILE)
    return state
  })
  stateWrites = run.catch(() => {})
  return run
}

/** Add to the archive list. The first stamp wins: it is when the delete grace started (aging.md). */
const archiveIds = (ids) =>
  mutateState((prior) => ({
    ...prior,
    archived: [...new Set([...prior.archived, ...ids])],
    archivedAt: { ...Object.fromEntries(ids.map((id) => [id, Date.now()])), ...prior.archivedAt },
    updatedAt: Date.now(),
  }))

/** Take one id off the archive list, stamp and all — a restore, and the only thing that shrinks it. */
const unarchiveId = (id) =>
  mutateState((prior) => {
    const archivedAt = { ...prior.archivedAt }
    delete archivedAt[id]
    return { ...prior, archived: prior.archived.filter((x) => x !== id), archivedAt, updatedAt: Date.now() }
  })

/**
 * A harness loads its session records at launch and rewrites them whenever it touches one,
 * which silently clears an archive flag set from outside. So Outpost keeps its own list
 * and re-asserts the flag on every scan; an archive that gets stomped comes back within one
 * scan.
 */
async function reconcileArchived(threads) {
  const state = await readState()
  if (!state.archived.length) return threads
  const wanted = new Set(state.archived)

  return Promise.all(
    threads.map(async (thread) => {
      if (!wanted.has(thread.id)) return thread
      if (!thread.archived && thread.canArchive) {
        await setThreadArchived(thread.harness, thread.ref, true).catch(() => {})
      }
      return { ...thread, archived: true }
    })
  )
}

/**
 * The roster as this machine knows it: every Outpost chat, and every routine's run, the hidden
 * ones included (`workspace.hidden`, routines.md). What the loops read — the routine runner,
 * aging, the MCP tools — and a delete ending a run's session. The page reads `roster()`.
 */
export async function fullRoster() {
  // The harness says what each thread is; the launcher says what this machine can do to
  // it. Stamped here so the page never infers "typable" from "has a pid".
  const launcher = await activeLauncher()
  const scan = await scanAll()
  const scanned = await launcher.annotate(await reconcileArchived(scan.threads))
  // What the supervisor intends to do about each stalled one, so the panel can count
  // down to a restart rather than only saying that a session stopped.
  const retries = await retryStates()
  for (const t of scanned) {
    const rec = retries.get(t.ref?.cliSessionId || t.id)
    // `max` rides along rather than being a constant on the page: it is the server's
    // policy, and a page showing "2 of 5" against a server configured for three is worse
    // than one that had to ask.
    t.retry = rec
      ? { attempts: rec.attempts, max: MAX_ATTEMPTS, nextAt: rec.nextAt, why: rec.why, exhausted: rec.exhausted, lastError: rec.lastError, held: Boolean(rec.held), heldContext: rec.heldContext || 0 }
      : null

    // A session started in a workspace belongs to that chat. Stamped here, beside the other
    // things this machine knows and the scan does not: the harness sees a cwd and nothing
    // else. A plain chat's cwd is the workspace directory itself, whose basename is an id
    // nobody should read as a repo — so the chat's name stands in for the project. A session
    // that has not answered yet carries the CLI's configured default as a flagged guess
    // (harnesses.md); the chat's own choice is the better guess, since it was launched on it.
    const ws = await workspaceFor(t.cwd)
    if (!ws) continue
    // `unpushed` only on a repo unpushed half an hour or more (unpushed.mjs), for the chip's outline.
    const unpushed = await unpushedRepos(ws.id)
    t.workspace = { id: ws.id, name: ws.name, status: ws.status, pinned: Boolean(ws.pinned), repos: ws.repos.map((r) => ({ id: r.id, name: r.name, branch: r.branch, ...(unpushed[r.id] ? { unpushed: true } : {}) })) }
    // A routine's run is not a chat until it is promoted (routines.md): hidden from the page
    // while it works and when it ends with nothing to say. A promoted one carries its routine,
    // for the chat list's chip; every other chat carries null. (A desktop session's own
    // scheduled-task id is `cliTaskId`, harnesses.md.) `answered` once the person has spoken in
    // it (`spokenAt`; nobody can before it is promoted): from then on a turn's end is news, not
    // the run asking again.
    t.routine = ws.routine?.promoted ? { id: ws.routine.id, name: ws.routine.name, runId: ws.routine.runId, answered: Boolean(ws.spokenAt) } : null
    if (ws.routine && !ws.routine.promoted) t.workspace.hidden = true
    // A chat that defines a routine (routines.md, *Defining chats*): listed, so the page can open
    // and drive it, and flagged, so it draws it under Routines and never under Chats. `roster()`
    // adds the routine's name, and says null for a routine that is gone.
    t.defines = ws.defines ? { routineId: ws.defines.routineId || null } : null
    if (!ws.repos.length) t.project = ws.name
    if (t.model && m_alias(ws.model) && t.modelAssumed) t.model = m_alias(ws.model)
    const sid = sessionIdOf(t.harness, t.ref)
    if (sid) noteSession(ws.id, sid).catch(() => {})
  }
  // Only the chats Outpost started are listed: a session in a workspace Outpost made. A VS
  // Code session, a hand-started terminal, a session in a working clone — all still fire
  // hooks and are still indexed for memory (integrations.md), and none is a row here.
  // One row per chat: a conversation the chat was started fresh from hangs on its successor as
  // `earlier` rather than being a row of its own (handoff.md).
  const threads = await stitchEarlier(scanned.filter((t) => t.workspace))
  // What each is called: the person's name, or one made from its prompts (chats.md). Only for
  // the listed chats, so a session Outpost did not start never costs a naming — nor a hidden
  // run, which is called by its workspace's name ("<routine> · <time>").
  await applyTitles(threads.filter((t) => !t.workspace?.hidden))
  for (const t of threads) if (t.workspace?.hidden) t.title = t.workspace.name
  // Each chat's handoff as the card and header need it, never its text (handoff.md).
  await stampHandoffs(threads)
  // Git status is re-checked only for chats a session is working in or was lately; a checkout
  // nobody is in cannot move, and Outpost's own pushes and commits drop its cached status.
  const active = new Set()
  for (const t of threads) if (t.workspace && (t.running || Date.now() - (t.lastActivityAt || 0) < ACTIVE_STATUS_MS)) active.add(t.workspace.id)
  const workspaces = await listWorkspaces({ active })
  // What aging thinks of each: idle for how long, when it ages out, whether it is being kept.
  const view = await agingView(workspaces, threads)
  for (const w of workspaces) w.aging = view.get(w.id) || null
  // Its Jenkins builds, for the Workspace section: Outpost's own record, no call to Jenkins.
  for (const w of workspaces) w.builds = await buildsFor(w.id)
  // A session that never started, with podman's reason (launchers.md): the panel would
  // otherwise sit on a ready chat with nothing in it and no word why.
  for (const w of workspaces) w.startFailure = await startFailureOf(w)
  for (const t of threads) if (t.workspace) t.workspace.aging = view.get(t.workspace.id) || null
  // `scanFailed` names any harness whose scan threw: its threads are missing from this list,
  // not gone, and aging and the routine runner refuse to act on a roster that says so.
  // `build` is the page on disk, so a tab running an older one can say so.
  // `contextLimits`: when the conversation header calls a context large (ui-conversation.md). On the roster
  // rather than fetched by the page, so a change in Settings reaches every open tab on the push.
  // `appearance` likewise (ui.md), null until one is saved so a page keeps its own cached choice.
  // A settings file that will not parse costs the colours, never the roster.
  const settings = await readSettings().catch(() => null)
  const contextLimits = settings ? settings.context : null
  const appearance = settings ? settings.appearance : null
  for (const w of workspaces) if (w.routine && !w.routine.promoted) w.hidden = true
  return { threads, workspaces, scannedAt: Date.now(), scanFailed: scan.failed, ...(await pageBuild()), contextLimits, appearance }
}

/**
 * The roster: every chat, as the page should see it. Served by `GET /api/threads` and pushed
 * down `/api/events` whenever it changes, so there is one answer to "what exists" however the
 * page asks. A routine's run that is not a chat is in neither `threads` nor `workspaces` — a
 * workspace with no listed chat reads to the page as one stranded (routines.md) — and
 * `routines` is the sidebar's list, so it repaints on the same push; `drafts` are the unsaved
 * defining chats, and each defining chat's `defines` is named (routines.md, *Defining chats*). A
 * routine store that will not read costs the list, never the roster.
 */
export async function roster() {
  const full = await fullRoster()
  const routines = await routineSummaries().catch(() => [])
  const threads = full.threads.filter((t) => !t.workspace?.hidden)
  const workspaces = full.workspaces.filter((w) => !w.hidden)
  return { ...full, threads, workspaces, routines, drafts: stampDefining(threads, workspaces, routines) }
}


/** How long after its last activity a chat's checkout is still re-checked: long enough to catch the turn's last commit. */
const ACTIVE_STATUS_MS = 5 * 60_000

/** The picker's label to the alias the CLI takes: the first word, lowercased (launchers.md). */
const m_alias = (label) => (label && !/^default\b/i.test(label) ? label.split(/\s+/)[0].toLowerCase() : '')

configureEvents({ roster })
/** Routines as the page reads them: each with its saved `layout` (routines.md *Layouts*), which the tools' list never carries. */
const pageRoutines = async () => withLayouts(await listRoutines())

/** A thread's last reply in words, or `''`: what a routine's run that never called `routine_end` last said. */
async function lastReply(thread) {
  const r = await readTranscript(thread.harness, thread.ref)
  const last = r.ok ? r.messages.findLast((m) => m.role === 'assistant' && m.kind === 'text') : null
  return last?.text || ''
}

/** What a run's session spent, for its record (routines.md); null when the transcript will not read. */
async function tokensOf(thread) {
  const t = await chatTokens(thread.harness, thread.ref)
  return t.ok ? { total: t.total.input + t.total.output + t.total.cacheRead + t.total.cacheWrite, input: t.total.input, output: t.total.output, cacheRead: t.total.cacheRead, cacheWrite: t.total.cacheWrite } : null
}

configureRoutines({
  roster: fullRoster,
  // A deleted routine's defining chat goes through the workspace's own delete, never forced
  // (routines.md, *Defining chats*).
  deleteChat: (id) => deleteWorkspace(id, { endSession: endWorkspaceSessions }),
  lastReply,
  discordSentSince,
  tokensOf,
  // A run that ended `nothing` or `done`: its session ended at once (routines.md). A refusal is
  // made a throw, which the runner logs.
  endSession: async (thread) => {
    const launcher = await activeLauncher()
    if (!(await launcher.isAlive(thread))) return
    const ended = await launcher.killSession(thread)
    if (!ended.ok) throw new Error(ended.error || 'The session did not stop')
  },
})
// Each tool call's input, for a routine run's execution log; the store decides whether the
// session is a run (routines.md).
hookEvents.on('tool', (e) => {
  noteRunTool(e).catch(() => {})
})
configureHandoffs({ roster })
// Unpushed work for the chat list's chip: checked after a call that can change a checkout, when
// a drawer into the chat goes quiet, and on a slow poll (workspaces-git.md).
startUnpushed()
shellEvents.on('quiet', (e) => requestCheck(e.workspace))
// The file sessions read Claude's sign-in from is made from the store and the settings at
// every start, so it never says other than they do (claude-auth.mjs).
writeClaudeEnvFile().catch((err) => console.error(`claude.env: ${err.message}`))
configureMcp({
  // The whole roster: `discord_send` names a hidden run by its thread too; `chats_list` leaves
  // hidden runs out itself.
  roster: fullRoster,
  startWork,
  pullWork,
  pushWork,
  tagWork,
  openPullRequest,
  mergePullRequest,
  githubRepoFor,
  addRepo,
  jenkinsAccessFor,
  hostsFor,
  listChatData,
  snapshotForChat,
  publishForChat,
  syncForChat,
  setupStatus,
  routineContextFor,
  routines: {
    list: listRoutines,
    get: getRoutine,
    // Where its boxes were dragged to, for the approval card's drawing (routines.md *Layouts*).
    layout: readLayout,
    save: saveRoutine,
    remove: deleteRoutine,
    // The store's own check on a draft, before anybody is asked (routines.md); a draft with no
    // id stays without one, so saving it creates.
    check: (r) => {
      const n = normaliseRoutine(r)
      if (!n) throw new Error('A routine needs a name')
      return r.id ? n : { ...n, id: undefined }
    },
    step: stepRun,
    end: endRun,
  },
  // `chats_digest` (routines.md, *The digest*): from the whole roster, each chat's transcript and
  // git, since the time asked for, else this routine's last run, else a day ago. The run itself
  // is left out with every other run.
  chatsDigest: async ({ since, maxBytes }, grant) => {
    const from = since || (await previousRunStart(grant.workspaceId).catch(() => 0)) || Date.now() - 24 * 60 * 60 * 1000
    const { threads } = await fullRoster()
    return buildDigest({
      since: from,
      threads,
      maxBytes,
      commits: runCommitsOf,
      read: async (t) => {
        const r = await readTranscript(t.harness, t.ref)
        if (!r.ok) return { items: [], from: 0 }
        return { items: r.messages, from: r.truncated ? r.messages[0]?.ts || 0 : 0 }
      },
    })
  },
})
configureJenkins({
  changed: noteChange,
  // A failure no chat owns starts one, as a routine's run is started: nobody is there to
  // answer a prompt, so it never asks (routines.md).
  startChat: (spec) => createWorkspace(spec, { permissionMode: 'dontAsk' }),
  workspaces: listWorkspaces,
})
configureAging({
  // The whole roster: a routine's run is aged, and its workspace deleted, like any chat's.
  roster: fullRoster,
  // The archive list, appended to, and the stamps the delete grace is counted from.
  archive: (ids) => archiveIds(ids),
  archivedAt: async () => (await readState()).archivedAt,
  endSession: async (thread) => {
    const launcher = await activeLauncher()
    if (!(await launcher.isAlive(thread))) return
    // A refusal is an answer, not a throw; aging logs what is thrown, so it is made one.
    const ended = await launcher.killSession(thread)
    if (!ended.ok) throw new Error(ended.error || 'The session did not stop')
  },
  // A quiet session's end: never one asking the person something, since a kill denies every
  // standing request (launchers.md), nor one working again since the roster was read.
  endQuiet: async (thread) => {
    const launcher = await activeLauncher()
    if (!(await launcher.isAlive(thread))) return { ended: false }
    const quiet = await launcher.isQuiet(thread)
    if (!quiet.quiet) return { ended: false }
    const ended = await launcher.killSession(thread)
    if (!ended.ok) throw new Error(ended.error || 'The session did not stop')
    return { ended: true }
  },
  startedAt: async (thread) => (await activeLauncher()).startedAt(thread),
})

/**
 * Every session of a workspace about to be deleted, ended through the launcher: the page's
 * Delete and a deleted routine's defining chat.
 */
async function endWorkspaceSessions(m) {
  const launcher = await activeLauncher()
  // The whole roster: a hidden run's session is ended too.
  const { threads } = await fullRoster()
  for (const t of threads) {
    // No look at `ref.pid`: the scan's pid is a file the CLI may not have written,
    // and a session skipped here keeps running in a directory that is about to go.
    if (t.workspace?.id !== m.id) continue
    if (!(await launcher.isAlive(t))) continue
    // A session that will not stop refuses the delete: pulling its working
    // directory out from under it is the thing ending it first exists to prevent.
    const ended = await launcher.killSession(t)
    if (!ended.ok) throw new Error(`Could not end the session in this workspace: ${ended.error || 'it did not stop'}`)
  }
}

/** Requests whose body went over its limit: answered, then hung up on (`readJsonBody`). */
const overLimit = new WeakSet()

function send(res, status, body) {
  const payload = JSON.stringify(body)
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  }
  // The rest of an oversized body is never read, so the connection cannot be reused: say so,
  // and drop it once the answer is out rather than leave a sender streaming into nothing.
  const hangUp = res.req && overLimit.has(res.req)
  if (hangUp) headers.Connection = 'close'
  res.writeHead(status, headers)
  res.end(payload, hangUp ? () => res.req.destroy() : undefined)
}

/**
 * The answer to a handler that threw. The status is the error's own when it carries one (a
 * body too large or not JSON), else 500 — and a 500 is written to the log, because the page
 * shows a toast that is gone in four seconds and nothing else ever recorded that it happened.
 */
function fail(req, res, err) {
  const status = err?.status || 500
  if (status >= 500) console.warn(`[outpost] ${req.method} ${String(req.url || '').split('?')[0]} failed:`, err?.stack || err)
  if (res.headersSent) return res.end()
  return send(res, status, { error: String(err && err.message ? err.message : err) })
}

/**
 * One file as text, for `/api/file` and the preview alike: from disk, bounded to the workspace,
 * the version a Write made, or the container's /tmp. Answers the status and the body to send.
 */
async function readFileText({ harness, ref, path: p, version, root }) {
  if (root !== undefined && root !== 'workspace' && root !== 'tmp') return { status: 400, result: { ok: false, error: 'Read from the workspace or the container /tmp' } }
  if (version && root !== 'tmp') {
    const result = await readFileVersion(harness, ref, String(version))
    // `size` on every answer, as the disk read has it: a version's is the Write's length.
    return { status: result.ok ? 200 : 404, result: result.ok ? { ...result, size: result.bytes } : result }
  }
  const thread = await threadFor(harness, ref)
  const ws = thread ? await workspaceFor(thread.cwd) : null
  if (!ws) return { status: 404, result: { ok: false, error: 'No such chat' } }
  if (root === 'tmp') {
    // The container's own /tmp (workspaces.md *Files*): gone with the container, so `missing` then.
    const { at } = await chatContainerRoot(ws)
    const result = at ? await readTmpFile(at, p) : { ok: true, path: String(p || ''), text: '', missing: true }
    return { status: result.ok ? 200 : 400, result }
  }
  const result = await readWorkspaceFile(ws, String(p || ''), { cwd: thread.cwd || '' })
  return { status: result.ok ? 200 : 400, result }
}

/**
 * The one thing `/api/hook` does not share with every other endpoint: who it trusts.
 *
 * Hooks are posted by `claude` itself, on the same machine as this server, with no browser
 * and no Origin anywhere in sight — so the rules in `auth.mjs` do not apply to them and this
 * is their whole gate. Same machine — the socket's real address, not the `Host` header a LAN
 * client can write (`fromThisMachine`) — plus a token when there is one to check. A hook from
 * loopback needs no token, so every existing install keeps reporting with nothing re-run.
 *
 * `OUTPOST_HOOK_TOKEN` is separate from `OUTPOST_TOKEN` on purpose. They guard different
 * things: `OUTPOST_TOKEN` lets a browser somewhere on the LAN drive Outpost, while this
 * one only ever needs to be known by processes already running on the server itself. Sharing
 * one secret between them would mean the LAN token has to be pasted into a
 * `.claude/settings.json` in every project — a file that gets committed.
 */
const HOOK_TOKEN = process.env.OUTPOST_HOOK_TOKEN || ''

/**
 * Two secrets compared in constant time. `!==` stops at the first differing character, and how
 * long that took says how much of a guess was right — for the setup token, the one thing
 * between the LAN and claiming a fresh box.
 */
function sameSecret(offered, wanted) {
  const a = Buffer.from(String(offered ?? ''))
  const b = Buffer.from(String(wanted ?? ''))
  return a.length === b.length && timingSafeEqual(a, b)
}

function hookTokenOk(req) {
  if (!HOOK_TOKEN) return true
  return sameSecret(req.headers.authorization || '', `Bearer ${HOOK_TOKEN}`)
}

/**
 * What a request body may weigh. Every endpoint that reads one reads it through
 * `readJsonBody`, so this is the cap on all of them: a ref and a few fields for most, a long
 * pasted prompt or a hook payload carrying a whole tool input at the top end.
 */
const BODY_LIMIT = 4 * 1024 * 1024
/**
 * A hook's cap. The biggest real payload is a `PreToolUse` carrying a whole tool input — a
 * `Write`'s file — and that is one model turn's output, a few hundred KB at most. 4 MB per
 * request let a loop on this machine push the store as fast as it could post.
 */
const HOOK_BODY_LIMIT = 1024 * 1024
/** `/api/upload` alone takes more: the decoded cap in `uploads.mjs`, plus base64's third and the envelope. */
const UPLOAD_BODY_LIMIT = Math.ceil(MAX_BYTES * 1.4)

/**
 * POSTs that only read — a POST because they carry a `ref` (api.md). The open conversation
 * asks several of these a second, and counting them as writes would mean the loop's roster
 * is never the one handed out.
 */
const READ_POSTS = new Set(['/api/transcript', '/api/image', '/api/agents', '/api/commands', '/api/task/output', '/api/files', '/api/file', '/api/file/bytes', '/api/file/preview', '/api/dir', '/api/find', '/api/tokens','/api/prompt', '/api/efforts', '/api/models', '/api/handoff/text'])

/**
 * `/proc/<pid>/root` of the chat's running container and its start time (`since`), or both
 * `''`: its newest session's, and only one run in a container.
 */
async function chatContainerRoot(ws) {
  const rec = await latestForWorkspace(ws.id)
  const at = rec?.container ? await containerRoot(rec.id) : ''
  return { at, since: at ? containerStart(rec.id) : '' }
}

const bodyError = (status, message) => Object.assign(new Error(message), { status })

/**
 * The request's JSON body, or `{}` for none. Over the limit is a 413 and not JSON is a 400,
 * both with a sentence: the socket used to be destroyed under an oversized body, so the page
 * saw a dropped connection and no reason, and a malformed one came back as a 500.
 */
function readJsonBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => {
      overLimit.add(req)
      reject(bodyError(413, `Request body is over ${Math.round(limit / 1048576)} MB`))
    }
    // A sender that says how much is coming is refused before any of it is read.
    if (Number(req.headers['content-length']) > limit) return tooLarge()
    let size = 0
    let chunks = []
    req.on('data', (c) => {
      if (!chunks) return
      size += c.length
      if (size > limit) {
        chunks = null // what was buffered is dropped; `send` hangs up after answering
        return tooLarge()
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks) return
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        reject(bodyError(400, 'Request body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Connect-style middleware: handles /api/*, passes everything else through.
 *
 * The wrapper is the net under everything `route` does outside its own try — the login and
 * setup endpoints, the MCP handler. A throw there was an unhandled rejection: no answer to
 * the request, and nothing between it and the process's exit.
 */
/**
 * A request the page waited more than this on is written to the log with its time. "Switching
 * chats is slow after a deploy" was reported with nothing to say which request was slow or
 * why, and every cache a restart empties measured cheap; this is what tells the next report
 * where the wait actually was. The stream is exempt: it is open for as long as the page is.
 */
const SLOW_MS = 1000

export async function apiMiddleware(req, res, next) {
  const started = performance.now()
  res.once('finish', () => {
    const ms = Math.round(performance.now() - started)
    if (ms < SLOW_MS || req.url?.startsWith('/api/events')) return
    console.warn(`[outpost] slow: ${req.method} ${req.url?.split('?')[0]} took ${ms} ms (up ${Math.round(process.uptime())} s)`)
  })
  try {
    return await route(req, res, next)
  } catch (err) {
    return fail(req, res, err)
  }
}

/**
 * Whether `incoming` would change a locked entry of `previous` — the same test `acceptEnv`
 * gates on (environment.mjs), used only to order an import; a disagreement costs order,
 * never the gate.
 */
function touchesLocked(incoming, previous) {
  const after = new Map((Array.isArray(incoming) ? incoming : []).map((e) => [String(e?.name || '').trim(), e]))
  return (previous || []).some((old) => {
    if (!old.locked) return false
    const now = after.get(old.name)
    return !now || now.locked !== true || (now.secret === true) !== old.secret || (old.secret ? typeof now.value === 'string' && now.value !== '' : String(now.value ?? '') !== old.value)
  })
}

async function route(req, res, next) {
  const url = new URL(req.url, 'http://localhost')
  // Sessions calling Outpost's tools: not the page, and not under /api — gated on a loopback
  // socket plus the per-workspace token the session carries (mcp/index.mjs).
  if (url.pathname === '/mcp') return handleMcp(req, res)
  if (!url.pathname.startsWith('/api/')) return next ? next() : send(res, 404, { error: 'Not found' })

  // Hooks are the one caller that is not the page. They arrive from `claude` itself and carry
  // no Origin at all, so the CSRF rule below would reject every one of them. They get their
  // own gate: a loopback socket, plus a shared token once there is one to check.
  if (url.pathname === '/api/hook') {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    if (!fromThisMachine(req) || !hookTokenOk(req)) {
      return send(res, 403, { ok: false, error: 'Not authorised to report hook events' })
    }
    try {
      const rec = await recordHookEvent(await readJsonBody(req, HOOK_BODY_LIMIT))
      // A malformed payload is answered, never thrown on: a hook that hangs or errors is a
      // hook that slows down somebody's actual session.
      return rec
        ? send(res, 200, { ok: true, status: rec.status })
        : send(res, 200, { ok: false, error: 'Not a hook payload: no session id, or a field past its limit' })
    } catch (err) {
      return send(res, 200, { ok: false, error: String(err?.message || err) })
    }
  }

  // The Files viewer's HTML preview, loaded by a frame whose src cannot carry the bearer header.
  // Its gate is the ticket in the path: 192 random bits, minted through the gated
  // `/api/file/preview`, ten minutes; nothing else of the request is read (server/lib/preview.mjs).
  if (url.pathname.startsWith('/api/preview/')) return servePreview(req, res, url.pathname.slice('/api/preview/'.length))

  // Jenkins posting a build's result: not the page and not this machine, so neither the page's
  // gate nor the hook's applies. Its own: the notify token the owner pasted into Settings and
  // into Jenkins, and nothing answers without one saved (integrations-ci.md).
  if (url.pathname === '/api/jenkins/notify') {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    if (!(await jenkinsNotifyAllowed(req.headers.authorization))) return send(res, 403, { ok: false, error: 'Not authorised to report builds' })
    const r = await recordResult(await readJsonBody(req, 64 * 1024))
    if (r.ok) console.log(`[outpost] Jenkins reported ${describeResult(r.result)} — ${r.delivered.map((d) => d.to).join(', ') || 'no chat waiting on it'}`)
    return send(res, r.ok ? 200 : 400, r)
  }

  // A routine's call trigger (routines-triggers.md): a script or another machine, not the page,
  // so neither the page's gate nor the hook's applies. Its own: the token made for that trigger
  // alone, and nothing answers a name with none — not even whether the name exists.
  const callMatch = /^\/api\/triggers\/([^/]+)$/.exec(url.pathname)
  if (callMatch) {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })
    const name = decodeURIComponent(callMatch[1])
    if (!CALL_NAME.test(name) || !(await callAllowed(name, req.headers.authorization))) return send(res, 403, { ok: false, error: 'Not authorised to start this routine' })
    // Capped as Jenkins's is; an empty body is `{}`, a call that sent nothing.
    const body = await readJsonBody(req, CALL_BODY_LIMIT)
    const r = await runByCall(name, body)
    const { status, ...answer } = r
    return send(res, status, answer)
  }

  // Logging in is the one thing that must work without a credential, so it sits outside the
  // gate below and carries its own: same-origin only, and rate limited, because a password on
  // a LAN with no limiter can be guessed a few thousand times a second.
  if (url.pathname === '/api/login' || url.pathname === '/api/logout' || url.pathname === '/api/auth' || url.pathname === '/api/setup') {
    const originOk = checkRequestOrigin(req)
    if (!originOk.ok) return send(res, originOk.status, { error: originOk.error })

    // What the page needs to know before it can render anything: is there a password at all?
    if (url.pathname === '/api/auth' && req.method === 'GET') {
      return send(res, 200, {
        passwordAuth: passwordAuthEnabled(),
        user: passwordAuthEnabled() ? configuredUser() : '',
        sessionDays: sessionDays(),
        setupRequired: setupRequired(),
      })
    }

    /**
     * The first password on a fresh box, from the page. Gated by the setup token the server
     * printed at start (auth.md): without it a request from the LAN could claim the box.
     * Refused outright once a password exists — this is for the first one only; changing it
     * is `yarn passwd`, or the account group later.
     */
    if (url.pathname === '/api/setup' && req.method === 'POST') {
      const body = await readJsonBody(req).catch(() => ({}))
      if (hasCredentials()) return send(res, 409, { error: 'A password is already set' })
      if (!SETUP_TOKEN || !sameSecret(body.token, SETUP_TOKEN)) {
        return send(res, 403, { error: 'That setup link is not the one this server printed' })
      }
      const user = String(body.user || '').trim()
      const password = String(body.password || '')
      if (!user || password.length < 8) return send(res, 400, { error: 'A username and a password of at least eight characters' })
      await setPassword(user, password)
      const token = await createSession(String(req.headers['user-agent'] || '').slice(0, 120))
      return send(res, 200, { ok: true, token, user, sessionDays: sessionDays() })
    }

    if (url.pathname === '/api/logout' && req.method === 'POST') {
      const auth = String(req.headers.authorization || '')
      const presented = auth.startsWith('Bearer ') ? auth.slice(7) : ''
      await revokeSession(presented).catch(() => false)
      return send(res, 200, { ok: true })
    }

    if (url.pathname === '/api/login' && req.method === 'POST') {
      if (!passwordAuthEnabled()) {
        return send(res, 400, { error: 'No password is set on this server. Run: yarn passwd' })
      }
      // The socket address, not a forwarded header — a client-supplied header would let an
      // attacker reset their own limiter by lying about where they are.
      const addr = req.socket?.remoteAddress || 'unknown'
      const gate = loginAllowed(addr)
      if (!gate.ok) {
        const mins = Math.ceil(gate.retryAfterMs / 60000)
        return send(res, 429, { error: `Too many attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` })
      }
      const body = await readJsonBody(req).catch(() => ({}))
      // Counted before the check, not after a miss: the check now yields for the length of a
      // scrypt, and counted after it, a burst of parallel guesses all passed `loginAllowed`
      // before any of them was noted. A right answer clears it below.
      noteFailedLogin(addr)
      if (!(await verifyLoginAsync(body.user, body.password))) {
        // One message for both halves: saying which was wrong hands over a valid username.
        return send(res, 401, { error: 'That username and password did not match' })
      }
      clearFailedLogins(addr)
      const token = await createSession(String(req.headers['user-agent'] || '').slice(0, 120))
      return send(res, 200, { ok: true, token, sessionDays: sessionDays() })
    }

    return send(res, 405, { error: 'Method not allowed' })
  }

  const allowed = checkApiRequest(req, url)
  // `needsLogin` rides along so the page can tell "show the form" from "you have no business
  // here" — a stale session in localStorage is the former, and is the normal way a login lapses.
  if (!allowed.ok) {
    return send(res, allowed.status, { error: allowed.error, needsLogin: Boolean(allowed.needsLogin), needsSetup: Boolean(allowed.needsSetup) })
  }

  // Anything that is not a read may have moved the roster, so the copy the events loop holds
  // is not handed to a fetch that follows it (events.mjs `heldRoster`). Marked on arrival and
  // again once answered: a scan that started in between read a write half done.
  if (req.method !== 'GET' && !READ_POSTS.has(url.pathname)) {
    noteChange()
    res.on('close', noteChange)
  }

  try {
    if (url.pathname === '/api/threads' && req.method === 'GET') {
      return send(res, 200, heldRoster() || (await roster()))
    }

    /**
     * The push channel: the same payload as `/api/threads`, sent whenever it changes, for as
     * long as the page keeps the stream open. Inside the credential gate like everything
     * else; the page reads it with `fetch` so the bearer header rides along (events.mjs).
     */
    if (url.pathname === '/api/events' && req.method === 'GET') {
      return openEventStream(req, res)
    }

    // ── the shells: the host's and a chat's container (docs/modules/auth.md) ────────────
    // Inside the credential gate, and refused outright while Outpost has no login of its own:
    // with none, anything on this machine could reach these routes. Behind them the host
    // shell still asks for the account's own password; a container shell reaches only what
    // its chat does (shell/index.mjs).
    if (url.pathname.startsWith('/api/shells')) {
      if (!hasCredentials()) return send(res, 403, { ok: false, error: 'The terminal needs Outpost’s own login turned on first — set a password' })
      const m = /^\/api\/shells(?:\/([a-f0-9]{12})(?:\/(out|in|resize))?)?$/.exec(url.pathname)
      if (!m) return send(res, 404, { ok: false, error: 'Not found' })
      const [, id, part] = m
      try {
        if (!id && req.method === 'GET') return send(res, 200, { shells: listShells(), account: defaultAccount(), host: os.hostname() })
        if (!id && req.method === 'POST') {
          const body = await readJsonBody(req)
          // `chat` is a shell into that chat's container, behind this login alone (auth.md).
          const chat = body?.chat ? { harness: body.chat.harness, ref: body.chat.ref } : null
          const shell = await openShell({ account: body?.account, chat, rows: body?.rows, cols: body?.cols, addr: req.socket?.remoteAddress || '' }, { threadFor, workspaceFor, latestForWorkspace, isAlive: unitAlive })
          return send(res, 200, { ok: true, shell, shells: listShells() })
        }
        if (id && !part && req.method === 'DELETE') {
          closeShell(id)
          return send(res, 200, { ok: true, shells: listShells() })
        }
        if (part === 'out' && req.method === 'GET') return streamShell(id, url.searchParams.get('from'), req, res)
        if (part === 'in' && req.method === 'POST') {
          writeShell(id, (await readJsonBody(req))?.data)
          return send(res, 200, { ok: true })
        }
        if (part === 'resize' && req.method === 'POST') {
          const body = await readJsonBody(req)
          resizeShell(id, body?.rows, body?.cols)
          return send(res, 200, { ok: true })
        }
        return send(res, 405, { ok: false, error: 'Method not allowed' })
      } catch (err) {
        // A stopped container is a 409 with `stopped`: the page waits for the chat to run again.
        return send(res, err?.status || 400, { ok: false, error: String(err?.message || err), ...(err?.stopped ? { stopped: true } : {}) })
      }
    }

    // ── the catalogue and workspaces (docs/modules/workspaces.md) ──────────────────────
    if (url.pathname === '/api/catalogue' && req.method === 'GET') {
      return send(res, 200, { repos: await reposView() })
    }
    if (url.pathname === '/api/catalogue' && req.method === 'PUT') {
      const body = await readJsonBody(req)
      // The Environment: secrets into the store, a locked entry changed only with the owner's
      // password (environment.mjs). A body with no `env` — an older page, an import — keeps
      // what is saved.
      const repoId = idFor(String(body?.id || '').trim() || String(body?.name || '').trim() || nameFromUrl(body?.url))
      const existing = await repoById(repoId)
      if (Array.isArray(body?.env)) {
        try {
          body.env = await acceptEnv(repoId, body.env, existing?.env, {
            password: body.password,
            addr: req.socket?.remoteAddress || 'unknown',
          })
        } catch (err) {
          return send(res, err instanceof EnvRefusal ? err.status : 400, { ok: false, error: String(err?.message || err) })
        }
      } else if (existing) {
        body.env = existing.env
      }
      if (!Array.isArray(body?.dataSources) && existing) body.dataSources = existing.dataSources
      // The repo page no longer chooses tools; what a recipe had stays for its routines and
      // Jenkins-failure chats (workspaces.md).
      if (!Array.isArray(body?.tools) && existing) body.tools = existing.tools
      delete body.password
      // A custom push is the page's sentence and the steps its Test passed with — never
      // steps from the request, so what is saved is what was tested (custom-push.mjs).
      if (body?.push === 'custom') {
        try {
          body.pushCustom = customForSave(scopeFor(body), body.pushCustom?.sentence, existing?.pushCustom)
        } catch (err) {
          return send(res, 400, { ok: false, error: String(err?.message || err) })
        }
      } else if (body) {
        delete body.pushCustom
      }
      const entry = await saveRepo(body)
      // Chats on it get the new Environment and data paths in their `.env.local` now.
      await refreshEnvFor(entry.id).catch(() => {})
      return send(res, 200, { ok: true, repo: (await reposView()).find((r) => r.id === entry.id), repos: await reposView() })
    }
    if (url.pathname === '/api/catalogue' && req.method === 'DELETE') {
      const { id } = await readJsonBody(req)
      const gone = await repoById(String(id || ''))
      const removed = await deleteCatalogueRepo(String(id || ''))
      // Its secret variables leave the store with it: nothing lingers that no repo names.
      if (removed && gone) for (const e of gone.env || []) if (e.secret) await removeSecret(envSecretName(gone.id, e.name)).catch(() => {})
      return send(res, removed ? 200 : 404, { ok: removed, repos: await reposView() })
    }
    // A repo's datasets — what its `.outpost/data.json` declares — with where each comes from
    // here and each read copy's last sync (datasets.mjs).
    if (url.pathname === '/api/catalogue/datasets' && req.method === 'GET') {
      const repo = await repoById(String(url.searchParams.get('id') || ''))
      if (!repo) return send(res, 404, { ok: false, error: 'No such repo' })
      const manifest = await manifestOf(repo)
      if (!manifest.ok) return send(res, 200, manifest)
      return send(res, 200, { ok: true, datasets: manifest.datasets, sources: repo.dataSources || [], state: await readDatasetState(repo.id) })
    }
    if (url.pathname === '/api/catalogue/datasets/sync' && req.method === 'POST') {
      const { id, dataset } = await readJsonBody(req)
      const repo = await repoById(String(id || ''))
      if (!repo) return send(res, 404, { ok: false, error: 'No such repo' })
      try {
        const ds = await datasetNamed(repo, dataset, 'read')
        const r = await syncRead(repo, ds)
        return send(res, 200, { ok: true, ...r, summary: `${r.files} files, ${(r.bytes / 1e6).toFixed(0)} MB` })
      } catch (err) {
        return send(res, 200, { ok: false, error: String(err?.message || err) })
      }
    }
    if (url.pathname === '/api/catalogue/test' && req.method === 'POST') {
      const { url: remote, auth } = await readJsonBody(req)
      try {
        // Reached the way a chat's mirror would be (integrations.mjs `remoteFor`), and it says
        // which way, so "reachable" is never read as "reachable with the token" when it was not.
        const r = await remoteFor({ url: String(remote || ''), auth: String(auth || '') })
        const res2 = await testRemote(r.url, r.env)
        return send(res, 200, { ...res2, via: r.via })
      } catch (err) {
        return send(res, 200, { ok: false, error: String(err?.message || err) })
      }
    }

    // `/registerRepo <url>`: what a catalogue entry for it would hold, read off the repo and not
    // saved (workspaces.md). Slow on a first clone; a refusal is an answer, not a 500.
    if (url.pathname === '/api/catalogue/scan' && req.method === 'POST') {
      const { url: remote } = await readJsonBody(req)
      try {
        return send(res, 200, { ok: true, ...(await scanForRegister(String(remote || ''))) })
      } catch (err) {
        return send(res, 200, { ok: false, error: String(err?.message || err) })
      }
    }

    // `/rescanRepo <name>`: what reading a catalogued repo again would change in its entry, and
    // its Update, which saves only the ticked changes onto the entry as saved (workspaces.md).
    if (url.pathname === '/api/catalogue/rescan' && req.method === 'POST') {
      const { repo } = await readJsonBody(req)
      try {
        return send(res, 200, { ok: true, ...(await scanForRescan(String(repo || ''))) })
      } catch (err) {
        return send(res, 200, { ok: false, error: String(err?.message || err) })
      }
    }
    if (url.pathname === '/api/catalogue/rescan/apply' && req.method === 'POST') {
      const body = await readJsonBody(req)
      try {
        const before = await repoById(String(body?.id || ''))
        const next = await applyRescan(body?.id, body || {})
        // New names only, as secrets with no value: no locked entry changes, so no password.
        next.env = await acceptEnv(next.id, next.env, before?.env, { addr: req.socket?.remoteAddress || 'unknown' })
        const entry = await saveRepo(next)
        await refreshEnvFor(entry.id).catch(() => {})
        return send(res, 200, { ok: true, repo: entry.name, repos: await reposView() })
      } catch (err) {
        return send(res, 400, { ok: false, error: String(err?.message || err) })
      }
    }

    // The ports a repo probably serves on, to pre-fill the Ports editor (launchers.md). A
    // suggestion scanned from the mirror; `scanned: false` means there is no mirror yet.
    {
      const m = /^\/api\/catalogue\/([^/]+)\/detect-ports$/.exec(url.pathname)
      if (m && req.method === 'GET') {
        try {
          return send(res, 200, { ok: true, ...(await detectRepoPorts(decodeURIComponent(m[1]))) })
        } catch (err) {
          return send(res, 200, { ok: false, error: String(err?.message || err), ports: [] })
        }
      }
    }

    // ── secrets, environments and the instance's setup (docs/modules/setup.md) ──────────
    if (url.pathname === '/api/secrets' && req.method === 'GET') {
      return send(res, 200, { secrets: await listSecrets() })
    }
    if (url.pathname === '/api/secrets' && req.method === 'POST') {
      const { action, name, value } = await readJsonBody(req)
      try {
        const n = String(name || '').trim().toLowerCase()
        let secret
        if (action === 'generate') secret = await generateKey(n)
        else if (action === 'key') secret = await addKey(n, value)
        else if (action === 'token') secret = await addToken(n, value)
        else return send(res, 400, { ok: false, error: 'action is generate, key or token' })
        return send(res, 200, { ok: true, secret, secrets: await listSecrets() })
      } catch (err) {
        return send(res, 400, { ok: false, error: String(err?.message || err) })
      }
    }
    if (url.pathname === '/api/secrets' && req.method === 'DELETE') {
      const { name } = await readJsonBody(req)
      const removed = await removeSecret(String(name || ''))
      return send(res, removed ? 200 : 404, { ok: removed, secrets: await listSecrets() })
    }

    if (url.pathname === '/api/environments' && req.method === 'GET') {
      return send(res, 200, { environments: await listEnvironments() })
    }
    if (url.pathname === '/api/environments' && req.method === 'PUT') {
      try {
        const body = await readJsonBody(req)
        // A host names a key the store holds, or none: one naming anything else can never
        // connect, and the page once saved its own placeholder here as a key name (bugs-fixed.md).
        const key = String(body?.key || '').trim()
        if (key && !(await listSecrets()).some((s) => s.name === key && s.kind === 'ssh-key')) {
          return send(res, 400, { ok: false, error: `There is no access key named "${key}" — make one for the host, or choose one from the list` })
        }
        const env = await saveEnvironment(body)
        return send(res, 200, { ok: true, environment: env, environments: await listEnvironments() })
      } catch (err) {
        return send(res, 400, { ok: false, error: String(err?.message || err) })
      }
    }
    if (url.pathname === '/api/environments' && req.method === 'DELETE') {
      const { name } = await readJsonBody(req)
      const removed = await deleteEnvironment(String(name || ''))
      return send(res, removed ? 200 : 404, { ok: removed, environments: await listEnvironments() })
    }
    if (url.pathname === '/api/environments/test' && req.method === 'POST') {
      const { name } = await readJsonBody(req)
      return send(res, 200, await testEnvironment(String(name || '')))
    }
    if (url.pathname === '/api/environments/forget' && req.method === 'POST') {
      const { host } = await readJsonBody(req)
      await forgetHost(String(host || ''))
      return send(res, 200, { ok: true })
    }

    /**
     * The portable half of a setup: the catalogue and the settings, never the secret store.
     * Import replaces both whole, so a box set up from an export matches the one it came from
     * except for the secrets, which are re-entered by hand (setup.md).
     */
    if (url.pathname === '/api/setup/export' && req.method === 'GET') {
      return send(res, 200, {
        version: 1,
        exportedAt: Date.now(),
        catalogue: { repos: await listRepos() },
        settings: await readSettings(),
        routines: await exportRoutines(),
      })
    }
    if (url.pathname === '/api/setup/import' && req.method === 'POST') {
      const body = await readJsonBody(req)
      try {
        const repos = (Array.isArray(body?.catalogue?.repos) ? body.catalogue.repos : []).filter((r) => r && typeof r === 'object')
        const current = await listRepos()
        const byId = new Map(current.map((r) => [r.id, r]))
        // Each repo goes through what the repo page's save does, before anything is deleted: a
        // locked variable changed only with the owner's password, secret values into the store,
        // and a custom push keeps the steps its Test passed with here (`PUT /api/catalogue`).
        // Saved straight, an import was a way round both. The owner's own export changes no
        // locked entry (a secret exports blank, which is "unchanged") and needs no password; on a
        // fresh box there is nothing locked yet. A custom push this box never tested is kept as
        // the export has it — the catalogue cuts it to the shapes a Test can pass — since asking
        // for the Test again would make moving machines a chore per repo (setup.md).
        const staged = repos.map((r) => {
          const id = idFor(String(r.id || '').trim() || String(r.name || '').trim() || nameFromUrl(r.url))
          return { r: { ...r, id }, existing: byId.get(id) }
        })
        // Repos changing a locked entry first, so a refused password stops the import before any
        // other repo's secrets have moved. The gate itself is `acceptEnv`'s; this only orders.
        staged.sort((a, b) => Number(touchesLocked(b.r.env, b.existing?.env)) - Number(touchesLocked(a.r.env, a.existing?.env)))
        const addr = req.socket?.remoteAddress || 'unknown'
        try {
          for (const s of staged) s.r.env = await acceptEnv(s.r.id, Array.isArray(s.r.env) ? s.r.env : [], s.existing?.env, { password: body?.password, addr })
        } catch (err) {
          if (err instanceof EnvRefusal) return send(res, err.status, { ok: false, error: String(err.message) })
          throw err
        }
        for (const s of staged) {
          const was = s.existing?.pushCustom
          if (s.r.push === 'custom' && was?.steps?.length && was.sentence === String(s.r.pushCustom?.sentence || '').trim()) s.r.pushCustom = was
        }
        for (const r of current) await deleteCatalogueRepo(r.id)
        for (const s of staged) await saveRepo(s.r)
        if (body?.settings) await writeSettings(body.settings)
        // An export from before routines carries `schedules`, converted as the migration does.
        if (Array.isArray(body?.routines) || Array.isArray(body?.schedules)) await importRoutines({ routines: body.routines, schedules: body.schedules })
        // The settings may name a Claude credential this store has or lacks: the file sessions
        // read is rewritten to match, never left saying what the old settings said.
        await writeClaudeEnvFile()
        // What the import named that this machine does not have, so "add the secrets they
        // name" is a list rather than a hunt (machine.mjs).
        return send(res, 200, { ok: true, repos: await listRepos(), settings: await readSettings(), routines: await pageRoutines(), missing: await missingOnThisMachine() })
      } catch (err) {
        return send(res, 400, { ok: false, error: String(err?.message || err) })
      }
    }

    if (url.pathname === '/api/workspaces' && req.method === 'GET') {
      return send(res, 200, { workspaces: await listWorkspaces() })
    }
    /**
     * A new chat. The workspace is created at once and prepared on; the page watches the
     * roster for the session to appear and the manifest for the preparation to finish or
     * fail. The launcher is checked first, so nothing is cloned for a launch that was going
     * to fail regardless.
     */
    if (url.pathname === '/api/workspaces' && req.method === 'POST') {
      const launcher = await activeLauncher()
      if (!launcher.canLaunch) return send(res, 400, { ok: false, error: `The ${launcher.name} launcher cannot start sessions` })
      const spec = await readJsonBody(req)
      try {
        const m = await createWorkspace(spec, { permissionMode: DEFAULT_PERMISSION_MODE })
        noteRepoUse(m.repos.map((r) => r.id)).catch(() => {})
        return send(res, 200, { ok: true, workspace: m })
      } catch (err) {
        return send(res, 400, { ok: false, error: String(err?.message || err) })
      }
    }
    const wsMatch = /^\/api\/workspaces\/([a-f0-9]{8})(?:\/(log|push|finish|retry|repos|register|setup|ports|pin|held))?$/.exec(url.pathname)
    if (wsMatch) {
      const [, id, sub] = wsMatch
      if (sub === 'log' && req.method === 'GET') return send(res, 200, { log: await readLog(id) })
      // What a delete would lose, commit by commit and file by file (workspaces-git.md `heldWork`):
      // what Settings › Workspaces shows under each row before anyone presses Delete.
      if (sub === 'held' && req.method === 'GET') {
        const held = await heldWorkOf(id)
        return send(res, held.ok ? 200 : 404, held)
      }
      // Pin `{ pinned }`: a chat aging never archives or deletes (aging.md). On the workspace, not
      // the session, so it carries over a handoff's start-fresh, which keeps the workspace.
      if (sub === 'pin' && req.method === 'POST') {
        const { pinned } = await readJsonBody(req).catch(() => ({}))
        const m = await markWorkspace(id, { pinned: Boolean(pinned) })
        return m ? send(res, 200, { ok: true, pinned: Boolean(m.pinned) }) : send(res, 404, { ok: false, error: 'No such workspace' })
      }
      // Which published ports have something listening (launchers.md): a host-side connect per
      // port, what the Workspace panel dims a port until.
      if (sub === 'ports' && req.method === 'GET') return send(res, 200, { ports: await portStatus(id), address: lanAddress() })
      // Each repo's setup, its state and its log (workspaces.md): what the page's setup pill
      // opens; POST `{ repo? }` is Try again — one repo, or every one that failed.
      if (sub === 'setup' && req.method === 'GET') {
        try {
          return send(res, 200, await setupStatus(id))
        } catch (err) {
          return send(res, 404, { ok: false, error: String(err?.message || err) })
        }
      }
      if (sub === 'setup' && req.method === 'POST') {
        const { repo } = await readJsonBody(req).catch(() => ({}))
        try {
          return send(res, 200, await retrySetup(id, String(repo || '')))
        } catch (err) {
          return send(res, 409, { ok: false, error: String(err?.message || err) })
        }
      }
      // `/addRepo` from the message box (workspaces-git.md): the session is told, since it did not ask.
      if (sub === 'repos' && req.method === 'POST') {
        const { repo, said } = await readJsonBody(req)
        try {
          return send(res, 200, await addRepo(id, { repo: String(repo || ''), notify: true, said: String(said || '') }))
        } catch (err) {
          return send(res, 400, { ok: false, error: String(err?.message || err) })
        }
      }
      // `/registerRepo`'s Register (workspaces.md): the card's entry saved to the catalogue, then
      // added to this chat as `/addRepo` adds one. Only what the card showed is taken, and never
      // over an entry that is there already — a register never edits a repo.
      if (sub === 'register' && req.method === 'POST') {
        const { repo, said } = await readJsonBody(req)
        try {
          const r = repo && typeof repo === 'object' ? repo : {}
          const body = { name: r.name, url: r.url, baseBranch: r.baseBranch, auth: r.auth, setup: r.setup, ports: r.ports, packages: r.packages, ...(Array.isArray(r.jenkinsJobs) ? { jenkinsJobs: r.jenkinsJobs } : {}), ...(Array.isArray(r.tools) ? { tools: r.tools } : {}) }
          const repoId = idFor(String(body.name || '').trim() || nameFromUrl(body.url))
          await addableChat(id)
          if (await repoById(repoId)) return send(res, 409, { ok: false, error: `${repoId} is in Settings › Repos already — /addRepo ${repoId} adds it` })
          body.env = await acceptEnv(repoId, Array.isArray(r.env) ? r.env : [], [], { addr: req.socket?.remoteAddress || 'unknown' })
          const entry = await saveRepo(body)
          const added = await addRepo(id, { repo: entry.id, notify: true, said: String(said || '') })
          return send(res, 200, { ...added, repos: await reposView() })
        } catch (err) {
          return send(res, 400, { ok: false, error: String(err?.message || err) })
        }
      }
      if (sub === 'retry' && req.method === 'POST') {
        try {
          const result = await retryWorkspace(id)
          return send(res, result.ok ? 200 : 409, result)
        } catch (err) {
          return send(res, 400, { ok: false, error: String(err?.message || err) })
        }
      }
      if (sub === 'finish' && req.method === 'POST') {
        const { repo, mode } = await readJsonBody(req)
        try {
          const result = await finishWorkspaceRepo(id, String(repo || ''), mode === 'pr' ? 'pr' : 'push')
          return send(res, result.ok ? 200 : 409, result)
        } catch (err) {
          return send(res, 400, { ok: false, error: String(err?.message || err) })
        }
      }
      if (sub === 'push' && req.method === 'POST') {
        const { repo } = await readJsonBody(req)
        try {
          return send(res, 200, await pushWorkspaceRepo(id, String(repo || '')))
        } catch (err) {
          return send(res, 400, { ok: false, error: String(err?.message || err) })
        }
      }
      if (!sub && req.method === 'DELETE') {
        const { force } = await readJsonBody(req).catch(() => ({}))
        try {
          // End the session first, through the launcher, so the unit Outpost started is
          // stopped by the same code that would stop it for an archive.
          const result = await deleteWorkspace(id, { force: Boolean(force), endSession: endWorkspaceSessions })
          return send(res, result.ok ? 200 : 409, result)
        } catch (err) {
          return send(res, 400, { ok: false, error: String(err?.message || err) })
        }
      }
    }

    // ── search and integrations (docs/modules/integrations.md, integrations-ci.md) ──────
    if (url.pathname === '/api/search' && req.method === 'GET') {
      const q = url.searchParams.get('q') || ''
      const kinds = (url.searchParams.get('kinds') || '').split(',').filter(Boolean)
      const hits = q.trim() ? await search(q, { kinds, limit: Number(url.searchParams.get('limit')) || 20 }) : []
      return send(res, 200, { hits, stats: await indexStats() })
    }
    // What "push" means for a chat's work unless its repo says otherwise (workspaces-git.md).
    if (url.pathname === '/api/push-default' && req.method === 'GET') {
      return send(res, 200, { push: (await readSettings()).push })
    }
    // `{ mode, sentence? }`: `custom` is saved only with a sentence whose Test passed.
    if (url.pathname === '/api/push-default' && req.method === 'PUT') {
      const body = await readJsonBody(req)
      try {
        const custom = body?.mode === 'custom' ? customForSave(scopeFor(null), body.sentence, (await readSettings()).push.custom) : undefined
        return send(res, 200, { ok: true, push: await savePushDefault({ mode: body?.mode, custom }) })
      } catch (err) {
        return send(res, 400, { ok: false, error: String(err?.message || err) })
      }
    }
    /**
     * The custom push setting's Test, `{ sentence, repo? }` — `repo` the repo's form as it
     * stands, absent for the default. A short read-only run of the CLI reads the sentence
     * into steps, then each step is checked with real calls; nothing is pushed, opened or
     * built (workspaces-git.md). A pass is what lets that sentence be saved.
     */
    if (url.pathname === '/api/push-custom/test' && req.method === 'POST') {
      return send(res, 200, await testCustomPush(await readJsonBody(req)))
    }
    if (url.pathname === '/api/git-identity' && req.method === 'GET') {
      return send(res, 200, { settings: (await readSettings()).git, effective: await identityFor() })
    }
    if (url.pathname === '/api/git-identity' && req.method === 'PUT') {
      await saveGitIdentity(await readJsonBody(req))
      return send(res, 200, { ok: true, settings: (await readSettings()).git, effective: await identityFor() })
    }
    if (url.pathname === '/api/integrations' && req.method === 'GET') {
      return send(res, 200, { integrations: await allIntegrations() })
    }
    // Claude's sign-in has its own shape — a pasted credential whose kind is read off its
    // prefix — so it is its own route rather than one more `which` (claude-auth.mjs).
    if (url.pathname === '/api/integrations/claude' && req.method === 'PUT') {
      const body = await readJsonBody(req)
      try {
        await saveClaudeAuth({ token: body?.token, clear: body?.clear === true })
        return send(res, 200, { ok: true, integrations: await allIntegrations() })
      } catch (err) {
        return send(res, 400, { ok: false, error: String(err?.message || err) })
      }
    }
    // Sign in with Claude (claude-auth.mjs): `claude setup-token` on a hidden terminal — its link
    // answered here, the code it asks for posted back, the token it prints saved to the store and
    // never sent to the page.
    if (url.pathname === '/api/integrations/claude/signin' && req.method === 'POST') {
      return send(res, 200, await startClaudeSignIn())
    }
    if (url.pathname === '/api/integrations/claude/signin/code' && req.method === 'POST') {
      const r = await finishClaudeSignIn((await readJsonBody(req))?.code)
      return send(res, 200, r.ok ? { ok: true, integrations: await allIntegrations() } : r)
    }
    // What this machine has for chats and what it lacks (machine.mjs): About this machine.
    if (url.pathname === '/api/machine' && req.method === 'GET') {
      return send(res, 200, { ...(await machineChecks()), missing: await missingOnThisMachine() })
    }
    // One integration at a time, `{ which, url?, user?, token?, clear? }`: each section of the
    // page saves itself and takes its own token (integrations-ci.md). The whole-object PUT is
    // kept for anything that still sends the old shape.
    if (url.pathname === '/api/integrations' && req.method === 'PUT') {
      const body = await readJsonBody(req)
      if (body?.which) {
        try {
          await saveIntegration(String(body.which), body)
          return send(res, 200, { ok: true, integrations: await allIntegrations() })
        } catch (err) {
          return send(res, 400, { ok: false, error: String(err?.message || err) })
        }
      }
      // The old whole-object shape never carried Claude's sign-in: keep what is saved.
      await saveIntegrations({ ...body, claude: (await readSettings()).integrations.claude })
      return send(res, 200, { ok: true, integrations: await allIntegrations() })
    }
    // Jenkins's notify token, made here and answered this once (setup.md); no endpoint ever
    // reads it again.
    if (url.pathname === '/api/integrations/notify-token' && req.method === 'POST') {
      const made = await generateNotifyToken()
      return send(res, 200, { ok: true, ...made, integrations: await allIntegrations() })
    }
    // Every Jenkins job this login sees, each marked when a recent build of it checked out
    // `url` — a repo's page offers those as its suggestions (integrations-ci.md).
    if (url.pathname === '/api/jenkins/jobs' && req.method === 'GET') {
      try {
        return send(res, 200, { ok: true, jobs: await listJenkinsJobs(url.searchParams.get('url') || '') })
      } catch (err) {
        return send(res, 200, { ok: false, error: String(err?.message || err), jobs: [] })
      }
    }
    if (url.pathname === '/api/integrations/test' && req.method === 'POST') {
      const { which } = await readJsonBody(req)
      if (which === 'github') return send(res, 200, await testGithub())
      if (which === 'jenkins') return send(res, 200, await testJenkins())
      if (which === 'claude') return send(res, 200, await testClaude())
      return send(res, 400, { ok: false, error: 'which is github, jenkins or claude' })
    }

    // ── aging (docs/modules/aging.md) ───────────────────────────────────────────────────
    if (url.pathname === '/api/aging' && req.method === 'GET') {
      return send(res, 200, await agingStatus({ measure: url.searchParams.get('measure') !== '0' }))
    }
    if (url.pathname === '/api/aging' && req.method === 'PUT') {
      const aging = await saveAging(await readJsonBody(req))
      return send(res, 200, { ok: true, ...(await agingStatus({ measure: false })), settings: aging })
    }
    if (url.pathname === '/api/aging/run' && req.method === 'POST') {
      return send(res, 200, await agingTick({ reason: 'manual' }))
    }
    if (url.pathname === '/api/aging/log' && req.method === 'GET') {
      return send(res, 200, { lines: await readAgingLog() })
    }

    // ── the header's context thresholds (docs/modules/ui-conversation.md) ───────────────
    // Read by the page off the roster; this pair is Settings' own read and write.
    if (url.pathname === '/api/context-limits' && req.method === 'GET') {
      return send(res, 200, { ok: true, limits: (await readSettings()).context })
    }
    if (url.pathname === '/api/context-limits' && req.method === 'PUT') {
      return send(res, 200, { ok: true, limits: await saveContextLimits(await readJsonBody(req)) })
    }

    // ── the page's look (docs/modules/ui.md) ─────────────────────────────────────────────
    // Off the roster like the thresholds; this pair is Settings' own read and write.
    if (url.pathname === '/api/appearance' && req.method === 'GET') {
      return send(res, 200, { ok: true, appearance: await readAppearance() })
    }
    if (url.pathname === '/api/appearance' && req.method === 'PUT') {
      return send(res, 200, { ok: true, appearance: await saveAppearance(await readJsonBody(req)) })
    }

    // ── the container fence (docs/modules/launchers.md) ─────────────────────────────────
    // Each switch applies to chats started or restarted after it; `saveContainers` refuses
    // free Bash unless the mounts are narrow and the network private (config.mjs).
    if (url.pathname === '/api/containers' && req.method === 'GET') {
      return send(res, 200, { ok: true, containers: (await readSettings()).containers })
    }
    if (url.pathname === '/api/containers' && req.method === 'PUT') {
      const body = await readJsonBody(req)
      // The private network is tried before it is saved, and only when it is being turned on:
      // saved on a machine whose pasta cannot do it, every chat after it died at start.
      let refused = ''
      if (body?.network === 'private' && (await readSettings()).containers.network !== 'private') {
        const probe = await privateNetworkReady()
        if (!probe.ok) refused = probe.why
      }
      const containers = await saveContainers(refused ? { ...body, network: 'host' } : body)
      return send(res, 200, { ok: true, containers, ...(refused ? { refused } : {}) })
    }

    // ── routines (docs/modules/routines.md) ─────────────────────────────────────────────
    if (url.pathname === '/api/routines' && req.method === 'GET') {
      return send(res, 200, { routines: await pageRoutines() })
    }
    if (url.pathname === '/api/routines' && req.method === 'PUT') {
      try {
        const routine = await saveRoutine(await readJsonBody(req))
        return send(res, 200, { ok: true, routine, routines: await pageRoutines() })
      } catch (err) {
        return send(res, 400, { ok: false, error: String(err?.message || err) })
      }
    }
    if (url.pathname === '/api/routines' && req.method === 'DELETE') {
      const { id } = await readJsonBody(req)
      const removed = await deleteRoutine(String(id || ''))
      // `chats`: the defining chat deleted with it, or kept as a draft and why (routines.md).
      return send(res, removed ? 200 : 404, { ok: Boolean(removed), chats: removed ? removed.chats : [], routines: await pageRoutines() })
    }
    // A defining chat (routines.md, *Defining chats*): New routine with no body, Change… with
    // `{ routineId }`, which answers the chat that already defines it when there is one.
    if (url.pathname === '/api/routines/draft' && req.method === 'POST') {
      const launcher = await activeLauncher()
      if (!launcher.canLaunch) return send(res, 400, { ok: false, error: `The ${launcher.name} launcher cannot start sessions` })
      const { routineId } = await readJsonBody(req).catch(() => ({}))
      try {
        const made = await startDefining({ routineId: typeof routineId === 'string' ? routineId : '' })
        return send(res, 200, { ok: true, ...made })
      } catch (err) {
        return send(res, err?.status === 404 ? 404 : 400, { ok: false, error: String(err?.message || err) })
      }
    }
    if (url.pathname === '/api/routines/log' && req.method === 'GET') {
      return send(res, 200, { lines: await readRoutineLog() })
    }
    const runMatch = /^\/api\/routines\/([a-f0-9]{8})\/run$/.exec(url.pathname)
    if (runMatch && req.method === 'POST') {
      try {
        const body = await readJsonBody(req).catch(() => ({}))
        const run = await runNow(runMatch[1], { skipGate: body?.skipGate === true })
        return send(res, run.outcome === 'failed' ? 400 : 200, { ok: run.outcome !== 'failed', run, routines: await pageRoutines() })
      } catch (err) {
        return send(res, 400, { ok: false, error: String(err?.message || err) })
      }
    }
    // A call trigger's token, made here and answered this once (setup.md, routines-triggers.md);
    // no endpoint ever reads it again. Making another replaces it.
    const tokenMatch = /^\/api\/routines\/([a-f0-9]{8})\/triggers\/([^/]+)\/token$/.exec(url.pathname)
    if (tokenMatch && req.method === 'POST') {
      const name = decodeURIComponent(tokenMatch[2])
      const routine = (await listRoutines()).find((r) => r.id === tokenMatch[1])
      if (!routine?.triggers.some((t) => t.kind === 'call' && t.name === name)) return send(res, 404, { ok: false, error: 'That routine has no such call trigger; save it first' })
      const token = await makeCallToken(name)
      return send(res, 200, { ok: true, token, path: `/api/triggers/${name}`, routines: await pageRoutines() })
    }
    // Where a routine's boxes sit on its page (routines.md *Layouts*): `{ layout }` saves it,
    // `{ layout: null }` or a DELETE puts the automatic layout back. Its own file, so neither is
    // a save of the routine.
    const layoutMatch = /^\/api\/routines\/([a-f0-9]{8})\/layout$/.exec(url.pathname)
    if (layoutMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
      try {
        const body = req.method === 'PUT' ? await readJsonBody(req) : {}
        if (req.method === 'PUT' && !(body && typeof body === 'object' && 'layout' in body)) return send(res, 400, { ok: false, error: 'Send { layout }, or { layout: null } to reset it' })
        const layout = await saveLayout(layoutMatch[1], req.method === 'PUT' ? body.layout : null)
        return send(res, 200, { ok: true, layout })
      } catch (err) {
        return send(res, err?.status === 404 ? 404 : 400, { ok: false, error: String(err?.message || err) })
      }
    }
    const runsMatch = /^\/api\/routines\/([a-f0-9]{8})\/runs$/.exec(url.pathname)
    if (runsMatch && req.method === 'GET') {
      return send(res, 200, { runs: await runsOf(runsMatch[1]) })
    }
    const logMatch = /^\/api\/routines\/([a-f0-9]{8})\/runs\/([a-f0-9]{8})\/log$/.exec(url.pathname)
    if (logMatch && req.method === 'GET') {
      return send(res, 200, { events: await runLogOf(logMatch[1], logMatch[2]) })
    }

    if (url.pathname === '/api/harnesses' && req.method === 'GET') {
      return send(res, 200, { harnesses: await harnessStatus() })
    }

    /**
     * How much of the plan's limits are spent — what `/usage` prints in a session, read off
     * the chats' own streams in `usage.ts`. No token is involved.
     */
    if (url.pathname === '/api/usage' && req.method === 'GET') {
      return send(res, 200, await readUsage())
    }

    /** The machine's CPU, memory and workspace-disk use, for the line under the chat list. */
    if (url.pathname === '/api/system' && req.method === 'GET') {
      return send(res, 200, await readSystem())
    }

    /** The same, per core and per disk, with Outpost's own folders: the window behind the line's arrow. */
    if (url.pathname === '/api/system/detail' && req.method === 'GET') {
      return send(res, 200, await readSystemDetail())
    }

    if (url.pathname === '/api/launcher' && req.method === 'GET') {
      const launcher = await activeLauncher()
      return send(res, 200, {
        id: launcher.id,
        name: launcher.name,
        canSend: launcher.canSend,
        canLaunch: launcher.canLaunch,
        canKill: launcher.canKill,
      })
    }

    /**
     * The conversation behind a thread. POST rather than GET because `ref` is an object the
     * page hands back opaquely, and it is easier to carry intact in a body than a query.
     * `after` is the offset the previous answer returned; the page tails with it. `before` is
     * a `start` it was given, and reads the page above it; `bytes` sizes a first load or a page.
     */
    if (url.pathname === '/api/transcript' && req.method === 'POST') {
      const { harness, ref, after, before, bytes } = await readJsonBody(req)
      const back = Number(before) > 0
      const result = await readTranscript(harness, ref, { after: Number(after) || 0, before: Number(before) || 0, bytes: Number(bytes) || 0 })
      // A chat being opened: its checkout is read afresh on the next roster (workspaces.md *Status*).
      if (!Number(after) && !back && !ref?.agentId) await forgetStatusForSession(sessionIdOf(harness, ref)).catch(() => {})
      // A transcript gone under a session that has answered was lost, not yet to be written: the
      // conversation is drawn from the session's own streams instead (launchers.md), one page
      // with nothing above it. Never before the first answer, or a chat whose transcript has not
      // appeared yet would be tailed on the stream's offsets and then read on the transcript's.
      if (result.ok && result.missing && !back && !ref?.agentId) {
        const launcher = await activeLauncher()
        const stream = await launcher.streamRecords?.({ harness, ref }, Number(after) || 0).catch(() => null)
        const messages = stream?.answered ? messagesOf(harness, stream.records) : null
        if (messages) Object.assign(result, { messages, offset: stream.offset, start: 0, size: stream.offset, missing: false, fromStream: true })
      }
      // The answer being written right now, for a structured session: the transcript has it
      // only once it is whole, the stream has it a token at a time. Not for a page of history.
      if (result.ok && !back) {
        const launcher = await activeLauncher()
        const partial = await launcher.partialText?.({ harness, ref }).catch(() => '')
        if (partial) result.partial = partial
      }
      return send(res, result.ok ? 200 : 400, result)
    }

    /**
     * One image out of a thread's conversation, as the bytes themselves. `id` is the image
     * item's id from `/api/transcript`. The type is one of four the harness allows and is
     * not to be sniffed past: what comes back is whatever somebody once attached.
     */
    if (url.pathname === '/api/image' && req.method === 'POST') {
      const { harness, ref, id } = await readJsonBody(req)
      const result = await readImage(harness, ref, id)
      if (!result.ok) return send(res, 404, result)
      res.writeHead(200, {
        'Content-Type': result.type,
        'Content-Length': result.bytes.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      return res.end(result.bytes)
    }

    /**
     * What a thread has spent in tokens, what of it the harness caused, and the fixed overhead
     * every session carries (usage.md, `tokens.ts`). Read off disk; nothing is asked of Anthropic.
     */
    if (url.pathname === '/api/tokens' && req.method === 'POST') {
      const { harness, ref, earlier } = await readJsonBody(req)
      const result = await chatTokens(harness, ref)
      // A chat started fresh has spent across every conversation it has had: `earlier` is the
      // roster's (handoff.md), handed back as it came, and `lifetime` sums them with this one.
      const before = Array.isArray(earlier) ? earlier.slice(0, 50).filter((e) => e && typeof e.harness === 'string') : []
      const lifetime = before.length && result.ok ? sumChatTokens([result, ...(await Promise.all(before.map((e) => chatTokens(e.harness, e.ref))))]) : null
      return send(res, result.ok ? 200 : 400, { ...result, overhead: fixedOverhead().always, ...(lifetime ? { lifetime } : {}) })
    }

    /** The subagents behind a thread, for the agent map (harnesses.md `readAgents`). */
    if (url.pathname === '/api/agents' && req.method === 'POST') {
      const { harness, ref } = await readJsonBody(req)
      const result = await readAgents(harness, ref)
      return send(res, result.ok ? 200 : 400, result)
    }

    /** The commands a thread sent to the background, for the commands map (harnesses.md `readCommands`). */
    if (url.pathname === '/api/commands' && req.method === 'POST') {
      const { harness, ref } = await readJsonBody(req)
      const result = await readCommands(harness, ref)
      return send(res, result.ok ? 200 : 400, result)
    }

    /**
     * The files a chat wrote or pointed the person at (harnesses.md `readFiles`), each as it
     * stands on disk in its workspace (workspaces.md *Files*). The thread is resolved here so
     * the cwd that places a relative path, and the workspace that bounds the disk read, are the
     * server's and never the page's.
     */
    if (url.pathname === '/api/files' && req.method === 'POST') {
      const { harness, ref } = await readJsonBody(req)
      const thread = await threadFor(harness, ref)
      if (!thread) return send(res, 404, { ok: false, error: 'No such chat' })
      const result = await readFiles(harness, ref, { cwd: thread.cwd || '' })
      if (!result.ok) return send(res, 400, result)
      const ws = await workspaceFor(thread.cwd)
      return send(res, 200, { ...result, files: ws ? await placeFiles(ws, result.files, thread.cwd || '') : [] })
    }

    /** One of those files: from disk, bounded to the workspace, or the version a Write made (harnesses.md `readFileVersion`). */
    if (url.pathname === '/api/file' && req.method === 'POST') {
      const { status, result } = await readFileText(await readJsonBody(req))
      return send(res, status, result)
    }

    /**
     * An HTML file for the viewer's preview: read exactly as `/api/file` reads it, wrapped with
     * its policy and listener, and kept under a ticket for `GET /api/preview/<ticket>` (outside
     * the gate, since a frame's src cannot carry the header; server/lib/preview.mjs).
     */
    if (url.pathname === '/api/file/preview' && req.method === 'POST') {
      const { status, result } = await readFileText(await readJsonBody(req))
      if (status !== 200) return send(res, status, result)
      if (result.missing) return send(res, 404, { ok: false, missing: true, error: 'That file is not there now' })
      if (result.binary) return send(res, 400, { ok: false, error: 'Not text' })
      const ticket = previews.mint(result.text || '')
      return send(res, 200, { ok: true, url: `/api/preview/${ticket}`, size: result.size, truncated: Boolean(result.truncated) })
    }

    /**
     * One of those files as its bytes, for what the viewer cannot draw from text — an image, a PDF,
     * a download — since an `<img>` or `<iframe>` src cannot carry the bearer header (workspaces.md
     * *Files*). Bounded as `/api/file` is; refused whole over `BIN_BYTES`, or `DOWNLOAD_BYTES`
     * with `download`. The type is the extension's, never sniffed.
     */
    if (url.pathname === '/api/file/bytes' && req.method === 'POST') {
      const { harness, ref, path: p, root, download } = await readJsonBody(req)
      if (root !== undefined && root !== 'workspace' && root !== 'tmp') return send(res, 400, { ok: false, error: 'Read from the workspace or the container /tmp' })
      const thread = await threadFor(harness, ref)
      const ws = thread ? await workspaceFor(thread.cwd) : null
      if (!ws) return send(res, 404, { ok: false, error: 'No such chat' })
      const maxBytes = download === true ? DOWNLOAD_BYTES : BIN_BYTES
      let result
      if (root === 'tmp') {
        const { at } = await chatContainerRoot(ws)
        result = at ? await readTmpBytes(at, p, { maxBytes }) : { ok: true, missing: true }
      } else result = await readWorkspaceBytes(ws, String(p || ''), { cwd: thread.cwd || '', maxBytes })
      if (result.ok && result.missing) return send(res, 404, { ok: false, missing: true, error: 'That file is not there now' })
      if (!result.ok) return send(res, result.tooBig ? 413 : 400, result)
      res.writeHead(200, {
        'Content-Type': result.type,
        'Content-Length': result.bytes.length,
        'Last-Modified': new Date(result.modifiedAt).toUTCString(),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      return res.end(result.bytes)
    }

    /**
     * One folder of what the chat's container sees, for the Browse tree (workspaces.md *Files*):
     * `root` `workspace` (the default; `path` '' is the workspace folder) or `tmp`, the
     * container's own /tmp, which is `absent` while no container runs — never an error.
     */
    if (url.pathname === '/api/dir' && req.method === 'POST') {
      const { harness, ref, root = 'workspace', path: p } = await readJsonBody(req)
      if (root !== 'workspace' && root !== 'tmp') return send(res, 400, { ok: false, error: 'Browse the workspace or the container /tmp' })
      const thread = await threadFor(harness, ref)
      const ws = thread ? await workspaceFor(thread.cwd) : null
      if (!ws) return send(res, 404, { ok: false, error: 'No such chat' })
      if (root === 'tmp') {
        // `since` is the container's start time, so the page can tell a later container from this one.
        const { at, since } = await chatContainerRoot(ws)
        const result = at ? await listTmpDir(at, p ?? '/tmp') : { ok: true, absent: true }
        return send(res, result.ok ? 200 : 400, { ...result, since })
      }
      const result = await listWorkspaceDir(ws, p ?? '')
      return send(res, result.ok ? 200 : 400, result)
    }

    /** The workspace's files whose path holds `q`, for the Files filter (workspaces.md *Files*). */
    if (url.pathname === '/api/find' && req.method === 'POST') {
      const { harness, ref, q } = await readJsonBody(req)
      const thread = await threadFor(harness, ref)
      const ws = thread ? await workspaceFor(thread.cwd) : null
      if (!ws) return send(res, 404, { ok: false, error: 'No such chat' })
      const result = await findInWorkspace(ws, typeof q === 'string' ? q : '')
      return send(res, result.ok ? 200 : 400, result)
    }

    /** The end of one background command's output (launchers.md *Reading a background command*). */
    if (url.pathname === '/api/task/output' && req.method === 'POST') {
      const { harness, ref, taskId, file } = await readJsonBody(req)
      const sessionId = sessionIdOf(harness, ref)
      if (!sessionId) return send(res, 404, { ok: false, error: 'Which command?' })
      const result = await readTaskOutput(sessionId, taskId, file)
      return send(res, result.ok ? 200 : 400, result)
    }

    if (url.pathname === '/api/send' && req.method === 'POST') {
      const { harness, ref, text: typed, files, command } = await readJsonBody(req)
      // An Outpost command (`/createRoutine`) is the typed words with its doc beside them (outpost-commands.mjs);
      // `/securityAudit` copies its skill into the chat's workspace first, so it needs one.
      let workspaceDir = ''
      if (command && commandNeedsWorkspace(String(command))) {
        const thread = await threadFor(harness, ref)
        const ws = thread ? await workspaceFor(thread.cwd) : null
        if (!ws) return send(res, 400, { ok: false, error: `Only a workspace chat can take /${command}` })
        workspaceDir = workspaceDirOf(ws)
      }
      const text = command ? await outpostCommandText(String(command), typed, { workspaceDir }) : typed
      if (text === null) return send(res, 400, { ok: false, error: `No Outpost command "${command}"` })
      const launcher = await activeLauncher()
      if (!launcher.canSend) {
        return send(res, 400, { ok: false, error: `The ${launcher.name} launcher cannot send prompts` })
      }
      // Attachments are paths the page got back from /api/upload, and only those: the page
      // must never be able to name an arbitrary file on this machine for a session to read.
      const wanted = Array.isArray(files) ? files.map(String) : []
      const ok = []
      for (const p of wanted) {
        const abs = path.resolve(p)
        if (!abs.startsWith(UPLOAD_DIR + path.sep)) return send(res, 400, { ok: false, error: 'Attachments must come from /api/upload' })
        if (!(await fsp.stat(abs).catch(() => null))?.isFile()) return send(res, 400, { ok: false, error: 'An attachment is missing on disk' })
        ok.push(abs)
      }
      // A chat's first message carries the setup note held for it (workspaces.md).
      const msg = await personMessage(sessionIdOf(harness, ref), text)
      // `resume`: a chat whose session aging ended is brought back by the message (launchers.md).
      const result = await launcher.sendPrompt({ harness, ref }, text, { files: ok, lead: msg?.lead || '', resume: true })
      if (result.ok && msg) await msg.commit().catch(() => {})
      // The person is back: an away mark on this chat is taken down (handoff.md).
      if (result.ok) await clearAway(sessionIdOf(harness, ref)).catch(() => {})
      return send(res, result.ok ? 200 : 400, result)
    }

    /**
     * Save a file (an image, a PDF or text) the page wants to attach to a prompt, and hand back the path to put in
     * it. Base64 in JSON rather than multipart: one body reader, one gate, and the limit is
     * the decoded size plus base64's third.
     */
    if (url.pathname === '/api/upload' && req.method === 'POST') {
      const { folder, name, type, data } = await readJsonBody(req, UPLOAD_BODY_LIMIT)
      const result = await saveUpload(UPLOAD_DIR, { folder, name, type, data })
      return send(res, result.ok ? 200 : 400, result)
    }

    /** What a session is asking through the approval tool — the exact command and the real options. */
    if (url.pathname === '/api/prompt' && req.method === 'POST') {
      const { harness, ref } = await readJsonBody(req)
      const launcher = await activeLauncher()
      return send(res, 200, await launcher.describePrompt({ harness, ref }))
    }

    /**
     * Answer what a session is asking: allow / always / deny. The launcher refuses when no
     * request is being held for that session (launchers.md) — a click on a bar that has gone
     * stale answers nothing.
     */
    if (url.pathname === '/api/respond' && req.method === 'POST') {
      const { harness, ref, answer, option, expect, id } = await readJsonBody(req)
      // Two kinds of answer. `answer` is the verb for a permission dialog; `option` is a row
      // number off a question the session asked, carrying the label the page showed so the
      // launcher can refuse if the session has moved on to a different question since.
      if (option === undefined && !['allow', 'always', 'deny'].includes(answer)) {
        return send(res, 400, { ok: false, error: 'answer must be allow, always or deny, or option must be a row number' })
      }
      if (option !== undefined && !/^\d{1,2}$/.test(String(option))) {
        return send(res, 400, { ok: false, error: 'option must be a row number' })
      }
      const launcher = await activeLauncher()
      // `id` is the request the page drew; the launcher refuses when another has taken its
      // place at the head of the queue since.
      const result = await launcher.answerPrompt({ harness, ref }, answer, { option, expect, id: typeof id === 'string' ? id : '' })
      // A deny puts the session back at its prompt and no hook will say so. Picking an option
      // does not: the session carries straight on and its own hooks report that. Nor does a
      // deny with more requests standing behind it: the session is still waiting on those.
      if (result.ok && option === undefined && answer === 'deny' && !result.more) await noteIdle(harness, ref)
      return send(res, result.ok ? 200 : 400, result)
    }

    /**
     * Stop the current turn: an interrupt on the session's stream, as blunt as Escape in a
     * terminal. It ends the turn and a foreground agent or command with it, and nothing in the
     * background, so `all` also stops every subagent and background command the hook store lists
     * (launchers.md *Interrupting*). The turn goes first: it is what the person pressed for.
     */
    if (url.pathname === '/api/interrupt' && req.method === 'POST') {
      const { harness, ref, all } = await readJsonBody(req)
      const launcher = await activeLauncher()
      const result = await launcher.interrupt({ harness, ref })
      if (!result.ok) return send(res, 400, result)
      let agents = 0
      let commands = 0
      const sessionId = all ? sessionIdOf(harness, ref) : ''
      if (sessionId) {
        const rec = (await hookStates()).get(sessionId)
        for (const a of rec?.subagents || []) {
          if (!a.id) continue
          if ((await launcher.stopTask({ harness, ref }, a.id)).ok) agents++
          await dropSubagent(sessionId, a.id)
        }
        for (const t of rec?.backgroundTasks || []) {
          if ((await stopBackgroundTask(sessionId, t.id)).ok) commands++
          await dropBackgroundTask(sessionId, t.id)
        }
      }
      await noteIdle(harness, ref)
      return send(res, 200, { ...result, agents, commands })
    }

    /**
     * Stop one command the session left running in the background (launchers.md). Only a task
     * the hook store lists for this session is looked for; nothing is typed at the session, and
     * the CLI wakes it to say the command ended.
     */
    if (url.pathname === '/api/task/stop' && req.method === 'POST') {
      const { harness, ref, taskId } = await readJsonBody(req)
      const sessionId = sessionIdOf(harness, ref)
      const listed = (await hookStates()).get(sessionId)?.backgroundTasks || []
      if (!sessionId || !listed.some((t) => t.id === taskId)) return send(res, 404, { ok: false, error: 'That command is not running.' })
      const result = await stopBackgroundTask(sessionId, taskId)
      // Gone either way: stopped now, or found not running, which the next `Stop` would say too.
      await dropBackgroundTask(sessionId, taskId)
      return send(res, result.ok ? 200 : 404, result)
    }

    /**
     * You have read a finished thread: `done` back to `idle`, so its ✓ clears.
     *
     * The badge had no other exit. A `done` set by `Stop` stands until that session takes
     * another turn or goes dormant three days later (`STALE_MS` in src/state/threads.js), so every thread
     * that finished this week was still wearing a ✓ — and a badge every thread earns by
     * finishing distinguishes nothing.
     *
     * The session itself is not touched; nothing is typed at it and no launcher is involved.
     * Only Outpost's record of it moves, through the same `markIdle` a deny or an interrupt
     * already uses.
     */
    /**
     * Name a chat. Outpost's own record, keyed by thread id, so it works for every chat and
     * nothing is typed at the session; an empty name clears it and the automatic one comes
     * back (chats.md).
     */
    if (url.pathname === '/api/title' && req.method === 'POST') {
      const { id, name } = await readJsonBody(req)
      if (!id || typeof id !== 'string') return send(res, 400, { ok: false, error: 'Which chat?' })
      return send(res, 200, await setName(id, String(name ?? '')))
    }

    if (url.pathname === '/api/ack' && req.method === 'POST') {
      const { harness, ref } = await readJsonBody(req)
      const rec = await noteIdle(harness, ref)
      // No hook record means nothing set the ✓ in the first place. Saying so beats a cheerful
      // 200 for a call that changed nothing.
      return send(res, rec ? 200 : 404, rec ? { ok: true } : { ok: false, error: 'No live state to clear for this session' })
    }

    /**
     * Send a stalled session on again, now. The button behind the countdown, and the only way
     * past an exhausted budget — which is the point of the budget: five automatic attempts,
     * then a person decides whether a sixth is sensible.
     *
     * It refuses for the same reasons the supervisor's own attempt does (not running, working,
     * asking you something), because those refuse a click just as hard as a timer
     * (resilience.md).
     */
    if (url.pathname === '/api/restart' && req.method === 'POST') {
      const { harness, ref } = await readJsonBody(req)
      const sessionId = sessionIdOf(harness, ref)
      if (!sessionId) return send(res, 400, { ok: false, error: 'That thread reports no live session' })
      const result = await restartNow(sessionId)
      return send(res, result.ok ? 200 : 400, result)
    }

    /** Forget a session's retry budget, so the next stall gets a fresh five. */
    if (url.pathname === '/api/restart' && req.method === 'DELETE') {
      const { harness, ref } = await readJsonBody(req)
      const sessionId = sessionIdOf(harness, ref)
      if (!sessionId) return send(res, 400, { ok: false, error: 'That thread reports no live session' })
      return send(res, 200, { ok: await clearRetry(sessionId) })
    }

    /**
     * Hand off: ask the session to commit its work and write the handoff a fresh conversation
     * starts from — or, where its cache is cold, a limit stopped it or it is not running, write
     * one without it in the background (handoff.md); `without: true` is the person choosing that
     * where the session could have been asked. A refusal with its reason is a 409 — busy,
     * waiting on the person, already asked — so the page says why rather than failing.
     */
    if (url.pathname === '/api/handoff' && req.method === 'POST') {
      const { harness, ref, without } = await readJsonBody(req)
      const thread = await threadFor(harness, ref)
      if (!thread) return send(res, 400, { ok: false, error: 'That chat is not one Outpost is running' })
      const result = await handOff(thread, 'button', { without: without === true })
      return send(res, result.ok ? 200 : 409, result)
    }

    /**
     * Cancel a handoff being written (handoff.md `cancelHandoff`): the summary run is stopped,
     * or the request forgotten and the turn writing it interrupted — the turn only, as Esc's
     * Stop is; agents and background commands are left as they are.
     */
    if (url.pathname === '/api/handoff/cancel' && req.method === 'POST') {
      const { harness, ref } = await readJsonBody(req)
      const thread = await threadFor(harness, ref)
      if (!thread) return send(res, 400, { ok: false, error: 'That chat is not one Outpost is running' })
      const result = await cancelHandoff(thread)
      if (!result.ok) return send(res, 409, result)
      if (result.interrupt) {
        const launcher = await activeLauncher()
        const stopped = await launcher.interrupt({ harness, ref })
        if (stopped.ok) await noteIdle(harness, ref)
        return send(res, 200, { ok: true, interrupted: Boolean(stopped.ok), ...(stopped.ok ? {} : { error: stopped.error }) })
      }
      return send(res, 200, { ok: true })
    }

    /** Set a ready handoff aside: still offered in its block, no longer in Needs you (handoff.md). */
    if (url.pathname === '/api/handoff/dismiss' && req.method === 'POST') {
      const { harness, ref } = await readJsonBody(req)
      const thread = await threadFor(harness, ref)
      if (!thread) return send(res, 400, { ok: false, error: 'That chat is not one Outpost is running' })
      const result = await dismissHandoff(thread)
      return send(res, result.ok ? 200 : 409, result)
    }

    /**
     * Start fresh: a new conversation in the same chat, its first message the kept handoff
     * (handoff.md). A stale or fallback handoff answers 409 with `confirm: true` until the page
     * sends `confirmed` — the person has read what they are starting from.
     */
    if (url.pathname === '/api/handoff/fresh' && req.method === 'POST') {
      const { harness, ref, confirmed } = await readJsonBody(req)
      const thread = await threadFor(harness, ref)
      if (!thread) return send(res, 400, { ok: false, error: 'That chat is not one Outpost is running' })
      const result = await startFresh(thread, { confirmed: confirmed === true })
      return send(res, result.ok ? 200 : 409, result)
    }

    /**
     * `/away`, caught by the page and never sent to the session (handoff.md): one chat by
     * `{ harness, ref }`, or every chat with a running session with `{ all: true }`. Answers
     * what happened to each — asked, marked to be asked when its turn ends, or left and why.
     */
    if (url.pathname === '/api/away' && req.method === 'POST') {
      const { harness, ref, all, back: isBack } = await readJsonBody(req)
      // `back: true` undoes it: the marks not yet acted on are taken down, one chat's or all.
      if (isBack === true) return send(res, 200, await back({ sessionId: harness ? sessionIdOf(harness, ref) : '', all: all === true }))
      const result = all === true ? await away({ all: true }) : await away({ sessionId: harness ? sessionIdOf(harness, ref) : '' })
      return send(res, result.ok ? 200 : 400, result)
    }

    /** The chat's kept handoff, text and all, for the card; `handoff: null` when there is none to offer. */
    if (url.pathname === '/api/handoff/text' && req.method === 'POST') {
      const { harness, ref } = await readJsonBody(req)
      const thread = await threadFor(harness, ref)
      if (!thread?.workspace?.id) return send(res, 400, { ok: false, error: 'That chat has no workspace' })
      return send(res, 200, { ok: true, handoff: await handoffOf(thread.workspace.id) })
    }

    /**
     * Change the password from the page (auth.md). Inside the credential gate — it takes a
     * live session or the token — and it asks for the current password too, so a tab left
     * logged in is not enough to take the account: checked like a login, at full scrypt cost,
     * counted against the same per-address limit, wrong answered the way login answers it.
     * The new password logs every device out, as `yarn passwd` does; this one is handed a
     * fresh session in the answer so the person changing it stays logged in.
     */
    if (url.pathname === '/api/account/password' && req.method === 'POST') {
      if (!hasCredentials()) return send(res, 400, { ok: false, error: 'No password is set on this server' })
      const addr = req.socket?.remoteAddress || 'unknown'
      const gate = loginAllowed(addr)
      if (!gate.ok) {
        const mins = Math.ceil(gate.retryAfterMs / 60000)
        return send(res, 429, { ok: false, error: `Too many attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` })
      }
      const { current, password } = await readJsonBody(req)
      const user = configuredUser()
      // 403 rather than 401: a wrong current password is not a lapsed session, and a 401
      // would send the page to its login form.
      // Counted before the check, as login is: parallel guesses must not all pass the gate.
      noteFailedLogin(addr)
      if (!(await verifyLoginAsync(user, String(current ?? '')))) {
        return send(res, 403, { ok: false, error: 'That is not the current password' })
      }
      clearFailedLogins(addr)
      const next = String(password ?? '')
      if (next.length < 8) return send(res, 400, { ok: false, error: 'Use at least eight characters' })
      await setPassword(user, next)
      const token = await createSession(String(req.headers['user-agent'] || '').slice(0, 120))
      return send(res, 200, { ok: true, token, user, sessionDays: sessionDays() })
    }

    /**
     * Where a stall goes when nobody is looking at the page.
     *
     * The GET never returns the webhook URL — only whether one is set and the last six
     * characters, enough to tell two apart. Anyone on the LAN who can open the dashboard can
     * call this, and a webhook URL is a credential: holding it means posting into that
     * channel as you. So it goes in and never comes back out (resilience.md).
     */
    if (url.pathname === '/api/notify' && req.method === 'GET') {
      return send(res, 200, await notifySettings())
    }

    if (url.pathname === '/api/notify' && req.method === 'PUT') {
      const { discordWebhook, onRestart } = await readJsonBody(req)
      const result = await saveNotifySettings({ discordWebhook, onRestart })
      return send(res, result.ok ? 200 : 400, result)
    }

    if (url.pathname === '/api/notify/test' && req.method === 'POST') {
      const result = await testNotify()
      return send(res, result.ok ? 200 : 400, result)
    }

    /**
     * The models a chat can run on: the CLI's stable aliases (launchers.md). No session
     * needed. Which model a thread is on comes from its transcript (harnesses.md); this only
     * answers what it could be moved to.
     */
    if (url.pathname === '/api/models' && (req.method === 'POST' || req.method === 'GET')) {
      const launcher = await activeLauncher()
      return send(res, 200, await launcher.readModels())
    }
    if (url.pathname === '/api/model' && req.method === 'POST') {
      const { harness, ref, model } = await readJsonBody(req)
      if (!model || typeof model !== 'string') return send(res, 400, { ok: false, error: 'model is required' })
      const launcher = await activeLauncher()
      const result = await launcher.setModel({ harness, ref }, model)
      return send(res, result.ok ? 200 : 400, result)
    }

    /**
     * The same pair again for effort. The levels are the CLI's own five words, the top one
     * withheld from Haiku, and setting one is a restart in place rather than a message, since
     * the stream refuses `set_effort` (launchers.md).
     */
    if (url.pathname === '/api/efforts' && req.method === 'POST') {
      const { harness, ref } = await readJsonBody(req)
      const launcher = await activeLauncher()
      const result = await launcher.readEfforts({ harness, ref })
      return send(res, result.ok ? 200 : 400, result)
    }
    if (url.pathname === '/api/effort' && req.method === 'POST') {
      const { harness, ref, effort } = await readJsonBody(req)
      if (!effort || typeof effort !== 'string') return send(res, 400, { ok: false, error: 'effort is required' })
      const launcher = await activeLauncher()
      const result = await launcher.setEffort({ harness, ref }, effort)
      return send(res, result.ok ? 200 : 400, result)
    }

    /**
     * Free up a session's context: compact summarises it, as `/compact` sent as a message
     * (launchers.md).
     *
     * The action is matched against a fixed list rather than turned into a command, because
     * this endpoint is otherwise "type anything you like into a session as a slash command"
     * for anyone who can reach the dashboard. `/api/send` is the endpoint for arbitrary text
     * and is deliberately the only one. There was a `clear` beside it; it started a new
     * session under a new id, which is a new chat, and went (api.md).
     *
     * The answer does not move the hook store. Compact keeps the session and reports its own
     * progress; guessing at it here is what hooks.md forbids.
     */
    if (url.pathname === '/api/context' && req.method === 'POST') {
      const { harness, ref, action } = await readJsonBody(req)
      const command = { compact: '/compact' }[String(action || '')]
      if (!command) return send(res, 400, { ok: false, error: 'action must be compact' })
      const launcher = await activeLauncher()
      const result = await launcher.runCommand({ harness, ref }, command)
      return send(res, result.ok ? 200 : 400, { ...result, action })
    }

    /**
     * Resume: a session whose unit is gone — a reboot, a crash — started again where it left
     * off. Refused while the unit is still running.
     */
    if (url.pathname === '/api/resume' && req.method === 'POST') {
      const { harness, ref } = await readJsonBody(req)
      const launcher = await activeLauncher()
      const result = await launcher.resume({ harness, ref })
      return send(res, result.ok ? 200 : 400, result)
    }

    /**
     * Archive: take the chat off the list, and end the session behind it.
     *
     * Archiving used to hide and nothing else, which meant a tidy list and a pile of live
     * sessions sitting at their prompts with no way left to see them. So the kill happens
     * here, first — before the flag, because it is the half that can fail and its answer is
     * worth having in the response.
     *
     * The archive itself never fails on the kill. The flag is the page's intent about its own
     * list, re-asserted on every scan, and a thread you have asked to be rid of should not
     * come back because its unit would not stop. `ended` carries what actually happened and
     * the page says it out loud.
     *
     * `chats: [{ id, harness, ref }]` archives several in one call — the list's bulk archive
     * (chats.md) — with one write to the list and an answer per chat in `results`.
     */
    if (url.pathname === '/api/archive' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const bulk = Array.isArray(body.chats)
      const chats = bulk ? body.chats : [body]
      const archived = bulk ? true : Boolean(body.archived)
      if (!chats.length || chats.some((c) => !c?.id)) return send(res, 400, { ok: false, error: 'Missing thread id' })
      // A pinned chat is archived only once unpinned; the page disables its Archive, and this
      // holds for another page or a stale roster. Checked before any kill, so nothing is half done.
      if (archived) {
        const ids = new Set(chats.map((c) => c.id))
        const pinned = (await roster()).threads.filter((t) => ids.has(t.id) && t.workspace?.pinned)
        if (pinned.length) return send(res, 409, { ok: false, error: `${pinned.length === 1 ? 'That chat is' : `${pinned.length} of those chats are`} pinned — unpin to archive` })
      }

      // Two cases. A session whose unit is running is the ordinary one: stop it and hand back
      // the answer. A session with no unit running has nothing to end — `ended: null`, because
      // an `ok: false` there would print "could not end that session" over an archive that had
      // nothing to end. The launcher asks systemd rather than trusting the request: `ref`
      // comes off a roster that is up to one scan old.
      const launcher = archived ? await activeLauncher() : null
      const ended = await Promise.all(
        chats.map(async ({ harness, ref }) => (archived && ref && (await launcher.isAlive({ harness, ref })) ? launcher.killSession({ harness, ref }) : null))
      )

      // The list is written here, not by the page: an archive a page had to remember to save
      // was one a failed save forgot, and the stamp is what the delete grace counts from.
      if (archived) await archiveIds(chats.map((c) => c.id))

      // The harness's own flag, where it keeps a record to flip. Having none is the ordinary
      // case — every session the CLI started — and is not an error: the harness's refusal
      // used to be spread into this answer, so every archive said `ok: true` with an `error`
      // beside it. `harnessError` is only a record that exists and could not be written.
      const results = []
      for (const [i, { harness, ref }] of chats.entries()) {
        const result = ref && harness ? await setThreadArchived(harness, ref, archived) : { ok: false, none: true }
        const answer = { archived, harnessRecord: Boolean(result.ok), ended: ended[i] }
        if (!result.ok && !result.none) answer.harnessError = result.error || 'The harness could not update its record'
        results.push(answer)
      }
      if (bulk) return send(res, 200, { ok: true, results: results.map((r, i) => ({ id: chats[i].id, ...r })) })
      return send(res, 200, { ok: true, ...results[0] })
    }

    /**
     * Restore: the way back from an archive, for as long as the workspace is still there.
     *
     * An archive ended the session, so a restore that only un-hid the row would hand back a
     * chat nobody can type into. It takes the id off the list, tells aging the workspace is
     * wanted again — `restoredAt` counts as activity, or a chat aged out for idleness would be
     * archived again on the next pass — and resumes the session where it left off. The thread
     * comes off the roster rather than the request: a chat whose workspace has been deleted is
     * not on it, and that is the answer.
     */
    if (url.pathname === '/api/unarchive' && req.method === 'POST') {
      const { id } = await readJsonBody(req)
      if (!id) return send(res, 400, { ok: false, error: 'Missing thread id' })
      const { threads } = await roster()
      const thread = threads.find((t) => t.id === id)
      if (!thread) return send(res, 404, { ok: false, error: 'That chat is gone — its workspace has been deleted' })
      await unarchiveId(id)
      if (thread.canArchive) await setThreadArchived(thread.harness, thread.ref, false).catch(() => {})
      await markWorkspace(thread.workspace.id, { aged: 0, kept: '', restoredAt: Date.now() })
      // One session per workspace: the approval surface is keyed on it (launchers.md), so a
      // chat whose workspace has since carried on under a new id is not resumed beside its successor.
      const busy = threads.some((t) => t.id !== id && t.workspace?.id === thread.workspace.id && t.canSend)
      const launcher = await activeLauncher()
      const resumed = busy
        ? { ok: false, error: 'Another session is already running in its workspace' }
        : (await launcher.isAlive(thread))
          ? { ok: true }
          : await launcher.resume(thread)
      return send(res, 200, { ok: true, resumed })
    }

    return send(res, 404, { error: 'Unknown endpoint' })
  } catch (err) {
    return fail(req, res, err)
  }
}
