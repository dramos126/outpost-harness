/**
 * Stopping a command a session left running in the background, from the page (launchers.md
 * *Stopping a background command*).
 *
 * Outpost holds no handle on it: the CLI spawned it, inside the chat's container. What it does
 * hold is the task's id (hooks.md `backgroundTasks`), and the CLI writes every background
 * command's output to `<tmp>/<project>/<session id>/tasks/<task id>.output`, open as the
 * shell's stdout for as long as it runs. A rootless container's processes are this user's on
 * the host, so `/proc` finds the shell by that path without asking Podman which container it
 * is in. The shell leads a process session of its own, so ending that session takes the command
 * and whatever it started, even ones that sent their output elsewhere.
 */
import fsp from 'node:fs/promises'

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/
const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/
/** How long a command gets to exit on SIGTERM before it is sent SIGKILL. */
const GRACE_MS = 3000

/** Process ids on this machine, as /proc lists them. */
async function pids() {
  const names = await fsp.readdir('/proc').catch(() => [])
  return names.filter((n) => /^\d+$/.test(n)).map(Number)
}

/** The process's session id, or 0 once it is gone. Field 6 of `stat`, read after the `)` that ends its name. */
async function sessionOf(pid) {
  const stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '')
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  return Number(rest[3]) || 0
}

/** Whether the process's stdout is this task's output file. Unreadable — another user's, or gone — is no. */
async function writesTo(pid, suffix) {
  const target = await fsp.readlink(`/proc/${pid}/fd/1`).catch(() => '')
  return target.endsWith(suffix)
}

/**
 * The processes running this session's task: every one in the process session its shell leads.
 * Only a leader that is itself writing the task's file names a session to end. A shell from a
 * CLI that did not start one of its own would otherwise put the CLI's session here, and the
 * chat would be ended with the command; there only the processes writing the file are taken.
 */
async function processesOf(sessionId, taskId) {
  const suffix = `/${sessionId}/tasks/${taskId}.output`
  const all = await pids()
  const writing = []
  for (const pid of all) if (await writesTo(pid, suffix)) writing.push(pid)
  if (!writing.length) return []
  const leaders = new Set()
  for (const pid of writing) if ((await sessionOf(pid)) === pid) leaders.add(pid)
  if (!leaders.size) return writing
  const out = []
  for (const pid of all) if (leaders.has(await sessionOf(pid))) out.push(pid)
  return out
}

const signal = (pid, sig) => {
  try {
    process.kill(pid, sig)
    return true
  } catch {
    return false
  }
}

/**
 * Stop one background command: SIGTERM to its processes, SIGKILL after `GRACE_MS` to any still
 * there in the same session. `{ ok, stopped }`, or `ok: false` when nothing is running under
 * that id — finished already, or never this session's.
 */
export async function stopBackgroundTask(sessionId, taskId) {
  if (!SESSION_ID.test(String(sessionId)) || !TASK_ID.test(String(taskId))) return { ok: false, error: 'Which command?' }
  const procs = await processesOf(sessionId, taskId)
  if (!procs.length) return { ok: false, error: 'That command is not running.' }
  const sessions = new Map()
  for (const pid of procs) sessions.set(pid, await sessionOf(pid))
  const stopped = procs.filter((pid) => signal(pid, 'SIGTERM')).length
  await new Promise((r) => setTimeout(r, GRACE_MS))
  // A pid can be reused within the grace; one still in the session it was found in is the same process.
  for (const pid of procs) {
    const sid = sessions.get(pid)
    if (sid && (await sessionOf(pid)) === sid) signal(pid, 'SIGKILL')
  }
  return { ok: true, stopped }
}

/** How much of a command's output the page is shown: its end, which is where a log says what happened. */
const OUTPUT_BYTES = 64 * 1024
/** Per session, the process whose root last held its tasks folder, so a read does not walk /proc every time. */
const rootPid = new Map()

/** The last `max` bytes of a file, or null when it cannot be opened. */
async function tailOf(file, max) {
  const fh = await fsp.open(file, 'r').catch(() => null)
  if (!fh) return null
  try {
    const { size } = await fh.stat()
    const start = Math.max(0, size - max)
    const buf = Buffer.alloc(size - start)
    const { bytesRead } = await fh.read(buf, 0, buf.length, start)
    return { text: buf.subarray(0, bytesRead).toString('utf8'), size, truncated: start > 0 }
  } finally {
    await fh.close()
  }
}

/**
 * The end of a background command's output, for the commands map. The file is in the chat's
 * container, under a `/tmp` the host does not share, so it is read through `/proc/<pid>/root` of
 * any process in that container — the same-user access `processesOf` relies on. `file` is the
 * in-container path the transcript names (harnesses.md `readCommands`), and must end in this
 * session's task, so no other path is ever opened. `{ ok, text, size, truncated }`, or
 * `missing: true` once the container, and the file with it, is gone.
 */
export async function readTaskOutput(sessionId, taskId, file) {
  if (!SESSION_ID.test(String(sessionId)) || !TASK_ID.test(String(taskId))) return { ok: false, error: 'Which command?' }
  const f = String(file || '')
  if (!f.startsWith('/') || f.includes('/../') || !f.endsWith(`/${sessionId}/tasks/${taskId}.output`)) return { ok: false, error: 'Which command?' }
  const cached = rootPid.get(sessionId)
  const tries = [f, ...(cached ? [`/proc/${cached}/root${f}`] : [])]
  for (const p of tries) {
    const out = await tailOf(p, OUTPUT_BYTES)
    if (out) return { ok: true, ...out }
  }
  for (const pid of await pids()) {
    const out = await tailOf(`/proc/${pid}/root${f}`, OUTPUT_BYTES)
    if (out) {
      rootPid.set(sessionId, pid)
      return { ok: true, ...out }
    }
  }
  rootPid.delete(sessionId)
  return { ok: true, text: '', size: 0, truncated: false, missing: true }
}
