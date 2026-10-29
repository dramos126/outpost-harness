import './ui/styles.css'
import {
  fetchThreads,
  ackThread,
  archiveThread,
  archiveThreads,
  unarchiveThread,
  startFresh as startFreshFrom,
  fetchModels,
  fetchAuth,
  fetchLauncher,
  fetchHarnesses,
  fetchUsage,
  fetchSystem,
  hasToken,
  logout,
  setUnauthorizedHandler,
  subscribeEvents,
  searchAll,
  fetchCatalogue,
  fetchShells,
  createWorkspace,
  deleteWorkspace,
  retryWorkspace,
  pushWorkspaceRepo,
  finishWorkspaceRepo,
  pinWorkspace,
  startDefining,
} from './api.js'
import { showLogin } from './ui/login.js'
import { Shell, fitKeyboard } from './ui/shell.js'
import { ChatList } from './ui/chat-list.js'
import { Conversation } from './ui/conversation.js'
import { Usage } from './ui/usage.js'
import { SystemDetail, SystemLine } from './ui/system.js'
import { SettingsView, applyRosterAppearance, applyTheme, readTheme } from './ui/settings.js'
import { heldWorkspaces } from './ui/settings/workspaces.js'
import { NewChat } from './ui/new-chat.js'
import { ActivityPanel } from './ui/activity.js'
import { AgentMap } from './ui/agents.js'
import { CommandMap } from './ui/commands.js'
import { SetupView } from './ui/setup-view.js'
import { WorkspacePanel } from './ui/workspace.js'
import { FilesPanel } from './ui/files.js'
import { wireCodeCopy, wirePathLinks } from './ui/markdown.js'
import { wireScrollFoot } from './ui/scroll-foot.js'
import { MARK, setFavicon, setFaviconUpdate } from './ui/favicon.js'
import { RoutineList, draftWaiting } from './ui/routines.js'
import { RoutinePage, RunPanel } from './ui/routine-page.js'
import { STATUS_LABEL, archivedThreads, chatThreads, definesOf, restingStatus, runOf, savedFrom, statusFor, visibleThreads, wantsYou } from './state/threads.js'
import { unsavedWork } from './state/handoff.js'

/**
 * Boot and the outer loop.
 *
 * The page holds one list of threads and one selection. The list arrives down the push channel
 * whenever the server sees it change, with a fetch behind it for a stream that is down; the
 * selection drives the conversation panel. Everything else — archiving, launching — is wiring
 * around those two.
 */

/** With the stream up this is a safety net; with it down it is the whole refresh. */
const FALLBACK_POLL_MS = 30000
/** Slower than the thread loop on purpose: limits move in whole percent over minutes. */
const USAGE_POLL_MS = 60000
/** CPU is an average over this interval (system.mjs), so it is also how quickly a spike shows. */
const SYSTEM_POLL_MS = 5000

applyTheme(readTheme())

const app = document.getElementById('app')
app.insertAdjacentHTML(
  'beforeend',
  `<div class="boot"><div class="inner"><div class="mark">${MARK}</div><h1>Outpost</h1><div class="bar"><i></i></div></div></div>`
)

let threads = []
/**
 * What this page archived or restored and the roster in hand may not say yet: id -> the
 * `archived` it should carry. The server owns the list (api.md); this only keeps a roster that
 * was already on its way from putting a row back for a moment, and an entry is dropped as soon
 * as a roster agrees with it.
 */
const pendingArchive = new Map()
/** Whether the list is showing the archived chats instead of the live ones. */
let showArchived = false
/**
 * The bulk archive's picks while it is on, else null (chats.md). Here and not in the list's
 * markup, because the list is rebuilt on every roster.
 */
let picking = null
/** Every workspace the server knows, as the roster last carried them. */
let workspaces = []
let selectedId = null
/** The roster's routines (`roster.routines`): the Routines tab's rows. */
let routines = []
/**
 * The roster's drafts (`roster.drafts`, routines.md *Defining chats*): chats defining a routine
 * not saved yet, drawn as the Routines tab's first rows.
 */
let drafts = []
/** The routine whose page is open in the main pane, or null. */
let selectedRoutine = null
/** The open chat's workspace, remembered so a roster that lacks the chat can tell "missing" from "gone". */
let selectedWorkspaceOf = ''
/** A workspace selected before its session exists — preparing, or failed. */
let selectedWs = null
/** The details column: open by choice on a wide screen, a sheet on a phone. */
let rightOpen = window.innerWidth >= 1100
let launcher = {}
let streamUp = false

/** The build this page was compiled from; '' under the dev server, which is never stale. */
const BUILD = __OUTPOST_BUILD__
/** Whether the server's `build` (off a roster) names a newer page than this one. */
const isStale = (build) => Boolean(BUILD && build && build !== BUILD)
/** The footer's version line: the commit it was built from; when, which the build id is the time of, is the hover. */
const VERSION = (() => {
  if (!BUILD) return { text: 'dev', title: 'Served by the dev server' }
  return { text: __OUTPOST_COMMIT__ || BUILD, title: `Outpost, built ${new Date(parseInt(BUILD, 36)).toLocaleString()}` }
})()
/** The footer and the tab's icon, from a roster: whether a newer page is on disk, and which commit it is. */
function applyBuild(roster) {
  const stale = isStale(roster.build)
  shell.setStale(stale, { commit: roster.buildCommit || '', subject: roster.buildSubject || '' })
  setFaviconUpdate(stale)
}

/**
 * The selection, kept in the address's fragment: `#/chat/<id>`, `#/workspace/<id>`,
 * `#/settings`. It lived in page memory alone, so every reload — a deploy, a phone that put
 * the tab to sleep, the refresh button — came back to the empty list. Replaced rather than
 * pushed, so the back button still leaves the page. A fragment is never sent to the server,
 * and an id is not a credential.
 *
 * The same route is also kept in `localStorage`, read only when the address has no fragment:
 * an installed app (the manifest's `standalone`) that the OS relaunches comes back at
 * `start_url`, fragment gone. The fragment wins when there is one, so two tabs on two chats
 * each reload into their own.
 */
const ROUTE_KEY = 'outpost.route'

function parseRoute(hash) {
  try {
    const [, kind = '', id = ''] = String(hash || '').split('/')
    return kind ? { kind, id: decodeURIComponent(id) } : null
  } catch {
    return null
  }
}

