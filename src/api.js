/**
 * The access token, when the server is asking for one.
 *
 * It arrives once, in the `?token=…` link the server prints at startup, and is kept in
 * `localStorage` from then on — deliberately not in a cookie. A cookie would be attached to
 * cross-site requests automatically and put CSRF back on the table; a token a page has to
 * read and attach itself cannot be forged by another origin, because no other origin can
 * read this one's `localStorage`.
 *
 * It is also stripped from the address bar immediately, so the URL you copy out of the tab
 * or leave in your history is not a working credential.
 */
const TOKEN_KEY = 'outpost.token'

function claimToken() {
  try {
    const url = new URL(location.href)
    const fromUrl = url.searchParams.get('token')
    if (!fromUrl) return localStorage.getItem(TOKEN_KEY) || ''
    localStorage.setItem(TOKEN_KEY, fromUrl)
    url.searchParams.delete('token')
    history.replaceState(null, '', url.pathname + url.search + url.hash)
    return fromUrl
  } catch {
    // A private window with storage blocked. The token still works for this page load.
    try {
      return new URL(location.href).searchParams.get('token') || ''
    } catch {
      return ''
    }
  }
}

let token = claimToken()

/**
 * The one-time setup link a fresh server prints. Held in memory only: it is spent the moment
 * a password is set, and it must not outlive this page load in storage.
 */
let setupToken = ''
try {
  const url = new URL(location.href)
  setupToken = url.searchParams.get('setup') || ''
  if (setupToken) {
    url.searchParams.delete('setup')
    history.replaceState(null, '', url.pathname + url.search + url.hash)
  }
} catch {
  /* no URL to read */
}
export const hasSetupToken = () => Boolean(setupToken)

/** Set the first password on a fresh box, and start using the session it mints. */
export async function setupPassword(user, password) {
  const res = await fetch('/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, password, token: setupToken }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `Setup failed (${res.status})`)
  token = body.token
  setupToken = ''
  unauthorizedFired = false
  try {
    localStorage.setItem(TOKEN_KEY, token)
  } catch {
    /* private window: the session lives as long as the tab */
  }
  return body
}

/** Whether this page holds anything to present. Says nothing about whether it is still valid. */
export const hasToken = () => Boolean(token)

/**
 * Called on a 401, once per lapse. The page decides what to do — show the login screen — and
 * this module only promises not to fire it again until a new token has been claimed, so a
 * burst of polls hitting an expired session produces one prompt rather than ten.
 */
let onUnauthorized = null
let unauthorizedFired = false
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn
}

function headers(extra) {
  const h = { ...extra }
  if (token) h.Authorization = `Bearer ${token}`
  return h
}

