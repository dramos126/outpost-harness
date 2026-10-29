/**
 * Posting to a Discord webhook.
 *
 * Deliberately the whole of what this file knows: a URL, a payload shape, and what Discord
 * does when you talk to it too fast. Which *events* are worth a message, and what they should
 * say, is `index.mjs`'s — so a second destination is a sibling of this file rather than a
 * rewrite of the thing above it.
 */

/** Discord's own cap on an embed description. Longer and the whole post is rejected. */
const MAX_DESCRIPTION = 4096
/** How long to wait on the network before giving up. A notification is never worth a hang. */
const TIMEOUT_MS = 10_000

/** Embed colours, as Discord's decimal ints. The same amber/red split the page draws. */
export const COLOR = {
  amber: 0xc9834f,
  red: 0xc94f4f,
  green: 0x4f9a63,
  grey: 0x8b8b85,
}

/**
 * Send one embed. Never throws: a notification that fails must not take down the supervisor
 * that raised it, and the caller has nowhere useful to report to anyway.
 *
 * Discord answers a webhook with 204 and no body on success. A 429 carries `retry_after`, and
 * this does not honour it — one retry per stall, at a rate measured in tens of minutes, cannot
 * reach a rate limit that a queue would help with. If that changes, queue here rather than in
 * the caller.
 */
export async function postDiscord(url, { title, description, color = COLOR.grey, footer = '' }) {
  if (!url) return { ok: false, error: 'No Discord webhook is configured' }

  const embed = {
    title: String(title || 'Outpost').slice(0, 256),
    description: String(description || '').slice(0, MAX_DESCRIPTION),
    color,
  }
  if (footer) embed.footer = { text: String(footer).slice(0, 2048) }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // No mention in any text Outpost posts may ping: much of it is a hook's or a chat's words,
      // and an `@everyone` there would page a whole server. Outpost itself mentions nobody.
      body: JSON.stringify({ username: 'Outpost', embeds: [embed], allowed_mentions: { parse: [] } }),
      signal: controller.signal,
    })
    if (!res.ok) {
      // The body is Discord's own error and is the only thing that says *why* — a webhook
      // deleted in the server's UI answers 404 and looks exactly like a typo from here.
      const body = await res.text().catch(() => '')
      return { ok: false, error: `Discord answered ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? 'Discord did not answer in time' : String(err?.message || err) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Text that is not Outpost's (a hook's error, a failure's reason) as one Discord quote line. A
 * newline ends a `>` quote, so a hook's `error_details` could otherwise go on in Outpost's own
 * voice below it ("Restarting at …", a fake link): every line break becomes a space.
 */
export const quote = (text) => `> ${String(text ?? '').replace(/[\r\n\u0085\u2028\u2029]+/g, ' ').trim()}`

const ROW = /^\s*\|.*\|\s*$/
const RULE = /^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*(:?-{3,}:?\s*)?$/
const cellsOf = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())

/**
 * A markdown table as a list of rows, each cell under its column's name. Discord draws no
 * tables, and a phone wraps a code block at about 35 characters, so a 5×5 table came through as
 * broken rows of pipes (2026-10-08). A whole fenced block that is a table is unfenced first: a
 * chat fences one to make the columns line up, which is exactly what a phone cannot show.
 */
export function tablesAsLists(text) {
  const lines = String(text).split('\n')
  const out = []
  for (let i = 0; i < lines.length; ) {
    // A fence whose whole inside is a table: drop the fence and let the table be read below.
    if (/^\s*```/.test(lines[i])) {
      const end = lines.findIndex((l, j) => j > i && /^\s*```\s*$/.test(l))
      const inside = end > 0 ? lines.slice(i + 1, end) : []
      if (inside.length >= 2 && RULE.test(inside[1]) && inside.every((l) => ROW.test(l) || !l.trim())) {
        lines.splice(i, end - i + 1, ...inside.filter((l) => l.trim()))
      } else {
        const stop = end > 0 ? end + 1 : lines.length
        out.push(...lines.slice(i, stop))
        i = stop
        continue
      }
    }
    if (ROW.test(lines[i]) && RULE.test(lines[i + 1] || '')) {
      const head = cellsOf(lines[i])
      let j = i + 2
      const rows = []
      for (; j < lines.length && ROW.test(lines[j]); j++) rows.push(cellsOf(lines[j]))
      if (out.length && out.at(-1).trim()) out.push('')
      out.push(rows.map((r) => r.map((c, k) => (head[k] ? `**${head[k]}:** ${c}` : c)).filter((c, k) => r[k]).join('\n')).join('\n\n'))
      if (lines[j]?.trim()) out.push('')
      i = j
      continue
    }
    out.push(lines[i++])
  }
  return out.join('\n')
}

/**
 * Does this look like a Discord webhook at all? Checked before saving so a paste that went
 * wrong is refused while the person is still looking at the box, rather than discovered
 * silently three hours later when the thing it was meant to tell them about happens.
 */
export function looksLikeWebhook(url) {
  try {
    const u = new URL(String(url))
    if (u.protocol !== 'https:') return false
    if (!/(^|\.)discord(app)?\.com$/.test(u.hostname)) return false
    return /^\/api\/(v\d+\/)?webhooks\/\d+\/[\w-]+$/.test(u.pathname)
  } catch {
    return false
  }
}