function readRoute() {
  if (location.hash) return parseRoute(location.hash)
  try {
    return parseRoute(localStorage.getItem(ROUTE_KEY))
  } catch {
    return null
  }
}

/** What the address named when the page loaded, until a roster can find it — or the person picks something else first. */
let restoring = readRoute()

function writeRoute(kind = '', id = '') {
  restoring = null
  const hash = kind ? `#/${kind}${id ? `/${encodeURIComponent(id)}` : ''}` : ''
  try {
    localStorage.setItem(ROUTE_KEY, hash)
  } catch {
    /* private window: the fragment still carries it */
  }
  if (hash === location.hash) return
  try {
    history.replaceState(null, '', location.pathname + location.search + hash)
  } catch {
    /* no history to write to; the selection still works for this page load */
  }
}

/**
 * Open what the address named. A chat the roster does not carry yet is waited for rather than
 * given up on: a page reloaded while the server restarts can be handed a roster short of it,
 * and clearing the address there was the selection lost a second way. Given up only when the
 * roster says the chat is archived, or on the person picking something else (`writeRoute`).
 */
function restore() {
  const { kind, id } = restoring
  if (kind === 'chat') {
    // An address naming a conversation the chat has since started fresh from opens the chat.
    const t = threads.find((x) => x.id === id) || threads.find((x) => !x.archived && x.earlier?.some((e) => e.id === id))
    if (!t) {
      if (!restoring.said) console.info(`[outpost] the chat in the address (${id}) is not on the roster yet; waiting for one that has it`)
      restoring.said = true
      return
    }
    if (t.archived) return writeRoute()
    return select(t.id)
  }
  if (kind === 'workspace' && !workspaces.some((w) => w.id === id)) return
  if (kind === 'routine' && !routines.some((r) => r.id === id)) return
  restoring = null
  if (kind === 'workspace') selectWorkspace(id)
  else if (kind === 'routine') selectRoutine(id)
  else if (kind === 'settings') showSettings()
  else writeRoute()
}

// Once, on the document: the conversation, the agent map and the activity panel all draw
// Markdown, and a code block's Copy button works the same in each.
wireCodeCopy(document)
wirePathLinks(document, openFile)
// Likewise once: one button serves every scrolling box on the page.
wireScrollFoot(document)
fitKeyboard()

const shell = new Shell(app, {
  onNewChat: () => newChat.show(),
  onNewRoutine: () => actions.defineRoutine(),
  onSettings: () => showSettings(),
  onBack: () => select(null),
  onArchived: () => {
    showArchived = !showArchived
    picking = null
    paintList()
  },
  onBulk: () => actions.bulkArchive(),
  onBulkCancel: () => stopPicking(),
  onSearch: (text) => {
    list.setFilter(text)
    routineList.setFilter(text)
    paintList()
    searchIndex(text)
  },
  // The tabs share the search box; what the index found is the chats' alone.
  onTab: () => {
    picking = null
    paintList()
    searchIndex(shell.$('.search input').value)
  },
  onRightToggle: () => paintRight(),
  // A heading in or out of Files mode: the one state is the panel's (ui-details.md).
  onRightMode: (on) => (on ? files.activate() : files.deactivate()),
  // The mode header's Expand: the open file over the chat and the column.
  onFileExpand: () => files.expand(),
  onRightClose: () => setRight(false),
})
shell.setVersion(VERSION.text, VERSION.title)
const activity = new ActivityPanel(shell.actEl)
// Files mode entered or left moves the column between its stacked view and Files alone, and its two widths (ui-details.md).
// The expanded layer is a child of the shell's grid (`shell.el`, `.app`), never of `#app`
// around it: spanning the grid's columns is what gives it its place and its size.
// An image in Files opens in the conversation's own zoom, not a second one (ui-details.md).
const files = new FilesPanel(shell.filesEl, shell.el, { onToast: (msg, kind) => shell.toast(msg, kind), onActive: () => paintRight(), onZoom: (url) => convo.zoom(url) })
const agentMap = new AgentMap(app)
const commandMap = new CommandMap(app, { onToast: (msg, kind) => shell.toast(msg, kind) })
const setupView = new SetupView(app, { onToast: (msg, kind) => shell.toast(msg, kind) })
const list = new ChatList(shell.chats, {
  onPick: (id, ws) => (ws ? selectWorkspace(ws) : select(id)),
  onRestore: (id) => actions.restoreThread(id),
  onPin: (workspaceId, pinned) => actions.pinChat(workspaceId, pinned),
  onToggle: (id) => {
    if (!picking) return
    if (!picking.delete(id)) picking.add(id)
    paintList()
  },
})
const newChat = new NewChat(app, {
  onStart: (spec) => actions.newWorkspace(spec),
  getModels: async () => {
    await ensureModelChoices()
    return modelChoices
  },
})
const wsPanel = new WorkspacePanel(shell.wsEl, {
  onPush: (id, repo) => actions.pushBranch(id, repo),
  onFinish: (id, repo, mode) => actions.finish(id, repo, mode),
  onDelete: (id, force) => actions.deleteWorkspace(id, force),
  onRetry: (id) => actions.retryWorkspace(id),
  onToast: (msg, kind) => shell.toast(msg, kind),
  // "Make a routine of this": a new chat with the request written and the same repos ticked;
  // the chat drafts the routine and asks you to approve it (routines.md, Made from a chat).
  onRoutine: (ws) =>
    newChat.prefill({
      prompt: `Make a routine from the chat "${ws.name}"${ws.prompt ? `, whose first prompt was:\n\n${ws.prompt}` : '.'}`,
      repos: ws.repos,
    }),
})
const routineList = new RoutineList(shell.routinesEl, { onPick: (id, runId) => selectRoutine(id, runId), onDraft: (ws) => openDefining(ws) })
/** The chat a routine's run became, if it did: its thread carries the run, or runs in its workspace. */
const chatOfRun = (run) =>
  threads.find((t) => !t.archived && (runOf(t)?.runId === run.runId || (run.workspaceId && t.workspace?.id === run.workspaceId))) || null
