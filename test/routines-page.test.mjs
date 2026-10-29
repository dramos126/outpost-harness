// The Routines tab and a routine's page, their logic without a browser (docs/modules/ui.md,
// ui-details.md *Run*): the list's sections and row marks, Delete's confirm, the run's log by step, and a
// routine's defining chats kept out of Chats (chats.md, routines.md *Defining chats*).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { draftStatus, draftWaiting, groupRoutines, RoutineList } from '../src/ui/routines.js'
import { deletedWords, deleteWords, groupLog, runFacts } from '../src/ui/routine-page.js'
import { chatThreads, definesOf, definingWords, liftNeedsYou, savedFrom, visibleThreads } from '../src/state/threads.js'

test('the list is Needs you, Active, Paused, One-offs done, empty sections left out', () => {
  const routines = [
    { id: 'a', enabled: true },
    { id: 'b', enabled: false },
    { id: 'c', enabled: true, finished: true },
    { id: 'd', enabled: false, finished: true },
    { id: 'e', enabled: true },
    { id: 'f', enabled: false },
  ]
  const waiting = new Map([['e', { id: 't1' }], ['f', { id: 't2' }]])
  const groups = groupRoutines(routines, waiting)
  assert.deepEqual(
    groups.map((g) => [g.key, g.routines.map((r) => r.id)]),
    [
      ['needs', ['e', 'f']],
      ['active', ['a']],
      ['paused', ['b']],
      ['finished', ['c', 'd']],
    ]
  )
  assert.deepEqual(
    groupRoutines([{ id: 'a' }]).map((g) => g.key),
    ['active']
  )
})

test('a server with no finished flag leaves a fired one-off under Active or Paused', () => {
  const groups = groupRoutines([{ id: 'a', enabled: true, next: [] }, { id: 'b', enabled: false }])
  assert.deepEqual(
    groups.map((g) => g.key),
    ['active', 'paused']
  )
})

test('Delete’s confirm names the routine and says its run log stays', () => {
  const { head, why } = deleteWords({ name: 'Nightly docs' })
  assert.equal(head, 'Delete “Nightly docs”?')
  assert.match(why, /run log is kept on this machine/)
  assert.doesNotMatch(why, /defined it/)
  assert.match(deleteWords({ name: 'x', definedBy: 'ab12cd34' }).why, /chat that defined it is deleted too/)
})

test('a run’s log is grouped by step, the run’s own events Before and After', () => {
  const events = [
    { at: 1, event: 'started', by: 'trigger' },
    { at: 2, event: 'gate', ran: true },
    { at: 3, event: 'tool', name: 'Read' },
    { at: 4, event: 'step', step: 's1', status: 'started' },
    { at: 5, event: 'tool', name: 'Bash' },
    { at: 6, event: 'tool', name: 'Edit' },
    { at: 7, event: 'step', step: 's1', status: 'done' },
    { at: 8, event: 'tool', name: 'Grep' },
    { at: 9, event: 'step', step: 's2', status: 'started' },
    { at: 10, event: 'tool', name: 'Bash' },
    { at: 11, event: 'ended', outcome: 'failed' },
    { at: 12, event: 'promoted' },
  ]
  const { before, steps, after } = groupLog(events)
  assert.deepEqual(before.map((e) => e.event), ['started', 'gate', 'tool'])
  assert.deepEqual(
    steps.map((g) => [g.step, g.status, g.at, g.endedAt, g.events.map((e) => e.at)]),
    [
      ['s1', 'done', 4, 7, [5, 6, 8]],
      ['s2', 'started', 9, 0, [10]],
    ]
  )
  assert.deepEqual(after.map((e) => e.event), ['ended', 'promoted'])
})

test('a step ended with no start seen is a group of its own; a run with no steps is all Before', () => {
  const { steps } = groupLog([{ at: 5, event: 'step', step: 's3', status: 'skipped' }])
  assert.deepEqual(steps.map((g) => [g.step, g.status, g.at, g.endedAt]), [['s3', 'skipped', 5, 5]])
  const flat = groupLog([{ event: 'started' }, { event: 'gate', ran: false }, { event: 'ended' }])
  assert.equal(flat.steps.length, 0)
  assert.equal(flat.before.length, 3)
})

