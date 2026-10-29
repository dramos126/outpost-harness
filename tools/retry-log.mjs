/**
 * Read back what the retry supervisor decided.
 *
 *   yarn retry:log                      # everything still on disk, oldest first
 *   yarn retry:log --tail 40            # the last 40 decisions
 *   yarn retry:log --session 468e77b2   # one session, by id or by any prefix of one
 *   yarn retry:log --json               # the raw lines, for piping somewhere
 *
 * The file is written by `server/state/retry-log.mjs`; this only renders it. Times are printed
 * local, because the question this answers is always "what was happening at half nine" and the
 * person asking it is sitting in front of the machine.
 */
import path from 'node:path'
import { readDecisions, LOG_FILE, PREV_FILE } from '../server/state/retry-log.mjs'

const args = process.argv.slice(2)
const flag = (name) => {
  const at = args.indexOf(name)
  return at === -1 ? '' : args[at + 1] || ''
}

const session = flag('--session')
const tail = Number(flag('--tail')) || 0
const asJson = args.includes('--json')

const sameDay = (ms) => new Date(ms).toDateString() === new Date().toDateString()

/**
 * A moment, with the date only when it is not today. A weekly window resetting "at 03:50" is
 * the sort of half-answer that sent the first diagnosis of these bugs down the wrong road.
 */
const clock = (ms) => {
  if (!ms) return '—'
  const d = new Date(ms)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return sameDay(ms) ? time : `${d.toLocaleDateString([], { month: 'short', day: '2-digit' })} ${time}`
}

/** "4h 9m", "14s" — how long something is, with no claim about which way. */
function dur(ms) {
  const n = Math.abs(ms)
  const h = Math.floor(n / 3_600_000)
  const m = Math.floor((n % 3_600_000) / 60_000)
  const s = Math.floor((n % 60_000) / 1000)
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`
}

/** The same, placed against now: "in 4h 9m", "14s ago". */
const span = (ms) => (ms >= 0 ? `in ${dur(ms)}` : `${dur(ms)} ago`)

/** One line of the story, per event. Everything else stays in `--json`. */
function line(rec) {
  switch (rec.event) {
    case 'stall':
      return [
        `${rec.restall ? 're-stalled' : 'stalled'} on ${rec.kind} (${rec.class})`,
        rec.exhausted
          ? `budget already spent — ${rec.attempts} of ${rec.max}, not scheduling`
          : `next attempt ${clock(rec.nextAt)} (${span(rec.inMs)}), ${rec.why}${rec.blind ? ' [blind]' : ''}`,
        rec.attempts ? `${rec.attempts} of ${rec.max} already spent` : '',
      ]
        .filter(Boolean)
        .join(' · ')
    case 'refine':
      return `guess replaced: ${clock(rec.was)} → ${clock(rec.nextAt)}, ${rec.why}`
    case 'send':
      return `sent the restart, attempt ${rec.attempt} of ${rec.max}${rec.manual ? ' (by hand)' : ''}${
        rec.stallAt ? ` — ${dur(rec.waitedMs)} after the stall` : ''
      }`
    case 'refused':
      return `no send: ${rec.reason} (${rec.spent ? 'attempt spent' : 'no attempt spent'})`
    case 'drop':
      return `budget dropped (${rec.attempts} spent): ${rec.reason}`
    case 'broken':
      return `not retryable: ${rec.kind} (${rec.class}) — ${rec.reason}`
    case 'exhausted':
      return `stopped trying after ${rec.attempts} of ${rec.max}`
    case 'gave-up':
      return `could not send at all: ${rec.reason}`
    case 'manual':
      return `person pressed Restart — budget was ${rec.attempts}${rec.wasExhausted ? ' (exhausted)' : ''}${
        rec.wasDueAt ? `, next was due ${clock(rec.wasDueAt)}` : ''
      }`
    default:
      return rec.event
  }
}

/** The windows a schedule was built on, one per line under it. This is the diagnostic. */
function usageLines(usage) {
  if (!usage) return []
  if (!usage.ok) return [`      usage: unavailable — ${usage.error || 'no reason given'}`]
  if (!usage.limits?.length) return ['      usage: answered, but published no limits']
  return usage.limits.map(
    (l) =>
      `      ${l.active ? '*' : ' '} ${l.label}: ${l.percent}% ${
        l.resetsAt ? `resets ${clock(Date.parse(l.resetsAt))} (${span(Date.parse(l.resetsAt) - Date.now())})` : 'no reset published'
      }`,
  )
}

const decisions = await readDecisions({ session, limit: tail })

if (asJson) {
  for (const rec of decisions) console.log(JSON.stringify(rec))
} else if (!decisions.length) {
  console.log(`No decisions logged${session ? ` for ${session}` : ''}.`)
  console.log(`Looked in ${LOG_FILE} and ${PREV_FILE}.`)
} else {
  for (const rec of decisions) {
    const at = new Date(rec.t)
    const stamp = `${at.toLocaleDateString([], { month: 'short', day: '2-digit' })} ${clock(at.getTime())}`
    const where = rec.cwd ? ` ${path.basename(rec.cwd)}` : ''
    console.log(`${stamp}  ${String(rec.session || '').slice(0, 8)}${where}  ${line(rec)}`)
    // Stars mark the window the account is actually being measured against; the schedule takes
    // the soonest future reset of any of them, which is the thing worth checking by eye.
    for (const l of usageLines(rec.usage)) console.log(l)
  }
  console.log(`\n${decisions.length} decision${decisions.length === 1 ? '' : 's'} from ${LOG_FILE}`)
}