const runPanel = new RunPanel(shell.runEl, {
  findChat: chatOfRun,
  onOpenChat: (id) => select(id),
  onToast: (msg, kind) => shell.toast(msg, kind),
})
const routinePage = new RoutinePage(shell.main, {
  onBack: () => select(null),
  onRight: () => setRight(!rightOpen),
  // A run tapped opens the details column (the sheet, on a phone); the one chosen on opening
  // the page leaves it as the person last had it.
  onRunChosen: (routine, run, byPerson) => {
    runPanel.set(routine, run)
    if (byPerson && run && !rightOpen) setRight(true)
    else paintRight()
  },
  // Change…: no form on the page (routines.md: changing one is asking a chat) — the chat that
  // defined it, or a new one the server links to it and tells what it is.
  onChange: (r) => actions.defineRoutine(r.id),
  onGone: () => select(null),
  onToast: (msg, kind) => shell.toast(msg, kind),
  repoName: (id) => catalogue.find((r) => r.id === id)?.name || id,
})
const usage = new Usage(shell.usageEl)
usage.show()
const systemDetail = new SystemDetail(app)
const systemLine = new SystemLine(shell.sysEl, { onMore: () => systemDetail.show() })
const convo = new Conversation(shell.main, {
  onArchive: () => actions.archiveThread(),
  onFresh: () => actions.startFresh(),
  onCancel: () => disarm(),
  onClose: () => select(null),
  onRight: () => setRight(!rightOpen),
  // The context bar: the Workspace section, whose Session lines say what it cost.
  onContext: () => setRight(true, 'workspace'),
  // The tool row's Files button: the column open in Files mode as a path link opens it, with no
  // file; pressed while on, the mode is left.
  onFiles: () => {
    if (!selectedId) return
    if (rightOpen && files.active) return files.deactivate()
    files.activate(true)
    setRight(true, 'files')
  },
  // An agent's marker lands on its group; a line of the log's inline steps on its call's row.
  onSteps: (group, id) => {
    setRight(true, 'activity')
    activity.reveal(group, id)
  },
  onAgents: () => {
    const thread = threads.find((t) => t.id === selectedId)
    if (thread) agentMap.show(thread)
  },
  onCommands: () => {
    const thread = threads.find((t) => t.id === selectedId)
    if (thread) commandMap.show(thread)
  },
  // The setup pill: the chat's setup, each repo's state and log, in a window of its own.
  onSetup: () => {
    const thread = threads.find((t) => t.id === selectedId)
    const ws = thread?.workspace?.id ? workspaces.find((w) => w.id === thread.workspace.id) : null
    if (ws) setupView.show(ws)
  },
  // `/registerRepo`: a Register changed the catalogue; Edit in Settings opens its form on the draft.
  onCatalogue: (repos) => setCatalogue(repos),
  onEditRepo: (draft) => {
    showSettings()
    settings.prefillRepo(draft)
  },
  activity,
  onToast: (msg, kind, opts) => shell.toast(msg, kind, opts),
  // A chat named in a toast — `/away all`'s list — opened.
  onOpen: (id) => select(id),
  // Something was sent, answered or resumed: the roster will have moved, so look soon.
  onActed: () => setTimeout(poll, 1500),
})
/**
 * Settings › Terminal (terminal.js), made the first time it is wanted: the terminal widget is
 * most of the page's weight, and a phone opening a chat should not download it.
 */
let termView = null
/** Bumped on each open and leave, so an open still loading when the page is left draws nothing. */
let termVisit = 0

/**
 * The Terminal page opened: the host's one terminal if it is open already — left by a reload,
 * or open on another device — else "Log in as".
 */
async function showTerminal(slot) {
  const visit = ++termVisit
  if (!termView) {
    const { TerminalView } = await import('./ui/terminal.js')
    termView ||= new TerminalView(slot, { onToast: (msg, kind) => shell.toast(msg, kind) })
  }
  let res
  try {
    res = await fetchShells()
  } catch (err) {
    // Refused while Outpost has no login of its own: the page says so instead of a form.
    if (visit !== termVisit) return
    termView.refuse(err.message || 'No terminal here')
    return termView.show('')
  }
  if (visit !== termVisit) return
  termView.refuse('')
  termView.setDefaults(res)
  // The host's only: a chat's container shells are its drawer's (chat-shell.js).
  const open = (res.shells || []).filter((s) => s.kind !== 'container' && !s.ended)
  for (const s of open) termView.attach(s)
  termView.prune(new Set(open.map((s) => s.id)))
  termView.show(open[0]?.id || '')
}

/** The Terminal page left, for another page or view: its terminal is closed. */
function leaveTerminal({ keepalive = false } = {}) {
  termVisit++
  termView?.closeAll({ keepalive })
}
// The tab closed or reloaded on the page: closed too, rather than left for the idle timer.
window.addEventListener('pagehide', () => {
  if (shell.view === 'settings' && settings.page === 'terminal') leaveTerminal({ keepalive: true })
})

const settings = new SettingsView(shell.settingsEl, {
  onTerminal: (slot) => (slot ? showTerminal(slot) : leaveTerminal()),
  onToast: (msg, kind) => shell.toast(msg, kind),
  onBack: () => select(null),
  onLogout: async () => {
    await logout()
    location.reload()
  },
  ensureModels: () => ensureModelChoices(),
  onCatalogue: (repos) => setCatalogue(repos),
  onRestore: (id) => actions.restoreThread(id),
})

/**
 * The search box filters the list as you type and, a beat later, asks the index for what
 * memory and docs say — the second answer the same words can have.
 */
let searchTimer = 0
let searchSeq = 0
function searchIndex(text) {
  clearTimeout(searchTimer)
  const q = text.trim()
  if (q.length < 3 || shell.tab === 'routines') return shell.setFound(null, '')
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq
    try {
      const res = await searchAll(q, ['memory', 'doc', 'chat'])
      if (seq === searchSeq) shell.setFound(res.hits || [], q)
    } catch {
      if (seq === searchSeq) shell.setFound([], q)
    }
  }, 350)
}

let catalogue = []
function setCatalogue(repos) {
  catalogue = repos
  settings.setCatalogue(repos)
  // `/addRepo` in the message box offers these.
  convo.setCatalogue(repos)
  newChat.setCatalogue(repos)
}

// ── actions ───────────────────────────────────────────────────────────────────────────

/** A New routine or Change… on its way to the server (`actions.defineRoutine`). */
let startingDefine = false

