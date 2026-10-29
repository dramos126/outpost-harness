/**
 * A container per chat (docs/proposals/containers.md; launchers.md has the run).
 *
 * Every chat runs in one — a plain chat too — and there is no falling back to this machine
 * (`containerPlan`): rootless Podman must be ready, and Outpost must hold a Claude credential
 * (Integrations › Claude), because a container must not get this machine's own login — that
 * is half of what the fence is for. Either missing, the chat does not start and says why.
 *
 * Inside, everything is at its host path (spikes 1 and 2, 2026-10-04): the workspace folder
 * (checkouts, `mcp.json`, data), each repo's mirror (a worktree's commits are written there,
 * and the CLI keys memory on it), the read-only data copies, `~/.claude` (transcripts land
 * where the scan reads; the hooks come with the user settings) and `~/.claude.json` (trust,
 * which preparation seeds). The host's login file is masked, and the credential comes in as one
 * variable from the session unit's environment. The host's network is shared, or under the
 * private network forwarded port by port (`PRIVATE_NETWORK`), so `127.0.0.1:5274` — hooks,
 * tools, approvals — is the same address inside either way.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { CLAUDE_BIN, claudeEnv } from '../claude-auth.mjs'
import { readSettings } from '../config.mjs'
import { PORT } from '../auth.mjs'
import { PACKAGE_NAME } from '../workspaces/catalogue.mjs'
import { SECRETS_DIR } from '../secrets/index.mjs'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const BASE_DIR = path.join(here, 'base')
/**
 * One package cache for every container on the machine, mounted at `~/.cache` inside: npm,
 * yarn and corepack keep theirs there. A container is thrown away after each run, and without
 * this every chat's install downloaded every package again. Shared between chats, so it is
 * the one thing one chat's container can write that another's reads — packages, not work.
 */
const CACHE_DIR = process.env.OUTPOST_CONTAINER_CACHE || path.join(os.homedir(), '.outpost', 'container-cache')
/** Where the claude program sits inside every container. */
export const CLAUDE_IN = '/usr/local/bin/claude'

/** The hooks' port, installed into the CLI's settings (tools/install-hooks.mjs; api.md). */
const HOOKS_PORT = 5274

/**
 * The `--network` of a `private` chat: a pasta network of its own with `-T` forwarding the
 * container's own `127.0.0.1:<port>` to the host's, for the hooks' port and the MCP's (`PORT`,
 * the same one on the live host; a scratch server's differs and both are needed). Only those
 * ports: every other port on the host's loopback is closed from inside, and the gateway does not
 * reach the host (both checked on the live host, Podman 4.9.3). `-T` is in every passt; the
 * `--map-host-loopback,127.0.0.1` this replaced is not in the passt Ubuntu 24.04 ships
 * (0.0~git20240220), whose pasta refused it and every private chat died at start (2026-10-05).
 * One `-T` per port: podman splits a `pasta:` value on commas into separate words.
 */
export const FORWARDED_PORTS = [...new Set([HOOKS_PORT, PORT])]
export const PRIVATE_NETWORK = `pasta:${FORWARDED_PORTS.map((p) => `-T,${p}`).join(',')}`

const exists = (p) => fsp.stat(p).then(() => true, () => false)

/**
 * The CLI's folder name for a cwd under `~/.claude/projects`: every `/` and `.` becomes `-`
 * (harnesses.md decodes the same way). The transcript for a session lands there, and the scan
 * reads it from the host, so a narrow chat's project dir is mounted at this exact path.
 */
const encodeProjectDir = (dir) => dir.replace(/[/.]/g, '-')

/**
 * A chat's own `~/.claude.json` for narrow mounts: not the host's (which carries every repo's
 * trust, the account and every cache), just what the CLI needs to run unattended — onboarding
 * marked done and trust seeded for the session's cwd and each checkout and its mirror, which
 * is what keeps the permission policy from being ignored as "an untrusted project" (trust.mjs)
 * and the first Enter from answering the trust dialog. An existing copy is topped up, never
 * rewritten, so a resume keeps the caches the CLI has since written into it; a repo added to a
 * running chat used to stay untrusted inside, its copy written once at the chat's start.
 */
