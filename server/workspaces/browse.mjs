/**
 * Browsing what a chat's container sees, for the Files section's Browse tree (ui-details.md):
 * one folder at a time out of the workspace folder, or out of the container's own `/tmp`, and a
 * name search across the workspace (workspaces.md *Files*).
 *
 * Bounded like `readWorkspaceFile`: a workspace path is checked by its letters and then by its
 * real path, so neither `..` nor a link reaches past the folder. The container's `/tmp` is not on
 * this disk at all — it is read through `/proc/<pid>/root`, where a link inside the container
 * would resolve against the *host* if followed, so there no link is followed, at any depth.
 *
 * No cache: one folder, read and stat'd, is about 2 ms, and a whole checkout's walk with the
 * ignored trees skipped about 6 ms (measured on Outpost's own checkout, 2026-10-14).
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { BIN_BYTES, FILE_BYTES, bytesOf, insideWorkspace, realInside, workspaceDir } from './files.mjs'
import { git } from './git.mjs'

const execFileAsync = promisify(execFile)

/** The most entries one folder answers with; past it the answer says `capped`. */
export const DIR_ENTRIES = 2000
/** A search stops after this many entries looked at, or this long, and says `capped`. */
export const FIND_VISITS = 5000
export const FIND_MS = 2000
/** The most matches a search answers with. */
export const FIND_MATCHES = 200

/** Always flagged ignored, git or no git: what nobody browsing a chat's work wants in the way. */
const ALWAYS_IGNORED = new Set(['.git', 'node_modules'])

const kindOf = (d) => (d.isDirectory() ? 'dir' : d.isFile() ? 'file' : d.isSymbolicLink() ? 'link' : 'other')

/**
 * The folder's entries, folders first then by name, at most `DIR_ENTRIES`. Kinds come from the
 * listing itself, so a link is a `link` and is never followed; only what is kept is stat'd.
 */
async function entriesOf(dir) {
  const all = await fsp.readdir(dir, { withFileTypes: true })
  all.sort((a, b) => (a.isDirectory() === b.isDirectory() ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.isDirectory() ? -1 : 1))
  const kept = all.slice(0, DIR_ENTRIES)
  const entries = await Promise.all(
    kept.map(async (d) => {
      const st = await fsp.lstat(path.join(dir, d.name)).catch(() => null)
      return { name: d.name, kind: kindOf(d), size: st?.size || 0, modifiedAt: st?.mtimeMs || 0, ignored: ALWAYS_IGNORED.has(d.name) }
    })
  )
  return { entries, capped: all.length > DIR_ENTRIES }
}

/** The chat's checkout that holds `abs` by its letters, or `''`. */
function checkoutOf(m, abs) {
  for (const r of m?.repos || []) {
    const root = String(r.path || '')
    if (root && (abs === root || abs.startsWith(root + path.sep))) return root
  }
  return ''
}

/**
 * Stamp `ignored` on the entries of `abs` by the checkout's own ignore rules. Only inside one
 * of the chat's checkouts, and only through `git()`, which tells git its dirs from Outpost's
 * layout and pins off hooks and fsmonitor (workspaces-git.md): a session can write its checkout,
 * so git left to find its own way runs what the session configured, as the owner. A folder
 * outside every checkout — `home/`, a repo a session cloned there — gets the fixed names only.
 * A non-zero exit (nothing ignored, or git refusing) is nothing ignored.
 */
async function markIgnored(m, abs, entries) {
  const root = checkoutOf(m, abs)
  const ask = entries.filter((e) => !e.ignored)
  if (!root || !ask.length) return
  let out = ''
  try {
    const names = ask.map((e) => path.relative(root, path.join(abs, e.name)) + '\0').join('')
    out = await git(['-C', root, 'check-ignore', '-z', '--stdin'], { timeout: 5000, input: names })
  } catch {
    return
  }
  const ignored = new Set(out.split('\0').filter(Boolean).map((p) => path.basename(p)))
  for (const e of ask) if (ignored.has(e.name)) e.ignored = true
}

/**
 * One folder of the workspace: `{ ok, path, entries, capped }`, each entry `{ name, kind, size,
 * modifiedAt, ignored }`. `p` is `''` for the workspace folder itself, else a path inside it — a
 * relative one placed from the workspace folder. Refused like a file is: outside by its letters
 * or by its real path, a NUL; `missing` when it is not there.
 */
