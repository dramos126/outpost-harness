/**
 * How much one of Outpost's tool results may hand a session, and how a cut result says so.
 *
 * A result is paid once when it lands and then read back on every later request of the chat,
 * for as long as the chat lives (architecture.md, *A feature pays for its tokens*). So each tool
 * that can return a lot has a default that covers a typical call, a parameter that asks for more,
 * and a cut that names the parameter. Each number's reason is beside it and in integrations.md;
 * the sizes they were set from are `yarn tokens:report`'s (usage.md).
 */

/**
 * A file or listing read through `catalogue_read` or `host_read`: whole lines, up to this many
 * bytes (≈8k tokens). The CLI's own Read on this machine's chats answers a median 2.7 KB, a p90
 * of 12.7 KB and at most 64 KB (2026-10-05), so 32 KB is a whole file on all but the largest
 * reads, and the cut says which line to ask for next. The 60 KB and 200 KB these tools cut at
 * before were each one call's worth of context nobody had asked for.
 */
export const READ_CAP = 32_000

/**
 * `host_run`'s output, stdout and stderr together, the end kept: 16 KB unless `max_bytes` asks
 * for up to 64 KB, all that is kept on the way back (hosts.mjs). The CLI's own Bash results here
 * are a median 298 B, a p90 of 2.3 KB and at most 29 KB; a command's end is where it says how it
 * ended, and 16 KB is seven times the p90. It was 64 KB of each stream, up to 128 KB, before.
 */
export const RUN_CAP = 16_000

/**
 * `catalogue_list`'s entries: one directory of a git tree, not recursive. This repo's largest
 * holds 30; 500 (≈15 KB) is a directory nobody lists to read, and `offset` pages past it.
 */
export const LIST_CAP = 500

/**
 * `jenkins_test_report`'s failing cases, each a message of up to 800 characters and twelve
 * lines of stack (integrations.mjs), so ≈2 KB a case: ten by default (≈20 KB), fifty when
 * `limit` asks. A build that fails many tests most often fails them for one reason, which the
 * first few show; thirty, the old fixed number, was ≈60 KB.
 */
export const TEST_CASES = 10
export const TEST_CASES_MAX = 50

/**
 * Bytes a `jenkins_build_log` section may average per line it is asked for: 80 lines (the
 * default) is then 12.8 KB a failed stage, 64 KB at 400. Lines are short in a log people read;
 * one over a thousand characters, a minified bundle or a blob, is cut to its start
 * (integrations.mjs), and this bounds a stage of many long-ish ones. Before, one 50 KB line in
 * the last eighty was 50 KB of answer.
 */
export const LOG_LINE_BYTES = 160

/**
 * `jenkins_job_info`'s branch names for a multibranch job. A branch is addressed as
 * `<job>/<branch>` whether or not it was listed, so the list is for finding one, and fifty is
 * every live branch of most repos; a repo with a branch per pull request can have hundreds.
 */
export const BRANCH_CAP = 50

/**
 * `routine_list`'s routines, ≈250 B each: fifty is 12 KB, more than one person keeps. Past
 * it the answer says how many more, and the Routines list has them all.
 */
export const ROUTINE_CAP = 50

/**
 * `chats_digest`'s answer (state/digest.mjs): 24 KB by default, 64 KB when `max_bytes` asks. A
 * day's chat is a few hundred bytes of commands and files and up to three replies of 1,200
 * characters, so ≈2–5 KB; 24 KB is five or more busy chats, and the cut names the chats left out
 * and the parameter. A run reads it once and carries it for the rest of its short life.
 */
export const DIGEST_CAP = 24_000
export const DIGEST_MAX = 64_000

/**
 * `data_publish`'s lists: files sent, already the same, newer there, and rsync's error lines,
 * this many of each (≈100 B a line, so ≈8 KB at most). A publish of a few runs is a dozen
 * files; one of a whole dataset can be thousands, which the count says and the `path`
 * parameter narrows. The Activity log has every line but the unchanged files'.
 */
export const PUBLISH_LINES = 20

/**
 * `github_pull_comments`' comments, the latest: twenty by default, a hundred when `limit` asks,
 * each cut at `COMMENT_CHARS`. A review round is a handful of comments and the latest are the
 * ones to act on; twenty of up to 2 KB is ≈40 KB at the very most, a few KB in practice.
 * `github_issue` keeps ten of an issue's comments by default (`ISSUE_COMMENTS`), the same
 * hundred at most, and the issue's own text up to `ISSUE_CHARS`.
 */
export const COMMENTS = 20
export const COMMENTS_MAX = 100
export const COMMENT_CHARS = 2000
export const ISSUE_COMMENTS = 10
export const ISSUE_CHARS = 16_000

/**
 * `github_actions`' runs when none is named: ten, ≈150 B each. A run is then read by its id,
 * its failed jobs' logs cut as a Jenkins stage's is (`LOG_LINE_BYTES`, 80 lines, 400 at most).
 */
export const RUNS = 10

/**
 * A window of `text`'s lines that fits in `cap` bytes: from line `offset` (1-based) onwards, or,
 * when `offset` is negative, the last that many lines — and when those do not fit, the end of
 * them, since that is what a negative offset asks for. A single line longer than the cap is cut
 * to it. `{ text, from, to, total }`, the line numbers 1-based and inclusive.
 */
export function lineWindow(text, offset = 1, cap = READ_CAP) {
  const lines = String(text).split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const total = lines.length
  const size = (i) => Buffer.byteLength(lines[i - 1]) + 1
  const n = Math.trunc(Number(offset)) || 1
  let from
  let to
  if (n < 0) {
    to = total
    const earliest = Math.max(1, total + n + 1)
    from = to + 1
    for (let bytes = 0; from > earliest && bytes + size(from - 1) <= cap; ) bytes += size(--from)
  } else {
    from = Math.max(1, n)
    if (from > total) return { text: '', from, to: from - 1, total }
    to = from - 1
    for (let bytes = 0; to < total && bytes + size(to + 1) <= cap; ) bytes += size(++to)
  }
  // One line over the cap on its own: it is shown cut rather than not at all.
  if (to < from) {
    const line = Buffer.from(lines[(n < 0 ? to : from) - 1])
    const kept = n < 0 ? line.subarray(line.length - cap) : line.subarray(0, cap)
    const at = n < 0 ? to : from
    return { text: n < 0 ? `…${kept.toString('utf8')}` : `${kept.toString('utf8')}…`, from: at, to: at, total }
  }
  return { text: lines.slice(from - 1, to).join('\n'), from, to, total }
}

/** The line a window's answer ends on when it is not everything: which lines these are, and how to go on. */
export function windowNote(w) {
  if (w.to < w.from) return `\n…(nothing from line ${w.from}: there are ${w.total} lines)`
  if (w.from <= 1 && w.to >= w.total) return ''
  return `\n…(lines ${w.from}–${w.to} of ${w.total}${w.to < w.total ? `; call again with offset ${w.to + 1} for the rest` : ''})`
}
