/**
 * What a chat may do on another machine: the actions its owner wrote for that host, on the
 * hosts a chat's repo names, and nothing else (docs/proposals/settings.md, phase 3, question 6).
 *
 * A host is the one Outpost already copies data from (setup.md): an address, a user and one
 * of Outpost's own keys. It gains `actions`, each `read` — the files under one absolute path —
 * or `run` — one fixed command, exactly as written, with no arguments a chat could add. A
 * chat names an action; it never sends a command or a path that an action does not already
 * cover. The key stays in the store and the command runs from here, so a session gets a tool
 * and a result and never the credential (integrations.md). What comes back is scrubbed the way
 * the search index scrubs prompts and cut short; a tool result is never indexed.
 */
import path from 'node:path'
import { spawn } from 'node:child_process'
import { environmentByName } from './config.mjs'
import { sshTarget } from './environments.mjs'
import { scrub } from './search/index.mjs'
import { READ_CAP, RUN_CAP, lineWindow } from './mcp/caps.mjs'

/** How much of a command's output is kept, its end: the most `host_run` will answer (mcp/caps.mjs `RUN_CAP`). */
const OUTPUT_CAP = 64 * 1024
/** A command still running after this is stopped. */
const RUN_TIMEOUT_MS = 2 * 60 * 1000