const actions = {
  /**
   * A new chat with a workspace. The server answers at once with the manifest and prepares
   * on; the row appears in the list from the next roster, and `followWorkspace` moves the
   * selection onto the session once it exists.
   */
  newWorkspace: async (spec) => {
    try {
      const res = await createWorkspace(spec)
      if (!res.ok) return shell.toast(res.error || 'Could not start that chat', 'err')
      selectWorkspace(res.workspace.id)
      shell.toast(res.workspace.repos.length ? `Preparing ${res.workspace.name}…` : `Starting ${res.workspace.name}…`)
      poll()
    } catch (err) {
      shell.toast(err.message || 'Could not start that chat', 'err')
    }
  },

  /**
   * New routine (no id) or Change… (`routineId`): a chat to define it in, started at once with no
   * form (routines.md *Defining chats*), and opened — for Change…, the chat that defined it when
   * there is one. A second press while the first is on its way does nothing: the server makes
   * one chat per routine, but a new one per press of New routine.
   */
  defineRoutine: async (routineId = '') => {
    if (startingDefine) return
    startingDefine = true
    try {
      const res = await startDefining(routineId)
      if (!res.ok) return shell.toast(res.error || 'Could not start that chat', 'err')
      openDefining(res.workspaceId)
      if (res.created) shell.toast(routineId ? 'Starting a chat to change it…' : 'Starting a chat for the new routine…')
      poll()
    } catch (err) {
      shell.toast(err.message || 'Could not start that chat', 'err')
    } finally {
      startingDefine = false
    }
  },

  pushBranch: async (id, repo) => {
    try {
      const res = await pushWorkspaceRepo(id, repo)
      shell.toast(res.ok ? `Pushed ${res.branch}` : res.error || 'Could not push', res.ok ? '' : 'err')
      poll()
    } catch (err) {
      shell.toast(err.message || 'Could not push', 'err')
    }
  },

  /** Land a checkout's work. A refusal carries the reason; a PR carries its link. */
  finish: async (id, repo, mode) => {
    try {
      const res = await finishWorkspaceRepo(id, repo, mode)
      if (!res.ok) return shell.toast(res.error || 'Could not finish', 'err')
      shell.toast(res.pr ? `${res.pr.existing ? 'Pull request already open' : 'Opened pull request'} #${res.pr.number}` : `${res.branch} landed on ${res.base}`)
      poll()
    } catch (err) {
      shell.toast(err.message || 'Could not finish', 'err')
    }
  },

  /** Try a failed preparation again. */
  retryWorkspace: async (id) => {
    try {
      const res = await retryWorkspace(id)
      shell.toast(res.ok ? 'Preparing again…' : res.error || 'Could not try again', res.ok ? '' : 'err')
      poll()
      return res
    } catch (err) {
      shell.toast(err.message || 'Could not try again', 'err')
      return { ok: false, error: err.message }
    }
  },

  /** Delete a workspace. A refusal comes back as an answer with a reason, for the panel to show. */
  deleteWorkspace: async (id, force) => {
    try {
      const res = await deleteWorkspace(id, force)
      if (res.refused) return res
      if (!res.ok) {
        shell.toast(res.error || 'Could not delete that workspace', 'err')
        return res
      }
      shell.toast('Workspace deleted')
      if (selectedWs === id) selectedWs = null
      const thread = threads.find((t) => t.workspace?.id === id)
      if (thread && thread.id === selectedId) select(null)
      poll()
      return res
    } catch (err) {
      shell.toast(err.message || 'Could not delete that workspace', 'err')
      return { ok: false, error: err.message }
    }
  },

  archiveThread: async () => {
    const thread = threads.find((t) => t.id === selectedId)
    if (!thread) return
    // Every archive is two presses, a session to end or not: one press took a chat off the
    // list, and a slip of the thumb is exactly how that happens.
    if (!confirmArchive(thread)) return
    // Archived mid-turn, an Undo resumes the session but not the turn it was in.
    const wasWorking = Boolean(thread.running)
    try {
      const res = await archiveThread(thread, true)
      pendingArchive.set(thread.id, true)
      select(null)
      applyThreads(threads)
      // Ten seconds to take it back where it was pressed, rather than from Archived (chats.md).
      const undo = { action: { label: 'Undo', run: () => actions.restoreThread(thread.id, { wasWorking }) } }
      if (res.ended && !res.ended.ok) shell.toast(`Archived, but the session is still running — ${res.ended.error}`, 'err', undo)
      else if (res.ended?.ok) shell.toast('Archived · session ended', '', undo)
      else if (res.harnessError) shell.toast(`Archived, but ${thread.harnessName || 'the harness'} did not record it — ${res.harnessError}`, 'err', undo)
      else shell.toast('Archived', '', undo)
    } catch (err) {
      shell.toast(err.message || 'Could not archive that chat', 'err')
    }
  },

  /**
   * The list's bulk archive (chats.md): the first press starts picking, the second archives
   * what was picked, with no confirm after it — turning it on, picking and pressing again are
   * the confirm. Pressed with nothing picked, it stops picking.
   */
  bulkArchive: async () => {
    if (!picking) {
      showArchived = false
      picking = new Set()
      return paintList()
    }
    const chosen = threads.filter((t) => picking.has(t.id))
    picking = null
    if (!chosen.length) return paintList()
    try {
      const res = await archiveThreads(chosen)
      if (!res.ok) {
        paintList()
        return shell.toast(res.error || 'Could not archive those chats', 'err')
      }
      for (const t of chosen) pendingArchive.set(t.id, true)
      // Closes the open chat too, when it was one of them: the roster now has it archived.
      applyThreads(threads)
      const results = res.results || []
      const running = results.filter((r) => r.ended && !r.ended.ok)
      const unrecorded = results.filter((r) => r.harnessError)
      const ended = results.filter((r) => r.ended?.ok).length
      const n = `${chosen.length} chat${chosen.length === 1 ? '' : 's'}`
      // Only what the server says it archived comes back.
      const archivedIds = results.filter((r) => r.archived).map((r) => r.id)
      const undo = archivedIds.length ? { action: { label: 'Undo all', run: () => actions.restoreMany(archivedIds) } } : {}
      if (running.length) shell.toast(`Archived ${n}, but ${running.length} session${running.length === 1 ? ' is' : 's are'} still running — ${running[0].ended.error}`, 'err', undo)
      else if (unrecorded.length) shell.toast(`Archived ${n}, but ${unrecorded.length} did not get the harness's record — ${unrecorded[0].harnessError}`, 'err', undo)
      else shell.toast(`Archived ${n}${ended ? ` · ${ended} session${ended === 1 ? '' : 's'} ended` : ''}`, '', undo)
    } catch (err) {
      paintList()
      shell.toast(err.message || 'Could not archive those chats', 'err')
    }
  },

  /**
   * The bulk archive's Undo all: each chat restored and its session resumed, one after another,
   * as Restore does one (api.md); one toast says how it went. Nothing is opened.
   */
  restoreMany: async (ids) => {
    let restored = 0
    let failed = ''
    for (const id of ids) {
      const thread = threads.find((t) => t.id === id)
      if (!thread) continue
      try {
        const res = await unarchiveThread(thread)
        if (!res.ok) {
          failed ||= res.error || 'could not restore'
          continue
        }
        pendingArchive.set(id, false)
        restored++
        if (!res.resumed?.ok) failed ||= `a session did not resume — ${res.resumed?.error || 'unknown error'}`
      } catch (err) {
        failed ||= err.message || 'could not restore'
      }
    }
    await poll()
    shell.toast(`Restored ${restored} of ${ids.length}${failed ? ` — ${failed}` : ''}`, failed ? 'err' : '')
  },

  /** Pin or unpin a chat from its row (aging.md): the list repaints from the roster that follows. */
  pinChat: async (workspaceId, pinned) => {
    try {
      const res = await pinWorkspace(workspaceId, pinned)
      if (!res.ok) return shell.toast(res.error || 'Could not change the pin', 'err')
      shell.toast(res.pinned ? 'Pinned — not archived or deleted until you unpin it' : 'Unpinned')
    } catch (err) {
      shell.toast(err.message || 'Could not change the pin', 'err')
    }
    poll()
  },

  // `wasWorking`: the archive's Undo for a chat archived mid-turn, whose turn is not given back.
  restoreThread: async (id, { wasWorking = false } = {}) => {
    const thread = threads.find((t) => t.id === id)
    if (!thread) return
    try {
      const res = await unarchiveThread(thread)
      if (!res.ok) return shell.toast(res.error || 'Could not restore that chat', 'err')
      pendingArchive.set(id, false)
      showArchived = false
      await poll()
      select(id)
      const lost = wasWorking ? '; the turn it was in when archived is lost' : ''
      if (res.resumed?.ok) shell.toast(`Restored — session resumed${lost}`)
      else shell.toast(`Restored, but the session did not resume — ${res.resumed?.error || 'unknown error'}`, 'err')
    } catch (err) {
      shell.toast(err.message || 'Could not restore that chat', 'err')
      poll()
    }
  },

  /**
   * A new conversation in the open chat from its handoff (handoff.md). A stale handoff, or one
   * written without the session, goes through the confirm first; so does one the server finds
   * stale when this page did not. The chat keeps its row: the roster that follows hangs the old
   * conversation on the new one, and `applyThreads` moves the selection across.
   */
  startFresh: async () => {
    const thread = threads.find((t) => t.id === selectedId)
    if (!thread?.handoff?.at) return
    const doubtful = thread.handoff.stale || thread.handoff.how === 'fallback'
    const confirmed = armed.id === thread.id && armed.kind === 'fresh'
    if (doubtful && !confirmAction(thread, 'fresh', thread.handoff.stale ? 'The session has worked since this handoff was written, so it misses the latest. This ends the session now running; its conversation stays above the new one.' : 'This handoff was summarised from the transcript and the branch, not written by the session. Read it first. This ends the session now running; its conversation stays above the new one.')) return
    disarm()
    try {
      const res = await startFreshFrom(thread, confirmed || doubtful)
      if (res.confirm) {
        confirmAction(thread, 'fresh', res.error)
        return
      }
      if (!res.ok) return shell.toast(res.error || 'Could not start fresh', 'err')
      // No toast: the "Fresh start from handoff" divider and the context bar starting over are
      // what says it happened (ui-conversation.md).
      setTimeout(poll, 1500)
    } catch (err) {
      shell.toast(err.message || 'Could not start fresh', 'err')
    }
  },
}

