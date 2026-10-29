/**
 * The push channel: one server-sent-events stream per open page, carrying the roster whenever
 * it changes.
 *
 * The page used to poll `/api/threads` every fifteen seconds and the open conversation every
 * two, which is a request a second from a phone whose screen is on — and still fifteen seconds
 * late for a session that just asked a question. The server already knows the moment anything
 * moves: a hook lands in the store, or a transcript's mtime changes on the next scan. So it
 * scans *here*, once for every client rather than once per client, and sends the roster only
 * when its shape has changed.
 *
 * What goes down the wire is exactly the `/api/threads` payload, nothing more. The page
 * handles a `threads` event the same way it handles a fetch, so the two paths cannot drift,
 * and a page that cannot hold a stream open — a proxy that buffers, an old browser — still
 * works on the fetch alone, just later.
 *
 * Not `EventSource`: it cannot carry the `Authorization` header, and the alternative is the
 * session token in a query string, which is the credential-in-a-URL that auth.md exists to
 * keep out of histories and logs. The page reads the stream through `fetch` instead, which
 * is the same bearer header every other request carries.
 */
import { hookEvents } from './state/hooks.mjs'

/** How often the roster is re-scanned while anybody is listening. The scan is cached on mtime, so this is cheap. */
const SCAN_MS = 5000
/** A hook fires several times a second mid-turn; one scan per burst is plenty. */
const HOOK_DEBOUNCE_MS = 300
/** Keeps intermediaries from closing an idle connection, and lets the page notice a dead one. */
const HEARTBEAT_MS = 25000

/** @type {Set<import('node:http').ServerResponse>} */
const clients = new Set()
let roster = null
let loop = null
let heartbeat = null
let hookTimer = null
let lastSignature = ''
let lastPayload = null
let scanning = null
/**
 * Counts everything that may have moved the roster from outside the loop's own clock: a
 * write through the API, a hook. `lastPayloadMoved` is what it read when the scan behind
 * `lastPayload` *started*, so a payload is known to postdate every such change or it is not
 * handed out (`heldRoster`).
 */
let moved = 0
let lastPayloadMoved = -1

/** Handed the roster function once by `api.mjs`, which owns it and everything it needs. */
export function configureEvents({ roster: fn }) {
  roster = fn
}

function write(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  } catch {
    clients.delete(res)
  }
}

function broadcast(event, data) {
  for (const res of clients) write(res, event, data)
}

/**
 * What a roster "changing" means for the page: a thread appearing or going, or any of the
 * fields the list and the open conversation draw from moving. `lastActivityAt` is in it on
 * purpose — it is bumped by a hook event and by the transcript growing, so it is the one
 * signal that says "re-tail this conversation" for a session with hooks and one without.
 */
function signatureOf(payload) {
  return JSON.stringify(
    (payload.threads || []).map((t) => [
      t.id,
      t.title,
      t.running,
      t.unread,
      t.hasError,
      t.stalled,
      t.done,
      t.archived,
      t.lastActivityAt,
      t.activity,
      // The quote on a row that needs you, and the "step N" on a working one. `steps` moves
      // with every tool call, as `activity` already does, so it adds no pushes.
      t.ask?.head,
      t.steps,
      t.model,
      t.effort,
      t.canSend,
      t.retry?.nextAt,
      t.retry?.attempts,
      t.retry?.held,
      t.failure?.kind,
      t.workspace?.id,
      t.workspace?.pinned,
      // A repo chip's unpushed outline (workspaces-git.md): it turns on with no hook, at minute 30.
      t.workspace?.repos?.map((r) => Boolean(r.unpushed)),
      // The header's context pill: the size moves with the transcript, the window when a turn
      // ends in a new unit.
      t.context,
      t.contextWindow,
      // The handoff block: one made, gone stale, asked for, or failed, and one ready set aside
      // from Needs you (handoff.md).
      t.handoff?.at,
      t.handoff?.stale,
      t.handoff?.asking,
      t.handoff?.error,
      t.handoff?.away,
      t.handoff?.dismissed,
      // A routine's run promoted to a chat gains its chip (routines.md).
      t.routine?.runId,
      // A defining chat saved: the page moves to the routine's page (routines.md).
      t.defines?.routineId,
    ]).concat(
      // And its thresholds, when Settings saves them: no thread moves, every open tab repaints.
      [JSON.stringify(payload.contextLimits || null)],
      // And the look (ui.md): a save in one tab repaints every other.
      [JSON.stringify(payload.appearance || null)],
      // The sidebar's routines (routines.md): a run starting or ending, a routine saved or paused.
      [JSON.stringify(payload.routines || null)],
      // The unsaved defining chats, the Routines tab's Draft rows (routines.md).
      [JSON.stringify(payload.drafts || null)],
      // A workspace moving through its preparation, or a checkout's git status changing, is
      // worth a push as much as a thread is: the row and the panel draw from both.
      // Its Jenkins builds too (integrations-ci.md): a build queued, running, or reporting.
      (payload.workspaces || []).map((w) => [w.id, w.status, w.step, w.error, w.kept, w.aged, w.pinned, w.repos.map((r) => [r.branch, r.git?.clean, r.git?.ahead, r.git?.pushed]), (w.builds || []).map((b) => [b.job, b.number, b.result])])
    )
  )
}

