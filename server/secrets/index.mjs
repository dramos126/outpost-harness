/**
 * The secret store: what this instance holds that must never be served back.
 *
 * `~/.outpost/secrets/` — mode 0700, outside any checkout and outside the exportable config —
 * with `index.json` (0600) naming every entry, a private key file per generated or pasted ssh
 * key, and the `known_hosts` Outpost keeps for itself. Entered from the page, owned by the
 * instance, lost with it: there is deliberately no backup and no export of this directory
 * (docs/proposals/harness.md, *Secrets are entered from the UI*).
 *
 * What crosses to the page is a name, a kind, a hint and — for a key — the public half. The
 * private half of a generated key never crosses the wire in either direction, which is why
 * generating is preferred to pasting. A token's value is read by the server at the moment it
 * is used and nowhere else.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readJsonFile } from '../lib/fsutil.mjs'

const execFileAsync = promisify(execFile)

export const SECRETS_DIR = process.env.OUTPOST_SECRETS || path.join(os.homedir(), '.outpost', 'secrets')
const INDEX = path.join(SECRETS_DIR, 'index.json')
export const KNOWN_HOSTS = path.join(SECRETS_DIR, 'known_hosts')

const NAME = /^[a-z0-9][a-z0-9._-]{0,40}$/

/** A secret's name is also its file name, so it is kept to a safe alphabet. */
export function validName(name) {
  return NAME.test(String(name || ''))
}

async function ensureDir() {
  await fsp.mkdir(SECRETS_DIR, { recursive: true, mode: 0o700 })
  await fsp.chmod(SECRETS_DIR, 0o700).catch(() => {})
}

/**
 * No index is a store with nothing in it. An index that will not parse is thrown, not read as
 * empty: every writer here is load, change, save, so an empty read was one "Add a token" away
 * from an index that had forgotten every key still sitting in the folder beside it.
 */
async function load() {
  const raw = await readJsonFile(INDEX)
  return raw && typeof raw.entries === 'object' && raw.entries ? raw : { entries: {} }
}

