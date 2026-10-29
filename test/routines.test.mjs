// Routines (docs/modules/routines.md): the migration from schedules, the gate, how a run's
// ending settles it — hidden, or promoted to a chat — what reaches Discord, and the execution
// log. The modules that reach Discord or start workspaces are mocked, so nothing leaves the
// machine; the store runs for real on a temp config and data dir.
import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-routines-'))
const CONFIG = path.join(tmp, 'config')
const DATA = path.join(tmp, 'data')
process.env.OUTPOST_DATA = DATA
fs.mkdirSync(CONFIG, { recursive: true })
fs.mkdirSync(DATA, { recursive: true })
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

// What schedules left behind, for the migration: written before the store first loads.
fs.writeFileSync(
  path.join(CONFIG, 'schedules.json'),
  JSON.stringify({
    version: 1,
    schedules: [{ id: 'aaaa0001', name: 'Nightly check', cron: '0 23 * * *', tz: 'America/Chicago', repos: [{ id: 'docs', base: 'main' }], prompt: 'check the docs', model: 'sonnet', permissionMode: 'dontAsk', graceMinutes: 30, createdBy: 'page' }],
  })
)
fs.writeFileSync(
  path.join(DATA, 'schedule-runs.json'),
  JSON.stringify({ version: 1, lastTickAt: 5, runs: { aaaa0001: [{ at: 1, slotAt: 1, workspaceId: 'old1', outcome: 'finished', reason: 'due' }] }, done: {} })
)

const sent = []
const created = []
const marked = []
let heads = {}
let manifests = {}
let pendingDeletes = {}
mock.module('../server/notify/index.mjs', { namedExports: { notify: (e) => (sent.push(e), Promise.resolve({ ok: true })) } })
mock.module('../server/workspaces/catalogue.mjs', { namedExports: { CONFIG_DIR: CONFIG } })
mock.module('../server/workspaces/index.mjs', {
  namedExports: {
    createWorkspace: async (spec) => {
      created.push(spec)
      const m = { id: `w${created.length}`, routine: spec.routine }
      manifests[m.id] = m
      return m
    },
    listWorkspaces: async () => [],
    mainHeadOf: async (id) => {
      if (!(id in heads)) throw new Error('no mirror')
      return heads[id]
    },
    markWorkspace: async (id, fields) => (marked.push({ id, ...fields }), { id, ...fields }),
    // Promotion as the workspace layer does it, its mode switch proven in routines-promote.test.mjs.
    promoteRun: async (id, fields) => (marked.push({ id, routine: { ...manifests[id]?.routine, ...fields, promoted: true } }), { mode: 'acceptEdits', ended: 1 }),
    // What a run's publish left to confirm (workspaces/index.mjs); set per test.
    pendingDeletesOf: async (id) => pendingDeletes[id] || [],
    runCommitsOf: async () => [{ repo: 'docs', sha: 'abc1234', pushed: true }],
    workspaceFor: async (cwd) => manifests[path.basename(cwd)] || null,
    DEFAULT_PERMISSION_MODE: 'acceptEdits',
    definingChats: async () => [],
    linkDefiningChat: async () => false,
  },
})

const routines = await import('../server/state/routines.mjs')
const { configureRoutines, settleRuns, checkGate, runNow, listRoutines, saveRoutine, runsOf, runLogOf, endRun, stepRun, noteRunTool, importRoutines, flushRoutineWrites, routineSummaries } = routines

let replies = 'What the run found.'
let sends = []
const endedSessions = []
configureRoutines({
  endSession: async (thread) => endedSessions.push(thread.workspace.id),
  roster: async () => ({ threads: [], workspaces: [] }),
  lastReply: async () => replies,
  discordSentSince: (id, at) => sends.some((t) => t >= at),
  tokensOf: async () => ({ input: 10, output: 20, cacheRead: 0, cacheWrite: 0 }),
})

