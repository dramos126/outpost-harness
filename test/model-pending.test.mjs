// A model change is pending until the session answers after it (launchers.md `modelPending`):
// the thread's model is read off its last answer, so nothing else says a change is coming.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-model-'))
process.env.OUTPOST_DATA = path.join(root, 'data')
process.env.OUTPOST_SESSIONS = path.join(root, 'sessions')

const { modelPending } = await import('../server/launchers/index.mjs')
const { withModel } = await import('../server/launchers/structured.mjs')

test('a model change is written into the arguments a restart starts from', () => {
  const launched = ['--permission-mode', 'default', '--model', 'opus', '--add-dir', '/w/repo']
  assert.deepEqual(withModel(launched, 'sonnet'), ['--permission-mode', 'default', '--add-dir', '/w/repo', '--model', 'sonnet'])
  // Default is the CLI's configured model, which has no flag of its own.
  assert.deepEqual(withModel(launched, 'default'), ['--permission-mode', 'default', '--add-dir', '/w/repo'])
  assert.deepEqual(withModel(undefined, 'haiku'), ['--model', 'haiku'])
})

test('a change is pending until the first answer after it, whatever model that answer names', () => {
  const at = 1_000_000
  const sonnet = { model: 'claude-sonnet-4-5', contextAt: at - 5000 }
  assert.equal(modelPending(sonnet, { model: 'opus', at }), 'opus')
  // Answered since on the new model: settled.
  assert.equal(modelPending({ model: 'claude-opus-4-1', contextAt: at + 5000 }, { model: 'opus', at }), '')
  // Answered since on the old one: the change did not take, and the button says what it runs on.
  assert.equal(modelPending({ ...sonnet, contextAt: at + 5000 }, { model: 'opus', at }), '')
})

test('an alias the session already names is not pending, and default always waits for an answer', () => {
  const at = 1_000_000
  assert.equal(modelPending({ model: 'claude-opus-4-1', contextAt: at - 1 }, { model: 'opus', at }), '')
  assert.equal(modelPending({ model: 'claude-opus-4-1', contextAt: at - 1 }, { model: 'default', at }), 'default')
  assert.equal(modelPending({ model: '', contextAt: 0 }, { model: 'haiku', at }), 'haiku')
})

test('nothing asked is nothing pending', () => {
  assert.equal(modelPending({ model: 'claude-opus-4-1', contextAt: 0 }, undefined), '')
  assert.equal(modelPending({ model: 'claude-opus-4-1', contextAt: 0 }, { model: '', at: 1 }), '')
})