/** One scan at a time; a hook landing mid-scan waits for the next rather than starting a second. */
async function scan({ force = false } = {}) {
  if (!roster || !clients.size) return
  if (scanning) return scanning
  scanning = (async () => {
    try {
      const at = moved
      const payload = await roster()
      const signature = signatureOf(payload)
      lastPayload = payload
      lastPayloadMoved = at
      if (force || signature !== lastSignature) {
        lastSignature = signature
        broadcast('threads', payload)
      }
    } catch (err) {
      // A failed scan is this tick's problem, not the stream's: the page keeps what it has
      // and the next tick tries again. Said once per failure rather than swallowed.
      broadcast('error', { error: String(err?.message || err) })
    } finally {
      scanning = null
    }
  })()
  return scanning
}

/** Told by `api.mjs` when a request that may change the roster arrives, and again when it has been answered. */
export function noteChange() {
  moved++
}

/**
 * The roster the loop is already holding, for `GET /api/threads` — or null, and the caller
 * scans for itself.
 *
 * The page fetches the roster for two reasons. One is "I just did something": that request
 * bumped `moved`, the held copy predates it, and the fetch gets a fresh scan as it always
 * did — handing back the loop's copy there would show an archive un-archived. The other is
 * the safety net — every thirty seconds, on focus, on a tab coming back — and that one was
 * a whole second scan to learn what the loop had read at most a tick ago and would have
 * pushed had it differed. Only while the loop is running, only a copy no older than two
 * ticks, and never one a write or a hook has overtaken.
 */
export function heldRoster() {
  if (!loop || !lastPayload || lastPayloadMoved !== moved) return null
  if (Date.now() - lastPayload.scannedAt > SCAN_MS * 2) return null
  return lastPayload
}

function onHook() {
  moved++
  clearTimeout(hookTimer)
  hookTimer = setTimeout(() => scan(), HOOK_DEBOUNCE_MS)
}

function start() {
  if (loop) return
  loop = setInterval(() => scan(), SCAN_MS)
  heartbeat = setInterval(() => broadcast('ping', { at: Date.now() }), HEARTBEAT_MS)
  hookEvents.on('event', onHook)
}

/** The loop runs only while somebody is listening; an idle server scans nothing. */
function stop() {
  if (!loop) return
  clearInterval(loop)
  clearInterval(heartbeat)
  clearTimeout(hookTimer)
  hookEvents.off('event', onHook)
  loop = heartbeat = hookTimer = null
  lastSignature = ''
  lastPayload = null
  lastPayloadMoved = -1
}

/**
 * Open a stream on `res` and keep it until the client goes. The first roster is sent at
 * once, whether or not it changed, so a page that just connected is not left waiting for the
 * next tick to learn what exists.
 */
export function openEventStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    // Vite's dev server and some proxies compress text responses, which buffers the stream
    // until it closes. Saying no here is cheaper than finding out which one did it.
    'Content-Encoding': 'identity',
    'X-Accel-Buffering': 'no',
  })
  res.write(': connected\n\n')
  clients.add(res)
  start()
  req.on('close', () => {
    clients.delete(res)
    if (!clients.size) stop()
  })
  // What the last scan found, straight away; the first listener triggers the scan itself.
  if (lastPayload) write(res, 'threads', lastPayload)
  else scan({ force: true })
}
