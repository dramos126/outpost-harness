/**
 * Data a project needs that is not in its repo (docs/proposals/settings.md, phase 4).
 *
 * **What** a project needs is the project's to say, in its repo, `.outpost/data.json`:
 *
 *   { "datasets": [
 *       { "name": "fixtures", "env": "FIXTURES_DIR", "access": "read", "refreshedBy": "fixtures-refresh" },
 *       { "name": "reports", "env": "REPORTS_DIR", "access": "write" },
 *       { "name": "app-db", "env": "APP_DB_PATH", "access": "snapshot",
 *         "sources": ["staging", "prod"], "scrub": ".outpost/scrub-app-db.sql",
 *         "checks": ["SELECT COUNT(*) FROM …"] } ] }
 *
 * **Where** it comes from is this machine's, on the repo's page (`dataSources`: a host and a
 * path, one per source for a snapshot) — the same project on another machine names another.
 *
 * - `read`: one copy on this machine, `~/.outpost/datasets/<repo>/<name>`, shared by every chat
 *   and made read-only to them; pulled with rsync over ssh with the host's own key, refreshed
 *   when it is older than a day as a chat starts, when the Jenkins job named `refreshedBy`
 *   reports a success, and on Sync now. A chat costs nothing extra, and in a container it is one
 *   read-only bind.
 * - `write`: each chat its own folder in its workspace, seeded from the source so what is there
 *   can be read, and published back with `data_publish` — adding and updating; a file the chat
 *   deleted or moved is removed from the source only once the person has said yes to the list.
 * - `snapshot`: none by default. On request a SQLite database is backed up on its host with
 *   SQLite's own `.backup`, scrubbed here with the script the repo ships, and checked with the
 *   queries the repo declares — each must answer 0 — before the chat may have it; a copy that
 *   fails a check is deleted, and a dataset with no scrub script gets none at all. The copy is
 *   the chat's own; staging and prod are untouched.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { ENV_NAME, listRepos } from './catalogue.mjs'
import { defaultBranch, git, mirrorPath } from './git.mjs'
import { environmentByName } from '../config.mjs'
import { sshRun, sshTarget } from '../environments.mjs'

export const DATASETS_DIR = process.env.OUTPOST_DATASETS || path.join(os.homedir(), '.outpost', 'datasets')
const STATE_FILE = path.join(DATASETS_DIR, 'state.json')

/**
 * Every file a yes removed from a write dataset's source, `{ [path]: { size, mtime } }` as the
 * listing printed it, one list per dataset for every chat. A chat's own seed cannot stand in:
 * a sync before 2026-10-21 rewrote the seed and kept the stale file, so to that chat the file
 * looked new here and was sent back. A file matching its entry is dropped from a copy instead
 * (`planDeletes`); one at the same path with other content is new and goes.
 */
const removedPath = (repoId, name) => path.join(DATASETS_DIR, `removed-${repoId}-${name}.json`)

async function readRemoved(repoId, name) {
  try {
    const r = JSON.parse(await fsp.readFile(removedPath(repoId, name), 'utf8'))
    return r && typeof r === 'object' ? r : {}
  } catch {
    return {}
  }
}

async function recordRemoved(repoId, name, entries) {
  const file = removedPath(repoId, name)
  const removed = { ...(await readRemoved(repoId, name)), ...entries }
  await fsp.mkdir(DATASETS_DIR, { recursive: true })
  await fsp.writeFile(`${file}.tmp`, JSON.stringify(removed))
  await fsp.rename(`${file}.tmp`, file)
}
const MANIFEST = '.outpost/data.json'
/** A read copy older than this is refreshed as a chat starts on its repo. */
const STALE_MS = 24 * 60 * 60 * 1000
/** A copy over the LAN that takes longer than this is not going to finish. */
const COPY_TIMEOUT_MS = 30 * 60 * 1000
const ACCESS = new Set(['read', 'write', 'snapshot'])

const str = (v) => (typeof v === 'string' ? v.trim() : '')
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`

function run(cmd, args, { timeout = COPY_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${cmd} did not finish in ${timeout / 60000} minutes`))
    }, timeout)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) return resolve(out)
      // The message is the last line; the rest rides along for a caller that has to say which
      // files an rsync could not handle — its last line is only "see previous errors".
      reject(Object.assign(new Error(err.trim().split('\n').pop() || `${cmd} exited ${code}`), { code, stdout: out, stderr: err }))
    })
  })
}

/** One dataset as declared, made safe to act on, or null for one that is not whole. */
function normaliseDataset(raw) {
  const name = str(raw?.name)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const env = str(raw?.env)
  const access = str(raw?.access)
  if (!name || !ENV_NAME.test(env) || !ACCESS.has(access)) return null
  const ds = { name, env, access, description: str(raw?.description).slice(0, 300) }
  if (access === 'read' && str(raw?.refreshedBy)) ds.refreshedBy = str(raw.refreshedBy)
  if (access === 'snapshot') {
    ds.sources = (Array.isArray(raw?.sources) ? raw.sources : []).map(str).filter((s) => /^[a-z0-9_-]{1,30}$/i.test(s))
    if (!ds.sources.length) ds.sources = ['default']
    ds.scrub = str(raw?.scrub)
    ds.checks = (Array.isArray(raw?.checks) ? raw.checks : []).map(str).filter(Boolean)
  }
  return ds
}

/**
 * What a repo declares, read from its mirror at the latest of its main branch:
 * `{ ok, datasets }`, or `{ ok: false, error }`. A repo with no manifest declares nothing.
 */