/** A string as one word to a POSIX shell: the remote end of ssh runs the command through one. */
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`

/**
 * One command on a host: `{ code, stdout, stderr }`, each output its last `OUTPUT_CAP` bytes.
 * Run with the host's own key and Outpost's own known_hosts (environments.mjs `sshTarget`).
 */
function ssh(env, command, { timeout = RUN_TIMEOUT_MS, keep = OUTPUT_CAP } = {}) {
  return sshTarget(env).then(
    ({ args, target }) =>
      new Promise((resolve) => {
        const child = spawn('ssh', [...args, target, command], { stdio: ['ignore', 'pipe', 'pipe'] })
        const tail = () => {
          let buf = Buffer.alloc(0)
          return {
            add: (d) => {
              buf = Buffer.concat([buf, d])
              if (buf.length > keep * 2) buf = buf.subarray(buf.length - keep)
            },
            text: () => (buf.length > keep ? buf.subarray(buf.length - keep) : buf).toString('utf8'),
            cut: () => buf.length > keep,
          }
        }
        const out = tail()
        const err = tail()
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, timeout)
        child.stdout.on('data', out.add)
        child.stderr.on('data', err.add)
        child.on('error', (e) => {
          clearTimeout(timer)
          resolve({ code: -1, stdout: '', stderr: e.message, cut: false, timedOut })
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          resolve({ code: timedOut ? -1 : code, stdout: out.text(), stderr: err.text(), cut: out.cut(), timedOut })
        })
      })
  )
}

/**
 * The hosts a chat may use, by the names its repos give (`hosts` on a catalogue entry), each
 * with its actions: `[{ name, actions }]`. A name that is no host, or a host with no actions,
 * gives the chat nothing.
 */
export async function hostsNamed(names) {
  const out = []
  for (const name of new Set(names || [])) {
    const env = await environmentByName(name)
    if (env?.actions?.length) out.push(env)
  }
  return out
}

const refuse = (why) => {
  throw new Error(why)
}

/** The host by name among those a chat may use, or the refusal. */
function pick(hosts, name) {
  const env = hosts.find((h) => h.name === name)
  if (!env) refuse(`${name || 'That host'} is not one this chat may use — ${hosts.length ? `it may use ${hosts.map((h) => h.name).join(', ')}` : "its repos name none"}. The owner gives a repo a host on its page in Settings › Repos.`)
  return env
}

/**
 * `host_read`: a file, or a directory's listing, under a path one of the host's `read`
 * actions covers. The path is resolved on the host first (`realpath`) and checked again, so a
 * symlink cannot lead out of what was allowed; only then is it read — a window of whole lines
 * from line `offset`, or the last `-offset` lines, of at most `READ_CAP` bytes (mcp/caps.mjs),
 * cut on the host so a large log never crosses the wire whole. `{ host, path, kind: 'file' |
 * 'dir', text, from, to, total }`.
 */
export async function hostRead(hosts, name, wanted, { offset = 1 } = {}) {
  const env = pick(hosts, name)
  const reads = env.actions.filter((a) => a.kind === 'read')
  if (!reads.length) refuse(`Nothing on ${env.name} may be read — its actions only run commands`)
  const asked = String(wanted || '').trim()
  if (!asked.startsWith('/')) refuse('Give the whole path, from /')
  const under = (p) => reads.some((a) => p === a.target || p.startsWith(a.target === '/' ? '/' : `${a.target}/`))
  const p = path.posix.normalize(asked)
  if (!under(p)) refuse(`${p} is not under anything ${env.name} lets a chat read: ${reads.map((a) => a.target).join(', ')}`)
  const real = await ssh(env, `realpath -e -- ${q(p)}`, { timeout: 30000 })
  if (real.code !== 0) refuse(`${p} is not there on ${env.name}`)
  const resolved = real.stdout.trim()
  if (!under(resolved)) refuse(`${p} leads to ${resolved}, which is not under anything ${env.name} lets a chat read`)
  const n = Math.trunc(Number(offset)) || 1
  // The kind, the line count, then the window's bytes and one more, so a cut is known.
  const slice = n < 0 ? `tail -n ${-n} | tail -c ${READ_CAP + 1}` : `tail -n +${n} | head -c ${READ_CAP + 1}`
  const r = await ssh(env, `if [ -d ${q(resolved)} ]; then echo dir; src() { ls -la -- ${q(resolved)}; }; else echo file; src() { cat -- ${q(resolved)}; }; fi; src | wc -l; src | ${slice}`, { keep: READ_CAP + 256 })
  if (r.code !== 0) refuse(`Could not read ${resolved}: ${r.stderr.trim().split('\n').pop() || 'it failed'}`)
  const [kindLine, countLine] = r.stdout.split('\n', 2)
  const kind = kindLine === 'dir' ? 'dir' : 'file'
  let chunk = r.stdout.slice(kindLine.length + countLine.length + 2)
  // `tail -c` starts mid-line when it cut: that part line is not one to show.
  if (n < 0 && Buffer.byteLength(chunk) > READ_CAP && chunk.includes('\n')) chunk = chunk.slice(chunk.indexOf('\n') + 1)
  if (n > 1 && !chunk) return { host: env.name, path: resolved, kind, text: '', from: n, to: n - 1, total: Number(countLine) || 0 }
  const w = lineWindow(chunk, n < 0 ? n : 1, READ_CAP)
  const shown = w.to - w.from
  // A file with no newline at its end has one line more than `wc -l` counts.
  const total = Math.max(Number(countLine) || 0, n < 0 ? w.total : n - 1 + w.to)
  const from = n < 0 ? total - shown : n - 1 + w.from
  return { host: env.name, path: resolved, kind, text: scrub(w.text), from, to: from + shown, total }
}

/**
 * `host_run`: one of the host's `run` actions, by name, its command exactly as the owner wrote
 * it. `{ host, action, code, output, cut, timedOut }` — stdout then stderr, the end of each,
 * together at most `maxBytes` (`RUN_CAP` unless asked, never past `OUTPUT_CAP`), the end kept.
 */
export async function hostRun(hosts, name, action, { maxBytes = RUN_CAP } = {}) {
  const env = pick(hosts, name)
  const a = env.actions.find((x) => x.kind === 'run' && x.name === String(action || '').trim())
  if (!a) {
    const runs = env.actions.filter((x) => x.kind === 'run').map((x) => x.name)
    refuse(`${env.name} has no action ${action || ''} to run${runs.length ? ` — it has ${runs.join(', ')}` : ''}`)
  }
  const r = await ssh(env, a.target)
  const keep = Math.min(Math.max(Math.trunc(Number(maxBytes)) || RUN_CAP, 1024), OUTPUT_CAP)
  // Each stream keeps its end. stderr, where a failure says why, gets at least half the cap,
  // and all of what stdout leaves; stdout gets the rest.
  const err = r.stderr.trim() ? Buffer.from(`--- stderr ---\n${r.stderr.trimEnd()}`) : Buffer.alloc(0)
  const out = Buffer.from(r.stdout.trimEnd())
  const errRoom = Math.max(Math.floor(keep / 2), keep - out.length - 1)
  const errKept = err.length > errRoom ? err.subarray(err.length - errRoom) : err
  const room = keep - errKept.length - (errKept.length && out.length ? 1 : 0)
  let outKept = out.length > room ? out.subarray(out.length - room) : out
  // A cut lands mid-line; the part line says nothing.
  if (outKept.length < out.length && outKept.includes(10)) outKept = outKept.subarray(outKept.indexOf(10) + 1)
  const output = [outKept.toString('utf8'), errKept.toString('utf8')].filter(Boolean).join('\n')
  return { host: env.name, action: a.name, code: r.code, output: scrub(output), cut: r.cut || outKept.length < out.length || errKept.length < err.length, timedOut: r.timedOut }
}
