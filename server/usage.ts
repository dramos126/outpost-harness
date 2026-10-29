/**
 * What `/usage` shows in a Claude Code session: how much of the plan's limits are spent.
 *
 * Read off the chats' own streams, not asked of Anthropic. Every turn of a structured session
 * carries a `rate_limit_event` the CLI wrote after its own request — the five-hour and weekly
 * windows, how full each is and when it resets — so the numbers are already on disk, fetched by
 * the official binary with its own login. Outpost never reads the OAuth token and never calls
 * Anthropic with it: Anthropic's terms keep subscription credentials for its own apps, and a
 * dashboard calling the usage endpoint with them is exactly the third-party use they rule out
 * (usage.md).
 *
 * The cost is freshness: the numbers are as of the last turn any chat took. Usage spent
 * elsewhere (claude.ai, another machine) shows at the next one.
 *
 * Everything is normalised here, into `{ id, label, percent, resetsAt }` rows; the page never
 * learns the CLI's window names, the same way it never learns what a session `ref` looks like.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CLAUDE_BIN, claudeEnv } from './claude-auth.mjs'
import { SESSIONS_DIR } from './launchers/structured.mjs'

const run = promisify(execFile)

/**
 * How long an answer is good for. Reading it is a few file tails, but the page polls and every
 * open of the panel asks again; this makes a burst of those one read.
 */
const CACHE_MS = 15_000

/** A reading older than this is drawn as "last known" rather than "checked". */
const STALE_AFTER_MS = 10 * 60_000

/** Newest streams looked in for a reading; the newest one with an event answers. */
const STREAMS_SCANNED = 10

/** How much of a stream's end is read. A turn's event is near it unless a long answer followed. */
const TAIL_BYTES = 2 * 1024 * 1024

/** The plan name changes about never; `claude auth status` is asked once an hour at most. */
const PLAN_MS = 60 * 60_000

export type UsageLimit = {
  id: string
  label: string
  percent: number
  resetsAt: string | null
  /** True for the limit the account is actually being measured against right now. */
  active: boolean
}

export type Usage = {
  ok: boolean
  error?: string
  limits: UsageLimit[]
  /** The one number the button shows: the fullest limit, and what it is. */
  overall: { percent: number; label: string } | null
  /** Pay-as-you-go credits. The stream does not carry them, so always null now (usage.md). */
  credits: { percent: number; usedLabel: string } | null
  plan: string
  fetchedAt: number
  stale?: boolean
  /** Nothing to show and nothing coming: no chat has reported limits, or chats run on an API key. */
  needsLogin?: boolean
}

type Cached = { at: number; value: Usage }
let cache: Cached | null = null
let inFlight: Promise<Usage> | null = null
let plan: { at: number; name: string } | null = null

const clampPercent = (n: unknown) => {
  const v = Number(n)
  return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : 0
}

/** "Current session", "Current week", "Current week (Opus)" — the wording `/usage` itself uses. */
const LABELS: Record<string, string> = {
  five_hour: 'Current session',
  seven_day: 'Current week',
  seven_day_opus: 'Current week (Opus)',
  seven_day_sonnet: 'Current week (Sonnet)',
}

/** The plan's name from the CLI, never from its credentials file; '' when it will not say. */
async function planName(): Promise<string> {
  if (plan && Date.now() - plan.at < PLAN_MS) return plan.name
  let name = ''
  try {
    const { stdout } = await run(CLAUDE_BIN, ['auth', 'status', '--json'], { timeout: 15000 })
    name = String(JSON.parse(stdout)?.subscriptionType || '')
  } catch {
    /* an older CLI, or no login: the heading just says "plan" */
  }
  plan = { at: Date.now(), name }
  return name
}

