// A routine's run promoted to a chat is watched from then on (docs/modules/routines.md): it ran
// `dontAsk`, and the person answering it must get the approval bar, not every call refused. The
// workspace layer and the launcher run for real on a temp folder; only the processes they would
// start (systemctl, systemd-run, mkfifo) are stood in for, so nothing starts on this machine.
import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-promote-'))
process.env.OUTPOST_DATA = path.join(tmp, 'data')
process.env.OUTPOST_SESSIONS = path.join(tmp, 'sessions')
process.env.OUTPOST_WORKSPACES = path.join(tmp, 'workspaces')
process.env.OUTPOST_CONFIG = path.join(tmp, 'config')
process.env.OUTPOST_DATASETS = path.join(tmp, 'datasets')
delete process.env.OUTPOST_PERMISSION_MODE
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

const sid = '0b7f2c1e-1111-4222-8333-944455556666'
const sdir = path.join(process.env.OUTPOST_SESSIONS, 'a0a0a0a0')
fs.mkdirSync(sdir, { recursive: true })
fs.mkdirSync(path.join(tmp, 'workspaces', 'w1'), { recursive: true })
fs.writeFileSync(
  path.join(tmp, 'workspaces', 'w1', 'workspace.json'),
  JSON.stringify({ id: 'w1', name: 'Docs · 15 Oct', status: 'ready', repos: [], tools: [], sessionIds: [sid], permissionMode: 'dontAsk', routine: { id: 'dddd0004', name: 'Docs', runId: 'rrrr0001' } })
)
fs.mkdirSync(process.env.OUTPOST_DATA, { recursive: true })
fs.writeFileSync(
  path.join(process.env.OUTPOST_DATA, 'structured.json'),
  JSON.stringify({
    version: 1,
    sessions: {
      a0a0a0a0: { id: 'a0a0a0a0', dir: sdir, unit: 'outpost-session-a0a0a0a0', cwd: path.join(tmp, 'workspaces', 'w1'), workspaceId: 'w1', sessionId: sid, model: 'claude-sonnet-4-5', startedAt: 1, args: ['--mcp-config', 'mcp.json', '--permission-mode', 'dontAsk', '--model', 'sonnet'], env: {}, approvalTool: 'mcp__outpost__approve', rules: '' },
    },
  })
)

// Which units are up, and every command the launcher ran.
const up = new Set(['outpost-session-a0a0a0a0'])
const ran = []
mock.module('node:child_process', {
  namedExports: {
    execFile: (file, args, opts, cb) => {
      const done = typeof opts === 'function' ? opts : cb
      ran.push([file, ...args])
      let stdout = ''
      if (file === 'systemctl' && args[1] === 'is-active') stdout = up.has(args[2]) ? 'active' : 'inactive'
      if (file === 'systemctl' && args[1] === 'stop') up.delete(args[2])
      if (file === 'mkfifo') fs.writeFileSync(args[args.length - 1], '')
      if (file === 'systemd-run') up.add(args.find((a) => a.startsWith('--unit=')).slice(7))
      setImmediate(() => done(null, { stdout, stderr: '' }))
    },
    spawn: () => {
      throw new Error('nothing is spawned in this test')
    },
  },
})

const { promoteRun, routineContextFor } = await import('../server/workspaces/index.mjs')
const structured = await import('../server/launchers/structured.mjs')

test('a run nobody watched is unattended until promoted', async () => {
  assert.equal((await routineContextFor('w1')).unattended, true)
})

test('promoted: the manifest says so, its mode is a chat’s, and its dontAsk session is ended', async () => {
  const r = await promoteRun('w1', { outcome: 'needs-you', endedAt: 5 })
  assert.deepEqual(r, { mode: 'acceptEdits', ended: 1 })
  const m = JSON.parse(fs.readFileSync(path.join(tmp, 'workspaces', 'w1', 'workspace.json'), 'utf8'))
  assert.equal(m.permissionMode, 'acceptEdits')
  assert.deepEqual(m.routine, { id: 'dddd0004', name: 'Docs', runId: 'rrrr0001', outcome: 'needs-you', endedAt: 5, promoted: true })
  assert.ok(ran.some((c) => c[0] === 'systemctl' && c[2] === 'stop' && c[3] === 'outpost-session-a0a0a0a0'))
  assert.equal(up.has('outpost-session-a0a0a0a0'), false)
  // Watched now: it may ask the person (a Jenkins job, a routine of its own).
  assert.equal((await routineContextFor('w1')).unattended, false)
})

test('the person’s next message resumes it in that mode, with the approval bar, never dontAsk', async () => {
  // What `/api/send` with `resume` does (launchers/index.mjs `resumeOnce`).
  const rec = await structured.latestForSession(sid)
  const r = await structured.restart(rec)
  assert.equal(r.ok, true)
  const script = fs.readFileSync(path.join(r.record.dir, 'run.sh'), 'utf8')
  assert.match(script, /'--permission-mode' 'acceptEdits'/)
  assert.doesNotMatch(script, /dontAsk/)
  assert.match(script, /'--permission-prompt-tool' 'mcp__outpost__approve'/)
  assert.match(script, new RegExp(`'--resume' '${sid}'`))
  // Once only: the flag is replaced, never stacked.
  assert.equal(r.record.args.filter((a) => a === '--permission-mode').length, 1)
})

test('a workspace that is not a run is not promoted', async () => {
  fs.mkdirSync(path.join(tmp, 'workspaces', 'w2'), { recursive: true })
  assert.equal(await promoteRun('w2'), null)
})
