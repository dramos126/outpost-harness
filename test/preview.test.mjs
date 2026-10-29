// The Files viewer's HTML preview (server/lib/preview.mjs, ui-details.md): the wrapped document,
// the ticket store's life and caps, and the headers the ungated route answers with.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PREVIEW_CSP, PREVIEW_HEADERS, createPreviewStore, previewDoc, servePreview } from '../server/lib/preview.mjs'

/** A response that records what it was given. */
function fakeRes() {
  const r = { status: 0, headers: {}, body: null }
  r.writeHead = (status, headers = {}) => {
    r.status = status
    r.headers = headers
    return r
  }
  r.end = (body) => {
    r.body = body ?? null
    return r
  }
  return r
}

test('the policy and the listener come first, after a leading doctype alone', () => {
  const guard = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><script>`
  // A `<head>` inside a comment is not where the guard goes.
  assert.ok(previewDoc('<!doctype html><!-- <head> --><html><head></head></html>').startsWith(`<!doctype html>${guard}`))
  assert.ok(previewDoc('<!-- a --> <!DOCTYPE html><p>x').startsWith(`<!-- a --> <!DOCTYPE html>${guard}`))
  assert.ok(previewDoc('<p>bare</p>').startsWith(guard))
  assert.ok(previewDoc('<p>bare</p>').endsWith('<p>bare</p>'))
})

test('the route sends the document under its own policy: sandboxed, nothing leaving, framed only by Outpost', () => {
  const store = createPreviewStore()
  const ticket = store.mint('<p>hi</p>')
  assert.match(ticket, /^[A-Za-z0-9_-]{32}$/)
  const res = fakeRes()
  servePreview({ method: 'GET' }, res, ticket, store)
  assert.equal(res.status, 200)
  assert.equal(res.headers['Content-Type'], 'text/html; charset=utf-8')
  assert.equal(res.headers['Cache-Control'], 'no-store')
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff')
  assert.equal(res.headers['Referrer-Policy'], 'no-referrer')
  assert.equal(
    res.headers['Content-Security-Policy'],
    "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'"
  )
  assert.equal(PREVIEW_HEADERS['Content-Security-Policy'], res.headers['Content-Security-Policy'])
  assert.ok(res.body.toString('utf8').endsWith('<p>hi</p>'))
  // Served again while it lives: a repaint loads the same URL.
  servePreview({ method: 'GET' }, fakeRes(), ticket, store)
  assert.ok(store.take(ticket))
  const post = fakeRes()
  servePreview({ method: 'POST' }, post, ticket, store)
  assert.equal(post.status, 405)
})

test('a ticket lives ten minutes, then is a bare 404 like an unknown one', () => {
  let t = 1_000_000
  const store = createPreviewStore({ now: () => t })
  const ticket = store.mint('<p>x</p>')
  t += 10 * 60 * 1000 - 1
  assert.ok(store.take(ticket))
  t += 1
  const res = fakeRes()
  servePreview({ method: 'GET' }, res, ticket, store)
  assert.equal(res.status, 404)
  assert.equal(res.body, null)
  const unknown = fakeRes()
  servePreview({ method: 'GET' }, unknown, 'B'.repeat(32), store)
  assert.equal(unknown.status, 404)
  assert.equal(store.take('../etc'), null)
})

test('the store keeps at most its count and its bytes, the oldest going first', () => {
  const store = createPreviewStore({ max: 3 })
  const tickets = [1, 2, 3, 4].map((n) => store.mint(`<p>${n}</p>`))
  assert.equal(store.size, 3)
  assert.equal(store.take(tickets[0]), null)
  for (const t of tickets.slice(1)) assert.ok(store.take(t))
  const small = createPreviewStore({ maxBytes: 2000 })
  const a = small.mint('a'.repeat(400))
  const b = small.mint('b'.repeat(400))
  const c = small.mint('c'.repeat(400)) // with the guard each is over 600 bytes: a goes
  assert.equal(small.take(a), null)
  assert.ok(small.take(b) && small.take(c))
})
