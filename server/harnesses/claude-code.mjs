/**
 * Harness adapter: Claude Code (Anthropic) — the desktop app and the CLI together.
 *
 * Everything that knows the shape of Claude Code's own files lives in this one module.
 * `server/scan.mjs` never reaches past the adapter interface, so adding another harness
 * means writing a sibling of this file rather than editing the scanner. The contract is
 * written down in `server/harnesses/README.md`.
 *
 * Two stores, deliberately merged rather than picked between:
 *   - the desktop app keeps one JSON record per thread (title, cwd, model, timestamps)
 *   - the CLI keeps the raw transcript, which is the only source for terminal-started work
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { exists, jsonLines, listDirs, listFiles, num, readHead, readTail } from '../lib/fsutil.mjs'
import { pathMentions } from '../lib/paths.mjs'
import { hookEverSeen, hookStates, markIdle } from '../state/hooks.mjs'

const HOME = os.homedir()

/** Where the Claude desktop app keeps one JSON record per thread. */
const DESKTOP_SESSIONS = path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude-code-sessions')
/** Where the CLI keeps the raw transcript: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl */
const CLI_PROJECTS = path.join(HOME, '.claude', 'projects')
/** One file per live CLI process: {pid, sessionId, cwd, ...}. Stale files outlive their pid. */
const CLI_LIVE = path.join(HOME, '.claude', 'sessions')
/** The CLI's own settings, whose `model` is what a session with nothing to say yet is on. */
const CLI_SETTINGS = path.join(HOME, '.claude', 'settings.json')

const HEAD_BYTES = 192 * 1024
/**
 * How far back from the end of a transcript to look for the model it is on now.
 *
 * Only the *last* assistant record answers that (see `lastAnswer`), so unlike everything else
 * in the meta this one field has to be read from the end. Generous enough that a run of large
 * tool results does not push the last assistant turn out of the window, small enough that a
 * 12 MB transcript still costs one short read per change.
 */
const TAIL_BYTES = 128 * 1024

/**
 * How recently a session must have done something to count as "active now".
 * A live process on its own is not enough: the desktop app pre-warms idle sessions, so
 * threads untouched for days still hold a CLI process. Measured against real data, the
 * warmed ones sat 16 hours to 3 days idle while genuinely active work was minutes old.
 */
const ACTIVE_WINDOW_MS = 30 * 60 * 1000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DESKTOP_ID = /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Every text block of a message, joined. Not just the first: a prompt Outpost delivers can
 * lead with a block of its own — a setup note and its system reminder — with what the person
 * typed in the next one, and the first block alone cleans to nothing. Every chat Outpost
 * started was titled "Untitled thread" that way (bugs-fixed.md).
 */
function allText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (typeof part === 'string' ? part : part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
}

/** Strip <system-reminder>/<command-*> noise the CLI wraps around prompts. */
function cleanPrompt(s) {
  return String(s)
    .replace(/<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * A prompt that means nothing on its own — "yes", "go ahead", "continue". Real turns in a
 * long session, and useless as the name of one: a thread called "ok" tells you less than the
 * stale title it replaced. The floor beneath it catches the variants this list does not name.
 */
const ACK_PROMPT =
  /^(y|n|yes|yep|yeah|no|nope|ok|okay|k|sure|go|go ahead|do it|proceed|continue|carry on|keep going|next|again|try again|retry|stop|wait|please|thanks|thank you|ty|nice|great|good|perfect|lgtm|ship it|commit|push)\b[\s.!,?]*$/i
/** Shorter than this and a prompt is treated as an aside, not a new subject. */
const MIN_TITLE_PROMPT = 16
/** A title is one line in a narrow list; the rest of the prompt is in the panel below it. */
const TITLE_CHARS = 72

/**
 * One line naming what a prompt asked for. Cut at a word boundary, because a title that ends
 * mid-word reads as a rendering bug rather than as a length.
 */
function titleFromPrompt(text) {
  const s = String(text || '').trim()
  if (s.length <= TITLE_CHARS) return s
  const cut = s.slice(0, TITLE_CHARS)
  const space = cut.lastIndexOf(' ')
  return (space > TITLE_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd() + '…'
}

/**
 * Is this record something a person typed, rather than something the CLI folded into the
 * transcript under a user role? Tool results, hook output, IDE context, slash-command echoes
 * and compaction preambles all arrive as `type: 'user'` and none of them is a prompt.
 *
 * Sidechains are excluded for the reason the caller cares about most: a subagent's turns are
 * a different conversation, and during a long run they are most of what lands in the file.
 */
function promptText(record) {
  if (!record || record.type !== 'user' || record.isMeta || record.isSidechain || record.isCompactSummary) return ''
  if (!record.message) return ''
  // The CLI writes an attachment into the prompt text as `[Image #1]`, ahead of whatever was
  // typed with it — a title that starts there names the paperclip and not the message.
  const text = cleanPrompt(allText(record.message.content)).replace(/^(?:\[(?:Image|Pasted text)[^\]]*\]\s*)+/i, '')
  // A leading `<` is an unpaired wrapper `cleanPrompt` could not strip — never a prompt. A
  // leading `/` is a command (`/addRepo webapp`), which names an action, not what
  // the chat is about, and would otherwise become its title.
  if (!text || text.startsWith('<') || text.startsWith('/')) return ''
  if (/^(Caveat: The messages below|This session is being continued from)/.test(text)) return ''
  if (INTERRUPTED.test(text)) return ''
  return text
}

/**
 * The marker the CLI writes, as a user message, when Esc or Interrupt stops a turn. Nobody
 * typed it: drawn as the person's bubble it read as words they never sent, so it is a note.
 */
const INTERRUPTED = /^\[Request interrupted by user( for tool use)?\]$/

/**
 * The most recent prompt worth naming a thread after, out of a run of records.
 *
 * Read from the end for the same reason `lastAnswer` is: a session that has been running for
 * six hours is no longer about the sentence that started it, and a list of forty threads all
 * titled by their opening line is a list you have to open one by one. Acknowledgements and
 * one-word asides are skipped rather than taken, so "yes" leaves the previous subject
 * standing instead of erasing it.
 */
function lastPrompt(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    const text = promptText(records[i])
    if (!text || text.length < MIN_TITLE_PROMPT || ACK_PROMPT.test(text)) continue
    return text
  }
  return ''
}

/**
 * The model and effort a session is on, out of a run of transcript records.
 *
 * Every assistant record carries the model that produced it, and `/model` mid-session means
 * one transcript can hold several — so the answer is the *last* one and never the first. That
 * is the whole reason this field is read from the tail while the rest of the meta comes from
 * the head: a session started on Opus and switched to Sonnet an hour ago still says Opus at
 * the top of its file, and reporting that is worse than reporting nothing.
 *
 * `<synthetic>` is the CLI's own placeholder on records it wrote itself — an API error, a
 * cancelled turn — and names no model.
 */
function lastAnswer(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i]
    const model = record?.message?.model
    if (!model || model === '<synthetic>') continue
    // `effort` sits on the record rather than inside the message, and is absent on a session
    // old enough to predate it — blank rather than a default invented here.
    return { model: String(model), effort: String(record.effort || '') }
  }
  return { model: '', effort: '' }
}

/**
 * The size of the context the session's latest request carried, and when it was answered:
 * fresh input plus what it read from the cache plus what it wrote to it. Only the main
 * conversation — a subagent's request is its own context, and taking one made a small chat
 * read as the size of whatever its agent last loaded. Off the last record rather than a sum:
 * every request re-sends the whole context, so the latest is the size, and a sum is spend
 * (`readTokens`). `<synthetic>` records carry no request.
 */
function lastContext(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    if (r?.type !== 'assistant' || r.isSidechain || !r.message?.usage || r.message.model === '<synthetic>') continue
    const u = r.message.usage
    const context = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens)
    if (!context) continue
    return { context, contextAt: Date.parse(r.timestamp) || 0 }
  }
  return { context: 0, contextAt: 0 }
}

/**
 * When the session last did something: the newest `timestamp` on any record, or 0. Not the
 * file's mtime — a CLI shutting down appends `last-prompt` and `cost-state`, which carry none,
 * and reading the mtime put every session aging ended at the top of the list as if just used.
 */
function lastStamp(records) {
  let at = 0
  for (const r of records) {
    const t = r?.timestamp ? Date.parse(r.timestamp) : 0
    if (t > at) at = t
  }
  return at
}

/**
 * Pull whatever a transcript knows about itself: title, cwd, branch, start time, model.
 * The CLI's own title precedence is custom > ai > summary > first prompt; `latestPrompt`
 * is read alongside it and slots in under `customTitle` — see `threadTitle`. `/rename` writes
 * a `custom-title` record each time and the CLI takes the last, so this does too: taking the
 * first kept a chat on the name it was renamed away from.
 */
function readTranscriptMeta(records) {
  const { model, effort } = lastAnswer(records)
  const meta = {
    customTitle: '',
    aiTitle: '',
    summary: '',
    firstPrompt: '',
    latestPrompt: lastPrompt(records),
    cwd: '',
    gitBranch: '',
    startedAt: 0,
    model,
    effort,
    lastStampAt: lastStamp(records),
    ...lastContext(records),
  }
  for (const r of records) {
    if (r.customTitle) meta.customTitle = r.customTitle
    if (!meta.aiTitle && r.aiTitle) meta.aiTitle = r.aiTitle
    if (!meta.summary && r.type === 'summary' && r.summary) meta.summary = r.summary
    if (!meta.cwd && r.cwd) meta.cwd = r.cwd
    if (!meta.gitBranch && r.gitBranch && r.gitBranch !== 'HEAD') meta.gitBranch = r.gitBranch
    if (!meta.startedAt && r.timestamp) {
      const t = Date.parse(r.timestamp)
      if (!Number.isNaN(t)) meta.startedAt = t
    }
    if (!meta.firstPrompt) {
      const text = promptText(r)
      if (text) meta.firstPrompt = text
    }
  }
  return meta
}

