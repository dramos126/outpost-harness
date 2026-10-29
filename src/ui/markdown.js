/**
 * Markdown for the conversation log — the small subset a coding session actually writes.
 *
 * The transcript stores what the model said as raw Markdown, and drawing it as preformatted
 * text puts `##`, `**`, backtick fences and pipe-drawn tables on screen exactly as typed.
 * A table is the worst of it: a hundred pipes wrapped into a fifteen-line paragraph, which is
 * how the panel looked beside the same answer on claude.ai.
 *
 * It is deliberately not a CommonMark implementation — no reference links, no HTML
 * passthrough, no setext headings. Headings, lists, tables, quotes, rules, fenced and inline
 * code, links, bold and italic is everything a session emits, and every line it does not
 * recognise falls through to a paragraph rather than disappearing.
 *
 * **Everything is escaped before anything is built.** The input is a transcript, which
 * contains whatever the model read off disk or off the network, so it is untrusted text:
 * escape first, then insert tags, and never put source text into markup unescaped. The only
 * attribute this file ever writes is an `href`, and only after `safeHref` has agreed to the
 * scheme — a `javascript:` link in a tool result would otherwise be one click from running.
 */

import { PATH_TOKEN } from '../../server/lib/paths.mjs'

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c])

/** Links are drawn only for schemes that can do nothing but navigate. */
const safeHref = (url) => (/^(https?:\/\/|mailto:)/i.test(url) ? url : null)

const link = (href, label) => `<a href="${href}" target="_blank" rel="noreferrer noopener">${label}</a>`

/**
 * A file path the session wrote in prose, as a button that opens it in the Files section
 * (`wirePathLinks`; ui-details.md). The rule is the server's own (`PATH_TOKEN`, harnesses.md
 * `readFiles`), so what the log links is exactly what the list calls a mention. Run on escaped
 * text, so `data-path` is already safe for an attribute. A `:42` line reference stays in the
 * label and out of the path. Before the link rules, which would otherwise find a path inside an
 * `href`; and inside a code span as well, since that is how a session usually writes one.
 */
const pathButton = (p, label) => `<button type="button" class="path" data-path="${p}">${label}</button>`
const pathLinks = (s) => s.replace(PATH_TOKEN, (whole, before, p, line) => `${before}${pathButton(p, p + (line || ''))}`)
/** `href` when the whole of it is one path token — a Markdown link to a file is the same button, with its label. */
const asPath = (href) => {
  const m = [...` ${href}`.matchAll(PATH_TOKEN)]
  return m.length === 1 && m[0][2] === href ? href : null
}

