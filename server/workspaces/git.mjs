/**
 * Everything that runs `git` for a workspace: the bare mirror per repo, the worktree per chat,
 * and the questions asked of a checkout before it is pushed or deleted.
 *
 * One mirror per catalogue entry at `~/.outpost/repos/<id>.git`, fetched before every
 * checkout so a branch starts from the remote's current base. Checkouts are worktrees of it:
 * seconds and one object store, where a clone per chat is minutes and hundreds of megabytes.
 * **The mirror's path is part of the repo's identity** — Claude Code keys its memory on the
 * git common dir, so moving the mirror orphans every chat's memory (docs/proposals/harness.md,
 * phase 0 results).
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readSettings } from '../config.mjs'

const execFileAsync = promisify(execFile)

export const MIRRORS_DIR = process.env.OUTPOST_MIRRORS || path.join(os.homedir(), '.outpost', 'repos')

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }

/**
 * Settings no git run here ever takes from a repository. A chat's container can write its
 * checkout and its mirror, and Outpost's own git runs there as the owner: a `core.fsmonitor`
 * or a hook a session planted would run on the host at the next status or merge. The mirror's
 * `config` and `hooks/` are read-only in the container (containers/index.mjs); these are the
 * belt for what git reads from anywhere else — a submodule's git dir above all. On the command
 * line, so git hands them to every git it starts. Outpost relies on no hook running here: the
 * repo's own hooks run on a session's commits, inside its container.
 */
const PINNED = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']

/**
 * `git` with prompts off and a timeout; the error carries git's last line, which is the useful one.
 * Run in a checkout or a mirror (`cwd`, or a leading `-C <dir>`), it is told its git dirs
 * outright (`gitDirsFor`), never left to find them. `input` is written to its stdin (a
 * `--stdin` command's list).
 */
export async function git(args, { cwd, timeout = 60000, env = {}, input = null } = {}) {
  try {
    const at = args[0] === '-C' ? args[1] : cwd
    const dirs = at ? await gitDirsFor(at) : {}
    const running = execFileAsync('git', [...PINNED, ...args], { cwd, timeout, env: { ...ENV, ...dirs, ...env }, maxBuffer: 8 * 1024 * 1024 })
    if (input !== null) {
      // A git that exits before reading it all is answered by its exit; the broken pipe is not a crash.
      running.child.stdin?.on('error', () => {})
      running.child.stdin?.end(input)
    }
    const { stdout } = await running
    return stdout
  } catch (err) {
    const tail = String(err?.stderr || err?.message || err).trim().split('\n').filter(Boolean).slice(-1)[0]
    throw new Error(`git ${args[0]}: ${tail || 'failed'}`)
  }
}

export const mirrorPath = (repoId) => path.join(MIRRORS_DIR, `${repoId}.git`)

/**
 * The git dirs to run git in `dir` with, from Outpost's own layout rather than what the
 * checkout says: `{ GIT_DIR, GIT_COMMON_DIR, GIT_WORK_TREE }` for a checkout, `{ GIT_DIR,
 * GIT_COMMON_DIR }` for a mirror. A checkout's `.git` file and its admin dir's `commondir` are
 * the session's to write, and left to find its own way git follows them to whatever config the
 * session wrote — and runs what that config names, as the owner. So the admin dir must be
 * `<mirror>/worktrees/<name>` of a mirror under `MIRRORS_DIR`, pointing back at this checkout,
 * and the common dir is that mirror, whatever `commondir` says. A folder that is none of these —
 * a `.git` that is a folder, missing, or aimed elsewhere — is refused rather than searched
 * upward from, since the folders above are the session's too. Throws in words.
 */