test('the summary says how long a run took and what it spent, or how long it has been going', () => {
  assert.equal(runFacts({ outcome: 'done', at: 1000, endedAt: 135000, tokens: { total: 34200 } }), 'took 2m 14s · 34k tokens')
  assert.equal(runFacts({ outcome: 'running', at: 1000 }, 63000), 'running for 1m 02s')
  assert.equal(runFacts({ outcome: 'failed' }), '')
})

test('drafts are a section of their own above Needs you, in the roster’s order', () => {
  const drafts = [{ workspaceId: 'w1' }, { workspaceId: 'w2' }]
  const groups = groupRoutines([{ id: 'a', enabled: true }, { id: 'e', enabled: true }], new Map([['e', { id: 't1' }]]), drafts)
  assert.deepEqual(
    groups.map((g) => [g.key, g.routines.map((r) => r.id || r.workspaceId)]),
    [
      ['drafts', ['w1', 'w2']],
      ['needs', ['e']],
      ['active', ['a']],
    ]
  )
  assert.deepEqual(groupRoutines([{ id: 'a' }], new Map(), []).map((g) => g.key), ['active'])
})

test('a draft says its chat’s status, and only one that asks counts as waiting', () => {
  const now = Date.now()
  const asking = { workspaceId: 'w1', status: 'ready', thread: { id: 't1', unread: true, lastActivityAt: now } }
  const working = { workspaceId: 'w2', status: 'ready', thread: { id: 't2', running: true, lastActivityAt: now } }
  const starting = { workspaceId: 'w3', status: 'preparing', thread: null }
  const failed = { workspaceId: 'w4', status: 'failed', error: 'no launcher', thread: null }
  assert.deepEqual([asking, working, starting, failed].map((d) => draftStatus(d, now)), ['waiting', 'working', 'working', 'blocked'])
  assert.deepEqual([asking, working, starting, failed].map((d) => draftWaiting(d, now)), [true, false, false, false])
})

test('a defining chat is never in Chats, its Needs you or its count', () => {
  const now = Date.now()
  const threads = [
    { id: 'plain', unread: true, lastActivityAt: now, defines: null },
    { id: 'draft', unread: true, lastActivityAt: now, defines: { routineId: null, name: null } },
    { id: 'linked', unread: true, lastActivityAt: now, defines: { routineId: 'ab12cd34', name: 'Nightly' } },
    { id: 'old', lastActivityAt: now },
  ]
  assert.deepEqual(chatThreads(threads).map((t) => t.id), ['plain', 'old'])
  const { needs } = liftNeedsYou(visibleThreads(chatThreads(threads)), now)
  assert.deepEqual(needs.map((t) => t.id), ['plain'])
  assert.equal(definesOf(threads[0]), null)
  assert.equal(definesOf({ id: 'x' }), null)
  assert.deepEqual(definesOf(threads[1]), { routineId: null, name: null })
})

test('a save is the open chat’s defines going from no routine to one', () => {
  const draft = { id: 't', defines: { routineId: null, name: null } }
  const linked = { id: 't', defines: { routineId: 'ab12cd34', name: 'Nightly' } }
  assert.equal(savedFrom(draft, linked), 'ab12cd34')
  assert.equal(savedFrom(linked, linked), '')
  assert.equal(savedFrom(undefined, linked), '')
  assert.equal(savedFrom(draft, draft), '')
  assert.equal(savedFrom({ id: 't', defines: null }, linked), '')
})

test('a defining chat is headed by what it makes, with the line on what to say', () => {
  assert.equal(definingWords(null), null)
  assert.equal(definingWords({ routineId: null, name: null }).head, 'Defining a routine')
  assert.equal(definingWords({ routineId: 'ab12cd34', name: 'Nightly docs' }).head, 'Changing Nightly docs')
  assert.match(definingWords({ routineId: null }).hint, /ask you to approve the routine/)
})

