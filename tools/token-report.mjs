/**
 * A baseline of what Outpost's chats have spent in tokens, and what of it the harness caused.
 *
 *   yarn tokens:report            # every chat in an Outpost workspace on this machine
 *   yarn tokens:report --all      # every Claude Code session on this machine
 *   yarn tokens:report --top 20   # only the twenty costliest rows (totals still count all)
 *   yarn tokens:report --json     # one line per chat, then the totals and the overhead
 *
 * Read off disk (server/tokens.ts, usage.md): nothing is asked of Anthropic and nothing is
 * written. Rows are ranked by `weighted` — tokens against one fresh input token at the ratios
 * every current model shares — so the ranking needs no price list; the CLI's own dollar figure
 * is beside it where the transcript carries one. Restarts are by cause only where the
 * launcher's records are on this machine; elsewhere they are what the transcript shows. Tool
 * results are sized per tool — Outpost's own, which it caps, apart from the CLI's.
 */
import { scanAll } from '../server/scan.mjs'
import { WORKSPACES_DIR } from '../server/workspaces/index.mjs'
import { allRecords } from '../server/launchers/structured.mjs'
import { chatTokens, fixedOverhead, resultStats, toolResults, weigh } from '../server/tokens.ts'

const args = process.argv.slice(2)
const all = args.includes('--all')
const asJson = args.includes('--json')
const topAt = args.indexOf('--top')
const top = topAt === -1 ? 0 : Number(args[topAt + 1]) || 0

/** 1234 → "1.2k": columns read at a glance. */
function count(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}G`
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`
  return String(Math.round(n || 0))
}
const pct = (part, whole) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : '—')
const pad = (s, n) => String(s).padEnd(n).slice(0, n)
const lpad = (s, n) => String(s).padStart(n)

const { threads, failed } = await scanAll()
if (failed.length) console.error(`Skipped harnesses whose scan failed: ${failed.join(', ')}`)
const inside = (cwd) => String(cwd || '').startsWith(WORKSPACES_DIR + '/')
const chosen = threads.filter((t) => all || inside(t.cwd))

const rows = []
const traffic = []
for (const t of chosen) {
  const r = await chatTokens(t.harness, t.ref)
  if (!r.ok || !r.total.turns) continue
  traffic.push(await toolResults(t.harness, t.ref))
  rows.push({ id: t.id, title: t.title || t.preview || '', project: t.project || '', at: t.lastActivityAt || 0, ...r })
}
rows.sort((a, b) => b.weighted - a.weighted)

const totals = { chats: rows.length, spend: { turns: 0, input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 }, subagentTurns: 0, costUSD: 0, withCli: 0 }
const waste = { refusals: 0, restarts: 0, effort: 0, addRepo: 0, resume: 0, resumeUnknown: 0, cold: 0, coldTokens: 0, expired: 0, modelSwitch: 0, invalidated: 0, retries: 0, notes: 0 }
for (const r of rows) {
  for (const k of Object.keys(totals.spend)) totals.spend[k] += r.total[k]
  totals.subagentTurns += r.subagents.turns
  if (r.cli) {
    totals.costUSD += r.cli.costUSD
    totals.withCli += 1
  }
  const w = r.waste
  waste.refusals += w.refusals
  waste.restarts += w.restarts.total
  waste.effort += w.restarts.effort
  waste.addRepo += w.restarts.addRepo
  if (w.restarts.resume === null) waste.resumeUnknown += 1
  else waste.resume += w.restarts.resume
  waste.cold += w.cold.turns
  waste.coldTokens += w.cold.tokens
  waste.expired += w.cold.expired
  waste.modelSwitch += w.cold.modelSwitch
  waste.invalidated += w.cold.invalidated
  waste.retries += w.retries
  waste.notes += w.notes
}
const overhead = fixedOverhead()
const results = resultStats(traffic)
// Outpost's own tools are the ones it can cap; the CLI's, and other servers', are context.
const ours = results.filter((x) => x.tool.startsWith('mcp__outpost__'))
const theirs = results.filter((x) => !x.tool.startsWith('mcp__outpost__'))

if (asJson) {
  for (const r of rows) console.log(JSON.stringify(r))
  console.log(JSON.stringify({ totals, waste, overhead, results: { outpost: ours, other: theirs } }))
  process.exit(0)
}

const s = totals.spend
const weighted = weigh(s)
const raw = s.input + s.cacheRead + s.cacheWrite + s.output
console.log(`${rows.length} chats ${all ? 'on this machine' : `in ${WORKSPACES_DIR}`} with any requests, ${s.turns} requests (${totals.subagentTurns} by subagents)\n`)

console.log('Totals')
console.log(`  fresh input   ${lpad(count(s.input), 7)}   ${lpad(pct(s.input, raw), 6)} of tokens   ${lpad(pct(s.input, weighted), 6)} of weighted cost`)
console.log(`  cache read    ${lpad(count(s.cacheRead), 7)}   ${lpad(pct(s.cacheRead, raw), 6)} of tokens   ${lpad(pct(s.cacheRead * 0.1, weighted), 6)} of weighted cost`)
console.log(
  `  cache written ${lpad(count(s.cacheWrite), 7)}   ${lpad(pct(s.cacheWrite, raw), 6)} of tokens   ${lpad(pct((s.cacheWrite - s.cacheWrite1h) * 1.25 + s.cacheWrite1h * 2, weighted), 6)} of weighted cost  (${pct(s.cacheWrite1h, s.cacheWrite)} with the one-hour lifetime)`
)
console.log(`  output        ${lpad(count(s.output), 7)}   ${lpad(pct(s.output, raw), 6)} of tokens   ${lpad(pct(s.output * 5, weighted), 6)} of weighted cost`)
console.log(`  weighted      ${lpad(count(weighted), 7)}   input-token equivalents`)
console.log(`  CLI's own count: $${totals.costUSD.toFixed(2)} at API prices, from ${totals.withCli} of ${rows.length} chats\n`)

