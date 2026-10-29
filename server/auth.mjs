/**
 * Who is allowed to drive this server.
 *
 * The usual answer for a local tool is "only a page this machine served", enforced by pinning
 * `Host` to loopback and `Origin` to the same. That is exactly right for a dashboard whose
 * browser and server are the same laptop, and exactly wrong for this one: the whole point is a
 * server on one machine and a browser on some other machine on the LAN.
 *
 * So the same-machine assumption is replaced with a bearer token, and the two checks it used
 * to lean on are kept as defence in depth rather than as the boundary:
 *
 *   - **Token.** The actual control. The page sends it as `Authorization: Bearer …` on every
 *     API call, having been handed it once in a `?token=` link. It lives in `localStorage`
 *     and never in a cookie — which is not a detail, it is what makes CSRF structurally
 *     impossible here. A cross-site page cannot read another origin's `localStorage`, so it
 *     cannot forge an authenticated request no matter what it does.
 *   - **Host.** Stops DNS rebinding, and matters most in the case with no token at all: a
 *     loopback server that trusts whoever reaches it. An attacker who points `evil.com` at
 *     127.0.0.1 arrives as a same-origin page and can read every reply — but still carries
 *     `Host: evil.com`.
 *   - **Origin.** Stops CSRF against that same tokenless case, where there is nothing else
 *     standing between a page you happened to be visiting and `POST /api/workspaces`.
 *
 * The one rule that is not optional: binding anywhere but loopback without a token is refused
 * at boot. Getting that wrong publishes a button that starts processes to the whole network,
 * and it is exactly the mistake that gets made at 1am while moving a service onto a VM.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import os from 'node:os'
import { checkSession, hasCredentials } from './credentials.mjs'

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0:0:0:0:0:0:0:1'])

/** Where to listen. Default keeps a fresh checkout private to the machine it runs on. */
export const BIND_HOST = process.env.OUTPOST_HOST || '127.0.0.1'
export const PORT = Number(process.env.PORT) || 5274

/** The API token. Empty means "no auth", which is only legal on loopback — see below. */
export const TOKEN = process.env.OUTPOST_TOKEN || ''

export const isLoopbackBind = () => LOOPBACK.has(BIND_HOST.toLowerCase())

/**
 * Extra hostnames this server may be addressed as, beyond loopback and the bind address —
 * `outpost.lan`, a Tailscale name, whatever the reverse proxy calls it. Optional hardening:
 * with a token set and no list configured, any Host is accepted and the token does the work.
 */
const ALLOWED_HOSTS = (process.env.OUTPOST_ALLOWED_HOSTS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)

/**
 * Refuse to start wide open. Throwing here rather than warning is deliberate: a warning in a
 * scrollback nobody reads is the same as no warning, and the failure mode is a LAN-exposed
 * endpoint that can spawn sessions and run git.
 */
/**
 * A fresh box: bound off loopback, no token, no password. Rather than refusing to start —
 * which leaves "set a password" as a step done on the machine, by hand, every time Outpost
 * moves house — the server starts in *setup mode*: every endpoint answers 401 except the one
 * that sets the first password, and that one needs this token, printed once in the log at
 * start. The token dies the moment a password exists. What stands between the network and a
 * button that starts processes is therefore still something: nothing starts until a password
 * is set, and setting it needs a secret only a person at the machine's log has.
 */
export const SETUP_TOKEN = !TOKEN && !hasCredentials() && !isLoopbackBind() ? randomBytes(24).toString('base64url') : ''
export const setupMode = () => Boolean(SETUP_TOKEN) && !hasCredentials()

export function assertSafeBind() {
  // A password is protection too — the point of this check is that *something* stands between
  // the network and a button that starts processes, not that it is specifically a token.
  if (isLoopbackBind() || TOKEN || hasCredentials()) return
  if (SETUP_TOKEN) return
  const suggestion = randomBytes(24).toString('base64url')
  throw new Error(
    `Refusing to bind to ${BIND_HOST} with no OUTPOST_TOKEN set.\n\n` +
      `Anyone who can reach this port could start sessions and run git as you. Set a token:\n\n` +
      `  OUTPOST_TOKEN=${suggestion} OUTPOST_HOST=${BIND_HOST} yarn serve\n\n` +
      `then open the dashboard once at  http://<this-host>:${PORT}/?token=${suggestion}\n` +
      `The page keeps it from then on. To stay private to this machine instead, unset OUTPOST_HOST.`
  )
}

/** Hostname out of a `Host:` or `Origin:` value, with the port and any brackets stripped. */
export function hostnameOf(value) {
  if (!value) return ''
  const raw = String(value).includes('://') ? value : `http://${value}`
  try {
    return new URL(raw).hostname.replace(/^\[|\]$/g, '').toLowerCase()
  } catch {
    return ''
  }
}

function hostAllowed(host) {
  if (!host) return false
  if (LOOPBACK.has(host)) return true
  if (ALLOWED_HOSTS.includes(host)) return true
  if (host === BIND_HOST.toLowerCase()) return true
  // Setup mode on a fresh `0.0.0.0` box: the link `accessUrl()` prints names the LAN address,
  // and refusing it left the first password impossible to set from another device. Only that
  // address, not any Host: the setup token is the gate, this keeps rebinding names out.
  if (setupMode() && host === lanAddress()) return true
  // Bound wide and reached by whatever address the client resolved. With a token that is
  // fine — it is the token, not the hostname, deciding this. Without one we never get here,
  // because `assertSafeBind` will not let the server start.
  return Boolean(TOKEN || hasCredentials()) && ALLOWED_HOSTS.length === 0
}

