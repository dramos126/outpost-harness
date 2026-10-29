/**
 * The instance's settings: `~/.outpost/config/settings.json`.
 *
 * The second of the two config files (the catalogue is the first): environments Outpost can
 * copy data from, and whatever the later phases add — storage roots, aging, defaults. Free of
 * secrets by rule: an environment names the *key* it uses, and the key lives in the secret
 * store. That is what makes this file exportable with the catalogue and re-importable on
 * another box (docs/proposals/harness.md, *Config is split*).
 *
 * Same discipline as the catalogue: read on change by mtime, written through a temp file, a
 * malformed file refused rather than overwritten.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { CONFIG_DIR } from './workspaces/catalogue.mjs'
import { normaliseCustom } from './workspaces/push-steps.mjs'

const FILE = path.join(CONFIG_DIR, 'settings.json')
const VERSION = 1

let cache = { mtimeMs: -1, settings: null }

const str = (v) => (typeof v === 'string' ? v.trim() : '')

/** Idle after this many days; deleted this many days after the archive, if clean and pushed; a disk budget, 0 for none. */
const AGING_DEFAULTS = Object.freeze({ endIdleHours: 6, idleDays: 14, deleteDays: 5, diskBudgetGB: 0 })

/**
 * When the conversation header calls a chat's context large (ui-conversation.md): orange from `warnTokens`
 * or `warnShare` of the model's window, red from `alertTokens` or `alertShare`, whichever comes
 * first. Every request re-sends the whole context, so a long chat's size is most of what it
 * costs (usage.md); these say when to start a fresh one.
 */
const CONTEXT_DEFAULTS = Object.freeze({ warnTokens: 200000, warnShare: 0.5, alertTokens: 400000, alertShare: 0.8 })

/**
 * How the page looks (ui.md): a preset of colour tokens, or `system` for graphite or paper by
 * the device's light/dark; an accent over the preset's (`''` keeps the preset's); and the UI and
 * mono font families, `system` for the stylesheet's stacks. Held here rather than in each
 * browser so every tab and device paints the same and an export carries it (setup.md).
 */
const APPEARANCE_PRESETS = Object.freeze(['graphite', 'paper', 'midnight', 'ember', 'system'])
const APPEARANCE_DEFAULTS = Object.freeze({ preset: 'graphite', accent: '', font: 'system', mono: 'system', width: 'wide' })
/** Reading width, the log's column cap (ui-settings.md): a name the page maps to a length, never a length itself. */
const APPEARANCE_WIDTHS = Object.freeze(['comfortable', 'wide', 'full'])

/**
 * How hard the fence around a chat's container is drawn (docs/modules/launchers.md). Each is off
 * by its safe default until the owner has watched it work on the live host, because none can be
 * proven on a machine without Podman:
 * - `mounts`: `wide` mounts the whole of `~/.claude`, `~/.claude.json` and each mirror writable
 *   (a chat can edit the CLI's hooks, the owner's memory, every other chat's transcript and the
 *   trust record); `narrow` gives the chat a config home of its own and mounts the governance
 *   files read-only.
 * - `network`: `host` shares the host's network namespace (a chat reaches everything on the
 *   host's loopback and LAN); `private` is a network of its own with only Outpost's port mapped
 *   back and declared ports published.
 * - `bash`: `ask` prompts the person for a Bash command outside the allowlist (today); `free`
 *   lets Bash run without asking, and is refused unless `mounts` is `narrow` and `network`
 *   `private` — the mounts and the missing credentials are the fence that makes it safe, not the
 *   prompt. `portRange` is the host ports declared ports are published to, one firewall rule.
 */
const CONTAINER_DEFAULTS = Object.freeze({ mounts: 'wide', network: 'host', bash: 'ask', portFrom: 41000, portTo: 41999 })