async function req(url, options = {}) {
  const res = await fetch(url, { ...options, headers: headers(options.headers) })
  const body = await res.json().catch(() => ({}))
  if (res.status === 401) {
    if (body.needsLogin && onUnauthorized && !unauthorizedFired) {
      unauthorizedFired = true
      onUnauthorized()
    }
    throw new Error(body.error || 'This dashboard needs a token — open it with ?token=…')
  }
  // A refusal with a reason is an answer, not a failure: the page shows it and offers the
  // next step (delete anyway, push first). Everything else is thrown as before.
  if (res.status === 409) return { ...body, ok: false, refused: true }
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`)
  return body
}

/**
 * Is there a password on this server, and whose? Unauthenticated by design — the page has to
 * know whether to draw a login form before it holds anything to authenticate with.
 */
export async function fetchAuth() {
  const res = await fetch('/api/auth')
  if (!res.ok) return { passwordAuth: false, user: '' }
  return res.json().catch(() => ({ passwordAuth: false, user: '' }))
}

/**
 * Trade a username and password for a session token, and start using it.
 *
 * The token goes into the same `localStorage` slot the static one used, and rides in the same
 * header — a session is just a token that expires and can be revoked alone.
 */
export async function login(user, password) {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, password }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `Login failed (${res.status})`)
  token = body.token
  unauthorizedFired = false
  try {
    localStorage.setItem(TOKEN_KEY, token)
  } catch {
    /* private window: the session lives as long as the tab */
  }
  return body
}

/**
 * Change the password: the current one and the new one. Every other device is logged out; this
 * one carries on with the fresh session the answer hands back, kept as login keeps its own.
 */
export async function changePassword(current, password) {
  const body = await req('/api/account/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current, password }) })
  token = body.token
  unauthorizedFired = false
  try {
    localStorage.setItem(TOKEN_KEY, token)
  } catch {
    /* private window: the session lives as long as the tab */
  }
  return body
}

/** Revoke this device's session and forget it locally. Other devices stay logged in. */
export async function logout() {
  try {
    await fetch('/api/logout', { method: 'POST', headers: headers() })
  } catch {
    /* the server may be gone; forgetting the token locally is still the right outcome */
  }
  token = ''
  try {
    localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* nothing to remove */
  }
}

const post = (url, payload) =>
  req(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

export const fetchThreads = () => req('/api/threads')

/** Two of the server's pings (`HEARTBEAT_MS`, 25 s) and some: no frame this long is a dead stream. */
const STREAM_SILENT_MS = 60000

/**
 * The push channel: `/api/events`, read as a stream for as long as the page is open.
 *
 * `fetch` rather than `EventSource`, because `EventSource` cannot carry the bearer header and
 * the only alternative is the token in the URL — the credential-in-a-link that auth.md exists
 * to keep out of histories and logs. The stream speaks the server-sent-events wire format,
 * parsed here by hand: it is two line prefixes and a blank line.
 *
 * `onEvent(name, data)` gets every event; `onStatus('up' | 'down')` says whether the stream
 * is connected, so the page can fall back to fetching when it is not. Reconnects on its own,
 * with a backoff that starts at a second and stops growing at half a minute. Returns a
 * function that closes it for good.
 */
export function subscribeEvents(onEvent, onStatus = () => {}) {
  let stopped = false
  let controller = null
  let watch = null
  let delay = 1000
  const run = async () => {
    while (!stopped) {
      controller = new AbortController()
      try {
        const res = await fetch('/api/events', { headers: headers({ Accept: 'text/event-stream' }), signal: controller.signal })
        if (res.status === 401) {
          const body = await res.json().catch(() => ({}))
          if (body.needsLogin && onUnauthorized && !unauthorizedFired) {
            unauthorizedFired = true
            onUnauthorized()
          }
          throw new Error('unauthorized')
        }
        if (!res.ok || !res.body) throw new Error(`${res.status}`)
        onStatus('up')
        delay = 1000
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        // A connection a sleeping phone or a network change left half open never ends: the
        // read just waits, the page says nothing is wrong, and no update arrives until a
        // refresh. The server pings every 25 s, so silence past two pings is a dead stream.
        let heard = Date.now()
        watch = setInterval(() => {
          if (Date.now() - heard > STREAM_SILENT_MS) controller.abort()
        }, 5000)
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          heard = Date.now()
          buffer += decoder.decode(value, { stream: true })
          let cut
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const chunk = buffer.slice(0, cut)
            buffer = buffer.slice(cut + 2)
            let name = 'message'
            const data = []
            for (const line of chunk.split('\n')) {
              if (line.startsWith('event:')) name = line.slice(6).trim()
              else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
            }
            if (!data.length) continue
            try {
              onEvent(name, JSON.parse(data.join('\n')))
            } catch {
              /* a malformed frame is dropped; the next roster replaces whatever it carried */
            }
          }
        }
      } catch {
        /* dropped, refused, or aborted — all end the same way: wait and try again */
      } finally {
        clearInterval(watch)
      }
      onStatus('down')
      if (stopped) break
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(delay * 2, 30000)
    }
  }
  run()
  return () => {
    stopped = true
    controller?.abort()
  }
}
export const archiveThread = (thread, archived) =>
  post('/api/archive', { id: thread.id, harness: thread.harness, ref: thread.ref, archived })

/** Archive several at once, the list's bulk archive: `{ ok, results: [{ id, ended, harnessError? }] }`. */
export const archiveThreads = (threads) =>
  post('/api/archive', { chats: threads.map((t) => ({ id: t.id, harness: t.harness, ref: t.ref })) })

/** Restore an archived chat: off the archive list, and its session resumed where it left off. */
export const unarchiveThread = (thread) => post('/api/unarchive', { id: thread.id })

/**
 * Type a prompt into a running session.
 *
 * Only some launchers can do this — check `canSend` from `fetchLauncher` before offering it,
 * so the button is absent rather than present and broken.
 */
export const sendPrompt = (thread, text, files = [], command = '') =>
  post('/api/send', { harness: thread.harness, ref: thread.ref, text, files, ...(command ? { command } : {}) })

/** Past the slowest first load of a large transcript on a phone, well short of "refresh it". */
const TRANSCRIPT_TIMEOUT_MS = 30000

/**
 * The conversation behind a thread, from byte `after` onwards. Pass back the `offset` you
 * were given to get only what is new — that is what makes tailing a growing transcript
 * cheap enough to do every couple of seconds. `before`, a `start` you were given, reads the
 * page above it instead; `bytes` sizes a first load or a page.
 */
export const fetchTranscript = (thread, after = 0, { before = 0, bytes = 0 } = {}) =>
  req('/api/transcript', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ harness: thread.harness, ref: thread.ref, after, ...(before ? { before } : {}), ...(bytes ? { bytes } : {}) }),
    // The panel reads one at a time per thread (ui-conversation.md), so a read that never
    // settles — a socket a sleeping phone left half open — froze that chat's log until a
    // refresh. Given up on, the next tick reads again on a fresh connection.
    signal: AbortSignal.timeout(TRANSCRIPT_TIMEOUT_MS),
  }).catch((err) => {
    throw err?.name === 'TimeoutError' ? new Error('Reading the conversation timed out; trying again') : err
  })

/**
 * One image out of a thread's conversation, as a blob. `id` is the image item's id from the
 * transcript.
 *
 * Fetched rather than linked, for the reason the stream is: an `<img src>` cannot carry the
 * bearer header, and the alternative is the token in a URL. The caller makes an object URL
 * of the blob and owns revoking it.
 */
export async function fetchImage(thread, id) {
  const res = await fetch('/api/image', {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ harness: thread.harness, ref: thread.ref, id }),
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.blob()
}

/** The subagents a thread has dispatched, each with what it was asked, its model, timing and context. */
export const fetchAgents = (thread) => post('/api/agents', { harness: thread.harness, ref: thread.ref })

/** The commands a thread sent to the background: each one's command, timing, output file and how it ended. */
export const fetchCommands = (thread) => post('/api/commands', { harness: thread.harness, ref: thread.ref })

/** The end of one background command's output. */
export const fetchTaskOutput = (thread, taskId, file) => post('/api/task/output', { harness: thread.harness, ref: thread.ref, taskId, file })

/** The files a thread wrote or pointed you at, each with its versions and whether it is on disk now. */
export const fetchFiles = (thread) => post('/api/files', { harness: thread.harness, ref: thread.ref })

/** One file as it is on disk, or — with `version`, a Write's tool-use id — as the session wrote it then. */
export const fetchFile = (thread, path, version = '', root = 'workspace') => post('/api/file', { harness: thread.harness, ref: thread.ref, path, version, root })

/**
 * An HTML file's preview: the server keeps it under a ticket and answers `{ ok, url, size,
 * truncated }`, the url a frame loads without the header (ui-details.md). One per open.
 */
export const fetchPreview = (thread, path, version = '', root = 'workspace') => post('/api/file/preview', { harness: thread.harness, ref: thread.ref, path, version, root })

/**
 * One file's bytes, for what the viewer draws from a blob (an image, a PDF) and the Download
 * link (`download` raises the server's cap). Fetched for the reason `fetchImage` is: an `<img>`
 * or `<iframe>` src cannot carry the bearer header. Answers `{ ok, blob, modifiedAt }`, or `{ ok:
 * false, missing | tooBig, size, error }` for a 404 or a 413 rather than throwing; the caller
 * makes the object URL and owns revoking it.
 */
export async function fetchFileBytes(thread, path, root = 'workspace', download = false) {
  const res = await fetch('/api/file/bytes', {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ harness: thread.harness, ref: thread.ref, path, root, download }),
  })
  if (res.ok) return { ok: true, blob: await res.blob(), modifiedAt: Date.parse(res.headers.get('Last-Modified') || '') || 0 }
  const body = await res.json().catch(() => ({}))
  if (res.status === 404 || res.status === 413) return { ...body, ok: false, missing: res.status === 404 && Boolean(body.missing), tooBig: res.status === 413 }
  throw new Error(body.error || `${res.status} ${res.statusText}`)
}

/** One folder for the Browse tree: `root` `workspace` (`path` '' is the workspace folder) or `tmp`, the container's /tmp. */
export const fetchDir = (thread, root, path) => post('/api/dir', { harness: thread.harness, ref: thread.ref, root, path })

/** The workspace's files whose path holds `q`, relative to the answer's `dir`. */
export const findFiles = (thread, q) => post('/api/find', { harness: thread.harness, ref: thread.ref, q })

/** What a thread has spent in tokens and what of it the harness caused (usage.md). */
export const fetchTokens = (thread) =>
  post('/api/tokens', {
    harness: thread.harness,
    ref: thread.ref,
    // The chat's earlier conversations, as the roster carried them (handoff.md): summed into `lifetime`.
    ...(thread.earlier?.length ? { earlier: thread.earlier.map((e) => ({ harness: e.harness, ref: e.ref })) } : {}),
  })

/** A subagent's own conversation, tailed the same way as the thread's. */
export const fetchAgentTranscript = (thread, agentId, after = 0) =>
  post('/api/transcript', { harness: thread.harness, ref: { ...thread.ref, agentId }, after })

/**
 * Save an attached file on the server so a prompt can point at it. Resolves to the absolute path the
 * session will be told to read.
 */
export async function uploadFile(thread, file) {
  const data = await new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] || '')
    r.onerror = () => reject(new Error('Could not read that file'))
    r.readAsDataURL(file)
  })
  const res = await post('/api/upload', { folder: thread.id, name: file.name, type: file.type, data })
  return res.path
}

/** What a session is asking right now — the request's own words and options — or `asking: false`. */
export const fetchPrompt = (thread) => post('/api/prompt', { harness: thread.harness, ref: thread.ref })

/** Allow / always / deny whatever a session is asking. Refused if it is not asking. */
export const respondPrompt = (thread, answer, id = '') => post('/api/respond', { harness: thread.harness, ref: thread.ref, answer, id })

/**
 * Pick a numbered option off a question the session asked. `expect` is the label this page
 * drew on the button; the server refuses if that row no longer reads that way, because the
 * next question's option 2 is not this one's.
 */
export const pickOption = (thread, option, expect, id = '') =>
  post('/api/respond', { harness: thread.harness, ref: thread.ref, option, expect, id })

/** Stop the current turn; with `all`, its subagents and background commands too. */
export const interruptThread = (thread, { all = false } = {}) => post('/api/interrupt', { harness: thread.harness, ref: thread.ref, all })
/** Stop one command the thread's session left running in the background (`backgroundTasks`). */
export const stopBackgroundTask = (thread, taskId) => post('/api/task/stop', { harness: thread.harness, ref: thread.ref, taskId })

/**
 * "I have read this one": a finished thread's ✓ back to plain idle. Nothing is sent to the
 * session — only Outpost's record of it moves.
 */
export const ackThread = (thread) => post('/api/ack', { harness: thread.harness, ref: thread.ref })

/** Name a chat; `''` clears the name and hands it back to automatic naming. Outpost's record only. */
export const renameThread = (thread, name) => post('/api/title', { id: thread.id, name })

/**
 * Which models a chat can be put on: the CLI's aliases, as `{ label, description }`.
 *
 * A fixed list on the server, read off no session. Nothing here says which one a thread is
 * *on*: that is `thread.model`, from the transcript.
 */
export const fetchModels = () => req('/api/models')

/**
 * Move a session onto another model, for that session alone — never the machine's default.
 * `model` is a `label` that came back from `fetchModels`; the server takes its first word as
 * the alias.
 */
export const setThreadModel = (thread, model) => post('/api/model', { harness: thread.harness, ref: thread.ref, model })

/**
 * The effort levels this session offers: `low` … `ultracode`. Sent with the thread's model
 * because the list depends on it: Opus offers `ultracode`, Haiku does not, and one list for
 * both would offer a level that refuses on click.
 */
export const fetchEfforts = (thread) =>
  post('/api/efforts', { harness: thread.harness, ref: thread.ref, model: thread.model || '' })

/** Move a session onto another effort level, for that session alone — never the machine's default. */
export const setThreadEffort = (thread, effort) => post('/api/effort', { harness: thread.harness, ref: thread.ref, effort })

/** A session whose unit is gone, started again where it left off. */
export const resumeThread = (thread) => post('/api/resume',{ harness: thread.harness, ref: thread.ref })

/** The catalogue: the repos Outpost can check out, and the recipe for each. */
export const fetchCatalogue = () => req('/api/catalogue')

export const saveCatalogueRepo = (repo) =>
  req('/api/catalogue', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(repo) })

export const deleteCatalogueRepo = (id) =>
  req('/api/catalogue', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })

/** Can the server reach that clone URL with that secret, and what is its default branch? */
export const testRemote = (url, auth = '') => post('/api/catalogue/test', { url, auth })

/**
 * A new chat with its own workspace: checkouts of the chosen repos on fresh branches, the
 * policy written, the session started in the first one. Answers at once with the manifest;
 * the preparation shows up in the roster's `workspaces` as it goes.
 */
export const createWorkspace = (spec) => post('/api/workspaces', spec)

export const fetchWorkspaceLog = (id) => req(`/api/workspaces/${id}/log`)

/** Which of a chat's published ports have something listening right now: `{ ports: [{host, listening}] }`. */
export const fetchWorkspacePorts = (id) => req(`/api/workspaces/${id}/ports`)

/** Each repo's setup in a chat, `{ repos: [{ id, name, state, error, log }] }`; and Try again on one, or every failed one. */
export const fetchSetup = (id) => req(`/api/workspaces/${id}/setup`)
export const retrySetup = (id, repo = '') => post(`/api/workspaces/${id}/setup`, { repo })

export const pushWorkspaceRepo = (id, repo) => post(`/api/workspaces/${id}/push`, { repo })

/** Land a checkout's work: merge the base in, push the branch, then fast-forward the base (`push`) or open a PR (`pr`). */
export const finishWorkspaceRepo = (id, repo, mode) => post(`/api/workspaces/${id}/finish`, { repo, mode })

/** Run a failed preparation again with the repo's settings as they are now. */
export const retryWorkspace = (id) => post(`/api/workspaces/${id}/retry`, {})

/** Pin or unpin a chat: a pinned one is never archived or deleted by aging. */
export const pinWorkspace = (id, pinned) => post(`/api/workspaces/${id}/pin`, { pinned })

/** What each checkout holds that its remote does not: unpushed commits and uncommitted files. */
export const fetchHeldWork = (id) => req(`/api/workspaces/${id}/held`)

/** Delete a workspace. Refused with a reason while a checkout has unpushed work, unless `force`. */
export const deleteWorkspace = (id, force = false) =>
  req(`/api/workspaces/${id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force }) })

