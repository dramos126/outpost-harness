/**
 * A shell on this machine, from the page — the owner's, and nobody else's (auth.md).
 *
 * The door is the machine's own login, not Outpost's: a terminal starts `su -l <account>`,
 * so Linux asks for that account's password inside the terminal (PAM, as ssh or a console
 * does) and Outpost never sees, keeps or checks it. Being logged in to the page gets you that
 * prompt and no further. The account is asked for, filled in with the one Outpost runs as —
 * never written in, since the box is not always the same user — and is always a name: a bare
 * `su` means root.
 *
 * Chats have no way here: no tool, nothing under `/mcp`, and these routes sit behind the
 * page's own login, which a chat does not hold. A chat that reached one anyway would meet the
 * same password prompt. Refused outright while Outpost has no login of its own.
 *
 * The terminal is `terminal.py` (Node has no pty without a native module). Its output is kept, the
 * last 512 KB, and streamed to the page with each chunk's offset, so a phone that drops the
 * connection picks up where it left off. A terminal nobody is watching or typing in for half
 * an hour is closed; at most four are open. Each one opened and closed is a line in
 * `data/shell.log`, with the account and the address it came from.
 *
 * The second kind is a shell into a chat's container (`podman exec`), behind Outpost's login
 * alone, no `su`: it reaches exactly what the chat reaches and nothing on the host (auth.md). A
 * chat whose session runs on the host has none — that would be a host shell without the
 * machine's login. At most eight are open, three per chat; the host's four are counted apart.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const PTY = path.join(here, 'terminal.py')
const DATA_DIR = process.env.OUTPOST_DATA || path.join(here, '..', '..', 'data')
const LOG = path.join(DATA_DIR, 'shell.log')
const KEEP_BYTES = 512 * 1024
const IDLE_MS = 30 * 60 * 1000
/** One host terminal: it lives on Settings › Terminal and closes when the page is left (ui.md). */
const MAX_OPEN = 1
/** Container shells: in all, and per chat (the drawer's tabs, ui-conversation.md). */
const MAX_CONTAINER = 8
const MAX_PER_CHAT = 3
/** An ended terminal is kept this long, so a page reconnecting hears that it ended. */
const ENDED_KEEP_MS = 5 * 60 * 1000
const ACCOUNT = /^[a-z_][a-z0-9_.-]{0,31}\$?$/i
/** A drawer with no keystroke and no output this long has finished what it was doing. */
const QUIET_MS = 10_000

const shells = new Map()

/**
 * `quiet` with `{ workspace }` when a shell into a chat's container goes quiet or closes: a
 * commit made by hand in the drawer is one no hook hears (unpushed.mjs).
 */
export const shellEvents = new EventEmitter()

function stirred(s) {
  if (s.kind !== 'container' || !s.workspace) return
  clearTimeout(s.quietTimer)
  s.quietTimer = setTimeout(() => shellEvents.emit('quiet', { workspace: s.workspace }), QUIET_MS)
  s.quietTimer.unref?.()
}

async function log(line) {
  await fsp.mkdir(DATA_DIR, { recursive: true }).catch(() => {})
  await fsp.appendFile(LOG, `${new Date().toISOString()} ${line}\n`).catch(() => {})
}

/** The account Outpost runs as: what "Log in as" is filled in with. */
export const defaultAccount = () => os.userInfo().username

const view = (s) => ({
  id: s.id,
  kind: s.kind,
  account: s.account,
  ...(s.kind === 'container' ? { chat: s.chat, container: s.container } : {}),
  openedAt: s.openedAt,
  ended: s.ended,
  code: s.code,
})

/** Not one the person closed: its row and widget would come back on the page's next look. */
export function listShells() {
  return [...shells.values()].filter((s) => !s.closed).map(view)
}

const openOf = (kind) => [...shells.values()].filter((s) => !s.ended && s.kind === kind)

/** A refusal the page shows as said; `stopped` tells it to wait for the chat to run again. */
const refuse = (message, extra = {}) => Object.assign(new Error(message), extra)

/**
 * The words of a person's shell into the chat's container: `podman exec` into the session's own
 * container, in the session's folder. `--userns keep-id` on the run already makes the user inside
 * the owner's uid, so nothing is passed for it. A record with no container is a chat running on
 * the host, which gets no shell here: one would be the host without the machine's login.
 */