export async function gitDirsFor(dir) {
  const at = path.resolve(dir)
  const mirrors = path.resolve(MIRRORS_DIR)
  const inMirrors = path.relative(mirrors, at)
  if (!inMirrors.startsWith('..') && !path.isAbsolute(inMirrors)) {
    // A mirror is a bare repo Outpost cloned; told so, git reads no `commondir` a chat left in it.
    return inMirrors && !inMirrors.includes(path.sep) && inMirrors.endsWith('.git') ? { GIT_DIR: at, GIT_COMMON_DIR: at } : {}
  }
  const refuse = (why) => {
    throw new Error(`${at} is not a checkout Outpost made: ${why}`)
  }
  // A checkout swapped for a link would have the owner's git write wherever it leads.
  const st = await fsp.lstat(at).catch(() => null)
  if (!st?.isDirectory()) refuse(st ? 'it is not a folder' : 'it is not there')
  const link = await fsp.readFile(path.join(at, '.git'), 'utf8').catch(() => '')
  const named = /^gitdir: (.+)$/m.exec(link)?.[1]?.trim()
  if (!named) refuse('its .git is not a worktree link')
  const admin = path.resolve(at, named)
  const mirror = path.dirname(path.dirname(admin))
  // Either spelling of the mirrors folder: git writes the path it resolved, links and all.
  const realMirrors = await fsp.realpath(mirrors).catch(() => mirrors)
  if (path.basename(path.dirname(admin)) !== 'worktrees' || ![mirrors, realMirrors].includes(path.dirname(mirror)) || !mirror.endsWith('.git'))
    refuse('its .git points outside the mirrors')
  // Through links too: an admin dir that is a link out of its mirror is not the mirror's.
  const [realAdmin, realMirror] = await Promise.all([fsp.realpath(admin).catch(() => ''), fsp.realpath(mirror).catch(() => '')])
  if (!realAdmin || path.dirname(path.dirname(realAdmin)) !== realMirror) refuse('its git dir is not in its mirror')
  const back = (await fsp.readFile(path.join(admin, 'gitdir'), 'utf8').catch(() => '')).trim()
  const realAt = await fsp.realpath(at).catch(() => at)
  if (!back || ![path.join(at, '.git'), path.join(realAt, '.git')].includes(path.resolve(admin, back))) refuse('its git dir belongs to another checkout')
  return { GIT_DIR: admin, GIT_COMMON_DIR: mirror, GIT_WORK_TREE: at }
}

const exists = (p) =>
  fsp.stat(p).then(
    () => true,
    () => false
  )

/**
 * The mirror for a repo, cloned if it is not there yet, fetched either way.
 *
 * `--bare` rather than `--mirror`: a mirror clone fetches tags and every ref, and prunes
 * local branches to match the remote — which would delete a chat's branch from under its
 * worktree the first time it fetched. The fetch refspec is set by hand so remote branches
 * land under `refs/remotes/origin/` and a chat's own branches under `refs/heads/` are never
 * touched by a fetch.
 */
export async function ensureMirror(repo, log = () => {}, remote = {}) {
  const dir = mirrorPath(repo.id)
  const { url = repo.url, env = {} } = remote
  if (!(await exists(dir))) {
    await fsp.mkdir(MIRRORS_DIR, { recursive: true })
    log(`Cloning ${repo.url} into ${dir}`)
    await git(['clone', '--bare', '--quiet', url, dir], { timeout: 10 * 60 * 1000, env })
    await git(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], { cwd: dir })
    // `origin` is the catalogued address whatever was cloned from (integrations.mjs `remoteFor`).
    if (url !== repo.url) await git(['remote', 'set-url', 'origin', repo.url], { cwd: dir })
  }
  await ensureIdentity(dir)
  log(`Fetching ${repo.name}`)
  await git(['fetch', '--quiet', '--prune', ...fromRemote(url, '*')], { cwd: dir, timeout: 5 * 60 * 1000, env })
  return dir
}

/**
 * What to fetch from: `origin` when there is no address of its own, else the address and the
 * refspec that lands its branches where `origin`'s would. Outpost reaches a repo by address
 * (integrations.mjs `remoteFor`), and the refs have to end up under `refs/remotes/origin/`
 * either way — every count and merge reads them there.
 */
function fromRemote(url, branch) {
  if (!url) return ['origin', ...(branch === '*' ? [] : [branch])]
  return [url, `+refs/heads/${branch}:refs/remotes/origin/${branch}`]
}

/**
 * Who commits in a worktree of this mirror. Every worktree shares the mirror's config, and a
 * worktree with no identity cannot commit at all — the session's own commits fail the same
 * way Outpost's merge did, with git asking who you are (the finish test, 2026-10-02). From
 * Settings when set, else the user's global git config, else the OS user at this host; an
 * identity written by a person is never overwritten by a guess.
 */
export async function identityFor() {
  const { git: g } = await readSettings()
  if (g?.name && g?.email) return { name: g.name, email: g.email, from: 'settings' }
  const read = async (key) => {
    try {
      return (await execFileAsync('git', ['config', '--global', '--get', key], { timeout: 5000 })).stdout.trim()
    } catch {
      return ''
    }
  }
  const [name, email] = await Promise.all([read('user.name'), read('user.email')])
  if (name && email) return { name, email, from: 'global' }
  const user = os.userInfo().username
  return { name: g?.name || name || user, email: g?.email || email || `${user}@${os.hostname()}`, from: 'host' }
}

async function ensureIdentity(mirror) {
  const current = await git(['config', '--get', 'user.email'], { cwd: mirror }).catch(() => '')
  const wanted = await identityFor()
  // A person's choice in Settings always wins; a guess only fills an empty slot.
  if (current.trim() && wanted.from !== 'settings') return
  await git(['config', 'user.name', wanted.name], { cwd: mirror })
  await git(['config', 'user.email', wanted.email], { cwd: mirror })
}