/** The secret store's public view: names, kinds, hints, public keys. Never a value. */
export const fetchSecrets = () => req('/api/secrets')

/** `action` is `generate` (an ssh key made on the server), `key` (a pasted one) or `token`. */
export const addSecret = (action, name, value = '') => post('/api/secrets', { action, name, value })

export const removeSecret = (name) =>
  req('/api/secrets', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })

export const fetchEnvironments = () => req('/api/environments')

export const saveEnvironment = (env) =>
  req('/api/environments', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(env) })

export const deleteEnvironment = (name) =>
  req('/api/environments', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })

/** Connect to an environment with its key and say what is there. */
export const testEnvironment = (name) => post('/api/environments/test', { name })

export const forgetHostKey = (host) => post('/api/environments/forget', { host })

/** The portable half of this instance's setup: catalogue and settings, never secrets. */
export const exportSetup = () => req('/api/setup/export')

export const importSetup = (payload) => post('/api/setup/import', payload)

/**
 * Routines: work that runs itself (routines.md). The whole of each — triggers, gate, steps —
 * with its last run, its next times, its trigger in words and its saved `layout` (or null); the
 * roster carries only the list's fields, so a routine's page reads this.
 */
export const fetchRoutines = () => req('/api/routines')

/** Create (no id) or replace a routine; answers `{ ok, routine, routines }`. */
export const saveRoutine = (routine) =>
  req('/api/routines', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(routine) })