/**
 * What to call a thread, given its transcript meta and whatever name its harness records
 * carry. One place, because the desktop pass and the CLI pass must not drift apart.
 *
 * A name a person chose wins outright — the desktop record's title, which the app lets you
 * rename, and `customTitle` from `/rename` — and `namedByPerson` says one did. Under those comes the latest prompt rather than
 * the generated `aiTitle`, which is written once near the start and then describes a session
 * the thread has long since stopped being: the whole point of the list is telling six live
 * threads apart at a glance, and six opening lines does not do it. Everything the CLI derived
 * from the start of the file follows, for a thread whose recent turns are all asides.
 */
function threadTitle(meta, recordTitle = '') {
  const from =
    recordTitle ||
    meta?.customTitle ||
    titleFromPrompt(meta?.latestPrompt) ||
    meta?.aiTitle ||
    meta?.summary ||
    titleFromPrompt(meta?.firstPrompt)
  return from || 'Untitled thread'
}

/**
 * Whether `threadTitle` took a name a person chose. Carried on the thread as `titleNamed` so
 * Outpost's automatic naming (titles.mjs) never writes over one.
 */
const namedByPerson = (meta, recordTitle = '') => Boolean(recordTitle || meta?.customTitle)

/**
 * `/repo/.claude/worktrees/feature-abc` -> project `/repo`, worktree `feature-abc`.
 * Either separator: the same session records `C:\repo\.claude\worktrees\…` on Windows.
 */
const WORKTREE_MARKER = /[/\\]\.claude[/\\]worktrees[/\\]/
function splitWorktree(cwd) {
  const m = WORKTREE_MARKER.exec(cwd)
  if (!m) return { root: cwd, worktree: '' }
  return {
    root: cwd.slice(0, m.index),
    worktree: cwd.slice(m.index + m[0].length).split(/[/\\]/)[0],
  }
}

function projectOf(cwd, originCwd) {
  const { root, worktree } = splitWorktree(cwd || '')
  const projectPath = originCwd || root || cwd || ''
  return { projectPath, project: path.basename(projectPath) || projectPath || 'unknown', worktree }
}

/**
 * Best-effort reverse of the encoding used for project folder names — `-Users-you-Some-Dir`
 * on POSIX, `c--Users-you-Some-Dir` on Windows, where the drive letter leads.
 *
 * Only a fallback: it runs when a transcript's records carry no `cwd` at all, which is rare.
 * Worth getting right anyway, because failing it does not produce a slightly wrong path, it
 * produces a *second project* — the raw `c--Users-…-webapp` string becomes its own name
 * sitting next to the real `webapp`, splitting one repo's sessions across two.
 *
 * Lossy, and nothing can mend that: a repo whose own name contains a hyphen cannot be told
 * from a path separator. Nothing in the encoding preserves that distinction.
 */
function decodeProjectDir(name) {
  const windows = /^([a-zA-Z])--(.*)$/.exec(name)
  if (windows) return `${windows[1]}:/${windows[2].replace(/-/g, '/')}`
  return name.startsWith('-') ? '/' + name.slice(1).replace(/-/g, '/') : name
}

/** Index every CLI transcript on disk, keyed by session id. */
async function scanTranscripts() {
  const byId = new Map()
  for (const projectDir of await listDirs(CLI_PROJECTS)) {
    for (const file of await listFiles(projectDir, (n) => n.endsWith('.jsonl'))) {
      const id = path.basename(file, '.jsonl')
      let stat
      try {
        stat = await fsp.stat(file)
      } catch {
        continue
      }
      byId.set(id, { id, file, projectDir, size: stat.size, mtime: stat.mtimeMs })
    }
  }
  return byId
}

/** Transcript metadata is expensive to parse, so keep it until the file changes. */
const metaCache = new Map()
async function transcriptMeta(entry) {
  const cached = metaCache.get(entry.id)
  if (cached && cached.mtime === entry.mtime) return cached.meta
  let meta
  try {
    const head = jsonLines(await readHead(entry.file, HEAD_BYTES))
    meta = readTranscriptMeta(head)
    // A file bigger than the head is a file whose current model the head cannot know. The
    // tail is only read for that one field, and only when the head could not have held it —
    // and the head's answer stands if the tail happens to be one enormous tool result with
    // no assistant turn in it.
    if (entry.size > HEAD_BYTES) {
      const tailRecords = jsonLines(await readTail(entry.file, TAIL_BYTES))
      const tail = lastAnswer(tailRecords)
      if (tail.model) {
        // Both or neither: they come off one record, and pairing a fresh model with a stale
        // effort would describe a combination the session has never run on.
        meta.model = tail.model
        meta.effort = tail.effort
      }
      // The context is the tail's or nothing: the head's figure is the session's size an
      // early request ago, and a header calling a 600k chat "40k" is worse than no number.
      Object.assign(meta, lastContext(tailRecords))
      // The same read answers "what is this thread about now". A window with no prompt in it
      // — one long agent run and its tool results — leaves the head's answer standing, which
      // is a real prompt from earlier in the session rather than a guess.
      const prompt = lastPrompt(tailRecords)
      if (prompt) meta.latestPrompt = prompt
      // The last thing done is at the end of the file; a tail with no stamp in it — one huge
      // record cut by the window — leaves 0, and the thread falls back to the mtime.
      meta.lastStampAt = lastStamp(tailRecords)
      // A head that is one oversized line — a screenshot pasted as the opening message runs
      // past HEAD_BYTES on its own — parses to nothing but the queue records, which carry no
      // cwd. The fallback is decoding the project dir, which turns `/.outpost/` into
      // `//outpost/`, so the chat matched no workspace and dropped off the list (bugs-fixed.md).
      // Every user and assistant record carries the cwd, so the tail has it.
      const late = readTranscriptMeta(tailRecords)
      if (!meta.cwd) meta.cwd = late.cwd
      if (!meta.gitBranch) meta.gitBranch = late.gitBranch
      // A `/rename` late in a long session is past the head, and the last one is the name.
      if (late.customTitle) meta.customTitle = late.customTitle
    }
  } catch {
    meta = readTranscriptMeta([])
  }
  metaCache.set(entry.id, { mtime: entry.mtime, meta })
  return meta
}

/**
 * The model the CLI would start a session on, out of its own settings.
 *
 * The fallback for a session that has not answered yet: it has a process and a prompt and no
 * assistant record to read a model off, and "no idea what this one is on" is the state this
 * whole field exists to end. It is an inference rather than an observation, so a thread that
 * leans on it says so with `modelAssumed` and the page draws it differently.
 *
 * Cached briefly rather than against mtime: `/model` rewrites this file from under us, so a
 * short life is what keeps the answer close to true without a stat per scan.
 */
let configuredModelCache = { at: 0, model: '' }
export async function configuredModel() {
  if (Date.now() - configuredModelCache.at < 15000) return configuredModelCache.model
  let model = ''
  try {
    model = String(JSON.parse(await fsp.readFile(CLI_SETTINGS, 'utf8')).model || '')
  } catch {
    /* no settings file, or one being rewritten right now — no default to report */
  }
  configuredModelCache = { at: Date.now(), model }
  return model
}

/**
 * Sessions with a CLI process actually alive right now. The registry keeps files for
 * processes that have exited, so every pid is probed before it counts.
 *
 * The whole record, not just the pid: `cwd` and `startedAt` are what let a session that has
 * written nothing yet still be given a thread — see the third pass of `scanThreads`.
 */
async function scanLiveSessions() {
  const live = new Map()
  for (const file of await listFiles(CLI_LIVE, (n) => n.endsWith('.json'))) {
    let record
    try {
      record = JSON.parse(await fsp.readFile(file, 'utf8'))
    } catch {
      continue
    }
    if (!record.sessionId || !record.pid) continue
    try {
      process.kill(record.pid, 0) // signal 0 only tests for existence
      // The pid says a session's process is alive and nothing more. The record's `tmux` pane
      // is not carried: the one launcher left finds a session by its id (launchers.md).
      live.set(record.sessionId, {
        pid: record.pid,
        cwd: String(record.cwd || ''),
        startedAt: num(record.startedAt),
      })
    } catch {
      /* process is gone */
    }
  }
  return live
}

/** Every thread the desktop app has a record for. */
async function scanDesktopSessions() {
  const out = []
  for (const account of await listDirs(DESKTOP_SESSIONS)) {
    for (const org of await listDirs(account)) {
      for (const file of await listFiles(org, (n) => n.startsWith('local_') && n.endsWith('.json'))) {
        try {
          out.push(JSON.parse(await fsp.readFile(file, 'utf8')))
        } catch {
          /* a session mid-write — skip this pass */
        }
      }
    }
  }
  return out
}

/**
 * Two desktop records can point at one transcript — resuming a thread that is already
 * open makes the app write a second, untitled record. Keep the richer of the two.
 */
