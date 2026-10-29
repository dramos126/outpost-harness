/**
 * The handoff's decisions, as pure functions: no disk, no clock but the one passed in, no
 * session. Everything that decides whether a handoff is asked for, whether one is current, and
 * what the session's answer holds is here, so it can be run against made-up threads and answers
 * (handoff.md) — the parts that touch a session are in index.ts.
 */

/** The header's thresholds (config.mjs `context`, ui-conversation.md): orange from `warn…`, red from `alert…`. */
export type Limits = { warnTokens: number; warnShare: number; alertTokens: number; alertShare: number }

/**
 * '' below orange, 'warn' in the orange band, 'alert' in the red: each band starts at its token
 * count or its share of the model's window, whichever comes first, and on the count alone while
 * no window is known. The same reading as the page's header pill (conversation.js), on purpose:
 * a chat Outpost calls red is one the person was shown in red.
 */
export function contextLevel(tokens: number, window: number, limits: Limits | null): '' | 'warn' | 'alert' {
  if (!limits || !tokens) return ''
  const over = (count: number, share: number) => tokens >= count || (window > 0 && tokens >= share * window)
  if (over(limits.alertTokens, limits.alertShare)) return 'alert'
  if (over(limits.warnTokens, limits.warnShare)) return 'warn'
  return ''
}

/** A checkout's git status as `worktreeStatus` gives it (workspaces.md). */
export type GitStatus = { exists?: boolean; clean?: boolean; ahead?: number; pushed?: boolean } | null | undefined

/**
 * Whether a chat has work that is not shipped: a checkout with uncommitted changes, or a branch
 * with commits its base lacks that are not on the remote either. A pushed branch waiting on a
 * pull request is shipped for this purpose — it is safe off this machine, and a handoff is
 * a turn, which a chat with nothing at risk should not be made to take. A plain chat, with no
 * checkout, never has any.
 */
export function unshipped(repos: Array<{ git?: GitStatus }> | null | undefined): boolean {
  for (const r of repos || []) {
    const g = r?.git
    if (!g || g.exists === false) continue
    if (g.clean === false) return true
    if ((g.ahead || 0) > 0 && !g.pushed) return true
  }
  return false
}

/** A handoff as it is kept (store.ts). */
export type Handoff = {
  text: string
  at: number
  /** `session`: the session wrote it, warm. `fallback`: written from the transcript's tail and git without it. */
  how: 'session' | 'fallback'
  /** The context the session carried when it was made, tokens. */
  context: number
  sessionId: string
  trigger: string
  /** Set aside from Needs you by the person (`dismissHandoff`); still offered, no longer asking. */
  dismissedAt?: number
  /** When a fresh start was made from it; a used handoff is never offered again. */
  usedAt?: number
}

/**
 * Whether a handoff no longer describes the chat: the session has answered since it was made.
 * `contextAt` is when the session's latest request was answered (harnesses.md), so any turn
 * after the handoff moves it past `at`. A handoff the session wrote is captured at its own turn's
 * end, after that turn's last answer, so it does not make itself stale.
 */
export function isStale(h: Handoff | null | undefined, contextAt: number): boolean {
  if (!h) return true
  return Boolean(contextAt && contextAt > h.at)
}

/** Whether a handoff can be offered to start fresh from at all: there, and not used. */
export const offerable = (h: Handoff | null | undefined): h is Handoff => Boolean(h && h.text && !h.usedAt)

/**
 * The handoff out of a session's answer: the text between a line naming `Handoff · <nonce>` and
 * one naming `End of handoff · <nonce>`, either as a heading or as a bare line. The nonce is new
 * for every request, so a session that has read Outpost's own source — or quotes an earlier
 * handoff — cannot be taken for this one. An answer with the opening line and no closing one
 * gives everything after the opening: a handoff cut short is better than none. `''` when there
 * is no opening line.
 */
