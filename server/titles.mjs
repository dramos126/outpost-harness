/**
 * What a chat is called: a name the person gave it, or one a model gave it from what the chat
 * is working on — kept by Outpost, stamped over the harness's title in `roster()` (chats.md).
 *
 * The harness titles a thread by its latest prompt (harnesses.md), which tells threads apart
 * but reads as a sentence cut at 72 characters, and moves with every aside long enough to
 * pass the filter. A short name for the goal reads better, and should only move when the goal
 * does. So it is made by the CLI, once when a chat has none and again when its latest prompt
 * has changed — never per poll, which is what the 2026-09-04 decision rejected — and the model
 * is told to hand the current name back when it still fits.
 *
 * Precedence, highest first: the name the person set here; a name the person gave the session
 * itself (`/rename`, the harness's `titleNamed`); the automatic name; the harness's title.
 * Nothing automatic ever writes over a name a person chose.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readJsonFile } from './lib/fsutil.mjs'
import { CLAUDE_BIN, claudeEnv } from './claude-auth.mjs'
import { readPrompts } from './scan.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.OUTPOST_DATA || path.join(here, '..', 'data')
const STORE_FILE = path.join(DATA_DIR, 'titles.json')

/** `OUTPOST_AUTO_TITLES=0` turns automatic naming off: a scratch server, or a plan with no usage to spare. */
const AUTO = process.env.OUTPOST_AUTO_TITLES !== '0'
/**
 * The least time between two namings of one chat once it has a name. A chat whose every prompt
 * is a new instruction would otherwise spend a call per turn on a name that, told to keep
 * itself when it still fits, mostly comes back unchanged.
 */
const RENAME_GAP_MS = 10 * 60 * 1000
/** After a failed naming, how long before that chat is tried again. */
const RETRY_MS = 10 * 60 * 1000
/** One naming is a few seconds; one still going after this is not going to answer. */
const RUN_TIMEOUT_MS = 60 * 1000
/** A name a person types, and one a model answers, are cut to this. */
const NAME_CHARS = 60

const SYSTEM = `You name chats in a list of coding sessions, so the person can tell them apart at a glance. You are given what the person has asked in one chat. Answer a short name for what the chat is working on: 2 to 6 words, sentence case, no quotes, no trailing full stop, never "Chat about" or "Session on". Name the goal, not the latest small step: "Fix untitled chat names", not "Run the checks". If a current name is given and it still describes the goal, answer it exactly as it is — a name moves only when the work has moved on. Answer {"name": "..."} and nothing else.`

const SCHEMA = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }

/**
 * id -> `{ name, auto, autoFor, autoAt, failedFor, failedAt }`. `name` is the person's;
 * `auto` the model's, made when the harness's title was `autoFor`, at `autoAt`.
 * @type {Map<string, object> | null}
 */
let store = null
let writing = Promise.resolve()

async function load() {
  if (store) return store
  const raw = await readJsonFile(STORE_FILE, { aside: true }).catch((err) => {
    console.warn(`[outpost] ${err.message}; starting with no chat names`)
    return undefined
  })
  store = new Map(Object.entries(raw?.titles || {}).filter(([, rec]) => rec && typeof rec === 'object'))
  return store
}

function persist() {
  const titles = Object.fromEntries(store)
  writing = writing.then(async () => {
    try {
      await fsp.mkdir(DATA_DIR, { recursive: true })
      const tmp = STORE_FILE + '.tmp'
      await fsp.writeFile(tmp, JSON.stringify({ version: 1, titles }, null, 2))
      await fsp.rename(tmp, STORE_FILE)
    } catch (err) {
      console.warn(`[outpost] chat names not saved: ${err.message}`)
    }
  })
  return writing
}

const cleanName = (s) =>
  String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“‘`]+|["'”’`.]+$/g, '')
    .trim()
    .slice(0, NAME_CHARS)
    .trim()

/** Set the person's name for a chat; an empty one clears it, and the automatic name comes back. */
export async function setName(id, name) {
  const s = await load()
  const clean = cleanName(name)
  const rec = { ...(s.get(id) || {}) }
  if (clean) rec.name = clean
  else delete rec.name
  s.set(id, rec)
  await persist()
  return { ok: true, name: clean }
}

/**
 * A chat started fresh from a handoff carries on under a new session id (handoff.md), and so a
 * new thread id: its name comes with it — the person's and the automatic one — once, onto a new
 * id that has none of its own. Without it a chat named by a person came back untitled.
 */
export async function carryName(from, to) {
  const s = await load()
  const was = s.get(from)
  if (!was || !to || s.has(to) || (!was.name && !was.auto)) return false
  s.set(to, { ...(was.name ? { name: was.name } : {}), ...(was.auto ? { auto: was.auto, autoFor: was.autoFor, autoAt: was.autoAt } : {}) })
  await persist()
  return true
}

