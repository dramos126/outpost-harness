/**
 * Workspace trust, seeded before a session is launched into a freshly cloned repo.
 *
 * Claude Code asks "is this a project you trust?" the first time an interactive session
 * starts anywhere new, and the default answer is **exit**. That is fine for a human sitting
 * at a terminal and fatal for anything that types into a session it launched: the first
 * Enter picks "No, exit", and the session is gone before it ever reported anything. Waiting
 * for the `SessionStart` hook does not help — the hook never fires, because the session never
 * starts.
 *
 * There is no CLI flag for it. The dialog is skipped when stdout is not a TTY (`-p`, or piped
 * output), which is how every session Outpost starts now runs — so seeding is belt and braces
 * for those, and what keeps a `claude` started by hand in the same workspace from stopping at
 * the dialog (launchers.md). Writing the key by hand is the documented answer:
 *
 *   > set `projects["<path>"].hasTrustDialogAccepted` to `true` in `~/.claude.json`, where
 *   > `<path>` is the repository root, or the folder itself outside a repository.
 *
 * Two details that make the difference between this working and silently doing nothing:
 *
 *   - **The key is the git repository root, not the directory you launch in.** A session
 *     started in `repo/src` is keyed on `repo`. Writing the wrong path leaves an entry that
 *     never matches and a dialog that still appears.
 *   - **A worktree is keyed on two paths, and both are seeded.** CLI 2.1.285 answered to the
 *     worktree's own root (`--show-toplevel`); 2.1.287, launched in a worktree of a bare
 *     mirror, read and wrote the record keyed on the git *common* dir — the mirror — and
 *     showed its dialog with the worktree path trusted. Seeding both costs one extra entry
 *     and survives whichever the next version reads.
 *
 * Trusting a parent directory is deliberately not an option here: that form of trust covers
 * subdirectories *except* git repositories nested inside them, and every project is a clone.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Claude Code's own config. `CLAUDE_CONFIG_DIR` moves the whole config home. */
function configFile() {
  const dir = process.env.CLAUDE_CONFIG_DIR
  return dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json')
}

/** What a project entry looks like when the dialog writes one. */
const trustRecord = () => ({
  allowedTools: [],
  mcpContextUris: [],
  mcpServers: {},
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
  hasTrustDialogAccepted: true,
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false,
  exampleFiles: [],
})

/**
 * Every path a version of the CLI has keyed trust on for `dir`: the repository root first,
 * then the git common dir when that is somewhere else — a worktree's mirror or main checkout.
 * Both are seeded, because the two versions seen so far disagree (header).
 */
export async function trustKeysFor(dir) {
  const keys = []
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', '--show-toplevel', '--git-common-dir'], {
      timeout: 5000,
    })
    const [root, common] = stdout.split('\n').map((l) => l.trim())
    if (root) keys.push(path.resolve(root))
    if (common) {
      const abs = path.resolve(root || dir, common)
      // A plain checkout's common dir is its own `.git`, which is not a project key.
      if (!keys.includes(abs) && path.basename(abs) !== '.git') keys.push(abs)
    }
  } catch {
    /* not a repo, or no git — the directory itself is the key */
  }
  if (!keys.length) keys.push(path.resolve(dir))
  return keys
}

/**
 * Mark a directory trusted, if it is not already.
 *
 * Read-modify-write through a temp file, touching one key of one entry. This is the largest
 * write Outpost makes to anything Claude Code owns, and it grants read/edit/execute in that
 * directory without anyone being asked — so it belongs behind a deliberate action on a repo
 * the user chose, never as a side effect of a scan.
 *
 * Returns `{ ok, key, alreadyTrusted }`.
 */
export async function trustDirectory(dir) {
  const keys = await trustKeysFor(dir)
  const key = keys[0]
  const file = configFile()

  let config
  try {
    config = JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch (err) {
    // No config at all means Claude Code has never run as this user. Creating one here would
    // be writing a file whose full shape we do not know; better to say so than to guess.
    return {
      ok: false,
      key,
      error:
        err.code === 'ENOENT'
          ? `No ${file} yet — run 'claude' once and sign in before launching sessions from here`
          : `Could not read ${file}: ${err.message}`,
    }
  }

  if (!config.projects || typeof config.projects !== 'object') config.projects = {}
  if (keys.every((k) => config.projects[k]?.hasTrustDialogAccepted === true)) {
    return { ok: true, key, alreadyTrusted: true }
  }

  for (const k of keys) {
    config.projects[k] = { ...trustRecord(), ...(config.projects[k] || {}), hasTrustDialogAccepted: true }
  }

  const tmp = `${file}.outpost.tmp`
  try {
    await fsp.writeFile(tmp, JSON.stringify(config, null, 2))
    await fsp.rename(tmp, file)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    return { ok: false, key, error: `Could not write ${file}: ${err.message}` }
  }
  return { ok: true, key, alreadyTrusted: false }
}