/** Delete a routine and its defining chat: `{ ok, chats: [{ workspaceId, deleted, error? }], routines }`. */
export const deleteRoutine = (id) =>
  req('/api/routines', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })

/**
 * A chat to define a routine in (routines.md *Defining chats*): a new one for New routine, or
 * with `routineId` for Change… — the chat that defines it, or a new one linked to it. Answers
 * `{ ok, workspaceId, created }`; 404 for a routine that is gone.
 */
export const startDefining = (routineId = '') => post('/api/routines/draft', routineId ? { routineId } : {})

/** Start a run now, by hand, logged as by the page; `skipGate` runs the steps on a quiet day too. */
export const runRoutineNow = (id, skipGate = false) => post(`/api/routines/${encodeURIComponent(id)}/run`, { skipGate })

/**
 * Make (or replace) the token of a routine's call trigger `name`: `{ ok, token, path, routines }`,
 * the only answer that ever carries the token (routines-triggers.md).
 */
export const makeCallToken = (id, name) =>
  post(`/api/routines/${encodeURIComponent(id)}/triggers/${encodeURIComponent(name)}/token`, {})

/**
 * Save where a routine's boxes sit on its page, `{ [boxId]: { x, y } }`, or null to put the
 * automatic layout back (routines.md *Layouts*): `{ ok, layout }`. Not a save of the routine.
 */
