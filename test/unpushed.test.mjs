// Unpushed work for the chat list's chip (docs/modules/workspaces-git.md *Unpushed work*): what
// counts as unpushed, the clock that holds the chip back half an hour, and a failed check
// keeping the last answer rather than guessing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-unpushed-')))
process.env.OUTPOST_DATA = path.join(tmp, 'data')
process.env.OUTPOST_MIRRORS = path.join(tmp, 'repos')
process.env.OUTPOST_WORKSPACES = path.join(tmp, 'workspaces')
process.env.OUTPOST_SECRETS = path.join(tmp, 'secrets')
const g = await import('../server/workspaces/git.mjs')
const u = await import('../server/workspaces/unpushed.mjs')

const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const sh = (args, cwd) => execFileSync('git', args, { cwd, env: { ...process.env, ...ID }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const src = path.join(tmp, 'src')
const remote = path.join(tmp, 'remote.git')
const mirror = g.mirrorPath('r')
fs.mkdirSync(src)
sh(['init', '-q', '-b', 'main'], src)
fs.writeFileSync(path.join(src, 'a.txt'), 'one\n')
sh(['add', 'a.txt'], src)
sh(['commit', '-qm', 'init'], src)
sh(['clone', '-q', '--bare', src, remote])
sh(['clone', '-q', '--bare', remote, mirror])
sh(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], mirror)
sh(['fetch', '-q', 'origin'], mirror)

/** A ready workspace with one checkout of the mirror, its manifest on disk. */
async function workspace(id) {
  const dir = path.join(process.env.OUTPOST_WORKSPACES, id)
  const checkout = path.join(dir, 'r')
  await g.addDetachedWorktree(mirror, checkout, 'main')
  const m = { id, status: 'ready', sessionIds: [], repos: [{ id: 'r', name: 'r', path: checkout, base: 'main', branch: '' }] }
  fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify(m))
  return { checkout }
}
const HALF_HOUR = u.UNPUSHED_AFTER_MS
// Made before anything reads the index, which loads the manifests on disk once.
const c1 = await workspace('c1')
const c2 = await workspace('c2')

test('strict status: a branch with no upstream and no commits of its own is pushed; one with commits is not', async () => {
  const { checkout } = await workspace('s1')
  let s = await g.worktreeStatus(checkout, 'main', '', { strict: true })
  assert.deepEqual([s.clean, s.pushed], [true, true])
  await g.startWorkBranch(checkout, 'main', 'w-s1', { clean: true })
  s = await g.worktreeStatus(checkout, 'main', 'w-s1', { strict: true })
  assert.deepEqual([s.remoteBranch, s.pushed], [false, true], 'nothing past the base')
  fs.writeFileSync(path.join(checkout, 'b.txt'), 'two\n')
  sh(['add', 'b.txt'], checkout)
  sh(['commit', '-qm', 'work'], checkout)
  s = await g.worktreeStatus(checkout, 'main', 'w-s1', { strict: true })
  assert.deepEqual([s.clean, s.pushed], [true, false], 'a commit past origin/main, and no origin/w-s1')
  await g.pushBranch(checkout, 'w-s1')
  s = await g.worktreeStatus(checkout, 'main', 'w-s1', { strict: true })
  assert.deepEqual([s.remoteBranch, s.pushed], [true, true], 'measured against origin/w-s1 once pushed')
})

test('strict status throws where the default guesses', async () => {
  await assert.rejects(g.worktreeStatus(path.join(tmp, 'nowhere'), 'main', '', { strict: true }))
  const { checkout } = await workspace('s2')
  await assert.rejects(g.worktreeStatus(checkout, 'no-such-base', '', { strict: true }))
  const loose = await g.worktreeStatus(checkout, 'no-such-base', '')
  assert.equal(loose.pushed, true, 'the default still reads an unknown base as nothing ahead')
})

test('the chip lights only after half an hour unpushed, and goes out the moment it is clean', async () => {
  const { checkout } = c1
  await u.checkUnpushed('c1')
  assert.deepEqual(await u.unpushedRepos('c1', Date.now() + HALF_HOUR * 2), {}, 'clean: no clock')
  fs.writeFileSync(path.join(checkout, 'x.txt'), 'x\n')
  await u.checkUnpushed('c1')
  assert.deepEqual(await u.unpushedRepos('c1'), {}, 'unpushed, but not for long')
  assert.deepEqual(await u.unpushedRepos('c1', Date.now() + HALF_HOUR), { r: true })
  // A second check while still unpushed keeps the first clock, not a new one.
  await u.checkUnpushed('c1')
  assert.deepEqual(await u.unpushedRepos('c1', Date.now() + HALF_HOUR), { r: true })
  fs.rmSync(path.join(checkout, 'x.txt'))
  await u.checkUnpushed('c1')
  assert.deepEqual(await u.unpushedRepos('c1', Date.now() + HALF_HOUR * 2), {}, 'clean resets the clock')
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.OUTPOST_DATA, 'unpushed.json'), 'utf8'))
  assert.deepEqual(saved.workspaces.c1, { r: null })
})

test('a check that fails keeps the last answer', async () => {
  const { checkout } = c2
  fs.writeFileSync(path.join(checkout, 'x.txt'), 'x\n')
  await u.checkUnpushed('c2')
  assert.deepEqual(await u.unpushedRepos('c2', Date.now() + HALF_HOUR), { r: true })
  // git cannot read the checkout: its link to the mirror is gone.
  fs.renameSync(path.join(checkout, '.git'), path.join(checkout, '.git-away'))
  await u.checkUnpushed('c2')
  assert.deepEqual(await u.unpushedRepos('c2', Date.now() + HALF_HOUR), { r: true }, 'kept, not read as clean')
  fs.renameSync(path.join(checkout, '.git-away'), path.join(checkout, '.git'))
})