/** A line that ends whatever paragraph is being collected, because it opens a block. */
const OPENS_BLOCK = /^\s{0,3}(#{1,6}\s|>|```|~~~|([-*+]|\d{1,9}[.)])\s)/

/**
 * The spans inside one block of text.
 *
 * Code spans come out first and go back in last: every other rule here would happily format
 * the code inside them, and `**` in a shell command is not emphasis.
 */
const inline = (text) => {
  const spans = []
  let s = escape(text)
  s = s.replace(/(`+)([\s\S]*?)\1(?!`)/g, (whole, ticks, body) => {
    if (!body.trim()) return whole
    // The placeholder is a NUL sentinel, because it has to be something the prose around it
    // cannot contain: a readable marker like ` 3 ` gets put back over the first bare 3 in the
    // sentence instead of over the code span it stood for.
    spans.push(`<code>${pathLinks(body.replace(/^ | $/g, ''))}</code>`)
    return `\u0000${spans.length - 1}\u0000`
  })
  s = pathLinks(s)
  s = s.replace(/\[([^\]\n]*)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (whole, label, href) => {
    const safe = safeHref(href)
    if (safe) return link(safe, label || safe)
    const p = asPath(href)
    return p ? pathButton(p, label || p) : whole
  })
  // Bare URLs, which is how a session cites a file it fetched. Trailing punctuation is left
  // outside the link: "see https://x/y." ends a sentence, it does not name a page called "y.".
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>()]+)/g, (whole, before, url) => {
    const trail = url.match(/[.,;:!?]+$/)?.[0] || ''
    const bare = url.slice(0, url.length - trail.length)
    return `${before}${link(bare, bare)}${trail}`
  })
  s = s.replace(/\*\*(?!\s)([\s\S]+?)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|\W)__(?!\s)([^_]+)__(?!\w)/g, '$1<strong>$2</strong>')
  s = s.replace(/(^|[^*\w])\*(?!\s)([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
  // `_` only between word boundaries: `some_long_name` is an identifier, not emphasis.
  s = s.replace(/(^|[\s(])_(?!\s)([^_\n]+)_(?![\w_])/g, '$1<em>$2</em>')
  s = s.replace(/~~(?!\s)([^~]+)~~/g, '<del>$1</del>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => spans[Number(i)])
}

/** Where the text of a list item starts, so its continuation lines can be dedented to it. */
const contentColumn = (line) => line.match(/^(\s*)([-*+]|\d{1,9}[.)])\s+/)?.[0].length ?? 0

/**
 * One list, from `start` until a line that is not part of it.
 *
 * Each item's lines are gathered, dedented and run back through `blocks`, which is what makes
 * a nested list, a paragraph or a code block inside an item work without a second parser for
 * "things that can appear in an item".
 */
const list = (lines, start) => {
  const open = lines[start].match(/^(\s*)([-*+]|\d{1,9}[.)])\s+/)
  const indent = open[1].length
  const ordered = open[2].length > 1
  const items = []
  let i = start

  while (i < lines.length) {
    const m = lines[i].match(/^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/)
    // A different indent or a different kind of marker is a different list, not this one.
    if (!m || m[1].length !== indent || (m[2].length > 1) !== ordered) break
    const pad = contentColumn(lines[i])
    const body = [m[3]]
    i++
    while (i < lines.length) {
      const line = lines[i]
      if (!line.trim()) {
        // A blank line ends the item unless something indented under it follows — that is a
        // loose list, whose items hold more than one block.
        let j = i + 1
        while (j < lines.length && !lines[j].trim()) j++
        if (j >= lines.length || lines[j].search(/\S/) < pad) break
        body.push('')
        i++
        continue
      }
      const at = line.search(/\S/)
      if (at >= pad) {
        body.push(line.slice(pad))
        i++
        continue
      }
      // A wrapped paragraph line under the marker's own column still belongs to the item;
      // anything that opens a block of its own does not.
      if (at > indent && !OPENS_BLOCK.test(line)) {
        body.push(line.trim())
        i++
        continue
      }
      break
    }
    items.push({ body, n: ordered ? Number(m[2].slice(0, -1)) : 0 })
  }

  // An ordered item keeps the number it was written with. The browser counts on from `start`,
  // so "1. … 8. … 10. 11." drew 9 and 10 for the last two, and a handoff that cited item 10
  // pointed at nothing on the page. Only a jump needs saying: the next number, or the same
  // one repeated ("1. 1. 1.", which Markdown counts up), is left to the browser.
  let written = 0
  let shown = 0
  const html = items
    .map(({ body, n }, k) => {
      const inner = blocks(body)
      // A one-paragraph item is drawn without the `<p>`, so a tight list keeps its tight
      // spacing; anything richer keeps its blocks.
      const tight = inner.startsWith('<p>') && inner.indexOf('</p>') === inner.length - 4
      const jump = ordered && k > 0 && n !== shown + 1 && n !== written
      shown = jump || k === 0 ? n : shown + 1
      written = n
      return `<li${jump ? ` value="${n}"` : ''}>${tight ? inner.slice(3, -4) : inner}</li>`
    })
    .join('')
  const tag = ordered ? 'ol' : 'ul'
  const from = ordered ? items[0].n : 1
  return [`<${tag}${ordered && from !== 1 ? ` start="${from}"` : ''}>${html}</${tag}>`, i]
}

/** `|---|:--:|` and friends: the row that makes the line above it a header. */
const isTableRule = (line) => Boolean(line) && line.includes('|') && /^[\s|:-]+$/.test(line) && line.includes('-')

const table = (lines, start) => {
  const cells = (row) =>
    row
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim())
  const align = cells(lines[start + 1]).map((c) => (/^:.*:$/.test(c) ? 'center' : /:$/.test(c) ? 'right' : /^:/.test(c) ? 'left' : ''))
  const cell = (tag) => (text, i) => `<${tag}${align[i] ? ` style="text-align:${align[i]}"` : ''}>${inline(text)}</${tag}>`
  const head = `<tr>${cells(lines[start]).map(cell('th')).join('')}</tr>`

  const body = []
  let i = start + 2
  while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
    body.push(`<tr>${cells(lines[i]).map(cell('td')).join('')}</tr>`)
    i++
  }
  // Wrapped, because a table is the one thing here that can be wider than the panel and it
  // must scroll on its own rather than push the whole log sideways.
  return [`<div class="tablewrap"><table><thead>${head}</thead><tbody>${body.join('')}</tbody></table></div>`, i]
}

