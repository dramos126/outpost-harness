/**
 * A username and password, and the sessions they mint.
 *
 * This exists because a `?token=…` link is a credential shaped like a URL, and URLs go
 * places credentials should not: browser history, the bookmark bar, cross-device sync, a
 * screenshot. On a home LAN where other people — and other people's children — have devices,
 * the realistic way in is not someone attacking the token but someone finding a machine that
 * already has it. So:
 *
 *   - The password is never stored, only an scrypt hash of it, salted per install.
 *   - Logging in mints a **session token**, which is what the page actually holds. It expires,
 *     and it can be revoked on its own without kicking every other device off.
 *   - Session tokens are stored hashed too. Someone who reads the auth file off a backup gets
 *     a list of dead hashes, not a set of working credentials.
 *
 * What this deliberately does NOT do is introduce a cookie. The whole CSRF argument in
 * `auth.mjs` rests on the credential living in `localStorage` and being attached by hand;
 * a session cookie would be sent automatically on cross-site requests and undo it. A session
 * token is transported exactly like the static token was — as a `Bearer` header.
 *
 * The static `OUTPOST_TOKEN` survives alongside this, because a password is useless to a
 * script: curl, a health check and a future systemd unit all still need a way in.
 */
import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto'
import net from 'node:net'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const AUTH_FILE = process.env.OUTPOST_AUTH || path.join(os.homedir(), '.outpost-auth.json')

/** How long a login lasts. Long enough not to nag, short enough that a stale device lapses. */
const SESSION_DAYS = Number(process.env.OUTPOST_SESSION_DAYS) || 30
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000

/** scrypt cost. N=16384 is ~100ms here — slow enough to matter offline, fast enough to log in. */
const SCRYPT = { N: 16384, r: 8, p: 1 }
const KEYLEN = 64

/**
 * The whole file, in memory.
 *
 * Kept in memory so that checking a token on every API request is a map lookup rather than a
 * file read. It was loaded once at boot on the premise that exactly one process writes it,
 * and that premise is false: `yarn passwd` is a second process, and a server holding a stale
 * copy answered logins with the old password and then wrote its copy back over the new one on
 * the next login. A password change appeared to do nothing and was then destroyed.
 *
 * So the file's mtime is the authority. A read reloads if it changed, at most once a second
 * because it is on the hot path; a write reloads first, unthrottled, so it merges onto
 * whatever is on disk rather than overwriting it. A race is still possible in the moment
 * between that reload and the rename — two processes writing one file cannot be made
 * airtight this way — but it now takes simultaneity rather than merely happening at all.
 */
let store = null
let loadedMtimeMs = 0
let lastStatAt = 0
/** Why the file on disk could not be read, or `''`. While set, auth is required whatever the store holds. */
let unreadable = ''
const STAT_EVERY_MS = 1000

/** The file's mtime, or 0 if it is not there. */
function mtimeOf() {
  try {
    return fs.statSync(AUTH_FILE).mtimeMs
  } catch {
    return 0
  }
}

const empty = () => ({ version: 1, user: '', salt: '', hash: '', sessions: {} })

/** Hash a session token for storage. Fast on purpose: this is a 256-bit random value, not a
 *  password, so there is nothing to brute-force and no reason to pay scrypt for it. */
const fingerprint = (raw) => createHash('sha256').update(String(raw)).digest('hex')

/**
 * A password's scrypt hash, off the event loop. A login is ~100ms of scrypt, and done synchronously that is
 * 100ms in which no request, hook or stream is answered — ten wrong guesses a second from the
 * LAN was a second of every chat frozen. Async runs it on libuv's thread pool.
 */
const deriveAsync = (password, salt) =>
  new Promise((resolve, reject) =>
    scrypt(String(password), Buffer.from(salt, 'hex'), KEYLEN, SCRYPT, (err, key) => (err ? reject(err) : resolve(key.toString('hex'))))
  )

/**
 * The store, reloaded if another process has written the file since we read it.
 *
 * `fresh` skips the once-a-second throttle: every caller that is about to *write* passes it,
 * because writing a stale store is what silently reverts a password change.
 */
