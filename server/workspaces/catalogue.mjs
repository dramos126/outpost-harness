/**
 * The catalogue: the repos Outpost knows, and the recipe for preparing a checkout of each.
 *
 * `~/.outpost/config/catalogue.json` — outside any checkout, because this repository is
 * published and the catalogue names your repos; and separate from the secret store that
 * phase 3 adds, because this file is the portable half of a setup (docs/proposals/harness.md,
 * *Config is split*). It holds no credential: `auth` names a secret, it never is one.
 *
 * Read on change by mtime rather than once, for the reason auth.md gives for the credentials
 * file: a settings page and a hand edit are both writers, and a cached copy written back over
 * a newer file destroys the newer one.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { normaliseCustom } from './push-steps.mjs'
import { MAX_PORTS } from '../containers/ports.mjs'

const execFileAsync = promisify(execFile)

export const CONFIG_DIR = process.env.OUTPOST_CONFIG || path.join(os.homedir(), '.outpost', 'config')
const FILE = path.join(CONFIG_DIR, 'catalogue.json')

const VERSION = 1

/** What every recipe field means, and what an absent one falls back to. */
export const RECIPE_DEFAULTS = Object.freeze({
  baseBranch: '', // '' = whatever the remote's HEAD points at
  branchTemplate: 'outpost/{slug}',
  setup: [], // shell commands, run in the checkout after it exists, in order
  allow: [], // permission rules written into the checkout's .claude/settings.local.json
  deny: [],
  permissionMode: '', // '' = Outpost's default
})

/**
 * The model a chat runs on when it is not given one: Opus, everywhere — the owner's, 2026-10-04.
 * A repo used to carry a model of its own; one default plus the choice per chat in New chat is
 * all that is wanted, and a per-repo override was one more place a model was decided unseen.
 * A catalogue saved with a `model` still loads; the field is dropped.
 */
export const DEFAULT_MODEL = 'opus'

let cache = { mtimeMs: -1, repos: [] }

const str = (v) => (typeof v === 'string' ? v.trim() : '')
const list = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : [])

/** A repo id is its name made safe for a directory: the mirror and every checkout are named by it. */
export function idFor(name) {
  return (
    String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 60) || ''
  )
}

/** The last path segment of a clone URL, without `.git` — what a repo is called when nobody says. */
export function nameFromUrl(url) {
  const m = /([^/:]+?)(?:\.git)?\/?$/.exec(String(url || '').trim())
  return m ? m[1] : ''
}

/**
 * A branch template that will make a valid, distinct name per chat. One with no placeholder
 * would give every chat the same branch (numbered apart by `freeBranchName`), and one ending
 * in a slash gives git a name it refuses — which is how a chat once failed with
 * `'outpost/webapp/' is not a valid branch name`. Repaired rather than refused:
 * the saved form shows what will actually be used.
 */
function branchTemplateOf(raw) {
  let t = str(raw).replace(/\/+$/, '').replace(/\/{2,}/g, '/')
  if (!t) return RECIPE_DEFAULTS.branchTemplate
  if (!/\{slug\}|\{id\}/.test(t)) t = `${t}/{slug}`
  return t
}

/**
 * A Debian package's name (Debian policy: lower case, digits, `+ - .`, two or more characters).
 * The names go into the image's `apt-get install` line, so anything else is dropped rather than
 * quoted: a name is never a way to put a command in the build.
 */
export const PACKAGE_NAME = /^[a-z0-9][a-z0-9.+-]{1,62}$/
const MAX_PACKAGES = 30

/** An environment variable's name: what a shell and a `.env` file both accept. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/**
 * A repo's Environment entries, `{ name, value, secret, locked }` — a secret's `value` never
 * kept here. A repeated or malformed name is dropped.
 */
function envEntries(raw) {
  const seen = new Set()
  const out = []
  for (const e of Array.isArray(raw) ? raw : []) {
    const name = str(e?.name)
    if (!ENV_NAME.test(name) || seen.has(name)) continue
    seen.add(name)
    const secret = e?.secret === true
    out.push({ name, value: secret ? '' : typeof e?.value === 'string' ? e.value : '', secret, locked: e?.locked === true })
  }
  return out
}

/**
 * The store's name for a repo's secret variable: `env-<repo>-<name>`, in the store's alphabet
 * and its forty-one characters. Readable in Keys and tokens, and the same every time.
 */