export const saveRoutineLayout = (id, layout) =>
  req(`/api/routines/${encodeURIComponent(id)}/layout`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ layout }) })

/** A routine's runs, newest first. */
export const fetchRoutineRuns = (id) => req(`/api/routines/${encodeURIComponent(id)}/runs`)

/** One run's execution log: `{ events }`, the inputs of what it did, never the results. */
export const fetchRoutineRunLog = (id, runId) => req(`/api/routines/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/log`)

/** The runner's decision log: what came due, and what it decided. */
export const fetchRoutineLog = () => req('/api/routines/log')

/** Aging: the settings, what the workspaces and mirrors take on disk, and what is free. */
/** `measure: false` answers the settings at once, without the seconds-long `du` (aging.md). */
export const fetchAging = ({ measure = true } = {}) => req(measure ? '/api/aging' : '/api/aging?measure=0')

export const saveAging = (settings) =>
  req('/api/aging', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) })

/** Run the aging pass now, by hand. */
export const runAgingNow = () => post('/api/aging/run', {})

/** When the conversation header calls a context large: `{ warnTokens, warnShare, alertTokens, alertShare }`. */
export const fetchContextLimits = () => req('/api/context-limits')

export const saveContextLimits = (limits) =>
  req('/api/context-limits', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(limits) })

