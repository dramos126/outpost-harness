// `chats_digest` (docs/modules/routines.md, *The digest*): what a routine's run reads about the
// day. Inputs and final replies only, never a tool's result; routine runs left out; capped and
// saying so.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-digest-'))
process.env.OUTPOST_DATA = tmp
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

const { buildDigest, activityOf } = await import('../server/state/digest.mjs')

const since = Date.parse('2026-10-15T00:00:00Z')
const at = (h) => since + h * 3600_000
const tool = (ts, name, input) => ({ ts, kind: 'tool', role: 'assistant', name, summary: input.file_path || input.command || '', detail: JSON.stringify(input) })
const say = (ts, role, text) => ({ ts, kind: 'text', role, text })

const items = [
  say(at(-2), 'user', 'yesterday'),
  tool(at(-2), 'Bash', { command: 'rm -rf old' }),
  say(at(-2), 'assistant', 'Done yesterday.'),
  say(at(1), 'user', 'move wiki to the new VM'),
  tool(at(1), 'Bash', { command: 'podman ps\n--all' }),
  { ts: at(1), kind: 'tool_result', text: 'SECRET_RESULT wiki up' },
  tool(at(1), 'Edit', { file_path: 'stacks/wiki/compose.yml', old_string: 'a', new_string: 'b' }),
  tool(at(1), 'mcp__outpost__host_run', { host: 'box-1', action: 'restart', token: 'ghp_abcdefghijklmnopqrstuvwxyz123456' }),
  say(at(1), 'assistant', 'Working on it.'),
  say(at(1), 'assistant', 'Moved wiki to vm-2.'),
]

test('commands, edits and final replies since the time; never a result, and secrets scrubbed', () => {
  const a = activityOf(items, since)
  assert.deepEqual(a.commands[0], 'podman ps ⏎ --all')
  assert.match(a.commands[1], /^host_run /)
  assert.doesNotMatch(a.commands[1], /ghp_/)
  assert.deepEqual(a.files, ['stacks/wiki/compose.yml'])
  assert.deepEqual(a.replies, ['Moved wiki to vm-2.'])
  assert.ok(!a.commands.some((c) => c.includes('rm -rf old')))
  assert.ok(!JSON.stringify(a).includes('SECRET_RESULT'))
})

const thread = (id, title, last, extra = {}) => ({ id, title, lastActivityAt: last, workspace: { id, name: title, repos: [{ id: 'stacks', name: 'stacks' }] }, ...extra })

test('chats active since, newest first; routine runs, hidden or promoted, left out', async () => {
  const text = await buildDigest({
    since,
    now: at(20),
    threads: [thread('a', 'Wiki move', at(2)), thread('b', 'Old chat', at(-5)), thread('r', 'Docs · run', at(3), { workspace: { id: 'r', hidden: true, repos: [] } }), thread('p', 'Docs · promoted', at(4), { routine: { id: 'x' } }), thread('c', 'Tiny', at(5))],
    read: async (t) => ({ items: t.id === 'a' ? items : [say(at(5), 'assistant', 'hi')], from: 0 }),
    commits: async (id) => (id === 'a' ? [{ repo: 'stacks', sha: 'abcdef1234567', subject: 'wiki: new VM', pushed: false }] : []),
    maxBytes: 24_000,
  })
  assert.match(text, /active since 2026-10-15 00:00Z .*: 2\./)
  assert.ok(text.indexOf('## Tiny') < text.indexOf('## Wiki move'))
  assert.doesNotMatch(text, /Old chat|Docs ·/)
  assert.match(text, /Commits: stacks abcdef12 "wiki: new VM" \(not pushed\)/)
  assert.match(text, /- podman ps/)
  assert.match(text, /Files edited: stacks\/wiki\/compose.yml/)
  assert.match(text, /> Moved wiki to vm-2\./)
  assert.doesNotMatch(text, /SECRET_RESULT/)
})

test('cut at its cap, naming the chats left out and how to see them', async () => {
  const many = Array.from({ length: 30 }, (_, i) => thread(`t${i}`, `Chat ${i}`, at(1 + i / 100)))
  const text = await buildDigest({ since, threads: many, read: async () => ({ items, from: 0 }), commits: async () => [], maxBytes: 2000 })
  assert.ok(Buffer.byteLength(text) < 2600)
  assert.match(text, /…\(cut at 2000 bytes: \d+ older chats not shown — .*max_bytes/)
})

test('a quiet day says so, and a chat read only in part says from when', async () => {
  assert.match(await buildDigest({ since, threads: [], read: async () => ({ items: [] }), commits: async () => [], maxBytes: 1000 }), /Nothing happened/)
  const text = await buildDigest({ since, threads: [thread('a', 'Long', at(2))], read: async () => ({ items, from: at(1) }), commits: async () => [], maxBytes: 24_000 })
  assert.match(text, /Only its transcript since 2026-10-15 01:00Z was read/)
})