test('a delete that kept its defining chat says so', () => {
  assert.deepEqual(deletedWords('Nightly', [{ workspaceId: 'w', deleted: true }]), ['Nightly deleted', ''])
  assert.deepEqual(deletedWords('Nightly'), ['Nightly deleted', ''])
  const [text, kind] = deletedWords('Nightly', [{ workspaceId: 'w', deleted: false, error: 'busy' }])
  assert.match(text, /kept under Drafts: busy/)
  assert.equal(kind, 'err')
})

test("a run's chat wants you when it comes back, and stops once the person has written in it", async () => {
  const { runNeedsYou } = await import('../src/state/threads.js')
  const fresh = { routine: { id: 'r', name: 'R', runId: 'x', answered: false } }
  const answered = { routine: { id: 'r', name: 'R', runId: 'x', answered: true } }
  assert.equal(runNeedsYou(fresh, 'done'), true)
  assert.equal(runNeedsYou(answered, 'done'), false, "a turn's end after a reply is news, not a question")
  assert.equal(runNeedsYou(answered, 'waiting'), true, 'a permission it asks still needs you')
  assert.equal(runNeedsYou({ routine: 'cli-task' }, 'done'), false)
})

// A row's mark (marks.js, ui.md *Status marks*): a done run earns none, since a check means
// something new to read and a done run never is; a paused routine keeps its ring in the slot.
const rowOf = (r, thread = null) => new RoutineList({ addEventListener() {} }, {}).row({ id: 'r', name: 'R', enabled: true, ...r }, thread, '', Date.now())
const markOf = (html) => /<i class="mark [^"]*"/.exec(html)?.[0] ?? ''

test('a routine row draws a running, needs-you or failed run as the marks, and a done one as none', () => {
  assert.match(markOf(rowOf({ running: true })), /working m-spin/)
  assert.match(markOf(rowOf({ lastRun: { outcome: 'running' } })), /working m-spin/)
  assert.match(markOf(rowOf({ lastRun: { outcome: 'needs-you' } }, { id: 't' })), /waiting m-ask/)
  assert.match(markOf(rowOf({ lastRun: { outcome: 'failed' } })), /blocked m-error/)
  for (const lastRun of [{ outcome: 'done' }, { outcome: 'nothing' }, undefined]) assert.equal(markOf(rowOf({ lastRun })), '<i class="mark idle"')
  // The row keeps its status class: the list's other rules read it.
  assert.match(rowOf({ lastRun: { outcome: 'done' } }), /class="chat routine done"/)
})

test("a needs-you run whose chat was dealt with needed you: no ask mark, and the words say so", () => {
  const waiting = rowOf({ lastRun: { outcome: 'needs-you' } }, { id: 't' })
  assert.match(waiting, /<span>needs you<\/span>/)
  const dealt = rowOf({ lastRun: { outcome: 'needs-you' } })
  assert.equal(markOf(dealt), '<i class="mark idle"')
  assert.match(dealt, /<span>needed you<\/span>/)
  assert.doesNotMatch(dealt, /waiting/)
})

test('a paused routine keeps its ring unless its last run has a mark of its own', () => {
  const html = rowOf({ enabled: false, lastRun: { outcome: 'done' } })
  assert.match(html, /<i class="mark idle m-ring"><i class="dot"><\/i><\/i>/)
  assert.match(html, /class="chat routine done paused"/)
  assert.match(markOf(rowOf({ enabled: false, lastRun: { outcome: 'failed' } })), /blocked m-error/)
})

test('a draft whose chat asks wears the ask mark', () => {
  const now = Date.now()
  const d = { workspaceId: 'w', title: 'New', thread: { id: 't', unread: true, lastActivityAt: now } }
  assert.match(markOf(new RoutineList({ addEventListener() {} }, {}).draftRow(d, '', now)), /waiting m-ask/)
})