test('each schedule becomes a routine on first load, its runs seed the routine’s, and the old files are renamed aside', async () => {
  const [r] = await listRoutines()
  assert.equal(r.id, 'aaaa0001')
  assert.deepEqual(r.triggers, [{ kind: 'time', cron: '0 23 * * *', tz: 'America/Chicago' }])
  assert.equal(r.gate, null)
  assert.deepEqual(r.steps, [{ id: 's1', title: 'Nightly check', next: [{ to: 'end:done' }] }])
  assert.equal(r.prompt, 'check the docs')
  assert.equal(r.model, 'sonnet')
  assert.equal(r.graceMinutes, 30)
  assert.equal(r.createdBy, 'page')
  assert.equal(r.when, 'Every day at 11:00 PM')
  assert.equal(r.next.length, 3)
  assert.equal(r.lastRun.outcome, 'done')
  assert.ok(fs.existsSync(path.join(CONFIG, 'routines', 'aaaa0001.json')))
  assert.ok(!fs.existsSync(path.join(CONFIG, 'schedules.json')))
  assert.ok(fs.readdirSync(CONFIG).some((n) => n.startsWith('schedules.json.migrated-')))
  assert.ok(fs.readdirSync(DATA).some((n) => n.startsWith('schedule-runs.json.migrated-')))
  const summary = (await routineSummaries())[0]
  assert.deepEqual(Object.keys(summary).sort(), ['definedBy', 'enabled', 'finished', 'id', 'lastRun', 'name', 'next', 'running', 'when'])
})

test('an old export’s schedules import as routines', async () => {
  const list = await importRoutines({ schedules: [{ id: 'bbbb0002', name: 'Once', at: Date.now() + 3600_000, tz: 'UTC', prompt: 'p' }] })
  assert.equal(list.length, 1)
  assert.equal(list[0].triggers[0].kind, 'time')
  assert.ok(list[0].triggers[0].at)
  // An import replaces the set: the migrated routine is gone, the imported one is there.
  assert.deepEqual((await listRoutines()).map((r) => r.id), ['bbbb0002'])
})

test('steps are checked: every edge lands on a step or an ending', async () => {
  await assert.rejects(saveRoutine({ name: 'bad', triggers: [{ cron: '0 1 * * *', tz: 'UTC' }], steps: [{ title: 'a', next: [{ to: 'nowhere' }] }] }), /neither a step nor/)
  const r = await saveRoutine({ name: 'two steps', triggers: [{ cron: '0 1 * * *', tz: 'UTC' }], steps: [{ title: 'read' }, { title: 'write' }] })
  assert.deepEqual(r.steps.map((s) => [s.id, s.next[0].to]), [['s1', 's2'], ['s2', 'end:done']])
})

// ── the gate ──

const gated = { id: 'cccc0003', name: 'Docs', gate: { kind: 'activity', repos: ['stacks'] } }
const chat = (id, at) => ({ workspace: { id }, lastActivityAt: at })

test('the gate lets the first run through', async () => {
  heads = { stacks: 'h1' }
  const g = await checkGate(gated, [], [], [])
  assert.equal(g.ran, true)
  assert.deepEqual(g.heads, { stacks: 'h1' })
})

test('the gate stops a run when nothing happened since the last one, and a run’s own activity does not count', async () => {
  heads = { stacks: 'h1' }
  const last = { at: 1000, workspaceId: 'w0', heads: { stacks: 'h1' } }
  const g = await checkGate(gated, [last], [chat('run1', 5000), chat('chat1', 500)], [{ id: 'run1', routine: { id: 'x' } }, { id: 'chat1' }])
  assert.equal(g.ran, false)
  assert.match(g.why, /No chat active/)
})

