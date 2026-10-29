// What a chat may do to routines, and what only a routine's run may do (docs/modules/routines.md).
// Whose routine a chat is changing is kept on it and said on the approval card; a run nobody
// watches cannot make one; `routine_step` and `routine_end` reach only a token granted the
// `routine` group. The real store and MCP handler run in-process on a temp dir; the approval
// is mocked to say yes and record what it was asked.
import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-routine-sec-'))
process.env.OUTPOST_DATA = path.join(tmp, 'data')
process.env.OUTPOST_CONFIG = path.join(tmp, 'config')
process.env.OUTPOST_SESSIONS = path.join(tmp, 'sessions')
process.env.OUTPOST_WORKSPACES = path.join(tmp, 'workspaces')

const asked = []
const structured = await import('../server/launchers/structured.mjs')
mock.module('../server/launchers/structured.mjs', {
  namedExports: { ...structured, awaitApproval: async (_ws, req) => (asked.push(req.input), { behavior: 'allow' }) },
})

const { listRoutines, getRoutine, saveRoutine, deleteRoutine, normalise, stepRun, endRun } = await import('../server/state/routines.mjs')
const { configureMcp, handleMcp, mintMcpToken } = await import('../server/mcp/index.mjs')

const unattended = new Set(['wsRun'])
/** Defining chats (routines.md): workspace → the routine it defines. */
const defining = new Map()
const stepped = []
const ended = []
configureMcp({
  roster: async () => ({ threads: [] }),
  routineContextFor: async (id) => ({ unattended: unattended.has(id), repos: [], model: '', defines: defining.get(id) || null }),
  routines: {
    list: listRoutines,
    get: getRoutine,
    save: saveRoutine,
    remove: deleteRoutine,
    check: (r) => ({ ...normalise(r), ...(r.id ? {} : { id: undefined }) }),
    step: async (ws, a) => stepped.push({ ws, ...a }),
    end: async (ws, a) => ended.push({ ws, ...a }),
  },
})