export const envSecretName = (repoId, name) => `env-${String(repoId).slice(0, 16)}-${String(name).toLowerCase().slice(0, 20)}`.replace(/-+$/, '')

function normalise(raw) {
  const url = str(raw?.url)
  const name = str(raw?.name) || nameFromUrl(url)
  const id = idFor(str(raw?.id) || name)
  if (!id || !url) return null
  const custom = normaliseCustom(raw.pushCustom)
  return {
    id,
    name,
    url,
    baseBranch: str(raw.baseBranch),
    branchTemplate: branchTemplateOf(raw.branchTemplate),
    setup: list(raw.setup),
    allow: list(raw.allow),
    deny: list(raw.deny),
    permissionMode: str(raw.permissionMode),
    // What to pull into a checkout before the session starts: `{ env, kind, from, to, envVar }`.
    data: (Array.isArray(raw.data) ? raw.data : [])
      .map((d) => ({ env: str(d?.env), kind: str(d?.kind), from: str(d?.from), to: str(d?.to), envVar: str(d?.envVar) }))
      .filter((d) => d.kind && (d.from || d.kind === 'command')),
    // The secret the mirror clones, fetches and pushes with. A name in the store, never a value.
    auth: str(raw.auth),
    // The tool groups a chat on this repo is offered (mcp/index.mjs TOOL_GROUPS); empty means the default.
    tools: list(raw.tools),
    // How a chat's work usually lands: `push` straight to the base, or `pr`. The panel offers both.
    finish: str(raw.finish) === 'pr' ? 'pr' : 'push',
    // What the `push` tool does for this repo: `main`, `remote` or `custom` (config.mjs
    // `PUSH_MODES`), or empty for the instance-wide default under Settings › Repos. `custom`
    // is the owner's sentence and the steps it was read as (push-steps.mjs); without steps
    // that can be carried out it is no choice at all, and the default applies.
    push: ['main', 'remote'].includes(str(raw.push)) || (str(raw.push) === 'custom' && custom) ? str(raw.push) : '',
    ...(custom ? { pushCustom: custom } : {}),
    // When a Jenkins build of a chat's work finishes, whether the chat is woken: `failure`
    // (empty means this), `always` or `never` (jenkins-results.mjs).
    jenkinsWake: ['always', 'never'].includes(str(raw.jenkinsWake)) ? str(raw.jenkinsWake) : '',
    // The Jenkins jobs a chat on this repo may use (integrations.mjs `jobAllowed`); a
    // multibranch job's name covers its branches. None means none: a chat's Jenkins tools
    // reach only jobs a repo it has names, so one repo's deploy is not another repo's to start.
    // Absent until chosen, which is how the repo's page tells "not chosen yet" (offer the jobs
    // that build it) from "chose none" (offer nothing) — the same empty list otherwise.
    ...(Array.isArray(raw.jenkinsJobs) ? { jenkinsJobs: list(raw.jenkinsJobs).map((j) => j.replace(/^\/+|\/+$/g, '')) } : {}),
    // The jobs whose failure, when no chat was waiting on the build, starts a chat on this repo
    // to find out why (jenkins-results.mjs `failureChats`) — a nightly run's, most often.
    jenkinsFailureChats: list(raw.jenkinsFailureChats).map((j) => j.replace(/^\/+|\/+$/g, '')),
    // The hosts (Settings › Integrations › Hosts) whose actions a chat on this repo may use —
    // none unless named here: a host can run the app the repo deploys (server/hosts.mjs).
    hosts: list(raw.hosts),
    // The repo's Environment: what every chat on it gets in `.env.local` (environment.mjs). A
    // plain entry keeps its value here; a secret's value is in the store, under
    // `envSecretName(id, name)`, and this file names it only — it stays exportable (setup.md).
    env: envEntries(raw.env),
    // Where each dataset the repo declares (its `.outpost/data.json`, datasets.mjs) comes from
    // on this machine: a host and a path, one per source for a snapshot.
    dataSources: (Array.isArray(raw.dataSources) ? raw.dataSources : [])
      .map((s) => ({ dataset: str(s?.dataset), source: str(s?.source), host: str(s?.host), path: str(s?.path) }))
      .filter((s) => s.dataset && s.host && s.path.startsWith('/')),
    // The image a chat's container starts from; empty is Outpost's own base (node, git, curl,
    // the build tools). Which box, not whether: every chat runs in one, and the per-repo
    // switch that was here went on 2026-10-04 (docs/proposals/containers.md). A catalogue that
    // still has `container` loads with it dropped.
    containerImage: str(raw.containerImage),
    // Debian packages added to Outpost's base for a chat on this repo (containers/index.mjs
    // `baseImage`): a JDK for a Kotlin repo, say. Built and tagged by Outpost on any machine, so
    // nothing is set up by hand on the host. Ignored when `containerImage` names an image.
    packages: list(raw.packages).filter((p) => PACKAGE_NAME.test(p)).slice(0, MAX_PACKAGES),
    // The ports a chat on this repo serves on, published from its private network to a host port
    // (containers/ports.mjs). Up to `MAX_PORTS`, each `{ label, port }` (the internal port). The
    // add-to-catalogue scan pre-fills these; the owner confirms or edits them. A whole number in
    // range, label defaulting to the port, duplicates by port dropped.
    ports: (() => {
      const seen = new Set()
      return (Array.isArray(raw.ports) ? raw.ports : [])
        .map((p) => ({ label: str(p?.label), port: Number(p?.port) }))
        .filter((p) => Number.isInteger(p.port) && p.port >= 1 && p.port <= 65535 && !seen.has(p.port) && seen.add(p.port))
        .map((p) => ({ label: p.label || `Port ${p.port}`, port: p.port }))
        .slice(0, MAX_PORTS)
    })(),
  }
}