test('the gate passes on a chat active since, or main moved, or a main it cannot read', async () => {
  const last = { at: 1000, workspaceId: 'w0', heads: { stacks: 'h1' } }
  heads = { stacks: 'h1' }
  assert.equal((await checkGate(gated, [last], [chat('chat1', 2000)], [{ id: 'chat1' }])).ran, true)
  heads = { stacks: 'h2' }
  const moved = await checkGate(gated, [last], [], [])
  assert.equal(moved.ran, true)
  assert.match(moved.why, /main moved on stacks/)
  heads = {}
  assert.equal((await checkGate(gated, [last], [], [])).ran, true)
})

test('Run now: a quiet gate ends the run as nothing with no session; skipGate starts one that is told how to end', async () => {
  heads = { stacks: 'h1' }
  const r = await saveRoutine({ name: 'Docs', triggers: [{ cron: '0 23 * * *', tz: 'UTC' }], gate: { kind: 'activity', repos: ['stacks'] }, prompt: 'update the docs', steps: [{ title: 'Read' }, { title: 'Write' }] })
  const first = await runNow(r.id) // the first run always passes the gate
  assert.equal(first.outcome, 'running')
  assert.equal(created.length, 1)
  assert.deepEqual(created[0].routine, { id: r.id, name: 'Docs', runId: first.runId })
  assert.match(created[0].prompt, /^update the docs\n\n---\n\n/)
  assert.match(created[0].prompt, /routine_end/)
  assert.match(created[0].prompt, /Read \(s1\)/)

  const quiet = await runNow(r.id)
  assert.equal(quiet.outcome, 'nothing')
  assert.equal(quiet.reason, 'gate')
  assert.equal(quiet.workspaceId, undefined)
  assert.equal(created.length, 1)

  const forced = await runNow(r.id, { skipGate: true })
  assert.equal(forced.outcome, 'running')
  assert.equal(forced.skipGate, true)
  assert.equal(created.length, 2)

  await flushRoutineWrites()
  const events = (await runLogOf(r.id, quiet.runId)).map((e) => e.event)
  assert.deepEqual(events, ['started', 'gate', 'ended'])
  const runs = await runsOf(r.id)
  assert.deepEqual(runs.map((x) => x.runId), [forced.runId, quiet.runId, first.runId])
})

// ── a run's steps, its tools and its ending ──

test('routine_step and tool calls go to the execution log; inputs only, and cut', async () => {
  const r = await saveRoutine({ name: 'Steps', triggers: [], prompt: 'p', steps: [{ title: 'one' }] })
  const run = await runNow(r.id)
  const ws = run.workspaceId
  await stepRun(ws, { step: 's1', status: 'started' })
  await stepRun(ws, { step: 's1', status: 'done' })
  await assert.rejects(stepRun(ws, { step: 's9', status: 'done' }), /No step "s9"/)
  await noteRunTool({ cwd: `/somewhere/${ws}`, tool: 'Write', input: { file_path: 'a.md', content: 'x'.repeat(5000) } })
  await noteRunTool({ cwd: '/elsewhere/not-a-run', tool: 'Bash', input: { command: 'ls' } })
  await flushRoutineWrites()
  const events = await runLogOf(r.id, run.runId)
  const steps = events.filter((e) => e.event === 'step').map((e) => e.status)
  assert.deepEqual(steps, ['started', 'done'])
  const tool = events.find((e) => e.event === 'tool')
  assert.equal(tool.name, 'Write')
  assert.ok(tool.input.content.length <= 1001)
  assert.equal(events.filter((e) => e.event === 'tool').length, 1)
  const [latest] = await runsOf(r.id)
  assert.equal(latest.steps.length, 1)
  assert.equal(latest.steps[0].status, 'done')
  assert.ok(latest.steps[0].endedAt)
})