/**
 * `mounts`/`network`/`bash` each to a known word, the port range to two whole ports in order.
 * **`bash: 'free'` is honoured only with `mounts: 'narrow'` and `network: 'private'`** — the
 * guard is here so nothing downstream can enable free Bash in a chat that is still wide open.
 */
function normaliseContainers(raw) {
  const pick = (v, ok, d) => (ok.includes(str(v)) ? str(v) : d)
  const port = (v, d) => (Number.isInteger(Number(v)) && Number(v) >= 1024 && Number(v) <= 65535 ? Number(v) : d)
  const mounts = pick(raw?.mounts, ['wide', 'narrow'], CONTAINER_DEFAULTS.mounts)
  const network = pick(raw?.network, ['host', 'private'], CONTAINER_DEFAULTS.network)
  let bash = pick(raw?.bash, ['ask', 'free'], CONTAINER_DEFAULTS.bash)
  if (bash === 'free' && !(mounts === 'narrow' && network === 'private')) bash = 'ask'
  let portFrom = port(raw?.portFrom, CONTAINER_DEFAULTS.portFrom)
  let portTo = port(raw?.portTo, CONTAINER_DEFAULTS.portTo)
  if (portTo < portFrom) [portFrom, portTo] = [portTo, portFrom]
  return { mounts, network, bash, portFrom, portTo }
}

/**
 * What "push" means for a chat's work, unless its repo says otherwise (catalogue `push`):
 * `main` — merge the latest main in, then land the branch on main; `remote` — merge main in,
 * then push the work branch alone and leave main as it is; `custom` — merge main in, push the
 * work branch, then carry out the steps the owner's sentence was read as (`custom: { sentence,
 * steps }`, workspaces/push-steps.mjs) (docs/proposals/settings.md, phase 2).
 */
export const PUSH_MODES = Object.freeze(['main', 'remote', 'custom'])

/**
 * `{ mode, custom? }`. `custom` without steps that can be carried out falls back to `main`;
 * a custom sentence is kept while another mode is chosen, so choosing it again is not
 * writing and testing it again.
 */
function normalisePush(raw) {
  const custom = normaliseCustom(raw?.custom)
  const mode = PUSH_MODES.includes(str(raw?.mode)) && (str(raw.mode) !== 'custom' || custom) ? str(raw.mode) : 'main'
  return custom ? { mode, custom } : { mode }
}

const empty = () => ({
  environments: [],
  aging: { ...AGING_DEFAULTS },
  context: { ...CONTEXT_DEFAULTS },
  // Null until somebody saves one: the page keeps the choice it cached in its own browser
  // rather than being repainted to the default by a server that was never told.
  appearance: null,
  integrations: { github: { secret: '' }, jenkins: { url: '', user: '', secret: '', notifySecret: '' }, claude: { secret: '', kind: '' } },
  git: { name: '', email: '' },
  push: { mode: 'main' },
  // How hard the container fence is drawn (launchers.md); every field safe by default.
  containers: { ...CONTAINER_DEFAULTS },
  // Whether a restart is worth a Discord message (resilience.md). The webhook itself is a
  // secret, `discord-webhook` in the store; this file names no secret it does not need to.
  notify: { onRestart: false },
})

/** Names of secrets and a URL, never values: the file stays exportable (setup.md). */
function normaliseIntegrations(raw) {
  return {
    github: { secret: str(raw?.github?.secret) },
    // `notifySecret`: the token Jenkins presents when it posts a build's result (integrations-ci.md).
    jenkins: { url: str(raw?.jenkins?.url).replace(/\/+$/, ''), user: str(raw?.jenkins?.user), secret: str(raw?.jenkins?.secret), notifySecret: str(raw?.jenkins?.notifySecret) },
    // How chats sign in to Claude (claude-auth.mjs): a subscription token or an API key.
    claude: { secret: str(raw?.claude?.secret), kind: ['subscription', 'api'].includes(str(raw?.claude?.kind)) ? str(raw.claude.kind) : '' },
  }
}

