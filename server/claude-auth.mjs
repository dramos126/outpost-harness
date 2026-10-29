/**
 * How the sessions Outpost starts sign in to Claude (docs/proposals/settings.md, phase 5).
 *
 * Until this, every chat ran on the CLI login in this host's `~/.claude` — the one credential
 * Outpost depended on that it did not hold, and that an export could not carry. Settings ›
 * Integrations › Claude takes one of two, for the whole machine:
 *
 * - a **subscription** token, the long-lived one `claude setup-token` prints (`sk-ant-oat…`),
 *   handed to the CLI as `CLAUDE_CODE_OAUTH_TOKEN`;
 * - an **API key** (`sk-ant-api…`), billed per token, handed over as `ANTHROPIC_API_KEY`.
 *
 * Kept in the store as `claude`, its kind in `settings.json` (`integrations.claude`), so an
 * export names it and a new machine re-enters it with the other secrets. With neither, no chat
 * starts: a container never gets this host's own login (containers/index.mjs).
 *
 * It reaches a session through an environment file beside the store (`claude.env`, 0600) that
 * every session unit reads at its start — not through the unit's `Environment=`, which
 * `systemctl show` prints to anyone on the box, and not on the launcher's record, which is
 * written to disk and would replay a token since replaced on every restart. Switching takes
 * effect at each session's next start or restart.
 *
 * The session process holds this credential — it must, to call Claude — so a command it runs
 * could print it. That was already so through the credentials file in `~/.claude`; it is the
 * one credential a session cannot be kept from (integrations.md).
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { readSettings, saveIntegrations } from './config.mjs'
import { SECRETS_DIR, addToken, listSecrets, removeSecret, tokenValue } from './secrets/index.mjs'

export const CLAUDE_BIN = process.env.OUTPOST_CLAUDE_BIN || 'claude'
const SECRET = 'claude'
/** Read by every session unit at its start (`EnvironmentFile=-`, so a missing one is no error). */
export const CLAUDE_ENV_FILE = path.join(SECRETS_DIR, 'claude.env')

const VAR = Object.freeze({ subscription: 'CLAUDE_CODE_OAUTH_TOKEN', api: 'ANTHROPIC_API_KEY' })

/** Which kind a pasted credential is, by the prefix Anthropic gives each; '' for neither. */
export function claudeKindOf(token) {
  const t = String(token || '').trim()
  if (/^sk-ant-oat/.test(t)) return 'subscription'
  if (/^sk-ant-api/.test(t)) return 'api'
  return ''
}

/**
 * What the page draws: which kind is saved, and its end. Never the value. The kind is the
 * stored token's own, read off its prefix, not the settings' word for it: an import can bring
 * settings that say "API key" to a store holding a subscription token.
 */
export async function claudeAuthView() {
  const { integrations } = await readSettings()
  const c = integrations.claude || {}
  const s = (await listSecrets()).find((x) => x.name === c.secret && x.kind === 'token')
  const kind = s ? claudeKindOf(await tokenValue(c.secret)) : ''
  return { kind, configured: Boolean(kind), hint: s?.hint || '', named: Boolean(c.secret) }
}

/**
 * The variables a CLI started by Outpost gets: one, or none when nothing is saved.
 * The variable is chosen by the token itself, so a subscription token is never handed over as
 * an API key because a settings file said so.
 */
export async function claudeEnv() {
  const { integrations } = await readSettings()
  const c = integrations.claude || {}
  if (!c.secret) return {}
  const value = await tokenValue(c.secret)
  const kind = claudeKindOf(value)
  return kind ? { [VAR[kind]]: value } : {}
}

/**
 * Write the environment file from what is saved, or remove it when nothing is. Called on
 * every save, after an import, and as the server starts, so the file never says other than
 * the store and the settings do.
 */
export async function writeClaudeEnvFile() {
  const vars = await claudeEnv()
  const lines = Object.entries(vars).map(([k, v]) => `${k}=${v}`)
  if (!lines.length) {
    await fsp.rm(CLAUDE_ENV_FILE, { force: true })
    return
  }
  await fsp.mkdir(path.dirname(CLAUDE_ENV_FILE), { recursive: true, mode: 0o700 })
  const tmp = `${CLAUDE_ENV_FILE}.tmp`
  await fsp.writeFile(tmp, lines.join('\n') + '\n', { mode: 0o600 })
  await fsp.rename(tmp, CLAUDE_ENV_FILE)
}