// ── confirming ────────────────────────────────────────────────────────────────────────

/**
 * The confirm in front of the things nobody should do by accident. The first call puts the
 * panel's confirm bar up with `why` and answers false; the bar's own button makes the same
 * call a second time, which answers true. One owner, one thing armed
 * at a time: asking about Compact takes Archive's question down. The bar stands until it is
 * answered, cancelled, or the selection moves — it is a question on the page now, not a
 * six-second window on a button, so there is no timer to race.
 */
let armed = { id: null, kind: '' }

const willEndSession = (thread) => Boolean(thread.canSend && launcher.canKill)

function confirmAction(thread, kind, why, extra = {}) {
  if (armed.id === thread.id && armed.kind === kind) {
    disarm()
    return true
  }
  armed = { id: thread.id, kind }
  convo.arm(kind, why, extra)
  return false
}

function confirmArchive(thread) {
  // Work its checkouts hold that is not safe yet, for the popover's Hand off first (state/handoff.js).
  const unsaved = unsavedWork(workspaces.find((w) => w.id === thread.workspace?.id)?.repos)
  return confirmAction(
    thread,
    'archive',
    thread.running
      ? `This session is working, and archiving ends it. ${restoreWindow(thread)}.`
      : `${willEndSession(thread) ? 'Archiving ends this session.' : 'It comes off the list.'} ${restoreWindow(thread)}.`,
    { unsaved }
  )
}

/** How long an archive can be taken back, in the words the confirm uses. */
function restoreWindow(thread) {
  const days = thread.workspace?.aging?.deleteDays
  return days > 0 ? `It can be restored from Archived for ${days} day${days === 1 ? '' : 's'}` : 'It can be restored from Archived until its workspace is deleted'
}

function disarm() {
  armed = { id: null, kind: '' }
  convo.arm('')
}

// ── selection ─────────────────────────────────────────────────────────────────────────

/**
 * Clear a finished chat's ✓ — `done` back to `idle` in the hook store. Only for a chat actually
 * showing one: acking a working or blocked session would be the page guessing at live state.
 * The badge is dropped before the request, since one still sitting there reads as a missed tap.
 */
async function markRead(id) {
  const thread = threads.find((t) => t.id === id)
  if (!thread || statusFor(thread) !== 'done') return
  thread.done = false
  applyThreads(threads)
  try {
    await ackThread(thread)
  } catch (err) {
    thread.done = true
    applyThreads(threads)
    shell.toast(err.message || 'Could not clear that one', 'err')
  }
}