/** The block level: one pass down the lines, each branch returning where it stopped. */
const blocks = (lines) => {
  const out = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }

    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/)
    if (fence) {
      const close = new RegExp(`^\\s{0,3}${fence[1][0] === '`' ? '`' : '~'}{${fence[1].length},}\\s*$`)
      const body = []
      i++
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++])
      i++ // the closing fence — or the end of a block still being written, which is the same here
      // Wrapped, so the Copy button sits outside the `<pre>`: inside it, the button would
      // scroll away sideways with a long line. `wireCodeCopy` is what answers the click.
      out.push(
        `<div class="codewrap"><pre class="code"${fence[2] ? ` data-lang="${escape(fence[2])}"` : ''}><code>${escape(body.join('\n'))}</code></pre>` +
          `<button class="copycode" type="button" aria-label="Copy code">Copy</button></div>`
      )
      continue
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/)
    if (heading) {
      const level = heading[1].length
      out.push(`<h${level}>${inline(heading[2].replace(/\s+#+\s*$/, ''))}</h${level}>`)
      i++
      continue
    }

    if (/^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(line)) {
      out.push('<hr />')
      i++
      continue
    }

    if (/^\s{0,3}>/.test(line)) {
      const body = []
      while (i < lines.length && (/^\s{0,3}>/.test(lines[i]) || (lines[i].trim() && body.length && !OPENS_BLOCK.test(lines[i])))) {
        body.push(lines[i++].replace(/^\s{0,3}>\s?/, ''))
      }
      out.push(`<blockquote>${blocks(body)}</blockquote>`)
      continue
    }

    if (line.includes('|') && isTableRule(lines[i + 1])) {
      const [html, next] = table(lines, i)
      out.push(html)
      i = next
      continue
    }

    if (/^\s{0,3}([-*+]|\d{1,9}[.)])\s+/.test(line)) {
      const [html, next] = list(lines, i)
      out.push(html)
      i = next
      continue
    }

    const para = []
    while (i < lines.length && lines[i].trim()) {
      // A block opener ends the paragraph, except on its first line — where it was already
      // ruled out above and is just text that starts with a `-` or a `#`.
      if (para.length && (OPENS_BLOCK.test(lines[i]) || (lines[i].includes('|') && isTableRule(lines[i + 1])))) break
      para.push(lines[i++])
    }
    // Single newlines are kept as breaks. A session's answer is not hard-wrapped prose; when
    // it breaks a line it means it — an address, a list of paths, a signature.
    out.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br />')}</p>`)
  }

  return out.join('')
}

/** Render `src` as HTML. Safe to assign to `innerHTML`: every span of source text is escaped. */
export const renderMarkdown = (src) => blocks(String(src ?? '').replace(/\r\n?/g, '\n').split('\n'))

/**
 * Put a code block's text on the clipboard. `navigator.clipboard` exists only on a secure
 * origin, and a phone reaching Outpost over plain http on the LAN is not one — there the
 * block is selected and copied the old way, or the button would do nothing exactly where
 * selecting a long snippet by hand is hardest.
 */
const copyText = async (code) => {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(code.textContent)
  const range = document.createRange()
  range.selectNodeContents(code)
  const sel = window.getSelection()
  sel.removeAllRanges()
  sel.addRange(range)
  const ok = document.execCommand('copy')
  sel.removeAllRanges()
  if (!ok) throw new Error('copy refused')
}

/**
 * Put a string on the clipboard, for a copy whose text is not on the page (the header's id
 * pill copies more than it shows). The same fallback as `copyText`, through a field made for
 * the moment, because a phone over plain http has no `navigator.clipboard`.
 */
export const copyString = async (text) => {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text)
  const field = document.createElement('textarea')
  field.value = text
  field.setAttribute('readonly', '')
  field.style.position = 'fixed'
  field.style.opacity = '0'
  document.body.appendChild(field)
  field.select()
  const ok = document.execCommand('copy')
  field.remove()
  if (!ok) throw new Error('copy refused')
}

/**
 * Answer every path button under `root`, once, with the path it names — delegated for the same
 * reason as the Copy button, and on the document because a path is drawn wherever Markdown is:
 * the log, an agent's report in Activity, the handoff block, and a file open in Files.
 */
/**
 * Answer every code block's Copy button under `root`, once. Delegated, because the log is
 * rebuilt by `innerHTML` — a message still being written is re-rendered on every chunk — and
 * a listener bound to a button would be gone with it. The button says what happened itself,
 * since the block it belongs to may be a screen away from where a toast would appear.
 */
export const wirePathLinks = (root, onFile) => {
  root.addEventListener('click', (e) => {
    const b = e.target.closest?.('button.path')
    if (!b) return
    e.preventDefault()
    onFile(b.dataset.path)
  })
}

export const wireCodeCopy = (root = document) => {
  root.addEventListener('click', async (e) => {
    const b = e.target.closest?.('button.copycode')
    const code = b?.closest('.codewrap')?.querySelector('pre.code code')
    if (!code) return
    try {
      await copyText(code)
      b.textContent = 'Copied'
    } catch {
      b.textContent = 'Could not copy'
    }
    clearTimeout(b._reset)
    b._reset = setTimeout(() => (b.textContent = 'Copy'), 1500)
  })
}
