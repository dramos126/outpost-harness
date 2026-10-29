/**
 * One command per Bash call: what counts as more than one, and the words a session is told.
 *
 * The CLI gates a bundle by its least-allowed part and matches a command holding a
 * substitution against no rule at all (docs/process/infra.md, *The permission allowlist*), so
 * `wc -l a && sed -n 1,70p b && ls ~/elsewhere` asks a person about three commands when one
 * needed asking — and `f=$(ls …); echo $f` asks about commands that were allowed all along.
 * Every prompt denied on this machine in the three days before this was written was one of
 * those. The approval surface (structured.mjs `awaitApproval`) therefore refuses such a call
 * back to the session instead of asking, and the session sends the parts one at a time: the
 * allowed ones run, and the one that needs a person reaches them alone.
 *
 * A pipe is not a chain. `grep x file | head` cannot be split into two calls, and the CLI
 * already allows a pipeline whose every side is allowed.
 *
 * This reads shell just well enough to tell — quotes, escapes, comments — and is not a parser.
 * A miss in either direction is cheap: a chain it does not see is asked as it always was, and
 * a single command it takes for a chain is refused with words that say how to rephrase it.
 */

/** Said to every session at launch, so the rule is known before the first refusal teaches it. */
export const ONE_COMMAND_RULE =
  'Outpost, the harness this session runs in, takes one command per Bash call. A call that ties commands together — `&&`, `||`, `;`, a line break between commands, `$(…)` or backticks, a heredoc — is refused without anybody being asked whenever it would need permission, so do not write one. Send each command as its own Bash call (independent ones can go in the same message) and only a command that really needs permission will reach the person. The working directory carries over between calls, so never `cd … &&`: pass a path, or `git -C <dir>`. Use Read, Write and Edit rather than cat, a heredoc or `sed -i`, and write values out literally rather than through `$(…)` or a shell variable. A pipe into head, tail, grep and the like is fine.'

/**
 * Why a command line is more than one command — `chain`, `substitution` or `heredoc` — with
 * the token that gave it away, or null for a single command or a single pipeline.
 */
export function tiedTogether(command) {
  const s = String(command || '').trim()
  let quote = '' // '', "'", '"' or "$'" (ANSI-C, where a backslash escapes)
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    const next = s[i + 1] || ''
    if (quote === "'") {
      if (c === "'") quote = ''
      continue
    }
    if (c === '\\') {
      // Outside single quotes a backslash takes the next character with it: `\;` ends a
      // `find -exec`, and a backslash before a line break continues the line.
      i++
      continue
    }
    if (quote === "$'") {
      if (c === "'") quote = ''
      continue
    }
    // A substitution runs inside double quotes as well as outside them. `$((` is arithmetic.
    if (c === '`') return { kind: 'substitution', token: '`…`' }
    if (c === '$' && next === '(' && s[i + 2] !== '(') return { kind: 'substitution', token: '$(…)' }
    if (quote === '"') {
      if (c === '"') quote = ''
      continue
    }
    if (c === '"') {
      quote = '"'
      continue
    }
    if (c === "'") {
      quote = "'"
      continue
    }
    if (c === '$' && next === "'") {
      quote = "$'"
      i++
      continue
    }
    const prev = s[i - 1] || ''
    if (c === '#' && (!prev || /\s/.test(prev))) {
      // A comment runs to the end of its line and separates nothing.
      const nl = s.indexOf('\n', i)
      if (nl === -1) break
      i = nl - 1
      continue
    }
    if ((c === '<' || c === '>') && next === '(') return { kind: 'substitution', token: `${c}(…)` }
    if (c === '<' && next === '<') {
      // `<<<` is a here-string, one word handed to one command.
      if (s[i + 2] === '<') {
        i += 2
        continue
      }
      return { kind: 'heredoc', token: '<<' }
    }
    const more = s.slice(i + 1).trim().length > 0
    if (c === ';') {
      if (more) return { kind: 'chain', token: ';' }
      continue
    }
    if (c === '\n') {
      if (more) return { kind: 'chain', token: 'a line break' }
      continue
    }
    if (c === '&') {
      if (next === '&') return { kind: 'chain', token: '&&' }
      // `2>&1`, `>&2`, `<&3`, `&>file` are redirections and `|&` is a pipe; a trailing `&` is
      // one command in the background.
      if (prev === '>' || prev === '<' || prev === '|' || next === '>') continue
      if (more) return { kind: 'chain', token: '&' }
      continue
    }
    if (c === '|' && next === '|') return { kind: 'chain', token: '||' }
  }
  return null
}

const HOW = {
  chain:
    'Send each command as its own Bash call — independent ones can go in the same message — and only a command that really needs permission will reach the person. The working directory carries over between calls, so there is no need for `cd … &&`: pass a path, or `git -C <dir>`.',
  substitution:
    'Run the inner command on its own first, then write its output into the next call as plain text.',
  heredoc:
    'Write the file with the Write tool and then run it; for a commit message, put the line breaks inside the quotes or repeat `-m`.',
}

/** How every refusal opens; what the token accounting (server/tokens.ts) counts refusals by. */
export const REFUSAL_LEAD = 'Outpost takes one command per Bash call'

/** The refusal a session reads in place of an answer, or '' when the command is a single one. */
export function refusalFor(command) {
  const tied = tiedTogether(command)
  if (!tied) return ''
  const what = { chain: `several commands tied together (${tied.token})`, substitution: `one command run inside another (${tied.token})`, heredoc: `a heredoc (${tied.token})` }[tied.kind]
  return `${REFUSAL_LEAD}, and this is ${what}, so nobody was asked. ${HOW[tied.kind]}`
}
