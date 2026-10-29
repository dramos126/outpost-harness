// The Browse tree and the Files filter (docs/modules/workspaces.md *Files*): one folder at a
// time, bounded to the workspace by letters and by real path; the container's /tmp walked with
// no link followed; ignore flags from the checkout's own rules; and the search's caps.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-browse-')))
process.env.OUTPOST_DATA = path.join(tmp, 'data')
process.env.OUTPOST_WORKSPACES = path.join(tmp, 'workspaces')
process.env.OUTPOST_CONFIG = path.join(tmp, 'config')
process.env.OUTPOST_MIRRORS = path.join(tmp, 'repos')
process.env.HOME = tmp

const { DIR_ENTRIES, containerRoot, containerStart, findInWorkspace, listTmpDir, listWorkspaceDir, readTmpBytes, readTmpFile, tmpPath } = await import('../server/workspaces/browse.mjs')

const ws = path.join(tmp, 'workspaces', 'w1')
const repo = path.join(ws, 'r')
fs.mkdirSync(path.join(ws, 'home', 'notes'), { recursive: true })
fs.writeFileSync(path.join(ws, 'home', 'notes', 'alpha-plan.md'), 'plan\n')
fs.mkdirSync(path.join(tmp, 'elsewhere'))
fs.writeFileSync(path.join(tmp, 'elsewhere', 'secret.txt'), 'not yours\n')
fs.symlinkSync(path.join(tmp, 'elsewhere'), path.join(ws, 'linkout'))
const manifest = { id: 'w1', status: 'ready', repos: [{ id: 'r', name: 'r', path: repo }] }

// A real checkout as Outpost makes one — a worktree of a bare mirror under OUTPOST_MIRRORS — so
// the ignore rules go through `git()` and its `gitDirsFor` exactly as they do live.
const hasGit = !spawnSync('git', ['--version']).error
const run = (args, cwd) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
}
if (hasGit) {
  const src = path.join(tmp, 'src')
  fs.mkdirSync(src)
  run(['init', '-q'], src)
  fs.writeFileSync(path.join(src, '.gitignore'), 'build/\n*.log\n')
  fs.writeFileSync(path.join(src, 'README.md'), 'hi\n')
  run(['add', '.'], src)
  run(['commit', '-q', '-m', 'one'], src)
  fs.mkdirSync(process.env.OUTPOST_MIRRORS)
  run(['clone', '-q', '--bare', src, path.join(process.env.OUTPOST_MIRRORS, 'r.git')], tmp)
  run(['worktree', 'add', '-q', '-b', 'work', repo], path.join(process.env.OUTPOST_MIRRORS, 'r.git'))
  fs.mkdirSync(path.join(repo, 'build'))
  fs.writeFileSync(path.join(repo, 'build', 'alpha-out.js'), '')
  fs.mkdirSync(path.join(repo, 'node_modules', 'pkg'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'node_modules', 'pkg', 'alpha-lib.js'), '')
  fs.mkdirSync(path.join(repo, 'src'))
  fs.writeFileSync(path.join(repo, 'src', 'alpha.js'), '')
  fs.writeFileSync(path.join(repo, 'debug.log'), '')
} else {
  fs.mkdirSync(repo)
}

test('the workspace folder lists folders first, links as links, and nothing is followed', async () => {
  const top = await listWorkspaceDir(manifest, '')
  assert.equal(top.ok, true)
  assert.equal(top.path, ws)
  assert.equal(top.capped, false)
  assert.deepEqual(
    top.entries.map((e) => [e.name, e.kind]),
    [
      ['home', 'dir'],
      ['r', 'dir'],
      ['linkout', 'link'],
    ]
  )
  const notes = await listWorkspaceDir(manifest, 'home/notes')
  assert.equal(notes.entries[0].name, 'alpha-plan.md')
  assert.equal(notes.entries[0].size, 'plan\n'.length)
  assert.ok(notes.entries[0].modifiedAt > 0)
  assert.equal((await listWorkspaceDir(manifest, path.join(ws, 'home'))).ok, true, 'absolute works too')
  assert.equal((await listWorkspaceDir(manifest, 'nope')).missing, true)
})

