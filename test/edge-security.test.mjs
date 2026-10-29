// The edge of the server: what an unauthenticated request can do to it, the page's headers, the
// gate's credential, uploads and the login limiter (docs/modules/api.md, auth.md). The server is
// started as a child process on a spare port with all of its state in a temp directory.
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-edge-'))
const TOKEN = 'edge-test-token'
// Before credentials.mjs is first imported: it fixes its file at import, and the default is
// the real `~/.outpost-auth.json`.
process.env.OUTPOST_AUTH = path.join(tmp, 'test-auth.json')

/** A port nothing is listening on, from the kernel. */
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
      OUTPOST_AUTH: path.join(tmp, 'auth.json'),
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

/** One raw request: `fetch` normalises the path, and the point is to send what it would not. */
function raw(target, headers = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => {
      const lines = Object.entries({ Host: `127.0.0.1:${port}`, ...headers, Connection: 'close' }).map(([k, v]) => `${k}: ${v}`)
      s.write(`GET ${target} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`)
    })
    let out = ''
    s.on('data', (d) => (out += d))
    s.on('end', () => {
      const [head] = out.split('\r\n\r\n')
      const [status, ...rest] = head.split('\r\n')
      const h = Object.fromEntries(rest.map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]))
      resolve({ status: Number(status.split(' ')[1]), headers: h })
    })
    s.on('error', reject)
  })
}

test('a URL that will not decode or parse is a 400, and the server stays up', async () => {
  for (const target of ['/%', '//', '//x:y@', '/%E0%A4%A']) {
    assert.equal((await raw(target)).status, 400, target)
  }
  assert.equal(child.exitCode, null)
  const ok = await raw('/api/threads', { Authorization: `Bearer ${TOKEN}` })
  assert.equal(ok.status, 200)
})

test('/api/* takes the token from the Authorization header only, never ?token=', async () => {
  assert.equal((await raw(`/api/threads?token=${TOKEN}`)).status, 401)
  assert.equal((await raw('/api/threads', { Authorization: `Bearer ${TOKEN}` })).status, 200)
  // The first-load link is the page's, and the page is not behind the gate.
  assert.notEqual((await raw(`/?token=${TOKEN}`)).status, 401)
})

test('an upload folder of dots stays inside the uploads directory; a thread id still names it', async () => {
  const { saveUpload } = await import('../server/uploads.mjs')
  const base = path.join(tmp, 'uploads')
  const png = { type: 'image/png', name: 'shot.png', data: Buffer.from('png bytes').toString('base64') }
  for (const folder of ['..', '.', '...', '../..', '']) {
    const r = await saveUpload(base, { ...png, folder })
    assert.ok(r.ok)
    assert.equal(path.dirname(path.dirname(r.path)), base, folder)
  }
  const r = await saveUpload(base, { ...png, folder: 'claude:3f2a-b.c_d' })
  assert.equal(path.dirname(r.path), path.join(base, 'claude_3f2a-b.c_d'))
})

test('an upload is an image, a PDF or text judged by its bytes, and never takes its extension from the name', async () => {
  const { saveUpload, uploadTitle, MAX_TEXT_BYTES } = await import('../server/uploads.mjs')
  const base = path.join(tmp, 'uploads-kinds')
  const b64 = (s) => Buffer.from(s).toString('base64')
  const pdf = await saveUpload(base, { folder: 't', name: 'report.sh', type: 'application/pdf', data: b64('%PDF-1.4') })
  assert.ok(pdf.ok && pdf.path.endsWith('-report.pdf'))
  assert.equal(uploadTitle(pdf.path), 'report.pdf')
  // `.ts` is a video to a browser, and `.md` is often nothing: the bytes say text.
  for (const [name, type] of [['notes.md', ''], ['main.ts', 'video/mp2t'], ['a.json', 'application/json']]) {
    const r = await saveUpload(base, { folder: 't', name, type, data: b64('{"x": "é"}\n') })
    assert.ok(r.ok && r.path.endsWith('.txt'), name)
    assert.equal(uploadTitle(r.path), name)
  }
  const bin = await saveUpload(base, { folder: 't', name: 'a.zip', type: 'application/zip', data: b64('PK\u0003\u0004\u0000\u0000') })
  assert.equal(bin.ok, false)
  const badUtf8 = await saveUpload(base, { folder: 't', name: 'x.txt', type: 'text/plain', data: Buffer.from([0xff, 0xfe, 0x41]).toString('base64') })
  assert.equal(badUtf8.ok, false)
  // An image type is never taken as text, whatever its bytes.
  assert.equal((await saveUpload(base, { folder: 't', name: 'x.svg', type: 'image/svg+xml', data: b64('<svg/>') })).ok, false)
  assert.equal((await saveUpload(base, { folder: 't', name: 'big.txt', type: 'text/plain', data: b64('a'.repeat(MAX_TEXT_BYTES + 1)) })).ok, false)
})