function mergeThread(existing, next) {
  const better = (a, b) => (a && a !== 'Untitled thread' ? a : b || a)
  // The titled record is the real thread; an untitled twin is the import ghost. Point
  // the canonical id at the real one, but keep both so archiving covers the ghost too.
  const keepExisting = existing.titled || !next.titled
  return {
    ...existing,
    ...next,
    title: better(existing.title, next.title),
    titled: existing.titled || next.titled,
    titleNamed: existing.titleNamed || next.titleNamed,
    preview: existing.preview || next.preview,
    desktopSessionId: keepExisting ? existing.desktopSessionId : next.desktopSessionId,
    desktopSessionIds: [...new Set([...existing.desktopSessionIds, ...next.desktopSessionIds])],
    bridgeSessionId: existing.bridgeSessionId || next.bridgeSessionId,
    model: existing.model || next.model,
    effort: existing.effort || next.effort,
    gitBranch: existing.gitBranch || next.gitBranch,
    cwd: existing.cwd || next.cwd,
    createdAt: Math.min(existing.createdAt || Infinity, next.createdAt || Infinity) || 0,
    lastActivityAt: Math.max(existing.lastActivityAt || 0, next.lastActivityAt || 0),
    lastFocusedAt: Math.max(existing.lastFocusedAt || 0, next.lastFocusedAt || 0),
    hasError: existing.hasError || next.hasError,
    hasLiveProcess: existing.hasLiveProcess || next.hasLiveProcess,
    starred: existing.starred || next.starred,
    cliTaskId: existing.cliTaskId || next.cliTaskId,
    prState: existing.prState || next.prState,
    archived: existing.archived && next.archived,
    hasTranscript: existing.hasTranscript || next.hasTranscript,
  }
}

/**
 * Fold the adapter's private bookkeeping into the shape the rest of the app sees.
 * The session ids stay, but behind `ref` — an opaque blob the browser hands straight
 * back on open/archive, so nothing outside this file has to know what a Claude session
 * id looks like.
 */
function toThread(t) {
  const { desktopSessionId, desktopSessionIds, cliSessionId, bridgeSessionId, titled, hasLiveProcess, pid, ...rest } = t
  return {
    ...rest,
    canArchive: desktopSessionIds.length > 0,
    // The session ids are what a launcher finds this session by (`sessionIdOf`). The pid is
    // left out: it is at most one scan stale, says only that a process was alive, and nothing
    // reaches a session by it.
    ref: { desktopSessionId, desktopSessionIds, cliSessionId },
  }
}

async function scanThreads() {
  const [desktop, transcripts, live, hooks] = await Promise.all([
    scanDesktopSessions(),
    scanTranscripts(),
    scanLiveSessions(),
    hookStates(),
  ])
  const byId = new Map()
  const add = (thread) => {
    const existing = byId.get(thread.id)
    byId.set(thread.id, existing ? mergeThread(existing, thread) : thread)
  }
  const claimed = new Set()

  for (const s of desktop) {
    const cliSessionId = s.cliSessionId || ''
    const entry = cliSessionId ? transcripts.get(cliSessionId) : null
    if (entry) claimed.add(cliSessionId)

    const cwd = s.cwd || s.originCwd || ''
    const { projectPath, project, worktree } = projectOf(cwd, s.originCwd)
    const meta = entry ? await transcriptMeta(entry) : null

    add({
      id: cliSessionId || s.sessionId,
      cliSessionId,
      desktopSessionId: s.sessionId || '',
      desktopSessionIds: s.sessionId ? [s.sessionId] : [],
      titled: Boolean(s.title),
      bridgeSessionId: (s.bridgeSessionIds && s.bridgeSessionIds[0]) || '',
      title: threadTitle(meta, s.title),
      titleNamed: namedByPerson(meta, s.title),
      preview: meta?.firstPrompt ? meta.firstPrompt.slice(0, 240) : '',
      project,
      projectPath,
      worktree,
      cwd,
      gitBranch: meta?.gitBranch || '',
      model: s.model || meta?.model || '',
      effort: s.effort || meta?.effort || '',
      context: meta?.context || 0,
      contextAt: meta?.contextAt || 0,
      createdAt: num(s.createdAt) || meta?.startedAt || 0,
      lastActivityAt: num(s.lastActivityAt) || num(s.lastFocusedAt) || num(s.createdAt) || 0,
      lastFocusedAt: num(s.lastFocusedAt),
      hasLiveProcess: live.has(cliSessionId),
      pid: live.get(cliSessionId)?.pid || 0,
      hasError: Boolean(s.error),
      starred: s.isStarred === true,
      cliTaskId: s.scheduledTaskId || '',
      prState: s.prState || '',
      archived: s.isArchived === true || s.isArchived === 'True',
      hasTranscript: Boolean(entry),
      sizeBytes: entry?.size || 0,
      source: 'desktop',
    })
  }

  // Transcripts with no desktop record — usually threads started straight from the terminal.
  for (const [id, entry] of transcripts) {
    if (claimed.has(id)) continue
    const meta = await transcriptMeta(entry)
    const cwd = meta.cwd || decodeProjectDir(path.basename(entry.projectDir))
    const { projectPath, project, worktree } = projectOf(cwd, '')
    add({
      id,
      cliSessionId: id,
      desktopSessionId: '',
      desktopSessionIds: [],
      titled: Boolean(meta.customTitle || meta.aiTitle),
      bridgeSessionId: '',
      title: threadTitle(meta),
      titleNamed: namedByPerson(meta),
      preview: meta.firstPrompt ? meta.firstPrompt.slice(0, 240) : '',
      project,
      projectPath,
      worktree,
      cwd,
      gitBranch: meta.gitBranch,
      model: meta.model,
      effort: meta.effort,
      context: meta.context,
      contextAt: meta.contextAt,
      createdAt: meta.startedAt || entry.mtime,
      // The newest stamped record, never the mtime while there is one (`lastStamp`).
      lastActivityAt: meta.lastStampAt || entry.mtime,
      lastFocusedAt: 0,
      hasLiveProcess: live.has(id),
      pid: live.get(id)?.pid || 0,
      hasError: false,
      starred: false,
      cliTaskId: '',
      prState: '',
      archived: false,
      hasTranscript: true,
      sizeBytes: entry.size,
      source: 'cli',
    })
  }

  // Sessions a hook has told us about but that have no transcript on disk yet: one just
  // launched and sitting at an empty prompt. Without this a new chat has no row until you
  // type the first thing into it, which is backwards — the point of starting a session
  // from the page is watching it arrive.
  for (const [id, hook] of hooks) {
    if (byId.has(id) || transcripts.has(id)) continue
    const cwd = hook.cwd || ''
    if (!cwd) continue
    const { projectPath, project, worktree } = projectOf(cwd, '')
    add({
      id,
      cliSessionId: id,
      desktopSessionId: '',
      desktopSessionIds: [],
      titled: false,
      bridgeSessionId: '',
      title: 'New session',
      titleNamed: false,
      preview: '',
      project,
      projectPath,
      worktree,
      cwd,
      gitBranch: '',
      model: '',
      effort: '',
      context: 0,
      contextAt: 0,
      createdAt: hook.startedAt || hook.updatedAt || 0,
      lastActivityAt: hook.updatedAt || 0,
      lastFocusedAt: 0,
      hasLiveProcess: live.has(id),
      pid: live.get(id)?.pid || 0,
      hasError: false,
      starred: false,
      cliTaskId: '',
      prState: '',
      archived: false,
      hasTranscript: false,
      sizeBytes: 0,
      source: 'cli',
    })
  }

  // The same case again, for a session no hook has reported either: the pass above depends on
  // `SessionStart` arriving, and that is the one event this harness cannot count on. It is not
  // delivered to an http hook at all (hooks.md), it is absent entirely in a repo where nobody
  // ran `yarn hooks`, and even where both hold it is a round trip behind the launch. The
  // registry file, by contrast, is written by the CLI itself at startup and carries the cwd —
  // enough to list the chat under the right workspace the moment the process exists.
  for (const [id, rec] of live) {
    if (byId.has(id) || transcripts.has(id) || hooks.has(id)) continue
    const cwd = rec.cwd
    if (!cwd) continue
    const { projectPath, project, worktree } = projectOf(cwd, '')
    add({
      id,
      cliSessionId: id,
      desktopSessionId: '',
      desktopSessionIds: [],
      titled: false,
      bridgeSessionId: '',
      title: 'New session',
      titleNamed: false,
      preview: '',
      project,
      projectPath,
      worktree,
      cwd,
      gitBranch: '',
      model: '',
      effort: '',
      context: 0,
      contextAt: 0,
      createdAt: rec.startedAt || 0,
      lastActivityAt: rec.startedAt || 0,
      lastFocusedAt: 0,
      hasLiveProcess: true,
      pid: rec.pid,
      hasError: false,
      starred: false,
      cliTaskId: '',
      prState: '',
      archived: false,
      hasTranscript: false,
      sizeBytes: 0,
      source: 'cli',
    })
  }

  const threads = [...byId.values()]
  // Read once for the whole roster: it is one small file and every thread that has not
  // answered yet wants the same answer out of it.
  const fallbackModel = await configuredModel()
  // Unread = the thread moved on after you last looked at it; never opened counts as unread.
  // Terminal-only threads have no focus history at all, so "unread" is unknowable — not true.
  const now = Date.now()
  for (const thread of threads) {
    // A session with no assistant record yet — just launched, sitting at its prompt — has no
    // observed model. The CLI's configured default is what it *will* answer on, which is the
    // thing worth knowing before you type; flagged as the guess it is.
    thread.modelAssumed = !thread.model && Boolean(fallbackModel)
    if (thread.modelAssumed) thread.model = fallbackModel

    thread.unread = thread.desktopSessionIds.length > 0 && thread.lastActivityAt > thread.lastFocusedAt
    thread.running = thread.hasLiveProcess && now - thread.lastActivityAt < ACTIVE_WINDOW_MS
    // A session that has written no transcript is not working however fresh its process is —
    // it is sitting at an empty prompt. Without this a just-launched chat reads `running`
    // before it has been given anything to do.
    if (!thread.hasTranscript) thread.running = false
    thread.done = false
    thread.turnEndedAt = 0
    // A turn that died of something that clears on its own — a rate limit, an overload.
    // Kept apart from `hasError` so the page can say "it stopped" without saying "it broke".
    thread.stalled = false
    thread.failure = null
    thread.activity = ''
    thread.ask = null
    thread.steps = 0
    thread.subagents = []
    thread.backgroundTasks = []

    // Hooks win outright wherever they have an opinion.
    //
    // Everything above is inference from a file that grew and a pid that still exists, which
    // cannot tell a session blocked on a permission prompt from one that finished a minute
    // ago from one sitting at an empty prompt. A hook was fired *by* the session at the
    // moment the thing happened, so where the two disagree the guess is simply wrong.
    //
    // Sessions in projects with no hooks installed keep the inference and lose nothing.
    const hook = hooks.get(thread.cliSessionId || thread.id)
    if (!hook) {
      // Running by inference alone, from a session no hook has ever reported: its repo has no
      // hooks, so the word will stay `running` for 30 minutes after it stopped (hooks.md). The
      // page says so rather than letting the row quietly lie.
      if (thread.running && !(await hookEverSeen(thread.cliSessionId || thread.id))) thread.noHooks = true
      continue
    }
    thread.running = hook.status === 'running'
    thread.unread = hook.status === 'waiting'
    thread.hasError = thread.hasError || hook.status === 'error'
    thread.stalled = hook.status === 'stalled'
    thread.failure = hook.failure || null
    thread.done = hook.status === 'done'
    // When the last turn ended, kept after reading it turns `done` into `idle` (hooks.md).
    thread.turnEndedAt = hook.turnEndedAt || 0
    // "Running Agent: count the words in hello" rather than "Running Agent". The description is
    // only kept for the tools where the name alone says nothing (hooks.md), so every other line
    // is exactly as it was.
    thread.activity = hook.message || (hook.tool ? `Running ${hook.tool}${hook.toolDetail ? `: ${hook.toolDetail}` : ''}` : '')
    // What it is waiting on you for, `{ kind, head }` or null: the chat list quotes `head` on a
    // row that needs you. A session Outpost started asks through the approval tool instead, and
    // the launcher's `annotate` puts its own over this (launchers.md).
    thread.ask = hook.status === 'waiting' ? { kind: hook.askKind === 'question' ? 'question' : 'permission', head: askHead(hook.message) } : null
    // Tool calls since the person last typed, the row's "step N" (hooks.md `steps`).
    thread.steps = Number.isInteger(hook.steps) ? hook.steps : 0
    // Which subagents it has out, `[{ id, type }]`, straight from the hook store (hooks.md):
    // the page counts them above the composer and names them in the agent map.
    thread.subagents = Array.isArray(hook.subagents) ? hook.subagents : []
    // What it left running in the background, `[{ id, type, description }]` (hooks.md): the
    // row's terminal mark, there whatever the status says.
    thread.backgroundTasks = Array.isArray(hook.backgroundTasks) ? hook.backgroundTasks : []
    // A hook event is activity, even when the transcript has not been flushed yet. Without
    // this a busy session whose .jsonl lags can cross the dormancy line and fall asleep on
    // its feet while it is working.
    thread.lastActivityAt = Math.max(thread.lastActivityAt, hook.updatedAt || 0)
  }
  return threads.map(toThread)
}