export async function manifestOf(repo) {
  const mirror = mirrorPath(repo.id)
  let base
  try {
    base = repo.baseBranch || (await defaultBranch(mirror))
  } catch {
    return { ok: false, error: `${repo.name} has not been fetched on this machine yet — start a chat on it once` }
  }
  let text
  try {
    text = await git(['show', `origin/${base}:${MANIFEST}`], { cwd: mirror })
  } catch {
    return { ok: true, datasets: [] }
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { ok: false, error: `${MANIFEST} on ${base} is not valid JSON: ${err.message}` }
  }
  const seen = new Set()
  const datasets = (Array.isArray(raw?.datasets) ? raw.datasets : []).map(normaliseDataset).filter((d) => d && !seen.has(d.name) && seen.add(d.name))
  return { ok: true, datasets }
}

/** Where a dataset comes from on this machine, `{ env, path }` with the host's entry, or a refusal. */
async function sourceOf(repo, ds, source = '') {
  const s = (repo.dataSources || []).find((x) => x.dataset === ds.name && (x.source || '') === (source === 'default' ? '' : source))
  if (!s) throw new Error(`${repo.name}'s ${ds.name}${source && source !== 'default' ? ` (${source})` : ''} has no source on this machine — set its host and path on the repo's page`)
  const env = await environmentByName(s.host)
  if (!env) throw new Error(`${ds.name} names a host "${s.host}" that is not under Integrations › Hosts`)
  return { env, path: s.path }
}

/** `rsync` arguments that go over the host's own ssh: its key, Outpost's known_hosts. */
async function rsyncSsh(env) {
  const { args, target } = await sshTarget(env)
  return { rsh: ['ssh', ...args].map(q).join(' '), target }
}

async function loadState() {
  try {
    return JSON.parse(await fsp.readFile(STATE_FILE, 'utf8'))
  } catch {
    return {}
  }
}

async function saveState(state) {
  await fsp.mkdir(DATASETS_DIR, { recursive: true })
  await fsp.writeFile(`${STATE_FILE}.tmp`, JSON.stringify(state, null, 2))
  await fsp.rename(`${STATE_FILE}.tmp`, STATE_FILE)
}

/** Each read copy of a repo's: `{ [name]: { at, files, bytes, error } }`. */
export async function readState(repoId) {
  return (await loadState())[repoId] || {}
}

async function measure(dir) {
  let files = 0
  let bytes = 0
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      const r = await measure(p)
      files += r.files
      bytes += r.bytes
    } else if (e.isFile()) {
      files++
      bytes += (await fsp.stat(p).catch(() => ({ size: 0 }))).size
    }
  }
  return { files, bytes }
}

const readCopyPath = (repoId, name) => path.join(DATASETS_DIR, repoId, name)

/** One sync of a read copy at a time per dataset; a second asker shares the first's answer. */
const syncing = new Map()

/**
 * Bring a read copy up to date from its source: made writable to Outpost, pulled with
 * `rsync --delete` (which deletes only in the copy, never on the source), then made
 * read-only again so a chat's own write fails loudly instead of changing what every chat
 * reads. Answers `{ at, files, bytes }` and records it, or records and throws the error.
 */
export function syncRead(repo, ds) {
  const key = `${repo.id}\u0000${ds.name}`
  if (syncing.has(key)) return syncing.get(key)
  const job = (async () => {
    const dest = readCopyPath(repo.id, ds.name)
    const state = await loadState()
    state[repo.id] ||= {}
    try {
      const { env, path: from } = await sourceOf(repo, ds)
      const { rsh, target } = await rsyncSsh(env)
      await fsp.mkdir(dest, { recursive: true })
      await run('chmod', ['-R', 'u+w', dest])
      await run('rsync', ['-a', '--delete', '--no-owner', '--no-group', '-e', rsh, `${target}:${from.replace(/\/+$/, '')}/`, `${dest}/`])
      await run('chmod', ['-R', 'a-w', dest])
      const m = await measure(dest)
      state[repo.id][ds.name] = { at: Date.now(), files: m.files, bytes: m.bytes }
      await saveState(state)
      return state[repo.id][ds.name]
    } catch (err) {
      await run('chmod', ['-R', 'a-w', dest]).catch(() => {})
      state[repo.id][ds.name] = { ...(state[repo.id][ds.name] || {}), error: String(err?.message || err), errorAt: Date.now() }
      await saveState(state)
      throw err
    }
  })().finally(() => syncing.delete(key))
  syncing.set(key, job)
  return job
}

/**
 * A chat's data, as its checkout's `.env.local` should name it: `{ vars, notes }`. Each read
 * dataset's shared copy, refreshed first if it is stale — a copy that cannot be refreshed but
 * exists is used, and said; each write dataset's own folder for this chat, seeded from the
 * source. Snapshots are on request only (`takeSnapshot`). A dataset with no source on this
 * machine is skipped with a note: the app falls back to its own default, as without Outpost.
 */