async function load() {
  let stat
  try {
    stat = await fsp.stat(FILE)
  } catch {
    cache = { mtimeMs: -1, repos: [] }
    return cache.repos
  }
  if (stat.mtimeMs === cache.mtimeMs) return cache.repos
  try {
    const raw = JSON.parse(await fsp.readFile(FILE, 'utf8'))
    const repos = (Array.isArray(raw?.repos) ? raw.repos : []).map(normalise).filter(Boolean)
    cache = { mtimeMs: stat.mtimeMs, repos }
  } catch (err) {
    // A malformed file is refused, not clobbered: the next save would otherwise write an
    // empty catalogue over whatever somebody was in the middle of editing.
    throw new Error(`${FILE} is not readable: ${err.message}`)
  }
  return cache.repos
}

async function save(repos) {
  await fsp.mkdir(CONFIG_DIR, { recursive: true })
  const tmp = `${FILE}.tmp`
  await fsp.writeFile(tmp, JSON.stringify({ version: VERSION, repos }, null, 2) + '\n')
  await fsp.rename(tmp, FILE)
  cache = { mtimeMs: -1, repos: [] } // re-read on the next call, with the real mtime
}

export const listRepos = () => load()

export async function repoById(id) {
  return (await load()).find((r) => r.id === id) || null
}

/** Add or replace one entry. `id` is derived from the name on a new entry and kept on an edit. */
export async function saveRepo(raw) {
  const entry = normalise(raw)
  if (!entry) throw new Error('A repo needs a name and a clone URL')
  const repos = (await load()).filter((r) => r.id !== entry.id)
  repos.push(entry)
  repos.sort((a, b) => a.name.localeCompare(b.name))
  await save(repos)
  return entry
}

export async function deleteRepo(id) {
  const repos = await load()
  const next = repos.filter((r) => r.id !== id)
  if (next.length === repos.length) return false
  await save(next)
  return true
}

/**
 * Can this machine reach that URL? `ls-remote` with prompts off, so a URL that wants a
 * password fails in a second with a reason rather than hanging on a prompt nobody will see.
 * Answers the remote's default branch too, which is what an empty `baseBranch` means.
 */
export async function testRemote(url, env = {}) {
  const u = str(url)
  if (!u) return { ok: false, error: 'No URL' }
  try {
    const { stdout } = await execFileAsync('git', ['ls-remote', '--symref', u, 'HEAD'], {
      timeout: 20000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    })
    const m = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(stdout)
    return { ok: true, defaultBranch: m ? m[1] : '' }
  } catch (err) {
    const msg = String(err?.stderr || err?.message || err).trim().split('\n').slice(-1)[0]
    return { ok: false, error: msg || 'Could not reach that URL' }
  }
}
