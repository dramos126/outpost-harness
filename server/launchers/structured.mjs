/**
 * The structured launcher: a session as a process under a transient systemd user unit,
 * reading prompts from a FIFO and writing its stream to a file, with Outpost as its
 * approval surface.
 *
 * What the phase 0 spike proved (docs/proposals/harness.md): `claude -p --input-format
 * stream-json --output-format stream-json` streams every token and tool call as data, fires
 * the same hooks a TUI session does, and outlives the process that started it when that is
 * `systemd-run --user`. What this module adds is the rest of a launcher: typing is a JSON
 * line into the FIFO, interrupting is a control request, the model is a control request, a
 * permission prompt is the CLI calling Outpost's `approve` tool and waiting for the answer the
 * page gives, and ending is `systemctl --user stop`. No pane is ever read.
 *
 * The transcript is the CLI's as ever — the harness reads it, the conversation panel tails it
 * — so nothing above this module changes shape. A session id is learned from the stream's
 * first `init` line and is how the router (index.mjs) knows a thread is one of these.
 *
 * Only workspaces start sessions this way: the approval tool reaches a session through its
 * workspace's MCP token, so a session with no workspace has no approval surface here.
 */
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { readJsonFile } from '../lib/fsutil.mjs'
import { ONE_COMMAND_RULE, refusalFor } from './compound.mjs'
import { REPLY_RULE } from './reply.mjs'
import { CLAUDE_ENV_FILE } from '../claude-auth.mjs'
import { uploadTitle } from '../uploads.mjs'
import { CLAUDE_IN, ensureProjectMounts, podmanArgs, removeSessionContainers } from '../containers/index.mjs'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.OUTPOST_DATA || path.join(here, '..', '..', 'data')
const REGISTRY = path.join(DATA_DIR, 'structured.json')
export const SESSIONS_DIR = process.env.OUTPOST_SESSIONS || path.join(os.homedir(), '.outpost', 'sessions')
const CLAUDE_BIN = process.env.OUTPOST_CLAUDE_BIN || 'claude'

/** A permission question nobody answers is denied after this long; a chat is not a queue. */
export const ASK_TIMEOUT_MS = 10 * 60 * 1000
/**
 * A chain put to the person in a free-Bash chat waits this long, not ten minutes: the session has
 * a way on without anyone — the same commands one per call — so it is not held for long.
 */
const CHAIN_ASK_MS = 2 * 60 * 1000

/**
 * The answer to a chain in a free-Bash chat that nobody approved, scoped to that one call. That
 * chat is never told the one-command rule (`start`), and the refusal's "Outpost takes one command
 * per Bash call" read as a rule for the whole chat, so a session would stop chaining for good
 * over one call the CLI happened to escalate.
 */
const splitThisChain = (why) => `${why}, so this chain did not run. Run its commands one per Bash call this time; chains are otherwise fine in this chat.`
/** How far back in the stream the `init` line is looked for. It is the first line, but a tail read is cheap. */
const INIT_SCAN_BYTES = 64 * 1024

/** @type {Map<string, object> | null} id -> record */
let records = null
/** @type {Map<string, Array<{ ask: object, resolve: Function, timer: any, key: string }>>} workspaceId -> the requests standing, oldest first */
const pending = new Map()
/** Tool calls a person said "always" to, per session: `tool\u0000input-json`. */
const always = new Map()
let writing = Promise.resolve()

async function load() {
  if (records) return records
  // A registry that will not parse is set aside, not read as "none yet": the next launch
  // saved one record over all of them. Set aside rather than thrown, because every chat goes
  // through here and a launcher that refuses to load is no chats at all.
  const raw = await readJsonFile(REGISTRY, { aside: true })
  const loaded = new Map()
  for (const [id, rec] of Object.entries(raw?.sessions || {})) loaded.set(id, rec)
  records = loaded
  return records
}

function persist() {
  const snapshot = JSON.stringify({ version: 1, sessions: Object.fromEntries(records) }, null, 2)
  writing = writing.then(async () => {
    try {
      await fsp.mkdir(DATA_DIR, { recursive: true })
      const tmp = `${REGISTRY}.tmp`
      await fsp.writeFile(tmp, snapshot)
      await fsp.rename(tmp, REGISTRY)
    } catch {
      /* a lost write costs a record after a restart, never a session */
    }
  })
  return writing
}

const unitName = (id) => `outpost-session-${id}`

async function systemctl(...args) {
  // A stop changes what is running: the snapshot `isLive` reads must not outlive it.
  if (args[0] === 'stop') liveUnits = null
  try {
    const { stdout } = await execFileAsync('systemctl', ['--user', ...args], { timeout: 20000 })
    return stdout.trim()
  } catch (err) {
    return String(err?.stdout || '').trim()
  }
}

/** How long one read of the running units answers every `isLive` asked after it. */
const LIVE_UNITS_MS = 1000
/** @type {{ at: number, units: Set<string> } | null} the session units running, as last read */
let liveUnits = null
/** @type {Promise<Set<string> | null> | null} the read under way, shared by everyone asking meanwhile */
let readingUnits = null

/**
 * The session units running now, one `systemctl list-units` for all of them; null when it
 * would not read. Asking `is-active` per record on every roster scan was a process per chat
 * Outpost ever started (140 of them) several times a second, which with systemd's answers
 * held a core busy (2026-10-15).
 */
async function runningUnits() {
  if (liveUnits && Date.now() - liveUnits.at < LIVE_UNITS_MS) return liveUnits.units
  readingUnits ||= (async () => {
    try {
      const { stdout } = await execFileAsync('systemctl', ['--user', 'list-units', '--type=service', '--state=active', '--plain', '--no-legend', '--no-pager', `${unitName('*')}.service`], { timeout: 20000 })
      const units = new Set(stdout.split('\n').map((l) => l.trim().split(/\s+/)[0].replace(/\.service$/, '')).filter(Boolean))
      liveUnits = { at: Date.now(), units }
      return units
    } catch {
      return null
    } finally {
      readingUnits = null
    }
  })()
  return readingUnits
}

/**
 * The variables safe to hand systemd-run as `-p Environment=K=V` and podman as `--env K`: a key
 * that is a variable name, a value with no line break or NUL. One that is not is left out and
 * said in the log — a newline in a unit property would start another property (an
 * `ExecStartPre=` of its own making), and a key like `-x` would read as a flag. Nothing outside
 * Outpost reaches `env` today; this keeps it so if that changes.
 */
export function unitEnvOf(env) {
  const out = {}
  for (const [k, v] of Object.entries(env)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !/[\r\n\0]/.test(String(v))) out[k] = v
    else console.warn(`[outpost] session environment ${JSON.stringify(k)} left out: not a variable name, or a value with a line break`)
  }
  return out
}

