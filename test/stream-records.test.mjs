// A chat's conversation rebuilt from its own streams when its transcript is gone (launchers.md
// `streamRecords`): chat 2a862bbc worked through seven turns on 2026-10-14 while its page said
// "Nothing said yet". The stream lines here are the shapes that session's `out.jsonl` held.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-stream-'))
process.env.OUTPOST_DATA = path.join(root, 'data')
process.env.OUTPOST_SESSIONS = path.join(root, 'sessions')
fs.mkdirSync(process.env.OUTPOST_DATA)
const sid = '7d91faf0-e3c2-4352-b557-a432461ec6c8'
const dir = path.join(process.env.OUTPOST_SESSIONS, 'a1c51162')
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(
  path.join(process.env.OUTPOST_DATA, 'structured.json'),
  JSON.stringify({ version: 1, sessions: { a1c51162: { id: 'a1c51162', dir, unit: 'outpost-session-a1c51162', sessionId: sid, startedAt: 1 } } })
)

const { streamRecords } = await import('../server/launchers/structured.mjs')
const { messagesOf } = await import('../server/scan.mjs')

const out = path.join(dir, 'out.jsonl')
const sent = path.join(dir, 'sent.jsonl')
const line = (o) => JSON.stringify(o) + '\n'
const size = () => (fs.existsSync(out) ? fs.statSync(out).size : 0)
const send = (id, text) => fs.appendFileSync(sent, line({ id, at: size(), ts: '2026-10-14T14:20:39.000Z', content: [{ type: 'text', text }] }))
const say = (uuid, content, extra = {}) =>
  fs.appendFileSync(out, line({ type: 'assistant', message: { role: 'assistant', content }, parent_tool_use_id: null, session_id: sid, uuid, timestamp: '2026-10-14T14:21:00.000Z', ...extra }))

test('before the CLI has answered, the stream is not taken for a lost transcript', async () => {
  fs.appendFileSync(out, line({ type: 'system', subtype: 'init', session_id: sid }))
  send('p1', 'redesign the settings page')
  const r = await streamRecords(sid)
  assert.equal(r.answered, false)
  assert.equal(r.records.length, 1, 'the typed message is there all the same')
})

test('the typed message, the answer and the tool traffic come back in order; deltas and subagents do not', async () => {
  fs.appendFileSync(out, line({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Here' } } }))
  say('a1', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/x/settings.tsx' } }])
  fs.appendFileSync(out, line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file text' }] }, parent_tool_use_id: null, session_id: sid, uuid: 'u1', timestamp: '2026-10-14T14:21:01.000Z' }))
  say('s1', [{ type: 'text', text: 'a subagent talking' }], { parent_tool_use_id: 'tu0' })
  say('a2', [{ type: 'text', text: "Here's the final plan" }])
  fs.appendFileSync(out, line({ type: 'result', subtype: 'success', result: "Here's the final plan" }))
  const r = await streamRecords(sid)
  assert.equal(r.answered, true)
  const items = messagesOf('claude-code', r.records)
  assert.deepEqual(
    items.map((m) => [m.kind, m.role || '', m.text || m.name || '']),
    [
      ['text', 'user', 'redesign the settings page'],
      ['tool', 'assistant', 'Read'],
      ['tool_result', '', 'file text'],
      ['text', 'assistant', "Here's the final plan"],
    ]
  )
})

test('a tail read from the last offset brings only what is new, a message sent mid-stream in its place', async () => {
  const { offset } = await streamRecords(sid)
  assert.deepEqual((await streamRecords(sid, offset)).records, [], 'nothing new, nothing again')
  send('p2', 'yes, start')
  say('a3', [{ type: 'text', text: 'Starting.' }])
  const next = await streamRecords(sid, offset)
  assert.deepEqual(
    messagesOf('claude-code', next.records).map((m) => m.text),
    ['yes, start', 'Starting.']
  )
  assert.ok(next.offset > offset)
})

test('a line still being written waits for its end', async () => {
  const { offset } = await streamRecords(sid)
  const whole = line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }, parent_tool_use_id: null, session_id: sid, uuid: 'a4', timestamp: '2026-10-14T14:30:00.000Z' })
  fs.appendFileSync(out, whole.slice(0, 40))
  assert.deepEqual((await streamRecords(sid, offset)).records, [])
  fs.appendFileSync(out, whole.slice(40))
  assert.deepEqual(messagesOf('claude-code', (await streamRecords(sid, offset)).records).map((m) => m.text), ['Done.'])
})

test('a session this launcher never ran has no streams', async () => {
  assert.equal(await streamRecords('00000000-0000-0000-0000-000000000000'), null)
})
