// The shells (docs/modules/auth.md *The terminal*): a chat's container shell is `podman exec`
// into that chat's own container, refused for a chat on the host and while the container is
// stopped, capped per chat and in all apart from the host's one, and listed with its kind and
// chat. No podman is run: the pty helper's spawn is a stand-in that holds the shell open.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-shell-'))
process.env.OUTPOST_DATA = path.join(tmp, 'data')

const { closeShell, containerShellArgs, listShells, openShell } = await import('../server/shell/index.mjs')

/** What `spawn` was asked for, and a child that stays open until its input is closed. */
const spawned = []
function fakeSpawn(cmd, args, opts) {
  const child = new EventEmitter()
  child.pid = 0
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough()]
  child.stdin.on('finish', () => child.emit('close', 0))
  spawned.push({ cmd, args, opts })
  return child
}

const rec = (id, extra = {}) => ({ id, cwd: `/work/${id}/repo`, workspaceId: `ws-${id}`, container: { image: 'localhost/outpost-base:x' }, ...extra })

/** The roster's lookups, for chats `c1`…: each in workspace `ws-<chat>`, its record `r-<chat>`. */
function deps({ alive = true, record = (chat) => rec(`r-${chat}`) } = {}) {
  return {
    threadFor: async (harness, ref) => (ref?.chat ? { id: ref.chat, cwd: `/work/${ref.chat}` } : null),
    workspaceFor: async (cwd) => ({ id: `ws-${path.basename(cwd)}` }),
    latestForWorkspace: async (wsId) => record(wsId.slice(3)),
    isAlive: async () => alive,
    spawn: fakeSpawn,
  }
}
const chat = (id) => ({ harness: 'claude', ref: { chat: id } })

test('the words: podman exec into the session container, in its folder, a login bash', () => {
  assert.deepEqual(containerShellArgs(rec('abc123')), ['podman', 'exec', '-it', '-w', '/work/abc123/repo', 'outpost-session-abc123', 'bash', '-l'])
})

test('a chat on the host gets no shell', async () => {
  assert.throws(() => containerShellArgs({ id: 'x', cwd: '/w' }), /runs on the host; the Terminal is the way in/)
  await assert.rejects(openShell({ chat: chat('host1') }, deps({ record: (c) => ({ id: `r-${c}`, cwd: '/w' }) })), /runs on the host/)
})

test('a stopped container is refused with `stopped`, and nothing is spawned', async () => {
  const before = spawned.length
  await assert.rejects(openShell({ chat: chat('stop1') }, deps({ alive: false })), (err) => {
    assert.match(err.message, /The container is stopped — Resume the chat to start it/)
    assert.equal(err.stopped, true)
    assert.equal(err.status, 409)
    return true
  })
  assert.equal(spawned.length, before)
})

test('an unknown chat is refused', async () => {
  await assert.rejects(openShell({ chat: { harness: 'claude', ref: {} } }, deps()), /No such chat/)
})

test('the record and the listing carry kind, chat, container and account; the environment is clean', async () => {
  const shell = await openShell({ chat: chat('c1'), rows: 30, cols: 100 }, deps())
  assert.equal(shell.kind, 'container')
  assert.equal(shell.chat, 'c1')
  assert.equal(shell.container, 'outpost-session-r-c1')
  assert.equal(shell.account, os.userInfo().username)
  const call = spawned.at(-1)
  assert.equal(call.cmd, 'python3')
  assert.deepEqual(call.args.slice(1), ['30', '100', 'podman', 'exec', '-it', '-w', '/work/r-c1/repo', 'outpost-session-r-c1', 'bash', '-l'])
  assert.deepEqual(Object.keys(call.opts.env).sort(), ['HOME', 'LANG', 'PATH', 'TERM', 'XDG_RUNTIME_DIR'])
  const listed = listShells().find((s) => s.id === shell.id)
  assert.equal(listed.kind, 'container')
  assert.equal(listed.chat, 'c1')
  const log = fs.readFileSync(path.join(tmp, 'data', 'shell.log'), 'utf8')
  assert.match(log, new RegExp(`opened ${shell.id} in outpost-session-r-c1 for chat c1`))
  closeShell(shell.id)
  assert.equal(listShells().some((s) => s.id === shell.id), false)
})

test('three per chat, eight in all', async () => {
  const opened = []
  for (let i = 0; i < 3; i++) opened.push(await openShell({ chat: chat('busy') }, deps()))
  await assert.rejects(openShell({ chat: chat('busy') }, deps()), /3 shells are open in this chat already/)
  for (const c of ['a', 'b']) for (let i = 0; i < 2; i++) opened.push(await openShell({ chat: chat(c) }, deps()))
  opened.push(await openShell({ chat: chat('d') }, deps()))
  assert.equal(opened.length, 8)
  await assert.rejects(openShell({ chat: chat('e') }, deps()), /8 container shells are open already/)
  // Closing one frees a place.
  closeShell(opened.pop().id)
  await new Promise((r) => setImmediate(r)) // the hang-up ends it on the next turn
  opened.push(await openShell({ chat: chat('e') }, deps()))
  for (const s of opened) closeShell(s.id)
  assert.equal(listShells().filter((s) => s.kind === 'container').length, 0)
})