/** The page's look, `{ preset, accent, font, mono }` (ui.md); read back off the roster, never fetched. */
export const saveAppearance = (appearance) =>
  req('/api/appearance', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(appearance) })

/** Ports scanned from a repo's mirror to pre-fill the Ports editor: `{ ports, scanned }`. */
export const detectRepoPorts = (id) => req(`/api/catalogue/${encodeURIComponent(id)}/detect-ports`)

/** The container fence: `{ mounts, network, bash, portFrom, portTo }` (launchers.md). */
export const fetchContainers = () => req('/api/containers')

export const saveContainers = (containers) =>
  req('/api/containers', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(containers) })

/** Search everything Outpost knows: chats, memory, docs. `kinds` narrows; empty is all. */
export const searchAll = (q, kinds = []) => req(`/api/search?q=${encodeURIComponent(q)}${kinds.length ? `&kinds=${kinds.join(',')}` : ''}`)

export const fetchIntegrations = () => req('/api/integrations')

export const saveIntegrations = (integrations) =>
  req('/api/integrations', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(integrations) })

/** A repo's datasets (its `.outpost/data.json`), where each comes from here, and each read copy's last sync. */
export const fetchDatasets = (id) => req(`/api/catalogue/datasets?id=${encodeURIComponent(id)}`)

/** Sync one read dataset's local copy from its source now. */
export const syncDataset = (id, dataset) => post('/api/catalogue/datasets/sync', { id, dataset })

/** Every Jenkins job, each marked `builds` when its builds check `url` out: `{ ok, jobs, error? }`. */
export const fetchJenkinsJobs = (url) => req(`/api/jenkins/jobs?url=${encodeURIComponent(url || '')}`)

/** Make Jenkins's notify token. The answer carries it this once, `{ token, integrations }`; nothing reads it again. */
export const generateNotifyToken = () => post('/api/integrations/notify-token', {})

