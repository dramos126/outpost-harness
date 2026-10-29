/**
 * What Outpost writes into a checkout so a session there asks less: the permission policy in
 * `.claude/settings.local.json`, and the pointer file that tells a multi-repo chat about its
 * other checkouts.
 *
 * The policy is the lever for "fewer prompts", and it is a statement of trust in a tree
 * Outpost made — not a sandbox (docs/proposals/harness.md, *Isolation is a directory*). Three
 * layers, merged: Outpost's floor (the workspace's own paths, auto-updates off), the recipe's
 * rules, and nothing else. The merge is the hooks installer's rule: entries Outpost wrote are
 * replaced in place, anything else in the file is kept, and a malformed file is refused rather
 * than clobbered.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

/** Marks the rules Outpost wrote, so a rewrite replaces them and leaves a person's alone. */
const OURS = '__outpost'

/**
 * Written into every chat's policy, on top of the recipe's own (docs/modules/launchers.md).
 * The CLI gates a command by the least-allowed part and a deny beats an allow, so these refuse
 * — not prompt — the ways a session would bypass an Outpost tool or reach for a credential.
 *
 * What they catch, checked against the real CLI (2.1.287) with Bash allowed, deny on top: the
 * plain command, extra whitespace (`git  push`), an env prefix (`FOO=1 git push`, `env git
 * push`), `command git push`, `timeout 5 git push`, a chain that contains one (`a && git push`,
 * `a; git push`), a substitution (`$(git push)`, backticks) and a pipe (`git push 2>&1 | …`).
 * What they do **not** catch: a different argument shape the glob misses (`git -C . push`), an
 * absolute path (`/usr/bin/git push`), or a nested shell (`bash -c "git push"`, `sh -c …`,
 * `eval …`, `xargs git`). So the deny list is a courtesy, not the fence: the fence is the narrow
 * mounts and that no git credential is ever in the container (launchers.md) — without one a
 * push cannot succeed however it is spelled, and the push/PR tools run on the host. The doc must
 * not claim these denies are airtight; they are not.
 */
export const DEFAULT_DENY = [
  // Landing work goes through Outpost's `push` tool, never the session's own git (workspaces-git.md).
  'Bash(git push)',
  'Bash(git push *)',
  // Reaching for a credential directly.
  'Bash(git credential)',
  'Bash(git credential *)',
  'Bash(gh auth)',
  'Bash(gh auth *)',
  // Reaching for a key over the wire.
  'Bash(ssh *)',
  'Bash(scp *)',
  'Bash(sftp *)',
  // Reading the keys and the login themselves (the `~` form the CLI expands; `//` its absolute).
  'Read(~/.ssh/**)',
  'Read(~/.aws/**)',
  'Read(~/.claude/.credentials.json)',
]

/**
 * The floor: read, edit and write anywhere under the workspace. `acceptEdits` already covers
 * the session's own cwd; this is what makes the *other* checkouts of a multi-repo chat
 * editable without a prompt each. `//` is the CLI's absolute-path form. `/tmp` too: sessions
 * reach for it out of habit despite `WORK_RULE`, and each prompt stalls the chat on the
 * approval bar. It is safe because every chat runs in its own container (launchers.md), whose
 * `/tmp` the host does not share.
 */
function floorRules(workspaceDir) {
  // `//` *replaces* the root slash in the CLI's syntax: `/tmp/x` is written `//tmp/x`.
  const p = `//${workspaceDir.replace(/^\/+/, '').replace(/\/+$/, '')}/**`
  return [p, '//tmp/**'].flatMap((q) => [`Read(${q})`, `Edit(${q})`, `Write(${q})`])
}

export async function writePolicy(checkoutDir, { workspaceDir, allow = [], deny = [] }) {
  const dir = path.join(checkoutDir, '.claude')
  const file = path.join(dir, 'settings.local.json')
  let current = {}
  try {
    current = JSON.parse(await fsp.readFile(file, 'utf8'))
    if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('not an object')
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`${file} is not valid JSON; not touching it`)
  }
  const perms = current.permissions && typeof current.permissions === 'object' ? current.permissions : {}
  const theirs = (list) => (Array.isArray(list) ? list.filter((r) => typeof r === 'string') : [])
  const ours = current[OURS] && typeof current[OURS] === 'object' ? current[OURS] : { allow: [], deny: [] }
  const strip = (list, mine) => list.filter((r) => !mine.includes(r))
  const nextAllow = [...new Set([...strip(theirs(perms.allow), ours.allow || []), ...floorRules(workspaceDir), ...allow])]
  // The default deny list is Outpost's floor for deny, beneath the recipe's: both are recorded
  // under `__outpost` so a rewrite replaces exactly them and a person's own denies are kept.
  const nextDeny = [...new Set([...strip(theirs(perms.deny), ours.deny || []), ...DEFAULT_DENY, ...deny])]
  const next = {
    ...current,
    permissions: { ...perms, allow: nextAllow, ...(nextDeny.length ? { deny: nextDeny } : {}) },
    // A session Outpost starts must not move the CLI under every other session on the box
    // (docs/proposals/harness.md, phase 0 results). Upgrading is a deliberate step.
    env: { ...(current.env && typeof current.env === 'object' ? current.env : {}), DISABLE_AUTOUPDATER: '1' },
    [OURS]: { allow: [...floorRules(workspaceDir), ...allow], deny: [...DEFAULT_DENY, ...deny] },
  }
  if (!nextDeny.length) delete next.permissions.deny
  await fsp.mkdir(dir, { recursive: true })
  const tmp = `${file}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(next, null, 2) + '\n')
  await fsp.rename(tmp, file)
  return file
}

/**
 * `--add-dir` lets a session touch another checkout but does not load that checkout's
 * `CLAUDE.md` (phase 0 results), so the primary checkout gets a `CLAUDE.local.md` — a file
 * the CLI reads beside `CLAUDE.md` and that git is told to ignore — naming the others and
 * asking the session to read their instructions before touching them.
 */
export async function writePointerFile(primaryDir, { workspaceName, others }) {
  const file = path.join(primaryDir, 'CLAUDE.local.md')
  if (!others.length) {
    await fsp.rm(file, { force: true })
    return null
  }
  const lines = [
    `# This chat's workspace`,
    ``,
    `This checkout belongs to the Outpost chat "${workspaceName}". The same chat has these other repos checked out, and you may read and edit them:`,
    ``,
    ...others.map((o) => `- **${o.name}** at \`${o.path}\` (${o.branch ? `branch \`${o.branch}\`` : `on the latest \`${o.base || 'main'}\`, no branch yet`}) — read \`${o.path}/CLAUDE.md\` before touching it.`),
    ``,
    `Each checkout is its own worktree. Call start_work before changing one, and commit in the checkout the change belongs to.`,
    ``,
  ]
  await fsp.writeFile(file, lines.join('\n'))
  return file
}

/**
 * The names `excludeGenerated` keeps out of every commit. `/temp/` is where sessions are told
 * to keep scratch work (`WORK_RULE`), so it must be ignored in every repo, not only the ones
 * whose own `.gitignore` says so.
 */
export const GENERATED = ['.claude/settings.local.json', 'CLAUDE.local.md', '.env.local', '/temp/']
