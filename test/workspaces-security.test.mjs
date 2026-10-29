// The guards on what a chat's own files can make the host do (docs/modules/workspaces-data.md,
// docs/modules/workspaces.md). Everything runs under a temporary folder.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-test-'))
process.env.OUTPOST_DATA = tmp
process.env.OUTPOST_DATASETS = path.join(tmp, 'datasets')
process.env.OUTPOST_WORKSPACES = path.join(tmp, 'workspaces')
process.env.OUTPOST_CONFIG = path.join(tmp, 'config')
process.env.HOME = tmp

// One ready chat with no repos, for addRepo.
fs.mkdirSync(path.join(tmp, 'workspaces', 'w1'), { recursive: true })
fs.writeFileSync(path.join(tmp, 'workspaces', 'w1', 'workspace.json'), JSON.stringify({ id: 'w1', status: 'ready', repos: [], tools: [] }))

const { execConfined, checkConfined, scrubPathIn } = await import('../server/workspaces/datasets.mjs')
const { addRepo, isLocalAddress } = await import('../server/workspaces/index.mjs')

function copy() {
  const db = new DatabaseSync(path.join(fs.mkdtempSync(path.join(tmp, 'db-')), 'copy.db'))
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT, secret TEXT); INSERT INTO users(email, secret) VALUES ('a@x', 's1'), ('b@x', 's2')`)
  return db
}

test('a scrub script that updates, deletes, creates and drops on the copy still runs', () => {
  const db = copy()
  execConfined(db, `-- scrub
    UPDATE users SET email = 'user' || id || '@example.invalid';
    /* the secret goes */ UPDATE users SET secret = NULL;;
    CREATE TABLE scratch(a); INSERT INTO scratch VALUES (1); DROP TABLE scratch;
    DELETE FROM users WHERE id = 2;
    CREATE TRIGGER t AFTER INSERT ON users BEGIN UPDATE users SET secret = NULL WHERE id = new.id; END;
    -- trailing comment`)
  assert.deepEqual(db.prepare('SELECT email, secret FROM users').all().map((r) => ({ ...r })), [{ email: 'user1@example.invalid', secret: null }])
  assert.equal(checkConfined(db, 'SELECT COUNT(*) FROM users WHERE secret IS NOT NULL'), 0)
  db.exec('VACUUM')
})

test('ATTACH, DETACH and VACUUM INTO are refused, however written, and nothing after them runs', () => {
  const outside = path.join(tmp, 'outside.db')
  new DatabaseSync(outside).close()
  for (const bad of [
    `ATTACH '${outside}' AS o`,
    `attach   database '${outside}' as o`,
    `/* hi */ AtTaCh "${outside}" AS o`,
    `DETACH main`,
    `VACUUM INTO '${path.join(tmp, 'stolen.db')}'`,
    `vacuum main into '${path.join(tmp, 'stolen.db')}'`,
  ]) {
    const db = copy()
    assert.throws(() => execConfined(db, `UPDATE users SET secret = NULL; ${bad}; DELETE FROM users`), /reaches a file other than the copy/, bad)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 2, 'statements after the refused one never ran')
    assert.throws(() => checkConfined(db, bad), /reaches a file other than the copy/)
  }
  assert.ok(!fs.existsSync(path.join(tmp, 'stolen.db')))
})

test('the scrub script is read only from inside the checkout, links followed', async () => {
  const checkout = fs.mkdtempSync(path.join(tmp, 'checkout-'))
  fs.mkdirSync(path.join(checkout, '.outpost'))
  fs.writeFileSync(path.join(checkout, '.outpost', 'scrub.sql'), 'SELECT 1')
  fs.writeFileSync(path.join(tmp, 'secret.sql'), 'SELECT 1')
  fs.symlinkSync(path.join(tmp, 'secret.sql'), path.join(checkout, '.outpost', 'link.sql'))
  assert.equal(await scrubPathIn(checkout, '.outpost/scrub.sql'), path.join(fs.realpathSync(checkout), '.outpost', 'scrub.sql'))
  assert.equal(await scrubPathIn(checkout, '.outpost/missing.sql'), null)
  await assert.rejects(scrubPathIn(checkout, '.outpost/link.sql'), /inside the repo/)
  await assert.rejects(scrubPathIn(checkout, '../secret.sql'), /inside the repo/)
})

test('a local path or file:// is a local address; a remote one is not', () => {
  for (const s of ['/home/me/.outpost/repos/x.git', 'file:///home/me/x', 'FILE:///x', ' /x']) assert.ok(isLocalAddress(s), s)
  for (const s of ['https://github.com/a/b.git', 'ssh://git@host/a/b', 'git@github.com:a/b.git', 'git://host/a']) assert.ok(!isLocalAddress(s), s)
})

test('the add_repo tool (no notify) may not add a repo on this machine; the page (notify) still may', async () => {
  for (const repo of ['/etc', 'file:///etc']) {
    await assert.rejects(addRepo('w1', { repo }), /added by a person/)
    // Past the guard: whatever fails next (here, the clone of a non-repo) is not the refusal.
    await assert.rejects(addRepo('w1', { repo, notify: true }), (err) => !/added by a person/.test(err.message))
  }
})

test('a permission mode the page does not offer falls back to the default, never reaching the CLI', async () => {
  const { permissionModeFor } = await import('../server/workspaces/index.mjs')
  // What the selects offer keeps working, spec first, then the repo's, then the caller's default.
  for (const mode of ['default', 'acceptEdits', 'plan', 'dontAsk']) {
    assert.equal(permissionModeFor({ permissionMode: mode }, { permissionMode: 'plan' }, 'acceptEdits'), mode)
    assert.equal(permissionModeFor({ permissionMode: '' }, { permissionMode: mode }, 'acceptEdits'), mode)
  }
  assert.equal(permissionModeFor({}, { permissionMode: '' }, 'dontAsk'), 'dontAsk')
  assert.equal(permissionModeFor({}, undefined, 'acceptEdits'), 'acceptEdits')
  // The owner's own default (OUTPOST_PERMISSION_MODE) may be any mode the CLI takes.
  assert.equal(permissionModeFor({}, undefined, 'bypassPermissions'), 'bypassPermissions')
  for (const bad of ['--dangerously-skip-permissions', 'bypassPermissions', 'nonsense', 'plan --x']) {
    assert.equal(permissionModeFor({ permissionMode: bad }, { permissionMode: '' }, 'acceptEdits'), 'acceptEdits', bad)
    assert.equal(permissionModeFor({ permissionMode: bad }, { permissionMode: 'plan' }, 'acceptEdits'), 'plan', bad)
  }
  assert.equal(permissionModeFor({}, undefined, '--bad'), 'acceptEdits')
})

test("a session's unit environment keeps variable names and one-line values, and leaves out the rest", async () => {
  const { unitEnvOf } = await import('../server/launchers/structured.mjs')
  const ok = { DISABLE_AUTOUPDATER: '1', MCP_TOOL_TIMEOUT: '630000', _X1: 'a b=c', EMPTY: '' }
  assert.deepEqual(unitEnvOf(ok), ok)
  assert.deepEqual(unitEnvOf({ ...ok, 'A\nExecStartPre=/bin/x': '1', '-p': 'x', 'B=C': 'x', BAD: 'one\nExecStartPre=/bin/x', NUL: 'a\0b' }), ok)
})