async function seedChatConfig(file, { repos, workspaceDir, mirrorPath, cwd }) {
  let config = { hasCompletedOnboarding: true, projects: {} }
  if (await exists(file)) {
    try {
      config = JSON.parse(await fsp.readFile(file, 'utf8'))
    } catch {
      // Mid-write by the CLI, or not ours to understand: left as it is rather than clobbered.
      return
    }
  }
  config.projects ||= {}
  const keys = [cwd, ...(repos.length ? repos.flatMap((r) => [r.path, mirrorPath(r.id)]) : [workspaceDir])]
  let changed = !(await exists(file))
  for (const k of keys) {
    if (config.projects[k]?.hasTrustDialogAccepted) continue
    config.projects[k] = { ...config.projects[k], hasTrustDialogAccepted: true }
    changed = true
  }
  if (changed) await fsp.writeFile(file, JSON.stringify(config, null, 2))
}

/** What a command hook may name for a container to be handed: a script, never data. */
const HOOK_SCRIPT = /\.(mjs|cjs|js|ts|sh|py)$/

/**
 * The scripts the owner's command hooks run (`settings.json`), each an absolute path that is a
 * real file, to be mounted read-only at that path. The hooks reach a container with the
 * settings, but a script outside the mounts did not: `guard-git.mjs` and `claims.mjs` in
 * Outpost's own checkout failed with MODULE_NOT_FOUND on every Bash call and every edit in every
 * chat, so the concurrency guards (concurrency.md) guarded nothing there — not the bulk `git add`,
 * the stash, the amend. Only the file itself, never its folder; never a link, nor anything
 * under `~/.ssh`, `~/.aws` or the secret store, whatever a hook names (setup.md). Unreadable
 * settings are no scripts.
 */
export async function hookScripts(settingsFile, home = os.homedir()) {
  let settings
  try {
    settings = JSON.parse(await fsp.readFile(settingsFile, 'utf8'))
  } catch {
    return []
  }
  const fenced = [path.join(home, '.ssh'), path.join(home, '.aws'), path.resolve(SECRETS_DIR)]
  const inside = (p, dir) => {
    const rel = path.relative(dir, p)
    return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel))
  }
  const out = new Set()
  for (const entries of Object.values(settings?.hooks || {})) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      for (const h of Array.isArray(entry?.hooks) ? entry.hooks : []) {
        if (h?.type !== 'command' || typeof h.command !== 'string') continue
        for (const word of h.command.split(/\s+/)) {
          const p = word.replace(/^['"]|['"]$/g, '')
          if (!path.isAbsolute(p) || !HOOK_SCRIPT.test(p) || fenced.some((d) => inside(path.resolve(p), d))) continue
          if ((await fsp.lstat(p).catch(() => null))?.isFile()) out.add(path.resolve(p))
        }
      }
    }
  }
  return [...out].sort()
}

/** Rootless Podman and the `newuidmap` it needs: `{ ok, version }` or `{ ok: false, why }`. */
export async function runtimeReady() {
  const version = await execFileAsync('podman', ['--version'], { timeout: 15000 })
    .then(({ stdout }) => stdout.trim())
    .catch(() => '')
  if (!version) return { ok: false, why: 'Podman is not installed' }
  const uidmap = await execFileAsync('newuidmap', ['--help'], { timeout: 5000 }).then(() => true, (err) => err?.code !== 'ENOENT')
  if (!uidmap) return { ok: false, why: 'uidmap is not installed, which rootless Podman needs' }
  return { ok: true, version }
}

/**
 * Outpost's base image, built here the first time it is needed and tagged by its
 * Containerfile's content. Answers the tag. A build takes a minute; it is said in the log.
 *
 * `packages` are Debian packages the chat's repos ask for (catalogue.mjs `packages`): the base's
 * Containerfile with one more `apt-get install` line, tagged by that content, so the same list on
 * any machine is the same image and a changed list is a new one. Names are checked again here,
 * since they become part of a build step.
 */
