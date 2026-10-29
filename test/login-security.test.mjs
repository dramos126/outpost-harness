// Every password check goes through `verifyLoginAsync`, counted against the login limit before
// it yields (auth.md): a right answer still gets in, a wrong one is counted, the eleventh is
// refused, and a burst of parallel guesses cannot get more than ten checks between them.
// Nothing here is imported statically: credentials.mjs fixes its file at import, and the
// default is the owner's real `~/.outpost-auth.json`.
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-login-'))
const TOKEN = 'login-test-token'
const PATHS = {
  HOME: path.join(tmp, 'home'),
  OUTPOST_DATA: path.join(tmp, 'data'),
  OUTPOST_CONFIG: path.join(tmp, 'config'),
  OUTPOST_WORKSPACES: path.join(tmp, 'workspaces'),
  OUTPOST_MIRRORS: path.join(tmp, 'mirrors'),
  OUTPOST_SECRETS: path.join(tmp, 'secrets'),
  OUTPOST_SESSIONS: path.join(tmp, 'sessions'),
  OUTPOST_UPLOADS: path.join(tmp, 'uploads'),
  OUTPOST_DATASETS: path.join(tmp, 'datasets'),
  OUTPOST_AUTH: path.join(tmp, 'auth.json'),
  OUTPOST_NOTIFY: path.join(tmp, 'no-notify.json'),
}
// This process and the server share one auth file, so the password set here is the server's.
Object.assign(process.env, PATHS)
fs.mkdirSync(PATHS.HOME)

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
  const { setPassword, authFilePath } = await import('../server/credentials.mjs')
  assert.equal(authFilePath(), PATHS.OUTPOST_AUTH)
  await setPassword('owner', 'correct horse')
  port = await freePort()
  child = spawn(process.execPath, [path.join(root, 'server', 'serve.mjs')], {
    env: { PATH: process.env.PATH, ...PATHS, OUTPOST_TOKEN: TOKEN, PORT: String(port) },
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

const post = (route, body, headers = {}) =>
  fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

const LOCKED = [{ name: 'API_URL', value: 'https://a.example', secret: false, locked: true }]
const CHANGED = [{ name: 'API_URL', value: 'https://b.example', secret: false, locked: true }]

test('a locked variable: the right password changes it, a wrong one is refused and counted', async () => {
  const { acceptEnv } = await import('../server/workspaces/environment.mjs')
  const { loginAllowed } = await import('../server/credentials.mjs')
  const addr = '10.1.0.1'
  await assert.rejects(acceptEnv('r', CHANGED, LOCKED, { password: 'wrong horse', addr }), { status: 403 })
  assert.equal(loginAllowed(addr).remaining, 9)
  const kept = await acceptEnv('r', CHANGED, LOCKED, { password: 'correct horse', addr })
  assert.equal(JSON.stringify(kept).includes('https://b.example'), true)
  // A right answer clears the count, as a login does.
  assert.equal(loginAllowed(addr).remaining, 10)
})

test('a locked variable: the eleventh guess is refused, and parallel guesses get ten checks at most', async () => {
  const { acceptEnv } = await import('../server/workspaces/environment.mjs')
  for (let i = 0; i < 10; i++) {
    await assert.rejects(acceptEnv('r', CHANGED, LOCKED, { password: `guess ${i}`, addr: '10.1.0.2' }), { status: 403 })
  }
  await assert.rejects(acceptEnv('r', CHANGED, LOCKED, { password: 'correct horse', addr: '10.1.0.2' }), { status: 429 })

  const burst = await Promise.allSettled(
    Array.from({ length: 25 }, (_, i) => acceptEnv('r', CHANGED, LOCKED, { password: `guess ${i}`, addr: '10.1.0.3' }))
  )
  const statuses = burst.map((r) => r.status === 'rejected' && r.reason.status)
  assert.equal(statuses.filter((s) => s === 403).length, 10)
  assert.equal(statuses.filter((s) => s === 429).length, 15)
})

test('/api/account/password: a wrong current password is 403, the right one changes it', async () => {
  const auth = { Authorization: `Bearer ${TOKEN}` }
  const wrong = await post('/api/account/password', { current: 'wrong horse', password: 'battery staple' }, auth)
  assert.equal(wrong.status, 403)
  const right = await post('/api/account/password', { current: 'correct horse', password: 'battery staple' }, auth)
  assert.equal(right.status, 200)
  assert.ok((await right.json()).token)
  assert.equal((await post('/api/login', { user: 'owner', password: 'battery staple' })).status, 200)
})

test('/api/login: right is 200 with a token, wrong is 401, and a parallel burst gets ten checks at most', async () => {
  const ok = await post('/api/login', { user: 'owner', password: 'battery staple' })
  assert.equal(ok.status, 200)
  assert.ok((await ok.json()).token)
  assert.equal((await post('/api/login', { user: 'owner', password: 'wrong' })).status, 401)
  // The right answer above cleared the count; the 401 is the one guess counted so far.
  const burst = await Promise.all(Array.from({ length: 25 }, () => post('/api/login', { user: 'owner', password: 'wrong' })))
  const statuses = burst.map((r) => r.status)
  assert.equal(statuses.filter((s) => s === 401).length, 9)
  assert.equal(statuses.filter((s) => s === 429).length, 16)
  // Locked out: even the right password is refused for the window.
  assert.equal((await post('/api/login', { user: 'owner', password: 'battery staple' })).status, 429)
})
