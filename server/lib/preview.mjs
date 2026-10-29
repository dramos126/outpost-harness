/**
 * The Files viewer's HTML preview (ui-details.md, api.md): a chat's HTML file served as a
 * document of its own under a short-lived ticket, for a frame sandboxed with `allow-scripts`.
 *
 * Why not `srcdoc` or a blob: a document made either way inherits the page's policy (the HTML
 * spec's policy container), whose `script-src 'self'` refuses every inline script, so the file's
 * scripts could not run without weakening the page. A document fetched from the server has the
 * policy its own response sends, `PREVIEW_HEADERS` — scripts on, nothing leaving, an opaque
 * origin by the `sandbox` directive even when the URL is opened in a tab.
 *
 * The frame's src cannot carry the bearer header, so the ticket is the gate: 192 random bits,
 * minted through the gated `POST /api/file/preview`, good for ten minutes, held in memory only.
 */
import { randomBytes } from 'node:crypto'

/** Nothing leaves the document: no fetch, no form, no image or font from anywhere but itself. */
export const PREVIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'"

/**
 * The served document's headers. `sandbox allow-scripts` makes its origin opaque wherever it is
 * opened; `frame-ancestors 'self'` lets only Outpost's page frame it.
 */
export const PREVIEW_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': `sandbox allow-scripts; ${PREVIEW_CSP}; frame-ancestors 'self'`,
}

/**
 * Tells the viewer what the document refused, for its "Blocked N requests" line. The policy is
 * sent twice — the header, and the same rules as a `<meta>` — so a blocked request breaks both;
 * only the header's report is sent (its `sandbox` is not in the meta's), once per request. `'*'`
 * is the only target an opaque origin can name; the viewer checks the sender is its frame.
 */
export const PREVIEW_LISTENER =
  "document.addEventListener('securitypolicyviolation',function(e){if(String(e.originalPolicy).indexOf('sandbox')<0)return;parent.postMessage({outpostPreview:'blocked',url:String(e.blockedURI),directive:String(e.effectiveDirective)},'*')})"

/**
 * The file with the policy and the listener first, ahead of anything it holds. They go in front
 * of the first tag rather than inside the file's `<head>`: the parser puts a `<meta>` met before
 * `<html>` in the head it makes, and a `<head>` matched by a pattern can sit in a comment. Only a
 * leading doctype (and comments before it) stays ahead, to keep the mode.
 */
export function previewDoc(text) {
  const lead = /^(?:﻿)?\s*(?:<!--[\s\S]*?-->\s*)*<!doctype[^>]*>/i.exec(text)?.[0] || ''
  const guard = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><script>${PREVIEW_LISTENER}</script>`
  return lead + guard + text.slice(lead.length)
}

/** A ticket is 24 random bytes as base64url: 32 characters, 192 bits. */
const TICKET_RE = /^[A-Za-z0-9_-]{32}$/

/**
 * The tickets: each a wrapped document, kept `ttlMs` from minting, at most `max` of them and
 * `maxBytes` in all, the oldest evicted first. One store for the server (`previews`); a test
 * makes its own with a clock it moves.
 */
export function createPreviewStore({ ttlMs = 10 * 60 * 1000, max = 32, maxBytes = 16 * 1024 * 1024, now = Date.now } = {}) {
  const docs = new Map() // ticket → { body, at }, oldest first
  let bytes = 0
  const drop = (ticket) => {
    const d = docs.get(ticket)
    if (!d) return
    bytes -= d.body.length
    docs.delete(ticket)
  }
  const prune = () => {
    const t = now()
    for (const [ticket, d] of docs) if (t - d.at >= ttlMs) drop(ticket)
  }
  return {
    /** Wrap `text` and keep it under a new ticket; answers the ticket. */
    mint(text) {
      prune()
      const body = Buffer.from(previewDoc(String(text)), 'utf8')
      while (docs.size && (docs.size >= max || bytes + body.length > maxBytes)) drop(docs.keys().next().value)
      const ticket = randomBytes(24).toString('base64url')
      docs.set(ticket, { body, at: now() })
      bytes += body.length
      return ticket
    },
    /** The document a live ticket holds, or null: unknown, malformed and expired are alike. */
    take(ticket) {
      if (typeof ticket !== 'string' || !TICKET_RE.test(ticket)) return null
      const d = docs.get(ticket)
      if (!d) return null
      if (now() - d.at >= ttlMs) {
        drop(ticket)
        return null
      }
      return d.body
    },
    get size() {
      return docs.size
    },
  }
}

export const previews = createPreviewStore()

/**
 * `GET /api/preview/<ticket>`: the document under its own headers, or a bare 404 — unknown and
 * expired alike, nothing said. Only the method and the ticket are read from the request.
 */
export function servePreview(req, res, ticket, store = previews) {
  if (req.method !== 'GET') return res.writeHead(405, { Allow: 'GET' }).end()
  const body = store.take(ticket)
  if (!body) return res.writeHead(404, { 'Cache-Control': 'no-store' }).end()
  res.writeHead(200, { ...PREVIEW_HEADERS, 'Content-Length': body.length })
  return res.end(body)
}
