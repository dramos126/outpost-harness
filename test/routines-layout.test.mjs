// A routine's layout (docs/modules/routines.md *Layouts*): where its boxes were dragged to, kept
// in a file beside the routine's and never in it — validated strictly, untouched by a save of the
// routine, deleted with it, and carried by a setup export and import. The store runs for real on
// a temp config and data dir; what reaches Discord or makes workspaces is mocked.
import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-layouts-'))
const CONFIG = path.join(tmp, 'config')
const DATA = path.join(tmp, 'data')
process.env.OUTPOST_DATA = DATA
fs.mkdirSync(CONFIG, { recursive: true })
fs.mkdirSync(DATA, { recursive: true })
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

mock.module('../server/notify/index.mjs', { namedExports: { notify: async () => ({ ok: true }) } })
mock.module('../server/workspaces/catalogue.mjs', { namedExports: { CONFIG_DIR: CONFIG } })
mock.module('../server/workspaces/index.mjs', {
  namedExports: {
    createWorkspace: async () => ({ id: 'w1' }),
    listWorkspaces: async () => [],
    mainHeadOf: async () => 'h',
    markWorkspace: async (id, fields) => ({ id, ...fields }),
    promoteRun: async () => ({ mode: 'acceptEdits', ended: 0 }),
    pendingDeletesOf: async () => [],
    runCommitsOf: async () => [],
    workspaceFor: async () => null,
    DEFAULT_PERMISSION_MODE: 'acceptEdits',
    definingChats: async () => [],
    linkDefiningChat: async () => false,
  },
})

const { deleteRoutine, exportRoutines, flushRoutineWrites, importRoutines, listRoutines, normaliseLayout, readLayout, saveLayout, saveRoutine, withLayouts, LOG_FILE } = await import(
  '../server/state/routines.mjs'
)

const DIR = path.join(CONFIG, 'routines')
const lines = async () => {
  await flushRoutineWrites()
  return fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean).length : 0
}

test('a layout is validated strictly: known box ids, finite bounded numbers, a capped count', () => {
  assert.equal(normaliseLayout(null), null)
  assert.equal(normaliseLayout({}), null)
  assert.deepEqual(normaliseLayout({ trigger: { x: 1.4, y: -2.6 }, gate: { x: 0, y: 0 }, 's:step one': { x: 8, y: 16 }, 'end:needs-you': { x: -500, y: 99999 } }), {
    trigger: { x: 1, y: -3 },
    gate: { x: 0, y: 0 },
    's:step one': { x: 8, y: 16 },
    'end:needs-you': { x: -500, y: 99999 },
  })
  for (const bad of [[], 'x', 5, { trigger: [1, 2] }, { trigger: { x: '1', y: 2 } }, { trigger: { x: NaN, y: 0 } }, { trigger: { x: Infinity, y: 0 } }, { trigger: { x: 0, y: 200000 } }, { trigger: null }]) {
    assert.throws(() => normaliseLayout(bad), undefined, JSON.stringify(bad))
  }
  for (const id of ['__proto__', 'constructor', 's:', 'end:maybe', 'step', 's:a\nb', 's:' + 'x'.repeat(201)]) {
    assert.throws(() => normaliseLayout({ [id]: { x: 0, y: 0 } }), /not a box/, id)
  }
  const many = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`s:${i}`, { x: i, y: i }]))
  assert.throws(() => normaliseLayout(many), /at most 500/)
})

test('a layout is its own file: saved, read back, never a save of the routine, and kept through one', async () => {
  const r = await saveRoutine({ name: 'Nightly', steps: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] })
  const file = path.join(DIR, `${r.id}.json`)
  const before = fs.readFileSync(file, 'utf8')
  const logged = await lines()
  const layout = { 's:a': { x: 300, y: -80 } }
  assert.deepEqual(await saveLayout(r.id, layout), layout)
  assert.deepEqual(await readLayout(r.id), layout)
  assert.ok(fs.existsSync(path.join(DIR, `${r.id}.layout.json`)))
  // The routine's file is not touched and nothing is logged: a drag is not a decision.
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  assert.equal(await lines(), logged)
  // The layout file is not read as a routine.
  assert.deepEqual((await listRoutines()).map((x) => x.id), [r.id])
  assert.deepEqual((await withLayouts(await listRoutines()))[0].layout, layout)
  // A save of the routine — Pause, or a chat's routine_update — writes it whole, and leaves the layout.
  await saveRoutine({ ...r, name: 'Nightly, renamed' })
  assert.deepEqual(await readLayout(r.id), layout)
  // Null removes it; an unknown routine is a 404.
  assert.equal(await saveLayout(r.id, null), null)
  assert.equal(await readLayout(r.id), null)
  assert.ok(!fs.existsSync(path.join(DIR, `${r.id}.layout.json`)))
  await assert.rejects(saveLayout('0badf00d', layout), (err) => err.status === 404)
  await assert.rejects(saveLayout(r.id, { nope: { x: 0, y: 0 } }), /not a box/)
})

test('an unreadable layout file reads as none, and the automatic layout stands', async () => {
  const [r] = await listRoutines()
  fs.writeFileSync(path.join(DIR, `${r.id}.layout.json`), '{ torn')
  assert.equal(await readLayout(r.id), null)
  fs.writeFileSync(path.join(DIR, `${r.id}.layout.json`), JSON.stringify({ trigger: { x: 'a', y: 0 } }))
  assert.equal(await readLayout(r.id), null)
  await saveLayout(r.id, null)
})

test('a deleted routine takes its layout with it', async () => {
  const r = await saveRoutine({ name: 'Gone soon' })
  await saveLayout(r.id, { trigger: { x: 10, y: 10 } })
  await deleteRoutine(r.id)
  assert.ok(!fs.existsSync(path.join(DIR, `${r.id}.layout.json`)))
})

test('an export carries each layout with its routine, and an import replaces them with the routines', async () => {
  const [r] = await listRoutines()
  const other = await saveRoutine({ name: 'Another' })
  await saveLayout(r.id, { 's:b': { x: -16, y: 240 } })
  await saveLayout(other.id, { trigger: { x: 0, y: 0 } })
  const exp = await exportRoutines()
  assert.deepEqual(exp.find((x) => x.id === r.id).layout, { 's:b': { x: -16, y: 240 } })
  // Plain routines in the export stay plain: no `layout: null` on one without.
  await saveLayout(other.id, null)
  assert.ok(!('layout' in (await exportRoutines()).find((x) => x.id === other.id)))
  // An import: the first routine's layout comes back, a bad one is dropped without stopping the
  // import, and a routine the export does not have goes with its layout.
  await saveLayout(r.id, { trigger: { x: 1, y: 1 } })
  await saveLayout(other.id, { trigger: { x: 2, y: 2 } })
  const third = await saveRoutine({ name: 'Third' })
  await saveLayout(third.id, { trigger: { x: 3, y: 3 } })
  const mine = exp.find((x) => x.id === r.id)
  const theirs = { ...exp.find((x) => x.id === other.id), layout: { trigger: { x: 'bad', y: 0 } } }
  const list = await importRoutines({ routines: [mine, theirs] })
  assert.deepEqual(list.map((x) => x.id).sort(), [r.id, other.id].sort())
  assert.deepEqual(await readLayout(r.id), { 's:b': { x: -16, y: 240 } })
  assert.equal(await readLayout(other.id), null)
  assert.ok(!fs.existsSync(path.join(DIR, `${third.id}.layout.json`)))
  assert.ok(!fs.existsSync(path.join(DIR, `${third.id}.json`)))
})