function select(id) {
  disarm()
  leaveTerminal()
  leaveRoutine()
  // Leaving a finished chat is how you say you have read it.
  if (selectedId && selectedId !== id) markRead(selectedId)
  const thread = id ? threads.find((t) => t.id === id) : null
  selectedWs = null
  if (!thread) {
    selectedId = null
    writeRoute()
    convo.hide()
    shell.setView('list')
    shell.setRight()
    paintList()
    return
  }
  selectedId = id
  selectedWorkspaceOf = thread.workspace?.id || ''
  writeRoute('chat', id)
  showArchived = false
  // A routine's defining chat is drawn under Routines, never Chats: the sidebar goes there, so
  // the row of what is open is the one showing (its draft, or its routine's).
  if (definesOf(thread)) shell.setTab('routines')
  convo.show(thread, lookFor(thread))
  shell.setView('chat')
  paintRight()
  paintList()
}

/**
 * A workspace that has no session yet: its row is selectable so the preparation can be
 * watched and a failure read. The main pane shows the workspace panel alone; once the
 * session appears the selection moves onto it.
 */
function selectWorkspace(id) {
  disarm()
  leaveTerminal()
  leaveRoutine()
  if (selectedId) markRead(selectedId)
  selectedId = null
  selectedWs = id
  writeRoute('workspace', id)
  showArchived = false
  if (workspaces.find((w) => w.id === id)?.defines || drafts.some((d) => d.workspaceId === id)) shell.setTab('routines')
  convo.hide()
  shell.setView('chat')
  paintRight()
  paintList()
}

/**
 * A routine's page in the main pane (routines.md *Its page*), on run `runId` when one is named —
 * a Needs-you row names the run that came back — else its newest. The details column is that
 * run's (`RunPanel`).
 */
function selectRoutine(id, runId = '') {
  disarm()
  leaveTerminal()
  if (selectedId) markRead(selectedId)
  selectedId = null
  selectedWs = null
  selectedRoutine = id
  writeRoute('routine', id)
  showArchived = false
  convo.hide()
  routinePage.show(id, runId)
  shell.setView('routine')
  paintRight()
  paintList()
}

/**
 * A defining chat by its workspace (a Draft row, New routine, Change…): its conversation when the
 * roster has it, else the workspace while its session starts — `applyThreads` moves onto the
 * session when it lands. One only archived is restored, which opens it.
 */
function openDefining(workspaceId) {
  const mine = threads.filter((t) => t.workspace?.id === workspaceId)
  const live = mine.find((t) => !t.archived)
  if (live) return select(live.id)
  if (mine.length) return actions.restoreThread(mine[0].id)
  shell.setTab('routines')
  selectWorkspace(workspaceId)
}

function leaveRoutine() {
  if (!selectedRoutine) return
  selectedRoutine = null
  routinePage.hide()
  runPanel.set(null, null)
}

/**
 * Open or close the details column; with `section`, unfolding that section if it was folded.
 * Asked for Workspace or Activity (the context bar, a step's line), Files mode is left, or the
 * section would stay drawn folded under it.
 */
function setRight(open, section) {
  rightOpen = open
  if (section) shell.expand(section)
  if (section && section !== 'files') files.deactivate(true)
  paintRight()
}

/** A path a message named: Files mode, open on that file (on a phone, the sheet). */
function openFile(path) {
  if (!selectedId) return
  files.activate(true)
  setRight(true, 'files')
  files.open(path)
}

/**
 * The details column: the selected chat's workspace above its activity, or the selected
 * workspace alone while it has no session yet. A section the chat has no use for is not
 * shown; a folded one shows its heading, and only the sections showing a body are painted.
 */
function paintRight() {
  if (selectedRoutine) {
    // A routine's page has one section beside it: the chosen run.
    files.set(null, false)
    const showing = shell.setRight({ sections: { run: true }, open: rightOpen })
    shell.el.classList.remove('ws-only')
    shell.setReading(false)
    activity.shown(false)
    runPanel.shown(Boolean(showing.run))
    convo.setRight(null)
    return
  }
  runPanel.shown(false)
  const thread = selectedId ? threads.find((t) => t.id === selectedId) : null
  const id = thread?.workspace?.id || selectedWs
  const ws = id ? workspaces.find((w) => w.id === id) : null
  const sections = { workspace: Boolean(ws), activity: Boolean(thread), files: Boolean(thread) }
  const wsOnly = sections.workspace && !thread
  // A workspace with no session is the whole view, so its panel is always open.
  const open = (sections.workspace || sections.activity) && (rightOpen || wsOnly)
  // Told the thread first: a change of chat leaves Files mode before the fill is decided.
  files.set(thread, false)
  const mode = files.active ? 'files' : ''
  const showing = shell.setRight({ sections, open, fill: mode, mode, viewing: files.viewing })
  shell.el.classList.toggle('ws-only', wsOnly)
  if (showing.workspace) wsPanel.set(ws, thread)
  activity.shown(Boolean(showing.activity))
  if (showing.files) files.set(thread, true)
  shell.setReading(Boolean(showing.files && files.active))
  convo.setRight(thread ? { open, files: files.active } : null)
  convo.setSetup(thread ? ws?.setup : null)
  convo.setHeldNote(thread ? ws?.heldNoteView : null)
}

function showSettings() {
  leaveTerminal()
  leaveRoutine()
  if (selectedId) markRead(selectedId)
  selectedId = null
  // The details column is a chat's — its activity, its workspace — and Settings has neither.
  // Left alone it stayed up beside the settings pages, showing "Nothing done yet." for a chat
  // that was no longer selected.
  selectedWs = null
  writeRoute('settings')
  convo.hide()
  settings.show()
  shell.setView('settings')
  paintRight()
  paintList()
}

/** What the conversation panel borrows from the list: the status key and its word. */
const lookFor = (thread) => {
  const key = statusFor(thread)
  return { key, status: STATUS_LABEL[key] || key, accent: '' }
}

// ── models ────────────────────────────────────────────────────────────────────────────

/** The models a chat can start on: the CLI's aliases, read once (launchers.md). */
let modelChoices = []
async function ensureModelChoices() {
  if (modelChoices.length) return
  try {
    const res = await fetchModels()
    modelChoices = res.models || []
  } catch {
    /* the dialog offers "repo's choice" alone until the list comes */
  }
}

// ── data ──────────────────────────────────────────────────────────────────────────────