const equals = (a, b) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * The Bearer header, and only that. The `?token=` link is for the page (`/`), which claims it
 * into `localStorage` and strips it from the address bar; no `/api/*` caller sends one. Taking
 * it here too made every API URL a place a credential could ride, and URLs land in logs,
 * history and `Referer`.
 */
function tokenOf(req) {
  const auth = String(req.headers.authorization || '')
  return auth.startsWith('Bearer ') ? auth.slice(7) : ''
}

/**
 * The gate for `/api/*`. Returns `{ ok: true }`, or a status and a message meant to be read
 * by a person staring at a dashboard that will not load.
 *
 * `/api/hook` does not come through here: hooks are posted by `claude` itself with no Origin
 * and no browser, and are gated separately in `api.mjs` on being same-machine.
 */
/**
 * The hostname and origin half of the gate, without the credential half.
 *
 * Split out because `/api/login` needs exactly this and nothing more: it is the one endpoint
 * that must answer a request carrying no credential, since obtaining one is its whole job.
 * It still has to be same-origin and addressed by a name we answer to.
 */
export function checkRequestOrigin(req) {
  if (!hostAllowed(hostnameOf(req.headers.host))) {
    return { ok: false, status: 403, error: 'Outpost does not answer to that hostname' }
  }
  const origin = req.headers.origin
  if (origin && origin !== 'null' && hostnameOf(origin) !== hostnameOf(req.headers.host)) {
    return { ok: false, status: 403, error: 'Cross-origin requests are not accepted' }
  }
  return { ok: true }
}

export function checkApiRequest(req, url) {
  if (!hostAllowed(hostnameOf(req.headers.host))) {
    return { ok: false, status: 403, error: 'Outpost does not answer to that hostname' }
  }
  // Setup mode: nothing is reachable until the first password exists (`/api/setup` is gated
  // by its own token in api.mjs, outside this check, like `/api/login`).
  if (setupMode()) return { ok: false, status: 401, error: 'Set a password to start using this Outpost', needsSetup: true }

  const writing = req.method !== 'GET' && req.method !== 'HEAD'
  const origin = req.headers.origin
  if (origin && origin !== 'null') {
    // Same-origin only. Compared against the request's own Host rather than a fixed list, so
    // this keeps working under whatever name the server ends up being reached by.
    if (hostnameOf(origin) !== hostnameOf(req.headers.host)) {
      return { ok: false, status: 403, error: 'Cross-origin requests are not accepted' }
    }
  } else if (writing && !TOKEN && !hasCredentials()) {
    // No Origin on a write, and no token to prove it is the page: browsers always send one,
    // so this is not the page. With a token set the token is proof enough, which is what
    // lets `curl -H 'Authorization: Bearer …'` script this.
    return { ok: false, status: 403, error: 'A state-changing request must carry an Origin' }
  }

  // Two ways to be allowed in, and they answer different needs. The static token is for
  // things that cannot type a password — curl, a health check, a systemd unit. A session is
  // what a person holds, and unlike the static token it expires and can be revoked alone.
  const presented = tokenOf(req)
  if (TOKEN && equals(presented, TOKEN)) return { ok: true }
  if (hasCredentials() && checkSession(presented)) return { ok: true }

  if (TOKEN || hasCredentials()) {
    return {
      ok: false,
      status: 401,
      error: hasCredentials() ? 'Log in to use this dashboard' : 'Missing or invalid token. Open the dashboard with ?token=…',
      needsLogin: hasCredentials(),
    }
  }

  return { ok: true }
}

/** A bridge Docker or libvirt made: never the address another box reaches this one on. */
const VIRTUAL_IF = /^(docker|br-|veth|virbr|cni|flannel)/

/** This machine's first non-internal IPv4 on a real interface, which is the address another box can reach it on. */
export function lanAddress() {
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_IF.test(name)) continue
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address
    }
  }
  return '127.0.0.1'
}

/**
 * The link to actually open, token and all.
 *
 * Two things worth doing here rather than at each call site. `0.0.0.0` is a bind address, not
 * a place a browser can go, so echoing it back is useless to the one person reading this line
 * to find out where the dashboard is — on a VM whose whole purpose is being reached from
 * another machine, the LAN address is the only form of the link with any value. And the token
 * belongs in it: it is needed exactly once, and a token that lives only in an env var is one
 * somebody has to splice into a URL by hand at the moment they least want to.
 */
export function accessUrl() {
  const wildcard = BIND_HOST === '0.0.0.0' || BIND_HOST === '::'
  const host = wildcard ? lanAddress() : BIND_HOST
  const query = TOKEN ? `/?token=${encodeURIComponent(TOKEN)}` : setupMode() ? `/?setup=${encodeURIComponent(SETUP_TOKEN)}` : '/'
  return `http://${host}:${PORT}${query}`
}

/** Whether a setup token is live: the page shows a set-a-password form and nothing else. */
export const setupRequired = () => setupMode()

/** Whether there is a password to log in with, as opposed to a token to be handed. */
export const passwordAuthEnabled = () => hasCredentials()