export function parseHandoff(answer: string, nonce: string): string {
  if (!answer || !nonce) return ''
  const esc = nonce.replace(/[^a-z0-9]/gi, '')
  const open = new RegExp(`^[ \\t>#*_]*Handoff\\s*[·:-]\\s*${esc}[ \\t*_]*$`, 'im')
  const close = new RegExp(`^[ \\t>#*_]*End of handoff\\s*[·:-]\\s*${esc}[ \\t*_]*$`, 'im')
  // The last opening line: an answer that drafts the handoff twice means the second.
  let start = -1
  let m: RegExpExecArray | null
  const all = new RegExp(open.source, 'gim')
  while ((m = all.exec(answer))) start = m.index + m[0].length
  if (start < 0) return ''
  const rest = answer.slice(start)
  const end = close.exec(rest)
  return (end ? rest.slice(0, end.index) : rest).trim()
}

/**
 * Whether the idle timer should ask a chat for a handoff now (handoff.md, *The idle timer*).
 * Every reason it should not is named, because "why did nothing happen" is the question a
 * person asks of a timer.
 */
export function idleVerdict(
  c: {
    now: number
    /** When the session's latest request was answered. */
    contextAt: number
    context: number
    window: number
    limits: Limits | null
    unshipped: boolean
    canSend: boolean
    running: boolean
    asking: boolean
    /** The cache lifetime its recent requests wrote with: '1h', '5m' or '' unknown. */
    cacheTtl: string
    current: Handoff | null
  },
  { idleMs, cacheMs }: { idleMs: number; cacheMs: number }
): { ask: boolean; why: string } {
  if (!c.canSend) return { ask: false, why: 'the session is not running' }
  if (c.running) return { ask: false, why: 'it is working' }
  if (c.asking) return { ask: false, why: 'it is waiting on the person' }
  if (!c.contextAt) return { ask: false, why: 'it has not answered yet' }
  const idle = c.now - c.contextAt
  if (idle < idleMs) return { ask: false, why: 'not idle long enough' }
  // Past the cache's lifetime the request would rewrite the whole context at full price — the
  // cost this exists to avoid. Too late; the fallback is for this.
  if (idle >= cacheMs) return { ask: false, why: 'the cache has already expired' }
  if (c.cacheTtl === '5m') return { ask: false, why: 'its cache lives five minutes, so it is long gone' }
  if (!contextLevel(c.context, c.window, c.limits)) return { ask: false, why: 'the context is below orange' }
  if (!c.unshipped) return { ask: false, why: 'nothing is unshipped' }
  if (offerable(c.current) && !isStale(c.current, c.contextAt)) return { ask: false, why: 'a current handoff exists' }
  return { ask: true, why: '' }
}

/** A plan window as `readUsage` gives it (usage.md). */
export type UsageLimit = { id?: string; label?: string; percent?: number; resetsAt?: string | null; active?: boolean }

/**
 * The plan window that is nearly spent, as a key naming it and its reset — or '' when the active
 * window is under `share`, or is the one a request was already made in (`done`). Only the active
 * window: it is the one the account is measured against, the one whose limit stops the turn.
 */
export function nearLimit(limits: UsageLimit[] | null | undefined, done: string, percent: number): string {
  const active = (limits || []).find((l) => l?.active)
  if (!active || !(Number(active.percent) >= percent)) return ''
  const key = `${active.id || active.label || 'window'}@${active.resetsAt || ''}`
  return key === done ? '' : key
}

/**
 * Whether `/away` should ask, or why not (handoff.md, "Away"): only a chat whose context is
 * orange or red with work not shipped. Below orange a fresh chat saves nothing worth a turn;
 * with nothing unshipped the next session reads the branch and is no worse off.
 */
export function awayVerdict(c: { context: number; window: number; limits: Limits | null; unshipped: boolean; canSend: boolean; current: Handoff | null; contextAt: number }): { ask: boolean; why: string } {
  if (!c.canSend) return { ask: false, why: 'its session is not running' }
  if (!contextLevel(c.context, c.window, c.limits)) return { ask: false, why: 'its context is below orange' }
  if (!c.unshipped) return { ask: false, why: 'nothing in it is unshipped' }
  if (offerable(c.current) && !isStale(c.current, c.contextAt)) return { ask: false, why: 'it already has a current handoff' }
  return { ask: true, why: '' }
}