test('a folder outside the workspace, a link leading out, a NUL and a file are refused', async () => {
  for (const p of [path.join(tmp, 'elsewhere'), '../elsewhere', '/etc', '~/x']) {
    const r = await listWorkspaceDir(manifest, p)
    assert.equal(r.ok, false, p)
    assert.equal(r.outside, true, p)
  }
  const link = await listWorkspaceDir(manifest, 'linkout')
  assert.equal(link.ok, false)
  assert.equal(link.outside, true, 'a link out of the workspace is not followed')
  assert.equal((await listWorkspaceDir(manifest, 'home\0/x')).ok, false)
  assert.equal((await listWorkspaceDir(manifest, 'home/notes/alpha-plan.md')).ok, false, 'a file')
  assert.equal((await listWorkspaceDir({}, '')).ok, false, 'no workspace')
})

test('a folder past the cap answers the first entries and says capped', async () => {
  const many = path.join(ws, 'home', 'many')
  fs.mkdirSync(many)
  for (let i = 0; i <= DIR_ENTRIES; i++) fs.writeFileSync(path.join(many, `f${String(i).padStart(5, '0')}`), '')
  const r = await listWorkspaceDir(manifest, 'home/many')
  assert.equal(r.entries.length, DIR_ENTRIES)
  assert.equal(r.capped, true)
  assert.equal(r.entries[0].name, 'f00000')
  fs.rmSync(many, { recursive: true })
})

test('ignored is the checkout own rules, plus .git and node_modules always', { skip: !hasGit && 'git is not on PATH' }, async () => {
  const r = await listWorkspaceDir(manifest, 'r')
  assert.equal(r.ok, true)
  const flag = Object.fromEntries(r.entries.map((e) => [e.name, e.ignored]))
  assert.deepEqual(flag, { build: true, node_modules: true, src: false, '.git': true, '.gitignore': false, 'debug.log': true, 'README.md': false })
  assert.equal(r.entries.find((e) => e.name === '.git').kind, 'file', "a worktree's .git is a file")
  const top = await listWorkspaceDir(manifest, '')
  assert.ok(top.entries.every((e) => !e.ignored), 'outside a checkout nothing but the fixed names is ignored')
})

test('a /tmp path is /tmp or under it by its letters, with no .. and no NUL', () => {
  assert.equal(tmpPath('/tmp'), '/tmp')
  assert.equal(tmpPath('/tmp/a//b/'), '/tmp/a/b')
  assert.equal(tmpPath('/tmp/./a'), '/tmp/a')
  for (const p of ['/tmp/../etc', '/tmp/a/../b', '/etc/passwd', '/tmpx', 'tmp/a', '', '/tmp/a\0b', null]) assert.equal(tmpPath(p), '', String(p))
})

