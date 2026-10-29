#!/usr/bin/env node
/**
 * PreToolUse guard: refuse the git commands that let one session in a shared working tree
 * destroy another session's work.
 *
 * Reads a PreToolUse payload on stdin and answers with a `deny` decision, or says nothing
 * and lets the command run. The set it refuses is small and every entry is a command whose
 * blast radius is *the whole tree or the whole index* — `git add -A` sweeps up whatever the
 * session next door had staged, `git stash` hides it, `git checkout .` deletes it. Every one of
 * them has a narrow form that does the same job for the paths you actually own, and the
 * refusal names it.
 *
 * It is a guard, not a sandbox. Command substitution, a script file, a shell alias — any of
 * those get through, and that is fine: this exists to stop an accident, not an adversary.
 *
 * **Fails open, always.** Anything it cannot parse runs. The pre-commit half (claims.mjs) is
 * the net underneath this one, and it does not depend on parsing a shell command at all.
 *
 * The rules and their reasoning live in docs/modules/concurrency.md.
 */
const OVERRIDE = 'OUTPOST_ALLOW_SHARED_COMMIT'

/**
 * Split a command line into segments (one per `;` `&&` `||` `|` `&` or newline) and each
 * segment into tokens, honouring quotes. Quoting matters twice over: `git commit -m "add -A
 * later"` must not read as an `-A`, and `git add "."` must still read as a `.`.
 */
function segments(cmd) {
  const segs = []
  let cur = []
  let tok = ''
  let open = false // this token exists even if empty — it was quoted
  const endTok = () => {
    if (tok || open) cur.push(tok)
    tok = ''
    open = false
  }
  const endSeg = () => {
    endTok()
    if (cur.length) segs.push(cur)
    cur = []
  }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (c === '\\' && i + 1 < cmd.length) {
      tok += cmd[++i]
      continue
    }
    if (c === "'" || c === '"') {
      const q = c
      open = true
      while (++i < cmd.length && cmd[i] !== q) {
        if (q === '"' && cmd[i] === '\\' && i + 1 < cmd.length) i++
        tok += cmd[i]
      }
      continue
    }
    if (c === ';' || c === '&' || c === '|' || c === '\n') {
      endSeg()
      while (i + 1 < cmd.length && /[;&|\n]/.test(cmd[i + 1])) i++
      continue
    }
    if (/\s/.test(c)) {
      endTok()
      continue
    }
    tok += c
  }
  endSeg()
  return segs
}

const isAssignment = (t) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)

/** git's own options before the subcommand, and which of them eat the next token. */
const GIT_OPT_WITH_ARG = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])

/**
 * The git argv of a segment, or null if it is not a git command. Leading assignments and the
 * usual wrappers are stepped over so `cd x && FOO=1 sudo git add -A` is still seen.
 */
function gitArgs(tokens) {
  let i = 0
  while (i < tokens.length && (isAssignment(tokens[i]) || ['sudo', 'env', 'command', 'nice'].includes(tokens[i]))) i++
  const cmd = tokens[i]
  if (!cmd) return null
  if (cmd.split('/').pop() !== 'git') return null
  i++
  while (i < tokens.length && tokens[i].startsWith('-')) {
    const opt = tokens[i]
    i++
    if (GIT_OPT_WITH_ARG.has(opt)) i++
  }
  return tokens.slice(i)
}

const short = (t) => /^-[A-Za-z]+$/.test(t)
const hasShort = (args, letter) => args.some((t) => short(t) && t.includes(letter))
const has = (args, ...long) => args.some((t) => long.includes(t))
const paths = (args) => args.filter((t) => !t.startsWith('-') && t !== '--')
const WHOLE_TREE = new Set(['.', './', ':/', '*', ':'])

/** Why any of this is refused. Left off the amend rule, which is about the audit trail
 *  rather than about concurrency and would read as a non-sequitur with this in front. */
const SHARED = "Several sessions share this working tree, so this command's blast radius is everyone's. "

/** null to allow; the whole refusal, ending in what to do instead, to refuse. */
function verdict(args) {
  const [sub, ...rest] = args
  switch (sub) {
    case 'add':
      if (hasShort(rest, 'A') || hasShort(rest, 'u') || has(rest, '--all', '--update', '--no-ignore-removal'))
        return SHARED + 'Stage the paths you changed instead:  git add <path> [<path>...]'
      if (paths(rest).some((p) => WHOLE_TREE.has(p)))
        return SHARED + 'Stage the paths you changed instead:  git add <path> [<path>...]'
      return null

    case 'commit':
      if (has(rest, '--amend'))
        return 'Amending rewrites a commit somebody may already be reading. Make a new commit.'
      if (hasShort(rest, 'a') || has(rest, '--all'))
        return SHARED + 'Commit your own paths:  git commit -m "..." -- <path> [<path>...]  (that form ignores the shared index)'
      return null

    case 'stash':
      if (!rest.length || ['push', 'save', 'create', 'store', '--'].includes(rest[0]) || rest[0].startsWith('-'))
        return SHARED + 'A stash sweeps up every session\'s uncommitted work, and only you know it is there. Commit your paths instead:  git commit -m "..." -- <path>'
      return null

    case 'reset':
      if (has(rest, '--hard'))
        return SHARED + 'A hard reset deletes uncommitted work belonging to every session in this tree. To unstage one path:  git reset -- <path>'
      if (!rest.includes('--'))
        return SHARED + 'A reset with no pathspec re-writes the whole shared index, including what other sessions had staged. To unstage your own:  git reset -- <path> [<path>...]  To undo a commit of yours, git revert it, or ask.'
      return null

    case 'checkout':
    case 'restore':
      if (paths(rest).some((p) => WHOLE_TREE.has(p)))
        return SHARED + `Discarding the whole tree takes every session's work with it. Name the file:  git ${sub} -- <path>`
      return null

    case 'clean':
      if (hasShort(rest, 'f') || has(rest, '--force'))
        return SHARED + 'git clean deletes untracked files another session may be part way through writing. Remove what you meant by name, or run it with -n first and read the list.'
      return null

    // Not about the shared tree: about the shared mirror. Every checkout Outpost makes of a repo
    // is a worktree of one mirror, and a chat's container holds only its own, so a prune there
    // drops every other chat's entry (2026-10-18, workspaces.md). Outpost's checkouts are locked
    // against it now; this says why, to a session that would prune its own scratch worktrees.
    case 'worktree':
      if (rest[0] === 'prune')
        return "Every chat's checkout of this repo shares one mirror, and a prune from here cannot see the others, so it would drop their entries. Remove a worktree you added by its path instead:  git worktree remove <path>  (that cleans up its entry too)"
      return null

    default:
      return null
  }
}

let payload = ''
for await (const chunk of process.stdin) payload += chunk

try {
  const hook = JSON.parse(payload)
  const command = hook?.tool_input?.command
  if (typeof command === 'string' && command.includes('git')) {
    for (const tokens of segments(command)) {
      // The override is a person's escape hatch from the pre-commit check (claims.mjs), so
      // an agent setting it on a command line is the one thing it must not be.
      if (tokens.some((t) => t.startsWith(`${OVERRIDE}=`))) {
        deny(`${OVERRIDE} is there for a person to type in their own shell, not for a session to set. Ask, and say which files overlap.`)
        break
      }
      const args = gitArgs(tokens)
      if (!args) continue
      const why = verdict(args)
      if (why) {
        deny(why)
        break
      }
    }
  }
} catch {
  // Fails open: see the header.
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })
  )
}