/** An ask's head is one line on a row: the same 140 as the launcher's (structured.mjs `askOf`). */
const ASK_HEAD_CAP = 140
/** A hook's message as an ask's head: its first line, at most `ASK_HEAD_CAP` chars. */
const askHead = (text) => String(text || 'Waiting on you').split('\n')[0].slice(0, ASK_HEAD_CAP)

/** Locate the desktop app's record for a session. Id is pattern-checked, never joined raw. */
async function findSessionFile(sessionId) {
  if (!DESKTOP_ID.test(sessionId)) return null
  for (const account of await listDirs(DESKTOP_SESSIONS)) {
    for (const org of await listDirs(account)) {
      const file = path.join(org, `${sessionId}.json`)
      if (await exists(file)) return file
    }
  }
  return null
}

/**
 * The wrappers the CLI folds into a prompt record around what the person actually typed:
 * system reminders, IDE selection context, slash-command echoes. Stripped for display,
 * whitespace kept — unlike `cleanPrompt`, which flattens for a one-line title.
 */
const PROMPT_WRAPPERS =
  /<(system-reminder|outpost-note|outpost-handoff|ide_selection|ide_opened_file|local-command-caveat|command-name|command-message|command-args|local-command-stdout|local-command-stderr)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g
const stripWrappers = (s) => String(s).replace(PROMPT_WRAPPERS, '').trim()

/**
 * Something Outpost itself sent a session and wants seen — a Jenkins build that woke the chat
 * — written as `<outpost-note tone="failure">…</outpost-note>`: `{ tone, text }`, or null. It
 * is drawn as a note in the log, never as a bubble of the person's: it arrives as a user
 * message, and drawn as one it reads as words they never typed (the `/addRepo` bug, bugs-fixed.md).
 */
function outpostNote(text) {
  const m = /<outpost-note(?:\s+tone="(\w+)")?>([\s\S]*?)<\/outpost-note>/.exec(String(text || ''))
  return m ? { tone: m[1] || 'info', text: m[2].trim() } : null
}

/**
 * The handoff a fresh conversation was started from (handoff.md), written as
 * `<outpost-handoff>…</outpost-handoff>` in its first prompt: the text, or null. Drawn under a
 * "Fresh start from handoff" divider, never as a bubble of the person's — Outpost sent it, and
 * a page of notes in the person's voice reads as something they pasted.
 */
function outpostHandoff(text) {
  const m = /<outpost-handoff>([\s\S]*?)<\/outpost-handoff>/.exec(String(text || ''))
  return m ? m[1].trim() : null
}

/**
 * A background agent's completion, which the CLI delivers to the session as a *user* message
 * wrapped in `<task-notification>`: the task id, the Agent call it answers, a status, a
 * one-line summary and the agent's final report. Nobody typed it, so it is not drawn as a
 * bubble; it goes to the Activity panel against the Agent row it belongs to (ui-details.md).
 * `null` for any other text.
 */
function taskNotification(text) {
  const s = String(text || '').trim()
  if (!s.startsWith('<task-notification>')) return null
  const field = (name) => {
    const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(s)
    return m ? m[1].trim() : ''
  }
  const summary = field('summary')
  // `Agent "Write the probe" finished` → `Write the probe · finished`, which reads as a row.
  const named = /^Agent "(.+)" (\w+)$/.exec(summary)
  return {
    toolUseId: field('tool-use-id'),
    taskId: field('task-id'),
    status: field('status') || 'completed',
    summary: named ? `${named[1]} · ${named[2]}` : summary,
    text: field('result'),
  }
}

/**
 * A completion's id, from the task rather than the record. The CLI sometimes writes one
 * notification twice — queued mid-turn, then again as a user record — and the page draws an
 * item once per id, so naming it by task and status is what keeps that to one marker.
 */
const doneId = (done, fallback) => (done.taskId ? `done:${done.taskId}:${done.status}` : fallback)

/**
 * Something that reached the session while it was mid-turn. The CLI does not write that as a
 * `user` record: it queues it and hands it to the model beside the next tool result, and what
 * lands in the transcript is an `attachment` of type `queued_command` — the only copy there
 * is. Read as a `user` record alone, a message typed into a working chat was answered and
 * never drawn, and a background agent that finished mid-turn never reached Activity.
 *
 * `prompt` is a string or a list of blocks. `commandMode` says who sent it: `prompt` is a
 * person, `task-notification` is the CLI. Anything else is not something somebody said.
 */
function queuedItem(r) {
  const a = r.attachment
  if (a?.type !== 'queued_command') return null
  const raw =
    typeof a.prompt === 'string'
      ? a.prompt
      : Array.isArray(a.prompt)
        ? a.prompt.map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text : '')).filter(Boolean).join('\n')
        : ''
  const ts = Date.parse(r.timestamp) || 0
  const id = `${r.uuid || ts}:0`
  const done = taskNotification(raw)
  if (done) return { id: doneId(done, id), ts, kind: 'agent_done', ...done }
  if (a.commandMode !== 'prompt') return null
  const note = outpostNote(raw)
  if (note) return { id, ts, kind: 'note', ...note }
  const text = stripWrappers(raw)
  return text ? { id, ts, role: 'user', kind: 'text', text } : null
}

/** How much of a tool result the conversation view carries. The rest is in the transcript. */
const RESULT_CHARS = 1500
/** The first load of a big transcript starts this far from the end, not at the beginning. */
const FIRST_LOAD_BYTES = 2 * 1024 * 1024
/** The least a caller may ask for as a page (`bytes`): a few records, not one line at a time. */
const PAGE_MIN_BYTES = 64 * 1024

/**
 * How many lines of an edit's diff travel to the page. A 2,000-line Write is not read in a
 * side panel; the transcript still has all of it.
 */
const DIFF_LINES = 300

/**
 * Lines of `a` and `b` as one list, each prefixed `' '`, `'-'` or `'+'` — the usual line
 * diff, by longest common subsequence, so an edit that moved one line reads as one line
 * moved rather than two blocks replaced. Past a size where the table would cost real memory
 * it falls back to "all of the old, then all of the new", which is still true.
 */
