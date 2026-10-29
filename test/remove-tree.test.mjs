// A workspace delete removes a folder a session left read-only, and never follows a link out of
// it (docs/modules/workspaces.md): 398a976d's test left `temp/hard/cfg` mode 0555 holding a
// link to the owner's credentials file, and every delete stopped there with EACCES.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-rmtree-'))
process.env.OUTPOST_DATA = path.join(root, 'data')
process.env.OUTPOST_WORKSPACES = path.join(root, 'workspaces')
fs.mkdirSync(process.env.OUTPOST_DATA)
const { removeTree } = await import('../server/workspaces/index.mjs')

test('a read-only folder is removed, and the file a link inside it names is left as it was', async () => {
  const outside = path.join(root, 'credentials.json')
  fs.writeFileSync(outside, 'secret')
  fs.chmodSync(outside, 0o400)
  const ws = path.join(root, 'ws')
  const cfg = path.join(ws, 'outpost', 'temp', 'hard', 'cfg')
  fs.mkdirSync(path.join(cfg, 'sessions'), { recursive: true })
  fs.writeFileSync(path.join(cfg, '.claude.json'), '{}')
  fs.chmodSync(path.join(cfg, '.claude.json'), 0o444)
  fs.symlinkSync(outside, path.join(cfg, '.credentials.json'))
  fs.chmodSync(cfg, 0o555)
  await removeTree(ws)
  assert.equal(fs.existsSync(ws), false)
  assert.equal(fs.readFileSync(outside, 'utf8'), 'secret')
  assert.equal(fs.statSync(outside).mode & 0o777, 0o400, 'the link was not followed')
})

test('a folder that is not there is not an error', async () => {
  await removeTree(path.join(root, 'never-made'))
})
