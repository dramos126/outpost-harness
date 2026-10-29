/**
 * What a chat has spent in tokens, how much of that the harness caused, and what every session
 * pays before it says a word.
 *
 * Measurement only: nothing here changes what a session is sent. It exists so that cutting what
 * Outpost costs a session is ranked on numbers (usage.md). Three parts:
 *
 * - **Spend**, summed off the transcript the CLI already writes (harnesses.md `readTokens`):
 *   fresh input, cache writes, cache reads and output, per API request, the main conversation
 *   and its subagents apart.
 * - **Harness waste**, counted rather than priced: Bash chains refused back to the session
 *   (each costs a turn), restarts in place (each can leave the next request with a cold cache),
 *   requests that began cold, and the turns Outpost itself sent.
 * - **Fixed overhead**: the standing rules appended to every session's system prompt and the
 *   descriptions and schemas of the MCP tools it is offered, measured from the constants
 *   themselves, never written down as numbers. `scripts/check-token-budget.mjs` holds them to a
 *   recorded budget.
 *
 * Plan limits (`/usage`) are a different question and live in usage.ts.
 */
import { readTokens, sessionIdOf } from './scan.mjs'
import { ONE_COMMAND_RULE, REFUSAL_LEAD } from './launchers/compound.mjs'
import { REPLY_RULE } from './launchers/reply.mjs'
import { allRecords } from './launchers/structured.mjs'
import { RESTART_LEAD } from './state/retry.mjs'
import { REMOUNT_LEAD, WORK_RULE, portsRule, setupNotice } from './workspaces/index.mjs'
import { DEFAULT_TOOLS, MCP_INSTRUCTIONS, TOOL_GROUPS, offeredTools } from './mcp/index.mjs'
import { HANDOFF_LEAD, freshPrompt, handoffRequest } from './handoff/index.ts'
import { definingLead, normalise as normaliseRoutine, routineEnding } from './state/routines.mjs'
import { commandLead } from './outpost-commands.mjs'
import { callData } from './state/triggers.mjs'

/**
 * A request is cold when it read back less than this share of what the request before it
 * carried: that prefix should have been in the cache, and was written again instead. Measured
 * against the previous request, not its own context, because a turn that adds a large file has a
 * low read share with a warm cache — the first cut counted those. On this machine's chats a
 * cold request reads about 12k (the CLI's own prompt, cached across sessions) of hundreds of
 * thousands, so the line is not delicate.
 */
const COLD_SHARE = 0.5

/** Below this the whole context is about the size of the system prompt, and a write is no loss. */
const COLD_MIN_CONTEXT = 20_000

/**
 * The CLI writes its cache with a one-hour lifetime. A cold request more than this after the one
 * before it is the cache running out while nobody spoke; within it, something changed the prompt
 * the cache was keyed on — a restart, a model switch, a compaction.
 */
const CACHE_TTL_MS = 60 * 60_000

/**
 * What each kind of token costs against one fresh input token, the same on every current
 * Claude model: a cache read a tenth, a cache write 1.25 for five minutes or 2 for an hour, and
 * output five. `weighted` ranks chats by cost without knowing a price list.
 */
const WEIGHT = { input: 1, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2, output: 5 }

/** About four characters a token for English prose; a rough figure, and labelled one wherever shown. */
export const approxTokens = (text: string) => Math.ceil(text.length / 4)

export type Spend = { turns: number; input: number; cacheWrite: number; cacheWrite1h: number; cacheRead: number; output: number }

/** One API request of the main conversation, as `readTokens` gives it. */
type Request = { at: number; model: string; effort: string; input: number; cacheWrite: number; cacheWrite1h: number; cacheRead: number; output: number }

export type Restarts = {
  /** `registry` when the launcher's records were readable; `transcript` when only its traces were. */
  source: 'registry' | 'transcript'
  total: number
  effort: number
  addRepo: number
  /** A unit gone and brought back; `null` when the records were not there to say. */
  resume: number | null
}

export type ChatTokens = {
  ok: boolean
  error?: string
  missing?: boolean
  /** The main conversation and its subagents together. */
  total: Spend
  main: Spend
  subagents: Spend & { agents: number }
  /** Against one fresh input token (`WEIGHT`), for ranking chats by cost. */
  weighted: number
  /** The CLI's own tally and its price, when it wrote one; counts what the transcript cannot. */
  cli: { costUSD: number; models: Record<string, { input: number; cacheWrite: number; cacheRead: number; output: number; costUSD: number }> } | null
  waste: {
    /** Bash calls refused back for tying commands together; each cost a turn. */
    refusals: number
    restarts: Restarts
    /** Requests that began with a cold cache, after the first; `tokens` is what they wrote again. */
    cold: { turns: number; tokens: number; expired: number; modelSwitch: number; invalidated: number }
    /** Turns the retry supervisor sent after an API failure. */
    retries: number
    /** Notes Outpost sent the session (setup finished, a build's result, a restart). */
    notes: number
    /** Handoffs Outpost asked the session for (handoff.md); each a turn of the whole context. */
    handoffs: number
  }
}