/**
 * Start a session. `args` are the CLI's own (`--model`, `--permission-mode`, `--add-dir`,
 * `--mcp-config`); the stream flags, the approval tool and the one-command rule are added here. Returns the record;
 * the session id arrives in the stream a moment later (`sessionIdOf`).
 *
 * `bashFree` is a chat where Bash runs without asking (launchers.md): the one-command rule is
 * not appended — with every Bash allowed it can never become a prompt, so the chain refusal it
 * explains is never reached — and the flag rides on the record so a restart keeps it.
 */
/** `--append-system-prompt <text>`, or nothing when there is no text (a free-Bash chat with no rules). */
const appendRules = (text) => (text ? ['--append-system-prompt', text] : [])

export async function start({ dir, args = [], env = {}, workspaceId = '', approvalTool = '', rules = '', container = null, bashFree = false }) {
  await load()
  const id = randomBytes(4).toString('hex')
  const sdir = path.join(SESSIONS_DIR, id)
  await fsp.mkdir(sdir, { recursive: true, mode: 0o700 })
  const fifo = path.join(sdir, 'in')
  await execFileAsync('mkfifo', ['-m', '600', fifo])
  const cli = [
    container ? CLAUDE_IN : CLAUDE_BIN,
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    // The approval tool is the CLI's to call, never the model's. The CLI keeps it from the main
    // conversation itself but offers it to every subagent, which could then put a question of
    // its own making on the person's bar. A disallow rule hides it from both and does not stop
    // the CLI calling it as the prompt tool (launchers.md).
    ...(approvalTool ? ['--permission-prompt-tool', approvalTool, '--disallowedTools', approvalTool] : ['--permission-prompts', 'none']),
    // Added here rather than kept in `args`, so a restart in place does not stack a second copy.
    // `rules` is the caller's standing instructions (workspaces' `WORK_RULE`), in the same one
    // flag: kept on the record, so a restart gives them again. A free-Bash chat drops the
    // one-command rule, which is only about Bash becoming a prompt (launchers.md). The reply
    // rule goes to every session.
    ...appendRules([REPLY_RULE, bashFree ? '' : ONE_COMMAND_RULE, rules].filter(Boolean).join('\n\n')),
    ...args,
  ]
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`
  // The approval tool's call stays open while a person decides; the CLI's own tool timeout
  // must outlast that, or every unanswered minute is a denial it did not mean. It has two:
  // the overall one, and an idle one that aborts a call silent for 300 s whatever the first
  // says — which cut a standing prompt off at five minutes as a tool error, not a denial.
  const patience = String(ASK_TIMEOUT_MS + 30000)
  const unitEnv = unitEnvOf({ DISABLE_AUTOUPDATER: '1', MCP_TOOL_TIMEOUT: patience, CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: patience, ...env })
  // In a container the same CLI runs inside `podman run` (containers/index.mjs): stdin, the
  // stream and the log are still this script's, so nothing that reads them changes. The
  // unit's variables and the sign-in are passed through by name — one the unit lacks stays out.
  const runner = container
    ? [
        'podman',
        ...podmanArgs({
          name: `outpost-session-${id}`,
          image: container.image,
          mounts: container.mounts,
          workdir: dir,
          passEnv: ['HOME', ...Object.keys(unitEnv), 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
          env: container.env || {},
          labels: { 'outpost.workspace': workspaceId || 'none', 'outpost.session': id },
          // Private network and the chat's assigned host ports, when the plan carries them
          // (containers/index.mjs). A restart keeps them: they ride on the record's `container`.
          network: container.network || 'host',
          publish: container.publish || [],
        }),
        ...cli,
      ]
    : cli
  // `exec 3<>in` holds the FIFO open read-write so the CLI's stdin never sees end-of-file
  // between prompts; the stream appends to a file a restarted Outpost can read from any offset.
  const script = `#!/bin/bash\ncd ${q(dir)}\nexec 3<>${q(fifo)}\nexec ${runner.map(q).join(' ')} <&3 >> ${q(path.join(sdir, 'out.jsonl'))} 2>> ${q(path.join(sdir, 'err.log'))}\n`
  const run = path.join(sdir, 'run.sh')
  await fsp.writeFile(run, script, { mode: 0o700 })
  const unit = unitName(id)
  const props = Object.entries(unitEnv).flatMap(([k, v]) => ['-p', `Environment=${k}=${v}`])
  // How it signs in to Claude: the file Settings › Integrations › Claude writes, read at the
  // unit's start — a restart reads it again, so a switch reaches every session at its next
  // start. The `-` makes a missing file no error; a chat with no sign-in is refused before
  // this, by `containerPlan` (containers/index.mjs).
  // A file rather than `Environment=`, which `systemctl show` prints (claude-auth.mjs).
  props.push('-p', `EnvironmentFile=-${CLAUDE_ENV_FILE}`)
  // A start always follows the last session's stop, so any session container of this chat still
  // up is a leftover holding its ports (containers/index.mjs).
  if (container && workspaceId) await removeSessionContainers(workspaceId)
  // A restart reuses the plan's mounts; a transcript folder gone since would refuse the start.
  if (container) await ensureProjectMounts(container.mounts)
  try {
    await execFileAsync('systemd-run', ['--user', '--quiet', '--collect', `--unit=${unit}`, ...props, run], { timeout: 20000 })
    liveUnits = null
  } catch (err) {
    await fsp.rm(sdir, { recursive: true, force: true })
    return { ok: false, error: `Could not start the session unit: ${String(err?.stderr || err?.message || err).trim()}` }
  }
  const rec = { id, dir: sdir, unit, cwd: dir, workspaceId, sessionId: '', startedAt: Date.now(), args: [...args], env: { ...env }, approvalTool, rules, ...(bashFree ? { bashFree: true } : {}), ...(container ? { container } : {}) }
  records.set(id, rec)
  await persist()
  return { ok: true, record: rec, target: id }
}

/**
 * The workspace layer's standing instructions (`WORK_RULE`, and the ports rule for a chat that
 * has ports), handed in rather than imported — that layer imports this one — and called with the
 * workspace id so a restart reads them as they are now (`restart`).
 */
let standingRules = null
export function setStandingRules(fn) {
  standingRules = fn
}

/**
 * The same for what is on disk: a workspace's policy is rewritten by this before a session of
 * it is launched again (`restart`, `startFresh`), so a rule changed since — a recipe's, the
 * default denies, the tools' — reaches the chat with the restart that makes it read the file,
 * and never a chat that is not live. Set by the workspace layer (`refreshPolicies`).
 */
let beforeLaunch = null
export function setBeforeLaunch(fn) {
  beforeLaunch = fn
}