/** `which` is `claude`, `github` or `jenkins`: a real call with the configured secret. */
export const testIntegration = (which) => post('/api/integrations/test', { which })

/** Claude's sign-in: `{ token }` (its kind read off its prefix) or `{ clear: true }`. Answers `{ integrations }`. */
export const saveClaudeAuth = (body) =>
  req('/api/integrations/claude', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

// ── the host shell (server/shell/index.mjs) ─────────────────────────────────────────

/** `{ shells, account, host }`: the terminals open, and the account "Log in as" is filled in with. */
export const fetchShells = () => req('/api/shells')
export const openShell = (account, rows, cols) => post('/api/shells', { account, rows, cols })
/**
 * A shell into the thread's container (auth.md). A stopped container comes back as `{ ok: false,
 * refused, stopped, error }`, not thrown; a chat on the host is thrown.
 */
export const openChatShell = (thread, rows, cols) => post('/api/shells', { chat: { harness: thread.harness, ref: thread.ref }, rows, cols })
export const shellInput = (id, data) => post(`/api/shells/${id}/in`, { data })
export const shellResize = (id, rows, cols) => post(`/api/shells/${id}/resize`, { rows, cols })
export const closeShell = (id, keepalive = false) => req(`/api/shells/${id}`, { method: 'DELETE', keepalive })

/**
 * Read a terminal's output from byte `from` until it ends or `signal` aborts: `onData(bytes,
 * at)` per chunk with the offset after it, `onExit(code)` once. `fetch` rather than
 * `EventSource` for the bearer header, as the push channel does. Resolves when the stream
 * closes, so the caller can reconnect from the last offset.
 */
export async function streamShell(id, from, { onData, onExit, signal }) {
  const res = await fetch(`/api/shells/${id}/out?from=${from}`, { headers: headers({ Accept: 'text/event-stream' }), signal })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `The terminal answered ${res.status}`)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let raw = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    raw += dec.decode(value, { stream: true })
    let i
    while ((i = raw.indexOf('\n\n')) >= 0) {
      const block = raw.slice(0, i)
      raw = raw.slice(i + 2)
      if (/^event: exit$/m.test(block)) {
        onExit(/^data: (.*)$/m.exec(block)?.[1] ?? '')
        return
      }
      const data = /^data: (.*)$/m.exec(block)
      const at = /^id: (\d+)$/m.exec(block)
      if (data && at) onData(Uint8Array.from(atob(data[1]), (c) => c.charCodeAt(0)), Number(at[1]))
    }
  }
}

/** Sign in with Claude: start answers `{ ok, url }`; the code Claude shows finishes it, `{ ok, integrations }`. */
export const startClaudeSignIn = () => post('/api/integrations/claude/signin', {})
export const finishClaudeSignIn = (code) => post('/api/integrations/claude/signin/code', { code })

/** What this machine has for chats and lacks: `{ claude, signIn, hooks, missing }` (machine.mjs). */
export const fetchMachine = () => req('/api/machine')

/** `/addRepo`: a catalogue repo, by id or name, or a git URL, into a running chat's workspace. */
export const addRepoToChat = (workspaceId, repo, said = '') => post(`/api/workspaces/${encodeURIComponent(workspaceId)}/repos`, { repo, said })

/** `/registerRepo`: what a catalogue entry for a git URL would hold, read off the repo, not saved. */
export const scanRepo = (url) => post('/api/catalogue/scan', { url })

/** `/rescanRepo`: what reading a catalogued repo again would change in its entry, not saved. */
export const rescanRepo = (repo) => post('/api/catalogue/rescan', { repo })

/** The rescan card's Update: `{ id, setup?, ports?, envAdd?, jobsAdd? }`, the ticked changes. */
export const applyRescan = (changes) => post('/api/catalogue/rescan/apply', changes)

/** The `/registerRepo` card's Register: that entry saved to the catalogue, then added to the chat. */
export const registerRepoToChat = (workspaceId, repo, said = '') => post(`/api/workspaces/${encodeURIComponent(workspaceId)}/register`, { repo, said })

/** What "push" means for a chat's work unless its repo says otherwise: `{ push: { mode, custom? } }`. */
export const fetchPushDefault = () => req('/api/push-default')