function lineDiff(a, b) {
  const A = a.split('\n')
  const B = b.split('\n')
  const n = A.length
  const m = B.length
  if (n * m > 250000) return [...A.map((s) => `-${s}`), ...B.map((s) => `+${s}`)]
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (A[i] === B[j]) out.push(` ${A[i++]}`), j++
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(`-${A[i++]}`)
    else out.push(`+${B[j++]}`)
  }
  while (i < n) out.push(`-${A[i++]}`)
  while (j < m) out.push(`+${B[j++]}`)
  return out
}

/**
 * The change an edit makes, for the tools that make one: `{ file, lines, truncated }` with
 * `lines` prefixed as `lineDiff` does and `'@'` between a MultiEdit's edits. A Write is all
 * additions. `null` for every other tool.
 */
function toolDiff(name, input) {
  if (!input || typeof input !== 'object') return null
  let lines
  if (name === 'Edit') lines = lineDiff(String(input.old_string ?? ''), String(input.new_string ?? ''))
  else if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    lines = []
    input.edits.forEach((e, k) => {
      if (k) lines.push('@ …')
      lines.push(...lineDiff(String(e?.old_string ?? ''), String(e?.new_string ?? '')))
    })
  } else if (name === 'Write') lines = String(input.content ?? '').split('\n').map((s) => `+${s}`)
  else return null
  const truncated = lines.length > DIFF_LINES
  return { file: String(input.file_path || ''), lines: truncated ? lines.slice(0, DIFF_LINES) : lines, truncated }
}

/** One line that says what a tool call was for, without the whole input. */
function toolSummary(name, input) {
  if (!input || typeof input !== 'object') return ''
  const one = (v) => String(v ?? '').split('\n')[0].slice(0, 160)
  switch (name) {
    case 'Bash':
      return one(input.description || input.command)
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return one(input.file_path || input.notebook_path)
    case 'Grep':
    case 'Glob':
      return one(input.pattern)
    case 'Agent':
    case 'Task':
      return one(input.description || input.prompt)
    case 'WebFetch':
    case 'WebSearch':
      return one(input.url || input.query)
    default: {
      const k = Object.keys(input)[0]
      if (!k) return ''
      const v = input[k]
      return one(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    }
  }
}

/** A tool result's text, whatever shape the block came in, capped for the wire. */
function resultText(content) {
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    text = content
      .map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : ''))
      .filter(Boolean)
      .join('\n')
  }
  text = text.trim()
  return text.length > RESULT_CHARS ? { text: text.slice(0, RESULT_CHARS), truncated: true } : { text, truncated: false }
}

/**
 * Transcript records -> the flat list the conversation view draws.
 *
 * A record is one API message, which may hold several blocks; each block that means
 * something to a reader becomes one item. Tool results are emitted as their own items keyed
 * by the tool-use id rather than folded into the call, because when the file is being tailed
 * the result usually arrives in a later read than the call did.
 *
 * Skipped on purpose: `isMeta` records (the CLI's own bookkeeping, hundreds of them),
 * sidechains (a subagent's transcript is a different conversation — unless this *is* that
 * transcript, where every record is one), and thinking blocks (empty on disk — the model's
 * reasoning is not stored).
 */
function toMessages(records, { sidechain = false } = {}) {
  const out = []
  for (const r of records) {
    if (r.isMeta || (r.isSidechain && !sidechain)) continue
    if (r.type === 'attachment') {
      const queued = queuedItem(r)
      if (queued) out.push(queued)
      continue
    }
    if (r.type !== 'user' && r.type !== 'assistant') continue
    const m = r.message
    if (!m) continue
    const ts = Date.parse(r.timestamp) || 0
    const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : []
    content.forEach((b, i) => {
      if (!b) return
      const block = typeof b === 'string' ? { type: 'text', text: b } : b
      const id = `${r.uuid || ts}:${i}`
      switch (block.type) {
        case 'text': {
          const done = r.type === 'user' ? taskNotification(block.text) : null
          if (done) {
            out.push({ id: doneId(done, id), ts, kind: 'agent_done', ...done })
            break
          }
          // The summary a session carries on from after its context ran out arrives as a user
          // message nobody typed. Drawn as a bubble it read as the person having pasted a
          // page of history; it is a marker that opens to the summary instead.
          if (r.type === 'user' && (r.isCompactSummary || /^This session is being continued from/.test(String(block.text || '').trim()))) {
            const text = String(block.text || '').trim()
            if (text) out.push({ id, ts, kind: 'compact', text })
            break
          }
          if (r.type === 'user' && INTERRUPTED.test(String(block.text || '').trim())) {
            out.push({ id: `${id}:note`, ts, kind: 'note', tone: 'info', text: 'Interrupted' })
            break
          }
          const note = r.type === 'user' ? outpostNote(block.text) : null
          if (note) out.push({ id: `${id}:note`, ts, kind: 'note', ...note })
          const handoff = r.type === 'user' ? outpostHandoff(block.text) : null
          if (handoff !== null) out.push({ id: `${id}:handoff`, ts, kind: 'handoff', text: handoff })
          const text = r.type === 'user' ? stripWrappers(block.text) : String(block.text || '').trim()
          if (text) out.push({ id, ts, role: r.type, kind: 'text', text })
          break
        }
        case 'tool_use': {
          const diff = toolDiff(block.name, block.input)
          out.push({
            id: block.id || id,
            ts,
            role: 'assistant',
            kind: 'tool',
            name: String(block.name || 'tool'),
            summary: toolSummary(block.name, block.input),
            detail: JSON.stringify(block.input ?? {}, null, 1).slice(0, 2000),
            ...(diff ? { diff } : {}),
          })
          break
        }
        case 'tool_result': {
          const { text, truncated } = resultText(block.content)
          out.push({ id: String(block.tool_use_id || id), ts, kind: 'tool_result', text, truncated, isError: Boolean(block.is_error) })
          break
        }
        case 'image':
          // The bytes stay in the file: the page asks for them by this id (`readImage`), so
          // a tail read never carries a megabyte of base64 nobody has looked at yet.
          out.push({ id, ts, role: r.type, kind: 'image' })
          break
        case 'document':
          // An attached PDF or text file is drawn by its name; its contents are the model's.
          out.push({ id, ts, role: r.type, kind: 'file', name: String(block.title || 'document').slice(0, 200) })
          break
        default:
          break
      }
    })
  }
  return out
}

/**
 * Bytes `[from, size)` of a file, trimmed to whole lines at both ends.
 *
 * Done on the buffer, not the decoded string, so the offsets handed back are byte offsets
 * the next call can resume from. The tail is cut at the last newline because the file may be
 * mid-write; the head is cut at the first newline only when the read had to start partway
 * through the file, in which case it started inside some record.
 */
async function readLines(file, from, maxBytes) {
  const fh = await fsp.open(file, 'r')
  try {
    const { size } = await fh.stat()
    let start = Math.max(0, from)
    if (start >= size) return { text: '', from: start, to: start, size, truncated: false }
    let truncated = false
    if (maxBytes && size - start > maxBytes) {
      start = size - maxBytes
      truncated = true
    }
    const buf = Buffer.allocUnsafe(size - start)
    const { bytesRead } = await fh.read(buf, 0, buf.length, start)
    let head = 0
    if (truncated) {
      const nl = buf.indexOf(0x0a)
      head = nl === -1 ? bytesRead : nl + 1
    }
    const lastNl = buf.lastIndexOf(0x0a, bytesRead - 1)
    const end = lastNl === -1 ? head : lastNl + 1
    return {
      text: end > head ? buf.subarray(head, end).toString('utf8') : '',
      from: start + head,
      to: start + Math.max(head, end),
      size,
      truncated,
    }
  } finally {
    await fh.close()
  }
}

/**
 * Up to `maxBytes` of whole lines ending at byte `before`, for reading a transcript backwards
 * a page at a time. `before` is a `from` an earlier read handed out, so it is a line start.
 *
 * The cut normally moves forward to the next line start. When no whole line follows it — one
 * record bigger than the page, as a pasted screenshot's base64 is — it moves back to the start
 * of that record instead, or the page would be empty and the reader would never get further.
 */
async function readLinesBefore(file, before, maxBytes) {
  const fh = await fsp.open(file, 'r')
  try {
    const { size } = await fh.stat()
    const end = Math.min(Math.max(0, before), size)
    const read = async (start) => {
      const buf = Buffer.allocUnsafe(end - start)
      const { bytesRead } = await fh.read(buf, 0, buf.length, start)
      return buf.subarray(0, bytesRead)
    }
    let start = Math.max(0, end - maxBytes)
    let buf = await read(start)
    let head = 0
    if (start > 0) {
      const nl = buf.indexOf(0x0a)
      head = nl === -1 ? buf.length : nl + 1
      if (head >= buf.length) {
        start = await lineStartBefore(fh, start)
        buf = await read(start)
        head = 0
      }
    }
    const lastNl = buf.lastIndexOf(0x0a)
    const tail = lastNl === -1 ? head : lastNl + 1
    return {
      text: tail > head ? buf.subarray(head, tail).toString('utf8') : '',
      from: start + head,
      to: start + Math.max(head, tail),
      size,
    }
  } finally {
    await fh.close()
  }
}

/** The start of the line byte `pos` is in, scanning back a block at a time. */
async function lineStartBefore(fh, pos) {
  const BLOCK = 64 * 1024
  const buf = Buffer.allocUnsafe(BLOCK)
  let at = pos
  while (at > 0) {
    const from = Math.max(0, at - BLOCK)
    const { bytesRead } = await fh.read(buf, 0, at - from, from)
    const nl = buf.subarray(0, bytesRead).lastIndexOf(0x0a)
    if (nl !== -1) return from + nl + 1
    at = from
  }
  return 0
}