export async function provisionData(repo, workspaceDir, log = async () => {}) {
  const vars = {}
  const notes = []
  const manifest = await manifestOf(repo)
  if (!manifest.ok) {
    notes.push(manifest.error)
    return { vars, notes }
  }
  const state = await readState(repo.id)
  for (const ds of manifest.datasets) {
    try {
      if (ds.access === 'read') {
        const dest = readCopyPath(repo.id, ds.name)
        const st = state[ds.name]
        if (!st?.at || Date.now() - st.at > STALE_MS) {
          await log(`${repo.name}: syncing ${ds.name}`)
          try {
            await syncRead(repo, ds)
          } catch (err) {
            if (!st?.at) throw err
            notes.push(`${ds.name}: could not refresh (${err.message}); using the copy from ${new Date(st.at).toISOString().slice(0, 16)}`)
          }
        }
        vars[ds.env] = dest
      } else if (ds.access === 'write') {
        const dir = path.join(workspaceDir, 'data', repo.id, ds.name)
        await fsp.mkdir(dir, { recursive: true })
        const { env, path: from } = await sourceOf(repo, ds)
        const { rsh, target } = await rsyncSsh(env)
        await log(`${repo.name}: copying ${ds.name} in`)
        await run('rsync', ['-a', '--no-owner', '--no-group', '-e', rsh, `${target}:${from.replace(/\/+$/, '')}/`, `${dir}/`])
        // What the source held as the copy was made: a publish tells a file this chat deleted
        // from one that appeared on the source since by this list (`planDeletes`).
        await writeSeed(workspaceDir, repo.id, ds.name, (await listSource(env, from)).files)
        vars[ds.env] = dir
      }
    } catch (err) {
      notes.push(`${ds.name}: ${err.message}`)
    }
  }
  for (const n of notes) await log(`${repo.name}: ${n}`)
  return { vars, notes }
}

/** The manifest's dataset by name, or a refusal naming what there is. */
async function datasetNamed(repo, name, access) {
  const manifest = await manifestOf(repo)
  if (!manifest.ok) throw new Error(manifest.error)
  const ds = manifest.datasets.find((d) => d.name === String(name || '').trim())
  if (!ds) throw new Error(`${repo.name} declares no dataset "${name}" — it has ${manifest.datasets.map((d) => d.name).join(', ') || 'none'}`)
  if (access && ds.access !== access) throw new Error(`${ds.name} is a ${ds.access} dataset, not ${access}`)
  return ds
}

// ── what a write dataset's source holds, and what this chat took away ──────────────────

/**
 * The seed list of a chat's write copy: every file of the source's this chat has seen, as the
 * source held it when the copy was made or last published or synced (`seenSeed`),
 * `{ at, files: { [path]: { size, mtime } } }`, beside the copy in the
 * workspace's `data/<repo>/`. Without it a publish cannot tell a file this chat deleted from
 * one that appeared on the source since: both are "on the source, not here". The chat can
 * read it, and could edit it; what that buys is nothing, since every removal is a list the
 * person sees and says yes to.
 */
const seedPath = (workspaceDir, repoId, name) => path.join(workspaceDir, 'data', repoId, `.seed-${name}.json`)

/** Where a clash's source version is saved (`planDeletes`): beside the copy, never in it. */
const theirsPath = (workspaceDir, repoId, name) => path.join(workspaceDir, 'data', repoId, `.theirs-${name}`)

async function readSeed(workspaceDir, repoId, name) {
  try {
    const s = JSON.parse(await fsp.readFile(seedPath(workspaceDir, repoId, name), 'utf8'))
    return s && typeof s.files === 'object' ? s.files : {}
  } catch {
    return {}
  }
}

async function writeSeed(workspaceDir, repoId, name, files) {
  const file = seedPath(workspaceDir, repoId, name)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(`${file}.tmp`, JSON.stringify({ at: Date.now(), files }))
  await fsp.rename(`${file}.tmp`, file)
}

/**
 * The seed after a publish or a sync: the source as listed now, but only what this chat has
 * seen — a file the copy holds as listed (`localStats`), as listed; any other still in the seed,
 * as the seed had it, so a change there since stays one (a conflict, `behind`, a clash). A file
 * the source gained that never reached the copy is left out, and so stays new. Writing the whole
 * listing made it "deleted here" instead (2026-10-21: a narrow publish took a night's batch run
 * and four folders into the seed, never pulled, and every sync after left them out as this
 * chat's deletions); writing the listing for every file the copy has, however old, made a stale
 * one read as edited here.
 */
export function seenSeed({ seed, source, localStats }) {
  const files = {}
  for (const [p, now] of Object.entries(source)) {
    if (sameAsSeen(now, localStats[p])) files[p] = now
    else if (seed[p]) files[p] = seed[p]
  }
  return files
}

/** The seed rewritten from a fresh listing (`seenSeed`); a listing that fails leaves the old one. */
async function reseed(env, from, workspaceDir, repoId, name, dir) {
  const [seed, listing, local] = await Promise.all([readSeed(workspaceDir, repoId, name), listSource(env, from), listLocal(dir)])
  await writeSeed(workspaceDir, repoId, name, seenSeed({ seed, source: listing.files, localStats: local.stats }))
}

/**
 * rsync's `--list-only` lines, `{ [path]: { size, mtime } }` for the regular files: a mode, a
 * size (with thousands commas), `YYYY/MM/DD HH:MM:SS`, the path. The time stays the string
 * it was printed as — it is only ever compared with another listing of the same source.
 */
export function parseListing(text) {
  const files = {}
  for (const line of String(text).split('\n')) {
    const m = line.match(/^(-\S{9})\s+([\d,]+)\s+(\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d)\s+(.+)$/)
    if (m && m[4] !== '.') files[m[4]] = { size: Number(m[2].replace(/,/g, '')), mtime: m[3] }
  }
  return files
}

/** The folders in the same listing, as paths; the root (`.`) is never one. */
export function parseListingDirs(text) {
  const dirs = []
  for (const line of String(text).split('\n')) {
    const m = line.match(/^d\S{9}\s+[\d,]+\s+\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d\s+(.+)$/)
    if (m && m[1] !== '.') dirs.push(m[1])
  }
  return dirs
}