console.log('Harness waste')
console.log(`  refused Bash chains       ${waste.refusals} (each a turn)`)
console.log(
  `  restarts in place         ${waste.restarts}: effort ${waste.effort}, repo added ${waste.addRepo}, resume ${waste.resume}${waste.resumeUnknown ? ` (unknown for ${waste.resumeUnknown} chats with no launcher records here)` : ''}`
)
// The registry is read from OUTPOST_DATA, else the checkout's own data/; the running server's
// unit sets the first, so a report run by hand without it finds none and every Resume reads as
// unknown — the owner's first run did exactly that.
if (!process.env.OUTPOST_DATA && !(await allRecords().catch(() => [])).length) {
  console.log(`  (no launcher records here: the running server keeps them in the OUTPOST_DATA its unit sets, deploy/outpost.service — try OUTPOST_DATA=~/.outpost/data yarn tokens:report)`)
}
console.log(`  cold requests             ${waste.cold}, ${count(waste.coldTokens)} tokens written again (${pct(waste.coldTokens, s.cacheWrite)} of all cache writes): ${waste.expired} after an idle hour, ${waste.modelSwitch} on a model switch, ${waste.invalidated} otherwise (a restart, most often)`)
console.log(`  retries sent              ${waste.retries}`)
console.log(`  notes sent                ${waste.notes}\n`)

console.log('Fixed per-session overhead (bytes, ≈tokens at four characters a token)')
for (const p of [...overhead.rules, ...overhead.conditional, ...overhead.tools]) {
  const always = overhead.rules.includes(p) || p.name === 'mcp instructions' || overhead.alwaysGroups.includes(p.name.replace(/^tools: /, ''))
  console.log(`  ${pad(p.name, 22)} ${lpad(p.bytes, 6)} B  ≈${lpad(p.tokens, 5)}  ${always ? 'every session' : p.name === 'setup notice' ? 'while setup runs' : 'when granted'}`)
}
console.log(`  ${pad('every session', 22)} ${lpad(overhead.always.bytes, 6)} B  ≈${lpad(overhead.always.tokens, 5)}  at most: every description of ${overhead.alwaysGroups.join(', ')} loaded`)
console.log(`  ${pad('  with tools deferred', 22)} ${lpad(overhead.deferred.bytes, 6)} B  ≈${lpad(overhead.deferred.tokens, 5)}  at least: the rules, the instructions and the tools' names\n`)

/** One table of result sizes; `loaded` is in how many chats tool search fetched the tool's schema. */
function resultTable(title, list) {
  console.log(title)
  console.log(`  ${pad('tool', 36)} ${lpad('calls', 6)} ${lpad('total', 7)} ${lpad('median', 7)} ${lpad('p90', 7)} ${lpad('max', 7)} ${lpad('loaded', 6)}`)
  for (const x of list) {
    console.log(`  ${pad(x.tool.replace(/^mcp__outpost__/, ''), 36)} ${lpad(x.calls, 6)} ${lpad(count(x.bytes), 7)} ${lpad(count(x.median), 7)} ${lpad(count(x.p90), 7)} ${lpad(count(x.max), 7)} ${lpad(x.loadedIn || '', 6)}`)
  }
  if (!list.length) console.log('  none')
  console.log('')
}
resultTable("Tool results, Outpost's own (bytes of text per result; loaded: chats that fetched its schema)", ours)
resultTable('Tool results, the CLI\'s and other servers\' (context: Outpost cannot cap these)', theirs.slice(0, 20))

const shown = top ? rows.slice(0, top) : rows
console.log('Per chat, costliest first')
console.log(`  ${pad('chat', 8)}  ${pad('title', 34)} ${lpad('req', 5)} ${lpad('read', 7)} ${lpad('written', 7)} ${lpad('out', 6)} ${lpad('weighted', 8)} ${lpad('$cli', 8)}  ${lpad('ref', 3)} ${lpad('rst', 3)} ${lpad('cold', 4)} ${lpad('rewrote', 7)}`)
for (const r of shown) {
  const w = r.waste
  console.log(
    `  ${pad(r.id.slice(0, 8), 8)}  ${pad(r.title.replace(/\s+/g, ' '), 34)} ${lpad(r.total.turns, 5)} ${lpad(count(r.total.cacheRead), 7)} ${lpad(count(r.total.cacheWrite), 7)} ${lpad(count(r.total.output), 6)} ${lpad(count(r.weighted), 8)} ${lpad(r.cli ? r.cli.costUSD.toFixed(2) : '—', 8)}  ${lpad(w.refusals, 3)} ${lpad(`${w.restarts.total}${w.restarts.source === 'transcript' ? '*' : ''}`, 3)} ${lpad(w.cold.turns, 4)} ${lpad(count(w.cold.tokens), 7)}`
  )
}
if (shown.length < rows.length) console.log(`  … ${rows.length - shown.length} more`)
console.log(`\n  ref: refused chains · rst: restarts in place (* from the transcript alone: effort and /addRepo only) · cold: requests that began with a cold cache`)
process.exit(0)