/**
 * Stamp each thread's title, in place, and queue the ones due an automatic name.
 *
 * `promptTitle` keeps what the harness said, so the page can still show it; `titleSource` is
 * `person`, `auto` or `prompt`, so the rename field knows whether there is a name to clear.
 */
export async function applyTitles(threads) {
  const s = await load()
  const now = Date.now()
  for (const t of threads) {
    const rec = s.get(t.id) || {}
    t.promptTitle = t.title
    if (rec.name) {
      t.title = rec.name
      t.titleSource = 'person'
    } else if (t.titleNamed) {
      t.titleSource = 'person'
    } else if (rec.auto) {
      t.title = rec.auto
      t.titleSource = 'auto'
    } else {
      t.titleSource = 'prompt'
    }
    if (AUTO && due(t, rec, now)) enqueue(t, rec)
  }
  return threads
}

/**
 * Whether a thread should be (re)named now. Not one a person named, not an archived one, not
 * one with nothing typed in it yet. A first name straight away; after that only when the
 * latest prompt has changed, the turn is over, and the last naming is ten minutes old.
 */
function due(t, rec, now) {
  if (rec.name || t.titleSource === 'person' || t.archived || !t.hasTranscript) return false
  const subject = t.promptTitle
  if (!subject || subject === 'Untitled thread' || subject === 'New session') return false
  if (rec.autoFor === subject) return false
  if (rec.failedFor === subject && now - (rec.failedAt || 0) < RETRY_MS) return false
  if (!rec.auto) return true
  return !t.running && now - (rec.autoAt || 0) >= RENAME_GAP_MS
}

/** id -> what to name it from. One naming at a time, in the order the roster had them: newest first. */
const queue = new Map()
let working = false

function enqueue(t, rec) {
  if (queue.has(t.id)) return
  queue.set(t.id, { id: t.id, harness: t.harness, ref: t.ref, subject: t.promptTitle, current: rec.auto || '' })
  if (!working) work()
}

async function work() {
  working = true
  try {
    while (queue.size) {
      const [id, job] = queue.entries().next().value
      try {
        const name = await nameFor(job)
        const s = await load()
        // A person may have named it while the model was thinking; theirs stands.
        const rec = { ...(s.get(id) || {}) }
        if (name) Object.assign(rec, { auto: name, autoFor: job.subject, autoAt: Date.now() })
        else Object.assign(rec, { failedFor: job.subject, failedAt: Date.now() })
        s.set(id, rec)
        await persist()
      } catch (err) {
        console.warn(`[outpost] could not name chat ${id}: ${err.message}`)
        const s = await load()
        s.set(id, { ...(s.get(id) || {}), failedFor: job.subject, failedAt: Date.now() })
        await persist()
      } finally {
        queue.delete(id)
      }
    }
  } finally {
    working = false
  }
}

/** The model's name for a chat, from its prompts; `''` when it has nothing to go on. */
async function nameFor(job) {
  const { first, recent } = await readPrompts(job.harness, job.ref, { limit: 6 })
  if (!recent.length && !first) return ''
  const lines = [job.current ? `Current name: ${job.current}` : 'This chat has no name yet.', '', `First request:\n${first || recent[0]}`]
  if (recent.length) lines.push('', 'Latest requests, oldest first:', ...recent.map((p, i) => `${i + 1}. ${p}`))
  const out = await runCli(lines.join('\n'))
  let answer
  try {
    answer = JSON.parse(out)
  } catch {
    throw new Error('the CLI did not answer in JSON')
  }
  if (answer.is_error) throw new Error(String(answer.result || 'the run failed').slice(0, 300))
  let name = answer.structured_output?.name
  if (!name) {
    const m = /\{[\s\S]*\}/.exec(String(answer.result || ''))
    try {
      name = m ? JSON.parse(m[0]).name : ''
    } catch {
      name = ''
    }
  }
  return cleanName(name)
}

/**
 * One `claude -p` on Haiku, as custom-push.mjs runs one: no tools, no MCP servers, no hooks or
 * CLAUDE.md, and nothing written to disk — so it cannot change anything and is never a chat of
 * its own in the list. Signed in the way chats are, so it spends what they spend.
 */
async function runCli(input) {
  const args = [
    '-p',
    '--safe-mode',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--permission-prompts',
    'none',
    '--model',
    'haiku',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(SCHEMA),
    '--system-prompt',
    SYSTEM,
    '--tools',
    '',
  ]
  const env = { ...process.env, ...(await claudeEnv()), DISABLE_AUTOUPDATER: '1' }
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, { cwd: os.tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('it took too long to answer'))
    }, RUN_TIMEOUT_MS)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(e.code === 'ENOENT' ? `the ${CLAUDE_BIN} program is not on this machine's PATH` : e.message))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (out.trim()) resolve(out)
      else reject(new Error(err.trim().split('\n').slice(-1)[0] || `the CLI exited ${code}`))
    })
    child.stdin.end(input)
  })
}