async function refreshBeforeLaunch(rec) {
  if (!rec.workspaceId || !beforeLaunch) return
  // A policy that cannot be rewritten (a person's malformed edit) is left as it is; the launch
  // goes ahead on the file as it stands.
  await beforeLaunch(rec.workspaceId).catch((err) => console.warn(`[outpost] policy of ${rec.workspaceId} not rewritten:`, err?.message || err))
}

/** Drop a flag and its value from an argument list, so a restart does not stack them. */
function without(args, flag) {
  const out = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) {
      i++
      continue
    }
    out.push(args[i])
  }
  return out
}

/**
 * Restart a session in place: stop its unit and start another in the same directory with
 * the same arguments and `--resume <id>`, which keeps the conversation, so the thread, the
 * transcript and the chat carry straight on. `extraArgs` is how a setting the stream cannot
 * change live is changed: effort goes in as a `--settings` override, replacing any earlier
 * one. The old record is kept, marked, so a question standing against it is answered and the
 * registry still knows the unit name.
 */
export async function restart(rec, { extraArgs = [], addArgs = [], container = null } = {}) {
  await load()
  if (!(await learnSessionId(rec))) return { ok: false, error: 'The session has not spoken yet; nothing to resume' }
  await systemctl('stop', rec.unit)
  denyAll(rec.workspaceId, 'The session was restarted')
  rec.endedAt = Date.now()
  await persist()
  let args = without(without(rec.args || [], '--resume'), '--session-id')
  for (let i = 0; i < extraArgs.length; i += 2) if (extraArgs[i].startsWith('--')) args = without(args, extraArgs[i])
  // `addArgs` join what is there rather than replacing it: a second `--add-dir` for a repo added
  // since, beside the first repo's.
  args = [...args, ...extraArgs, ...addArgs, '--resume', rec.sessionId]
  // A workspace session gets the standing instructions as they are now, not as they were at
  // its first launch: a rule added since reaches it on its next restart. Its policy the same.
  const rules = rec.workspaceId && standingRules ? standingRules(rec.workspaceId) : rec.rules || ''
  await refreshBeforeLaunch(rec)
  // A chat that ran in a container is restarted in one — the same image and mounts, or the
  // `container` given: an /addRepo restarts into one that mounts the repo's mirror too.
  const started = await start({ dir: rec.cwd, args, env: rec.env || {}, workspaceId: rec.workspaceId, approvalTool: rec.approvalTool || '', rules, container: container || rec.container || null, bashFree: Boolean(rec.bashFree) })
  if (!started.ok) return started
  // The id is known already; writing it saves a read and keeps the router pointed right.
  started.record.sessionId = rec.sessionId
  await persist()
  return { ok: true, record: started.record, target: started.record.id, resumed: true }
}

/**
 * A new conversation in the same place: stop the session's unit and start another in the same
 * directory, with the same arguments, container and rules — and no `--resume`, which is what
 * makes it a new conversation under a new session id rather than the old one carried on. The
 * one restart that does not resume, on purpose: starting fresh from a handoff (handoff.md). The
 * checkout is untouched, uncommitted changes and all. `prompt` is written to the new session's
 * FIFO, which buffers it until the CLI reads.
 */
export async function startFresh(rec, prompt) {
  await load()
  await systemctl('stop', rec.unit)
  if (await isAlive(rec)) return { ok: false, error: 'The session did not stop' }
  denyAll(rec.workspaceId, 'The chat was started fresh')
  rec.endedAt = Date.now()
  await persist()
  const args = without(without(rec.args || [], '--resume'), '--session-id')
  const rules = rec.workspaceId && standingRules ? standingRules(rec.workspaceId) : rec.rules || ''
  await refreshBeforeLaunch(rec)
  const started = await start({ dir: rec.cwd, args, env: rec.env || {}, workspaceId: rec.workspaceId, approvalTool: rec.approvalTool || '', rules, container: rec.container || null, bashFree: Boolean(rec.bashFree) })
  if (!started.ok) return started
  const sent = await sendPrompt(started.record, prompt)
  return { ok: true, record: started.record, target: started.record.id, sent }
}

/** The structured record a session belongs to: the newest one, alive or not. */
export async function latestForSession(sessionId) {
  if (!sessionId) return null
  const mine = (await allRecords()).filter((r) => r.sessionId === sessionId).sort((a, b) => b.startedAt - a.startedAt)
  return mine[0] || null
}

/** @type {Map<string, { offset: number, partial: string }>} record id -> the stream parser's place */
const partials = new Map()

/**
 * The text of the answer being written right now, assembled from the stream's deltas since
 * the last complete message — what a chat page shows a token at a time where the transcript
 * tail shows nothing until the message is whole. Read incrementally from the stream file.
 */
export async function partialText(rec) {
  const state = partials.get(rec.id) || { offset: 0, partial: '', carry: '' }
  partials.set(rec.id, state)
  let fh
  try {
    fh = await fsp.open(path.join(rec.dir, 'out.jsonl'), 'r')
  } catch {
    return ''
  }
  try {
    const { size } = await fh.stat()
    if (size < state.offset) {
      state.offset = 0
      state.partial = ''
      state.carry = ''
    }
    if (size === state.offset) return state.partial
    const buf = Buffer.alloc(size - state.offset)
    await fh.read(buf, 0, buf.length, state.offset)
    state.offset = size
    const text = state.carry + buf.toString('utf8')
    const lines = text.split('\n')
    state.carry = lines.pop() || ''
    for (const line of lines) {
      if (!line) continue
      let m
      try {
        m = JSON.parse(line)
      } catch {
        continue
      }
      if (m.type === 'stream_event') {
        const ev = m.event || {}
        if (ev.type === 'message_start') state.partial = ''
        else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') state.partial += ev.delta.text || ''
      } else if (m.type === 'assistant' || m.type === 'result' || m.type === 'user') state.partial = ''
    }
  } finally {
    await fh.close()
  }
  return state.partial
}

/** How far back a stream is looked at the first time it is asked about: a day's stream is tens of MB of deltas. */
const WINDOW_SCAN_BYTES = 1024 * 1024
/** @type {Map<string, { offset: number, carry: string, windows: Record<string, number> }>} record id -> where the window reader is */
const windowReads = new Map()

/**
 * The context window of each model the session has answered on, by model id, as the CLI put it
 * in its last `result` line (`modelUsage[model].contextWindow`). The transcript does not carry
 * it, and a table of model to window in Outpost goes wrong the day a model ships or a `[1m]`
 * variant is chosen; the stream says what the CLI itself is working to. Read incrementally,
 * like `partialText`: only what was appended since the last ask. `{}` until a turn has ended
 * in this unit.
 */