function paintList() {
  // A routine's defining chats are the Routines tab's (routines.md *Defining chats*): never in
  // Chats, its Needs you, the header's count or the picks. An archived one stays in Archived,
  // the one way back to it.
  const shown = visibleThreads(chatThreads(threads))
  const archived = archivedThreads(threads)
  if (!archived.length) showArchived = false
  shell.setArchived(archived.length, showArchived)
  const now = Date.now()
  const waiting = shown.filter((t) => wantsYou(t, statusFor(t, now))).length
  shell.setNeedsYou(waiting)
  // Each draft with its chat, once the session is up: its status word and its question are the chat's.
  const draftRows = drafts.map((d) => ({ ...d, thread: (d.threadId && threads.find((t) => t.id === d.threadId && !t.archived)) || null }))
  const draftsWaiting = draftRows.filter((d) => draftWaiting(d, now)).length
  // Runs that came back as chats and still want you: each routine's row under Needs you on the
  // Routines tab, newest run first (the list's own order). The tab's count is of routines, not
  // runs (ui.md, 2026-10-15): it says how many rows are in that section, and a routine whose
  // two runs both failed is one thing to look at.
  const waitingRuns = new Map()
  for (const t of shown) {
    const run = runOf(t)
    if (run && wantsYou(t, statusFor(t, now)) && !waitingRuns.has(run.id)) waitingRuns.set(run.id, t)
  }
  // A draft whose chat asks something counts too: it is a row on that tab waiting on you.
  shell.setRoutineCount(routines.filter((r) => waitingRuns.has(r.id)).length + draftsWaiting)
  // The row of what is open: a routine's page, or its defining chat; a draft's chat, or its
  // workspace while the session starts.
  const open = selectedId ? threads.find((t) => t.id === selectedId) : null
  const openDefines = definesOf(open)
  routineList.set(
    routines,
    waitingRuns,
    { routine: selectedRoutine || openDefines?.routineId || null, draft: openDefines ? (openDefines.routineId ? null : open.workspace?.id) : selectedWs },
    draftRows
  )
  list.setRoutines(routines)
  setFavicon({ needsYou: waiting + draftsWaiting > 0, working: shown.some((t) => statusFor(t, now) === 'working') })
  // Every chat, not only those the filter shows: a reload interrupts the live view of any of them.
  shell.setWorking(threads.filter((t) => statusFor(t, now) === 'working').length)
  // A picked chat that has started working again, or gone, is dropped from the picks rather
  // than archived from under the person.
  if (picking) {
    const resting = new Set(shown.filter((t) => !t.workspace?.pinned && restingStatus(statusFor(t, now))).map((t) => t.id))
    for (const id of picking) if (!resting.has(id)) picking.delete(id)
  }
  shell.setBulk(picking ? picking.size : null)
  if (showArchived) return list.setArchived(archived)
  // Workspaces whose session has not appeared yet, or never will: a row each.
  const carried = new Set(threads.map((t) => t.workspace?.id).filter(Boolean))
  // A routine's run has no row until it comes back as a chat (routines.md): it is hidden. One
  // promoted with no session — its preparation failed — is a chat with nothing to read but its
  // error, and gets the row: left out, the run that most needs a look was nowhere in Chats.
  // A defining chat starting up is its Draft row under Routines, not a Starting row here.
  const orphans = workspaces.filter((w) => !carried.has(w.id) && !w.defines && !(w.routine?.id && !w.routine.promoted) && (w.status !== 'ready' || Date.now() - (w.launch?.at || w.createdAt) < 120000))
  list.set(shown, selectedId || selectedWs, orphans, picking)
}

function stopPicking() {
  picking = null
  paintList()
}

function applyThreads(next, nextWorkspaces = workspaces, nextRoutines = routines, nextDrafts = drafts) {
  const previous = threads
  for (const t of next) {
    if (!pendingArchive.has(t.id)) continue
    if (Boolean(t.archived) === pendingArchive.get(t.id)) pendingArchive.delete(t.id)
    else t.archived = pendingArchive.get(t.id)
  }
  threads = next
  workspaces = nextWorkspaces
  routines = Array.isArray(nextRoutines) ? nextRoutines : []
  drafts = Array.isArray(nextDrafts) ? nextDrafts : []
  paintList()
  // The open routine's page reads itself again when its line moved; its run's Open the chat
  // appears once the roster carries the chat the run became.
  if (selectedRoutine) {
    routinePage.setSummary(routines.find((r) => r.id === selectedRoutine))
    runPanel.refreshChat()
  }
  // Workspaces waiting on a decision (settings/workspaces.js). A roster with no threads at all is
  // one read across a restart, which would make every workspace look chatless for a moment.
  if (threads.length) {
    const held = heldWorkspaces(threads, workspaces)
    const n = held.stranded.length + held.kept.length
    shell.setWorkspaceBadge(n)
    settings.setWorkspaceBadgeCount(n)
  }

  // A roster after a load is the first thing that can find what the address named.
  if (restoring) restore()

  // A workspace that was selected before its session existed: move onto the session.
  if (selectedWs) {
    const landed = threads.find((t) => t.workspace?.id === selectedWs && !t.archived)
    if (landed) select(landed.id)
    else paintRight()
  }

  // Keep the open conversation honest, and re-tail it if the server saw it move.
  if (selectedId) {
    const thread = threads.find((t) => t.id === selectedId && !t.archived)
    // Started fresh (handoff.md): the open conversation is now an earlier one of a thread that
    // carries on the chat — on this page's press or another device's. Follow it there.
    const successor = thread ? null : threads.find((t) => !t.archived && t.earlier?.some((e) => e.id === selectedId))
    if (successor) {
      select(successor.id)
    } else if (!thread) {
      // Gone is archived, or its workspace deleted; missing from one roster is not gone. A
      // roster read across a restart can be short of a chat that is still there, and closing
      // it threw the person back to the list on a deploy. The panel keeps what it last had.
      const archived = threads.some((t) => t.id === selectedId && t.archived)
      const wsGone = !selectedWorkspaceOf || !workspaces.some((w) => w.id === selectedWorkspaceOf)
      console.info(`[outpost] the open chat (${selectedId}) is not on this roster —`, archived ? 'archived, closing it' : wsGone ? 'its workspace is gone, closing it' : 'its workspace is still there, keeping it open')
      if (archived || wsGone) select(null)
    } else if (savedFrom(previous.find((t) => t.id === selectedId), thread)) {
      // The open defining chat just saved its routine (routines.md *Defining chats*): its page,
      // where the routine now is. The chat stays one press away, behind Change….
      selectRoutine(definesOf(thread).routineId)
      shell.toast(`Saved ${definesOf(thread).name || 'the routine'}`)
    } else {
      selectedWorkspaceOf = thread.workspace?.id || ''
      const was = previous.find((t) => t.id === selectedId)
      const moved = !was || was.lastActivityAt !== thread.lastActivityAt || was.running !== thread.running || was.unread !== thread.unread
      convo.update(thread, lookFor(thread), { moved })
      agentMap.update(thread)
      commandMap.update(thread)
      paintRight()
    }
  }
}