/** The branch the remote's HEAD points at, for a recipe that names none. */
export async function defaultBranch(mirror) {
  try {
    const out = await git(['symbolic-ref', '--short', 'HEAD'], { cwd: mirror })
    const name = out.trim().replace(/^origin\//, '')
    if (name && (await branchExists(mirror, `refs/remotes/origin/${name}`))) return name
  } catch {
    /* fall through to the candidates */
  }
  for (const name of ['main', 'master', 'dev']) {
    if (await branchExists(mirror, `refs/remotes/origin/${name}`)) return name
  }
  throw new Error('Could not work out the default branch — set one in the recipe')
}

/** Whether git would accept `name` as a branch, said before a worktree is attempted with it. */
export async function validBranchName(name) {
  try {
    await git(['check-ref-format', '--branch', name])
    return true
  } catch {
    return false
  }
}

export async function branchExists(mirror, ref) {
  try {
    await git(['rev-parse', '--verify', '--quiet', ref], { cwd: mirror })
    return true
  } catch {
    return false
  }
}

/**
 * A checkout at the latest of the base branch, holding no branch: a detached HEAD on
 * `origin/<base>`. Git will not check one branch out in two worktrees of a repository, and
 * every chat's checkout of a repo hangs off the same mirror, so "on main" for any number of
 * chats at once is the commit, not the branch. A branch is made when work starts
 * (`startWorkBranch`) — named for the work, not for the chat.
 *
 * Locked from the start. A chat's container mounts its own workspace and the whole mirror, so a
 * `git worktree prune` run there sees every other chat's checkout as gone and drops its entry:
 * one in a chat on 2026-10-18 cut 25 checkouts off the mirror, and `worktree add`
 * then handed three of the freed names to new chats. A prune, and `gc`'s, skip a locked entry.
 */
export async function addDetachedWorktree(mirror, dir, base, log = () => {}) {
  log(`Checking out origin/${base} (no branch until work starts)`)
  await fsp.mkdir(path.dirname(dir), { recursive: true })
  await git(['worktree', 'add', '--quiet', '--lock', '--reason', LOCK_REASON, '--detach', dir, `origin/${base}`], { cwd: mirror, timeout: 5 * 60 * 1000 })
}

/** Shown beside the entry by `git worktree list`, which is where a session pruning would look. */
export const LOCK_REASON = "Outpost chat checkout: a prune inside a chat's container cannot see the others"

/**
 * The entries of a mirror, from `git worktree list --porcelain -z`: `{ path, locked }` for
 * each but the bare mirror itself. `-z` because a path may hold a newline.
 */
async function worktreeEntries(mirror) {
  const out = await git(['worktree', 'list', '--porcelain', '-z'], { cwd: mirror })
  const entries = []
  let cur = null
  for (const field of out.split('\0')) {
    if (!field) {
      if (cur && !cur.bare) entries.push({ path: cur.path, locked: cur.locked })
      cur = null
    } else if (field.startsWith('worktree ')) cur = { path: field.slice('worktree '.length), locked: false, bare: false }
    else if (cur && field === 'bare') cur.bare = true
    else if (cur && (field === 'locked' || field.startsWith('locked '))) cur.locked = true
  }
  return entries
}

/**
 * The host's pass over one mirror's entries under `root` (the workspaces folder): lock each whose
 * folder is there and is not locked yet — every checkout from before the lock, and one a session
 * unlocked — and remove each whose folder is gone when `keep(<the folder under root it is in>)`
 * says no workspace holds it any more. Unlocked, that is the prune's job; locked, nothing else
 * would ever do it, and a stale entry holds its branch, so no other checkout could take it.
 * Only here on the host, which sees every workspace, is "gone" true. The branch is never
 * touched: one left behind keeps its commits reachable, as a delete does. Entries outside
 * `root` (a subagent's worktree, a session's scratch one) are not Outpost's and are left alone.
 * Answers `{ locked, freed, failed }`: the paths of the first two, and `{ path, error }` for an
 * entry git refused, the others still swept.
 */
export async function sweepMirror(mirror, { root, keep }) {
  const roots = [...new Set([path.resolve(root), await fsp.realpath(root).catch(() => path.resolve(root))])]
  const locked = []
  const freed = []
  const failed = []
  for (const entry of await worktreeEntries(mirror)) {
    const rel = roots.map((r) => path.relative(r, entry.path)).find((p) => p && !p.startsWith('..') && !path.isAbsolute(p))
    if (!rel) continue
    try {
      if (await exists(entry.path)) {
        if (entry.locked) continue
        await git(['worktree', 'lock', '--reason', LOCK_REASON, entry.path], { cwd: mirror })
        locked.push(entry.path)
      } else if (!(await keep(rel.split(path.sep)[0]))) {
        await git(['worktree', 'remove', '--force', '--force', entry.path], { cwd: mirror })
        freed.push(entry.path)
      }
    } catch (err) {
      failed.push({ path: entry.path, error: String(err?.message || err) })
    }
  }
  return { locked, freed, failed }
}

/** Bring one branch's latest from the remote into `refs/remotes/origin/`. */
export async function fetchBranch(dir, branch, remote = {}) {
  const { url = '', env = {} } = remote
  await git(['fetch', '--quiet', ...fromRemote(url, branch)], { cwd: dir, timeout: 5 * 60 * 1000, env })
}

/**
 * Make the branch new work goes on. A clean checkout first moves to the base's latest, so
 * the work starts from main as it is now; a checkout with changes in it keeps them and
 * branches where it stands, and the base is merged in when it is pushed instead — moving
 * uncommitted work across commits is how it gets lost. `--no-track`: from a remote-tracking
 * ref git would otherwise set the base as the upstream, and a bare `git push` would aim at it;
 * `pushBranch` sets the upstream to the branch's own name when it pushes.
 */
export async function startWorkBranch(dir, base, branch, { clean }) {
  if (clean) await git(['switch', '--quiet', '--detach', `origin/${base}`], { cwd: dir })
  await git(['switch', '--quiet', '--no-track', '-c', branch], { cwd: dir })
}

/** A branch name nobody has used in this mirror yet: the wanted one, else a numbered one. */
export async function freeBranchName(mirror, wanted) {
  if (!(await branchExists(mirror, `refs/heads/${wanted}`)) && !(await branchExists(mirror, `refs/remotes/origin/${wanted}`))) return wanted
  for (let i = 2; i < 100; i++) {
    const name = `${wanted}-${i}`
    if (!(await branchExists(mirror, `refs/heads/${name}`)) && !(await branchExists(mirror, `refs/remotes/origin/${name}`))) return name
  }
  throw new Error(`Every name near ${wanted} is taken`)
}

/**
 * What a checkout is doing relative to its base and its remote branch. `pushed` means the
 * remote has every commit on this branch; `clean` means nothing uncommitted. Both have to be
 * true before a workspace may be deleted on its own.
 *
 * `strict` throws wherever the default would guess — a missing checkout, a status git would
 * not give, a base it cannot find — so a caller that keeps a last known answer keeps it rather
 * than taking the guess for news (unpushed.mjs).
 */
export async function worktreeStatus(dir, base, branch, { strict = false } = {}) {
  const out = { exists: false, clean: true, changed: 0, ahead: 0, behind: 0, pushed: false, remoteBranch: false, head: '', broken: false }
  if (!(await exists(dir))) {
    if (strict) throw new Error(`${dir} is not there`)
    return out
  }
  out.exists = true
  try {
    const status = await git(['status', '--porcelain', '--untracked-files=normal'], { cwd: dir })
    out.changed = status.split('\n').filter(Boolean).length
    out.clean = out.changed === 0
  } catch (err) {
    if (strict) throw err
    // Not clean, since what it holds cannot be told — but `broken`, so it is not reported as
    // "0 uncommitted changes": a delete that stopped partway left a checkout of only `temp/`,
    // kept by aging under that reason for good (2026-10-14).
    out.clean = false
    out.broken = true
  }
  try {
    out.head = (await git(['rev-parse', '--short', 'HEAD'], { cwd: dir })).trim()
  } catch {
    /* an empty repo has no HEAD */
  }
  try {
    const counts = await git(['rev-list', '--left-right', '--count', `origin/${base}...HEAD`], { cwd: dir })
    const [behind, ahead] = counts.trim().split(/\s+/).map(Number)
    out.behind = behind || 0
    out.ahead = ahead || 0
  } catch (err) {
    if (strict) throw err
    /* base gone or unknown: the counts stay zero */
  }
  if (strict) {
    // Kept apart from the default below, whose one catch cannot tell "no remote branch" from
    // a count git failed to give: only the first is an answer.
    const remote = branch ? await git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { cwd: dir }).then(() => true, () => false) : false
    out.remoteBranch = remote
    out.pushed = remote ? Number((await git(['rev-list', '--count', `origin/${branch}..HEAD`], { cwd: dir })).trim()) === 0 : out.ahead === 0
    return out
  }
  try {
    await git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { cwd: dir })
    out.remoteBranch = true
    const unpushed = await git(['rev-list', '--count', `origin/${branch}..HEAD`], { cwd: dir })
    out.pushed = Number(unpushed.trim()) === 0
  } catch {
    // No remote branch yet: pushed only if there is nothing to push at all.
    out.remoteBranch = false
    out.pushed = out.ahead === 0
  }
  return out
}