function loadSync({ fresh = false } = {}) {
  if (store && !fresh && Date.now() - lastStatAt < STAT_EVERY_MS) return store
  const mtime = mtimeOf()
  lastStatAt = Date.now()
  if (store && mtime === loadedMtimeMs) return store
  try {
    const raw = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'))
    store = { ...empty(), ...raw, sessions: raw.sessions || {} }
    loadedMtimeMs = mtime
    unreadable = ''
    pruneExpired()
  } catch (err) {
    if (err.code === 'ENOENT') {
      // No file is the normal case: password auth is simply off until somebody sets one.
      store = empty()
      loadedMtimeMs = 0
      unreadable = ''
      return store
    }
    // A file that is there and will not read is not "no password". Read as one, a running
    // server bound to the LAN stopped asking anybody for anything: `hasCredentials` went
    // false, setup mode is decided at boot and so was not on, and `checkApiRequest` fell
    // through to its loopback answer — every request allowed. So this fails closed. The last
    // good copy, if there is one, goes on answering; with none, `hasCredentials` still says
    // yes and nothing can pass, until the file is mended or `yarn passwd` replaces it.
    const why = `${AUTH_FILE} is not readable: ${err.message}`
    if (why !== unreadable) {
      console.warn(`[outpost] ${why}; ${store ? 'keeping the last good copy in memory' : 'refusing every login until it is mended, or `yarn passwd` replaces it'}`)
    }
    unreadable = why
    if (!store) store = empty()
    // Not looked at again until the file changes, like any other load.
    loadedMtimeMs = mtime
  }
  return store
}

async function persist() {
  const tmp = `${AUTH_FILE}.tmp`
  const json = JSON.stringify(store, null, 2) + '\n'
  // Written 0600 from the start rather than chmod'd afterwards — otherwise there is a window,
  // however brief, where a password hash sits on disk world-readable.
  await fsp.writeFile(tmp, json, { mode: 0o600 })
  await fsp.chmod(tmp, 0o600).catch(() => {})
  await fsp.rename(tmp, AUTH_FILE)
  // Remember what we just wrote, so the next read does not mistake our own write for
  // somebody else's and reload for nothing.
  loadedMtimeMs = mtimeOf()
  lastStatAt = Date.now()
  // What is on disk now is what we hold, whatever was there before.
  unreadable = ''
}

function pruneExpired() {
  const now = Date.now()
  let dropped = 0
  for (const [key, s] of Object.entries(store.sessions)) {
    if (!s || typeof s.expiresAt !== 'number' || s.expiresAt <= now) {
      delete store.sessions[key]
      dropped++
    }
  }
  return dropped
}

/**
 * Whether a password has been set. When false, password auth is off entirely — so an auth
 * file that exists and cannot be read answers true: somebody set one, and not being able to
 * check it is a reason to let nobody in, not everybody (`loadSync`).
 */
export function hasCredentials() {
  const s = loadSync()
  return Boolean(s.user && s.salt && s.hash) || Boolean(unreadable)
}

/** The configured username, for a login form that wants to prefill it. */
export const configuredUser = () => loadSync().user

/**
 * Set (or change) the password. Rotates the salt, and drops every existing session — changing
 * a password that someone else may know is meant to log that someone else out.
 */
export async function setPassword(user, password) {
  const salt = randomBytes(16).toString('hex')
  const hash = await deriveAsync(password, salt)
  // Loaded fresh after the hash, not before: the store is what gets written, and another
  // writer may have written in the time the hash took (the Hard rule in auth.md).
  const s = loadSync({ fresh: true })
  s.user = String(user)
  s.salt = salt
  s.hash = hash
  s.sessions = {}
  await persist()
  return { ok: true, user: s.user }
}

/** The two comparisons, given the attempt's derived hash and the store it was derived against. */
function matches(s, user, attemptHex) {
  const attempt = Buffer.from(attemptHex, 'hex')
  const known = Buffer.from(s.hash, 'hex')
  const passwordOk = attempt.length === known.length && timingSafeEqual(attempt, known)
  const a = Buffer.from(String(user ?? ''))
  const b = Buffer.from(s.user)
  const userOk = a.length === b.length && timingSafeEqual(a, b)
  return passwordOk && userOk
}

/**
 * Check a username and password, off the event loop (`deriveAsync`). Resolves to a boolean:
 * a caller must `await` it — a bare Promise is truthy, so `if (!verifyLoginAsync(…))` would let
 * every guess in.
 *
 * Both comparisons are timing-safe, and a wrong *username* still pays the full scrypt cost —
 * otherwise the response time tells an attacker which half they got right, and turns one
 * unknown into two independent ones.
 */
export async function verifyLoginAsync(user, password) {
  const s = loadSync({ fresh: true })
  // No hash to compare against: no password set, or a file that could not be read.
  if (!hasCredentials() || !s.hash || !s.salt) return false
  const { salt, hash, user: known } = s
  return matches({ hash, user: known }, user, await deriveAsync(password ?? '', salt))
}

/** Mint a session. The raw token is returned once and never stored in recoverable form. */
export async function createSession(label = '') {
  const s = loadSync({ fresh: true })
  const raw = randomBytes(32).toString('base64url')
  pruneExpired()
  s.sessions[fingerprint(raw)] = {
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_MS,
    label: String(label).slice(0, 120),
  }
  await persist()
  return raw
}