/**
 * One fetch of the roster. Overlapping polls collapse onto the one in flight, and that one is
 * handed back so a caller waiting on fresh data (a launch being watched) actually waits.
 */
let polling = null
function poll() {
  if (polling) return polling
  polling = (async () => {
    try {
      const res = await fetchThreads()
      convo.setContextLimits(res.contextLimits)
      if (applyRosterAppearance(res.appearance)) settings.paintTheme()
      applyThreads(res.threads || [], res.workspaces || [], res.routines || [], res.drafts || [])
      shell.setPartial(res.scanFailed || [])
      applyBuild(res)
      shell.removeBoot()
    } catch (err) {
      shell.toast(err.message || 'Could not reach the server', 'err')
      shell.removeBoot()
    } finally {
      polling = null
    }
  })()
  return polling
}

/** The push channel. Every `threads` event is applied exactly as a fetch would be. */
function subscribe() {
  subscribeEvents(
    (name, data) => {
      if (name !== 'threads') return
      convo.setContextLimits(data.contextLimits)
      if (applyRosterAppearance(data.appearance)) settings.paintTheme()
      applyThreads(data.threads || [], data.workspaces || [], data.routines || [], data.drafts || [])
      shell.setPartial(data.scanFailed || [])
      applyBuild(data)
      shell.removeBoot()
    },
    (status) => {
      const up = status === 'up'
      if (up && !streamUp) poll() // whatever moved while the stream was down
      streamUp = up
      shell.setLink(up)
    }
  )
}

let usageShown = false
/** Polls in a row that came back `ok: false` before any answer: past this the spinner gives way to the reason. */
const USAGE_MISSES_SHOWN = 3
let usageMisses = 0
let usageError = ''
async function pollUsage() {
  try {
    const u = await fetchUsage()
    // An empty corner meant any of three things and cost a round of chasing a correct deploy
    // (2026-09-04): the reason goes to the console once, on the spinner, then in the panel.
    if (!u.ok && u.error !== usageError) console.warn('[outpost] usage:', u.error || 'no reason given')
    usageError = u.ok ? '' : u.error || ''
    if (!u.ok && !usageShown) {
      // Only a missing login gives the space back. Anything else (a 429 right after a restart,
      // usually) passes, so the spinner stays and the next poll asks again.
      if (u.needsLogin) return usage.hide()
      usageMisses += 1
      if (usageMisses < USAGE_MISSES_SHOWN) return usage.waiting(u.error)
    } else usageMisses = 0
    // Shown again here, not only at start: an early poll that failed (before login, say) hid it.
    usage.show()
    usage.set(u)
    usageShown = true
  } catch {
    /* the page is not about usage; a failure here is worth nothing on screen */
  }
}

async function pollSystem() {
  // Nobody is looking at a hidden tab's numbers; the next visible poll catches up.
  if (document.hidden) return
  try {
    systemLine.set(await fetchSystem())
  } catch {
    /* same as usage: a missed reading is not worth a word on screen */
  }
}

async function boot() {
  const auth = await fetchAuth().catch(() => ({ passwordAuth: false }))
  settings.setAccount(auth)
  // A fresh box: nothing answers until a password exists, so the form is the whole page.
  if (auth.setupRequired) {
    await showLogin('', { setup: true })
    location.reload()
    return
  }
  if (auth.passwordAuth) {
    setUnauthorizedHandler(() => showLogin(auth.user, { reason: 'Your session has ended' }))
    if (!hasToken()) await showLogin(auth.user)
  }
  fetchLauncher()
    .then((l) => {
      launcher = l
      convo.setCapabilities(l)
      fetchHarnesses()
        .then((h) => settings.setAbout({ launcher: l, harnesses: h.harnesses || [] }))
        .catch(() => settings.setAbout({ launcher: l, harnesses: [] }))
    })
    .catch(() => {
      /* no launcher info — the panel stays read-only, which is the honest default */
    })
  fetchCatalogue()
    .then((res) => setCatalogue(res.repos || []))
    .catch(() => {
      /* no catalogue readable — New chat offers plain chats only */
    })

  await poll()
  subscribe()
  setInterval(() => {
    if (!streamUp || document.hidden === false) poll()
  }, FALLBACK_POLL_MS)
  // The open chat is read again too, not only the roster: a push that landed while the tab was
  // hidden was applied but its read skipped (the panel does not read hidden), so the roster
  // that follows looks unmoved and the log waited for a fallback tick a phone may have frozen.
  const back = () => {
    poll()
    convo.poll()
  }
  window.addEventListener('focus', back)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) back()
  })
  pollUsage()
  setInterval(pollUsage, USAGE_POLL_MS)
  pollSystem()
  setInterval(pollSystem, SYSTEM_POLL_MS)
}

// ── keyboard ──────────────────────────────────────────────────────────────────────────

window.addEventListener('keydown', (e) => {
  const t = e.target
  if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return
  if (e.metaKey || e.ctrlKey || e.altKey) return
  // A terminal takes every key it is given; one pressed beside it is not a shortcut either.
  if (shell.view === 'settings' && settings.page === 'terminal') return
  // Nor beside a chat's shell: a key pressed in its drawer (a tab, its header) is the shell's.
  if (t instanceof Element && t.closest('.cshell')) return
  switch (e.key) {
    case 'Escape':
      if (newChat.open) break
      if (picking) stopPicking()
      else if (shell.view !== 'list') select(null)
      break
    case 'c':
    case 'C':
      if (shell.view !== 'settings') newChat.show()
      break
    case 'n':
    case 'N': {
      // The next chat that wants you, cycling on repeat presses.
      const now = Date.now()
      const pool = visibleThreads(chatThreads(threads)).filter((x) => wantsYou(x, statusFor(x, now)))
      if (!pool.length) return shell.hint('Nothing is waiting on you')
      const i = pool.findIndex((x) => x.id === selectedId)
      select(pool[(i + 1) % pool.length].id)
      break
    }
  }
})

boot()

// Handy for poking at the page from the console.
window.outpost = { poll, select, selectRoutine, get threads() { return threads }, get routines() { return routines } }
