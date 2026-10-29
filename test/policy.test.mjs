// The policy Outpost writes into a checkout (docs/modules/workspaces.md): its tools as one rule
// for the whole server, and a rewrite that replaces exactly what Outpost wrote before — the
// per-tool rules of an older policy included — and keeps a person's own lines.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-policy-'))
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

const { writePolicy, DEFAULT_DENY } = await import('../server/workspaces/policy.mjs')
const { toolRulesFor } = await import('../server/mcp/index.mjs')

test('a chat’s tools are one allow rule for the server, present tools and future ones alike', () => {
  assert.deepEqual(toolRulesFor(['approval', 'work']), ['mcp__outpost'])
  assert.deepEqual(toolRulesFor(['work', 'github']), ['mcp__outpost'])
  assert.deepEqual(toolRulesFor([]), [])
  assert.deepEqual(toolRulesFor(['no-such-group']), [])
})

test('a rewrite replaces the per-tool rules an older policy carried and keeps what a person wrote', async () => {
  const checkout = path.join(tmp, 'repo')
  const file = path.join(checkout, '.claude', 'settings.local.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // As a policy from before 2026-10-17 was: every tool by name, under Outpost's own key.
  const old = ['mcp__outpost__start_work', 'mcp__outpost__push', 'mcp__outpost__data_publish']
  fs.writeFileSync(
    file,
    JSON.stringify({
      permissions: { allow: ['Bash(make test)', ...old, `Read(//${tmp}/ws/**)`], deny: ['Bash(rm -rf *)', ...DEFAULT_DENY] },
      __outpost: { allow: [`Read(//${tmp}/ws/**)`, ...old], deny: DEFAULT_DENY },
      env: { DISABLE_AUTOUPDATER: '1', MINE: '1' },
    })
  )
  await writePolicy(checkout, { workspaceDir: path.join(tmp, 'ws'), allow: ['mcp__outpost', 'Bash(yarn test)'], deny: ['Bash(git push --force)'] })
  const next = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.ok(next.permissions.allow.includes('mcp__outpost'))
  assert.ok(next.permissions.allow.includes('Bash(make test)'), 'the person’s own allow stays')
  assert.ok(next.permissions.allow.includes('Bash(yarn test)'))
  assert.ok(!next.permissions.allow.some((r) => r.startsWith('mcp__outpost__')), 'the per-tool rules are gone')
  assert.ok(next.permissions.deny.includes('Bash(rm -rf *)'), 'the person’s own deny stays')
  assert.ok(next.permissions.deny.includes('Bash(git push --force)'))
  for (const d of DEFAULT_DENY) assert.ok(next.permissions.deny.includes(d))
  for (const r of ['Read', 'Edit', 'Write']) assert.ok(next.permissions.allow.includes(`${r}(//tmp/**)`), 'the container’s /tmp needs no prompt')
  assert.equal(next.env.MINE, '1')
  assert.deepEqual(next.__outpost.allow.filter((r) => r.startsWith('mcp__')), ['mcp__outpost'])
})
