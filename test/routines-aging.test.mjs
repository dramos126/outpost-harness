// A routine's run that ended with nothing for the person is deleted a day after it ended, and
// only clean and pushed; one that is not is promoted to a chat rather than kept out of sight
// (docs/modules/aging.md, routines.md). The workspace store and settings are mocked; aging runs
// for real on a temp data dir.
import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-routine-aging-'))
process.env.OUTPOST_DATA = tmp
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

const deleted = []
const marked = []
const promoted = []
const runEvents = []
let refuse = ''
mock.module('../server/config.mjs', { namedExports: { readSettings: async () => ({ aging: { endIdleHours: 0, idleDays: 0, deleteDays: 7, diskBudgetGB: 0 } }) } })
mock.module('../server/workspaces/git.mjs', { namedExports: { MIRRORS_DIR: tmp } })
let routineIds = new Set()
mock.module('../server/state/routines.mjs', {
  namedExports: {
    logRunEvent: (...a) => runEvents.push(a),
    routineIdsOnDisk: async () => {
      if (routineIds === null) throw new Error('EACCES')
      return routineIds
    },
  },
})
mock.module('../server/workspaces/index.mjs', {
  namedExports: {
    WORKSPACES_DIR: tmp,
    deleteWorkspace: async (id, { force }) => {
      assert.equal(force, false)
      if (refuse) return { ok: false, error: refuse }
      deleted.push(id)
      return { ok: true }
    },
    markWorkspace: async (id, fields) => (marked.push({ id, ...fields }), {}),
    promoteRun: async (id) => (promoted.push(id), { mode: 'acceptEdits', ended: 0 }),
    pendingDeletesOf: async () => [],
    sweepWorktrees: async () => (sweeps++, [{ mirror: 'docs.git', locked: [], freed: ['/w/gone/docs'], failed: [] }]),
  },
})
let sweeps = 0
let firstSwept = null

const { configureAging, tick, RUN_KEEP_MS } = await import('../server/state/aging.mjs')

const now = Date.now()
const run = (id, outcome, endedAt, extra = {}) => ({ id, name: id, status: 'ready', createdAt: endedAt, routine: { id: 'aaaa0001', name: 'Docs', runId: `r-${id}`, outcome, endedAt, ...extra } })
let workspaces = []
configureAging({ roster: async () => ({ threads: [], workspaces }) })

test('a nothing or done run goes a day after it ended; a fresh one, a needs-you one or a running one stays', async () => {
  workspaces = [
    run('old-done', 'done', now - RUN_KEEP_MS - 1000),
    run('old-nothing', 'nothing', now - RUN_KEEP_MS - 1000),
    run('fresh-done', 'done', now - 1000),
    run('needs-you', 'needs-you', now - RUN_KEEP_MS * 3, { promoted: true }),
    { id: 'running', name: 'running', status: 'ready', createdAt: now - RUN_KEEP_MS * 3, routine: { id: 'aaaa0001', name: 'Docs', runId: 'r-running' } },
  ]
  const r = await tick()
  firstSwept = r.swept
  assert.equal(r.ok, true)
  assert.deepEqual(deleted.sort(), ['old-done', 'old-nothing'])
  assert.deepEqual(runEvents.map((e) => [e[1], e[2]]).sort(), [['r-old-done', 'deleted'], ['r-old-nothing', 'deleted']])
})

test('one holding unpushed work is never deleted: it is promoted to a chat, with why', async () => {
  deleted.length = 0
  runEvents.length = 0
  refuse = 'docs has commits that are not pushed. Push the branch first, or delete anyway.'
  workspaces = [run('unpushed', 'done', now - RUN_KEEP_MS - 1000)]
  await tick()
  assert.deepEqual(deleted, [])
  assert.equal(marked[0].id, 'unpushed')
  assert.equal(marked[0].kept, refuse)
  assert.deepEqual(promoted, ['unpushed'])
  assert.equal(runEvents[0][2], 'promoted')
})

// A chat that defines a routine (routines.md, *Defining chats*) is never deleted while its
// routine is on disk; an unsaved draft, or one whose routine is gone, ages like any chat.
test('a defining chat whose routine exists is kept; a draft and an orphan are deleted after the grace', async () => {
  deleted.length = 0
  refuse = ''
  const old = now - 30 * 24 * 60 * 60 * 1000
  const chat = (id, routineId) => ({ id, name: id, status: 'ready', createdAt: old, aged: old, defines: { routineId } })
  routineIds = new Set(['aaaa0001'])
  workspaces = [chat('linked', 'aaaa0001'), chat('draft', null), chat('orphan', 'bbbb0002')]
  await tick()
  assert.deepEqual(deleted.sort(), ['draft', 'orphan'])
  const { agingView } = await import('../server/state/aging.mjs')
  const view = await agingView(workspaces, [])
  assert.equal(view.get('linked').deleteAt, 0)
  assert.equal(view.get('linked').pinned, false)
  assert.ok(view.get('draft').deleteAt > 0)
})

test('a routines folder that cannot be listed keeps every defining chat that names a routine', async () => {
  deleted.length = 0
  routineIds = null
  const old = now - 30 * 24 * 60 * 60 * 1000
  workspaces = [{ id: 'linked', name: 'linked', status: 'ready', createdAt: old, aged: old, defines: { routineId: 'aaaa0001' } }]
  await tick()
  assert.deepEqual(deleted, [])
  routineIds = new Set()
})

// The mirrors' worktree sweep (aging.md) rides the first pass after a start, then waits a day.
test('the worktree sweep ran on the first pass and not on the later ones', async () => {
  assert.deepEqual(firstSwept, ['docs.git'])
  assert.equal(sweeps, 1)
  const r = await tick()
  assert.deepEqual(r.swept, [])
  assert.equal(sweeps, 1)
})