async function save(index) {
  await ensureDir()
  const tmp = `${INDEX}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(index, null, 2) + '\n', { mode: 0o600 })
  await fsp.rename(tmp, INDEX)
  await fsp.chmod(INDEX, 0o600).catch(() => {})
}

const keyFile = (name) => path.join(SECRETS_DIR, name)

/** What the page may know: everything but a value. */
function publicView(name, e) {
  return {
    name,
    kind: e.kind,
    createdAt: e.createdAt || 0,
    hint: e.hint || '',
    publicKey: e.publicKey || '',
    fingerprint: e.fingerprint || '',
    generated: Boolean(e.generated),
  }
}

export async function listSecrets() {
  const { entries } = await load()
  return Object.entries(entries)
    .map(([name, e]) => publicView(name, e))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The kind of a named secret, or `''`. For callers deciding how to use it, not what it is. */
export async function secretKind(name) {
  return (await load()).entries[name]?.kind || ''
}

async function fingerprintOf(pubFile) {
  try {
    const { stdout } = await execFileAsync('ssh-keygen', ['-l', '-f', pubFile], { timeout: 5000 })
    return stdout.trim().split(/\s+/)[1] || ''
  } catch {
    return ''
  }
}

/**
 * A new ed25519 keypair, made here. The private half is written by `ssh-keygen` straight into
 * the store and never leaves it; the public half is what the page shows, to be added to a
 * host's `authorized_keys` or to GitHub as a deploy key.
 */
export async function generateKey(name) {
  if (!validName(name)) throw new Error('A secret name is lowercase letters, digits, dots, dashes and underscores')
  const index = await load()
  if (index.entries[name]) throw new Error(`A secret named ${name} already exists`)
  await ensureDir()
  const file = keyFile(name)
  await fsp.rm(file, { force: true })
  await fsp.rm(`${file}.pub`, { force: true })
  const comment = `outpost-${name}@${os.hostname()}`
  await execFileAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', file], { timeout: 20000 })
  await fsp.chmod(file, 0o600)
  const publicKey = (await fsp.readFile(`${file}.pub`, 'utf8')).trim()
  index.entries[name] = {
    kind: 'ssh-key',
    createdAt: Date.now(),
    generated: true,
    publicKey,
    fingerprint: await fingerprintOf(`${file}.pub`),
    hint: publicKey.slice(-8),
  }
  await save(index)
  return publicView(name, index.entries[name])
}

/**
 * A pasted private key — the fallback for a key that has to be shared, and the one path where
 * a private key crosses the LAN. The public half is derived from it, so the page shows the
 * same thing it would for a generated key.
 */
export async function addKey(name, privateKey) {
  if (!validName(name)) throw new Error('A secret name is lowercase letters, digits, dots, dashes and underscores')
  const text = String(privateKey || '').replace(/\r\n?/g, '\n').trim()
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) throw new Error('That is not a private key')
  const index = await load()
  if (index.entries[name]) throw new Error(`A secret named ${name} already exists`)
  await ensureDir()
  const file = keyFile(name)
  await fsp.writeFile(file, text + '\n', { mode: 0o600 })
  await fsp.chmod(file, 0o600)
  let publicKey = ''
  try {
    const { stdout } = await execFileAsync('ssh-keygen', ['-y', '-f', file], { timeout: 5000 })
    publicKey = stdout.trim()
    await fsp.writeFile(`${file}.pub`, publicKey + '\n', { mode: 0o644 })
  } catch (err) {
    await fsp.rm(file, { force: true })
    throw new Error(`ssh could not read that key: ${String(err?.stderr || err?.message || err).trim().split('\n').pop()}`)
  }
  index.entries[name] = {
    kind: 'ssh-key',
    createdAt: Date.now(),
    generated: false,
    publicKey,
    fingerprint: await fingerprintOf(`${file}.pub`),
    hint: publicKey.slice(-8),
  }
  await save(index)
  return publicView(name, index.entries[name])
}

/** A token — GitHub, Jenkins, anything that is a string. The value goes in and never comes out. */
export async function addToken(name, value) {
  if (!validName(name)) throw new Error('A secret name is lowercase letters, digits, dots, dashes and underscores')
  const v = String(value || '').trim()
  if (!v) throw new Error('The token is empty')
  const index = await load()
  index.entries[name] = {
    kind: 'token',
    createdAt: Date.now(),
    value: v,
    hint: `…${v.slice(-4)}`,
  }
  await save(index)
  return publicView(name, index.entries[name])
}

export async function removeSecret(name) {
  const index = await load()
  const e = index.entries[name]
  if (!e) return false
  delete index.entries[name]
  await save(index)
  if (e.kind === 'ssh-key') {
    await fsp.rm(keyFile(name), { force: true })
    await fsp.rm(`${keyFile(name)}.pub`, { force: true })
  }
  return true
}

/** A token's value, for the server's own use at the moment of use. Never on an endpoint. */
export async function tokenValue(name) {
  const e = (await load()).entries[name]
  if (!e || e.kind !== 'token') return ''
  return e.value || ''
}

/** The private key's path, or `''`. */
export async function keyPath(name) {
  const e = (await load()).entries[name]
  if (!e || e.kind !== 'ssh-key') return ''
  return keyFile(name)
}

/**
 * The ssh options that make a key reach a host without touching the user's own ssh setup:
 * only this key, no password fallback, no prompt, and Outpost's own known_hosts — trusting a
 * host on first use and refusing one whose key changed, which the environment test reports.
 */
export async function sshArgsFor(keyName) {
  const file = await keyPath(keyName)
  if (!file) throw new Error(`No ssh key named ${keyName} in the secret store`)
  await ensureDir()
  return [
    '-i',
    file,
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    `UserKnownHostsFile=${KNOWN_HOSTS}`,
    '-o',
    'ConnectTimeout=10',
  ]
}

/** The host key fingerprint Outpost has on file for a host, from its own known_hosts. */
export async function knownFingerprint(host) {
  try {
    const { stdout } = await execFileAsync('ssh-keygen', ['-F', host, '-f', KNOWN_HOSTS], { timeout: 5000 })
    const line = stdout.split('\n').find((l) => l && !l.startsWith('#'))
    if (!line) return ''
    const tmp = path.join(SECRETS_DIR, `.fp-${process.pid}`)
    await fsp.writeFile(tmp, line.replace(/^\S+\s+/, '') + '\n')
    try {
      const { stdout: fp } = await execFileAsync('ssh-keygen', ['-l', '-f', tmp], { timeout: 5000 })
      return fp.trim().split(/\s+/)[1] || ''
    } finally {
      await fsp.rm(tmp, { force: true })
    }
  } catch {
    return ''
  }
}

/** Forget a host's key, so the next connection trusts whatever it presents. A person's call. */
export async function forgetHost(host) {
  await execFileAsync('ssh-keygen', ['-R', host, '-f', KNOWN_HOSTS], { timeout: 5000 }).catch(() => {})
}

/**
 * The askpass helper. Git asks `Username for 'https://<host>[/<path>]': `, then
 * `Password for 'https://<user>@<host>[/<path>]': `; the helper answers only a prompt that is
 * exactly that for `OUTPOST_GIT_HOST`, with no `@` after the host — a user name in an address a
 * session wrote cannot then pass for the host. Anything else gets nothing, and git fails to
 * authenticate there.
 */
const ASKPASS = `#!/bin/sh
h=$OUTPOST_GIT_HOST
[ -n "$h" ] || exit 1
p=$(printf '%s' "$1" | tr 'A-Z' 'a-z')
ans() { case "$2" in *@*) exit 1 ;; esac; printf '%s\\n' "$1"; exit 0; }
case "$p" in
  "username for 'https://$h': ") ans x-access-token "" ;;
  "username for 'https://$h/"*) ans x-access-token "\${p#"username for 'https://$h/"}" ;;