/**
 * What a checkout holds that the remote does not, for a person deciding whether to delete it
 * (ui-settings.md *Workspaces*): the commits past `origin/<base>`, newest first, as short sha and
 * subject, and each uncommitted file as `new`, `deleted` or `changed` with its lines added and
 * removed. At most `limit` of each, with how many more. Read-only; "5 uncommitted files" alone
 * asked a person to delete work they could not see (2026-10-14).
 */
export async function heldWork(dir, base, { limit = 8 } = {}) {
  const out = { commits: [], moreCommits: 0, files: [], moreFiles: 0 }
  if (!(await exists(dir))) return out
  try {
    const log = await git(['log', '--format=%h%x09%s', `origin/${base}..HEAD`], { cwd: dir })
    const all = log
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [sha, ...subject] = l.split('\t')
        return { sha, subject: subject.join('\t') }
      })
    out.commits = all.slice(0, limit)
    out.moreCommits = Math.max(0, all.length - limit)
  } catch {
    /* no base, or not a repo: no commits to name */
  }
  try {
    const status = await git(['status', '--porcelain', '--untracked-files=normal'], { cwd: dir })
    // Lines added and removed against HEAD; an untracked file has none to compare, so is `new` alone.
    const counts = new Map()
    const numstat = await git(['diff', 'HEAD', '--numstat'], { cwd: dir }).catch(() => '')
    for (const l of numstat.split('\n').filter(Boolean)) {
      const [added, removed, ...p] = l.split('\t')
      counts.set(p.join('\t'), { added: Number(added) || 0, removed: Number(removed) || 0 })
    }
    const all = status
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const code = l.slice(0, 2)
        const file = l.slice(3).split(' -> ').pop()
        const state = code === '??' ? 'new' : code.includes('D') ? 'deleted' : 'changed'
        return { path: file, state, ...(counts.get(file) || { added: 0, removed: 0 }) }
      })
    out.files = all.slice(0, limit)
    out.moreFiles = Math.max(0, all.length - limit)
  } catch {
    /* not a repo: `worktreeStatus` calls it broken */
  }
  return out
}

