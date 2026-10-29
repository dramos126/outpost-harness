/**
 * Data copies: what a recipe pulls into a checkout from an environment before the session
 * starts, and the `.env.local` that tells the app where it landed.
 *
 * A source is `{ env, kind, from, to, envVar }`. `kind` is the whole knob: a SQLite file is
 * backed up with SQLite's own tool on the host — a copy of a live file is a torn copy with the
 * WAL out of step — then pulled; a directory or any other file comes over with rsync; a
 * command runs here with the environment's ssh prefix in `$OUTPOST_SSH`, for the case neither
 * covers. A Postgres project adds a kind rather than a special case.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { environmentByName } from '../config.mjs'
import { sshRun, sshTarget, sshWrapper } from '../environments.mjs'

export const KINDS = Object.freeze(['sqlite-backup', 'rsync', 'command'])

/** Ten minutes: a backup over the LAN of a database measured in gigabytes still fits. */
const COPY_TIMEOUT_MS = 10 * 60 * 1000

function run(cmd, args, { cwd, env, log, timeout = COPY_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${cmd} did not finish in ${timeout / 60000} minutes`))
    }, timeout)
    let last = ''
    const relay = (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (!line.trim()) continue
        last = line
        log?.(`  ${line}`)
      }
    }
    child.stdout.on('data', relay)
    child.stderr.on('data', relay)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(last || `${cmd} exited ${code}`))
    })
  })
}

/** Shell-quote one argument for a remote command line. */
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`

/**
 * Pull one source into `checkoutDir`. Returns `{ to, bytes }` with `to` absolute. Everything
 * it needs from the environment is resolved here, so a missing key or host fails with a
 * sentence naming it rather than an ssh error three steps later.
 */
export async function copySource(source, { checkoutDir, workspaceId, log }) {
  const kind = String(source.kind || '')
  if (!KINDS.includes(kind)) throw new Error(`Unknown data kind "${kind}"`)
  const to = path.resolve(checkoutDir, String(source.to || '').trim() || path.basename(String(source.from || 'data')))
  if (!to.startsWith(checkoutDir + path.sep)) throw new Error(`Data must land inside the checkout, not at ${to}`)
  await fsp.mkdir(path.dirname(to), { recursive: true })

  const env = source.env ? await environmentByName(source.env) : null
  if (kind !== 'command' && !env) throw new Error(`No environment named "${source.env}"`)

  if (kind === 'sqlite-backup') {
    const from = String(source.from || '').trim()
    if (!from) throw new Error('A sqlite-backup source needs a path on the host')
    const tmp = `/tmp/outpost-${workspaceId}-${path.basename(to)}`
    log?.(`sqlite3 backup of ${from} on ${env.name}`)
    // `.backup` takes a consistent snapshot through SQLite's own API, WAL included.
    await sshRun(env, `command -v sqlite3 >/dev/null || { echo "sqlite3 is not installed on this host" >&2; exit 2; }; sqlite3 ${q(from)} ".backup ${tmp}"`, {
      timeout: COPY_TIMEOUT_MS,
    })
    try {
      const { args, target } = await sshTarget(env)
      const scpArgs = args.map((a) => (a === '-p' ? '-P' : a)) // scp spells the port flag differently
      log?.(`Pulling ${tmp} → ${path.relative(checkoutDir, to)}`)
      await run('scp', ['-q', ...scpArgs, `${target}:${tmp}`, to], { log })
    } finally {
      await sshRun(env, `rm -f ${q(tmp)}`, { timeout: 20000 }).catch(() => {})
    }
  } else if (kind === 'rsync') {
    const from = String(source.from || '').trim()
    if (!from) throw new Error('An rsync source needs a path on the host')
    const { args, target } = await sshTarget(env)
    const rsh = ['ssh', ...args].map(q).join(' ')
    log?.(`rsync ${env.name}:${from} → ${path.relative(checkoutDir, to)}`)
    await run('rsync', ['-az', '--no-owner', '--no-group', '-e', rsh, `${target}:${from}`, to], { log })
  } else {
    const cmd = String(source.from || '').trim()
    if (!cmd) throw new Error('A command source needs a command')
    const extra = {}
    if (env) {
      // One word, no quoting: `$OUTPOST_SSH hostname` runs `hostname` on the environment.
      extra.OUTPOST_SSH = await sshWrapper(env)
      extra.OUTPOST_ENV_HOST = env.host
      extra.OUTPOST_ENV_USER = env.user
    }
    extra.OUTPOST_DATA_TO = to
    log?.(`$ ${cmd}`)
    await run('/bin/bash', ['-lc', cmd], { cwd: checkoutDir, env: extra, log })
  }

  let bytes = 0
  try {
    bytes = (await fsp.stat(to)).size
  } catch {
    /* a command source may have produced a directory, or nothing; the step still ran */
  }
  return { to, bytes }
}

const BEGIN = '# >>> outpost — written per chat, do not edit this block'
const END = '# <<< outpost'

/**
 * `.env.local` in the checkout: the env vars that point the app at its copies, in a block
 * Outpost owns and replaces whole. Lines outside the block are a person's and are kept.
 */
export async function writeEnvLocal(checkoutDir, vars) {
  const file = path.join(checkoutDir, '.env.local')
  let current = ''
  try {
    current = await fsp.readFile(file, 'utf8')
  } catch {
    /* none yet */
  }
  const kept = current.includes(BEGIN) ? current.replace(new RegExp(`${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}\\n?`), '') : current
  const entries = Object.entries(vars).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
  if (!entries.length) {
    if (kept !== current) await fsp.writeFile(file, kept)
    return
  }
  const block = [BEGIN, ...entries.map(([k, v]) => `${k}=${dotenvValue(v)}`), END, ''].join('\n')
  // Owner-only: a repo's Environment can put a credential in it (environment.mjs).
  await fsp.writeFile(file, `${kept.replace(/\n*$/, kept ? '\n\n' : '')}${block}`, { mode: 0o600 })
  await fsp.chmod(file, 0o600).catch(() => {})
}

/**
 * A value as dotenv reads it back unchanged. Bare when it is plain; single-quoted otherwise,
 * which dotenv takes literally and Next's expansion leaves alone — a password with `$`, `#`
 * or a space was cut short or expanded when written bare. Double quotes only for a value
 * that has a single quote or a newline, with what they would interpret escaped.
 */
function dotenvValue(v) {
  const s = String(v ?? '')
  if (/^[A-Za-z0-9_./:@,+=-]*$/.test(s)) return s
  if (!/['\n\r]/.test(s)) return `'${s}'`
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/\r?\n/g, '\\n')}"`
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