/** The last `rate_limit_info` in one stream's tail, or null. */
async function lastEvent(file: string): Promise<any> {
  let fh
  try {
    fh = await fsp.open(file, 'r')
  } catch {
    return null
  }
  try {
    const { size } = await fh.stat()
    const length = Math.min(size, TAIL_BYTES)
    const buf = Buffer.alloc(length)
    await fh.read(buf, 0, length, size - length)
    const lines = buf.toString('utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limit_event"')) continue
      try {
        const m = JSON.parse(lines[i])
        if (m?.type === 'rate_limit_event' && m.rate_limit_info) return m.rate_limit_info
      } catch {
        /* the first line of the tail, cut in half */
      }
    }
    return null
  } finally {
    await fh.close()
  }
}

/** The newest reading any chat's stream holds, and when that stream was last written. */
async function newestReading(): Promise<{ info: any; at: number } | null> {
  const ids = await fsp.readdir(SESSIONS_DIR).catch(() => [] as string[])
  const streams: Array<{ file: string; at: number }> = []
  for (const id of ids) {
    const file = path.join(SESSIONS_DIR, id, 'out.jsonl')
    const st = await fsp.stat(file).catch(() => null)
    if (st) streams.push({ file, at: Math.round(st.mtimeMs) })
  }
  streams.sort((a, b) => b.at - a.at)
  for (const s of streams.slice(0, STREAMS_SCANNED)) {
    const info = await lastEvent(s.file)
    if (info?.unifiedWindows) return { info, at: s.at }
  }
  return null
}

/**
 * The event, reduced to rows. A window whose reset has passed is drawn empty: it has turned
 * since the reading, whatever it said then. `*_overage_*` windows are the account's
 * pay-as-you-go side, not a plan limit, and are left out.
 */
function normalise(info: any): Pick<Usage, 'limits' | 'overall' | 'credits'> {
  const now = Date.now()
  const limits: UsageLimit[] = []
  for (const [key, w] of Object.entries<any>(info?.unifiedWindows || {})) {
    if (!w || key.includes('overage')) continue
    const reset = Number(w.resetsAt) * 1000
    const turned = Number.isFinite(reset) && reset <= now
    limits.push({
      id: key,
      label: LABELS[key] || key.replace(/_/g, ' '),
      percent: turned ? 0 : clampPercent(Number(w.utilization) * 100),
      resetsAt: !turned && Number.isFinite(reset) ? new Date(reset).toISOString() : null,
      active: info.rateLimitType === key,
    })
  }
  const fullest = limits.reduce<UsageLimit | null>((best, l) => (!best || l.percent > best.percent ? l : best), null)
  return { limits, overall: fullest ? { percent: fullest.percent, label: fullest.label } : null, credits: null }
}

function nothing(error: string): Usage {
  return { ok: false, needsLogin: true, error, limits: [], overall: null, credits: null, plan: '', fetchedAt: Date.now() }
}

async function refresh(): Promise<Usage> {
  // Chats on an API key have no plan limits: the host's login may still have some to show, but
  // they are not what chats spend, so showing them would mislead (claude-auth.mjs).
  const signIn: Record<string, string> = await claudeEnv()
  if (signIn.ANTHROPIC_API_KEY) return nothing('Chats run on an API key — billed per token, so there are no plan limits')
  const reading = await newestReading()
  if (!reading) return nothing('No chat has reported plan limits yet — they arrive with the next turn')
  return {
    ok: true,
    plan: await planName(),
    fetchedAt: reading.at,
    ...(Date.now() - reading.at > STALE_AFTER_MS ? { stale: true } : {}),
    ...normalise(reading.info),
  }
}

/** Plan usage, cached. Never throws: a failure says why in `error`. */
export async function readUsage(): Promise<Usage> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value
  if (inFlight) return inFlight

  inFlight = refresh()
    .catch((err: unknown): Usage => ({ ok: false, error: String((err as Error)?.message || err), limits: [], overall: null, credits: null, plan: '', fetchedAt: Date.now() }))
    .then((value) => {
      cache = { at: Date.now(), value }
      return value
    })
    .finally(() => {
      inFlight = null
    })

  return inFlight
}
