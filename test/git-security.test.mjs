// Outpost's own git in a chat's checkout runs nothing the chat planted (docs/modules/workspaces-git.md,
// The checkout's git is Outpost's). A real remote, mirror and worktree in a temp folder; each
// plant is first shown to fire under plain git, so a pass means the guard stopped it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-git-')))
process.env.OUTPOST_DATA = path.join(tmp, 'data')
process.env.OUTPOST_MIRRORS = path.join(tmp, 'repos')
process.env.OUTPOST_SECRETS = path.join(tmp, 'secrets')

const g = await import('../server/workspaces/git.mjs')
const secrets = await import('../server/secrets/index.mjs')

const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
/** Plain git, as a session (or the test) runs it. */
const sh = (args, cwd, env = {}) => execFileSync('git', args, { cwd, env: { ...process.env, ...ID, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const src = path.join(tmp, 'src')
const remote = path.join(tmp, 'remote.git')
const mirror = g.mirrorPath('r')
const ws = path.join(tmp, 'ws')
const pwned = path.join(tmp, 'PWNED')
const evil = path.join(tmp, 'evil.sh')
fs.writeFileSync(evil, `#!/bin/sh\necho "$0 $*" >> ${pwned}\n`, { mode: 0o755 })
const fired = () => fs.existsSync(pwned)
const reset = () => fs.rmSync(pwned, { force: true })

fs.mkdirSync(src)
sh(['init', '-q', '-b', 'main'], src)
fs.writeFileSync(path.join(src, 'a.txt'), 'one\n')
sh(['add', 'a.txt'], src)
sh(['commit', '-qm', 'init'], src)
sh(['clone', '-q', '--bare', src, remote])
sh(['clone', '-q', '--bare', remote, mirror])
sh(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], mirror)
sh(['config', 'user.name', 'Owner'], mirror)
sh(['config', 'user.email', 'owner@x'], mirror)
sh(['fetch', '-q', 'origin'], mirror)

let n = 0
/** A fresh checkout of the mirror, the way preparation makes one. */
async function checkout() {
  const dir = path.join(ws, `c${++n}`)
  await g.addDetachedWorktree(mirror, dir, 'main')
  return dir
}

test('the legitimate path: status, start work, push, merge the base', async () => {
  const dir = await checkout()
  let s = await g.worktreeStatus(dir, 'main', '')
  assert.equal(s.clean, true)
  fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n')
  s = await g.worktreeStatus(dir, 'main', '')
  assert.equal(s.changed, 1)
  await g.startWorkBranch(dir, 'main', 'work-1', { clean: false })
  sh(['add', 'b.txt'], dir)
  sh(['commit', '-qm', 'work'], dir)
  // The base moves on the remote; Outpost merges it in and pushes.
  fs.writeFileSync(path.join(src, 'c.txt'), 'three\n')
  sh(['add', 'c.txt'], src)
  sh(['commit', '-qm', 'base moves'], src)
  sh(['push', '-q', remote, 'main'], src)
  await g.mergeBase(dir, 'main')
  assert.ok(fs.existsSync(path.join(dir, 'c.txt')))
  await g.pushBranch(dir, 'work-1')
  assert.match(sh(['branch', '--list', 'work-1'], remote), /work-1/)
  s = await g.worktreeStatus(dir, 'main', 'work-1')
  assert.equal(s.pushed, true)
  assert.equal(s.behind, 0)
})

test('a fsmonitor and hooks planted in the mirror do not run on Outpost git', async () => {
  const dir = await checkout()
  sh(['config', 'core.fsmonitor', evil], mirror)
  fs.writeFileSync(path.join(mirror, 'hooks', 'post-merge'), `#!/bin/sh\n${evil} hook\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(mirror, 'hooks', 'post-checkout'), `#!/bin/sh\n${evil} hook\n`, { mode: 0o755 })
  try {
    reset()
    sh(['status', '--porcelain'], dir)
    assert.ok(fired(), 'the plant fires under plain git')
    reset()
    await g.worktreeStatus(dir, 'main', '')
    await g.startWorkBranch(dir, 'main', 'work-2', { clean: true })
    await g.mergeBase(dir, 'main')
    assert.equal(fired(), false)
  } finally {
    sh(['config', '--unset', 'core.fsmonitor'], mirror)
    fs.rmSync(path.join(mirror, 'hooks', 'post-merge'))
    fs.rmSync(path.join(mirror, 'hooks', 'post-checkout'))
  }
})

test("a checkout's .git aimed at a config of the session's own is refused", async () => {
  const dir = await checkout()
  const fake = path.join(ws, 'fake.git')
  sh(['init', '-q', '--bare', fake], ws)
  sh(['config', 'core.fsmonitor', evil], fake)
  sh(['config', 'core.bare', 'false'], fake)
  fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${fake}\n`)
  reset()
  sh(['status', '--porcelain'], dir)
  assert.ok(fired(), 'the plant fires under plain git')
  reset()
  const s = await g.worktreeStatus(dir, 'main', '')
  assert.equal(s.clean, false, 'unknown is never clean')
  await assert.rejects(g.git(['status'], { cwd: dir }), /not a checkout Outpost made/)
  assert.equal(fired(), false)
})

test("an admin dir's commondir aimed elsewhere is ignored, and the checkout still works", async () => {
  const dir = await checkout()
  const admin = g.gitDirsFor(dir).then((d) => d.GIT_DIR)
  const fake = path.join(ws, 'common.git')
  sh(['clone', '-q', '--bare', mirror, fake])
  sh(['config', 'core.fsmonitor', evil], fake)
  fs.writeFileSync(path.join(await admin, 'commondir'), `${fake}\n`)
  reset()
  sh(['status', '--porcelain'], dir)
  assert.ok(fired(), 'the plant fires under plain git')
  reset()
  fs.writeFileSync(path.join(dir, 'd.txt'), 'x\n')
  const s = await g.worktreeStatus(dir, 'main', '')
  assert.equal(s.changed, 1)
  assert.equal(fired(), false)
})

test('a .git link to another checkout, or a checkout that is a link, is refused', async () => {
  const a = await checkout()
  const b = await checkout()
  fs.writeFileSync(path.join(b, '.git'), fs.readFileSync(path.join(a, '.git')))
  await assert.rejects(g.gitDirsFor(b), /belongs to another checkout/)
  const link = path.join(ws, 'link')
  fs.symlinkSync(a, link)
  await assert.rejects(g.gitDirsFor(link), /not a folder/)
  fs.rmSync(path.join(a, '.git'))
  fs.mkdirSync(path.join(a, '.git'))
  await assert.rejects(g.gitDirsFor(a), /not a worktree link/)
})

test('a submodule git dir with config of its own is not run; a clean one is', async () => {
  // A submodule the session added itself, the way git writes one.
  const lib = path.join(tmp, 'lib')
  fs.mkdirSync(lib)
  sh(['init', '-q', '-b', 'main'], lib)
  fs.writeFileSync(path.join(lib, 'l.txt'), 'lib\n')
  sh(['add', 'l.txt'], lib)
  sh(['commit', '-qm', 'lib'], lib)
  const dir = await checkout()
  sh(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'libs/l'], dir)
  assert.equal(await g.submodulesUnsafe(dir), '')
  const { GIT_DIR } = await g.gitDirsFor(dir)
  const modConfig = path.join(GIT_DIR, 'modules', 'libs', 'l', 'config')
  const clean = fs.readFileSync(modConfig, 'utf8')
  try {
    fs.appendFileSync(modConfig, `[filter "x"]\n\tsmudge = ${evil}\n`)
    assert.match(await g.submodulesUnsafe(dir), /sets filter\.x\.smudge/)
    fs.writeFileSync(modConfig, clean.replace(/worktree = .*/, 'worktree = /'))
    assert.match(await g.submodulesUnsafe(dir), /work tree outside the checkout/)
    fs.writeFileSync(modConfig, clean)
    fs.writeFileSync(path.join(dir, 'libs', 'l', '.git'), `gitdir: ${mirror}\n`)
    assert.match(await g.submodulesUnsafe(dir), /points outside its git dirs/)
    // And fillCheckout says why instead of running it.
    reset()
    assert.match(await g.fillCheckout(dir), /submodules not checked out \(.*Outpost will not run git/)
    assert.equal(fired(), false)
  } finally {
    fs.writeFileSync(modConfig, clean)
  }
})

// The token goes to the remote's own https host and no other (F5): git asks the helper with the
// address, and a submodule or LFS address a session wrote can name any host.
test("the askpass helper answers only the remote's own host", async () => {
  await secrets.addToken('gh', 'TOKEN-123')
  const env = await secrets.gitEnvFor('gh', 'https://github.com/o/r.git')
  const ask = (prompt, extra = {}) => {
    try {
      return execFileSync(env.GIT_ASKPASS, [prompt], { env: { ...process.env, ...env, ...extra }, encoding: 'utf8' }).trim()
    } catch {
      return null
    }
  }
  // The legitimate prompts, as git 2.39 words them (checked against a live server).
  assert.equal(ask("Username for 'https://github.com': "), 'x-access-token')
  assert.equal(ask("Password for 'https://x-access-token@github.com': "), 'TOKEN-123')
  assert.equal(ask("Password for 'https://x-access-token@GitHub.com/o/r.git': "), 'TOKEN-123', 'useHttpPath and case still answered')
  // Another host, a look-alike, or a user name posing as the host: nothing.
  assert.equal(ask("Password for 'https://x-access-token@evil.example': "), null)
  assert.equal(ask("Username for 'https://evil.example': "), null)
  assert.equal(ask("Password for 'https://x-access-token@github.com.evil.example': "), null)
  assert.equal(ask("Password for 'https://x-access-token@github.com/@evil.example': "), null)
  assert.equal(ask("Password for 'http://x-access-token@github.com': "), null, 'never in the clear')
  // No address known: nothing at all.
  assert.equal(ask("Password for 'https://x-access-token@github.com': ", { OUTPOST_GIT_HOST: '' }), null)
  // A catalogued address carrying its own user is still answered for that user.
  const own = await secrets.gitEnvFor('gh', 'https://bob@git.example.com/o/r.git')
  assert.equal(ask("Password for 'https://bob@git.example.com': ", own), 'TOKEN-123')
})

test('a host is read from every shape of git address', () => {
  assert.equal(g.hostOf('git@github.com:o/r.git'), 'github.com')
  assert.equal(g.hostOf('ssh://git@GitHub.com:22/o/r.git'), 'github.com')
  assert.equal(g.hostOf('https://github.com/o/r.git'), 'github.com')
  assert.equal(g.hostOf('/srv/git/r.git'), '')
})

test('an .lfsconfig aimed at another host is not pulled from', async () => {
  const dir = await checkout()
  fs.writeFileSync(path.join(dir, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n')
  fs.writeFileSync(path.join(dir, '.lfsconfig'), '[lfs]\n\turl = https://evil.example/lfs\n')
  assert.equal(await g.lfsElsewhere(dir, 'git@github.com:o/r.git'), 'evil.example')
  fs.writeFileSync(path.join(dir, '.lfsconfig'), '[lfs]\n\turl = https://github.com/o/r.git/info/lfs\n')
  assert.equal(await g.lfsElsewhere(dir, 'git@github.com:o/r.git'), '')
  const out = await g.fillCheckout(dir, { url: 'git@github.com:o/r.git' })
  assert.doesNotMatch(out, /evil/)
})
