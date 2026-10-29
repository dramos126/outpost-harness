// What a session left running in the background (docs/modules/hooks.md `backgroundTasks`), from
// the payloads a 2026-10-14 probe recorded: `Stop` lists the CLI's running tasks, and a finished
// one wakes the session with a task-notification as its prompt.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.OUTPOST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-hooks-bg-'))
const { recordHookEvent } = await import('../server/state/hooks.mjs')

const id = 'bg-session-0001'
const ev = (extra) => recordHookEvent({ session_id: id, cwd: '/tmp', ...extra })
const ids = (rec) => rec.backgroundTasks.map((t) => t.id)

test('a Stop sets the running background tasks; agents and finished ones are left out', async () => {
  const rec = await ev({
    hook_event_name: 'Stop',
    background_tasks: [
      { id: 'b1', type: 'shell', status: 'running', description: 'probe bg sleep', command: 'sleep 30' },
      { id: 'b2', type: 'shell', status: 'running', command: 'grep -r x .\nsecond line' },
      { id: 'b3', type: 'shell', status: 'completed', description: 'done already' },
      { id: 'a1', type: 'local_agent', status: 'running', description: 'an agent' },
    ],
  })
  assert.equal(rec.status, 'done', 'a background command does not hold the chat working')
  assert.ok(rec.backgroundTasks.every((t) => t.since > 0))
  assert.deepEqual(rec.backgroundTasks.map(({ since, ...t }) => t), [
    { id: 'b1', type: 'shell', description: 'probe bg sleep' },
    { id: 'b2', type: 'shell', description: 'grep -r x .' },
  ])
})

test('the task-notification turn drops the task it reports; other events keep the list', async () => {
  assert.deepEqual(ids(await ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} })), ['b1', 'b2'])
  const rec = await ev({
    hook_event_name: 'UserPromptSubmit',
    prompt: '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>',
  })
  assert.deepEqual(ids(rec), ['b2'])
})

test('TaskStop and KillShell drop the task they name', async () => {
  await ev({ hook_event_name: 'Stop', background_tasks: [
    { id: 'b4', type: 'shell', status: 'running' },
    { id: 'b5', type: 'shell', status: 'running' },
    { id: 'b6', type: 'shell', status: 'running' },
  ] })
  assert.deepEqual(ids(await ev({ hook_event_name: 'PreToolUse', tool_name: 'TaskStop', tool_input: { task_id: 'b4' } })), ['b5', 'b6'])
  assert.deepEqual(ids(await ev({ hook_event_name: 'PreToolUse', tool_name: 'KillShell', tool_input: { shell_id: 'b5' } })), ['b6'])
})

test('a task keeps the time it was first seen across Stops', async () => {
  const first = await ev({ hook_event_name: 'Stop', background_tasks: [{ id: 'b8', type: 'shell', status: 'running' }] })
  await new Promise((r) => setTimeout(r, 5))
  const again = await ev({ hook_event_name: 'Stop', background_tasks: [{ id: 'b8', type: 'shell', status: 'running' }] })
  assert.equal(again.backgroundTasks[0].since, first.backgroundTasks[0].since)
})

test('an agent Outpost stopped is dropped at once, so the next Stop is not held on it', async () => {
  const { dropSubagent } = await import('../server/state/hooks.mjs')
  await ev({ hook_event_name: 'SubagentStart', agent_id: 'ag1', agent_type: 'dev' })
  await ev({ hook_event_name: 'SubagentStart', agent_id: 'ag2', agent_type: 'explore' })
  const rec = await dropSubagent(id, 'ag1')
  assert.deepEqual(rec.subagents.map((a) => a.id), ['ag2'])
  await dropSubagent(id, 'ag2')
  assert.equal((await ev({ hook_event_name: 'Stop' })).status, 'done')
})

test('a Stop without the field, and a new session, clear it', async () => {
  assert.deepEqual(ids(await ev({ hook_event_name: 'Stop' })), [])
  await ev({ hook_event_name: 'Stop', background_tasks: [{ id: 'b7', type: 'shell', status: 'running' }] })
  assert.deepEqual(ids(await ev({ hook_event_name: 'SessionStart' })), [])
})

test('stopping a task ends its shell and what the shell started; another task is untouched', async () => {
  const { spawn } = await import('node:child_process')
  const { stopBackgroundTask } = await import('../server/launchers/tasks.mjs')
  const session = 'task-stop-session-0001'
  const dir = path.join(process.env.OUTPOST_DATA, session, 'tasks')
  fs.mkdirSync(dir, { recursive: true })
  // As the CLI starts one: a shell leading a process session of its own, its output in the task's file.
  const start = (task) => {
    const out = fs.openSync(path.join(dir, `${task}.output`), 'w')
    const sh = spawn('sh', ['-c', 'sleep 60; echo late'], { detached: true, stdio: ['ignore', out, out] })
    fs.closeSync(out)
    return sh
  }
  const alive = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const target = start('t1')
  const other = start('t2')
  const exited = new Promise((r) => target.on('exit', r))
  await new Promise((r) => setTimeout(r, 200))
  const res = await stopBackgroundTask(session, 't1')
  assert.equal(res.ok, true)
  assert.ok(res.stopped >= 2, 'the shell and its sleep')
  await exited
  assert.equal(alive(other.pid), true)
  assert.equal((await stopBackgroundTask(session, 't1')).ok, false, 'nothing left under that id')
  assert.equal((await stopBackgroundTask(session, '../x')).ok, false, 'an id that is not one')
  process.kill(-other.pid, 'SIGKILL')
})

test("a task's output is read from its own file only, its end when it is long", async () => {
  const { readTaskOutput } = await import('../server/launchers/tasks.mjs')
  const session = 'task-read-session-0001'
  const dir = path.join(process.env.OUTPOST_DATA, session, 'tasks')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 't1.output')
  fs.writeFileSync(file, 'x'.repeat(70 * 1024) + 'the end\n')
  const res = await readTaskOutput(session, 't1', file)
  assert.equal(res.ok, true)
  assert.equal(res.truncated, true)
  assert.ok(res.text.endsWith('the end\n'))
  assert.equal((await readTaskOutput(session, 't1', '/etc/passwd')).ok, false, 'not a task file')
  assert.equal((await readTaskOutput(session, 't2', file)).ok, false, "another task's file")
  assert.equal((await readTaskOutput(session, 't9', path.join(dir, 't9.output'))).missing, true)
})
