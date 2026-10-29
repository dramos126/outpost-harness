// The scripts the owner's command hooks run are handed to a chat's container read-only, and
// nothing a hook names under ~/.ssh, ~/.aws or the secret store ever is (launchers.md, The
// container; concurrency.md). A temp home with a settings.json in it.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-hooks-')))
process.env.OUTPOST_DATA = path.join(home, 'data')
process.env.OUTPOST_SECRETS = path.join(home, '.outpost', 'secrets')
after(() => fs.rmSync(home, { recursive: true, force: true }))

const { hookScripts } = await import('../server/containers/index.mjs')

const file = (rel, text = '') => {
  const p = path.join(home, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text)
  return p
}
const guard = file('projects/outpost/scripts/guard-git.mjs')
const claims = file('projects/outpost/scripts/claims.mjs')
const key = file('.ssh/steal.sh')
const secret = file('.outpost/secrets/peek.mjs')
const aws = file('.aws/peek.py')
fs.symlinkSync(guard, path.join(home, 'link.mjs'))
const settings = file('.claude/settings.json', JSON.stringify({
  hooks: {
    PreToolUse: [
      { hooks: [{ type: 'http', url: 'http://127.0.0.1:5274/api/hook' }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: `node ${guard}` }, { type: 'command', command: `sh '${key}'` }] },
    ],
    PostToolUse: [{ hooks: [{ type: 'command', command: `node "${claims}" record` }, { type: 'command', command: `node ${claims} check` }] }],
    Stop: [{ hooks: [`python3 ${aws}`, `node ${secret}`, `node ${path.join(home, 'link.mjs')}`, `node ${path.join(home, 'gone.mjs')}`].map((command) => ({ type: 'command', command })) }],
    SessionStart: [{ hooks: [{ type: 'command', command: `curl -sS --data-binary @- http://127.0.0.1:5274/api/hook ${path.join(home, '.claude', 'settings.json')}` }] }],
  },
}))

test("each command hook's script is named once; data, links, missing files and fenced folders are not", async () => {
  assert.deepEqual(await hookScripts(settings, home), [claims, guard].sort())
})

// The guard those mounts carry in (concurrency.md): what it refuses, run as the hook runs it.
const GUARD = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'guard-git.mjs')
const guarded = (command) => {
  const out = execFileSync('node', [GUARD], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8' })
  return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'allow'
}

test('the guard refuses a bulk add and a worktree prune, and lets a worktree remove and a narrow add through', () => {
  assert.equal(guarded('git add -A'), 'deny')
  assert.equal(guarded('git worktree prune'), 'deny')
  assert.equal(guarded('git worktree remove --force /tmp/x/head && git worktree prune'), 'deny')
  assert.equal(guarded('git worktree remove --force /tmp/x/head'), 'allow')
  assert.equal(guarded('git add src/a.js'), 'allow')
})

test('settings that will not parse, or are not there, name no scripts', async () => {
  assert.deepEqual(await hookScripts(file('bad.json', '{'), home), [])
  assert.deepEqual(await hookScripts(path.join(home, 'none.json'), home), [])
})