const emptySpend = (): Spend => ({ turns: 0, input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 })

function add(into: Spend, s: Spend | Request, turns = 1) {
  into.turns += turns
  into.input += s.input
  into.cacheWrite += s.cacheWrite
  into.cacheWrite1h += s.cacheWrite1h
  into.cacheRead += s.cacheRead
  into.output += s.output
}

export const weigh = (s: Spend) =>
  Math.round(
    s.input * WEIGHT.input +
      s.cacheRead * WEIGHT.cacheRead +
      (s.cacheWrite - s.cacheWrite1h) * WEIGHT.cacheWrite5m +
      s.cacheWrite1h * WEIGHT.cacheWrite1h +
      s.output * WEIGHT.output
  )

/** The value given to a flag in an argument list, or ''. */
function flagValue(args: string[], flag: string) {
  const at = args.lastIndexOf(flag)
  return at === -1 ? '' : String(args[at + 1] || '')
}

/**
 * Restarts in place, by cause, from the launcher's records: a restart is a new record with the
 * same session id (launchers.md). What changed between one and the next says why — a new
 * `--settings` is an effort change, another `--add-dir` a repo added; neither is Resume after
 * the unit went. With no records here (another machine's data, or none kept), the transcript's
 * traces stand in: an effort that moved between answers, and the note an /addRepo restart sends.
 */
async function restartsOf(sessionId: string, requests: Request[], remounts: number): Promise<Restarts> {
  const recs = sessionId ? (await allRecords().catch(() => [] as any[])).filter((r: any) => r.sessionId === sessionId).sort((a: any, b: any) => a.startedAt - b.startedAt) : []
  if (recs.length) {
    const out: Restarts = { source: 'registry', total: recs.length - 1, effort: 0, addRepo: 0, resume: 0 }
    for (let i = 1; i < recs.length; i++) {
      const was: string[] = recs[i - 1].args || []
      const now: string[] = recs[i].args || []
      if (flagValue(now, '--settings') !== flagValue(was, '--settings')) out.effort += 1
      else if (now.filter((a) => a === '--add-dir').length > was.filter((a) => a === '--add-dir').length) out.addRepo += 1
      else out.resume = (out.resume || 0) + 1
    }
    return out
  }
  // On the same model only: `/model` moves the effort to the new model's default with no restart.
  let effort = 0
  for (let i = 1; i < requests.length; i++) {
    const q = requests[i]
    const p = requests[i - 1]
    if (q.model === p.model && q.effort && p.effort && q.effort !== p.effort) effort += 1
  }
  return { source: 'transcript', total: effort + remounts, effort, addRepo: remounts, resume: null }
}

const contextOf = (q: Request) => q.input + q.cacheRead + q.cacheWrite

/**
 * Cold requests after the first (`COLD_SHARE`), by cause: the cache ran out while nobody spoke
 * (`expired`), the model changed — each model has its own cache — (`modelSwitch`), or something
 * else changed the prompt the cache was keyed on, a restart most often (`invalidated`). A
 * compaction is not one: the context it starts is new and smaller, and writing it is the point.
 */
function coldOf(requests: Request[]) {
  const cold = { turns: 0, tokens: 0, expired: 0, modelSwitch: 0, invalidated: 0 }
  for (let i = 1; i < requests.length; i++) {
    const q = requests[i]
    const p = requests[i - 1]
    const before = contextOf(p)
    if (before < COLD_MIN_CONTEXT || q.cacheRead >= COLD_SHARE * before || contextOf(q) < COLD_SHARE * before) continue
    cold.turns += 1
    cold.tokens += q.cacheWrite
    if (q.at && p.at && q.at - p.at > CACHE_TTL_MS) cold.expired += 1
    else if (q.model !== p.model) cold.modelSwitch += 1
    else cold.invalidated += 1
  }
  return cold
}

/** The leads of what Outpost sends a session, counted off the transcript; one object, so `toolResults` reads the same cache entry. */
const MARKERS = { refusals: REFUSAL_LEAD, retries: RESTART_LEAD, remounts: REMOUNT_LEAD, handoffs: HANDOFF_LEAD }

