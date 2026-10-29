#!/usr/bin/env node
/**
 * Who is holding which file, so that two sessions sharing one working tree stop committing
 * each other's half-finished work.
 *
 *   claims.mjs record    # PostToolUse hook: this session has touched a file
 *   claims.mjs check     # .githooks/pre-commit: refuse a commit carrying someone else's path
 *   claims.mjs release   # .githooks/post-commit: what I just committed is no longer mine
 *
 * A claim means "a live session edited this path and has not committed it yet" — which is
 * exactly the work a `git add -A` from the next session along destroys. It is keyed on
 * `CLAUDE_CODE_SESSION_ID`, which Claude Code puts in the environment of every command it
 * runs, so a plain git hook can read it: the check binds a human's `git commit` and any
 * other client too, not only the session that wrote the file.
 *
 * **Fails open, always.** A guard that wedges a commit because it could not parse its own
 * state file is worse than the clobber it exists to prevent. Every path out of here that is
 * not a positive "someone else holds this" is exit 0.
 *
 * The whole rule, and why claims are released on commit rather than expiring on a timer, is
 * in docs/modules/concurrency.md.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const OVERRIDE = 'OUTPOST_ALLOW_SHARED_COMMIT'

/** Claim files older than this are swept on write. A session that died without SessionEnd
 *  leaves one behind, and pid liveness already ignores it — this only stops the directory
 *  growing forever. */
const SWEEP_MS = 7 * 24 * 60 * 60 * 1000

const run = (args, cwd) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

/**
 * `--git-common-dir`, not `--git-dir`: a worktree has a git dir of its own, and claims must
 * be shared across every worktree of one repository or two sessions in two worktrees would
 * never see each other. (They also cannot clobber each other — separate indexes — but the
 * common dir is still the honest home for the record.)
 */
function repo(from) {
  const out = run(['-C', from, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'], from)
  if (!out) return null
  const [gitDir, top] = out.split('\n')
  if (!gitDir || !top) return null
  return { dir: path.join(gitDir, 'outpost-claims'), top }
}

/** A session is gone when its pid is. EPERM means somebody else's process answered, which
 *  still means alive; only ESRCH is proof of death. */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

const readClaim = (file) => {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'))
    return c && typeof c === 'object' && c.paths ? c : null
  } catch {
    return null
  }
}

/** Every claim file except mine, from a session that is still running. */
function others(dir, me) {
  let names = []
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  const live = []
  for (const name of names) {
    const file = path.join(dir, name)
    const claim = readClaim(file)
    if (!claim) continue
    if (claim.session === me) continue
    if (alive(claim.pid)) {
      live.push(claim)
      continue
    }
    // Dead session: its work is no longer in flight, so its claims say nothing.
    try {
      if (Date.now() - (claim.updated || 0) > SWEEP_MS) fs.unlinkSync(file)
    } catch {}
  }
  return live
}

const session = () => process.env.CLAUDE_CODE_SESSION_ID || ''
const claimFile = (dir, id) => path.join(dir, `${id.replace(/[^A-Za-z0-9_-]/g, '')}.json`)

// ── record ──────────────────────────────────────────────────────────────────────────────
/**
 * Reads a PostToolUse payload on stdin and notes the file it wrote. Anything unexpected —
 * no session id, a tool with no path, a file outside a repo — is simply not a claim.
 */
async function record() {
  const id = session()
  if (!id) return
  let payload = ''
  for await (const chunk of process.stdin) payload += chunk
  let hook
  try {
    hook = JSON.parse(payload)
  } catch {
    return
  }
  const input = hook?.tool_input || {}
  const file = input.file_path || input.notebook_path
  if (!file || typeof file !== 'string') return

  const abs = path.resolve(hook.cwd || process.cwd(), file)
  const found = repo(path.dirname(abs))
  if (!found) return
  const rel = path.relative(found.top, abs)
  if (!rel || rel.startsWith('..')) return

  fs.mkdirSync(found.dir, { recursive: true })
  const target = claimFile(found.dir, id)
  const claim = readClaim(target) || { session: id, paths: {} }
  claim.pid = Number(process.env.CLAUDE_PID) || process.ppid
  claim.cwd = hook.cwd || ''
  claim.updated = Date.now()
  claim.paths[rel] = claim.updated
  fs.writeFileSync(target, JSON.stringify(claim))
}

// ── check ───────────────────────────────────────────────────────────────────────────────
/**
 * Run from .githooks/pre-commit. `git diff --cached` is the right question even for
 * `git commit -- <paths>`: git points GIT_INDEX_FILE at the temporary index it built for
 * that commit, so what we read is what is about to be committed either way.
 */
function check() {
  if (process.env[OVERRIDE]) return 0
  const found = repo(process.cwd())
  if (!found) return 0
  const staged = (run(['diff', '--cached', '--name-only'], found.top) || '').split('\n').filter(Boolean)
  if (!staged.length) return 0

  const held = new Map() // path -> claim
  for (const claim of others(found.dir, session())) {
    for (const p of Object.keys(claim.paths)) if (staged.includes(p) && !held.has(p)) held.set(p, claim)
  }
  if (!held.size) return 0

  const ago = (t) => {
    const mins = Math.round((Date.now() - t) / 60000)
    return mins < 1 ? 'just now' : mins === 1 ? '1 min ago' : `${mins} min ago`
  }
  const mine = staged.filter((p) => !held.has(p))

  console.error('\nRefusing this commit: it carries files another live session is still editing.\n')
  for (const [p, claim] of held) {
    console.error(`  ${p}`)
    console.error(`      held by session ${claim.session.slice(0, 8)} (pid ${claim.pid}), last touched ${ago(claim.paths[p])}`)
  }
  console.error('\nCommit only your own paths — this ignores the shared index entirely:\n')
  console.error(`  git commit -m "..." -- ${mine.length ? mine.join(' ') : '<your paths>'}\n`)
  console.error(`If the overlap is deliberate, a person can override it:  ${OVERRIDE}=1 git commit ...\n`)
  return 1
}

// ── release ─────────────────────────────────────────────────────────────────────────────
/** Run from .githooks/post-commit. Committed work is no longer in flight, so it stops
 *  blocking anyone — this is what keeps a claim meaning "uncommitted" rather than "ever
 *  touched", and is why claims need no expiry. */
function release() {
  const id = session()
  if (!id) return 0
  const found = repo(process.cwd())
  if (!found) return 0
  const target = claimFile(found.dir, id)
  const claim = readClaim(target)
  if (!claim) return 0

  // `-m` so a merge commit reports its files rather than nothing at all.
  const committed = (run(['diff-tree', '-m', '-r', '--no-commit-id', '--name-only', 'HEAD'], found.top) || '')
    .split('\n')
    .filter(Boolean)
  let changed = false
  for (const p of committed) {
    if (p in claim.paths) {
      delete claim.paths[p]
      changed = true
    }
  }
  if (!changed) return 0
  if (!Object.keys(claim.paths).length) {
    try {
      fs.unlinkSync(target)
    } catch {}
    return 0
  }
  claim.updated = Date.now()
  fs.writeFileSync(target, JSON.stringify(claim))
  return 0
}

try {
  const mode = process.argv[2]
  if (mode === 'record') await record()
  else if (mode === 'check') process.exit(check())
  else if (mode === 'release') process.exit(release())
  else {
    console.error('usage: claims.mjs record|check|release')
    process.exit(2)
  }
} catch {
  // Fails open: see the header.
  process.exit(0)
}