export async function contextWindows(rec) {
  const state = windowReads.get(rec.id) || { offset: -1, carry: '', windows: {} }
  windowReads.set(rec.id, state)
  let fh
  try {
    fh = await fsp.open(path.join(rec.dir, 'out.jsonl'), 'r')
  } catch {
    return state.windows
  }
  try {
    const { size } = await fh.stat()
    if (size < state.offset) Object.assign(state, { offset: -1, carry: '' })
    if (size === state.offset) return state.windows
    // A first look starts near the end, mid-line, so that first piece is dropped.
    const first = state.offset < 0
    const from = first ? Math.max(0, size - WINDOW_SCAN_BYTES) : state.offset
    const buf = Buffer.alloc(size - from)
    await fh.read(buf, 0, buf.length, from)
    state.offset = size
    const lines = (state.carry + buf.toString('utf8')).split('\n')
    state.carry = lines.pop() || ''
    if (first && from > 0) lines.shift()
    for (const line of lines) {
      if (!line.includes('"contextWindow"')) continue
      try {
        const m = JSON.parse(line)
        if (m.type !== 'result') continue
        for (const [model, u] of Object.entries(m.modelUsage || {})) {
          const n = Number(u?.contextWindow)
          if (n > 0) state.windows[model] = n
        }
      } catch {
        /* a line being written */
      }
    }
  } finally {
    await fh.close()
  }
  return state.windows
}

/**
 * @type {Map<string, { parts: Map<string, { out: number, sent: number, outCarry: string, sentCarry: string, pending: object[] }>, key: number, answered: boolean, records: { key: number, r: object }[] }>}
 * session id -> the conversation rebuilt from its streams so far
 */
const streamLogs = new Map()

/** Bytes `[from, size)` of a file as text, and how many there were; nothing for a file that is gone or shrank. */
async function readFrom(file, from) {
  let fh
  try {
    fh = await fsp.open(file, 'r')
  } catch {
    return { text: '', bytes: 0 }
  }
  try {
    const { size } = await fh.stat()
    if (size <= from) return { text: '', bytes: 0 }
    const buf = Buffer.alloc(size - from)
    await fh.read(buf, 0, buf.length, from)
    return { text: buf.toString('utf8'), bytes: buf.length }
  } finally {
    await fh.close()
  }
}