/** A subagent id as the CLI writes it: short hex. Anything else never reaches a path. */
const AGENT_ID = /^[0-9a-f]{8,40}$/

/** Where a session's subagent transcripts live: beside the transcript, in a folder of its id. */
async function agentDirFor(sessionId) {
  const file = await transcriptFileFor(sessionId)
  return file ? path.join(path.dirname(file), sessionId, 'subagents') : ''
}

const statOf = (p) => fsp.stat(p).catch(() => null)

/**
 * The subagents a session has dispatched, each read off its own transcript: what it was
 * asked (the parent's Agent call, matched by prompt, says it in a line; the CLI's own record
 * of an async one says it too), the model it answered on, when it started and last moved,
 * how many turns it took and the context it was last carrying. Whether one is still running
 * is not knowable from a file and is left to the hooks (the thread's `subagents`).
 */
async function readAgents(ref) {
  const id = ref?.cliSessionId || ''
  const file = id ? await transcriptFileFor(id) : ''
  if (!file) return { ok: true, agents: [], missing: true }
  const dir = await agentDirFor(id)
  const names = (await fsp.readdir(dir).catch(() => [])).filter((n) => /^agent-[0-9a-f]+\.jsonl$/.test(n))
  if (!names.length) return { ok: true, agents: [], missing: false }

  const calls = [] // the parent's Agent calls, in order: { description, type, prompt, startedAt }
  const byId = new Map() // what the CLI recorded about an async agent, by its id
  const parent = await readLines(file, 0, 0)
  for (const r of jsonLines(parent.text)) {
    if (r.isSidechain) continue
    const content = Array.isArray(r.message?.content) ? r.message.content : []
    if (r.type === 'assistant') {
      for (const b of content) {
        if (b?.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task')) {
          calls.push({
            description: String(b.input?.description || ''),
            type: String(b.input?.subagent_type || ''),
            prompt: String(b.input?.prompt || ''),
            startedAt: Date.parse(r.timestamp) || 0,
          })
        }
      }
    } else if (r.type === 'user' && r.toolUseResult?.agentId) {
      byId.set(String(r.toolUseResult.agentId), { description: String(r.toolUseResult.description || ''), model: String(r.toolUseResult.resolvedModel || '') })
    }
  }

  const agents = []
  for (const name of names) {
    const agentId = name.slice('agent-'.length, -'.jsonl'.length)
    const chunk = await readLines(path.join(dir, name), 0, 0)
    let prompt = ''
    let model = ''
    let startedAt = 0
    let endedAt = 0
    let turns = 0
    let tokens = 0
    for (const r of jsonLines(chunk.text)) {
      const ts = Date.parse(r.timestamp) || 0
      if (ts) {
        if (!startedAt) startedAt = ts
        endedAt = Math.max(endedAt, ts)
      }
      if (r.type === 'user' && !prompt && typeof r.message?.content === 'string') prompt = r.message.content
      if (r.type === 'assistant') {
        turns += 1
        if (r.message?.model) model = String(r.message.model)
        const u = r.message?.usage
        if (u) tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0)
      }
    }
    const known = byId.get(agentId) || {}
    const call = prompt ? calls.find((c) => !c.used && c.prompt === prompt) : null
    if (call) call.used = true
    agents.push({
      id: agentId,
      description: known.description || call?.description || prompt.split('\n')[0].slice(0, 120),
      type: call?.type || '',
      model: known.model || model,
      startedAt: call?.startedAt || startedAt,
      endedAt,
      turns,
      tokens,
    })
  }
  agents.sort((a, b) => a.startedAt - b.startedAt)
  return { ok: true, agents, missing: false }
}

/** The texts a record can carry a `<task-notification>` in: a user prompt, a queued one, or the queue's own entry. */
function notificationTexts(r) {
  const out = []
  if (typeof r.content === 'string') out.push(r.content)
  if (typeof r.message?.content === 'string') out.push(r.message.content)
  const p = r.attachment?.type === 'queued_command' ? r.attachment.prompt : null
  if (typeof p === 'string') out.push(p)
  else if (Array.isArray(p)) for (const b of p) if (b?.type === 'text') out.push(String(b.text || ''))
  return out.filter((s) => s.includes('<task-notification>'))
}

/**
 * Every command the session sent to the background, for the commands map (ui-conversation.md):
 * the Bash call's command and description, when it went to the background, the in-container
 * file its output is written to and, once the CLI has said so, how it ended. Whether one is
 * still running is left to the hooks (`backgroundTasks`), as `readAgents` leaves it.
 */
async function readCommands(ref) {
  const id = ref?.cliSessionId || ''
  const file = id ? await transcriptFileFor(id) : ''
  if (!file) return { ok: true, commands: [], missing: true }
  const calls = new Map() // Bash tool_use id → { command, description }
  const byTask = new Map()
  const chunk = await readLines(file, 0, 0)
  for (const r of jsonLines(chunk.text)) {
    if (r.isSidechain) continue
    const ts = Date.parse(r.timestamp) || 0
    const content = Array.isArray(r.message?.content) ? r.message.content : []
    if (r.type === 'assistant') {
      for (const b of content) {
        if (b?.type === 'tool_use' && b.name === 'Bash') calls.set(b.id, { command: String(b.input?.command || ''), description: String(b.input?.description || '') })
      }
      continue
    }
    const taskId = r.type === 'user' ? r.toolUseResult?.backgroundTaskId : null
    if (taskId) {
      const result = content.find((b) => b?.type === 'tool_result')
      const text = typeof result?.content === 'string' ? result.content : ''
      const call = calls.get(result?.tool_use_id) || {}
      byTask.set(String(taskId), {
        id: String(taskId),
        command: call.command || '',
        description: call.description || '',
        startedAt: ts,
        outputFile: /Output is being written to: (\S+?\.output)/.exec(text)?.[1] || '',
        status: '',
        exitCode: null,
        endedAt: 0,
      })
      continue
    }
    for (const s of notificationTexts(r)) {
      const done = taskNotification(s)
      const cmd = done && byTask.get(done.taskId)
      if (!cmd || cmd.endedAt) continue
      const code = /exit code (\d+)/.exec(done.summary)
      cmd.status = done.status
      cmd.exitCode = code ? Number(code[1]) : null
      cmd.endedAt = ts
      cmd.outputFile ||= /<output-file>([^<]+)<\/output-file>/.exec(s)?.[1] || ''
    }
  }
  return { ok: true, commands: [...byTask.values()], missing: false }
}

/** The usage fields `readTokens` sums, as the API names them. */
const usageOf = (u) => ({
  input: num(u?.input_tokens),
  cacheWrite: num(u?.cache_creation_input_tokens),
  cacheWrite1h: num(u?.cache_creation?.ephemeral_1h_input_tokens),
  cacheRead: num(u?.cache_read_input_tokens),
  output: num(u?.output_tokens),
})

/** Field by field, the larger: a message written over several records may carry a growing count. */
function mergeUsage(into, u) {
  for (const k of Object.keys(u)) into[k] = Math.max(into[k] || 0, u[k])
}

const emptySpend = () => ({ turns: 0, input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 })

function addSpend(into, u) {
  into.turns += 1
  for (const k of ['input', 'cacheWrite', 'cacheWrite1h', 'cacheRead', 'output']) into[k] += u[k] || 0
}

/** Every text a user record carries: its string content, its text blocks and its tool results' text. */
function userTexts(r) {
  const c = r.message?.content
  if (typeof c === 'string') return [c]
  const out = []
  for (const b of Array.isArray(c) ? c : []) {
    if (b?.type === 'text') out.push(String(b.text || ''))
    else if (b?.type === 'tool_result') {
      if (typeof b.content === 'string') out.push(b.content)
      else for (const x of Array.isArray(b.content) ? b.content : []) if (x?.type === 'text') out.push(String(x.text || ''))
    }
  }
  return out
}

/** The bytes of text a tool result hands the model: its string, or its text blocks (an image is not text). */
function resultBytes(b) {
  if (typeof b.content === 'string') return Buffer.byteLength(b.content)
  let n = 0
  for (const x of Array.isArray(b.content) ? b.content : []) if (x?.type === 'text') n += Buffer.byteLength(String(x.text || ''))
  return n
}

/**
 * Tool traffic, for sizing what each tool hands back (usage.md): `names` maps a tool_use id to
 * its tool as the assistant calls it, `sizes` a tool_use id to its result's bytes — by id, so a
 * record written twice is counted once — and `loaded` the tools tool search fetched the schema
 * of (its `tool_reference` blocks), which is when a deferred tool's description starts being paid.
 */
const newToolTraffic = () => ({ names: new Map(), sizes: new Map(), loaded: new Set() })

function noteToolTraffic(t, r) {
  const c = r.message?.content
  if (!Array.isArray(c)) return
  for (const b of c) {
    if (r.type === 'assistant' && b?.type === 'tool_use') t.names.set(String(b.id || ''), String(b.name || ''))
    else if (r.type === 'user' && b?.type === 'tool_result') {
      t.sizes.set(String(b.tool_use_id || ''), resultBytes(b))
      for (const x of Array.isArray(b.content) ? b.content : []) if (x?.type === 'tool_reference' && x.tool_name) t.loaded.add(String(x.tool_name))
    }
  }
}

/** Result sizes by tool name, from the traffic noted; a result whose call was not seen is `?`. */
function toolResultsOf(t) {
  const results = {}
  for (const [id, bytes] of t.sizes) (results[t.names.get(id) || '?'] ||= []).push(bytes)
  return { results, loaded: [...t.loaded] }
}