/** What the source holds under `from`: `{ files }` as `parseListing` reads them, `dirs` its folders. */
async function listSource(env, from) {
  const { rsh, target } = await rsyncSsh(env)
  const text = await run('rsync', ['-r', '--list-only', '-e', rsh, `${target}:${from.replace(/\/+$/, '')}/`])
  return { files: parseListing(text), dirs: parseListingDirs(text) }
}

/** Every regular file and every folder under `dir`, as paths relative to it; `stats` each file's size and time. */
async function listLocal(dir, prefix = '', out = { files: [], dirs: [], stats: {} }) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) {
      out.dirs.push(rel)
      await listLocal(path.join(dir, e.name), rel, out)
    } else if (e.isFile()) {
      out.files.push(rel)
      const s = await fsp.stat(path.join(dir, e.name)).catch(() => null)
      if (s) out.stats[rel] = { size: s.size, mtimeMs: s.mtimeMs }
    }
  }
  return out
}

/**
 * `removedThere` dropped from the copy, and the folders that leaves empty, deepest first, never
 * the copy's root. Answers the folders that went.
 */
async function dropFromCopy(dir, files) {
  const parents = new Set()
  for (const p of files) {
    await fsp.rm(path.join(dir, p), { force: true })
    for (let d = path.dirname(p); d && d !== '.'; d = path.dirname(d)) parents.add(d)
  }
  const gone = []
  for (const d of [...parents].sort((a, b) => b.split('/').length - a.split('/').length)) {
    if (await fsp.rmdir(path.join(dir, d)).then(() => true, () => false)) gone.push(d)
  }
  return gone
}

/**
 * What a publish does about the files on the source that are not in the copy, each put in one
 * of three groups by the seed list (`seed`: the source as this chat last saw it; `source`: as
 * it is now; `local`: the copy's files):
 * - `fresh`: not in the seed — added on the source since; pulled into the copy, never removed;
 * - `conflicts`: in the seed, but changed on the source since — someone else's edit of a file
 *   this chat deleted; pulled back and reported, never removed;
 * - `candidates`: in the seed and unchanged there — what this chat deleted or moved away;
 *   removed from the source only with the person's yes.
 * `rel` narrows all three to one folder, as `data_publish`'s `path` narrows the send.
 *
 * And `folders`, the source's folders the candidates' removal would leave empty
 * (`emptiedFolders`), when `sourceDirs` and `localDirs` are given.
 *
 * The mirror case, the files in the copy and the seed but gone from the source — another chat's
 * approved removal — by `localStats` (`{ [path]: { size, mtimeMs } }`):
 * - `removedThere`: unchanged here since the seed; dropped from the copy, so the send cannot put
 *   them back (2026-10-21: stale copies resurrected a cleanup twice);
 * - `editedHere`: changed here since; sent, and reported. A file with no stat is this group too,
 *   so a caller without stats sends as before.
 * `removed` (`readRemoved`) adds the files any chat's yes removed: one not in the seed but
 * matching its entry is `removedThere` too, since the seed of a stale copy may have lost it.
 *
 * And the files on both sides, by the seed as their common base (2026-10-21: a routine's rewrite
 * of a shared index never reached a chat, and `--update` alone chose by time, so a chat's edit on
 * a stale base overwrote the routine's):
 * - `behind`: changed there, not here — pulled. So is one older here than the version the seed
 *   says this chat saw: no edit made since can be older, and a seed from before this rule
 *   recorded the source's newer version against a copy that never got it;
 * - `clashes`: changed on both sides — never sent; the source's version saved beside the copy
 *   (`theirs`) for the chat to merge. One whose seed entry is still marked `clash` stays one
 *   while its saved version is there (`theirs`, the paths that are), so an unmerged file is
 *   not sent on the next publish either;
 * - changed here only: none of these, so sent.
 */
export function planDeletes({ seed, source, local, localStats = {}, removed = {}, theirs = new Set(), rel = '', sourceDirs = [], localDirs = [], emptyToo = false }) {
  const have = new Set(local)
  const inside = (p) => !rel || p === rel || p.startsWith(`${rel}/`)
  const fresh = []
  const conflicts = []
  const candidates = []
  const behind = []
  const clashes = []
  for (const [p, now] of Object.entries(source)) {
    if (!inside(p)) continue
    const was = seed[p]
    if (have.has(p)) {
      const mine = localStats[p]
      if (was?.clash && theirs.has(p)) clashes.push(p)
      else if (sameAsSeen(was, mine)) {
        if (was.size !== now.size || was.mtime !== now.mtime) behind.push(p)
      } else if (was && was.size === now.size && was.mtime === now.mtime) {
        if (olderThanSeen(was, mine)) behind.push(p)
      } else if (mine && !sameAsSeen(now, mine)) clashes.push(p)
      continue
    }
    if (!was) fresh.push(p)
    else if (was.size !== now.size || was.mtime !== now.mtime) conflicts.push(p)
    else candidates.push(p)
  }
  const removedThere = []
  const editedHere = []
  for (const p of local) {
    if (source[p] || !inside(p)) continue
    if (sameAsSeen(seed[p], localStats[p]) || sameAsSeen(removed[p], localStats[p])) removedThere.push(p)
    else if (seed[p]) editedHere.push(p)
  }
  const folders = emptiedFolders({ sourceFiles: Object.keys(source), sourceDirs, localDirs, candidates, rel, emptyToo })
  return { fresh: fresh.sort(), conflicts: conflicts.sort(), candidates: candidates.sort(), folders, removedThere: removedThere.sort(), editedHere: editedHere.sort(), behind: behind.sort(), clashes: clashes.sort() }
}