/** Whether this token is a live session. Expiry is enforced on read, not only on prune. */
export function checkSession(raw) {
  if (!raw) return false
  const s = loadSync()
  const hit = s.sessions[fingerprint(raw)]
  if (!hit) return false
  if (typeof hit.expiresAt !== 'number' || hit.expiresAt <= Date.now()) {
    delete s.sessions[fingerprint(raw)]
    persist().catch(() => {})
    return false
  }
  return true
}

/** Log one device out, leaving the others alone. */
export async function revokeSession(raw) {
  const s = loadSync({ fresh: true })
  const key = fingerprint(raw)
  if (!s.sessions[key]) return false
  delete s.sessions[key]
  await persist()
  return true
}

/** Log every device out, this one included. */
export async function revokeAllSessions() {
  const s = loadSync({ fresh: true })
  const n = Object.keys(s.sessions).length
  s.sessions = {}
  await persist()
  return n
}

export const sessionCount = () => Object.keys(loadSync().sessions).length
export const authFilePath = () => AUTH_FILE
export const sessionDays = () => SESSION_DAYS

/**
 * Login rate limiting, per client address.
 *
 * A password worth guessing is worth guessing quickly, and a LAN service with no limiter will
 * happily answer thousands of attempts a second. In memory rather than on disk because a
 * restart clearing the counter is not the threat — nobody is restarting the server between
 * guesses, and persisting it would let an attacker fill the disk instead.
 */
const ATTEMPTS = new Map()
const WINDOW_MS = 15 * 60 * 1000
const MAX_ATTEMPTS = 10
/** Clients tracked at once. Past it the oldest record goes, so the map cannot grow without bound. */
const MAX_TRACKED = 5000

/** An IPv6 address as its eight groups, or null. `::` expanded, a dotted IPv4 tail turned into two groups. */
function groupsOf(v6) {
  let s = v6
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (tail) {
    const [a, b, c, d] = tail[1].split('.').map(Number)
    s = s.slice(0, -tail[1].length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16)
  }
  const [head, rest] = s.split('::')
  const left = head ? head.split(':') : []
  const right = rest ? rest.split(':') : []
  const fill = s.includes('::') ? Array(8 - left.length - right.length).fill('0') : []
  const groups = [...left, ...fill, ...right]
  return groups.length === 8 ? groups.map((g) => parseInt(g, 16) || 0) : null
}

/**
 * Who a failed login counts against. IPv4 is the address. IPv6 is its /64: one machine is
 * routinely handed a whole /64 and can pick a fresh address for every guess, which made a
 * per-address limit no limit. An IPv4 client reaching a dual-stack socket arrives as
 * `::ffff:a.b.c.d` and is counted as `a.b.c.d`, the same as over IPv4.
 */
export function limiterKey(addr) {
  const raw = String(addr || '').replace(/%.*$/, '')
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(raw)
  if (mapped) return mapped[1]
  if (net.isIPv4(raw)) return raw
  if (net.isIPv6(raw)) {
    const g = groupsOf(raw.toLowerCase())
    if (g) return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`
  }
  return raw || 'unknown'
}

export function loginAllowed(addr) {
  const key = limiterKey(addr)
  const rec = ATTEMPTS.get(key)
  if (!rec || rec.resetAt <= Date.now()) return { ok: true, remaining: MAX_ATTEMPTS }
  if (rec.count >= MAX_ATTEMPTS) {
    return { ok: false, retryAfterMs: rec.resetAt - Date.now() }
  }
  return { ok: true, remaining: MAX_ATTEMPTS - rec.count }
}

export function noteFailedLogin(addr) {
  const key = limiterKey(addr)
  const now = Date.now()
  const rec = ATTEMPTS.get(key)
  if (rec && rec.resetAt > now) {
    rec.count++
    return
  }
  // A new record is where the map grows, so this is where it is kept in bound — pruning only
  // on a repeat let a stream of fresh addresses grow it forever. Lapsed records first; if it
  // is still full, the oldest (a Map iterates in insertion order).
  ATTEMPTS.delete(key)
  if (ATTEMPTS.size >= MAX_TRACKED) {
    for (const [k, v] of ATTEMPTS) if (v.resetAt <= now) ATTEMPTS.delete(k)
    while (ATTEMPTS.size >= MAX_TRACKED) ATTEMPTS.delete(ATTEMPTS.keys().next().value)
  }
  ATTEMPTS.set(key, { count: 1, resetAt: now + WINDOW_MS })
}

export const clearFailedLogins = (addr) => ATTEMPTS.delete(limiterKey(addr))

/** How many clients the limiter holds, for tests. */
export const trackedLogins = () => ATTEMPTS.size