/** `readTokens` answers, by transcript, while its file and its subagents' folder are unchanged. */
const tokenCache = new Map()

/**
 * What a session has spent, off its transcript: every API request the main conversation made
 * (`requests`, oldest first), what its subagents spent in sum, the CLI's own running tally when
 * it wrote one, and how many user records open with each of `markers` — the caller's words for
 * things it sent the session, so this file never learns them.
 *
 * One request is one message id. The CLI writes a message as one record per content block, each
 * carrying the same usage, so summing records counts a ten-block answer ten times: deduplicated
 * here, field by field the larger. A `<synthetic>` message is the CLI's own, never a request.
 * `cli` is the `cost-state` record, the last one per process start: it counts what the
 * transcript cannot see — subagents, and small requests of the CLI's own on other models — so
 * it is a cross-check and a cost, not the source of the split. `tools` is every tool result's
 * size by tool, the main conversation's and its subagents' together, and the tools whose schema
 * tool search fetched (`toolResultsOf`).
 *
 * Read whole, as `readPrompts` is, and cached against size and mtime: a 12 MB transcript is a
 * read when it moved and a `stat` when it did not.
 */
async function readTokens(ref, { markers = {} } = {}) {
  const id = ref?.cliSessionId || ''
  const file = id ? await transcriptFileFor(id) : ''
  if (!file) return { ok: true, missing: true, requests: [], subagents: { agents: 0, ...emptySpend() }, cli: null, marks: {}, notes: 0, tools: { results: {}, loaded: [] } }
  const dir = await agentDirFor(id)
  const [st, dst] = await Promise.all([statOf(file), statOf(dir)])
  const key = `${st?.size}:${st?.mtimeMs}:${dst?.mtimeMs || 0}:${JSON.stringify(markers)}`
  const hit = tokenCache.get(file)
  if (hit?.key === key) return hit.value

  const byId = new Map() // message id -> the request, main conversation only
  const side = new Map() // message id -> usage, sidechains written into this file by older CLIs
  const costs = new Map() // process start -> its last cost-state
  const marks = Object.fromEntries(Object.keys(markers).map((k) => [k, 0]))
  let notes = 0
  const traffic = newToolTraffic()
  for (const line of (await fsp.readFile(file, 'utf8')).split('\n')) {
    // Most of a transcript is tool traffic; only these three kinds say anything here.
    if (!line.includes('"assistant"') && !line.includes('"user"') && !line.includes('"cost-state"')) continue
    let r
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    noteToolTraffic(traffic, r)
    if (r.type === 'cost-state') {
      costs.set(String(r.startTime || ''), r)
    } else if (r.type === 'assistant' && r.message?.usage && r.message.model !== '<synthetic>') {
      const u = usageOf(r.message.usage)
      const mid = String(r.message.id || r.uuid || '')
      const into = r.isSidechain ? side : byId
      const had = into.get(mid)
      if (had) mergeUsage(had, u)
      else into.set(mid, { at: Date.parse(r.timestamp) || 0, model: String(r.message.model || ''), effort: String(r.effort || ''), ...u })
    } else if (r.type === 'user' && !r.isSidechain) {
      for (const text of userTexts(r)) {
        let t = text.trimStart()
        if (t.startsWith('<outpost-note')) {
          notes += 1
          t = t.replace(/^<outpost-note[^>]*>/, '')
        }
        for (const [name, lead] of Object.entries(markers)) if (lead && t.startsWith(lead)) marks[name] += 1
      }
    }
  }

  const subagents = { agents: 0, ...emptySpend() }
  for (const u of side.values()) addSpend(subagents, u)
  const names = (await fsp.readdir(dir).catch(() => [])).filter((n) => /^agent-[0-9a-f]+\.jsonl$/.test(n))
  subagents.agents = names.length
  for (const name of names) {
    const seen = new Map()
    const chunk = await readLines(path.join(dir, name), 0, 0)
    for (const r of jsonLines(chunk.text)) {
      noteToolTraffic(traffic, r)
      if (r.type !== 'assistant' || !r.message?.usage || r.message.model === '<synthetic>') continue
      const mid = String(r.message.id || r.uuid || '')
      const u = usageOf(r.message.usage)
      if (seen.has(mid)) mergeUsage(seen.get(mid), u)
      else seen.set(mid, u)
    }
    for (const u of seen.values()) addSpend(subagents, u)
  }

  let cli = null
  for (const c of costs.values()) {
    cli ||= { costUSD: 0, models: {} }
    cli.costUSD += Number(c.totalCostUSD) || 0
    for (const [model, m] of Object.entries(c.modelUsage || {})) {
      const into = (cli.models[model] ||= { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, costUSD: 0 })
      into.input += num(m?.inputTokens)
      into.cacheWrite += num(m?.cacheCreationInputTokens)
      into.cacheRead += num(m?.cacheReadInputTokens)
      into.output += num(m?.outputTokens)
      into.costUSD += Number(m?.costUSD) || 0
    }
  }

  const value = { ok: true, missing: false, requests: [...byId.values()], subagents, cli, marks, notes, tools: toolResultsOf(traffic) }
  tokenCache.set(file, { key, value })
  return value
}

/** How many versions of one path travel to the page: the newest ones. */
const FILE_VERSIONS = 20
/** The most of one Write's content served to the page; a report is read there, not a dump. */
const FILE_BYTES = 512 * 1024
/** A tool-use id as the CLI writes it, checked before it is searched for on a raw buffer. */
const TOOL_USE_ID = /^toolu_[A-Za-z0-9_-]{4,80}$/

/** A mentioned or written path as one key: absolute, from the session's cwd; `''` for one that cannot be placed. */
function placePath(p, cwd) {
  const s = String(p || '')
  if (!s || s.startsWith('~')) return ''
  if (s.startsWith('/')) return path.normalize(s)
  return cwd ? path.resolve(cwd, s) : ''
}

/**
 * The files a session wrote with its Write tool or named in an answer, for the Files section
 * (ui-details.md): one entry per path with `writes` — each Write's tool-use id, time and size,
 * newest first, the last `FILE_VERSIONS` — and `mentionedAt`, when an answer last named the
 * path, and `mentions`. The transcript is the record: a Write carries the whole file, so every
 * version a session wrote is still here after its container is gone, and a mention is how a
 * session says "read this" — no marker and no rule, so it costs a session nothing. Whether the
 * file is on disk now is the workspace layer's to say (workspaces.md *Files*). Only the main
 * conversation's answers: a subagent's Writes are in its own transcript. The whole file is read
 * and the answer cached against its size and mtime, like `readTokens`.
 */
const filesCache = new Map()
async function readFiles(ref, { cwd = '' } = {}) {
  const id = ref?.cliSessionId || ''
  const file = id ? await transcriptFileFor(id) : ''
  if (!file) return { ok: true, files: [], missing: true }
  const st = await statOf(file)
  const key = `${st?.size}:${st?.mtimeMs}:${cwd}`
  const hit = filesCache.get(file)
  if (hit?.key === key) return hit.value

  const byPath = new Map()
  const entry = (p) => {
    let e = byPath.get(p)
    if (!e) byPath.set(p, (e = { path: p, writes: [], mentions: 0, mentionedAt: 0 }))
    return e
  }
  for (const line of (await fsp.readFile(file, 'utf8')).split('\n')) {
    // Only the session's own records say anything here; most of the file is the other side.
    if (!line.includes('"type":"assistant"')) continue
    let r
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    if (r.type !== 'assistant' || r.isSidechain || !Array.isArray(r.message?.content)) continue
    const ts = Date.parse(r.timestamp) || 0
    for (const b of r.message.content) {
      if (b?.type === 'tool_use' && b.name === 'Write' && b.input?.file_path) {
        const p = placePath(b.input.file_path, cwd)
        if (p) entry(p).writes.push({ id: String(b.id || ''), at: ts, bytes: Buffer.byteLength(String(b.input.content ?? '')) })
      } else if (b?.type === 'text' && typeof b.text === 'string') {
        for (const m of pathMentions(b.text)) {
          const p = placePath(m.path, cwd)
          if (!p) continue
          const e = entry(p)
          e.mentions += 1
          if (ts > e.mentionedAt) e.mentionedAt = ts
        }
      }
    }
  }
  const files = [...byPath.values()].map((e) => ({ ...e, writes: e.writes.slice(-FILE_VERSIONS).reverse() }))
  const value = { ok: true, files, missing: false }
  filesCache.set(file, { key, value })
  return value
}

/**
 * One Write's content out of the transcript, by the tool-use id `readFiles` listed: `{ ok,
 * path, text, at, bytes, truncated }`. Found the way `readImage` finds a record — the id on
 * the raw buffer, that one line parsed — since a session's transcript is megabytes and one
 * version is one line of it.
 */
async function readFileVersion(ref, id) {
  const none = { ok: false, error: 'That version is not in the transcript' }
  const file = TOOL_USE_ID.test(String(id || '')) ? await transcriptFileOf(ref) : ''
  if (!file) return none
  const buf = await fsp.readFile(file)
  const needle = Buffer.from(`"id":"${id}"`)
  let at = buf.indexOf(needle)
  while (at !== -1) {
    const start = buf.lastIndexOf(0x0a, at) + 1
    const nl = buf.indexOf(0x0a, at)
    const end = nl === -1 ? buf.length : nl
    try {
      const r = JSON.parse(buf.subarray(start, end).toString('utf8'))
      const block = r.type === 'assistant' && Array.isArray(r.message?.content) ? r.message.content.find((b) => b?.type === 'tool_use' && b.id === id) : null
      if (block) {
        if (block.name !== 'Write' || !block.input?.file_path) return none
        const text = String(block.input.content ?? '')
        const bytes = Buffer.byteLength(text)
        const truncated = bytes > FILE_BYTES
        return { ok: true, path: String(block.input.file_path), text: truncated ? Buffer.from(text).subarray(0, FILE_BYTES).toString('utf8') : text, at: Date.parse(r.timestamp) || 0, bytes, truncated }
      }
    } catch {
      /* a line being written right now, or not a record at all — keep looking */
    }
    at = buf.indexOf(needle, end)
  }
  return none
}