/**
 * Push the checkout's branch to its own name on the remote. `remote` is `{ url, env }` from
 * `remoteFor`; with no `url`, `origin`, and the upstream is set as it goes — an address is not
 * a remote git can track, so the remote-tracking ref is fetched into place instead.
 */
export async function pushBranch(dir, branch, remote = {}) {
  const { url = '', env = {} } = remote
  await git(['push', '--quiet', ...(url ? [url] : ['-u', 'origin']), `HEAD:refs/heads/${branch}`], { cwd: dir, timeout: 5 * 60 * 1000, env })
  await git(['fetch', '--quiet', ...fromRemote(url, branch)], { cwd: dir, timeout: 60000, env })
}

/**
 * Bring the base's latest into the checkout's branch. A conflict is aborted and reported:
 * resolving it is the chat's work, not this function's.
 */
export async function mergeBase(dir, base, remote = {}) {
  const { url = '', env = {} } = remote
  await git(['fetch', '--quiet', ...fromRemote(url, base)], { cwd: dir, timeout: 5 * 60 * 1000, env })
  try {
    await git(['merge', '--no-edit', `origin/${base}`], { cwd: dir, timeout: 60000 })
  } catch (err) {
    // A conflict leaves unmerged paths; anything else is git's own reason, said as is.
    const unmerged = await git(['diff', '--name-only', '--diff-filter=U'], { cwd: dir }).catch(() => '')
    await git(['merge', '--abort'], { cwd: dir }).catch(() => {})
    if (unmerged.trim()) throw new Error(`Merging origin/${base} conflicts in ${unmerged.trim().split('\n').join(', ')} — resolve it in the chat, then finish again`)
    throw new Error(`Could not merge origin/${base}: ${err.message}`)
  }
}

/**
 * Merge `ref` into the checkout, for the `pull` tool. Unlike `mergeBase`, a conflict is left in
 * place and answered as `{ conflict: [files] }`: a pull is the session asking for the merge,
 * and an aborted one leaves it nothing to resolve. Anything else git refuses is aborted and
 * thrown.
 */