export async function listWorkspaceDir(m, p) {
  const s = String(p ?? '')
  if (s.includes('\0')) return { ok: false, error: 'That is not a path' }
  const abs = s ? insideWorkspace(m, s, workspaceDir(m)) : m?.id ? workspaceDir(m) : ''
  if (!abs) return { ok: false, error: "That folder is not in this chat's workspace", outside: true }
  const real = await realInside(m, abs)
  if (!real) {
    const there = await fsp.lstat(abs).catch(() => null)
    return there ? { ok: false, error: 'That link leads out of the workspace', outside: true } : { ok: true, path: abs, entries: [], capped: false, missing: true }
  }
  const st = await fsp.stat(real)
  if (!st.isDirectory()) return { ok: false, error: 'That is a file, not a folder' }
  const { entries, capped } = await entriesOf(real)
  await markIgnored(m, abs, entries)
  return { ok: true, path: abs, entries, capped }
}

/**
 * `p` as a path under the container's `/tmp`, normalised, or `''`: absolute, no NUL, no `..`
 * anywhere in it, and `/tmp` or below once resolved.
 */
export function tmpPath(p) {
  const s = String(p ?? '')
  if (!s.startsWith('/') || s.includes('\0') || s.split('/').includes('..')) return ''
  const r = path.posix.resolve(s)
  return r === '/tmp' || r.startsWith('/tmp/') ? r : ''
}

/**
 * The host path of the container path `inside`, under `root` (`/proc/<pid>/root`), walked one
 * component at a time with `lstat`: `{ at, st }`, `{ link: true }` when any component is a link,
 * or `{ missing: true }`. Refusing a link rather than following it is the whole point: through
 * /proc a link resolves against the host's root, not the container's.
 */
async function walkUnder(root, inside) {
  let at = root
  let st = null
  for (const part of inside.split('/').filter(Boolean)) {
    at = `${at}/${part}`
    st = await fsp.lstat(at).catch(() => null)
    if (!st) return { missing: true }
    if (st.isSymbolicLink()) return { link: true }
  }
  return { at, st }
}

const LINK_REFUSED = { ok: false, error: 'That path goes through a link, which is not followed in the container' }

/** One folder of the container's `/tmp`: the answer `listWorkspaceDir` gives, with no git. */
export async function listTmpDir(root, p) {
  const inside = tmpPath(p)
  if (!inside) return { ok: false, error: "That is not a path in the container's /tmp" }
  const w = await walkUnder(root, inside)
  if (w.link) return LINK_REFUSED
  if (w.missing) return { ok: true, path: inside, entries: [], capped: false, missing: true }
  if (!w.st.isDirectory()) return { ok: false, error: 'That is a file, not a folder' }
  return { ok: true, path: inside, ...(await entriesOf(w.at)) }
}

/**
 * A file of the container's `/tmp` opened for a read, no link followed: `{ inside, fh }`, or the
 * answer to send instead — not a `/tmp` path, a link, `missing`, or a folder.
 */
async function openTmp(root, p) {
  const inside = tmpPath(p)
  if (!inside) return { answer: { ok: false, error: "That is not a path in the container's /tmp" } }
  const w = await walkUnder(root, inside)
  if (w.link) return { answer: LINK_REFUSED }
  if (w.missing) return { answer: { ok: true, path: inside, text: '', missing: true } }
  if (!w.st.isFile()) return { answer: { ok: false, error: 'That is a folder, not a file' } }
  // O_NOFOLLOW: a file swapped for a link between the walk and the open is refused, not followed.
  const fh = await fsp.open(w.at, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW).catch(() => null)
  return fh ? { inside, fh } : { answer: LINK_REFUSED }
}

/** One file of the container's `/tmp`, as `readWorkspaceFile` answers: the same cap, refusals and `binary`, no link followed. */
export async function readTmpFile(root, p, { maxBytes = FILE_BYTES } = {}) {
  const { answer, inside, fh } = await openTmp(root, p)
  if (answer) return answer
  try {
    const st = await fh.stat()
    const buf = Buffer.alloc(Math.min(st.size, maxBytes))
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    const head = buf.subarray(0, bytesRead)
    if (head.includes(0)) return { ok: true, path: inside, text: '', binary: true, size: st.size, modifiedAt: st.mtimeMs, truncated: false }
    return { ok: true, path: inside, text: head.toString('utf8'), size: st.size, modifiedAt: st.mtimeMs, truncated: st.size > maxBytes }
  } finally {
    await fh.close()
  }
}

/** One file of the container's `/tmp` as bytes, as `readWorkspaceBytes` answers, no link followed. */
export async function readTmpBytes(root, p, { maxBytes = BIN_BYTES } = {}) {
  const { answer, inside, fh } = await openTmp(root, p)
  if (answer) return answer
  try {
    return { ...(await bytesOf(fh, inside, maxBytes)), path: inside }
  } finally {
    await fh.close()
  }
}

