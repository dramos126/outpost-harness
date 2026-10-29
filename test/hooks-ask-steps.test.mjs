// The row's "step N" and the quote on a row that needs you (docs/modules/hooks.md `steps`,
// `askKind`; launchers.md `askOf`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.OUTPOST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-hooks-steps-'))
const { recordHookEvent, markIdle } = await import('../server/state/hooks.mjs')

const id = 'steps-session-0001'
const ev = (extra) => recordHookEvent({ session_id: id, cwd: '/tmp', ...extra })
const tool = (extra = {}) => ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, ...extra })

test('steps count PreToolUse since the last prompt, a subagent\'s calls included', async () => {
  await ev({ hook_event_name: 'SessionStart' })
  assert.equal((await ev({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })).steps, 0)
  await tool()
  await ev({ hook_event_name: 'PostToolUse', tool_name: 'Bash' })
  await ev({ hook_event_name: 'PostToolBatch' })
  await tool({ agent_id: 'a1' })
  assert.equal((await tool()).steps, 3)
  assert.equal((await ev({ hook_event_name: 'Stop' })).steps, 3, 'a finished turn keeps its count')
  assert.equal((await markIdle(id)).steps, 3)
})

test('a new prompt and a new process start the count again', async () => {
  await tool()
  assert.equal((await ev({ hook_event_name: 'UserPromptSubmit', prompt: 'again' })).steps, 0)
  await tool()
  assert.equal((await ev({ hook_event_name: 'SessionStart' })).steps, 0)
})

test('askKind says which a wait is', async () => {
  await tool()
  let rec = await ev({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })
  assert.equal(rec.status, 'waiting')
  assert.equal(rec.askKind, 'permission')
  rec = await ev({ hook_event_name: 'Notification', notification_type: 'elicitation_dialog', message: 'Pick one\nmore' })
  assert.equal(rec.askKind, 'question')
  assert.equal((await ev({ hook_event_name: 'SubagentStop', agent_id: 'gone' })).askKind, 'question', 'kept while still waiting')
})

test('askOf quotes the head of the queue in one line', async () => {
  const { awaitApproval, askOf, answer } = await import('../server/launchers/structured.mjs')
  const ws = 'ws-ask-steps'
  const rec = { workspaceId: ws }
  assert.equal(askOf(rec), null)

  awaitApproval(ws, { toolName: 'WebFetch', input: { url: 'https://example.com/x', prompt: 'read it' }, toolUseId: 't1' })
  assert.deepEqual(askOf(rec), { kind: 'permission', head: 'WebFetch: https://example.com/x' })
  answer(ws, 'deny', { id: 't1' })

  awaitApproval(ws, { toolName: 'Write', input: { file_path: '/a/b.txt', content: 'x'.repeat(5000) }, toolUseId: 't2' })
  assert.deepEqual(askOf(rec), { kind: 'permission', head: 'Write: /a/b.txt' })
  answer(ws, 'deny', { id: 't2' })

  awaitApproval(ws, { toolName: 'mcp__x__y', input: { n: 1 }, toolUseId: 't3' })
  assert.deepEqual(askOf(rec), { kind: 'permission', head: 'mcp__x__y' })
  answer(ws, 'deny', { id: 't3' })

  const long = 'q'.repeat(300)
  awaitApproval(ws, {
    toolName: 'AskUserQuestion',
    input: { questions: [{ question: `Which way?\nsecond line`, options: [{ label: 'A' }] }, { question: long, options: [{ label: 'B' }] }] },
    toolUseId: 't4',
  })
  assert.deepEqual(askOf(rec), { kind: 'question', head: 'Which way?' })
  answer(ws, 'allow', { id: 't4', option: '1' })
  assert.equal(askOf(rec).head, 'q'.repeat(140), 'the next question, cut at 140')
  answer(ws, 'allow', { id: 't4', option: '1' })
  assert.equal(askOf(rec), null)
})