/** What one chat has spent and what of it the harness caused. Never throws. */
export async function chatTokens(harness: string, ref: unknown): Promise<ChatTokens> {
  const blank = (error: string): ChatTokens => ({
    ok: false,
    error,
    total: emptySpend(),
    main: emptySpend(),
    subagents: { ...emptySpend(), agents: 0 },
    weighted: 0,
    cli: null,
    waste: { refusals: 0, restarts: { source: 'transcript', total: 0, effort: 0, addRepo: 0, resume: null }, cold: { turns: 0, tokens: 0, expired: 0, modelSwitch: 0, invalidated: 0 }, retries: 0, notes: 0, handoffs: 0 },
  })
  let read: any
  try {
    read = await readTokens(harness, ref, { markers: MARKERS })
  } catch (err) {
    return blank(String((err as Error)?.message || err))
  }
  if (!read?.ok) return blank(read?.error || 'Nothing to read')
  const requests: Request[] = read.requests || []
  const main = emptySpend()
  for (const q of requests) add(main, q)
  const subagents = { ...emptySpend(), ...read.subagents }
  const total = emptySpend()
  add(total, main, main.turns)
  add(total, subagents, subagents.turns)
  return {
    ok: true,
    ...(read.missing ? { missing: true } : {}),
    total,
    main,
    subagents,
    weighted: weigh(total),
    cli: read.cli,
    waste: {
      refusals: read.marks?.refusals || 0,
      restarts: await restartsOf(sessionIdOf(harness, ref), requests, read.marks?.remounts || 0),
      cold: coldOf(requests),
      retries: read.marks?.retries || 0,
      notes: read.notes || 0,
      handoffs: read.marks?.handoffs || 0,
    },
  }
}

/**
 * Several conversations' spend as one: a chat started fresh from a handoff (handoff.md) has a
 * transcript per conversation, and its lifetime is their sum. The parts that answered `ok` are
 * added; `conversations` says how many. `cli` is not summed — each part's is its own process's.
 */
export function sumChatTokens(parts: ChatTokens[]) {
  const ok = parts.filter((p) => p.ok)
  const total = emptySpend()
  const main = emptySpend()
  const subagents = { ...emptySpend(), agents: 0 }
  const waste = { refusals: 0, restarts: 0, cold: { turns: 0, tokens: 0 }, retries: 0, notes: 0, handoffs: 0 }
  for (const p of ok) {
    add(total, p.total, p.total.turns)
    add(main, p.main, p.main.turns)
    add(subagents, p.subagents, p.subagents.turns)
    subagents.agents += p.subagents.agents
    waste.refusals += p.waste.refusals
    waste.restarts += p.waste.restarts.total
    waste.cold.turns += p.waste.cold.turns
    waste.cold.tokens += p.waste.cold.tokens
    waste.retries += p.waste.retries
    waste.notes += p.waste.notes
    waste.handoffs += p.waste.handoffs
  }
  return { conversations: ok.length, total, main, subagents, weighted: weigh(total), waste }
}

export type ToolTraffic = { results: Record<string, number[]>; loaded: string[] }

/**
 * Every tool result's size in bytes by tool, and the tools whose schema tool search fetched, for
 * one chat. Kept out of `chatTokens`, which `/api/tokens` answers: a size per call is the
 * report's to sum, not the page's to carry. Read off the same cached pass. Never throws.
 */
export async function toolResults(harness: string, ref: unknown): Promise<ToolTraffic> {
  try {
    const read: any = await readTokens(harness, ref, { markers: MARKERS })
    return read?.tools || { results: {}, loaded: [] }
  } catch {
    return { results: {}, loaded: [] }
  }
}

export type ResultStats = { tool: string; calls: number; bytes: number; median: number; p90: number; max: number; loadedIn: number }

/** The value at a share of the way up a sorted list, nearest rank. */
const rank = (sorted: number[], share: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1))] || 0

/**
 * Many chats' tool traffic summed by tool, largest total first: calls, total bytes, median, p90
 * and max of one result, and in how many chats the tool's schema was fetched. What the cap on
 * each of Outpost's tools is set from (integrations.md); the CLI's own tools are beside them as
 * context, since Outpost cannot cap those.
 */
export function resultStats(chats: ToolTraffic[]): ResultStats[] {
  const sizes = new Map<string, number[]>()
  const loaded = new Map<string, number>()
  for (const c of chats) {
    for (const [tool, list] of Object.entries(c.results)) {
      const into = sizes.get(tool) || []
      for (const n of list) into.push(n)
      sizes.set(tool, into)
    }
    for (const tool of c.loaded) loaded.set(tool, (loaded.get(tool) || 0) + 1)
  }
  const out: ResultStats[] = []
  for (const tool of new Set([...sizes.keys(), ...loaded.keys()])) {
    const sorted = [...(sizes.get(tool) || [])].sort((a, b) => a - b)
    out.push({ tool, calls: sorted.length, bytes: sorted.reduce((n, x) => n + x, 0), median: rank(sorted, 0.5), p90: rank(sorted, 0.9), max: sorted[sorted.length - 1] || 0, loadedIn: loaded.get(tool) || 0 })
  }
  return out.sort((a, b) => b.bytes - a.bytes)
}

