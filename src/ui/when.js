/**
 * The one clock the page shows: "Oct 2 · 10:06 AM".
 *
 * Every timestamp carries a short date, even today's. A chat is read back days later, often
 * on a phone, and a bare "10:06" above a message then means nothing — the day grouping in the
 * chat list is not visible from inside a conversation. Twelve-hour with a meridiem because that
 * is how the person reading it tells the time; the server's logs stay ISO.
 */
export function when(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const date = d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  const clock = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return `${date} · ${clock}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAY_MS = 86_400_000

/** How far `zone`'s wall clock is ahead of UTC at instant `t`, in ms. */
function offset(fmt, t) {
  const p = Object.fromEntries(fmt.formatToParts(t).map((x) => [x.type, x.value]))
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - Math.floor(t / 60_000) * 60_000
}

/**
 * The CLI's limit line, "You've hit your session limit · resets 3:40pm (UTC)", read in the
 * reader's own clock: "resets Oct 5 · 11:40 AM". The CLI writes the machine's zone, which on a
 * server is UTC, and a person on a phone otherwise does the sum in their head — beside a usage
 * card that already shows the same reset in local time. A bare time is the next one after the
 * message was written (`ts`); a line whose zone this browser does not know is left as written.
 */
export function localizeResets(text, ts) {
  if (!text || !text.includes('resets ')) return text
  const anchor = ts ? new Date(ts).getTime() : Date.now()
  return text.replace(
    /\bresets (?:([A-Z][a-z]{2}) (\d{1,2}),? )?(\d{1,2})(?::(\d{2}))? ?([ap]m) \(([\w/+-]+)\)/gi,
    (all, mon, day, hh, mm, ap, zone) => {
      let fmt
      try {
        fmt = new Intl.DateTimeFormat('en-US', {
          timeZone: zone, hourCycle: 'h23',
          year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
        })
      } catch {
        return all
      }
      const month = mon ? MONTHS.findIndex((m) => m.toLowerCase() === mon.toLowerCase()) : -1
      if (mon && month < 0) return all
      const hour = (+hh % 12) + (ap.toLowerCase() === 'pm' ? 12 : 0)
      const here = Object.fromEntries(fmt.formatToParts(anchor).map((x) => [x.type, x.value]))
      // The wall time in `zone` to an instant: subtract the zone's offset, then again at the
      // result, which is only different across a DST change.
      const at = (y, m, d) => {
        const wall = Date.UTC(y, m, d, hour, +(mm || 0))
        const guess = wall - offset(fmt, wall)
        return wall - offset(fmt, guess)
      }
      let t
      if (mon) {
        t = at(+here.year, month, +day)
        if (t < anchor - DAY_MS) t = at(+here.year + 1, month, +day) // "Jan 2" written on Dec 30
      } else {
        t = at(+here.year, +here.month - 1, +here.day)
        if (t < anchor) t += DAY_MS
      }
      return Number.isFinite(t) ? `resets ${when(t)}` : all
    },
  )
}
