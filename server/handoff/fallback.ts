/**
 * A handoff written without the session (handoff.md): for a chat whose cache has already gone
 * cold, that a usage limit stopped, or whose session is not running — every case where asking
 * the session would rewrite its whole context at full price, or cannot be done at all.
 *
 * One `claude -p` on Haiku, run as chat naming runs it (titles.mjs): no tools, no MCP servers, no
 * hooks or CLAUDE.md, nothing written to disk, signed in as chats are. It reads what Outpost can
 * read without the session — the tail of the conversation, prompts and answers only, and each
 * checkout's commits since its base and uncommitted changes — so it is a reconstruction, and the
 * card and the confirm say so. A few thousand tokens on the smallest model, against a rewrite of
 * hundreds of thousands on the chat's own.
 */
import os from 'node:os'
import { spawn } from 'node:child_process'
import { readTranscript } from '../scan.mjs'
import { CLAUDE_BIN, claudeEnv } from '../claude-auth.mjs'
import { git as gitJs } from '../workspaces/git.mjs'

/** `git(args, { cwd })`: typed loosely, since tsc reads the JavaScript's options from its `{}` default. */
const git: (args: string[], opts: { cwd: string }) => Promise<string> = gitJs as any
import { workspaceFor } from '../workspaces/index.mjs'

/** How much of the conversation's tail the model is shown, in characters, newest kept. */
const TAIL_CHARS = 24_000
/** One message longer than this is cut: a pasted log is not what the next session needs. */
const ITEM_CHARS = 2_000
/** Commits and changed files per checkout; a branch of hundreds is summarised by its newest. */
const GIT_LINES = 40
/** A Haiku answer of a page is seconds; one still going after this is not coming. */
const RUN_TIMEOUT_MS = 120_000

const SYSTEM = `You write handoffs for coding sessions. A long conversation between a person and a coding agent is being set aside, and a fresh agent session will start in the same checkout from what you write — it will know nothing else. You are given the end of the conversation (the person's messages and the agent's answers, without tool output) and the git state of each checkout. Write the handoff in Markdown, under 500 words, with these sections: Goal; Done (with commit hashes where the git log shows them); Next (in order); Files that matter (paths); Decisions (and why, where the conversation says); Open questions (for the person, including any the agent asked last). Say only what the material supports; where something is unclear, say so under Open questions rather than guessing. Answer with the handoff and nothing else.`

/** The conversation's tail as text, newest kept: `[person]` and `[agent]` turns, each cut to a size. */
export function conversationTail(messages: any[], max = TAIL_CHARS): string {
  const out: string[] = []
  let used = 0
  for (let i = messages.length - 1; i >= 0 && used < max; i--) {
    const m = messages[i]
    if (m?.kind !== 'text' || !m.text) continue
    let text = String(m.text).trim()
    if (text.length > ITEM_CHARS) text = `${text.slice(0, ITEM_CHARS)} …[cut]`
    const line = `[${m.role === 'user' ? 'person' : 'agent'}] ${text}`
    out.unshift(line)
    used += line.length
  }
  return out.join('\n\n')
}

/** Each checkout's branch, commits since its base and uncommitted changes, as text. */
async function gitState(cwd: string): Promise<string> {
  const m: any = await workspaceFor(cwd)
  const parts: string[] = []
  for (const r of m?.repos || []) {
    const cut = (s: string) => s.split('\n').filter(Boolean).slice(0, GIT_LINES).join('\n')
    const log = await git(['log', '--oneline', '--no-decorate', `-${GIT_LINES}`, `origin/${r.base}..HEAD`], { cwd: r.path }).catch(() => '')
    const status = await git(['status', '--short'], { cwd: r.path }).catch(() => '')
    const stat = await git(['diff', '--stat', 'HEAD'], { cwd: r.path }).catch(() => '')
    parts.push(
      [
        `## ${r.name} (${r.path})`,
        `Branch: ${r.branch || '(none yet — no work started)'}; base ${r.base}`,
        `Commits since ${r.base}:\n${cut(log) || '(none)'}`,
        `Uncommitted:\n${cut(status) || '(clean)'}`,
        stat.trim() ? `Uncommitted, by size:\n${cut(stat)}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    )
  }
  return parts.join('\n\n') || '(This chat has no repo checkout.)'
}

/** The handoff, or a thrown reason. `thread` is the roster's; `signal` is the block's Cancel. */
export async function writeFallback(thread: any, signal?: AbortSignal): Promise<string> {
  const read: any = await readTranscript(thread.harness, thread.ref, { after: 0 })
  if (!read?.ok) throw new Error(read?.error || 'The conversation could not be read')
  const tail = conversationTail(read.messages || [])
  if (!tail) throw new Error('The conversation has nothing in it to hand off')
  const input = [`# The end of the conversation${read.truncated ? ' (an earlier part is not shown)' : ''}`, tail, '# Git', await gitState(thread.cwd)].join('\n\n')
  if (signal?.aborted) throw new Error('cancelled')
  const out = await runCli(input, signal)
  let answer: any
  try {
    answer = JSON.parse(out)
  } catch {
    throw new Error('the CLI did not answer in JSON')
  }
  if (answer.is_error) throw new Error(String(answer.result || 'the run failed').slice(0, 300))
  const text = String(answer.result || '').trim()
  if (!text) throw new Error('the model wrote nothing')
  return text
}

function runCli(input: string, signal?: AbortSignal): Promise<string> {
  const args = ['-p', '--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--permission-prompts', 'none', '--model', 'haiku', '--output-format', 'json', '--system-prompt', SYSTEM, '--tools', '']
  return claudeEnv().then(
    (auth: Record<string, string>) =>
      new Promise((resolve, reject) => {
        const child = spawn(CLAUDE_BIN, args, { cwd: os.tmpdir(), env: { ...process.env, ...auth, DISABLE_AUTOUPDATER: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
        let out = ''
        let err = ''
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error('it took too long to answer'))
        }, RUN_TIMEOUT_MS)
        signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          child.kill('SIGKILL')
          reject(new Error('cancelled'))
        })
        child.stdout.on('data', (d) => (out += d))
        child.stderr.on('data', (d) => (err += d))
        child.on('error', (e: any) => {
          clearTimeout(timer)
          reject(new Error(e.code === 'ENOENT' ? `the ${CLAUDE_BIN} program is not on this machine's PATH` : e.message))
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          if (out.trim()) resolve(out)
          else reject(new Error(err.trim().split('\n').slice(-1)[0] || `the CLI exited ${code}`))
        })
        child.stdin.end(input)
      })
  )
}