/** Settle one running run whose thread is `thread`, with `ending` as what it called routine_end with. */
async function settle(thread, { ending, legacy = false } = {}) {
  sent.length = 0
  marked.length = 0
  endedSessions.length = 0
  const run = { runId: 'rrrr0001', at: 1_000_000, workspaceId: 'w9', outcome: 'running', steps: [], ...(legacy ? { legacy } : {}), ...(ending ? { ending } : {}) }
  const ws = { id: 'w9', status: 'ready', routine: { id: 'dddd0004', name: 'Docs', runId: 'rrrr0001' } }
  await settleRuns({ runs: { dddd0004: [run] } }, [{ id: 'dddd0004', name: 'Docs' }], [ws], thread ? [{ workspace: { id: 'w9' }, title: 'run', ...thread }] : [])
  return { run, mark: marked[0] }
}

test('done: hidden, told to Discord with its text, unless the run posted itself', async () => {
  sends = []
  const { run, mark } = await settle({ done: true }, { ending: { outcome: 'done', text: 'Updated two pages.' } })
  assert.equal(run.outcome, 'done')
  assert.equal(run.text, 'Updated two pages.')
  assert.deepEqual(run.commits, [{ repo: 'docs', sha: 'abc1234', pushed: true }])
  assert.equal(run.tokens.output, 20)
  assert.equal(mark.routine.outcome, 'done')
  assert.equal(mark.routine.promoted, undefined)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].event, 'routine-ended')
  assert.equal(sent[0].summary, 'Updated two pages.')
  sends = [1_000_000 + 60_000]
  await settle({ done: true }, { ending: { outcome: 'done', text: 'x' } })
  assert.deepEqual(sent, [])
  sends = []
})

test('nothing and done end the run’s session at once; a promoted run’s is ended for the mode switch alone', async () => {
  await settle({ done: true }, { ending: { outcome: 'done', text: 'x' } })
  assert.deepEqual(endedSessions, ['w9'])
  await settle({ turnEndedAt: 2 }, { ending: { outcome: 'nothing', text: '' } })
  assert.deepEqual(endedSessions, ['w9'])
  await settle({ done: true }, { ending: { outcome: 'needs-you', text: 'Which?' } })
  assert.deepEqual(endedSessions, [], 'promoteRun ends it, not the runner')
  await settle({ done: true }, { legacy: true })
  assert.deepEqual(endedSessions, [], 'a visible chat from before routines is aged like one')
  await settle({ running: true }, { ending: { outcome: 'done', text: 'x' } })
  assert.deepEqual(endedSessions, [])
})

test('done with a publish’s deletions waiting is needs-you: promoted, the files named, told to Discord', async () => {
  pendingDeletes = { w9: [{ repo: 'docs', dataset: 'reports', to: 'nas-1:/mnt/reports', files: ['old/a.json', 'old/b.json'] }] }
  try {
    const { run, mark } = await settle({ done: true }, { ending: { outcome: 'done', text: 'Moved two runs.' } })
    assert.equal(run.outcome, 'needs-you')
    assert.equal(run.reason, 'deletions')
    assert.match(run.text, /^Moved two runs\.\n\nIt deleted or moved 2 files in reports; say whether to remove them from nas-1:\/mnt\/reports too\.$/)
    assert.equal(mark.routine.promoted, true)
    assert.equal(mark.routine.outcome, 'needs-you')
    assert.deepEqual(endedSessions, [], 'promoteRun ends it, and asks the question once the chat is watched')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].outcome, 'needs-you')
    assert.match(sent[0].summary, /remove them/)
    // A run that already needs you is not asked twice over.
    const again = await settle({ done: true }, { ending: { outcome: 'needs-you', text: 'Which?' } })
    assert.equal(again.run.reason, undefined)
  } finally {
    pendingDeletes = {}
  }
})

test('nothing: hidden, and nothing is told', async () => {
  const { run, mark } = await settle({ turnEndedAt: 2 }, { ending: { outcome: 'nothing', text: '' } })
  assert.equal(run.outcome, 'nothing')
  assert.equal(mark.routine.promoted, undefined)
  assert.deepEqual(sent, [])
})