const parseLine = (line) => {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

/**
 * The conversation of a session whose transcript is gone, rebuilt from what Outpost holds: each
 * unit's stream (`out.jsonl`, the CLI's answers, tool calls and results, which are transcript
 * records in all but name) and `sent.jsonl` (what was typed, which the stream never echoes),
 * every unit of the session in the order they ran. Answers `{ records, offset, answered }`, or
 * null for a session this launcher never ran.
 *
 * A transcript folder deleted under a running container cannot be written again from inside it,
 * and the chat drew "Nothing said yet" through seven turns of work (bugs-fixed.md). Records are
 * keyed by a count of the bytes of both files consumed, which only grows, so `after` — the
 * `offset` a previous answer gave — tails it the way a transcript is tailed. Read incrementally,
 * like `partialText`. `answered` is whether the CLI has replied at all: it writes the transcript
 * before it replies, so only then is a missing transcript lost rather than not yet written.
 */
export async function streamRecords(sessionId, after = 0) {
  if (!sessionId) return null
  const recs = (await allRecords()).filter((r) => r.sessionId === sessionId).sort((a, b) => a.startedAt - b.startedAt)
  if (!recs.length) return null
  const log = streamLogs.get(sessionId) || { parts: new Map(), key: 0, answered: false, records: [] }
  streamLogs.set(sessionId, log)
  for (const rec of recs) {
    const p = log.parts.get(rec.id) || { out: 0, sent: 0, outCarry: '', sentCarry: '', pending: [] }
    log.parts.set(rec.id, p)
    // The sends first: each is stamped with the stream's size before it went, so every one read
    // now belongs at or before the end of the stream read after it.
    const s = await readFrom(path.join(rec.dir, 'sent.jsonl'), p.sent)
    p.sent += s.bytes
    const sentLines = (p.sentCarry + s.text).split('\n')
    p.sentCarry = sentLines.pop() || ''
    for (const line of sentLines) {
      const e = parseLine(line)
      if (e) p.pending.push({ e, bytes: Buffer.byteLength(line) + 1 })
    }
    const flush = (upTo) => {
      while (p.pending.length && (Number(p.pending[0].e.at) || 0) <= upTo) {
        const { e, bytes } = p.pending.shift()
        log.key += bytes
        log.records.push({ key: log.key, r: { type: 'user', uuid: e.id, timestamp: e.ts, message: { role: 'user', content: e.content } } })
      }
    }
    // Where the first whole line of this read starts: the old carry is its beginning.
    let at = p.out - Buffer.byteLength(p.outCarry)
    const o = await readFrom(path.join(rec.dir, 'out.jsonl'), p.out)
    p.out += o.bytes
    const outLines = (p.outCarry + o.text).split('\n')
    p.outCarry = outLines.pop() || ''
    for (const line of outLines) {
      flush(at)
      const bytes = Buffer.byteLength(line) + 1
      at += bytes
      log.key += bytes
      // Most of a stream is token deltas, never a record: not parsed.
      const r = line && !line.startsWith('{"type":"stream_event"') ? parseLine(line) : null
      // A subagent's own traffic is a sidechain; the transcript keeps it in its own file.
      if (!r || r.parent_tool_use_id || (r.type !== 'assistant' && r.type !== 'user')) continue
      if (r.type === 'assistant') log.answered = true
      log.records.push({ key: log.key, r })
    }
    flush(at)
  }
  return { records: log.records.filter((x) => x.key > after).map((x) => x.r), offset: log.key, answered: log.answered }
}

/** The CLI's session id for a record, read off the stream's `init` line once it is there. */
async function learnSessionId(rec) {
  if (rec.sessionId && rec.model) return rec.sessionId
  try {
    const fh = await fsp.open(path.join(rec.dir, 'out.jsonl'), 'r')
    try {
      const buf = Buffer.alloc(INIT_SCAN_BYTES)
      const { bytesRead } = await fh.read(buf, 0, INIT_SCAN_BYTES, 0)
      let changed = false
      // Hook events come before the init line, so the whole head is read: the id off the first
      // line that carries one, the model off the init line — a restart for effort keys its
      // settings override on it, and the router is handed a ref rather than a thread.
      for (const line of buf.toString('utf8', 0, bytesRead).split('\n')) {
        if (!line.includes('"session_id"') && !line.includes('"init"')) continue
        try {
          const m = JSON.parse(line)
          if (m.session_id && !rec.sessionId) {
            rec.sessionId = m.session_id
            changed = true
          }
          if (m.subtype === 'init' && m.model && !rec.model) {
            rec.model = m.model
            changed = true
          }
          if (rec.sessionId && rec.model) break
        } catch {
          /* a partial line */
        }
      }
      if (changed) await persist()
    } finally {
      await fh.close()
    }
  } catch {
    /* no stream yet */
  }
  return rec.sessionId || ''
}

/** Every record, with session ids learned where the stream has them. */
export async function allRecords() {
  await load()
  for (const rec of records.values()) if (!rec.sessionId) await learnSessionId(rec)
  return [...records.values()]
}

export async function recordForSession(sessionId) {
  return latestForSession(sessionId)
}

export async function isAlive(rec) {
  return (await systemctl('is-active', rec.unit)) === 'active'
}

/**
 * `isAlive` for the roster, which asks it of every record on every scan: answered from one
 * read of the running units, at most a second old and dropped at any start or stop. Anything
 * about to act on the answer — a stop, a start, a delete — asks `isAlive`, which asks systemd
 * for that unit now. A read that fails falls back to it.
 */
export async function isLive(rec) {
  const units = await runningUnits()
  return units ? units.has(rec.unit) : isAlive(rec)
}

/** @type {Set<string>} record ids whose own stream has carried a session id; it never uncarries one. */
const spoke = new Set()

/**
 * Whether this record's own stream ever carried a session id — the CLI ran in this unit. Not
 * `rec.sessionId`: `restart` copies the old id onto the new record, so a restart whose container
 * died at start (an effort change, `/addRepo`, a resilience restart into a setting this machine
 * cannot honour) looked as if it had started and sat silent. A `system` line only (the
 * SessionStart hook's, or init): a `--resume` that finds no conversation prints just an error
 * `result`, which carries the id too, and read as started it left the chat "stopped" with no
 * reason and no Try again (bugs-fixed.md).
 */
async function streamSpoke(rec) {
  if (spoke.has(rec.id)) return true
  let head = ''
  try {
    const fh = await fsp.open(path.join(rec.dir, 'out.jsonl'), 'r')
    try {
      const buf = Buffer.alloc(INIT_SCAN_BYTES)
      const { bytesRead } = await fh.read(buf, 0, INIT_SCAN_BYTES, 0)
      head = buf.toString('utf8', 0, bytesRead)
    } finally {
      await fh.close()
    }
  } catch {
    return false
  }
  const ran = head.split('\n').some((line) => {
    if (!line.includes('"session_id"')) return false
    try {
      const m = JSON.parse(line)
      return m.type === 'system' && Boolean(m.session_id)
    } catch {
      return false // a partial line
    }
  })
  if (!ran) return false
  spoke.add(rec.id)
  return true
}

const START_POLL_MS = 500
/** Long enough for a container to start and the CLI to print its SessionStart line. */
const START_WAIT_MS = 30 * 1000

/**
 * Whether the session `target` came up: `{ ok: true }` once its stream shows the CLI ran, or
 * the unit is still alive at the end of the wait; `{ ok: false, error }` once it is gone
 * having never run (`startFailure`'s log). `start` and `restart` answer when the unit is made,
 * before the container in it has run, so a caller that reports the outcome waits on this.
 */
export async function awaitStart(target) {
  await load()
  const rec = records.get(target)
  if (!rec) return { ok: false, error: 'No such session' }
  const end = Date.now() + START_WAIT_MS
  while (Date.now() < end) {
    if (await streamSpoke(rec)) return { ok: true }
    const failed = await startFailure(target)
    if (failed) return { ok: false, error: failed.log || 'It stopped before it started' }
    await new Promise((r) => setTimeout(r, START_POLL_MS))
  }
  return { ok: true }
}

/** A workspace's newest session record, alive or not: the one a failure to start is judged on. */
export async function latestForWorkspace(workspaceId) {
  await load()
  let best = null
  for (const rec of records.values()) if (rec.workspaceId === workspaceId && (!best || rec.startedAt > best.startedAt)) best = rec
  return best
}

/** How much of the end of `err.log` a start failure carries when podman wrote no `Error:` line. */
const START_FAILURE_LINES = 8

/**
 * Why the session `target` never started, or `null` when it did or is still alive: its unit
 * is gone and its stream never carried a session id — the SessionStart hook's line carries
 * one within a second of the CLI starting, a chat given no first message too — so the CLI
 * never ran. `{ at, log, resumed? }`, `log` the tail of `err.log`, where `podman run` writes why. Without
 * this a container that died at start (a pasta that refused its option, 2026-10-05) left the
 * chat on "no work yet" for good, its preparation `ready` and the reason only on disk.
 */
export async function startFailure(target) {
  await load()
  const rec = records.get(target)
  if (!rec || (await streamSpoke(rec))) return null
  if (await isAlive(rec)) return null
  const text = await fsp.readFile(path.join(rec.dir, 'err.log'), 'utf8').catch(() => '')
  const lines = text.split('\n').filter((l) => l.trim())
  // Podman's own `Error:` line and the one after (its cause) where there is one: a pasta that
  // refuses an option prints its whole usage after that, and the tail would be the usage.
  const at = lines.findIndex((l) => l.startsWith('Error:'))
  const shown = at >= 0 ? lines.slice(at, at + 2) : lines.slice(-START_FAILURE_LINES)
  // `resumed`: a restart of a conversation that had spoken, so its checkouts hold work and a
  // retry restarts it rather than preparing the chat again (workspaces.md `retryWorkspace`).
  return { at: rec.startedAt, log: shown.join('\n'), ...(rec.sessionId ? { resumed: true } : {}) }
}

/**
 * A workspace was deleted: forget every session it carried — the record, its stream folder,
 * what it was told "always" to and how far its partial answer had been read.
 *
 * This is the only thing that ever removes a record, and the workspace going is the only
 * moment one stops being needed: a record whose unit has gone is what Resume starts from
 * (launchers.md), however long ago that was. Nothing removed them at all before, so the
 * registry and the sessions folder only grew. A unit still running is left alone; the delete
 * ends sessions before it gets here, and one that would not stop refuses the delete.
 */
export async function forgetWorkspace(workspaceId) {
  if (!workspaceId) return 0
  await load()
  let n = 0
  for (const [id, rec] of records) {
    if (rec.workspaceId !== workspaceId) continue
    if (await isAlive(rec)) continue
    // Only ever a folder this module made: the path is rebuilt from the id, not read off the record.
    await fsp.rm(path.join(SESSIONS_DIR, id), { recursive: true, force: true }).catch(() => {})
    streamLogs.delete(rec.sessionId)
    records.delete(id)
    always.delete(id)
    partials.delete(id)
    n++
  }
  if (n) await persist()
  return n
}

function writeLine(rec, obj) {
  return new Promise((resolve, reject) => {
    // Write-only open blocks until a reader holds the other end; the CLI does, through fd 3.
    const ws = fs.createWriteStream(path.join(rec.dir, 'in'), { flags: 'a' })
    ws.on('error', reject)
    ws.write(JSON.stringify(obj) + '\n', (err) => {
      ws.end()
      if (err) reject(err)
      else resolve()
    })
  })
}

/**
 * One uploaded file as a content block, by the extension `uploads.mjs` gave it: an image, a
 * PDF as a document the model reads page by page, or text as a document titled with its name
 * — a document rather than a text block, so the log draws a chip and not the whole file.
 */
async function fileBlock(file) {
  const data = await fsp.readFile(file)
  const ext = path.extname(file).toLowerCase().replace('.', '')
  if (ext === 'pdf') return { type: 'document', title: uploadTitle(file), source: { type: 'base64', media_type: 'application/pdf', data: data.toString('base64') } }
  if (ext === 'txt') return { type: 'document', title: uploadTitle(file), source: { type: 'text', media_type: 'text/plain', data: data.toString('utf8') } }
  const type = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }[ext] || 'image/png'
  return { type: 'image', source: { type: 'base64', media_type: type, data: data.toString('base64') } }
}