/** `sentence` goes with `custom`, and is refused unless its Test passed as written. */
export const savePushDefault = (mode, sentence = '') =>
  req('/api/push-default', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, sentence }) })

/**
 * Test a custom push sentence: read into steps, each checked with real calls, nothing done.
 * `repo` is the repo's form as it stands, or null for the default. `{ ok, steps: [{ text, ok,
 * why }] }`, or `{ ok: false, error }`.
 */
export const testCustomPush = (sentence, repo = null) => post('/api/push-custom/test', { sentence, repo })

/** Who commits in a workspace: the setting, and what it resolves to right now. */
export const fetchGitIdentity = () => req('/api/git-identity')

export const saveGitIdentity = (identity) =>
  req('/api/git-identity', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(identity) })

/** Which harnesses this server knows about and which it found on this machine. */
export const fetchHarnesses = () => req('/api/harnesses')

/** Which launcher this server has, and therefore what the UI may offer. */
export const fetchLauncher = () => req('/api/launcher')

/**
 * How much of the Claude plan's limits are spent — the same numbers `/usage` prints in a
 * session. Server-side and cached there, because the credential it takes is the CLI's own
 * OAuth token and that must never reach a browser.
 */
export const fetchUsage = () => req('/api/usage')

/** The machine's CPU, memory and workspace-disk use: `{ cpu, memory, disk }`, each with a `percent`. */
export const fetchSystem = () => req('/api/system')
export const fetchSystemDetail = () => req('/api/system/detail')

/**
 * Send a stalled session on again, now — the button behind the countdown, and the only way
 * past a spent retry budget. It can still be refused: the server checks the session first, and
 * one that has quietly gone back to work is not one to send a restart into.
 */
export const restartThread = (thread) => post('/api/restart', { harness: thread.harness, ref: thread.ref })

/**
 * Hand off: ask the session to commit its work and write the handoff a fresh conversation
 * starts from (handoff.md), or with `without` have it summarised from the transcript instead. A
 * refusal — busy, already asked — comes back as `{ ok: false, error }`.
 */
export const askHandoff = (thread, { without = false } = {}) => post('/api/handoff', { harness: thread.harness, ref: thread.ref, ...(without ? { without: true } : {}) })

/** Set a ready handoff aside: still in its block, no longer under Needs you. */
export const dismissHandoff = (thread) => post('/api/handoff/dismiss', { harness: thread.harness, ref: thread.ref })

/** Cancel the handoff being written: the summary stopped, or the session's turn interrupted. */
export const cancelHandoff = (thread) => post('/api/handoff/cancel', { harness: thread.harness, ref: thread.ref })

/**
 * `/away`: the chat's handoff asked for now, or when its turn ends, if it is worth one; `null`
 * for every chat with a running session. Answers `{ results: [{ id, title, outcome, why }] }`.
 */
export const goAway = (thread) => post('/api/away', thread ? { harness: thread.harness, ref: thread.ref } : { all: true })

/** Take the away marks down again — one chat's, or every chat's with no thread. Answers `{ cleared }`. */
export const comeBack = (thread) => post('/api/away', thread ? { harness: thread.harness, ref: thread.ref, back: true } : { all: true, back: true })

/**
 * Start a fresh conversation in the chat from its kept handoff. A stale or fallback one comes
 * back `{ refused, confirm, error }` until `confirmed` is sent.
 */
export const startFresh = (thread, confirmed = false) => post('/api/handoff/fresh', { harness: thread.harness, ref: thread.ref, confirmed })

/** The chat's kept handoff, text and all: `{ handoff }`, null when there is none to offer. */
export const fetchHandoff = (thread) => post('/api/handoff/text', { harness: thread.harness, ref: thread.ref })

/**
 * Where a stall goes when nobody is looking at the page.
 *
 * `fetchNotify` never returns the webhook URL — only whether one is set, and its last six
 * characters so two can be told apart. That is deliberate: this page is reachable from every
 * device on the LAN, and the URL is a credential that lets its holder post as you. It goes in
 * and never comes back out.
 */
export const fetchNotify = () => req('/api/notify')

export const saveNotify = (settings) =>
  req('/api/notify', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  })

/** Post a real message, so "saved" can be checked rather than believed. */
export const testNotify = () => post('/api/notify/test', {})
