/**
 * A chat's handoff as the page reads it (handoff.md): which state its block is in, the
 * handoff a session wrote inside an answer, and the line of section names. Pure, so the panel's
 * block and the list read one answer — and the tests read it without a page.
 */

/** How a handoff's request opens in the log: `HANDOFF_LEAD` in server/handoff/index.ts. */
export const HANDOFF_LEAD = 'Handoff asked for'

/** What asked for a handoff, as its block says it (`trigger` on the roster's `handoff`). */
export const HANDOFF_TRIGGER = { button: 'asked by you', away: 'on /away', idle: 'idle 50 min, before the cache expires', limit: 'the plan near its limit' }

/** The prompt cache's lifetime (usage.md `cold`): past it, asking the session rewrites its context. */
const CACHE_TTL_MS = 60 * 60_000

/**
 * Whether Hand off has two ways to go: the server would ask this session — running, no failure
 * standing, its cache warm (handoff.md `handOff`) — and a summary without it is the other.
 */
export const handoffChoice = (t, now = Date.now()) => Boolean(t?.canSend && !t.failure && !(t.contextAt && now - t.contextAt > CACHE_TTL_MS))

/**
 * Whether a workspace's checkouts hold work not yet safe: uncommitted changes, or commits on a
 * branch that is not on the remote — the server's `unshipped` (server/handoff/rules.ts), read
 * off the roster's `workspaces`, whose repos carry their git status. Archive offers Hand off first.
 */
export function unsavedWork(repos) {
  for (const r of repos || []) {
    const g = r?.git
    if (!g || g.exists === false) continue
    if (g.clean === false) return true
    if ((g.ahead || 0) > 0 && !g.pushed) return true
  }
  return false
}

/** The triggers a person pulled — the button or `/handoff`, and `/away` — as against the timers'. */
const ASKED_BY_YOU = new Set(['button', 'away'])

/**
 * Whether a ready handoff waits on the person: one they asked for, current, not set aside
 * (`dismissed`). It is a decision to make — start fresh or not — so the chat is under Needs you
 * until it is made (chats.md). One the idle timer or the plan's limit asked for is not: the list's
 * check and Discord say it (2026-10-19).
 */
export const handoffWaits = (t) => {
  const h = t?.handoff
  return Boolean(h?.at && !h.stale && !h.asking && !h.dismissed && ASKED_BY_YOU.has(h.trigger))
}

/** A handoff in an answer, between the request's markers with their nonce (handoff.md `parseHandoff`). */
const CUT = /^#{0,6}[ \t]*Handoff · ([0-9a-f]{6})[ \t]*\n([\s\S]*?)\n#{0,6}[ \t]*End of handoff · \1[ \t]*$/m

/**
 * Which state a thread's handoff is in: `progress` while one is written, `held` after a limit
 * reset, `away` while one is promised for the turn's end, `ready` or `stale` when one is kept,
 * `error` when the last request gave none; '' for none. Being written wins over held, as the
 * card it replaced had it.
 */
export function handoffState(thread) {
  const h = thread?.handoff || {}
  if (!thread) return ''
  if (h.asking) return 'progress'
  if (thread.retry?.held) return 'held'
  if (h.away) return 'away'
  if (h.at) return h.stale ? 'stale' : 'ready'
  if (h.error) return 'error'
  return ''
}

/**
 * An answer split around the handoff it carries: `{ rest, handoff }`, the answer without it and
 * the handoff's own text, or null when it carries none.
 */
export function cutHandoff(text) {
  const s = String(text || '')
  const m = CUT.exec(s)
  if (!m) return null
  const rest = (s.slice(0, m.index) + s.slice(m.index + m[0].length)).replace(/\n{3,}/g, '\n\n').trim()
  return { rest, handoff: m[2] }
}

/**
 * A handoff's section names on one line — "Goal · Done · Next · Files" — from its headings, or
 * its bold leads where it has too few: enough to see it is a real summary without opening it.
 */
export function handoffSections(text) {
  const names = (re) => [...String(text || '').matchAll(re)].map((m) => m[1].replace(/^[*_`]+|[*_`:]+$/g, '').trim()).filter(Boolean)
  let found = names(/^#{1,6}[ \t]+(.+?)[ \t]*#*$/gm)
  if (found.length < 2) found = names(/^\*\*([^*\n]{2,40})\*\*/gm)
  return found.slice(0, 7).join(' · ')
}
