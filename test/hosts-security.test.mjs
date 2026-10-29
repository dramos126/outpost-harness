// What reaches ssh for a host (docs/modules/integrations-hosts.md). ssh itself and the secret
// store are mocked: the argv is recorded, nothing is run.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-test-'))
process.env.OUTPOST_DATA = tmp
process.env.HOME = tmp

const calls = []
mock.module('node:child_process', {
  namedExports: {
    execFile: (cmd, args, opts, cb) => {
      calls.push([cmd, ...args])
      cb(null, { stdout: 'ok\n', stderr: '' })
    },
  },
})
mock.module('../server/secrets/index.mjs', {
  namedExports: { SECRETS_DIR: path.join(tmp, 'secrets'), knownFingerprint: async () => '', sshArgsFor: async () => ['-i', '/key', '-o', 'IdentitiesOnly=yes'] },
})

const { sshRun, sshTarget, sshWrapper } = await import('../server/environments.mjs')

const host = (over) => ({ name: 'staging', host: 'staging.example.com', user: 'deploy', port: 22, key: 'k', ...over })

test('a valid host is reached as before, with -- ahead of the target and its command', async () => {
  calls.length = 0
  assert.equal(await sshRun(host({ port: 2222 }), 'hostname'), 'ok\n')
  assert.deepEqual(calls[0], ['ssh', '-i', '/key', '-o', 'IdentitiesOnly=yes', '-p', '2222', '--', 'deploy@staging.example.com', 'hostname'])
  for (const ok of [host({ host: '10.0.0.5' }), host({ user: 'first.last', host: 'box-1.lan' }), host({ user: 'svc_x', host: 'h' })]) {
    assert.equal((await sshTarget(ok)).target, `${ok.user}@${ok.host}`)
  }
})

test('a user or host that would read as an option, or holds a space, is refused before ssh runs', async () => {
  calls.length = 0
  for (const bad of [
    host({ user: '-oProxyCommand=touch /tmp/pwned' }),
    host({ host: '-oProxyCommand=x' }),
    host({ user: 'a b' }),
    host({ host: 'h\nx' }),
    host({ user: '' }),
  ]) {
    await assert.rejects(sshTarget(bad), /may not start with "-"/)
    await assert.rejects(sshRun(bad, 'hostname'), /may not start with "-"/)
    await assert.rejects(sshWrapper(bad), /may not start with "-"/)
  }
  assert.equal(calls.length, 0)
})

test('the $OUTPOST_SSH wrapper keeps its shape: options, then the target, then what the caller adds', async () => {
  const file = await sshWrapper(host())
  assert.equal(fs.readFileSync(file, 'utf8'), `#!/bin/sh\nexec ssh '-i' '/key' '-o' 'IdentitiesOnly=yes' 'deploy@staging.example.com' "$@"\n`)
})