/** One prompt's worth for naming a chat; a pasted log past this says nothing more about the subject. */
const PROMPT_CHARS = 600

/**
 * What the person has asked, oldest first: `{ ok, first, recent }`, `first` the opening
 * prompt and `recent` up to `limit` real prompts from the end, each cut to 600 characters. The
 * same filter as the title (`promptText`), so a setup note, a tool result or a `/` command is
 * not something the chat is about. Read for automatic naming (titles.mjs).
 *
 * The whole file, not a tail: a working session writes megabytes of tool traffic between two
 * things the person said, and a 512 KB tail of this very feature's chat held no prompt at all.
 * Only lines that can be a typed prompt are parsed, and it runs at most once per chat per ten
 * minutes, so a 12 MB transcript costs one read on that schedule.
 */
async function readPrompts(ref, { limit = 6 } = {}) {
  const file = ref?.cliSessionId ? await transcriptFileFor(ref.cliSessionId) : ''
  if (!file) return { ok: false, first: '', recent: [] }
  const prompts = []
  for (const line of (await fsp.readFile(file, 'utf8')).split('\n')) {
    if (!line.includes('"type":"user"') || line.includes('"tool_use_id"')) continue
    try {
      const text = promptText(JSON.parse(line))
      if (text) prompts.push(text)
    } catch {
      /* the line being written right now */
    }
  }
  const cut = (s) => (s.length > PROMPT_CHARS ? s.slice(0, PROMPT_CHARS) + '…' : s)
  return { ok: true, first: cut(prompts[0] || ''), recent: prompts.slice(1).slice(-limit).map(cut) }
}

/** Where a session's transcript is, found by walking the projects dir; cached briefly. */
let transcriptIndex = { at: 0, byId: new Map() }
async function transcriptFileFor(sessionId) {
  if (!UUID.test(sessionId)) return ''
  if (Date.now() - transcriptIndex.at > 10000 || !transcriptIndex.byId.has(sessionId)) {
    transcriptIndex = { at: Date.now(), byId: await scanTranscripts() }
  }
  return transcriptIndex.byId.get(sessionId)?.file || ''
}

/** The file a `ref` reads: the session's transcript, or with `agentId` that subagent's own (readAgents). */
async function transcriptFileOf(ref) {
  const id = ref?.cliSessionId || ''
  const agentId = ref?.agentId ? String(ref.agentId) : ''
  if (id && agentId) {
    const dir = AGENT_ID.test(agentId) ? await agentDirFor(id) : ''
    const candidate = dir ? path.join(dir, `agent-${agentId}.jsonl`) : ''
    return candidate && (await statOf(candidate)) ? candidate : ''
  }
  return id ? transcriptFileFor(id) : ''
}

/** What an image block may be served as. Anything else in `media_type` is not sent to a browser. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
/** An image item's id, as `toMessages` made it: the record's uuid and the block's index. */
const IMAGE_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d{1,4})$/i

/**
 * One image out of the conversation, as bytes: `{ ok, type, bytes }`.
 *
 * The transcript is where an attached image lives — the CLI writes the block whole, base64
 * and all — so this is the copy that is still there from another device, after the uploads
 * folder is tidied, and for an image that never came through Outpost. `id` is the item id
 * `readTranscript` handed out. The record is found by its uuid on the raw buffer and only
 * that one line is parsed; parsing a whole transcript to pull one picture out of it would
 * cost seconds on a long session. A uuid quoted inside another record's text is escaped
 * there and cannot match, and the parsed record is checked anyway.
 */
async function readImage(ref, id) {
  const none = { ok: false, error: 'That image is not in the transcript' }
  const m = IMAGE_ID.exec(String(id || ''))
  const file = m ? await transcriptFileOf(ref) : ''
  if (!file) return none
  const buf = await fsp.readFile(file)
  const needle = Buffer.from(`"uuid":"${m[1]}"`)
  let at = buf.indexOf(needle)
  while (at !== -1) {
    const start = buf.lastIndexOf(0x0a, at) + 1
    const nl = buf.indexOf(0x0a, at)
    const end = nl === -1 ? buf.length : nl
    try {
      const r = JSON.parse(buf.subarray(start, end).toString('utf8'))
      const block = r.uuid === m[1] && Array.isArray(r.message?.content) ? r.message.content[Number(m[2])] : null
      if (block?.type === 'image') {
        const type = String(block.source?.media_type || '').toLowerCase()
        if (block.source?.type !== 'base64' || !IMAGE_TYPES.has(type)) return none
        const bytes = Buffer.from(String(block.source.data || ''), 'base64')
        return bytes.length ? { ok: true, type, bytes } : none
      }
    } catch {
      /* a line being written right now, or not a record at all — keep looking */
    }
    at = buf.indexOf(needle, end)
  }
  return none
}

/**
 * The conversation, as items for the page, from byte `after` onwards — or, with `before`,
 * the page of it that ends there.
 *
 * `after` is the `offset` a previous call returned, so the page tails the file by asking
 * for what is new rather than re-reading a growing transcript every two seconds. A first
 * load of a large file starts `bytes` (at most `FIRST_LOAD_BYTES`) from the end and says so;
 * a tail read is never truncated, since skipping bytes there would drop messages silently.
 * `start` is where the answer begins, the `before` that reads the page above it.
 */
async function readTranscript(ref, { after = 0, before = 0, bytes = 0 } = {}) {
  const agentId = ref?.agentId ? String(ref.agentId) : ''
  const file = await transcriptFileOf(ref)
  if (!file) return { ok: true, messages: [], offset: 0, start: 0, size: 0, missing: true, truncated: false }
  const page = bytes > 0 ? Math.min(FIRST_LOAD_BYTES, Math.max(PAGE_MIN_BYTES, bytes)) : FIRST_LOAD_BYTES
  const chunk =
    before > 0
      ? await readLinesBefore(file, before, page)
      : await readLines(file, after > 0 ? after : 0, after > 0 ? 0 : page)
  return {
    ok: true,
    messages: toMessages(jsonLines(chunk.text), { sidechain: Boolean(agentId) }),
    offset: chunk.to,
    start: chunk.from,
    size: chunk.size,
    truncated: chunk.from > 0 && !(after > 0),
    missing: false,
  }
}

/**
 * Flip `isArchived` on the desktop app's own session record — the same field its
 * Archived list reads. Only that one key is touched; everything else is written back
 * byte-for-byte from what was there, through a temp file so a crash can't truncate it.
 */
async function setSessionArchived(sessionId, archived) {
  const file = await findSessionFile(sessionId)
  if (!file) return { ok: false, error: 'No Claude Code session record for that thread' }

  let record
  try {
    record = JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return { ok: false, error: 'Session record is unreadable' }
  }
  if (!record || typeof record !== 'object' || record.sessionId !== sessionId) {
    return { ok: false, error: 'Session record did not look like the expected session' }
  }

  record.isArchived = Boolean(archived)
  const tmp = `${file}.outpost.tmp`
  await fsp.writeFile(tmp, JSON.stringify(record, null, 2))
  await fsp.rename(tmp, file)
  metaCache.delete(record.cliSessionId)
  return { ok: true, file, archived: Boolean(archived) }
}

/**
 * Archive every record that maps to a thread — the real one and any import ghosts. `none`
 * tells a thread with no record to flip (every CLI session) from a record that would not
 * write, so the caller can stay quiet about the first and report the second.
 */
async function setArchived(ref, archived) {
  const ids = ref?.desktopSessionIds || []
  if (!ids.length) return { ok: false, none: true, error: 'No session records for that thread' }
  const results = []
  for (const id of ids) results.push(await setSessionArchived(id, archived))
  const ok = results.some((r) => r.ok)
  return ok
    ? { ok, archived: Boolean(archived), records: results.filter((r) => r.ok).length }
    : results[0] || { ok: false, error: 'No session records for that thread' }
}

/** Outpost answered or interrupted this session itself; see hooks.mjs `markIdle`. */
const noteIdle = (ref) => (UUID.test(ref?.cliSessionId || '') ? markIdle(ref.cliSessionId) : null)

/**
 * The id this session's hooks report under, or `''`. The one thing that opens a `ref` for
 * anything keyed on hook state — the retry supervisor — without that caller having to know
 * what a Claude Code session id looks like. It returns the id rather than doing the work, so
 * nothing here has to import a module that imports the scan.
 */
const sessionIdOf = (ref) => (UUID.test(ref?.cliSessionId || '') ? ref.cliSessionId : '')

export default {
  id: 'claude-code',
  name: 'Claude Code',
  /** Only claim this machine if one of the two stores is actually there. */
  detect: async () => (await exists(DESKTOP_SESSIONS)) || (await exists(CLI_PROJECTS)),
  scanThreads,
  setArchived,
  readTranscript,
  toMessages,
  readImage,
  readAgents,
  readCommands,
  readFiles,
  readFileVersion,
  readPrompts,
  readTokens,
  noteIdle,
  sessionIdOf,
  paths: { DESKTOP_SESSIONS, CLI_PROJECTS, CLI_LIVE },
}
