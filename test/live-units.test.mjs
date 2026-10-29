// The roster's liveness check (launchers.md `isLive`): one `systemctl list-units` answers every
// record, where `is-active` per record on every scan held a core busy (2026-10-15).
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as childProcess from 'node:child_process'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-live-'))
process.env.OUTPOST_DATA = path.join(root, 'data')
process.env.OUTPOST_SESSIONS = path.join(root, 'sessions')
fs.mkdirSync(process.env.OUTPOST_DATA)

const calls = []
let listing = 'outpost-session-aaaa0001.service loaded active running x\noutpost-session-aaaa0002.service loaded active running y\n'
let listFails = false
mock.module('node:child_process', {
  namedExports: {
    ...childProcess,
    execFile: (cmd, args, _opts, cb) => {
      calls.push([cmd, ...args].join(' '))
      if (args[1] === 'list-units') return listFails ? cb(new Error('no bus')) : cb(null, { stdout: listing, stderr: '' })
      if (args[1] === 'is-active') return cb(null, { stdout: args[2] === 'outpost-session-aaaa0003' ? 'active\n' : 'inactive\n', stderr: '' })
      return cb(null, { stdout: '', stderr: '' })
    },
  },
})

const { isLive, isAlive, kill } = await import('../server/launchers/structured.mjs')
const rec = (id) => ({ id, unit: `outpost-session-${id}`, workspaceId: '' })

test('one read answers every record, and only the running ones are live', async () => {
  calls.length = 0
  const answers = await Promise.all(['aaaa0001', 'aaaa0002', 'aaaa0003', 'aaaa0004'].map((id) => isLive(rec(id))))
  assert.deepEqual(answers, [true, true, false, false])
  assert.equal(calls.filter((c) => c.includes('list-units')).length, 1)
  assert.equal(calls.filter((c) => c.includes('is-active')).length, 0)
})

test('a stop drops the snapshot: the next answer is read again', async () => {
  await isLive(rec('aaaa0001'))
  listing = ''
  calls.length = 0
  await kill(rec('aaaa0001')).catch(() => {})
  assert.equal(await isLive(rec('aaaa0001')), false)
  assert.ok(calls.some((c) => c.includes('list-units')))
})

test('a listing that fails falls back to asking the unit itself; isAlive always does', async () => {
  listFails = true
  await new Promise((r) => setTimeout(r, 1100))
  calls.length = 0
  assert.equal(await isLive(rec('aaaa0003')), true)
  assert.ok(calls.some((c) => c.includes('is-active outpost-session-aaaa0003')))
  listFails = false
  calls.length = 0
  assert.equal(await isAlive(rec('aaaa0003')), true)
  assert.deepEqual(calls.filter((c) => c.includes('list-units')), [])
})