export function containerShellArgs(rec) {
  if (!rec?.container) throw refuse('This chat runs on the host; the Terminal is the way in')
  return ['podman', 'exec', '-it', '-w', String(rec.cwd || '/'), `outpost-session-${rec.id}`, 'bash', '-l']
}

/**
 * Open a terminal. `{ account }` is the host's, asking for that account's password; throws a
 * sentence for an account the machine does not have, or a fifth terminal. `{ chat: { harness,
 * ref } }` is a shell into that chat's container, found through `deps` (`threadFor`,
 * `workspaceFor`, `latestForWorkspace`, `isAlive`); refused for a chat on the host, with
 * `stopped` while its container is not running, and past three for the chat or eight in all.
 * Answers its view.
 */
export async function openShell({ account, chat, rows = 24, cols = 80, addr = '' }, deps = {}) {
  const r = Math.max(2, Math.min(500, Number(rows) || 24))
  const c = Math.max(10, Math.min(1000, Number(cols) || 80))
  if (chat) return openContainerShell(chat, r, c, addr, deps)
  const name = String(account || '').trim()
  if (!ACCOUNT.test(name)) throw new Error('Name an account on this machine')
  try {
    await execFileAsync('getent', ['passwd', name], { timeout: 5000 })
  } catch {
    throw new Error(`This machine has no account "${name}"`)
  }
  if (openOf('host').length >= MAX_OPEN) throw new Error('A terminal is open already — terminate it first')
  const s = begin(['su', '-l', name], r, c, { kind: 'host', account: name, addr }, deps.spawn)
  await log(`opened ${s.id} as ${name} from ${addr || 'unknown'}`)
  return view(s)
}

async function openContainerShell(chat, r, c, addr, { threadFor, workspaceFor, latestForWorkspace, isAlive, spawn: spawnFn }) {
  const thread = await threadFor(chat.harness, chat.ref)
  if (!thread) throw refuse('No such chat')
  const ws = await workspaceFor(thread.cwd)
  const rec = ws ? await latestForWorkspace(ws.id) : null
  if (!rec) throw refuse('This chat has no session Outpost started')
  const argv = containerShellArgs(rec)
  if (!(await isAlive(rec))) throw refuse('The container is stopped — Resume the chat to start it', { stopped: true, status: 409 })
  if (openOf('container').filter((s) => s.chat === thread.id).length >= MAX_PER_CHAT) throw refuse(`${MAX_PER_CHAT} shells are open in this chat already — close one first`)
  if (openOf('container').length >= MAX_CONTAINER) throw refuse(`${MAX_CONTAINER} container shells are open already — close one first`)
  const container = argv[5]
  const s = begin(argv, r, c, { kind: 'container', account: defaultAccount(), chat: thread.id, container, workspace: ws.id, addr }, spawnFn)
  await log(`opened ${s.id} in ${container} for chat ${thread.id} from ${addr || 'unknown'}`)
  return view(s)
}

/** Who a log line is about: the account, and the chat for a container shell. */
const whose = (s) => (s.kind === 'container' ? `${s.account}, chat ${s.chat}` : s.account)

/** Start `argv` on a pty and keep its output; the shell's record, registered. */
function begin(argv, r, c, fields, spawnFn = spawn) {
  // A clean environment: `su -l` resets it anyway, and nothing of Outpost's own — its port,
  // its paths, a credential a launch put there — should be in the terminal's to begin with.
  // Rootless podman finds its storage under HOME and its runtime under XDG_RUNTIME_DIR, the
  // owner's own; without them `podman exec` looks for a container in the wrong place.
  const env = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', TERM: 'xterm-256color', LANG: process.env.LANG || 'C.UTF-8' }
  if (fields.kind === 'container') {
    env.HOME = os.homedir()
    env.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR || `/run/user/${os.userInfo().uid}`
  }
  const child = spawnFn('python3', [PTY, String(r), String(c), ...argv], { env, cwd: '/', stdio: ['pipe', 'pipe', 'pipe', 'pipe'], detached: true })
  const s = { id: randomBytes(6).toString('hex'), ...fields, openedAt: Date.now(), ended: false, closed: false, code: null, child, chunks: [], start: 0, end: 0, clients: new Set(), lastActive: Date.now() }
  const take = (buf) => {
    s.chunks.push(buf)
    s.end += buf.length
    let kept = s.end - s.start
    while (kept > KEEP_BYTES && s.chunks.length > 1) {
      const dropped = s.chunks.shift()
      s.start += dropped.length
      kept -= dropped.length
    }
    const msg = `id: ${s.end}\ndata: ${buf.toString('base64')}\n\n`
    for (const res of s.clients) res.write(msg)
    stirred(s)
  }
  child.stdout.on('data', take)
  // The helper's own failures (python missing, a bad argument) are worth seeing in the terminal.
  child.stderr.on('data', take)
  child.stdio[3].on('error', () => {})
  child.stdin.on('error', () => {})
  child.on('close', (code) => {
    s.ended = true
    s.code = code
    clearTimeout(s.quietTimer)
    if (s.kind === 'container' && s.workspace) shellEvents.emit('quiet', { workspace: s.workspace })
    for (const res of s.clients) {
      res.write(`event: exit\ndata: ${code ?? ''}\n\n`)
      res.end()
    }
    s.clients.clear()
    void log(`closed ${s.id} (${whose(s)}), exit ${code}`)
    if (s.closed) shells.delete(s.id)
    else setTimeout(() => shells.delete(s.id), ENDED_KEEP_MS).unref()
  })
  child.on('error', (err) => take(Buffer.from(`\r\nCould not start the terminal: ${err.message}\r\n`)))
  shells.set(s.id, s)
  return s
}