/**
 * A prompt, as a user message with the text and any attached files as content blocks — the
 * stream takes an image or a document inline, which a paste into a pane could only approximate.
 */
export async function sendPrompt(rec, text, { files = [], lead = '' } = {}) {
  if (!(await isAlive(rec))) return { ok: false, error: 'That session has ended' }
  // `lead` is a block before everything the person sent — setup's held note (workspaces.md) —
  // so the log draws it above their files, not between a file and their words.
  const content = lead ? [{ type: 'text', text: lead }] : []
  // What `sent.jsonl` keeps of each file: its name, never its bytes.
  const named = lead ? [{ type: 'text', text: lead }] : []
  for (const file of files) {
    try {
      content.push(await fileBlock(file))
      named.push({ type: 'document', title: uploadTitle(file) })
    } catch {
      /* a file that cannot be read is left out; the text still goes */
    }
  }
  if (text) content.push({ type: 'text', text })
  if (text) named.push({ type: 'text', text })
  if (content.length === (lead ? 1 : 0)) return { ok: false, error: 'Nothing to send' }
  // Taken before the write: the stream cannot hold anything answering this message yet.
  const streamAt = (await fsp.stat(path.join(rec.dir, 'out.jsonl')).catch(() => null))?.size || 0
  try {
    await writeLine(rec, { type: 'user', message: { role: 'user', content } })
  } catch (err) {
    return { ok: false, error: `Could not write to the session: ${err.message}` }
  }
  await logSent(rec, streamAt, named)
  return { ok: true }
}

/**
 * What was typed into a session, one line per send in `sent.jsonl` beside its stream: the stream
 * never echoes the person's side, and it is the only copy of the conversation when the transcript
 * is gone (`streamRecords`). `at` is the stream's size when the message went, which places it
 * between the stream's lines. A failure here never fails the send.
 */
async function logSent(rec, at, content) {
  const line = { id: randomBytes(8).toString('hex'), at, ts: new Date().toISOString(), content }
  await fsp.appendFile(path.join(rec.dir, 'sent.jsonl'), JSON.stringify(line) + '\n').catch(() => {})
}

async function control(rec, request) {
  if (!(await isAlive(rec))) return { ok: false, error: 'That session has ended' }
  try {
    await writeLine(rec, { type: 'control_request', request_id: randomBytes(6).toString('hex'), request })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: `Could not write to the session: ${err.message}` }
  }
}

/**
 * A workspace's sessions in another permission mode from their next start on: every record's
 * `--permission-mode` is rewritten, so the resume the person's next message makes (`restart`
 * reads the record's arguments) — and any restart after it — runs in `mode`, and every unit still
 * running is stopped so that resume is the next thing to happen. A restart, not a control request:
 * a mode set live would be lost again at the next restart, which reads the record. What a routine's
 * run promoted to a chat goes through (routines.md): it ran `dontAsk`, and the person answering it
 * must get the approval bar, not a refusal for every call nobody allowed.
 */
export async function switchMode(workspaceId, mode) {
  await load()
  const mine = [...records.values()].filter((r) => r.workspaceId === workspaceId)
  for (const rec of mine) rec.args = [...without(rec.args || [], '--permission-mode'), '--permission-mode', mode]
  await persist()
  let ended = 0
  for (const rec of mine) {
    if (!(await isAlive(rec))) continue
    const r = await kill(rec)
    if (!r.ok) return { ok: false, error: r.error, ended }
    ended++
  }
  return { ok: true, ended }
}

export const interrupt = (rec) => control(rec, { subtype: 'interrupt' })
// An interrupt ends the turn and nothing it left in the background: a background agent is a task
// of its own, and only this (the CLI's own stop, by its task id, which is the agent's id) ends it.
export const stopTask = (rec, taskId) => control(rec, { subtype: 'stop_task', task_id: String(taskId) })
/**
 * A launch's arguments on another model: `--model` replaced, or dropped for `default`, which is
 * the CLI's configured model and has no flag of its own.
 */
export function withModel(args, model) {
  const rest = without(args || [], '--model')
  return model === 'default' ? rest : [...rest, '--model', model]
}

/**
 * Move a running session to `model`, and remember that it was asked: the thread's model is read
 * off its last answer (harnesses.md), so until it answers again nothing else says a change is
 * on its way. `modelWanted` on the record is what the roster turns into `modelPending`.
 * Every record of the session gets the model in its arguments too: `restart` starts from them,
 * so an effort change, a resume after aging or a resilience restart put the session back on the
 * model it was launched with.
 */
export async function setModel(rec, model) {
  const r = await control(rec, { subtype: 'set_model', model })
  if (!r.ok) return r
  await load()
  rec.modelWanted = { model, at: Date.now() }
  for (const other of records.values()) {
    if (other === rec || (rec.sessionId && other.sessionId === rec.sessionId)) other.args = withModel(other.args, model)
  }
  await persist()
  return r
}

export async function kill(rec) {
  await systemctl('stop', rec.unit)
  // `systemctl` above hands back whatever was printed, a failure included, so the stop is
  // checked rather than believed: this answered `ok` for a unit that was still running, and
  // an archive then said "session ended" over one that had not.
  if (await isAlive(rec)) return { ok: false, error: 'The session did not stop' }
  denyAll(rec.workspaceId, 'The session was ended')
  return { ok: true, target: rec.id }
}