test("the container's /tmp is walked with no link followed at any depth", async () => {
  // A stand-in for /proc/<pid>/root: a folder with its own tmp/, holding links that would resolve against the host.
  const root = path.join(tmp, 'croot')
  fs.mkdirSync(path.join(root, 'tmp', 'sub'), { recursive: true })
  fs.writeFileSync(path.join(root, 'tmp', 'a.txt'), 'in the container\n')
  fs.writeFileSync(path.join(root, 'tmp', 'sub', 'b.txt'), 'deeper\n')
  fs.writeFileSync(path.join(root, 'tmp', 'bin.dat'), Buffer.from([1, 0, 2]))
  fs.symlinkSync(path.join(tmp, 'elsewhere', 'secret.txt'), path.join(root, 'tmp', 'ln'))
  fs.symlinkSync(path.join(tmp, 'elsewhere'), path.join(root, 'tmp', 'lndir'))
  const top = await listTmpDir(root, '/tmp')
  assert.equal(top.ok, true)
  assert.equal(top.path, '/tmp')
  assert.deepEqual(
    top.entries.map((e) => [e.name, e.kind]),
    [
      ['sub', 'dir'],
      ['a.txt', 'file'],
      ['bin.dat', 'file'],
      ['ln', 'link'],
      ['lndir', 'link'],
    ]
  )
  assert.equal((await listTmpDir(root, '/tmp/sub')).entries[0].name, 'b.txt')
  assert.equal((await listTmpDir(root, '/tmp/lndir')).ok, false, 'a link to a folder is not listed')
  assert.equal((await listTmpDir(root, '/tmp/../etc')).ok, false)
  assert.equal((await listTmpDir(root, '/tmp/gone')).missing, true)
  const file = await readTmpFile(root, '/tmp/sub/b.txt')
  assert.equal(file.text, 'deeper\n')
  assert.equal(file.path, '/tmp/sub/b.txt')
  assert.equal((await readTmpFile(root, '/tmp/ln')).ok, false, 'a link is not read')
  assert.equal((await readTmpFile(root, '/tmp/lndir/secret.txt')).ok, false, 'nor is a path through one')
  const bin = await readTmpFile(root, '/tmp/bin.dat')
  assert.equal(bin.ok, true, 'not text is an answer, not a refusal')
  assert.equal(bin.binary, true)
  assert.equal(bin.size, 3)
  assert.equal((await readTmpFile(root, '/tmp/sub')).ok, false, 'a folder')
  assert.equal((await readTmpFile(root, '/tmp/nope')).missing, true)
  const cut = await readTmpFile(root, '/tmp/a.txt', { maxBytes: 2 })
  assert.equal(cut.text, 'in')
  assert.equal(cut.truncated, true)
  // The bytes, under the same walk: no link, no `..`, refused whole over the cap.
  const bytes = await readTmpBytes(root, '/tmp/bin.dat')
  assert.deepEqual([...bytes.bytes], [1, 0, 2])
  assert.equal(bytes.type, 'application/octet-stream')
  assert.equal((await readTmpBytes(root, '/tmp/ln')).ok, false, 'a link is not read')
  assert.equal((await readTmpBytes(root, '/tmp/lndir/secret.txt')).ok, false, 'nor is a path through one')
  assert.equal((await readTmpBytes(root, '/tmp/../etc/passwd')).ok, false)
  assert.equal((await readTmpBytes(root, '/tmp/nope')).missing, true)
  const big = await readTmpBytes(root, '/tmp/a.txt', { maxBytes: 4 })
  assert.equal(big.ok, false)
  assert.equal(big.tooBig, true)
  assert.equal(big.bytes, undefined, 'nothing is cut and sent')
})

test('no running container is no root, and a bad record id never reaches podman', async () => {
  assert.equal(await containerRoot('../x'), '')
  assert.equal(await containerRoot('nosuchrecord0'), '')
  // No container kept, no start time: the page's `since` is then empty.
  assert.equal(containerStart('nosuchrecord0'), '')
})

test('the search matches the path, skips what git ignores, and stops at its caps', async () => {
  const r = await findInWorkspace(manifest, 'ALPHA')
  assert.equal(r.ok, true)
  assert.equal(r.dir, ws)
  const want = hasGit ? ['r/src/alpha.js', 'home/notes/alpha-plan.md'] : ['home/notes/alpha-plan.md']
  assert.deepEqual(r.paths, want, 'ignored files and node_modules are not searched')
  assert.equal(r.capped, false)
  assert.equal((await findInWorkspace(manifest, 'notes/alpha')).paths.length, 1, 'the folder is part of the match')
  const few = await findInWorkspace(manifest, 'alpha', { matches: 1 })
  assert.equal(few.paths.length, 1)
  assert.equal(few.capped, true)
  const short = await findInWorkspace(manifest, 'alpha', { visits: 1 })
  assert.equal(short.capped, true)
  assert.equal((await findInWorkspace(manifest, 'a')).ok, false, 'one character')
  assert.equal((await findInWorkspace(manifest, 'x'.repeat(81))).ok, false, 'over 80')
  assert.ok(!(await findInWorkspace(manifest, 'secret')).paths.length, 'a link out is not walked')
})
