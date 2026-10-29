/**
 * What this machine has for Outpost and what it lacks (docs/proposals/settings.md, phase 5):
 * the new-machine path. An export carries the catalogue, the settings and the routines, and
 * every secret by name only (setup.md); on a new machine the import is the easy half, and the
 * other half was "now add the secrets they name" with nothing saying which.
 *
 * `missingOnThisMachine` reads what the settings and the catalogue name and says, a line each,
 * what is not here and where it is entered. `machineChecks` adds what chats need of the box
 * itself: the `claude` program, a way to sign in, and the hooks that are Outpost's only live
 * state (hooks.md). Both answer About this machine; the first answers an import too.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { readSettings } from './config.mjs'
import { listSecrets } from './secrets/index.mjs'
import { envSecretName, listRepos } from './workspaces/catalogue.mjs'
import { CLAUDE_BIN, claudeAuthView } from './claude-auth.mjs'
import { runtimeReady } from './containers/index.mjs'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const HOOKS_TEMPLATE = path.join(here, '..', 'templates', 'hooks', 'settings.json')
const CLI_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json')
const CLI_CREDENTIALS = path.join(os.homedir(), '.claude', '.credentials.json')
const WEBHOOK_SECRET = 'discord-webhook'

/**
 * Each thing the settings or a repo name that this machine does not have:
 * `{ what, where, optional? }`. `where` is the page and section it is entered in. A repo's
 * secret variable left blank on purpose is listed too — it is missing, whatever the reason.
 */
export async function missingOnThisMachine() {
  const settings = await readSettings()
  const repos = await listRepos()
  const secrets = new Map((await listSecrets()).map((s) => [s.name, s.kind]))
  const hosts = new Set(settings.environments.map((e) => e.name))
  const has = (name, kind) => secrets.get(name) === kind
  const out = []
  const i = settings.integrations
  if (i.github.secret && !has(i.github.secret, 'token')) out.push({ what: 'The GitHub token', where: 'Integrations › GitHub' })
  if (i.jenkins.secret && !has(i.jenkins.secret, 'token')) out.push({ what: "Jenkins's API token", where: 'Integrations › Jenkins' })
  if (i.jenkins.notifySecret && !has(i.jenkins.notifySecret, 'token')) out.push({ what: "Jenkins's notify token — make a new one and paste it into Jenkins", where: 'Integrations › Jenkins › Build results' })
  if (i.claude.secret && !has(i.claude.secret, 'token'))
    out.push({ what: `Claude's ${i.claude.kind === 'api' ? 'API key' : 'subscription token'} — until it is entered, chats use this machine's own login if it has one`, where: 'Integrations › Claude' })
  if (settings.notify.onRestart && !has(WEBHOOK_SECRET, 'token')) out.push({ what: 'The Discord webhook', where: 'General › Notifications' })
  for (const e of settings.environments) {
    if (e.key && !has(e.key, 'ssh-key')) out.push({ what: `Host ${e.name}'s key "${e.key}" — make a new one and put its public half on ${e.host}`, where: 'Integrations › Hosts' })
  }
  for (const r of repos) {
    const where = `Repos › ${r.name}`
    if (r.auth && r.auth !== '@machine' && !secrets.has(r.auth)) out.push({ what: `${r.name}: the key or token it is reached with, "${r.auth}"`, where: `${where} › Access` })
    for (const e of r.env || []) if (e.secret && !has(envSecretName(r.id, e.name), 'token')) out.push({ what: `${r.name}: ${e.name}`, where: `${where} › Environment` })
    for (const h of r.hosts || []) if (!hosts.has(h)) out.push({ what: `${r.name}: the host ${h}, which its chats may use`, where: 'Integrations › Hosts' })
    for (const s of r.dataSources || [])
      if (!hosts.has(s.host)) out.push({ what: `${r.name}: the host ${s.host}, where ${s.dataset}${s.source ? ` (${s.source})` : ''} comes from`, where: 'Integrations › Hosts' })
    for (const d of r.data || []) if (d.env && !hosts.has(d.env)) out.push({ what: `${r.name}: the host ${d.env}, a setup copy comes from`, where: 'Integrations › Hosts' })
  }
  return out
}

/** Whether the CLI's settings carry Outpost's hooks for every event the template installs. */
async function hooksInstalled() {
  let template
  try {
    template = JSON.parse(await fsp.readFile(HOOKS_TEMPLATE, 'utf8'))
  } catch {
    return { ok: false, missing: [], error: 'The hooks template is not in this checkout' }
  }
  let current = {}
  try {
    current = JSON.parse(await fsp.readFile(CLI_SETTINGS, 'utf8'))
  } catch {
    /* no settings yet: every event is missing */
  }
  // Ours is any hook that posts to `/api/hook` — tools/install-hooks.mjs's test, so a hook
  // installed with another port or host still counts as there.
  const ours = (entry) =>
    Array.isArray(entry?.hooks) &&
    entry.hooks.some((h) => (h?.type === 'http' && String(h.url || '').endsWith('/api/hook')) || (h?.type === 'command' && String(h.command || '').includes('/api/hook')))
  const missing = Object.keys(template.hooks || {}).filter((ev) => !(current.hooks?.[ev] || []).some(ours))
  return { ok: missing.length === 0, missing }
}

/**
 * What chats need of the box: `{ claude: { ok, version | error }, signIn: { ok, how },
 * hooks: { ok, missing } }`.
 */
export async function machineChecks() {
  let claude
  try {
    const { stdout } = await execFileAsync(CLAUDE_BIN, ['--version'], { timeout: 15000 })
    claude = { ok: true, version: stdout.trim().split('\n')[0] }
  } catch (err) {
    claude = { ok: false, error: err?.code === 'ENOENT' ? 'not installed — or not on the PATH Outpost runs with' : String(err?.message || err).split('\n')[0] }
  }
  const auth = await claudeAuthView()
  const hostLogin = await fsp
    .readFile(CLI_CREDENTIALS, 'utf8')
    .then((t) => Boolean(JSON.parse(t)?.claudeAiOauth?.accessToken))
    .catch(() => false)
  const signIn = auth.configured
    ? { ok: true, how: auth.kind === 'api' ? `an API key from Settings (ending ${auth.hint.replace(/^…/, '')})` : `a subscription token from Settings (ending ${auth.hint.replace(/^…/, '')})` }
    : hostLogin
      ? { ok: true, how: "this machine's own claude login — it does not travel; Integrations › Claude makes it a setting" }
      : { ok: false, how: 'none — enter a token under Integrations › Claude, or run claude once here and sign in' }
  return { claude, signIn, hooks: await hooksInstalled(), containers: await containerRuntime(auth.configured) }
}

/**
 * Whether chats can start here at all (docs/proposals/containers.md): every chat runs in a
 * container, so rootless Podman — and the `newuidmap` it needs, which a plain `podman` install
 * can lack and which needs sudo to add — and a Claude sign-in of Outpost's own.
 */
async function containerRuntime(signedIn) {
  const r = await runtimeReady()
  if (!r.ok) return { ok: false, how: `not ready — ${r.why}; no chat can start until it is: sudo apt install podman uidmap slirp4netns` }
  // Ready, but a container never gets this machine's login: without Outpost's own sign-in no
  // chat starts at all (containers/index.mjs).
  if (!signedIn) return { ok: false, how: `${r.version}, rootless — but no chat can start until a Claude sign-in is saved under Integrations › Claude` }
  return { ok: true, how: `${r.version}, rootless — every new chat runs in one` }
}