// ── the approval surface ──────────────────────────────────────────────────────────────

const queueOf = (workspaceId) => pending.get(workspaceId) || []

/** Take one request out of its workspace's queue; the map holds no empty queues (`isAsking`). */
function dropAsk(workspaceId, entry) {
  clearTimeout(entry.timer)
  const rest = queueOf(workspaceId).filter((e) => e !== entry)
  if (rest.length) pending.set(workspaceId, rest)
  else pending.delete(workspaceId)
}

/**
 * Deny everything a workspace has standing — its session was ended or restarted under them.
 * A standing question (`awaitApproval`'s `standing`) is not the session's and stays: ending
 * the session is what a promoted run does before anyone has seen its question. Exported for
 * its test.
 */
export function denyAll(workspaceId, message) {
  const kept = []
  for (const entry of queueOf(workspaceId)) {
    if (entry.standing) {
      kept.push(entry)
      continue
    }
    clearTimeout(entry.timer)
    entry.resolve({ behavior: 'deny', message })
  }
  if (kept.length) pending.set(workspaceId, kept)
  else pending.delete(workspaceId)
}

/**
 * Take back a standing question by its `id` — the thing it asked about was replaced, or its
 * workspace deleted. Its promise answers `withdrawn`, which the asker tells from a No.
 */
export function withdraw(workspaceId, id) {
  const entry = queueOf(workspaceId).find((e) => e.ask.id === String(id))
  if (!entry) return false
  dropAsk(workspaceId, entry)
  entry.resolve({ behavior: 'deny', message: 'withdrawn' })
  return true
}

let askSeq = 0

/**
 * The tool name of a question Outpost itself puts to the person through a chat's approval bar,
 * rather than one the CLI asks: `input` is `{ question, yes, card? }`, the words to ask, the Yes
 * button's, and something for the page to draw above them. The first is a Jenkins job a chat
 * wants to start that its repo does not name yet; the second a routine a chat wants to make,
 * change or delete, which brings a `card` (`kind: 'routine'`) so the person reads the routine
 * rather than its JSON (both mcp/index.mjs); the third the files a chat's publish would remove
 * from a dataset's source (`kind: 'files'`, workspaces/index.mjs), standing until answered —
 * asked where the person is already looking, at the moment it matters. `question` stays a
 * plain sentence: it is what a page without the card draws, and what a phone shows first.
 */
export const OUTPOST_ASK = 'outpost_question'

/**
 * The CLI asked: called by the MCP `approve` tool with the workspace the token belongs to.
 * Holds the request until the page answers through `answer`, or denies after the timeout.
 *
 * A queue per workspace, drawn and answered head first. The CLI does not ask one at a time:
 * tool calls sent in one message each call `approve`, concurrently, and so does a subagent
 * while its parent's question stands. With one slot, each arrival resolved the one before it
 * as a denial — "Superseded by a newer request" — that no person had made, the session
 * retried what it thought was refused, and the person answered the last of N. A repeat of
 * the same `tool_use_id` takes its own earlier place in the queue and nobody else's.
 *
 * Each request's ten minutes run from when it arrived, queued or not: the CLI's own timeout
 * on the call started then too, and a request held past it is one nobody is waiting on.
 *
 * `standing` is Outpost's own question with no session waiting on it (a write dataset's
 * deletions, workspaces/index.mjs): no timeout, and it outlives the session's end and restart
 * (`denyAll`), since the person may reach the chat hours later. Answered on the bar like any
 * other, or taken back with `withdraw`. The caller holds the promise and acts on the answer.
 */
export function awaitApproval(workspaceId, { toolName, input, toolUseId, standing = false }) {
  const rec = recordSyncForWorkspace(workspaceId)
  const key = `${toolName}\u0000${JSON.stringify(input || {})}`
  if (rec && always.get(rec.id)?.has(key)) return Promise.resolve({ behavior: 'allow', updatedInput: input })
  // One command per Bash call (compound.mjs): a chain is sent back to be split, not put to a
  // person who would be answering for six commands because one of them needed it. Before the
  // queue is touched, so a refused chain never takes a place in it. Except in a free-Bash chat,
  // which was never told the rule: the Bash allow lets nearly every chain through, and the few
  // the CLI still escalates go to the person, briefly, and come back split if nobody approves.
  const refusal = toolName === 'Bash' ? refusalFor(input?.command) : ''
  const freeChain = Boolean(refusal && rec?.bashFree)
  if (refusal && !freeChain) return Promise.resolve({ behavior: 'deny', message: refusal })
  // The session's own question to the person arrives here too, with its questions and
  // options in the input; the page draws them one at a time and the labels go back as the
  // tool's answers. Nothing about it is a permission, so it is kept apart from the start.
  const questions = toolName === 'AskUserQuestion' && Array.isArray(input?.questions) ? input.questions : null
  return new Promise((resolve) => {
    const entry = {
      // `id` is what the page hands back with its answer, so a click meant for the request it
      // drew cannot land on the one that took its place at the head.
      ask: { id: String(toolUseId || `ask-${++askSeq}`), toolName, input, toolUseId, at: Date.now(), kind: questions ? 'question' : 'permission', questions, index: 0, answers: {} },
      resolve,
      key,
      timer: null,
      standing,
      // What a plain No answers, when there is a better word than "Denied".
      denied: freeChain ? splitThisChain('The person did not approve it') : '',
    }
    if (!standing) {
      entry.timer = setTimeout(() => {
        dropAsk(workspaceId, entry)
        resolve({ behavior: 'deny', message: freeChain ? splitThisChain('Nobody approved it in time') : 'Nobody answered in time' })
      }, freeChain ? CHAIN_ASK_MS : ASK_TIMEOUT_MS)
    }
    const queue = [...queueOf(workspaceId)]
    const at = toolUseId ? queue.findIndex((e) => e.ask.toolUseId === toolUseId) : -1
    if (at >= 0) {
      clearTimeout(queue[at].timer)
      queue[at].resolve({ behavior: 'deny', message: 'Superseded by a repeat of the same request' })
      queue[at] = entry
    } else {
      queue.push(entry)
    }
    pending.set(workspaceId, queue)
  })
}

function recordSyncForWorkspace(workspaceId) {
  if (!records) return null
  return [...records.values()].filter((r) => r.workspaceId === workspaceId).sort((a, b) => b.startedAt - a.startedAt)[0] || null
}

/**
 * What a session is asking, in the shape the page's permission bar draws: the head of the
 * queue, its `id`, and how many `more` stand behind it.
 */
