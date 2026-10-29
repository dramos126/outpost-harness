// `toolDone` (docs/modules/hooks.md *The store*): the template installs no `PostToolUse`, so the
// unpushed check hears a batch's tools at `PostToolBatch` — shipped first listening for
// `PostToolUse` alone, which no session Outpost set up ever sends (2026-10-20).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.OUTPOST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-hooks-done-'))
const { recordHookEvent, hookEvents } = await import('../server/state/hooks.mjs')

const heard = []
hookEvents.on('toolDone', (e) => heard.push(e))
const ev = (id, extra) => recordHookEvent({ session_id: id, cwd: '/tmp/w', ...extra })

test('a batch ends with the tools its PreToolUse calls named, once', async () => {
  heard.length = 0
  await ev('done-session-01', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} })
  await ev('done-session-01', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: {} })
  assert.equal(heard.length, 0, 'nothing before the batch ends')
  await ev('done-session-01', { hook_event_name: 'PostToolBatch' })
  assert.deepEqual(heard, [{ sessionId: 'done-session-01', cwd: '/tmp/w', tools: ['Read', 'Edit'] }])
  await ev('done-session-01', { hook_event_name: 'Stop' })
  assert.equal(heard.length, 1, 'a Stop with nothing since the batch says nothing')
})

test('a Stop ends a batch no PostToolBatch closed, and a failure names its tool', async () => {
  heard.length = 0
  await ev('done-session-02', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} })
  await ev('done-session-02', { hook_event_name: 'Stop' })
  assert.deepEqual(heard.map((e) => e.tools), [['Bash']])
  await ev('done-session-02', { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', error: 'exit 1' })
  assert.deepEqual(heard.map((e) => e.tools), [['Bash'], ['Bash']])
})