/**
 * Save a pasted credential — its kind read off its prefix, so there is nothing to choose and
 * nothing to choose wrong — or remove it (`clear`). Answers the view.
 */
export async function saveClaudeAuth({ token = '', clear = false } = {}) {
  const { integrations } = await readSettings()
  if (clear) {
    await removeSecret(SECRET).catch(() => {})
    await saveIntegrations({ ...integrations, claude: { secret: '', kind: '' } })
  } else {
    const t = String(token || '').trim()
    const kind = claudeKindOf(t)
    if (!kind) throw new Error('That is neither a subscription token (sk-ant-oat…, from `claude setup-token`) nor an API key (sk-ant-api…)')
    await addToken(SECRET, t)
    await saveIntegrations({ ...integrations, claude: { secret: SECRET, kind } })
  }
  await writeClaudeEnvFile()
  return claudeAuthView()
}

// ── Sign in with Claude: `claude setup-token`, driven from the page ─────────────────────

const TERMINAL = path.join(path.dirname(new URL(import.meta.url).pathname), 'shell', 'terminal.py')
/** A sign-in nobody finishes is ended after this long. */
const SIGNIN_TTL_MS = 10 * 60 * 1000
let signin = null

/** A terminal's output as plain text: escape sequences out, hyperlinks' targets kept. */
const plain = (s) =>
  s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, ' ')
    .replace(/\x1b[()][A-Za-z0-9]|\x1b[78=>]|\x1b./g, '')

function endSignIn() {
  if (!signin) return
  clearTimeout(signin.timer)
  try {
    signin.child.stdin.end()
    signin.child.kill('SIGKILL')
  } catch {
    /* already gone */
  }
  signin = null
}

/** Wait until `test(output)` answers something, the program ends, or `ms` pass. */
function waitFor(test, ms) {
  const s = signin
  return new Promise((resolve) => {
    const tick = () => {
      if (!s || signin !== s) return resolve({ ended: true })
      const hit = test(s.out)
      if (hit) return resolve({ hit })
      if (s.closed) return resolve({ ended: true })
      if (Date.now() > deadline) return resolve({ timeout: true })
      setTimeout(tick, 200)
    }
    const deadline = Date.now() + ms
    tick()
  })
}

/**
 * Start `claude setup-token` on a hidden terminal and answer the link it gives for signing
 * in: the owner opens it, signs in to their Claude account, and is shown a code
 * (`finishClaudeSignIn`). Nothing is opened on this machine (`BROWSER` is a no-op), and the
 * terminal is wide so the link and the token each come out on one line.
 */