/**
 * A copy's file against its seed entry: the same size, and a time within a second of the one the
 * listing printed (`YYYY/MM/DD HH:MM:SS`, this machine's zone — rsync prints it here, and `-a`
 * kept it). The second is the listing's rounding; a real edit moves the time further.
 */
function sameAsSeen(was, now) {
  if (!was || !now || was.size !== now.size) return false
  const seen = listedMs(was.mtime)
  return !Number.isNaN(seen) && Math.abs(now.mtimeMs - seen) < 2000
}

/** A copy's file older than its seed entry, past the listing's rounding (`behind`). */
function olderThanSeen(was, now) {
  return Boolean(was && now) && now.mtimeMs < listedMs(was.mtime) - 2000
}

/** A listing's `YYYY/MM/DD HH:MM:SS`, this machine's zone, as ms; NaN for anything else. */
function listedMs(mtime) {
  const m = String(mtime).match(/^(\d{4})\/(\d\d)\/(\d\d) (\d\d):(\d\d):(\d\d)$/)
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : NaN
}

/**
 * The source's folders to remove with the candidates, deepest first so each is empty when its
 * turn comes. A folder goes only when all of these hold:
 * - it is inside `rel` (never `rel` itself) and never the dataset's root;
 * - it is not a folder in the copy, even an empty one: the copy is what the source should match;
 * - no file stays under it on the source once the candidates are gone (a file new there, one
 *   brought back, one this chat kept);
 * - this removal is what empties it: a candidate is somewhere under it, and so under every
 *   folder below it — a folder that was empty before is left, and so is one holding it.
 * `emptyToo` drops the last condition, for a publish asked to tidy folders already empty there
 * and absent here (`data_publish`'s `empty_folders`); every other one still holds, and the
 * person still says yes to the list.
 */
export function emptiedFolders({ sourceFiles, sourceDirs, localDirs, candidates, rel = '', emptyToo = false }) {
  const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
  const ancestors = (p) => {
    const out = []
    for (let d = parentOf(p); d; d = parentOf(d)) out.push(d)
    return out
  }
  const gone = new Set(candidates)
  const blocked = new Set(localDirs)
  for (const f of sourceFiles) if (!gone.has(f)) for (const d of ancestors(f)) blocked.add(d)
  const touched = new Set(candidates.flatMap(ancestors))
  const inside = (d) => !rel || d.startsWith(`${rel}/`)
  const children = new Map()
  for (const d of sourceDirs) {
    const p = parentOf(d)
    if (!children.has(p)) children.set(p, [])
    children.get(p).push(d)
  }
  const depth = (d) => d.split('/').length
  const ok = new Map()
  for (const d of [...sourceDirs].sort((a, b) => depth(b) - depth(a))) {
    ok.set(d, inside(d) && !blocked.has(d) && (emptyToo || touched.has(d)) && (children.get(d) || []).every((c) => ok.get(c)))
  }
  return sourceDirs.filter((d) => ok.get(d)).sort((a, b) => depth(b) - depth(a) || a.localeCompare(b))
}

/** A path from a listing the source command may name: relative, no `..`, printable. */
function sourceRelative(p) {
  const s = String(p)
  if (!s || s.startsWith('/') || s.split('/').includes('..') || s.split('/').includes('') || /[\x00-\x1f]/.test(s)) throw new Error(`"${s}" is not a path inside the dataset`)
  return s
}

/** The source command names this many files at a time; a chat that moved a folder of runs is hundreds. */
const REMOVE_CHUNK = 100

/**
 * The person said yes: `files` removed from the source of `name`, and from the seed, so the
 * next publish does not pull them back; then `folders`, the ones the same yes covered
 * (`emptiedFolders`). Only ever the lists that were confirmed — `rm -f` on each file and
 * `rmdir` on each folder, under the source's folder, never a `--delete` nor an `rm -r`:
 * rsync's deletion is of whatever the sender lacks, and the point here is to remove nothing the
 * person has not read. `rmdir` removes only an empty folder, so one that gained a file since
 * the question is left, and is not in the answer. Answers `{ files, folders }` removed.
 */
export async function removeFromSource(repo, name, workspaceDir, files, folders = []) {
  const ds = await datasetNamed(repo, name, 'write')
  const { env, path: to } = await sourceOf(repo, ds)
  const rels = [...new Set((files || []).map(sourceRelative))]
  const dirs = [...new Set((folders || []).map(sourceRelative))]
  for (let i = 0; i < rels.length; i += REMOVE_CHUNK) {
    const chunk = rels.slice(i, i + REMOVE_CHUNK)
    await sshRun(env, `cd ${q(to)} && rm -f -- ${chunk.map(q).join(' ')}`, { timeout: COPY_TIMEOUT_MS })
  }
  const seed = await readSeed(workspaceDir, repo.id, ds.name)
  // The seed's entry is the source's: only a file unchanged there since was ever a candidate.
  await recordRemoved(repo.id, ds.name, Object.fromEntries(rels.filter((p) => seed[p]).map((p) => [p, seed[p]])))
  for (const p of rels) delete seed[p]
  await writeSeed(workspaceDir, repo.id, ds.name, seed)
  // Deepest first, as listed; each one that went is printed, so a folder a file reached since
  // is told apart from one removed.
  const removedDirs = []
  for (let i = 0; i < dirs.length; i += REMOVE_CHUNK) {
    const chunk = dirs.slice(i, i + REMOVE_CHUNK)
    const out = await sshRun(env, `cd ${q(to)} && for d in ${chunk.map(q).join(' ')}; do rmdir -- "$d" 2>/dev/null && printf '%s\\n' "$d"; done; true`, { timeout: COPY_TIMEOUT_MS })
    const done = new Set(String(out || '').split('\n'))
    removedDirs.push(...chunk.filter((d) => done.has(d)))
  }
  return { files: rels, folders: removedDirs }
}