const live = (id) => {
  const s = shells.get(String(id || ''))
  if (!s) throw new Error('No such terminal')
  return s
}

/**
 * Stream a terminal's output to `res` from offset `from`: what is kept since then at once, then
 * as it comes. An offset older than what is kept starts at the oldest kept byte; the first
 * event's `id` says where the stream now stands.
 */
export function streamShell(id, from, req, res) {
  const s = live(id)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'Content-Encoding': 'identity',
    'X-Accel-Buffering': 'no',
  })
  res.write(': connected\n\n')
  let at = Math.max(Number(from) || 0, s.start)
  if (at < s.end) {
    let pos = s.start
    const parts = []
    for (const chunk of s.chunks) {
      const next = pos + chunk.length
      if (next > at) parts.push(chunk.subarray(Math.max(0, at - pos)))
      pos = next
    }
    res.write(`id: ${s.end}\ndata: ${Buffer.concat(parts).toString('base64')}\n\n`)
    at = s.end
  }
  if (s.ended) {
    res.write(`event: exit\ndata: ${s.code ?? ''}\n\n`)
    res.end()
    return
  }
  s.clients.add(res)
  s.lastActive = Date.now()
  // A comment every 25 s, so nothing between here and a phone takes a quiet terminal for a dead one.
  const beat = setInterval(() => res.write(': \n\n'), 25000)
  req.on('close', () => {
    clearInterval(beat)
    s.clients.delete(res)
    s.lastActive = Date.now()
  })
}

/** Keystrokes, as the terminal widget sends them. */
export function writeShell(id, data) {
  const s = live(id)
  if (s.ended) throw new Error('That terminal has ended')
  s.lastActive = Date.now()
  stirred(s)
  s.child.stdin.write(String(data ?? ''))
}

export function resizeShell(id, rows, cols) {
  const s = live(id)
  if (s.ended) return
  s.child.stdio[3].write(`${Math.round(Number(rows) || 24)} ${Math.round(Number(cols) || 80)}\n`)
}

/**
 * Close a terminal: its input is closed, which the helper turns into a hang-up for the shell,
 * as a dropped ssh line is; whatever is still there a few seconds later is killed. Closed by
 * the person, it leaves the list at once rather than lingering as an ended row.
 */
export function closeShell(id) {
  const s = live(id)
  s.closed = true
  if (s.ended) {
    shells.delete(s.id)
    return
  }
  hangUp(s)
}

function hangUp(s) {
  s.child.stdin.end()
  setTimeout(() => {
    if (!s.ended) {
      try {
        process.kill(-s.child.pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }, 5000).unref()
}

// Half an hour with nobody watching and nothing typed: closed, so a terminal left open on a
// phone in a pocket does not stay a logged-in shell for days.
setInterval(() => {
  for (const s of shells.values()) {
    if (!s.ended && !s.clients.size && Date.now() - s.lastActive > IDLE_MS) {
      void log(`idle ${s.id} (${whose(s)}) — closing`)
      // Hung up, not closed: a page that comes back still hears that it ended.
      hangUp(s)
    }
  }
}, 60 * 1000).unref()