export type Piece = { name: string; bytes: number; tokens: number }

export type Overhead = {
  /** Appended to every session's system prompt (launchers.md): the one-command rule and the work rule. */
  rules: Piece[]
  /** Appended only while a repo's setup runs (workspaces.md), measured with one repo named. */
  conditional: Piece[]
  /** The MCP server's instructions and each tool group's descriptions and schemas, as the model is shown them. */
  tools: Piece[]
  /** The groups every workspace chat is granted whatever was ticked and the model is shown: the defaults and `work`. */
  alwaysGroups: string[]
  /**
   * What every workspace session carries at most: the rules, the instructions and the always-granted
   * groups with every description loaded. With tool search on, the CLI defers each MCP tool to
   * its name until the session fetches it (integrations.md), so a session starts at `deferred`
   * and pays a description from the request after it loads that tool.
   */
  always: { bytes: number; tokens: number }
  /** The floor while tool search defers the tools: the rules, the instructions, and the always-granted tools' names, one a line as the CLI lists them. */
  deferred: { bytes: number; tokens: number }
}

const piece = (name: string, text: string): Piece => ({ name, bytes: Buffer.byteLength(text, 'utf8'), tokens: approxTokens(text) })

/**
 * What every session pays before it says a word, measured from the real constants. A tool group
 * is measured as the CLI shows it to the model — name, description, input schema — and with
 * everything it grants, configured or not: `tools/list` drops a Jenkins tool with no Jenkins,
 * so this is the most a grant can cost, which is the number a budget wants.
 */
export function fixedOverhead(): Overhead {
  const rules = [piece('reply rule', REPLY_RULE), piece('one-command rule', ONE_COMMAND_RULE), piece('work rule', WORK_RULE)]
  // Sent only when a trigger fires, never standing (handoff.md); budgeted so it cannot grow unseen.
  const conditional = [
    piece('setup notice', setupNotice(['repo'])),
    // Standing, but only for a chat that declares ports (workspaces.md); measured at two.
    piece('ports rule', portsRule({ container: { ports: [{ label: 'App', internal: 3000 }, { label: 'API', internal: 8080 }] } })),
    piece('handoff request', handoffRequest('000000', 'the person has stepped away')),
    // What wraps the handoff in a fresh conversation's first message, the handoff itself left out.
    piece('fresh start', freshPrompt('')),
    // What follows a routine's prompt in its run's first message, never standing (routines.md);
    // measured at one step named like a short routine.
    piece('routine ending', routineEnding(normaliseRoutine({ id: '00000000', name: 'Website docs' })!)),
    // The lead `/createRoutine` sends with the person's words, once, when typed (routines-tools.md).
    piece('createRoutine lead', commandLead('createRoutine')),
    // The lead `/securityAudit` sends, once, when typed (api.md); the skill it points at is read
    // only by that chat, as files, and costs nothing until then. Measured with `{dir}` unfilled.
    piece('securityAudit lead', commandLead('securityAudit')),
    // What a defining chat's session is told in front of the person's first message, once
    // (routines.md, *Defining chats*); for Change…, measured around a one-step routine with a
    // one-line prompt, the definition itself being the person's.
    piece('defining lead', definingLead()),
    piece('changing lead', definingLead(normaliseRoutine({ id: '00000000', name: 'Website docs', triggers: [{ kind: 'time', cron: '0 6 * * *', tz: 'UTC' }], prompt: 'Check the docs.' })!)),
    // What a run started by a call is told about it, around the caller's body (routines-triggers.md);
    // measured with a body of one short field, since the body itself is the caller's and capped apart.
    piece('call data', callData('website-push', { ref: 'main' })),
  ]
  const tools = [piece('mcp instructions', MCP_INSTRUCTIONS)]
  // `approval` is not measured: its one tool is the CLI's prompt tool, disallowed to the
  // model at launch (launchers.md), so no session is shown its description at all.
  for (const group of Object.keys(TOOL_GROUPS).filter((g) => g !== 'approval')) tools.push(piece(`tools: ${group}`, JSON.stringify(offeredTools([group]))))
  const alwaysGroups = [...new Set([...DEFAULT_TOOLS, 'work'])]
  const always = [...rules, tools[0], ...tools.filter((t) => alwaysGroups.includes(t.name.replace(/^tools: /, '')))]
  const names = piece('names', offeredTools(alwaysGroups).map((t) => t.name).join('\n'))
  const floor = [...rules, tools[0], names]
  return {
    rules,
    conditional,
    tools,
    alwaysGroups,
    always: { bytes: always.reduce((n, p) => n + p.bytes, 0), tokens: always.reduce((n, p) => n + p.tokens, 0) },
    deferred: { bytes: floor.reduce((n, p) => n + p.bytes, 0), tokens: floor.reduce((n, p) => n + p.tokens, 0) },
  }
}