function normaliseAging(raw) {
  const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d)
  return {
    endIdleHours: n(raw?.endIdleHours, AGING_DEFAULTS.endIdleHours),
    idleDays: n(raw?.idleDays, AGING_DEFAULTS.idleDays),
    deleteDays: n(raw?.deleteDays, AGING_DEFAULTS.deleteDays),
    diskBudgetGB: n(raw?.diskBudgetGB, AGING_DEFAULTS.diskBudgetGB),
  }
}

/** Token counts are whole and positive; a share is a fraction of the window, above 0 and at most 1. */
function normaliseContext(raw) {
  const tokens = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 1 ? Math.round(Number(v)) : d)
  const share = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) <= 1 ? Number(v) : d)
  return {
    warnTokens: tokens(raw?.warnTokens, CONTEXT_DEFAULTS.warnTokens),
    warnShare: share(raw?.warnShare, CONTEXT_DEFAULTS.warnShare),
    alertTokens: tokens(raw?.alertTokens, CONTEXT_DEFAULTS.alertTokens),
    alertShare: share(raw?.alertShare, CONTEXT_DEFAULTS.alertShare),
  }
}

/**
 * A value that cannot be used keeps its default. The accent is `#rrggbb` and a family a plain
 * name, because the page writes both into a CSS custom property: anything wider is a way to
 * inject a declaration into every tab.
 */
function normaliseAppearance(raw) {
  const preset = APPEARANCE_PRESETS.includes(str(raw?.preset)) ? str(raw.preset) : APPEARANCE_DEFAULTS.preset
  const accent = /^#[0-9a-f]{6}$/i.test(str(raw?.accent)) ? str(raw.accent).toLowerCase() : APPEARANCE_DEFAULTS.accent
  const family = (v) => (/^[A-Za-z0-9][A-Za-z0-9 _-]{0,59}$/.test(str(v)) && str(v).toLowerCase() !== 'system' ? str(v) : 'system')
  const width = APPEARANCE_WIDTHS.includes(str(raw?.width)) ? str(raw.width) : APPEARANCE_DEFAULTS.width
  return { preset, accent, font: family(raw?.font), mono: family(raw?.mono), width }
}

/**
 * One thing a chat may do on a host (server/hosts.mjs): `read` the files under an absolute
 * path, or `run` one fixed command, never more than it says. Named, so a chat asks for it by
 * name and the owner reads the list as a list of permissions. Null for one that is not whole.
 */
function normaliseAction(raw) {
  const name = str(raw?.name)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const kind = raw?.kind === 'read' || raw?.kind === 'run' ? raw.kind : ''
  let target = str(raw?.target)
  if (!name || !kind || !target) return null
  if (kind === 'read') {
    if (!target.startsWith('/')) return null
    target = path.posix.normalize(target).replace(/(.)\/+$/, '$1')
  }
  return { name, kind, target }
}

function normaliseEnvironment(raw) {
  const name = str(raw?.name)
  const host = str(raw?.host)
  if (!name || !host) return null
  const port = Number(raw.port) || 22
  // What a chat may do there; none until the owner writes some, and a repo has to name the
  // host before any of its chats can use them (integrations-hosts.md).
  const seen = new Set()
  const actions = (Array.isArray(raw.actions) ? raw.actions : []).map(normaliseAction).filter((a) => a && !seen.has(a.name) && seen.add(a.name))
  return { name, host, user: str(raw.user) || 'root', port, key: str(raw.key), actions }
}

function normalise(raw) {
  const s = empty()
  s.environments = (Array.isArray(raw?.environments) ? raw.environments : []).map(normaliseEnvironment).filter(Boolean)
  s.aging = normaliseAging(raw?.aging)
  s.context = normaliseContext(raw?.context)
  s.appearance = raw?.appearance ? normaliseAppearance(raw.appearance) : null
  s.integrations = normaliseIntegrations(raw?.integrations)
  // Who commits in a workspace: written into every mirror's config (workspaces.md).
  s.git = { name: str(raw?.git?.name), email: str(raw?.git?.email) }
  s.push = normalisePush(raw?.push)
  s.containers = normaliseContainers(raw?.containers)
  s.notify = { onRestart: raw?.notify?.onRestart === true }
  return s
}

