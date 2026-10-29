import http from 'node:http'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiMiddleware } from './api.mjs'
import { BIND_HOST, PORT, TOKEN, assertSafeBind, accessUrl, passwordAuthEnabled, setupRequired } from './auth.mjs'
import { startRetrySupervisor } from './state/retry.mjs'
import { startRoutineRunner } from './state/routines.mjs'
import { startAging } from './state/aging.mjs'
import { startJenkinsPoller } from './jenkins-results.mjs'
import { startHandoffs } from './handoff/index.ts'
import { refresh as refreshIndex } from './search/index.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(here, '..', 'dist')

// Before anything is listening. Binding wide with no token is refused rather than warned
// about — see the note at the top of `auth.mjs`.
assertSafeBind()

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
}

/**
 * Sent with every file of the page. The page's own code is all the script it runs, from this
 * origin, so an injected `<script>` or `onerror=` in rendered transcript text does nothing.
 * Styles need `'unsafe-inline'`: xterm writes `<style>` elements and the page renders `style=`
 * attributes, and a style cannot run code. Images are `blob:` because attachments and
 * transcript images are fetched with the bearer header and drawn from a blob (api.md). A PDF in
 * the Files viewer is a blob too, in an `<iframe>`: `frame-src blob:` lets the frame load it, and
 * `object-src blob:` lets the browser's PDF viewer — a plugin to the policy, which a blob document
 * inherits — draw it. A chat's HTML is previewed in a sandboxed frame of a document this server
 * sends under a ticket (`/api/preview/<ticket>`, server/lib/preview.mjs), so `frame-src` has
 * `'self'` too; that document carries its own policy, scripts on and nothing leaving. A `srcdoc`
 * or blob document would inherit this policy instead, and no inline script could run in it.
 * No other origin is framed or embedded. The
 * stream and every call are `fetch` to this origin, so `connect-src` stays at `'self'`. Framing
 * is refused outright: a page that can be framed can be clicked through by someone else's.
 */
const PAGE_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "frame-src blob: 'self'",
    "object-src blob:",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}

/**
 * Resolve inside dist/ only — a request can never climb out with `..`. `undefined` for a path
 * that will not decode (`/%`), which is the caller's 400.
 */
function resolveInDist(pathname) {
  let rel
  try {
    rel = decodeURIComponent(pathname).replace(/^\/+/, '')
  } catch {
    return undefined
  }
  const file = path.resolve(DIST, rel || 'index.html')
  return file === DIST || file.startsWith(DIST + path.sep) ? file : null
}

/** The request's URL, or null when it will not parse (`//`, `//x:y@`). */
function parseUrl(raw) {
  try {
    return new URL(raw, 'http://localhost')
  } catch {
    return null
  }
}

const badRequest = (res) => res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad request')

/**
 * Any request, before any credential is looked at. Every throw is caught here: this handler is
 * async, so a throw is a rejected promise nobody awaits, and with no handler for that Node
 * exits — `GET /%` from anyone on the LAN took the server down.
 */
async function handle(req, res) {
  const url = parseUrl(req.url)
  if (!url) return badRequest(res)

  if (url.pathname.startsWith('/api/') || url.pathname === '/mcp') {
    return apiMiddleware(req, res, null)
  }
  for (const [name, value] of Object.entries(PAGE_HEADERS)) res.setHeader(name, value)

  let file = resolveInDist(url.pathname)
  if (file === undefined) return badRequest(res)
  if (!file) {
    res.writeHead(403).end('Forbidden')
    return
  }
  try {
    if ((await fsp.stat(file)).isDirectory()) file = path.join(file, 'index.html')
  } catch {
    file = path.join(DIST, 'index.html') // SPA fallback
  }

  try {
    const body = await fsp.readFile(file)
    const type = TYPES[path.extname(file)] || 'application/octet-stream'
    const cache = file.includes(`${path.sep}assets${path.sep}`)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache'
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': cache })
    res.end(body)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(`[outpost] ${req.method} ${String(req.url).split('?')[0]} failed:`, err?.stack || err)
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Internal error')
    else res.destroy()
  })
})

// The last line of defence, for a promise somebody forgot to catch anywhere in the server (a
// loop, a timer, a fire-and-forget write). Node's default is to exit, which turns one stray
// rejection into every chat losing its page and its hooks at once; a rejection is one failed
// piece of work, and the rest of the process is still sound, so it is logged and the server
// carries on.
process.on('unhandledRejection', (reason) => {
  console.error('[outpost] unhandled rejection, kept running:', reason?.stack || reason)
})
// A synchronous throw that reached the top is different: it unwound through code that may have
// been halfway through changing state, and Node gives no promise the process is sound after it.
// So it is logged with its stack and the process exits non-zero, which is what lets the unit's
// `Restart=on-failure` bring up a clean one in seconds. Request handling cannot get here — it
// is async and caught above.
process.on('uncaughtException', (err) => {
  console.error('[outpost] uncaught exception, exiting for a clean restart:', err?.stack || err)
  process.exit(1)
})

server.listen(PORT, BIND_HOST, () => {
  // The token goes in the URL exactly once, on the link you open the first time. The page
  // keeps it from then on, so it is worth printing in full rather than making somebody go
  // and look it up.
  console.log(`Outpost → ${accessUrl()}`)
  if (passwordAuthEnabled()) console.log('Password auth is on — the page will ask you to log in.')
  if (setupRequired()) console.log('No password yet. Open that link once to set one; nothing else answers until you do.')
  if (TOKEN) console.log('Token auth is on. Open that link once; the page remembers it.')
  // Only here, never from `api.mjs`: the middleware is imported by tools and tests that have
  // no business restarting anybody's sessions. A running server is what earns the supervisor.
  startRetrySupervisor()
  // Same argument: routines start runs, and only a running server should.
  startRoutineRunner()
  startAging()
  // And the builds Outpost started, asked after until they report (jenkins-results.mjs).
  startJenkinsPoller()
  // And handoffs: a turn's end captures one asked for, and the triggers that ask (handoff.md).
  startHandoffs()
  // The first search should not pay for the first index: build it now, in the background.
  // A failure costs nothing now and is said anyway: an index that never builds is otherwise a
  // search that quietly finds nothing, with no line anywhere to say why.
  setTimeout(() => refreshIndex({ force: true }).catch((err) => console.warn('[outpost] the search index did not build:', err?.message || err)), 5000)
})