/**
 * `data_publish`: a write dataset's new and changed files back to its source — `rsync
 * --update`, never `--delete`, so a chat cannot remove what another chat or a person put
 * there. `sub` narrows it to one folder of the copy, sent to the same place under the source
 * (`-R` from `<dir>/./<sub>`, which also makes the folders above it there).
 *
 * Before the send, the source is listed and compared with the seed list (`planDeletes`):
 * files added there since are pulled into the copy, a file this chat deleted that someone
 * changed there is pulled back, a file removed there since and untouched here is dropped from
 * the copy (`dropped`; one edited here is sent, `resent`), and the files this chat deleted or moved away come back as
 * `pending` — the caller puts that list to the person, and `removeFromSource` acts on a yes.
 * A move is the add first (sent here) and the removal only after the yes, so a file is never
 * gone from the source before its copy is there. The seed is then the source as it is after
 * the send, so what was sent counts as seen, bar what never reached the copy (`seenSeed`). The folders those removals would leave empty
 * come back as `pendingFolders` (`emptiedFolders`), asked about in the same question; with
 * `emptyToo`, folders already empty there and absent here as well.
 *
 * Folder times and permissions are not carried: the source's folders are often another
 * user's, and setting either on them fails and turned a publish whose every file went into
 * an rsync code 23 (2026-10-05). A partial transfer (23, 24) is an answer, not a throw: the
 * files that went and rsync's own lines for what did not, which its last line only points at.
 *
 * Every file compared is accounted for: `-ii` itemizes the ones already there unchanged, and
 * `--info=skip1` names those `--update` kept because the source's is newer. Without both a
 * publish of files an earlier partial run had sent answered "0 files" and nothing else, and
 * the chat could not tell sent from never seen (2026-10-05).
 * Answers `{ dataset, to, sent, same, newer, pulled, conflicts, dropped, resent, pending: [path], pendingFolders: [path], errors: [line], partial }`.
 */
export async function publishWrite(repo, name, workspaceDir, sub = '', { emptyToo = false } = {}) {
  const ds = await datasetNamed(repo, name, 'write')
  const dir = path.join(workspaceDir, 'data', repo.id, ds.name)
  const rel = String(sub || '').trim().replace(/^\/+|\/+$/g, '')
  if (rel && (path.isAbsolute(rel) || rel.split('/').includes('..'))) throw new Error(`"${sub}" must be a folder inside ${ds.name}`)
  if (rel && !(await fsp.stat(path.join(dir, rel)).catch(() => null))?.isDirectory()) throw new Error(`${ds.name} has no folder "${rel}"`)
  const { env, path: to } = await sourceOf(repo, ds)
  const { rsh, target } = await rsyncSsh(env)
  const remote = `${target}:${to.replace(/\/+$/, '')}/`
  // The source first: what is there and not here is pulled in, bar what this chat took away.
  const plan = await pullIn(repo, ds, workspaceDir, rel, { emptyToo })
  const from = rel ? ['-R', `${dir}/./${rel}/`] : [`${dir}/`]
  // A clash is the one file here the plan says not to send. `--update` stays as the backstop for
  // a write there between the listing and the send.
  const skip = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'outpost-send-')), 'exclude')
  await fsp.writeFile(skip, plan.clashes.map(excludeRule).join('\n') + '\n')
  let out
  let stderr = ''
  let partial = false
  try {
    out = await run('rsync', ['-a', '--update', '--no-owner', '--no-group', '--no-perms', '--omit-dir-times', '-ii', '--info=skip1', `--exclude-from=${skip}`, '-e', rsh, ...from, remote])
  } catch (err) {
    if (err.code !== 23 && err.code !== 24) throw err
    out = err.stdout
    stderr = err.stderr
    partial = true
  } finally {
    await fsp.rm(path.dirname(skip), { recursive: true, force: true })
  }
  const lines = out.split('\n')
  // An itemized file is 11 flag characters, a space, the path: `<f` sent, `.f` already the same.
  const files = (re) => lines.filter((l) => re.test(l)).map((l) => l.slice(12))
  const sent = files(/^<f/)
  const same = files(/^\.f/)
  const newer = lines.map((l) => l.match(/^(.+) is newer$/)?.[1]).filter(Boolean)
  // rsync's closing summary says only that there were errors; the lines before it say which.
  const errors = stderr.split('\n').map((l) => l.trim()).filter((l) => l && !/^rsync error: /.test(l))
  // Seen now: the source as it is, sent files included, bar what never reached the copy — a
  // narrow publish pulls only inside `rel`. A listing that fails leaves the old seed, which is at
  // worst one more file pulled back next time.
  await reseed(env, to, workspaceDir, repo.id, ds.name, dir).catch(() => {})
  return { dataset: ds.name, to: `${env.name}:${to}${rel ? `/${rel}` : ''}`, sent, same, newer, pulled: plan.pulled, conflicts: plan.conflicts, behind: plan.behind, clashes: plan.clashes, dropped: plan.removedThere, resent: plan.editedHere, pending: plan.candidates, pendingFolders: plan.folders, errors, partial }
}