esac
for u in x-access-token "$OUTPOST_GIT_URL_USER"; do
  [ -n "$u" ] || continue
  case "$p" in
    "password for 'https://$u@$h': ") ans "$OUTPOST_GIT_TOKEN" "" ;;
    "password for 'https://$u@$h/"*) ans "$OUTPOST_GIT_TOKEN" "\${p#"password for 'https://$u@$h/"}" ;;
  esac
done
exit 1
`

/** The host (and port) of an https address as git names it in a prompt, lowercased, and its user; `''` for anything else. */
export function httpsHost(url) {
  try {
    const u = new URL(String(url || ''))
    if (u.protocol !== 'https:') return { host: '', user: '' }
    // The user as written in the address: git's prompt shows it so, percent signs and all.
    return { host: u.host.toLowerCase(), user: u.username.toLowerCase() }
  } catch {
    return { host: '', user: '' }
  }
}

/**
 * The environment that makes `git` use a named secret for a remote: a key through
 * `GIT_SSH_COMMAND`, a token through an askpass helper that reads it from the environment —
 * never from the command line, which `ps` shows to every user on the box.
 *
 * `url` is the address the token is for (integrations.mjs `remoteFor`), and the token goes to
 * that https host only: the same git also fetches submodules and LFS files from addresses a
 * session wrote (`.gitmodules`, `.lfsconfig`), and a helper that answered every prompt handed
 * the token to whichever host they named.
 */
export async function gitEnvFor(authName, url = '') {
  if (!authName) return {}
  const kind = await secretKind(authName)
  if (kind === 'ssh-key') {
    const args = await sshArgsFor(authName)
    return { GIT_SSH_COMMAND: ['ssh', ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ') }
  }
  if (kind === 'token') {
    const helper = path.join(SECRETS_DIR, 'askpass.sh')
    await ensureDir()
    await fsp.writeFile(helper, ASKPASS, { mode: 0o700 })
    await fsp.chmod(helper, 0o700).catch(() => {})
    const { host, user } = httpsHost(url)
    return { GIT_ASKPASS: helper, OUTPOST_GIT_TOKEN: await tokenValue(authName), OUTPOST_GIT_HOST: host, OUTPOST_GIT_URL_USER: user, GIT_TERMINAL_PROMPT: '0' }
  }
  throw new Error(`No secret named ${authName} in the secret store`)
}