export function describePrompt(rec) {
  const queue = queueOf(rec.workspaceId)
  const p = queue[0]
  if (!p) return { asking: false, options: [], question: '' }
  const more = queue.length - 1
  if (p.ask.kind === 'question') {
    const q = p.ask.questions[p.ask.index]
    if (!q) return { asking: false, options: [], question: '' }
    return {
      asking: true,
      id: p.ask.id,
      more,
      kind: 'question',
      question: [q.header, q.question].filter(Boolean).join(' — '),
      multiSelect: Boolean(q.multiSelect),
      options: (q.options || []).map((o, i) => ({ key: String(i + 1), text: String(o.label || ''), detail: String(o.description || '') })),
    }
  }
  const { toolName, input } = p.ask
  // Outpost's own question: its words, a Yes in its words, and No — no "always", since what
  // Yes does is already kept (it changes a setting, not this one call).
  if (toolName === OUTPOST_ASK) {
    return {
      asking: true,
      id: p.ask.id,
      more,
      kind: 'permission',
      head: 'Outpost is asking you',
      question: String(input?.question || ''),
      ...(input?.card ? { card: input.card } : {}),
      options: [
        { key: 'allow', text: `Yes${input?.yes ? ` — ${input.yes}` : ''}`, detail: '' },
        { key: 'deny', text: 'No', detail: '' },
      ],
    }
  }
  const summary = summarise(toolName, input)
  return {
    asking: true,
    id: p.ask.id,
    more,
    kind: 'permission',
    question: summary,
    options: [
      { key: 'allow', text: 'Yes', detail: '' },
      { key: 'always', text: 'Yes, and don\'t ask again for this in this chat', detail: '' },
      { key: 'deny', text: 'No', detail: '' },
    ],
  }
}

function summarise(toolName, input) {
  if (!input || typeof input !== 'object') return toolName
  if (toolName === 'Bash' && input.command) return `Bash: ${input.command}`
  if ((toolName === 'Write' || toolName === 'Edit') && input.file_path) return `${toolName}: ${input.file_path}`
  if (toolName === 'Read' && input.file_path) return `Read: ${input.file_path}`
  const text = JSON.stringify(input)
  return `${toolName}: ${text.length > 300 ? text.slice(0, 300) + '…' : text}`
}

/**
 * The page's answer to the head of the queue: `allow`, `always` or `deny`. Refused when
 * nothing is being asked, and when `id` names a request that is no longer the head — the bar
 * the click came from was drawn for something already answered. `more` in the answer is how
 * many still stand.
 */
export function answer(workspaceId, what, { option, expect, id = '', message = '' } = {}) {
  const p = queueOf(workspaceId)[0]
  if (!p) return { ok: false, error: 'Nothing is being asked' }
  if (id && String(id) !== p.ask.id) return { ok: false, error: 'The question has moved on; look again' }
  if (p.ask.kind === 'question' && what !== 'deny') {
    const q = p.ask.questions[p.ask.index]
    const pick = q?.options?.[Number(option) - 1]
    if (!pick) return { ok: false, error: 'That row is not one of the options being asked' }
    // The label the page drew must still be the one at that row, or the question moved on.
    if (expect && !String(expect).startsWith(String(pick.label || ''))) return { ok: false, error: 'The question has moved on; look again' }
    p.ask.answers[q.question] = pick.label
    p.ask.index++
    if (p.ask.index < p.ask.questions.length) return { ok: true, chose: pick.label, next: true }
    dropAsk(workspaceId, p)
    p.resolve({ behavior: 'allow', updatedInput: { ...p.ask.input, answers: p.ask.answers } })
    return { ok: true, chose: pick.label, more: queueOf(workspaceId).length }
  }
  dropAsk(workspaceId, p)
  if (what === 'always') {
    const rec = recordSyncForWorkspace(workspaceId)
    if (rec) {
      if (!always.has(rec.id)) always.set(rec.id, new Set())
      always.get(rec.id).add(p.key)
    }
    // The same call queued behind this one has just been answered too; asking again for
    // what somebody said "always" to a second ago is the prompt that promise removes.
    for (const twin of queueOf(workspaceId).filter((e) => e.key === p.key && e.ask.kind === 'permission')) {
      dropAsk(workspaceId, twin)
      twin.resolve({ behavior: 'allow', updatedInput: twin.ask.input })
    }
  }
  if (what === 'allow' || what === 'always') p.resolve({ behavior: 'allow', updatedInput: p.ask.input })
  else p.resolve({ behavior: 'deny', message: message || p.denied || 'Denied from Outpost' })
  return { ok: true, chose: what === 'deny' ? 'No' : 'Yes', more: queueOf(workspaceId).length }
}

export function isAsking(rec) {
  return pending.has(rec.workspaceId)
}

/**
 * What the chat list says while a request stands, or `''`. The approval tool replaces the
 * CLI's own dialog, so the `permission_prompt` notification that would make the hook store say
 * `waiting` never fires: without this the row kept "Running WebFetch" over a bar waiting on you.
 */
export function askingLine(rec) {
  const p = queueOf(rec.workspaceId)[0]
  if (!p) return ''
  if (p.ask.kind === 'question' || p.ask.toolName === OUTPOST_ASK) return 'Asking you a question'
  return `Needs your permission: ${p.ask.toolName}`
}

/** An ask's head is one line on a row; the hook overlay cuts a hook's message the same (claude-code.mjs). */
const ASK_HEAD_CAP = 140
const firstLine = (v) => String(v ?? '').trim().split('\n')[0].trim().slice(0, ASK_HEAD_CAP)

/** The input fields that say what a permission is for, in the order one is looked for. */
const ASK_TARGETS = ['command', 'file_path', 'notebook_path', 'path', 'url', 'pattern', 'query']

/**
 * What the request at the head of the queue asks, for the chat list to quote: `{ kind, head }`,
 * or null with nothing standing. A question's head is the first line of the one being asked
 * now (an `AskUserQuestion` steps through several; Outpost's own carries one); a permission's is
 * `<tool>: <first line of its command or path>`, or the tool alone when the input names
 * neither. Never the whole input: a row has one line, and a 300-char JSON blob is not one.
 */
export function askOf(rec) {
  const p = queueOf(rec.workspaceId)[0]
  if (!p) return null
  const { toolName, input } = p.ask
  if (p.ask.kind === 'question' || toolName === OUTPOST_ASK) {
    const q = p.ask.kind === 'question' ? p.ask.questions?.[p.ask.index]?.question : input?.question
    return { kind: 'question', head: firstLine(q) || 'Asking you a question' }
  }
  const field = input && typeof input === 'object' ? ASK_TARGETS.find((k) => typeof input[k] === 'string' && input[k].trim()) : ''
  return { kind: 'permission', head: firstLine(field ? `${toolName}: ${firstLine(input[field])}` : toolName) }
}