/**
 * What the source holds and the copy does not, brought in — bar what this chat deleted on
 * purpose (`planDeletes`): the exact files by name (`--files-from` sends nothing else), so a
 * candidate stays gone here. Answers the plan with `pulled` (fresh and conflicts together).
 */
async function pullIn(repo, ds, workspaceDir, rel = '', { emptyToo = false } = {}) {
  const dir = path.join(workspaceDir, 'data', repo.id, ds.name)
  const theirsDir = theirsPath(workspaceDir, repo.id, ds.name)
  const { env, path: from } = await sourceOf(repo, ds)
  const source = await listSource(env, from)
  const local = await listLocal(dir)
  const seed = await readSeed(workspaceDir, repo.id, ds.name)
  const theirs = new Set((await listLocal(theirsDir)).files)
  const plan = planDeletes({ seed, source: source.files, local: local.files, localStats: local.stats, removed: await readRemoved(repo.id, ds.name), theirs, rel, sourceDirs: source.dirs, localDirs: local.dirs, emptyToo })
  // Removed there since this chat saw it, and untouched here: gone here too, before any send.
  const droppedFolders = await dropFromCopy(dir, plan.removedThere)
  const pulled = [...plan.fresh, ...plan.conflicts, ...plan.behind]
  await fetchFiles(env, from, pulled, dir)
  // A clash's source version goes beside the copy, never into it, so no publish sends it; the
  // seed marks the clash, so the file is not sent while that version is there unmerged.
  if (plan.clashes.length) {
    await fetchFiles(env, from, plan.clashes, theirsDir)
    for (const p of plan.clashes) seed[p] = { ...source.files[p], clash: true }
    await writeSeed(workspaceDir, repo.id, ds.name, seed)
  }
  return { ...plan, pulled, droppedFolders }
}

/** The named files of the source under `from`, into `to` at the same paths (`--files-from`, those alone). */
async function fetchFiles(env, from, files, to) {
  if (!files.length) return
  const { rsh, target } = await rsyncSsh(env)
  const list = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'outpost-pull-')), 'files')
  try {
    await fsp.writeFile(list, files.join('\n') + '\n')
    await run('rsync', ['-a', '--no-owner', '--no-group', `--files-from=${list}`, '-e', rsh, `${target}:${from.replace(/\/+$/, '')}/`, `${to}/`])
  } finally {
    await fsp.rm(path.dirname(list), { recursive: true, force: true })
  }
}

/**
 * An rsync exclude rule for exactly one path from the dataset's root. rsync reads a backslash
 * as an escape only when the rule holds a wildcard, so only then is everything escaped.
 */
export function excludeRule(p) {
  const s = String(p)
  return `/${/[*?[]/.test(s) ? s.replace(/[*?[\\]/g, (c) => `\\${c}`) : s}`
}

/**
 * `data_sync` on a write dataset: the copy brought up to date from its source without sending
 * anything — what a publish does first, on its own, for a chat that wants to see what another
 * chat or a job put there since. The seed becomes the source as this chat has seen it now (`seenSeed`); what this chat
 * deleted stays deleted here and is still `pending` for the next publish to ask about.
 * Answers `{ dataset, from, pulled, conflicts, pending }`.
 */
export async function syncWrite(repo, name, workspaceDir) {
  const ds = await datasetNamed(repo, name, 'write')
  const { env, path: from } = await sourceOf(repo, ds)
  const plan = await pullIn(repo, ds, workspaceDir)
  // Listed again after the pull: a file written there in between is not in the copy, so stays new.
  await reseed(env, from, workspaceDir, repo.id, ds.name, path.join(workspaceDir, 'data', repo.id, ds.name)).catch(() => {})
  return { dataset: ds.name, from: `${env.name}:${from}`, pulled: plan.pulled, conflicts: plan.conflicts, behind: plan.behind, clashes: plan.clashes, dropped: plan.removedThere, resent: plan.editedHere, pending: plan.candidates }
}

/**
 * True when SQLite's own compiled program for `sql` reaches a file other than the open one:
 * ATTACH (reads any database the owner can read into the copy, or creates one anywhere the owner
 * can write), DETACH, or VACUUM INTO (writes the copy anywhere). The scrub script comes from the
 * chat's checkout, which the session writes, and runs on the host; node:sqlite in Node 22 has no
 * authorizer and no SQLITE_LIMIT_ATTACHED, so the program is inspected instead of the text —
 * comments, case and quoting cannot hide an opcode. EXPLAIN only compiles; nothing runs.
 */
function reachesAnotherFile(db, sql) {
  return db.prepare(`EXPLAIN ${sql}`).all().some((op) =>
    ((op.opcode === 'Function' || op.opcode === 'PureFunc') && /^sqlite_(attach|detach)\b/.test(String(op.p4 ?? ''))) ||
    (op.opcode === 'Vacuum' && Number(op.p2) !== 0))
}

/** What is left of a script once leading blanks, empty statements and comments are gone. */
function skipToStatement(sql) {
  let s = sql
  for (;;) {
    const next = s.replace(/^[\s;]+/, '').replace(/^--[^\n]*(\n|$)/, '').replace(/^\/\*[\s\S]*?(\*\/|$)/, '')
    if (next === s) return s
    s = next
  }
}

/**
 * Runs `script` on `db` one statement at a time, each split off by SQLite's own parser (a
 * prepared statement's source is exactly its text), refusing any that reaches another file —
 * the check before each runs, so the statements before it have run and later ones see them.
 */
