// A setup import goes through the repo page's checks (docs/modules/setup.md): a locked variable
// changes only with the owner's password, and the owner's own export imports as ever. The
// server runs as a child process with a password set and all of its state in a temp directory.
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-import-'))
const TOKEN = 'import-test-token'
const PASSWORD = 'correct horse battery'
process.env.OUTPOST_AUTH = path.join(tmp, 'auth.json')

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

let child
let port
let output = ''

before(async () => {
  const { setPassword } = await import('../server/credentials.mjs')
  await setPassword('owner', PASSWORD)
  port = await freePort()
  const home = path.join(tmp, 'home')
  fs.mkdirSync(home)
  child = spawn(process.execPath, [path.join(root, 'server', 'serve.mjs')], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      OUTPOST_DATA: path.join(tmp, 'data'),
      OUTPOST_CONFIG: path.join(tmp, 'config'),
      OUTPOST_WORKSPACES: path.join(tmp, 'workspaces'),
      OUTPOST_MIRRORS: path.join(tmp, 'mirrors'),
      OUTPOST_SECRETS: path.join(tmp, 'secrets'),
      OUTPOST_SESSIONS: path.join(tmp, 'sessions'),
      OUTPOST_AUTH: process.env.OUTPOST_AUTH,
      OUTPOST_NOTIFY: path.join(tmp, 'no-notify.json'),
      OUTPOST_TOKEN: TOKEN,
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => (output += d))
  child.stderr.on('data', (d) => (output += d))
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 15000)
    child.stdout.on('data', () => output.includes('Outpost →') && (clearTimeout(t), resolve()))
    child.on('exit', (code) => reject(new Error(`server exited ${code}:\n${output}`)))
  })
})

after(() => {
  child?.kill()
  fs.rmSync(tmp, { recursive: true, force: true })
})

async function api(method, p, body) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: r.status, json: await r.json() }
}

const fooOf = async () => (await api('GET', '/api/setup/export')).json.catalogue.repos.find((r) => r.id === 'r1')?.env?.find((e) => e.name === 'FOO')

test('the owner’s own export imports with no password, locked variables and all', async () => {
  const put = await api('PUT', '/api/catalogue', { name: 'r1', url: 'https://example.invalid/r1.git', env: [{ name: 'FOO', value: 'bar', locked: true }] })
  assert.equal(put.json.ok, true, JSON.stringify(put.json))
  const exp = (await api('GET', '/api/setup/export')).json
  const r = await api('POST', '/api/setup/import', exp)
  assert.equal(r.json.ok, true, JSON.stringify(r.json))
  assert.equal((await fooOf()).value, 'bar')
})

test('an import that changes a locked variable is refused without the password, and changes nothing', async () => {
  const exp = (await api('GET', '/api/setup/export')).json
  exp.catalogue.repos.find((r) => r.id === 'r1').env.find((e) => e.name === 'FOO').value = 'evil'
  exp.catalogue.repos.push({ name: 'r2', url: 'https://example.invalid/r2.git', env: [] })
  const r = await api('POST', '/api/setup/import', exp)
  assert.equal(r.status, 403)
  assert.match(r.json.error, /locked variable \(FOO\)/)
  assert.equal((await fooOf()).value, 'bar')
  assert.equal((await api('GET', '/api/setup/export')).json.catalogue.repos.length, 1)
  const wrong = await api('POST', '/api/setup/import', { ...exp, password: 'nope' })
  assert.equal(wrong.status, 403)
  const ok = await api('POST', '/api/setup/import', { ...exp, password: PASSWORD })
  assert.equal(ok.json.ok, true, JSON.stringify(ok.json))
  assert.equal((await fooOf()).value, 'evil')
})

test('the setup token is checked, wrong or right, and only the printed one sets the first password', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-setup-'))
  const sport = await freePort()
  const home = path.join(dir, 'home')
  fs.mkdirSync(home)
  const env = { PATH: process.env.PATH, HOME: home, OUTPOST_HOST: '0.0.0.0', PORT: String(sport), OUTPOST_AUTH: path.join(dir, 'auth.json') }
  for (const k of ['DATA', 'CONFIG', 'WORKSPACES', 'MIRRORS', 'SECRETS', 'SESSIONS']) env[`OUTPOST_${k}`] = path.join(dir, k.toLowerCase())
  const c = spawn(process.execPath, [path.join(root, 'server', 'serve.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    let out = ''
    const token = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no setup link:\n${out}`)), 15000)
      const look = (d) => {
        out += d
        const m = out.match(/[?&]setup=([^\s&]+)/)
        if (m) (clearTimeout(t), resolve(decodeURIComponent(m[1])))
      }
      c.stdout.on('data', look)
      c.stderr.on('data', look)
    })
    const setup = (body) =>
      fetch(`http://127.0.0.1:${sport}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.status)
    assert.equal(await setup({ token: token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'), user: 'o', password: 'long enough' }), 403)
    assert.equal(await setup({ token: 'short', user: 'o', password: 'long enough' }), 403)
    assert.equal(await setup({ user: 'o', password: 'long enough' }), 403)
    assert.equal(await setup({ token, user: 'o', password: 'long enough' }), 200)
  } finally {
    c.kill()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a routine’s layout is saved apart from it, read with it, exported and imported with it, and reset', async () => {
  const made = await api('PUT', '/api/routines', { name: 'Laid out', steps: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] })
  assert.equal(made.json.ok, true, JSON.stringify(made.json))
  const id = made.json.routine.id
  const layout = { trigger: { x: 0, y: 0 }, 's:b': { x: -240, y: 160 } }
  const put = await api('PUT', `/api/routines/${id}/layout`, { layout })
  assert.deepEqual(put.json, { ok: true, layout })
  const read = async () => (await api('GET', '/api/routines')).json.routines.find((r) => r.id === id)
  assert.deepEqual((await read()).layout, layout)
  assert.equal((await api('PUT', `/api/routines/${id}/layout`, { layout: { 's:b': { x: 'far', y: 0 } } })).status, 400)
  assert.equal((await api('PUT', `/api/routines/${id}/layout`, {})).status, 400)
  assert.equal((await api('PUT', '/api/routines/00000000/layout', { layout })).status, 404)
  // A save of the routine (as Pause, or a chat's routine_update) leaves the layout alone.
  const { layout: _l, lastRun, next, when, running, calls, finished, definedBy, ...stored } = await read()
  assert.equal((await api('PUT', '/api/routines', { ...stored, enabled: false })).json.ok, true)
  assert.deepEqual((await read()).layout, layout)
  const exp = (await api('GET', '/api/setup/export')).json
  assert.deepEqual(exp.routines.find((r) => r.id === id).layout, layout)
  assert.equal((await api('DELETE', `/api/routines/${id}/layout`)).json.ok, true)
  assert.equal((await read()).layout, null)
  const imp = await api('POST', '/api/setup/import', exp)
  assert.equal(imp.json.ok, true, JSON.stringify(imp.json))
  assert.deepEqual(imp.json.routines.find((r) => r.id === id).layout, layout)
  assert.equal((await api('PUT', `/api/routines/${id}/layout`, { layout: null })).json.layout, null)
  assert.equal((await read()).layout, null)
})