const RECORD_ID = /^[A-Za-z0-9_-]{1,64}$/
/** Per session record, the container's pid and its start time, so a reused pid is never taken for it. */
const containerPids = new Map()

/** A process's start time (field 22 of `stat`), or `''` once it is gone. */
async function startOf(pid) {
  const stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '')
  return stat ? stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] || '' : ''
}

/**
 * `/proc/<pid>/root` of the session record's container, or `''` when it is not running. The
 * container is `outpost-session-<record id>` (structured.mjs); its pid is asked of Podman once
 * and kept while that process lives and its `/tmp` reads.
 */
export async function containerRoot(recordId) {
  if (!RECORD_ID.test(String(recordId || ''))) return ''
  const cached = containerPids.get(recordId)
  if (cached && (await startOf(cached.pid)) === cached.start) {
    const root = `/proc/${cached.pid}/root`
    if (await fsp.lstat(`${root}/tmp`).catch(() => null)) return root
  }
  containerPids.delete(recordId)
  let pid = 0
  try {
    const { stdout } = await execFileAsync('podman', ['inspect', '--format', '{{.State.Pid}}', `outpost-session-${recordId}`], { timeout: 5000 })
    pid = Number(stdout.trim()) || 0
  } catch {
    return '' // no such container
  }
  const start = pid ? await startOf(pid) : ''
  if (!start) return ''
  const root = `/proc/${pid}/root`
  if (!(await fsp.lstat(`${root}/tmp`).catch(() => null))) return ''
  containerPids.set(recordId, { pid, start })
  return root
}

/**
 * The start time `containerRoot` last kept for the record's container, `''` when none is kept.
 * Sent beside a `/tmp` answer as `since`, so the page can tell a container started later from
 * the one it read before (ui-details.md *Browse*).
 */
export function containerStart(recordId) {
  return containerPids.get(recordId)?.start || ''
}

/**
 * The workspace's files whose path from the workspace folder holds `q`, case aside:
 * `{ ok, dir, paths, capped }`, `paths` relative to `dir`. Inside each checkout one `git
 * ls-files` names the files git does not ignore; outside them the walk is plain, skipping `.git`,
 * `node_modules` and every link. Stops at `FIND_VISITS` entries or `FIND_MS`, and keeps
 * `FIND_MATCHES`; either says `capped`.
 */
export async function findInWorkspace(m, q, { visits = FIND_VISITS, ms = FIND_MS, matches = FIND_MATCHES } = {}) {
  const needle = String(q ?? '').trim()
  if (needle.length < 2 || needle.length > 80) return { ok: false, error: 'Search for 2 to 80 characters' }
  const dir = m?.id ? workspaceDir(m) : ''
  if (!dir) return { ok: false, error: 'No workspace' }
  const lower = needle.toLowerCase()
  const end = Date.now() + ms
  const paths = []
  let seen = 0
  let capped = false
  const spent = () => {
    if (seen >= visits || Date.now() > end) capped = true
    return capped
  }
  const consider = (rel) => {
    seen++
    if (!rel.toLowerCase().includes(lower)) return
    if (paths.length < matches) paths.push(rel)
    else capped = true
  }
  const roots = (m.repos || []).map((r) => String(r.path || '')).filter((r) => r && r.startsWith(dir + path.sep))
  for (const root of roots) {
    if (spent()) break
    let out = ''
    try {
      out = await git(['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { timeout: Math.max(200, end - Date.now()) })
    } catch {
      continue // a checkout git will not vouch for is not searched, rather than walked by hand
    }
    for (const p of out.split('\0')) {
      // node_modules is skipped whether or not the repo ignores it.
      if (!p || p.split('/').some((part) => ALWAYS_IGNORED.has(part))) continue
      if (spent()) break
      consider(path.relative(dir, path.join(root, p)))
    }
  }
  const skip = new Set(roots)
  const queue = [dir]
  while (queue.length && !spent()) {
    const at = queue.shift()
    const list = await fsp.readdir(at, { withFileTypes: true }).catch(() => [])
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const d of list) {
      if (spent()) break
      const abs = path.join(at, d.name)
      if (ALWAYS_IGNORED.has(d.name) || skip.has(abs)) continue
      if (d.isDirectory()) {
        seen++
        queue.push(abs)
      } else if (d.isFile()) consider(path.relative(dir, abs))
    }
  }
  return { ok: true, dir, paths, capped }
}
