/**
 * Reaching an environment: a named host, over ssh, with one of Outpost's own keys.
 *
 * Nothing here reads the user's `~/.ssh`. The key is the secret store's, the known_hosts is
 * the secret store's, and the options say so on every call (secrets/index.mjs `sshArgsFor`).
 * A host is trusted on first use and refused when its key changes; the test reports both so
 * the settings page can show the fingerprint and offer to forget the old one.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { environmentByName } from './config.mjs'
import { SECRETS_DIR, knownFingerprint, sshArgsFor } from './secrets/index.mjs'

const execFileAsync = promisify(execFile)

/**
 * A user or host that can only be read as one: not empty, no leading `-` and no blank or control
 * character. `user@host` is an argument to ssh, scp and rsync, and one beginning `-` — a user
 * `-oProxyCommand=…` — is read as an option, which runs a command here.
 */
const PLAIN = /^[^\s\x00-\x1f\x7f-][^\s\x00-\x1f\x7f]*$/

/** `ssh` arguments for an environment, ready for a command to follow: `[...args, 'user@host']`. */
export async function sshTarget(env) {
  if (!PLAIN.test(String(env.user ?? ''))) throw new Error(`Host ${env.name}'s user is not a user name — it may not start with "-" or hold a space`)
  if (!PLAIN.test(String(env.host ?? ''))) throw new Error(`Host ${env.name}'s address is not a host name — it may not start with "-" or hold a space`)
  if (!env.key) throw new Error(`Environment ${env.name} has no key chosen`)
  const args = await sshArgsFor(env.key)
  if (env.port && env.port !== 22) args.push('-p', String(env.port))
  return { args, target: `${env.user}@${env.host}` }
}

/**
 * A script that is `ssh` to this environment: `exec ssh <options> user@host "$@"`. For a
 * recipe's `command` source, which gets it as `$OUTPOST_SSH` — a single word that needs no
 * quoting, where the option list as a string would have to be split by the shell and every
 * path in it quoted by hand. Lives beside the keys, so it is owner-only like them.
 */
export async function sshWrapper(env) {
  const { args, target } = await sshTarget(env)
  const dir = path.join(SECRETS_DIR, 'ssh')
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, env.name.replace(/[^a-zA-Z0-9._-]/g, '_'))
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`
  await fsp.writeFile(file, `#!/bin/sh\nexec ssh ${[...args, target].map(q).join(' ')} "$@"\n`, { mode: 0o700 })
  await fsp.chmod(file, 0o700).catch(() => {})
  return file
}

/** Run one command on the environment. Throws with ssh's last line on failure. */
export async function sshRun(env, command, { timeout = 60000 } = {}) {
  const { args, target } = await sshTarget(env)
  try {
    // `--`: what follows is the target and its command, never an option, whatever it begins with.
    // Not in `sshWrapper`, whose callers may put options after the target, as ssh allows.
    const { stdout } = await execFileAsync('ssh', [...args, '--', target, command], { timeout, maxBuffer: 16 * 1024 * 1024 })
    return stdout
  } catch (err) {
    const tail = String(err?.stderr || err?.message || err).trim().split('\n').filter(Boolean).pop()
    throw new Error(tail || 'ssh failed')
  }
}

/**
 * Can Outpost reach this environment, and what is there? Answers the hostname, which of the
 * tools a data source might need are installed, and the host key fingerprint on file — so
 * "connected" is a checked claim and a changed key is a sentence rather than a hang.
 */
export async function testEnvironment(name) {
  const env = await environmentByName(name)
  if (!env) return { ok: false, error: 'No such environment' }
  if (!env.key) return { ok: false, error: 'Choose a key for it first' }
  try {
    const out = await sshRun(
      env,
      'hostname; for t in sqlite3 docker rsync; do command -v $t >/dev/null 2>&1 && printf "%s " $t; done; echo',
      { timeout: 25000 }
    )
    const [hostname, toolsLine] = out.trim().split('\n')
    return {
      ok: true,
      hostname: hostname || env.host,
      tools: (toolsLine || '').trim().split(/\s+/).filter(Boolean),
      fingerprint: await knownFingerprint(env.host),
      checkedAt: Date.now(),
    }
  } catch (err) {
    const msg = err.message || 'Could not connect'
    const changed = /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(msg)
    return {
      ok: false,
      error: changed ? 'The host key has changed since it was last seen. Forget it to trust the new one.' : msg,
      hostKeyChanged: changed,
      fingerprint: await knownFingerprint(env.host),
    }
  }
}
