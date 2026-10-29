// Every checkout is locked in its mirror, so a prune that cannot see it — one run in another
// chat's container — never drops its entry; Outpost's own delete still removes it, and the
// host's sweep frees the entry of a folder deleted behind Outpost's back
// (docs/modules/workspaces.md). A real mirror and worktrees in a temp folder.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-lock-')))
process.env.OUTPOST_DATA = path.join(tmp, 'data')
process.env.OUTPOST_MIRRORS = path.join(tmp, 'repos')
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

const g = await import('../server/workspaces/git.mjs')

const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
/** Plain git, as a session runs it. */
const sh = (args, cwd) => execFileSync('git', args, { cwd, env: { ...process.env, ...ID }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const src = path.join(tmp, 'src')
const mirror = g.mirrorPath('r')
const root = path.join(tmp, 'workspaces')
fs.mkdirSync(src)
sh(['init', '-q', '-b', 'main'], src)
sh(['commit', '-q', '--allow-empty', '-m', 'init'], src)
sh(['clone', '-q', '--bare', src, mirror])
sh(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], mirror)
sh(['fetch', '-q', 'origin'], mirror)

/** The paths the mirror has entries for, from its admin dirs' `gitdir` files. */
const entries = () =>
  fs.existsSync(path.join(mirror, 'worktrees'))
    ? fs.readdirSync(path.join(mirror, 'worktrees')).map((n) => path.dirname(fs.readFileSync(path.join(mirror, 'worktrees', n, 'gitdir'), 'utf8').trim()))
    : []
const checkout = async (ws) => {
  const dir = path.join(root, ws, 'r')
  await g.addDetachedWorktree(mirror, dir, 'main')
  return dir
}
/** What a container that mounts only its own workspace sees: the others' folders are gone. */
const hidden = (dir, fn) => {
  fs.renameSync(dir, `${dir}.away`)
  try {
    return fn()
  } finally {
    fs.renameSync(`${dir}.away`, dir)
  }
}

test("a prune that cannot see a checkout leaves its entry, and the checkout still works", async () => {
  const dir = await checkout('a1')
  hidden(dir, () => sh(['worktree', 'prune'], mirror))
  assert.ok(entries().includes(dir))
  assert.equal((await g.worktreeStatus(dir, 'main', '')).clean, true)
  assert.match(sh(['worktree', 'list', '--porcelain'], mirror), new RegExp(`locked ${g.LOCK_REASON}`))
})

test("Outpost's delete removes a locked checkout, its entry and its branch", async () => {
  const dir = await checkout('a2')
  await g.startWorkBranch(dir, 'main', 'work-a2', { clean: true })
  fs.rmSync(dir, { recursive: true, force: true })
  // The folder already gone too: a locked entry is otherwise cleared by nothing.
  await g.removeWorktree(mirror, dir, 'work-a2', { deleteBranch: true })
  assert.ok(!entries().includes(dir))
  assert.equal(sh(['branch', '--list', 'work-a2'], mirror).trim(), '')
  const live = await checkout('a3')
  await g.removeWorktree(mirror, live, '', { deleteBranch: false })
  assert.ok(!entries().includes(live))
  assert.ok(!fs.existsSync(live))
})

test("a delete of a checkout whose entry was given to another leaves the other's alone", async () => {
  const victim = await checkout('b1')
  const thief = path.join(root, 'b2', 'r')
  // The 2026-10-18 shape: the victim's entry pruned, its name reused for the thief's checkout.
  const admin = fs.readFileSync(path.join(victim, '.git'), 'utf8').replace('gitdir: ', '').trim()
  fs.rmSync(admin, { recursive: true, force: true })
  await g.addDetachedWorktree(mirror, thief, 'main')
  assert.equal(fs.readFileSync(path.join(victim, '.git'), 'utf8'), fs.readFileSync(path.join(thief, '.git'), 'utf8'))
  await g.removeWorktree(mirror, victim, '', { deleteBranch: false })
  assert.ok(entries().includes(thief))
  assert.equal((await g.worktreeStatus(thief, 'main', '')).clean, true)
})

test('the sweep locks an unlocked checkout, frees an orphan, and leaves a held one and a foreign one', async () => {
  const old = path.join(root, 'c1', 'r')
  sh(['worktree', 'add', '-q', '--detach', old, 'origin/main'], mirror)
  const orphan = await checkout('c2')
  sh(['branch', 'work-c2', 'origin/main'], mirror)
  const held = await checkout('c3')
  const foreign = path.join(tmp, 'scratch', 'head')
  sh(['worktree', 'add', '-q', '--detach', foreign, 'origin/main'], mirror)
  fs.rmSync(orphan, { recursive: true, force: true })
  fs.rmSync(held, { recursive: true, force: true })
  fs.rmSync(foreign, { recursive: true, force: true })
  const r = await g.sweepMirror(mirror, { root, keep: async (id) => id === 'c3' })
  assert.deepEqual(r.locked, [old])
  assert.deepEqual(r.freed, [orphan])
  assert.deepEqual(r.failed, [])
  assert.ok(!entries().includes(orphan))
  assert.ok(entries().includes(held))
  assert.ok(entries().includes(foreign))
  assert.match(sh(['branch', '--list', 'work-c2'], mirror), /work-c2/)
  hidden(old, () => sh(['worktree', 'prune'], mirror))
  assert.ok(entries().includes(old))
  // A second sweep has nothing to do.
  const again = await g.sweepMirror(mirror, { root, keep: async (id) => id === 'c3' })
  assert.deepEqual([again.locked, again.freed], [[], []])
})
