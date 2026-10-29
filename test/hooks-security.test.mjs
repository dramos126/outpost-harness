// The hooks' side of the server: who may post a hook or call /mcp, and what a hook payload can
// do once in (docs/modules/hooks.md, resilience.md, handoff.md, routines.md). The server is
// started as a child process on a spare port, bound to every interface as the deploy unit does,
// with all of its state in a temp directory.
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-hooks-'))
const TOKEN = 'hooks-test-token'
// The in-process imports below (the hook store, the MCP gate) keep their state here too.
process.env.OUTPOST_DATA = path.join(tmp, 'unit-data')

/** This machine's first non-loopback IPv4 address: a request to it arrives from it, not from loopback. */
const lanAddress = Object.values(os.networkInterfaces())
  .flat()
  .find((a) => a && a.family === 'IPv4' && !a.internal)?.address

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
      OUTPOST_HOST: '0.0.0.0',
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

/** One raw POST to `target` over a socket to `address`, with exactly the headers given. */
function post(target, body, { address = '127.0.0.1', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    const s = net.connect(port, address, () => {
      const all = { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers, Connection: 'close' }
      s.write(`POST ${target} HTTP/1.1\r\n${Object.entries(all).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`)
      s.write(data)
    })
    let out = ''
    s.on('data', (d) => (out += d))
    s.on('end', () => {
      const [head, ...rest] = out.split('\r\n\r\n')
      let json = null
      try {
        json = JSON.parse(rest.join('\r\n\r\n'))
      } catch {}
      resolve({ status: Number(head.split(' ')[1]), json })
    })
    s.on('error', reject)
  })
}

const SID = '0f6c5a1e-3b5d-4c2a-9a51-2b8d6f1c7e90'
const hook = (extra = {}) => ({ session_id: SID, hook_event_name: 'UserPromptSubmit', cwd: '/tmp', ...extra })

// ── F2: who may post ─────────────────────────────────────────────────────────────────────

test('a hook from loopback is taken with no token, as every installed hook sends it', async () => {
  const r = await post('/api/hook', hook())
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
})

test('a hook from the LAN is refused even with a loopback Host', { skip: !lanAddress && 'no LAN address here' }, async () => {
  const r = await post('/api/hook', hook(), { address: lanAddress })
  assert.equal(r.status, 403)
})

test('a hook relayed by a proxy on this machine is refused', async () => {
  for (const h of ['X-Forwarded-For', 'Forwarded', 'CF-Connecting-IP', 'X-Real-IP']) {
    const r = await post('/api/hook', hook(), { headers: { [h]: '192.168.1.50' } })
    assert.equal(r.status, 403, h)
  }
})

test('a hook naming another Host from loopback is still refused', async () => {
  const r = await post('/api/hook', hook(), { headers: { Host: `evil.example:${port}` } })
  assert.equal(r.status, 403)
})

test('/mcp from the LAN is refused before the token is looked at; from loopback it is the token that decides', async () => {
  const rpc = { jsonrpc: '2.0', id: 1, method: 'ping' }
  if (lanAddress) assert.equal((await post('/mcp', rpc, { address: lanAddress, headers: { Authorization: 'Bearer x' } })).status, 403)
  assert.equal((await post('/mcp', rpc, { headers: { 'X-Forwarded-For': '10.0.0.9', Authorization: 'Bearer x' } })).status, 403)
  assert.equal((await post('/mcp', rpc, { headers: { Authorization: 'Bearer x' } })).status, 401)
})

test('fromThisMachine reads the socket, the Host and the forwarding headers', async () => {
  const { fromThisMachine } = await import('../server/mcp/index.mjs')
  const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers: { host: '127.0.0.1:5274', ...headers } })
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.2']) assert.equal(fromThisMachine(req(a)), true, a)
  for (const a of ['192.0.2.1', '::ffff:192.168.1.4', 'fe80::1', '', undefined]) assert.equal(fromThisMachine(req(a)), false, String(a))
  assert.equal(fromThisMachine(req('127.0.0.1', { host: 'localhost:5274' })), true)
  assert.equal(fromThisMachine(req('127.0.0.1', { host: 'outpost.lan:5274' })), false)
  assert.equal(fromThisMachine(req('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' })), false)
})

// ── F7: what one hook can make the store hold ─────────────────────────────────────────────

test('a payload that is not a hook is answered ok:false; a real-sized one is taken', async () => {
  for (const bad of [{ ...hook(), session_id: '' }, { ...hook(), session_id: 'x' }, { ...hook(), session_id: '../../etc' }, hook({ cwd: '/' + 'a'.repeat(5000) })]) {
    const r = await post('/api/hook', bad)
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, false)
  }
  // A Write of a 600 KB file: bigger than any one turn writes, and still under the cap.
  const big = await post('/api/hook', hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/tmp/x', content: 'x'.repeat(600_000) } }))
  assert.equal(big.json.ok, true)
  // Over the cap the server answers ok:false before reading and hangs up, so by timing the send
  // sees that answer, a reset, a broken pipe or an empty reply. Whichever, it is not taken.
  const huge = await post('/api/hook', hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { content: 'x'.repeat(1_100_000) } })).catch((err) => ({ err }))
  assert.notEqual(huge.json?.ok, true)
})

test('free text, names and subagents are bounded; the store is capped, oldest out', async () => {
  const { recordHookEvent, hookStates, hookEverSeen } = await import('../server/state/hooks.mjs')
  const id = '11111111-2222-4333-8444-555555555555'
  const ev = (extra) => recordHookEvent({ session_id: id, cwd: '/tmp', ...extra })
  let r = await ev({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'm'.repeat(10_000) })
  assert.equal(r.message.length, 500)
  r = await ev({ hook_event_name: 'PreToolUse', tool_name: 't'.repeat(10_000) })
  assert.equal(r.tool.length, 200)
  r = await ev({ hook_event_name: 'StopFailure', error: 'k'.repeat(10_000), error_details: 'd'.repeat(10_000) })
  assert.equal(r.failure.kind.length, 200)
  assert.equal(r.failure.detail.length, 500)
  for (let i = 0; i < 80; i++) r = await ev({ hook_event_name: 'SubagentStart', agent_id: 'a' + i, agent_type: 'y'.repeat(1000) })
  assert.equal(r.subagents.length, 50)
  assert.equal(r.subagents[0].type.length, 200)
  // A real UUID and the cwd a real session sends are taken unchanged.
  r = await ev({ hook_event_name: 'UserPromptSubmit', cwd: '/home/someone/.outpost/workspaces/abc/repo' })
  assert.equal(r.cwd, '/home/someone/.outpost/workspaces/abc/repo')

  for (let i = 0; i < 2100; i++) await recordHookEvent({ session_id: `flood-${String(i).padStart(8, '0')}`, hook_event_name: 'Stop', cwd: '/tmp' })
  const states = await hookStates()
  assert.ok(states.size <= 2000, String(states.size))
  // The newest flood entry stays; the first real one, now the quietest, was the one to go.
  assert.equal(await hookEverSeen('flood-00002099'), true)
  assert.equal(await hookEverSeen(id), false)
})
