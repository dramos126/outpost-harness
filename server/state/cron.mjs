/**
 * Five-field cron, matched against wall-clock time in a named timezone.
 *
 * `minute hour day-of-month month day-of-week`, with `*`, lists, ranges, steps and the usual
 * names; day-of-month and day-of-week are OR-ed when both are restricted, as cron has always
 * done. The timezone is the one the schedule was written in, carried beside the expression,
 * because this server runs in UTC and the one time Outpost formatted a time in its own zone it
 * was four hours wrong (resilience.md). No library: the whole of what a schedule needs is a
 * parser for one line and a question — does this minute match — asked once a minute.
 */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

const RANGES = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week, 7 = Sunday too
]

function parseField(text, index) {
  const [lo, hi] = RANGES[index]
  const names = index === 3 ? MONTHS : index === 4 ? DAYS : null
  const value = (s) => {
    const t = s.toLowerCase()
    if (names) {
      const i = names.indexOf(t.slice(0, 3))
      if (i >= 0) return index === 3 ? i + 1 : i
    }
    if (!/^\d+$/.test(t)) throw new Error(`"${s}" is not a number in a cron field`)
    return Number(t)
  }
  const set = new Set()
  const star = text === '*'
  for (const part of text.split(',')) {
    const [rangeText, stepText] = part.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) throw new Error(`"${part}" has a bad step`)
    let from
    let to
    if (rangeText === '*') {
      from = lo
      to = hi
    } else if (rangeText.includes('-')) {
      const [a, b] = rangeText.split('-')
      from = value(a)
      to = value(b)
    } else {
      from = value(rangeText)
      to = stepText === undefined ? from : hi
    }
    if (from < lo || to > hi || from > to) throw new Error(`"${part}" is outside ${lo}-${hi}`)
    for (let v = from; v <= to; v += step) set.add(index === 4 && v === 7 ? 0 : v)
  }
  return { set, star }
}

/** Parse an expression. Throws with a sentence a person can act on. */
export function parseCron(expression) {
  const fields = String(expression || '')
    .trim()
    .split(/\s+/)
  if (fields.length !== 5) throw new Error('A cron expression is five fields: minute hour day month weekday')
  const [minute, hour, dom, month, dow] = fields.map(parseField)
  return { minute, hour, dom, month, dow, expression: fields.join(' ') }
}

const formatters = new Map()
function formatter(tz) {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      minute: 'numeric',
      hour: 'numeric',
      day: 'numeric',
      month: 'numeric',
      weekday: 'short',
    })
    formatters.set(tz, f)
  }
  return f
}

/** Whether a timezone name is one this runtime knows. */
export function validTimezone(tz) {
  try {
    formatter(tz)
    return true
  } catch {
    return false
  }
}

/** The wall-clock fields of an instant in a timezone. */
export function partsIn(ms, tz) {
  const parts = {}
  for (const p of formatter(tz).formatToParts(new Date(ms))) parts[p.type] = p.value
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour) % 24,
    day: Number(parts.day),
    month: Number(parts.month),
    weekday: DAYS.indexOf(String(parts.weekday || '').toLowerCase().slice(0, 3)),
  }
}

/** Does the minute containing `ms` match, read in `tz`? */
export function matches(cron, ms, tz) {
  const t = partsIn(ms, tz)
  if (!cron.minute.set.has(t.minute) || !cron.hour.set.has(t.hour) || !cron.month.set.has(t.month)) return false
  const domOk = cron.dom.set.has(t.day)
  const dowOk = cron.dow.set.has(t.weekday)
  if (cron.dom.star && cron.dow.star) return true
  if (cron.dom.star) return dowOk
  if (cron.dow.star) return domOk
  return domOk || dowOk
}

/** The next matching minute strictly after `fromMs`, within a year, or 0. */
export function nextMatch(cron, fromMs, tz) {
  const start = Math.floor(fromMs / 60000) * 60000 + 60000
  const limit = start + 366 * 24 * 60 * 60000
  for (let t = start; t < limit; t += 60000) {
    if (matches(cron, t, tz)) return t
  }
  return 0
}

/** Up to `n` matching minutes after `fromMs`, soonest first — what a person checks a routine by. */
export function nextMatches(cron, fromMs, tz, n) {
  const out = []
  for (let t = fromMs; out.length < n; ) {
    t = nextMatch(cron, t, tz)
    if (!t) break
    out.push(t)
  }
  return out
}

const clock12 = (h, m) => `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
const DAY_WORDS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']
const ordinal = (n) => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`
const and = (words) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`)

/**
 * An expression in words, in the routine's own wall clock: "Weekdays at 4:15 PM". Only the
 * shapes people write; anything else is said as the expression itself, because a sentence that
 * is nearly right about when a run happens is worse than the cron a person can read.
 */
export function describeCron(expression) {
  let c
  try {
    c = parseCron(expression)
  } catch {
    return `cron \`${String(expression || '').trim()}\``
  }
  const [mi, h, dom, mon, dow] = c.expression.split(' ')
  const single = (s) => /^\d+$/.test(s)
  const fallback = `cron \`${c.expression}\``
  if (mon !== '*') return fallback
  if (single(mi) && single(h)) {
    const at = `at ${clock12(Number(h), Number(mi))}`
    if (dom === '*') {
      const days = [...c.dow.set].sort((a, b) => a - b)
      if (dow === '*' || days.length === 7) return `Every day ${at}`
      if (days.join() === '1,2,3,4,5') return `Weekdays ${at}`
      if (days.join() === '0,6') return `Weekends ${at}`
      return `${and(days.map((d) => DAY_WORDS[d]))} ${at}`
    }
    if (dow === '*' && single(dom)) return `On the ${ordinal(Number(dom))} of every month ${at}`
    return fallback
  }
  if (dom !== '*' || dow !== '*') return fallback
  if (single(mi) && h === '*') return `Every hour at :${mi.padStart(2, '0')}`
  if (h === '*' && mi === '*') return 'Every minute'
  const step = /^\*\/(\d+)$/.exec(mi)
  if (step && h === '*') return `Every ${step[1]} minutes`
  return fallback
}

/** An instant as ISO 8601 in a timezone, with its offset: `2026-10-06T16:15-04:00`. */
export function isoIn(ms, tz) {
  const parts = {}
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZoneName: 'longOffset' })
  for (const p of f.formatToParts(new Date(ms))) parts[p.type] = p.value
  const offset = String(parts.timeZoneName || '').replace('GMT', '') || '+00:00'
  return `${parts.year}-${parts.month}-${parts.day}T${String(Number(parts.hour) % 24).padStart(2, '0')}:${parts.minute}${offset}`
}

/** Every matching minute in `(fromMs, toMs]`, oldest first — what a runner owes after a gap. */
export function matchesBetween(cron, fromMs, toMs, tz) {
  const out = []
  const start = Math.floor(fromMs / 60000) * 60000 + 60000
  const end = Math.floor(toMs / 60000) * 60000
  for (let t = start; t <= end; t += 60000) if (matches(cron, t, tz)) out.push(t)
  return out
}
