/**
 * What a routine's run can read about the day (`chats_digest`, routines.md *The digest*): per
 * chat active since a time, its title and repos, the commits it made, the commands it ran and
 * the files it edited, and its own final replies.
 *
 * Read from what Outpost already has — the roster, each chat's transcript through its harness,
 * git — never a copy kept for the purpose. Tool calls are their inputs only: a result is what a
 * command printed, and tool results are never indexed or handed on (integrations.md). What a
 * person or a session wrote is scrubbed as the index scrubs it, since people paste tokens.
 *
 * A digest is a tool result, read back on every later request of the run, so it is capped and
 * says where it was cut (mcp/caps.mjs).
 */
import { scrub } from '../search/index.mjs'

/** Per chat: the commands and files kept (the latest), the replies kept (the last turns), and how long each may be. */
export const DIGEST_COMMANDS = 30
export const DIGEST_FILES = 40
export const DIGEST_REPLIES = 3
const COMMAND_CHARS = 300
const REPLY_CHARS = 1200

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const iso = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z'
const cut = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s)
const oneLine = (s) => String(s || '').replace(/\s*\n\s*/g, ' ⏎ ').trim()

/** A tool item's input, as the harness kept it (`detail`, JSON cut at 2,000 characters); null when the cut broke it. */
function inputOf(item) {
  try {
    return JSON.parse(item.detail || '{}')
  } catch {
    return null
  }
}

/**
 * The commands, edits and final replies in one chat's transcript items since `since`. A command
 * is a Bash call's command, or a host action (`host_run`); an edit is the file a Write, Edit or
 * NotebookEdit named. A final reply is the last thing the session said in a turn — before the
 * person's next message, or at the end.
 */
export function activityOf(items, since) {
  const commands = []
  const files = new Set()
  const replies = []
  let last = null
  const closeTurn = () => {
    if (last && last.ts >= since) replies.push(last)
    last = null
  }
  for (const m of items) {
    if (m.kind === 'text' && m.role === 'user') closeTurn()
    if (m.kind === 'text' && m.role === 'assistant') last = m
    if (m.kind !== 'tool' || (m.ts || 0) < since) continue
    const input = inputOf(m)
    if (m.name === 'Bash') commands.push(cut(oneLine(scrub(input?.command ?? m.summary)), COMMAND_CHARS))
    else if (/(^|__)host_run$/.test(m.name)) commands.push(cut(oneLine(scrub(`host_run ${input ? JSON.stringify(input) : m.summary}`)), COMMAND_CHARS))
    else if (EDIT_TOOLS.has(m.name)) {
      const file = input?.file_path || input?.notebook_path || m.summary
      if (file) files.add(String(file))
    }
  }
  closeTurn()
  return { commands, files: [...files], replies: replies.map((r) => cut(scrub(String(r.text || '').trim()), REPLY_CHARS)) }
}

/**
 * The digest, as text for the session. `threads` is the whole roster's; a routine's run, hidden
 * or promoted, is left out — the digest is of the person's chats, and a run reading its own
 * kind would report itself. `read(thread)` answers `{ items, from }` — the transcript items and
 * the time of the earliest one read, so a chat read only in part says so; `commits(workspaceId,
 * since)` the commits its checkouts made since then, `{ repo, sha, subject, pushed }`.
 */
export async function buildDigest({ since, now = Date.now(), threads, read, commits, maxBytes }) {
  const active = threads
    .filter((t) => t.workspace && !t.workspace.hidden && !t.routine && (t.lastActivityAt || 0) > since)
    .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))
  const head = `Chats active since ${iso(since)} (now ${iso(now)}): ${active.length}. Routine runs are left out; commands and edits are what was asked for, never what came back.`
  if (!active.length) return `${head}\n\nNothing happened in any chat.`
  const parts = []
  for (const t of active) {
    const repos = (t.workspace.repos || []).map((r) => r.name || r.id).join(', ')
    const lines = [`## ${t.title || t.workspace.name || 'Untitled'}${repos ? ` — ${repos}` : ''} (last active ${iso(t.lastActivityAt)})`]
    const made = await commits(t.workspace.id, since).catch(() => [])
    if (made.length) lines.push(`Commits: ${made.map((c) => `${c.repo} ${String(c.sha).slice(0, 8)} "${oneLine(c.subject || '')}"${c.pushed ? '' : ' (not pushed)'}`).join('; ')}`)
    const { items, from } = await read(t).catch(() => ({ items: [], from: 0, error: true }))
    const a = activityOf(items || [], since)
    if (from > since) lines.push(`(Only its transcript since ${iso(from)} was read.)`)
    if (a.commands.length) {
      const shown = a.commands.slice(-DIGEST_COMMANDS)
      lines.push(`Commands${a.commands.length > shown.length ? ` (the last ${shown.length} of ${a.commands.length})` : ''}:`, ...shown.map((c) => `- ${c}`))
    }
    if (a.files.length) {
      const shown = a.files.slice(-DIGEST_FILES)
      lines.push(`Files edited${a.files.length > shown.length ? ` (${shown.length} of ${a.files.length})` : ''}: ${shown.join(', ')}`)
    }
    const replies = a.replies.slice(-DIGEST_REPLIES)
    if (replies.length) lines.push(`Its final replies${a.replies.length > replies.length ? ` (the last ${replies.length} of ${a.replies.length} turns)` : ''}:`, ...replies.map((r) => r.split('\n').map((l) => `> ${l}`).join('\n')))
    if (lines.length === 1) lines.push('Talked, but ran no command and edited no file.')
    parts.push(lines.join('\n'))
  }
  let text = head
  let shown = 0
  for (const p of parts) {
    if (Buffer.byteLength(`${text}\n\n${p}`) > maxBytes) break
    text += `\n\n${p}`
    shown++
  }
  if (shown < parts.length) {
    const rest = active.slice(shown)
    text += `\n\n…(cut at ${maxBytes} bytes: ${rest.length} older chat${rest.length === 1 ? '' : 's'} not shown — ${rest.map((t) => t.title || t.workspace.name).slice(0, 10).join(', ')}${rest.length > 10 ? ', …' : ''}. A larger max_bytes, or a later since, shows them.)`
  }
  return text
}