test('the login limiter keys IPv6 by /64 and mapped IPv4 as IPv4', async () => {
  const { limiterKey } = await import('../server/credentials.mjs')
  assert.equal(limiterKey('192.168.1.20'), '192.168.1.20')
  assert.equal(limiterKey('::ffff:192.168.1.20'), '192.168.1.20')
  assert.equal(limiterKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64')
  assert.equal(limiterKey('2001:db8:1:2:ffff:ffff:ffff:fffe'), '2001:db8:1:2::/64')
  assert.equal(limiterKey('2001:0db8:0001:0002::'), '2001:db8:1:2::/64')
  assert.notEqual(limiterKey('2001:db8:1:3::1'), limiterKey('2001:db8:1:2::1'))
  assert.equal(limiterKey('fe80::1%eth0'), 'fe80:0:0:0::/64')
  assert.equal(limiterKey('::1'), '0:0:0:0::/64')
  assert.equal(limiterKey(''), 'unknown')
})

test('ten failures lock out a client and its /64 for the window; others are untouched', async () => {
  const { loginAllowed, noteFailedLogin, clearFailedLogins } = await import('../server/credentials.mjs')
  for (let i = 0; i < 10; i++) {
    assert.ok(loginAllowed(`2001:db8:9:9::${i}`).ok)
    noteFailedLogin(`2001:db8:9:9::${i}`)
  }
  assert.equal(loginAllowed('2001:db8:9:9::ffff').ok, false)
  assert.ok(loginAllowed('2001:db8:9:a::1').ok)
  assert.ok(loginAllowed('10.0.0.1').ok)
  clearFailedLogins('2001:db8:9:9::1')
  assert.ok(loginAllowed('2001:db8:9:9::ffff').ok)
})

test('the limiter holds at most 5000 clients however many fresh addresses fail', async () => {
  const { noteFailedLogin, loginAllowed, trackedLogins } = await import('../server/credentials.mjs')
  for (let i = 0; i < 6000; i++) noteFailedLogin(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`)
  assert.ok(trackedLogins() <= 5000)
  // The newest are kept, so a client still guessing is still counted.
  for (let i = 0; i < 9; i++) noteFailedLogin('10.0.23.111')
  assert.equal(loginAllowed('10.0.23.111').ok, false)
})

test('a password set and checked off the event loop; wrong user or password fails', async () => {
  const { setPassword, verifyLoginAsync, hasCredentials, authFilePath } = await import('../server/credentials.mjs')
  // Never the owner's real file.
  assert.equal(authFilePath(), path.join(tmp, 'test-auth.json'))
  assert.equal(hasCredentials(), false)
  assert.equal(await verifyLoginAsync('owner', 'correct horse'), false)
  await setPassword('owner', 'correct horse')
  assert.equal(await verifyLoginAsync('owner', 'correct horse'), true)
  assert.equal(await verifyLoginAsync('owner', 'wrong horse'), false)
  assert.equal(await verifyLoginAsync('someone', 'correct horse'), false)
  assert.equal(await verifyLoginAsync('owner', undefined), false)
})

test('a preview ticket is read with no bearer, an unknown one is a bare 404; minting one needs the bearer', async () => {
  // Outside the gate: no 401 for want of a header, and nothing said about the ticket.
  const unknown = await raw(`/api/preview/${'A'.repeat(32)}`)
  assert.equal(unknown.status, 404)
  assert.equal(unknown.headers['content-type'], undefined)
  assert.equal((await raw('/api/preview/not-a-ticket')).status, 404)
  // The mint is a page call like any other.
  const mint = await fetch(`http://127.0.0.1:${port}/api/file/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(mint.status, 401)
})

test('the page is served with a CSP, no framing, nosniff and no referrer', async () => {
  // `/` with or without a built dist/: a 200 or the 404 both carry the page's headers.
  const { headers } = await raw('/')
  const csp = headers['content-security-policy'] || ''
  assert.match(csp, /default-src 'self'/)
  assert.match(csp, /script-src 'self'(;|$)/)
  assert.match(csp, /frame-ancestors 'none'/)
  assert.match(csp, /img-src 'self' blob:/)
  // A PDF in the Files viewer is a blob in a frame, and the HTML preview a ticketed document of
  // this origin (server/lib/preview.mjs); nothing from another origin is framed or embedded.
  assert.match(csp, /frame-src blob: 'self'(;|$)/)
  assert.match(csp, /object-src blob:(;|$)/)
  assert.equal(headers['x-frame-options'], 'DENY')
  assert.equal(headers['x-content-type-options'], 'nosniff')
  assert.equal(headers['referrer-policy'], 'no-referrer')
})