export async function mergeInto(dir, ref) {
  try {
    await git(['merge', '--no-edit', ref], { cwd: dir, timeout: 60000 })
    return { conflict: [] }
  } catch (err) {
    const unmerged = (await git(['diff', '--name-only', '--diff-filter=U'], { cwd: dir }).catch(() => '')).trim()
    if (unmerged) return { conflict: unmerged.split('\n') }
    await git(['merge', '--abort'], { cwd: dir }).catch(() => {})
    throw new Error(`Could not merge ${ref}: ${err.message}`)
  }
}

/**
 * A GitHub address written for ssh, read as https, for the git that runs under a token: a
 * submodule's URL is the one its `.gitmodules` wrote, often `git@github.com:`, and a token
 * cannot answer ssh. Set through git's environment so the submodule clones git starts inherit it.
 */
const GITHUB_OVER_HTTPS = {
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'url.https://github.com/.insteadOf',
  GIT_CONFIG_VALUE_0: 'git@github.com:',
  GIT_CONFIG_KEY_1: 'url.https://github.com/.insteadOf',
  GIT_CONFIG_VALUE_1: 'ssh://git@github.com/',
}

/**
 * The only transports a submodule is fetched over, on the command line so they hold for every
 * nested one. `ext::` runs a command, `file` runs the target's own upload-pack config, `git://`
 * runs `core.gitProxy` and `http://` would carry the token in the clear.
 */
const SUBMODULE_PROTOCOLS = ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always']

/**
 * What a submodule's own git config may say for Outpost to run git in it. Its git dir is under
 * the checkout's admin dir in the mirror, which a session can write, and git reads it when
 * `submodule update` fetches and checks out there: a filter or credential helper, an `include`,
 * a `core.worktree` aimed out of the checkout, a `remote.<name>.vcs` — each runs or writes as the
 * owner. These are the keys git itself writes when it clones a submodule.
 */
const MODULE_KEYS =
  /^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|worktree)|remote\.[^.]+\.(url|fetch)|branch\..+\.(remote|merge)|submodule\..+\.(url|active)|user\.(name|email)|lfs\.repositoryformatversion|extensions\.objectformat)$/

/** Whether `p`, through every link that exists along it, lies inside `root` (a real path). */
async function insideReal(p, root) {
  let probe = p
  let rest = ''
  for (;;) {
    const real = await fsp.realpath(probe).catch(() => null)
    if (real) return path.relative(root, path.join(real, rest)).split(path.sep)[0] !== '..'
    if (path.dirname(probe) === probe) return false
    rest = path.join(path.basename(probe), rest)
    probe = path.dirname(probe)
  }
}

/**
 * Why `git submodule update` must not run in this checkout, or `''`. Every submodule git dir
 * under the admin dir holds only `MODULE_KEYS`, with no `commondir` and a work tree inside the
 * checkout; every populated submodule's `.git` is a link file into those git dirs; nested ones
 * the same. Checked before the run, so a session writing in the same moment is not excluded —
 * `PINNED` and `SUBMODULE_PROTOCOLS` are what still hold then.
 */
export async function submodulesUnsafe(checkout) {
  const top = await gitDirsFor(checkout)
  const root = await fsp.realpath(top.GIT_WORK_TREE)
  const modules = path.join(top.GIT_DIR, 'modules')
  const realModules = await fsp.realpath(modules).catch(() => null)
  if (realModules && !(await insideReal(modules, await fsp.realpath(top.GIT_DIR)))) return 'its submodule git dirs are a link'
  // Every git dir git might use for a submodule, at any depth: walked, not listed by the index,
  // since an existing one is reused by a fresh `--init` whatever put it there.
  const walk = async (dir, depth) => {
    if (depth > 12) return 'its submodules nest too deep'
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
    const names = new Set(entries.map((e) => e.name))
    if (names.has('commondir')) return `${path.relative(modules, dir)} names another git dir`
    if (names.has('HEAD') && names.has('config')) {
      const list = await git(['config', '--file', path.join(dir, 'config'), '--null', '--list']).catch(() => null)
      if (list === null) return `${path.relative(modules, dir)} has a config git cannot read`
      for (const item of list.split('\0').filter(Boolean)) {
        const [key, ...v] = item.split('\n')
        const value = v.join('\n')
        if (!MODULE_KEYS.test(key)) return `${path.relative(modules, dir)} sets ${key}`
        if (key === 'core.bare' && value !== 'false') return `${path.relative(modules, dir)} sets core.bare`
        if (key === 'core.worktree' && !(await insideReal(path.resolve(dir, value), root))) return `${path.relative(modules, dir)} has its work tree outside the checkout`
      }
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) return `${path.relative(modules, path.join(dir, e.name))} is a link`
      if (e.isDirectory() && !['objects', 'refs', 'logs', 'lfs'].includes(e.name)) {
        const why = await walk(path.join(dir, e.name), depth + 1)
        if (why) return why
      }
    }
    return ''
  }
  if (realModules) {
    const why = await walk(modules, 0)
    if (why) return why
  }
  // Each populated submodule's `.git`, from the index of the repo it is in: a link file into
  // the git dirs just checked, never a folder or a link of its own.
  const links = async (env, workTree, depth) => {
    if (depth > 12) return 'its submodules nest too deep'
    const staged = await git(['ls-files', '--stage', '-z'], { env }).catch(() => '')
    for (const line of staged.split('\0').filter((l) => l.startsWith('160000 '))) {
      const sub = path.join(workTree, line.slice(line.indexOf('\t') + 1))
      const st = await fsp.lstat(sub).catch(() => null)
      if (!st) continue
      if (!st.isDirectory()) return `${path.relative(root, sub)} is not a folder`
      const dotGit = await fsp.lstat(path.join(sub, '.git')).catch(() => null)
      if (!dotGit) continue
      if (!dotGit.isFile()) return `${path.relative(root, sub)}/.git is not a link file`
      const named = /^gitdir: (.+)$/m.exec(await fsp.readFile(path.join(sub, '.git'), 'utf8'))?.[1]?.trim()
      const gitDir = named && path.resolve(sub, named)
      if (!gitDir || !realModules || !(await insideReal(gitDir, realModules))) return `${path.relative(root, sub)}/.git points outside its git dirs`
      if (!(await exists(gitDir))) continue
      const why = await links({ GIT_DIR: gitDir, GIT_COMMON_DIR: gitDir }, sub, depth + 1)
      if (why) return why
    }
    return ''
  }
  return links(top, root, 0)
}

