// A fresh box bound to 0.0.0.0, no token, no password: setup mode (auth.md). The link it prints
// names the LAN address, so that Host must be answered — refusing it left the first password
// impossible to set from another device — while any other name is still refused.
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-setup-'))
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
// Set before auth.mjs is imported: credentials.mjs fixes its file at import, and the default is
// the owner's real `~/.outpost-auth.json`.
Object.assign(process.env, PATHS)
fs.mkdirSync(PATHS.HOME)
const { lanAddress } = await import('../server/auth.mjs')

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
  port = await freePort()
  child = spawn(process.execPath, [path.join(root, 'server', 'serve.mjs')], {
    env: { PATH: process.env.PATH, ...PATHS, OUTPOST_HOST: '0.0.0.0', PORT: String(port) },
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

// `fetch` will not set Host, so a raw request: the server is reached on loopback but addressed
// by the name a browser on another device would send.
const request = (method, route, host, body) =>
  new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : ''
    const req = http.request(
      { host: '127.0.0.1', port, method, path: route, headers: { host: `${host}:${port}`, 'content-type': 'application/json' } },
      (res) => {
        let text = ''
        res.on('data', (d) => (text += d))
        res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : {} }))
      }
    )
    req.on('error', reject)
    req.end(data)
  })

test('setup mode: the printed link names the LAN address, and that Host is answered', async () => {
  const link = new URL(output.match(/Outpost → (\S+)/)[1])
  assert.equal(link.hostname, lanAddress())
  assert.ok(link.searchParams.get('setup'))
  const r = await request('GET', '/api/auth', lanAddress())
  assert.equal(r.status, 200)
  assert.equal(r.body.setupRequired, true)
})

test('setup mode: any other name is still refused', async () => {
  assert.equal((await request('GET', '/api/auth', 'rebind.example')).status, 403)
})

test('setup mode: the first password is set through the LAN address with the printed token', async () => {
  const token = new URL(output.match(/Outpost → (\S+)/)[1]).searchParams.get('setup')
  const wrong = await request('POST', '/api/setup', lanAddress(), { token: 'not-it', user: 'owner', password: 'correct horse' })
  assert.equal(wrong.status, 403)
  const ok = await request('POST', '/api/setup', lanAddress(), { token, user: 'owner', password: 'correct horse' })
  assert.equal(ok.status, 200)
  assert.ok(ok.body.token)
})