export async function baseImage(log = async () => {}, packages = []) {
  const wanted = [...new Set(packages.filter((p) => PACKAGE_NAME.test(p)))].sort()
  let file = await fsp.readFile(path.join(BASE_DIR, 'Containerfile'), 'utf8')
  // The man folder first: the slim base has none, and a JDK's install fails creating its links
  // there (the openjdk-on-slim bug), which is the package this was added for.
  if (wanted.length) file += `RUN mkdir -p /usr/share/man/man1 \\\n && apt-get update \\\n && apt-get install -y --no-install-recommends ${wanted.join(' ')} \\\n && rm -rf /var/lib/apt/lists/*\n`
  const name = wanted.length ? 'outpost-base-plus' : 'outpost-base'
  const tag = `localhost/${name}:${createHash('sha256').update(file).digest('hex').slice(0, 12)}`
  const have = await execFileAsync('podman', ['image', 'exists', tag], { timeout: 30000 }).then(() => true, () => false)
  if (have) return tag
  await log(`Building the container image ${tag}${wanted.length ? ` with ${wanted.join(', ')}` : ''} — the first time on this machine takes a minute`)
  // A context of its own for the extended file; the base's folder is never written to.
  const dir = wanted.length ? await fsp.mkdtemp(path.join(os.tmpdir(), 'outpost-image-')) : BASE_DIR
  try {
    if (wanted.length) await fsp.writeFile(path.join(dir, 'Containerfile'), file)
    await execFileAsync('podman', ['build', '--quiet', '-t', tag, dir], { timeout: 20 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 })
  } catch (err) {
    throw new Error(`Could not build the container image${wanted.length ? ` with ${wanted.join(', ')}` : ''}: ${String(err?.stderr || err?.message || err).trim().split('\n').slice(-2).join(' ')}`)
  } finally {
    if (wanted.length) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  return tag
}

/**
 * Whether `PRIVATE_NETWORK` works on this machine: `{ ok: true }` or `{ ok: false, why }`. A
 * throwaway container from the base image reaches Outpost the way a chat's hooks and MCP would,
 * so a pasta that refuses the option, or a forward that goes nowhere, is found when the switch
 * is turned on rather than as a chat that never starts. Any HTTP answer is a pass.
 */
export async function privateNetworkReady() {
  const ready = await runtimeReady()
  if (!ready.ok) return ready
  let image
  try {
    image = await baseImage()
  } catch (err) {
    return { ok: false, why: err.message }
  }
  const args = ['run', '--rm', '--network', PRIVATE_NETWORK, '--entrypoint', 'curl', image, '-sS', '-o', '/dev/null', '-m', '10', `http://127.0.0.1:${PORT}/`]
  try {
    await execFileAsync('podman', args, { timeout: 60000 })
    return { ok: true }
  } catch (err) {
    // Podman's own `Error:` line and its cause, not the pasta usage text that follows them.
    const lines = String(err?.stderr || err?.message || err).split('\n').filter((l) => l.trim())
    const at = lines.findIndex((l) => l.startsWith('Error:') || l.startsWith('curl:'))
    return { ok: false, why: `The private network does not work here: ${(at >= 0 ? lines.slice(at, at + 2) : lines.slice(0, 2)).join(' ')}` }
  }
}

/**
 * Whether this chat runs in a container, and with what: `{ use: true, image, mounts }`, or
 * `{ use: false, why }` — the sentence its workspace shows. `repos` are the manifest's
 * entries (`{ id, path }`), `recipes` the catalogue's for them; `workspaceDir` the chat's
 * folder; `cwd` where its session runs (the manifest's `primary`); `mirrorPath` and
 * `datasetsDir` where the mirrors and read copies live.
 */
export async function containerPlan({ repos, recipes, workspaceDir, cwd = repos[0]?.path || workspaceDir, mirrorPath, datasetsDir, log, signIn = true }) {
  // Every chat, with no exceptions and no falling back to this machine (the owner's,
  // 2026-10-04): a chat started with no repo used to run on the host, gained a repo through
  // /addRepo, and looked containerised while it had the run of the machine. Without the runtime
  // or a sign-in of Outpost's own, the chat does not start, and says why. `signIn: false` is for
  // a repo's setup, which runs no session and needs no sign-in.
  const runtime = await runtimeReady()
  if (!runtime.ok) return { use: false, why: `${runtime.why}, and every chat runs in a container — see Settings › General › About this machine` }
  if (signIn) {
    const env = await claudeEnv()
    if (!env.CLAUDE_CODE_OAUTH_TOKEN && !env.ANTHROPIC_API_KEY)
      return { use: false, why: "No Claude sign-in for chats — Settings › Integrations › Claude › Sign in with Claude. A chat never uses this machine's own login." }
  }
  // The image is the first repo's, if it names one; a plain chat, or a repo that names none,
  // gets Outpost's base, with every package the chat's repos ask for (`baseImage`).
  const first = recipes.find(Boolean)
  const image = first?.containerImage || (await baseImage(log, recipes.flatMap((r) => r?.packages || [])))
  const home = os.homedir()
  // How hard the fence is drawn (docs/modules/launchers.md, config.mjs). `mounts: wide` is every
  // chat today (the whole of `~/.claude`, `~/.claude.json` and each mirror writable); `narrow`
  // gives the chat a config state of its own and mounts the governance read-only. `network`
  // (returned for the launcher to apply in `podmanArgs`) is `host` or a private network. Both
  // off by default until watched on the live host, since no part can be proven without Podman.
  const cfg = (await readSettings()).containers
  const narrow = cfg.mounts === 'narrow'
  const bin = await fsp.realpath(await which(CLAUDE_BIN))
  // A home of its own first, so everything mounted under it lands on top: inside, the user's
  // home was there but not writable, and the first install that wrote `~/.npm` failed
  // (2026-10-04). It lives in the workspace, so it goes with the chat.
  const ownHome = path.join(workspaceDir, 'home')
  await fsp.mkdir(ownHome, { recursive: true })
  const mounts = [{ src: ownHome, dst: home }, { src: bin, dst: CLAUDE_IN, ro: true }, { src: workspaceDir }]
  for (const r of repos) {
    const mirror = mirrorPath(r.id)
    if (await exists(mirror)) {
      mounts.push({ src: mirror })
      // The mirror stays writable — a worktree commits objects and moves its branch's ref
      // there, and there is no mount granularity that protects one branch's ref from another in
      // one `refs/heads` (so a chat can still write another branch of *this* repo, shared only
      // by this repo's chats). What is closed, under either mounts setting, is the sharp edge:
      // `config` and `hooks` read-only, so a chat cannot point `core.hooksPath`/`core.fsmonitor`,
      // a filter or a merge driver at a script of its own that Outpost's next git in this mirror
      // or a checkout of it (git.mjs) would then run as the owner. Wide too: unlike the rest of
      // what narrow closes, this one runs the chat's code on the host, not in another box. What
      // a session loses is `git config` and `git remote` for the repo (`--global` is its own
      // home's, and still works); a branch it makes still is made, untracked.
      for (const sub of ['config', 'hooks']) {
        const p = path.join(mirror, sub)
        if (await exists(p)) mounts.push({ src: p, ro: true })
      }
    }
    // A repo added to be read has no data of its own.
    if (r.oneOff) continue
    // Made now if it is not there yet: the plan comes before the repo's data is synced, and a
    // folder missing at the container's start could never appear inside it later.
    const data = path.join(datasetsDir, r.id)
    await fsp.mkdir(data, { recursive: true })
    mounts.push({ src: data, ro: true })
  }
  await fsp.mkdir(CACHE_DIR, { recursive: true })
  mounts.push({ src: CACHE_DIR, dst: path.join(home, '.cache') })
  const dotClaude = path.join(home, '.claude')
  if (narrow) {
    // Wide mounts the whole of `~/.claude` writable, so a chat can edit the CLI's hooks and
    // settings, the owner's memory and every other chat's transcript, and `~/.claude.json`, the
    // trust record. Narrow does the opposite: `~/.claude` is *not* mounted at all, so inside it
    // is the chat's own empty folder (under `ownHome`) that the CLI writes its scratch into —
    // todos, tasks, backups, shell snapshots — reaching none of the host's and hiding every
    // other chat's transcript outright (better than read-only; nothing in the box needs them —
    // the scan, memory_search and the token report all run on the host). Two things are bridged
    // back in:
    // - the owner's `settings.json` read-only, because that is where the hooks live and hooks
    //   are the only source of live state (hooks.md) — read-only so a chat cannot disable or
    //   rewrite the hook that reports it, nor the permissions it governs;
    const hostSettings = path.join(dotClaude, 'settings.json')
    if (await exists(hostSettings)) mounts.push({ src: hostSettings, ro: true })
    // - the project dir for each checkout's cwd, writable, at its host path so the scan still
    //   finds the transcript the CLI writes there (harnesses.md keys on the encoded cwd). The
    //   session's own cwd always: a chat started with no repo runs in the workspace folder for
    //   good, and once /addRepo gave it one, its remount mounted only the checkout's — the
    //   resume found no conversation and the chat stopped (bugs-fixed.md).
    const cwds = new Set([cwd, ...(repos.length ? repos.filter((x) => !x.oneOff).map((r) => r.path) : [workspaceDir])])
    for (const dir of cwds) {
      const src = path.join(dotClaude, 'projects', encodeProjectDir(dir))
      await fsp.mkdir(src, { recursive: true })
      mounts.push({ src })
    }
    // - each repo's memory folder, writable: the CLI keys memory on the mirror's path, not the
    //   checkout's, so without it a narrow chat read none of what other chats saved and what it
    //   saved died with its container. Writable by the owner's choice (2026-10-05: the repos are
    //   theirs, and memory lost is quick answers lost) — a chat can plant text every later chat
    //   on the repo reads at its start; only the memory folder, never the project dir around it.
    for (const r of repos.filter((x) => !x.oneOff)) {
      const src = path.join(dotClaude, 'projects', encodeProjectDir(mirrorPath(r.id)), 'memory')
      await fsp.mkdir(src, { recursive: true })
      mounts.push({ src })
    }
    // `~/.claude.json` is rewritten constantly (trust, caches, onboarding), so it cannot be
    // read-only. The chat gets a copy of its own under its home — seeded with just the trust the
    // CLI needs for its checkouts and mirrors, and onboarding done — rather than the host's,
    // which carries every repo's trust, the account and every cache. No host mount: the file
    // sits in `ownHome`, which is already `$HOME` inside. The login is an env variable
    // (claude-auth.mjs), so no credentials file is present to mask.
    await seedChatConfig(path.join(ownHome, '.claude.json'), { repos, workspaceDir, mirrorPath, cwd })
  } else {
    mounts.push({ src: dotClaude })
    if (await exists(path.join(home, '.claude.json'))) mounts.push({ src: path.join(home, '.claude.json') })
    // The host's own login stays out of the box: the file is covered with an empty one. Only
    // where it exists — a mount point made inside the mounted folder would leave an empty file
    // on the host, which the host's CLI would then read as no login.
    const creds = path.join(dotClaude, '.credentials.json')
    if (await exists(creds)) mounts.push({ src: '/dev/null', dst: creds, ro: true })
  }
  // Either mounts setting: the scripts the owner's command hooks run, read-only where the
  // hooks name them, or every one fails inside (`hookScripts`).
  for (const src of await hookScripts(path.join(dotClaude, 'settings.json'), home)) mounts.push({ src, ro: true })
  // Narrow: the policy (`.claude/settings.local.json`, workspaces/policy.mjs) is where the deny
  // list and — with free Bash — the Bash allow live, so a chat that could rewrite it could lift
  // its own fence. The checkout is writable (the session edits code), so the policy is pinned
  // read-only over itself: a `:ro` bind the session cannot write through whatever a permission
  // rule says. Written before this by preparation, so the file is there to pin.
  if (narrow) {
    const checkouts = repos.length ? repos.map((r) => r.path) : [workspaceDir]
    for (const dir of checkouts) {
      const policy = path.join(dir, '.claude', 'settings.local.json')
      if (await exists(policy)) mounts.push({ src: policy, ro: true })
    }
  }
  // Every mount point under the home is made now, as the user. Left to Podman, it makes them
  // inside the home's folder as the container's root — a subordinate id on the host — and the
  // user cannot delete them: a deleted chat's folder was left with `home/.outpost/…` that `rm`
  // was refused on (2026-10-04).
  for (const m of mounts.slice(1)) {
    const dst = m.dst || m.src
    const rel = path.relative(home, dst)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue
    const at = path.join(ownHome, rel)
    const isFile = (await fsp.stat(m.src).catch(() => null))?.isFile() || m.src === '/dev/null'
    await fsp.mkdir(isFile ? path.dirname(at) : at, { recursive: true })
    if (isFile) await fsp.writeFile(at, '', { flag: 'a' })
  }
  // npm keeps its cache in `~/.npm` unless told; pointed at the shared cache with the rest.
  const env = { npm_config_cache: path.join(home, '.cache', 'npm') }
  // The ports each repo declares (catalogue `ports`), flattened with their repo so the panel can
  // group them and a clash between two repos' internal ports can be named. The launcher hands
  // these to `assignHostPorts` and publishes the result; nothing here reaches for a host port.
  const ports = []
  for (const r of repos.filter((x) => !x.oneOff)) {
    const rec = recipes.find((x) => x && x.id === r.id)
    for (const p of rec?.ports || []) ports.push({ repo: r.id, repoName: rec?.name || r.id, label: p.label, internal: p.port })
  }
  return { use: true, image, mounts, env, network: cfg.network, ports }
}

/**
 * Remove a folder a container may have written into as its own root: files owned by a
 * subordinate id, which the user cannot delete. `podman unshare` runs the `rm` as that root.
 * A no-op where Podman is not installed — nothing of a container's can be there.
 */
/**
 * Make again any transcript folder a stored plan mounts that has gone since it was made. A
 * checkout the session never worked in leaves its project dir empty, and empty project dirs do
 * not survive on the host (the CLI's own cleanup, it seems); a restart reuses the plan, and
 * podman refused the resume with "statfs …: no such file or directory" (bugs-fixed.md). Only
 * folders under `~/.claude/projects`: those are the plan's own empty dirs, and a missing file
 * mount must stay an error rather than come back as a folder.
 */
export async function ensureProjectMounts(mounts = []) {
  const projects = path.join(os.homedir(), '.claude', 'projects') + path.sep
  for (const m of mounts) {
    if (m?.src?.startsWith(projects)) await fsp.mkdir(m.src, { recursive: true })
  }
}

export async function removeContainerFiles(dir) {
  if (!(await exists(dir))) return
  await execFileAsync('podman', ['unshare', 'rm', '-rf', dir], { timeout: 120000 }).catch(() => {})
}

/** The program's full path, so the mount is of the file and not a name on a PATH. */
async function which(bin) {
  if (bin.includes('/')) return bin
  const { stdout } = await execFileAsync('sh', ['-c', `command -v ${bin}`], { timeout: 5000 })
  return stdout.trim()
}

/**
 * The `podman run` words that wrap a session's CLI: `-i` for the FIFO, the host's network and
 * user, every mount at its path, the variables passed through by name from the unit's
 * environment (a variable the unit does not have stays out), and labels so a workspace's
 * containers can be found and removed with it.
 */
export function podmanArgs({ name, image, mounts, workdir, passEnv, env = {}, labels = {}, network = 'host', publish = [] }) {
  const args = ['run', '--rm', '-i', '--replace', '--name', name, '--userns', 'keep-id', '-w', workdir]
  // `host` shares the host's network namespace, so `127.0.0.1:5274` is the same address inside
  // and nothing is published — but the container reaches everything on the host's loopback and
  // LAN. `private` is a pasta network of its own (`PRIVATE_NETWORK`): only Outpost's ports on
  // the container's `127.0.0.1` reach the host's, so the hooks and MCP keep posting to
  // `127.0.0.1:5274` unchanged and auth.md's bind-safety is untouched (still a loopback Host and
  // the workspace token). Outbound goes out over the host's routes; the LAN is not firewalled.
  // Each declared port is published to its assigned host port (containers/ports.mjs).
  if (network === 'private') args.push('--network', PRIVATE_NETWORK)
  else args.push('--network', 'host')
  for (const p of publish) args.push('-p', `${p.host}:${p.internal}`)
  for (const [k, v] of Object.entries(labels)) args.push('--label', `${k}=${v}`)
  for (const k of passEnv) args.push('-e', k)
  // Set here, not passed through: what the plan says every container on the machine gets.
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`)
  for (const m of mounts) args.push('-v', `${m.src}:${m.dst || m.src}${m.ro ? ':ro' : ''}`)
  args.push(image)
  return args
}

/**
 * Run one command in a throwaway container from the chat's plan — a repo's setup command:
 * that is the repo's own code (an install runs every dependency's scripts), and it belongs
 * inside the fence with the chat, not on this machine. Same image and mounts as the session,
 * so what it installs is in the checkout the session sees, built against the libraries it
 * runs on. Lines of output go to `onLine`; resolves on exit 0, rejects with the exit code.
 */
export function runInContainer({ plan, workdir, cmd, workspaceId, env = {}, timeoutMs, onLine = () => {} }) {
  const name = `outpost-setup-${workspaceId}-${Date.now().toString(36)}`
  const args = podmanArgs({
    name,
    image: plan.image,
    mounts: plan.mounts,
    workdir,
    passEnv: ['HOME', ...Object.keys(env)],
    env: plan.env || {},
    labels: { 'outpost.workspace': workspaceId },
    // Setup needs outbound (an install) but nothing inbound, so it takes the plan's network and
    // publishes no port of its own.
    network: plan.network || 'host',
  })
  return new Promise((resolve, reject) => {
    const child = spawn('podman', [...args, 'bash', '-lc', cmd], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      execFile('podman', ['rm', '-f', name], () => {})
      child.kill('SIGKILL')
      reject(new Error(`"${cmd}" did not finish in ${Math.round(timeoutMs / 60000)} minutes`))
    }, timeoutMs)
    const relay = (chunk) => {
      for (const line of String(chunk).split('\n')) if (line.trim()) onLine(line)
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
      else reject(new Error(`"${cmd}" exited ${code} in the container`))
    })
  })
}

/**
 * Remove a workspace's session containers left from an earlier start, before the next one. Each
 * start names its container afresh, so `--replace` never reaches the last one, and stopping the
 * session's unit can leave the container running under conmon with its published ports still
 * bound: a restore then failed "Failed to bind port … Address already in use" (2026-10-05).
 * Only containers labelled `outpost.session` — a repo's setup runs beside the session and stays.
 */
export async function removeSessionContainers(workspaceId) {
  try {
    const { stdout } = await execFileAsync('podman', ['ps', '-a', '--filter', `label=outpost.workspace=${workspaceId}`, '--format', '{{.ID}} {{index .Labels "outpost.session"}}'], { timeout: 30000 })
    const ids = stdout.split('\n').map((l) => l.trim().split(/\s+/)).filter(([id, session]) => id && session).map(([id]) => id)
    if (ids.length) await execFileAsync('podman', ['rm', '-f', ...ids], { timeout: 60000 })
    return ids.length
  } catch {
    return 0
  }
}

/**
 * Remove a workspace's containers, running or not — its delete takes them with it — and wait
 * until they are gone. The folder is removed after: removed while a container was still
 * shutting down, Podman's own cleanup made its mount points again, and a deleted chat left
 * an empty `home/.outpost/…` behind (2026-10-04).
 */
export async function removeContainers(workspaceId) {
  const list = async () => {
    const { stdout } = await execFileAsync('podman', ['ps', '-aq', '--filter', `label=outpost.workspace=${workspaceId}`], { timeout: 30000 })
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  }
  try {
    const ids = await list()
    if (ids.length) await execFileAsync('podman', ['rm', '-f', ...ids], { timeout: 60000 })
    for (let i = 0; i < 20 && (await list()).length; i++) await new Promise((r) => setTimeout(r, 500))
    return ids.length
  } catch {
    return 0
  }
}