const server = http.createServer(handleMcp)
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const { port } = server.address()
after(() => {
  server.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

async function call(token, name, args) {
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  return r.json()
}

const tokenA = await mintMcpToken('wsA', ['work'])
const tokenB = await mintMcpToken('wsB', ['work'])
const tokenRun = await mintMcpToken('wsRun', ['work', 'routine'])
const draft = { name: 'nightly', prompt: 'check things', cron: '0 3 * * *', tz: 'UTC' }

test('a routine records who made it, and a page save of a chat-made one keeps it', async () => {
  asked.length = 0
  await call(tokenA, 'routine_create', { ...draft, steps: [{ title: 'Read' }, { title: 'Write', detail: 'the docs' }] })
  const r = (await listRoutines()).find((x) => x.name === 'nightly')
  assert.deepEqual(r.createdBy, { workspaceId: 'wsA' })
  assert.equal(r.permissionMode, 'dontAsk')
  // The card is a routine's, with its steps drawn, each with where it goes next.
  assert.equal(asked[0].card.kind, 'routine')
  assert.deepEqual(asked[0].card.steps, [
    { id: 's1', title: 'Read', next: [{ to: 's2' }] },
    { id: 's2', title: 'Write', detail: 'the docs', next: [{ to: 'end:done' }] },
  ])
  // The page sends the routine back without (or with a forged) createdBy: the maker stays.
  await saveRoutine({ ...r, createdBy: 'page', prompt: 'check more' })
  assert.deepEqual((await getRoutine(r.id)).createdBy, { workspaceId: 'wsA' })
  const page = await saveRoutine({ name: 'from page', prompt: 'p', triggers: [{ cron: '0 4 * * *', tz: 'UTC' }] })
  assert.equal(page.createdBy, 'page')
})

test('the card says so when a chat changes or deletes a routine it did not make; its own reads plainly', async () => {
  const r = (await listRoutines()).find((x) => x.name === 'nightly')
  asked.length = 0
  await call(tokenA, 'routine_update', { id: r.id, prompt: 'own change' })
  assert.equal(asked[0].card.madeBy, 'Made by this chat')
  assert.doesNotMatch(asked[0].question, /not/)

  asked.length = 0
  const res = await call(tokenB, 'routine_update', { id: r.id, prompt: 'someone else', gate: [] })
  assert.equal(asked[0].card.madeBy, 'Made by another chat, not this one')
  assert.match(asked[0].question, /made by another chat/)
  assert.ok(asked[0].card.changes.some((c) => c.field === 'gate'))
  // Still allowed: the person said yes, knowing.
  assert.match(JSON.stringify(res), /Changed/)
  assert.deepEqual((await getRoutine(r.id)).gate, { kind: 'activity', repos: [] })

  const page = (await listRoutines()).find((x) => x.name === 'from page')
  asked.length = 0
  await call(tokenB, 'routine_delete', { id: page.id })
  assert.equal(asked[0].card.madeBy, 'Made on the page, not by this chat')
  assert.match(asked[0].question, /made on the page/)
  assert.equal(await getRoutine(page.id), null)
})

test('a chat made to change a routine reads as where it is defined, whoever made it', async () => {
  const r = await saveRoutine({ name: 'defined elsewhere', prompt: 'p', triggers: [{ cron: '0 5 * * *', tz: 'UTC' }] })
  defining.set('wsB', r.id)
  asked.length = 0
  await call(tokenB, 'routine_update', { id: r.id, prompt: 'changed' })
  assert.equal(asked[0].card.madeBy, 'Defined in this chat')
  assert.doesNotMatch(asked[0].question, /not/)
  defining.delete('wsB')
})

test('a run nobody watches cannot make or change a routine, and nothing is asked', async () => {
  asked.length = 0
  const res = await call(tokenRun, 'routine_create', { ...draft, name: 'from a run' })
  assert.match(JSON.stringify(res), /nobody watching cannot make or change routines/)
  assert.equal(asked.length, 0)
  assert.equal((await listRoutines()).some((x) => x.name === 'from a run'), false)
})

test('routine_step and routine_end reach only a run granted them', async () => {
  for (const name of ['routine_step', 'routine_end']) {
    const res = await call(tokenA, name, { step: 's1', status: 'done', outcome: 'done', text: 'x' })
    assert.match(JSON.stringify(res), /Unknown tool/)
  }
  await call(tokenRun, 'routine_step', { step: 's1', status: 'started' })
  await call(tokenRun, 'routine_end', { outcome: 'needs-you', text: 'Which one?' })
  assert.deepEqual(stepped, [{ ws: 'wsRun', step: 's1', status: 'started' }])
  assert.deepEqual(ended, [{ ws: 'wsRun', outcome: 'needs-you', text: 'Which one?' }])
})

test('a run’s ending is its own: the store refuses a chat that is not a run', async () => {
  await assert.rejects(endRun('wsA', { outcome: 'done', text: 'x' }), /not a routine's run/)
  await assert.rejects(stepRun('wsA', { step: 's1', status: 'done' }), /not a routine's run/)
})

test('/createRoutine is an Outpost command with a lead and no doc; the person’s words follow it', async () => {
  const { outpostCommandText } = await import('../server/outpost-commands.mjs')
  const text = await outpostCommandText('createRoutine', '/createRoutine every night at 11')
  assert.match(text, /^<system-reminder>The person sent \/createRoutine: .*routine_create.*<\/system-reminder>\n\n\/createRoutine every night at 11$/s)
  assert.equal(await outpostCommandText('nope', 'x'), null)
})

test('/securityAudit copies the vendored skill into the workspace, whole, and points the session at it', async () => {
  const { commandNeedsWorkspace, outpostCommandText } = await import('../server/outpost-commands.mjs')
  assert.equal(commandNeedsWorkspace('securityAudit'), true)
  assert.equal(commandNeedsWorkspace('leanOut'), false)
  assert.equal(commandNeedsWorkspace('toString'), false, 'a name off the prototype is no command')
  const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'outpost-audit-'))
  try {
    // A file left by an earlier copy is gone after the next: the copy is replaced, not merged.
    await fsp.mkdir(path.join(ws, 'security-audit', 'skill'), { recursive: true })
    await fsp.writeFile(path.join(ws, 'security-audit', 'skill', 'STALE.md'), 'old')
    const text = await outpostCommandText('securityAudit', '/securityAudit quick, server/ only', { workspaceDir: ws })
    const dir = path.join(ws, 'security-audit')
    assert.ok(text.includes(`${dir}/skill/SKILL.md`), 'the lead names the copy')
    assert.ok(text.includes(`${dir}/runs/`), 'and where the run goes')
    assert.ok(!text.includes('{dir}'))
    assert.match(text, /<\/system-reminder>\n\n\/securityAudit quick, server\/ only$/)
    assert.ok((await fsp.stat(path.join(dir, 'skill', 'SKILL.md'))).isFile())
    assert.ok((await fsp.stat(path.join(dir, 'skill', 'validate-findings.cjs'))).isFile())
    assert.equal(await fsp.stat(path.join(dir, 'skill', 'STALE.md')).catch(() => null), null)
  } finally {
    await fsp.rm(ws, { recursive: true, force: true })
  }
})

test("routine_list's needs-you says whether the run's chat still waits, by the page's rule", async () => {
  const { runChatWaits } = await import('../server/mcp/index.mjs')
  const run = (fields, answered = false) => ({ routine: { id: 'r', runId: 'x', answered }, ...fields })
  assert.equal(runChatWaits([run({ done: true })], 'x'), true, 'come back and not opened')
  assert.equal(runChatWaits([run({ unread: true }, true)], 'x'), true, 'asking again after a reply')
  assert.equal(runChatWaits([run({ done: false })], 'x'), false, 'opened')
  assert.equal(runChatWaits([run({ done: true }, true)], 'x'), false, 'written in')
  assert.equal(runChatWaits([run({ done: true, archived: true })], 'x'), false, 'archived')
  assert.equal(runChatWaits([run({ done: true })], 'y'), false, 'another run')
  assert.equal(runChatWaits([], 'x'), false, 'its chat gone')
})