test('needs-you: promoted to a chat and told, even when the run posted itself', async () => {
  sends = [1_000_000 + 60_000]
  const { run, mark } = await settle({ done: true }, { ending: { outcome: 'needs-you', text: 'Which VM is this?' } })
  assert.equal(run.outcome, 'needs-you')
  assert.equal(mark.routine.promoted, true)
  assert.equal(sent[0].outcome, 'needs-you')
  assert.equal(sent[0].summary, 'Which VM is this?')
  sends = []
})

test('a run that stops without routine_end is needs-you, with its last reply', async () => {
  const { run, mark } = await settle({ done: true })
  assert.equal(run.outcome, 'needs-you')
  assert.equal(run.reason, 'no-ending')
  assert.equal(run.text, 'What the run found.')
  assert.equal(mark.routine.promoted, true)
  assert.equal(sent.length, 1)
})

test('a stalled or errored run fails, promoted and told', async () => {
  for (const [thread, reason] of [[{ stalled: true }, 'stalled'], [{ hasError: true }, 'error']]) {
    const { run, mark } = await settle(thread, { ending: { outcome: 'done', text: 'x' } })
    assert.equal(run.outcome, 'failed')
    assert.equal(run.reason, reason)
    assert.equal(mark.routine.promoted, true)
    assert.equal(sent[0].outcome, 'failed')
  }
})

test('a run whose turn ended with a background task still out is held, not settled', async () => {
  const { run } = await settle({ done: true, backgroundTasks: [{ id: 't1' }] })
  assert.equal(run.outcome, 'running')
  assert.deepEqual(sent, [])
})

test('a run that called routine_end is settled though a background task is still out', async () => {
  const { run, mark } = await settle({ turnEndedAt: 2, backgroundTasks: [{ id: 't1' }] }, { ending: { outcome: 'needs-you', text: 'Publish as-is?' } })
  assert.equal(run.outcome, 'needs-you')
  assert.equal(run.text, 'Publish as-is?')
  assert.equal(mark.routine.promoted, true)
})

test('a run still working is left alone', async () => {
  const { run } = await settle({ running: true }, { ending: { outcome: 'done', text: 'x' } })
  assert.equal(run.outcome, 'running')
  assert.deepEqual(sent, [])
})

test('a schedule’s run from before routines finishes as done, never promoted', async () => {
  const { run, mark } = await settle({ done: true }, { legacy: true })
  assert.equal(run.outcome, 'done')
  assert.equal(mark.routine.promoted, undefined)
  assert.equal(sent[0].summary, 'What the run found.')
})

test('routine_end is refused for a chat that is not a run, and checked', async () => {
  await assert.rejects(endRun('nobody', { outcome: 'done', text: 'x' }), /not a routine's run/)
  const r = await saveRoutine({ name: 'Ends', triggers: [], prompt: 'p' })
  const run = await runNow(r.id)
  await assert.rejects(endRun(run.workspaceId, { outcome: 'maybe', text: 'x' }), /nothing, done or needs-you/)
  await assert.rejects(endRun(run.workspaceId, { outcome: 'needs-you', text: '' }), /needs a text/)
  await endRun(run.workspaceId, { outcome: 'done', text: 'fine' })
  const [latest] = await runsOf(r.id)
  assert.deepEqual({ outcome: latest.ending.outcome, text: latest.ending.text }, { outcome: 'done', text: 'fine' })
})

test('a tick whose roster names a skipped harness starts and settles nothing', async () => {
  const before = created.length
  configureRoutines({ roster: async () => ({ threads: [], workspaces: [], scanFailed: ['claude-code'] }) })
  await saveRoutine({ name: 'Every minute', triggers: [{ cron: '* * * * *', tz: 'UTC' }], prompt: 'p' })
  await routines.tick()
  await flushRoutineWrites()
  assert.equal(created.length, before)
  const log = fs.readFileSync(path.join(DATA, 'routine-log.jsonl'), 'utf8')
  assert.match(log, /"event":"tick-error"/)
})