/** The host of a git address — https, ssh or scp-like — lowercased, `''` when it has none. */
export function hostOf(url) {
  const s = String(url || '').trim()
  const scp = /^(?:[^@/:]+@)?([^/:]+):(?!\/\/)/.exec(s)
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return scp[1].toLowerCase()
  try {
    return new URL(s).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** A host other than the repo's that the checkout's `.lfsconfig` sends LFS to, or `''`. */
export async function lfsElsewhere(dir, url) {
  const own = hostOf(url || (await git(['config', '--get', 'remote.origin.url'], { cwd: dir }).catch(() => '')))
  const listed = await git(['config', '--file', path.join(dir, '.lfsconfig'), '--null', '--list']).catch(() => '')
  for (const item of listed.split('\0').filter(Boolean)) {
    const [key, ...v] = item.split('\n')
    if (!/url$/i.test(key)) continue
    const host = hostOf(v.join('\n'))
    if (host !== own) return host || v.join('\n')
  }
  return ''
}

let lfsInstalled = null
const hasLfs = async () =>
  (lfsInstalled ??= git(['lfs', 'version'], { timeout: 10000 }).then(
    () => true,
    () => false
  ))

/**
 * A checkout's submodules and Git LFS files, brought down here, where the credential is: a
 * chat's container holds none (workspaces.md), so `git submodule update` or `git lfs pull` run
 * there cannot reach the remote and leave empty folders and pointer files. Called wherever a
 * checkout moves to new commits — preparation, adding a repo, starting work, a pull. Answers
 * what it did or why it could not, in words, `''` for a repo with neither; never throws, since a
 * checkout without them is still worth working in.
 */
export async function fillCheckout(dir, remote = {}) {
  const env = { ...(remote.env || {}), ...(remote.env?.GIT_ASKPASS ? GITHUB_OVER_HTTPS : {}) }
  const notes = []
  if (await exists(path.join(dir, '.gitmodules'))) {
    try {
      const unsafe = await submodulesUnsafe(dir)
      if (unsafe) throw new Error(`Outpost will not run git where ${unsafe}`)
      await git([...SUBMODULE_PROTOCOLS, 'submodule', 'update', '--init', '--recursive', '--quiet'], { cwd: dir, timeout: 10 * 60 * 1000, env })
      notes.push('submodules checked out')
    } catch (err) {
      notes.push(`submodules not checked out (${err.message})`)
    }
  }
  const attributes = await fsp.readFile(path.join(dir, '.gitattributes'), 'utf8').catch(() => '')
  if (/filter=lfs/.test(attributes)) {
    if (!(await hasLfs())) {
      notes.push('Git LFS files left as pointers: git-lfs is not installed on the machine Outpost runs on')
    } else {
      // Under a token the address is https, and LFS is asked there rather than at `origin`,
      // which may be the ssh address the token cannot answer — and on the command line, so it
      // wins over any `lfs.url` the checkout's `.lfsconfig` names.
      const lfsUrl = /^https:/.test(remote.url || '') ? ['-c', `lfs.url=${remote.url.replace(/(\.git)?\/?$/, '.git')}/info/lfs`] : []
      // Otherwise `.lfsconfig` is the session's to write: an address on another host would be
      // asked with whatever this machine's credential helpers give for it. Same host only.
      const elsewhere = lfsUrl.length ? '' : await lfsElsewhere(dir, remote.url)
      try {
        if (elsewhere) throw new Error(`.lfsconfig sends them to ${elsewhere}, not the repo's host`)
        await git([...lfsUrl, 'lfs', 'pull'], { cwd: dir, timeout: 30 * 60 * 1000, env })
        notes.push('Git LFS files downloaded')
      } catch (err) {
        notes.push(`Git LFS files not downloaded (${err.message})`)
      }
    }
  }
  return notes.join('; ')
}

/**
 * Tag `commit` and push the tag, for the `push_tag` tool. Annotated, so it carries who and when.
 * Never moves a tag the remote has (the caller checks first); a local tag of that name the
 * remote lacks is a leftover of a push that failed, and is replaced.
 */
export async function pushTag(dir, tag, commit, message, remote = {}) {
  const { url = '', env = {} } = remote
  await git(['tag', '-d', tag], { cwd: dir }).catch(() => {})
  await git(['tag', '-a', tag, commit, '-m', message], { cwd: dir })
  try {
    await git(['push', '--quiet', url || 'origin', `refs/tags/${tag}`], { cwd: dir, timeout: 5 * 60 * 1000, env })
  } catch (err) {
    await git(['tag', '-d', tag], { cwd: dir }).catch(() => {})
    throw err
  }
}

/** Whether the remote has a tag of that name right now. */
export async function remoteHasTag(dir, tag, remote = {}) {
  const { url = '', env = {} } = remote
  const out = await git(['ls-remote', '--tags', url || 'origin', `refs/tags/${tag}`], { cwd: dir, env })
  return Boolean(out.trim())
}

/** Whether the remote has a branch of that name right now — asked of the remote, not of what was last fetched. */
export async function remoteHasBranch(dir, branch, remote = {}) {
  const { url = '', env = {} } = remote
  const out = await git(['ls-remote', '--heads', url || 'origin', `refs/heads/${branch}`], { cwd: dir, env })
  return Boolean(out.trim())
}

/** Fast-forward the base on the remote to this checkout's HEAD. Refused by git if it is not a fast-forward. */
export async function pushToBase(dir, base, remote = {}) {
  const { url = '', env = {} } = remote
  await git(['push', '--quiet', url || 'origin', `HEAD:refs/heads/${base}`], { cwd: dir, timeout: 5 * 60 * 1000, env })
  await git(['fetch', '--quiet', ...fromRemote(url, base)], { cwd: dir, timeout: 60000, env })
}

/**
 * Remove a worktree and its branch from the mirror. `--force` because the caller has already
 * decided what to do about uncommitted work (the refusal lives in the store, where the reason
 * can be given); the branch is deleted only when it is pushed, so a deleted workspace whose
 * branch was never pushed keeps its commits reachable in the mirror.
 *
 * Forced twice: once for changes, once for the lock every checkout carries
 * (`addDetachedWorktree`) — a single force is refused, both callers swallow the refusal, and the
 * entry and its branch would be left behind for good. Not only when the folder is there: a locked
 * entry whose folder is gone is cleared by nothing else. A path no entry names (a checkout whose
 * entry was pruned and its name given to another) is refused by git, and that other checkout's
 * entry is never matched, since git finds the entry by its path. The branch delete is refused
 * too while any entry still has it checked out.
 */
export async function removeWorktree(mirror, dir, branch, { deleteBranch }) {
  await git(['worktree', 'remove', '--force', '--force', dir], { cwd: mirror, timeout: 60000 }).catch(() => {})
  await git(['worktree', 'prune'], { cwd: mirror }).catch(() => {})
  if (deleteBranch) await git(['branch', '-D', branch], { cwd: mirror }).catch(() => {})
}

/**
 * Two generated files live in every checkout and must never reach a commit. A worktree's
 * exclude file is the mirror's — one entry covers every chat on the repo.
 */
export async function excludeGenerated(mirror, names) {
  const file = path.join(mirror, 'info', 'exclude')
  await fsp.mkdir(path.dirname(file), { recursive: true })
  let current = ''
  try {
    current = await fsp.readFile(file, 'utf8')
  } catch {
    /* no exclude file yet */
  }
  const have = new Set(current.split('\n').map((l) => l.trim()))
  const add = names.filter((n) => !have.has(n))
  if (!add.length) return
  await fsp.writeFile(file, `${current.replace(/\n?$/, '\n')}${add.join('\n')}\n`)
}