export function execConfined(db, script) {
  let rest = skipToStatement(String(script))
  while (rest) {
    const one = db.prepare(rest).sourceSQL
    if (!one || !rest.startsWith(one)) throw new Error('the script could not be split into statements')
    if (reachesAnotherFile(db, one)) throw new Error(`"${one.trim().slice(0, 80)}" reaches a file other than the copy (ATTACH, DETACH and VACUUM INTO are refused)`)
    db.exec(one)
    rest = skipToStatement(rest.slice(one.length))
  }
}

/** One check query, the same refusal as the scrub: its first row's first value. */
export function checkConfined(db, check) {
  const sql = String(check)
  const stmt = db.prepare(sql)
  if (reachesAnotherFile(db, stmt.sourceSQL)) throw new Error(`the check "${sql}" reaches a file other than the copy`)
  const row = stmt.get()
  return row ? Object.values(row)[0] : null
}

/** The scrub file's real path, refused unless it is inside the checkout once links are followed. */
export async function scrubPathIn(checkoutDir, rel) {
  const root = await fsp.realpath(checkoutDir)
  const inside = (p) => p.startsWith(root + path.sep)
  const named = path.resolve(root, rel)
  if (!inside(named)) throw new Error('scrub script must be inside the repo')
  // null when there is no such file: the caller says it is not in this checkout.
  const file = await fsp.realpath(named).catch(() => null)
  if (file && !inside(file)) throw new Error('scrub script must be inside the repo')
  return file
}

/**
 * `data_snapshot`: a scrubbed copy of a snapshot dataset from one of its sources, for this chat
 * alone. Backed up on the host with SQLite's own `.backup` (a copy of a live file is a torn
 * one), pulled, scrubbed with the repo's script from the chat's checkout, then every check run:
 * each must answer 0, or the copy is deleted and the reason given. Answers the copy's path.
 */
export async function takeSnapshot(repo, name, source, { checkoutDir, workspaceDir }) {
  const ds = await datasetNamed(repo, name, 'snapshot')
  const src = String(source || '').trim() || ds.sources[0]
  if (!ds.sources.includes(src)) throw new Error(`${ds.name} has no source "${src}" — it has ${ds.sources.join(', ')}`)
  if (!ds.scrub) throw new Error(`${ds.name} names no scrub script, so no copy of it is made — the repo adds one to its ${MANIFEST}`)
  // Real paths: a link in the checkout must not lead the read outside it.
  const scrubFile = await scrubPathIn(checkoutDir, ds.scrub).catch(() => {
    throw new Error(`${ds.name}'s scrub script must be inside the repo`)
  })
  const scrub = await (scrubFile ? fsp.readFile(scrubFile, 'utf8') : Promise.reject(new Error('missing'))).catch(() => {
    throw new Error(`${ds.name}'s scrub script ${ds.scrub} is not in this checkout`)
  })
  const { env, path: from } = await sourceOf(repo, ds, src)
  const dir = path.join(workspaceDir, 'data', repo.id)
  await fsp.mkdir(dir, { recursive: true })
  const to = path.join(dir, `${ds.name}-${src}.db`)
  const tmp = `/tmp/outpost-snapshot-${Date.now()}.db`
  // SQLite's backup either way: the sqlite3 shell, or python3's binding of the same call where
  // the host has no shell installed — a server image often has python and not sqlite3.
  const py = `import sqlite3,sys; s=sqlite3.connect(sys.argv[1]); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()`
  await sshRun(
    env,
    `if command -v sqlite3 >/dev/null; then sqlite3 ${q(from)} ${q(`.backup ${tmp}`)}; elif command -v python3 >/dev/null; then python3 -c ${q(py)} ${q(from)} ${q(tmp)}; else echo "${env.name} has neither sqlite3 nor python3 to back the database up with" >&2; exit 2; fi`,
    { timeout: COPY_TIMEOUT_MS },
  )
  try {
    const { args, target } = await sshTarget(env)
    await run('scp', ['-q', ...args.map((a) => (a === '-p' ? '-P' : a)), `${target}:${tmp}`, to])
  } finally {
    await sshRun(env, `rm -f ${q(tmp)}`, { timeout: 20000 }).catch(() => {})
  }
  try {
    const db = new DatabaseSync(to)
    try {
      execConfined(db, scrub)
      for (const check of ds.checks) {
        const value = checkConfined(db, check)
        if (Number(value) !== 0) throw new Error(`the check "${check}" answered ${value}, not 0`)
      }
      db.exec('VACUUM')
    } finally {
      db.close()
    }
  } catch (err) {
    await fsp.rm(to, { force: true })
    throw new Error(`The ${src} copy of ${ds.name} was scrubbed and failed its check, so it was deleted: ${err.message}`)
  }
  return { dataset: ds.name, source: src, path: to, env: ds.env, checks: ds.checks.length }
}

/**
 * A Jenkins job reported a success: every read dataset that names it as `refreshedBy` is
 * synced now, so the copy chats read is the one the job just made. A job matches by its own
 * name or as a branch of it (`refreshedBy: "docs-site"` takes `docs-site/main`).
 */
export async function refreshOnBuild(job) {
  const j = String(job || '')
  const synced = []
  for (const repo of await listRepos()) {
    const manifest = await manifestOf(repo).catch(() => ({ ok: false }))
    if (!manifest.ok) continue
    for (const ds of manifest.datasets.filter((d) => d.access === 'read' && d.refreshedBy && (j === d.refreshedBy || j.startsWith(`${d.refreshedBy}/`)))) {
      try {
        await syncRead(repo, ds)
        synced.push(`${repo.name}: ${ds.name}`)
      } catch {
        /* recorded in the state; the next chat start or Sync now tries again */
      }
    }
  }
  return synced
}

export { datasetNamed }