export async function startClaudeSignIn() {
  endSignIn()
  const env = { HOME: process.env.HOME || '', PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', TERM: 'xterm-256color', BROWSER: 'true', DISABLE_AUTOUPDATER: '1', LANG: process.env.LANG || 'C.UTF-8' }
  const child = spawn('python3', [TERMINAL, '50', '1000', CLAUDE_BIN, 'setup-token'], { env, cwd: SECRETS_DIR, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })
  signin = { child, out: '', closed: false, timer: setTimeout(endSignIn, SIGNIN_TTL_MS) }
  const s = signin
  child.stdout.on('data', (d) => (s.out += d))
  child.stderr.on('data', (d) => (s.out += d))
  child.stdio[3].on('error', () => {})
  child.stdin.on('error', () => {})
  child.on('close', () => (s.closed = true))
  child.on('error', () => (s.closed = true))
  const r = await waitFor((out) => /https:\/\/[^\s\x1b\x07]*oauth\/authorize[^\s\x1b\x07]*/.exec(out)?.[0], 45000)
  if (!r.hit) {
    const said = plain(s.out).replace(/\s+/g, ' ').trim().slice(-300)
    endSignIn()
    console.warn(`[outpost] Claude sign-in: no link — ${said || 'nothing said'}`)
    return { ok: false, error: r.timeout ? 'claude setup-token gave no sign-in link' : `claude setup-token ended: ${said || 'nothing said'}` }
  }
  console.warn('[outpost] Claude sign-in: link given, waiting for the code')
  return { ok: true, url: r.hit }
}

/**
 * Give the started sign-in the code the owner was shown, catch the token it prints, and save
 * it as Outpost's Claude sign-in. The token goes from the program to the store; it is never
 * answered to the page, or anywhere else.
 */
export async function finishClaudeSignIn(code) {
  const c = String(code || '').trim()
  if (!signin) {
    console.warn('[outpost] Claude sign-in: a code came with no sign-in under way')
    return { ok: false, error: 'No sign-in is under way (Outpost may have restarted, or it was over ten minutes) — tap Sign in with Claude again' }
  }
  if (!c) return { ok: false, error: 'Paste the code Claude showed you' }
  const from = signin.out.length
  // The code, then Enter on its own a moment later. Written together, a real code (90-odd
  // characters) arrives as one chunk the program takes for a paste, Enter included, and it
  // sat showing the masked code until the wait ran out — the owner's second try, 2026-10-04.
  // A short test code had gone through, which is why the first test passed.
  signin.child.stdin.write(c)
  await new Promise((r) => setTimeout(r, 400))
  if (!signin) return { ok: false, error: 'The sign-in ended while the code was being typed — tap Sign in with Claude again' }
  signin.child.stdin.write('\r')
  // The token, or the program's own refusal — it stays open after one ("Press Enter to retry"),
  // so waiting for it to end would sit out the whole minute on a mistyped code.
  const r = await waitFor((out) => {
    const text = plain(out.slice(from))
    const token = /sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{20,}/.exec(text)?.[0]
    if (token) return { token }
    // Only the program's own refusal ends it early — it waits at "Press Enter to retry" after
    // one. A looser test (any "error" or "failed") could end a sign-in that was working.
    if (/OAuth error|Press Enter to retry/i.test(text)) return { refused: true }
    return null
  }, 90000)
  const said = plain(signin?.out.slice(from) || '')
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[token]')
    // The program echoes the code masked, but its last characters can show through; the code
    // is single-use, and still not for a log.
    .replace(/\*{4,}\S*/g, '[code]')
    .split(c)
    .join('[code]')
    .replace(/\s+/g, ' ')
    .replace(/Press Enter to retry\.?/i, '')
    .trim()
    .slice(-300)
  endSignIn()
  if (!r.hit?.token) {
    console.warn(`[outpost] Claude sign-in: no token — ${r.timeout ? 'timed out; ' : ''}${said || 'nothing said'}`)
    return { ok: false, error: `${said ? `Claude said: ${said}` : 'No token came back'} — tap Sign in with Claude to try again` }
  }
  const view = await saveClaudeAuth({ token: r.hit.token })
  console.warn(`[outpost] Claude sign-in: token saved (${view.kind}, ending ${view.hint})`)
  return { ok: true, integration: view }
}

/**
 * Run the CLI once with the credential chats get, and see it answer: the binary is there, the
 * credential works, and the model is reachable — the whole path, not a guess at one part.
 * Haiku and one word, so a Test costs next to nothing.
 */
export async function testClaude() {
  const env = await claudeEnv()
  const via = env.CLAUDE_CODE_OAUTH_TOKEN ? 'the subscription token' : env.ANTHROPIC_API_KEY ? 'the API key' : "this machine's own Claude login"
  // The host's own key or token must not stand in for the one under test.
  const base = { ...process.env }
  delete base.ANTHROPIC_API_KEY
  delete base.CLAUDE_CODE_OAUTH_TOKEN
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let child
    try {
      child = spawn(CLAUDE_BIN, ['-p', 'Answer with the single word OK.', '--model', 'haiku', '--output-format', 'text'], {
        cwd: SECRETS_DIR,
        env: { ...base, ...env, DISABLE_AUTOUPDATER: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      resolve({ ok: false, via, error: String(e?.message || e) })
      return
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), 90000)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, via, error: e.code === 'ENOENT' ? 'The claude program is not on this machine’s PATH' : String(e.message) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const said = out.trim()
      if (code === 0 && said) resolve({ ok: true, via, answer: said.slice(0, 80) })
      else resolve({ ok: false, via, error: (err.trim() || said || `claude exited ${code}`).split('\n').slice(-2).join(' ').slice(0, 300) })
    })
  })
}