/** The container fence settings, with the `free`-Bash guard applied (`normaliseContainers`). */
export async function saveContainers(raw) {
  const s = await readSettings()
  const containers = normaliseContainers(raw)
  await writeSettings({ ...s, containers })
  return containers
}

/**
 * The instance-wide push default, `{ mode, custom? }`. A `custom` given replaces the one
 * kept; none given keeps it. The caller has already held a new sentence to its Test
 * (workspaces/custom-push.mjs `customForSave`).
 */
export async function savePushDefault(raw) {
  const s = await readSettings()
  const push = normalisePush({ mode: raw?.mode, custom: raw?.custom || s.push.custom })
  await writeSettings({ ...s, push })
  return push
}

export async function readSettings() {
  let stat
  try {
    stat = await fsp.stat(FILE)
  } catch {
    cache = { mtimeMs: -1, settings: empty() }
    return cache.settings
  }
  if (stat.mtimeMs === cache.mtimeMs && cache.settings) return cache.settings
  try {
    const raw = JSON.parse(await fsp.readFile(FILE, 'utf8'))
    cache = { mtimeMs: stat.mtimeMs, settings: normalise(raw) }
  } catch (err) {
    throw new Error(`${FILE} is not readable: ${err.message}`)
  }
  return cache.settings
}

export async function writeSettings(settings) {
  const next = normalise(settings)
  await fsp.mkdir(CONFIG_DIR, { recursive: true })
  const tmp = `${FILE}.tmp`
  await fsp.writeFile(tmp, JSON.stringify({ version: VERSION, ...next }, null, 2) + '\n')
  await fsp.rename(tmp, FILE)
  cache = { mtimeMs: -1, settings: null }
  return next
}

export async function listEnvironments() {
  return (await readSettings()).environments
}

export async function environmentByName(name) {
  return (await listEnvironments()).find((e) => e.name === name) || null
}

export async function saveEnvironment(raw) {
  const env = normaliseEnvironment(raw)
  if (!env) throw new Error('An environment needs a name and a host')
  const s = await readSettings()
  const environments = s.environments.filter((e) => e.name !== env.name)
  environments.push(env)
  environments.sort((a, b) => a.name.localeCompare(b.name))
  await writeSettings({ ...s, environments })
  return env
}

export async function saveAging(raw) {
  const s = await readSettings()
  const aging = normaliseAging(raw)
  await writeSettings({ ...s, aging })
  return aging
}

export async function saveContextLimits(raw) {
  const s = await readSettings()
  const context = normaliseContext(raw)
  await writeSettings({ ...s, context })
  return context
}

/** The appearance as saved; what `GET /api/appearance` answers before any save. */
export async function readAppearance() {
  return (await readSettings()).appearance || { ...APPEARANCE_DEFAULTS }
}

export async function saveAppearance(raw) {
  const s = await readSettings()
  const appearance = normaliseAppearance(raw)
  await writeSettings({ ...s, appearance })
  return appearance
}

export async function saveGitIdentity(raw) {
  const s = await readSettings()
  const git = { name: str(raw?.name), email: str(raw?.email) }
  await writeSettings({ ...s, git })
  return git
}

export async function saveIntegrations(raw) {
  const s = await readSettings()
  const integrations = normaliseIntegrations(raw)
  await writeSettings({ ...s, integrations })
  return integrations
}

export async function deleteEnvironment(name) {
  const s = await readSettings()
  const environments = s.environments.filter((e) => e.name !== name)
  if (environments.length === s.environments.length) return false
  await writeSettings({ ...s, environments })
  return true
}
