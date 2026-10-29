/**
 * A repo's Environment: the variables every chat on it gets in its checkout's `.env.local`
 * (docs/proposals/settings.md, phase 4).
 *
 * A plain entry's value is kept in the catalogue. A secret's is kept in the store, under
 * `envSecretName(repo, name)`, and goes in once and never comes back out (setup.md): the page
 * is told only its last four characters. The chat itself can read what lands in its
 * `.env.local` — that is the owner's deliberate exception to "a session never holds a
 * credential", scoped to a repo's runtime environment, because the app the chat runs needs
 * them (an app's API credential, say).
 *
 * An entry can be **locked**: changing, removing or unlocking one asks for the owner's Outpost
 * password, so a slip in Settings cannot flip a value nobody meant to touch. No chat has a tool
 * that edits an Environment at all.
 */
import { envSecretName } from './catalogue.mjs'
import { addToken, listSecrets, removeSecret, tokenValue } from '../secrets/index.mjs'
import { clearFailedLogins, configuredUser, hasCredentials, loginAllowed, noteFailedLogin, verifyLoginAsync } from '../credentials.mjs'

/** A refusal the API answers with its own status, so a locked change is a 403 with a sentence. */
class EnvRefusal extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/**
 * The Environment as the page draws it: each entry, a secret's value replaced by whether it is
 * saved and its last four characters. Never a secret's value.
 */
export async function envView(repo) {
  const hints = new Map((await listSecrets()).filter((s) => s.kind === 'token').map((s) => [s.name, s.hint]))
  return (repo?.env || []).map((e) => (e.secret ? { ...e, value: '', hint: hints.get(envSecretName(repo.id, e.name)) || '' } : e))
}

/**
 * Turn the page's Environment into what is kept, storing what a secret was given. `incoming` is
 * the page's list — a secret with a `value` is new or replaced, one without keeps what is
 * saved — and `previous` the repo's list as saved. Throws an `EnvRefusal` for a locked entry
 * changed without the password, and for a secret that has no value anywhere.
 *
 * `addr` is the request's socket address: a wrong password counts against the login limit
 * (auth.md), so the lock is no easier to guess than the login.
 */
export async function acceptEnv(repoId, incoming, previous, { password = '', addr = '' } = {}) {
  const before = new Map((previous || []).map((e) => [e.name, e]))
  const after = new Map()
  for (const e of Array.isArray(incoming) ? incoming : []) {
    const name = String(e?.name || '').trim()
    if (!name || after.has(name)) continue
    after.set(name, e)
  }
  // Which locked entries this changes: gone, unlocked, turned to or from secret, or given a new
  // value. Only those need the password; anything else saves as it always did.
  const touched = []
  for (const [name, old] of before) {
    if (!old.locked) continue
    const now = after.get(name)
    const changed =
      !now ||
      now.locked !== true ||
      (now.secret === true) !== old.secret ||
      (old.secret ? typeof now.value === 'string' && now.value !== '' : String(now.value ?? '') !== old.value)
    if (changed) touched.push(name)
  }
  if (touched.length && hasCredentials()) {
    const gate = loginAllowed(addr)
    if (!gate.ok) throw new EnvRefusal(429, `Too many attempts. Try again in ${Math.ceil(gate.retryAfterMs / 60000)} minutes.`)
    if (!password) throw new EnvRefusal(403, `This changes a locked variable (${touched.join(', ')}) — confirm with your Outpost password`)
    // Counted before the check, as login is: parallel guesses must not all pass the gate.
    noteFailedLogin(addr)
    if (!(await verifyLoginAsync(configuredUser(), String(password)))) {
      throw new EnvRefusal(403, 'That is not your password — the locked variable was not changed')
    }
    clearFailedLogins(addr)
  }
  const kept = []
  for (const [name, e] of after) {
    const secret = e.secret === true
    const store = envSecretName(repoId, name)
    // A secret with nothing saved yet is kept as a name to fill in (the owner's: entries set
    // up ahead, values typed in later); `envVars` leaves it out of `.env.local` until then.
    if (secret && typeof e.value === 'string' && e.value !== '') await addToken(store, e.value)
    kept.push({ name, value: secret ? '' : String(e.value ?? ''), secret, locked: e.locked === true })
  }
  // A secret that is gone, or no longer secret, leaves the store too: nothing lingers.
  for (const [name, old] of before) {
    if (old.secret && !kept.some((k) => k.name === name && k.secret)) await removeSecret(envSecretName(repoId, name)).catch(() => {})
  }
  return kept
}

export { EnvRefusal }

/**
 * The variables a chat on this repo gets: every entry, a secret's value read from the store
 * now. A secret with no value yet is left out rather than written empty — an app that reads
 * `X ?? fallback` would take an empty string as set.
 */
export async function envVars(repo) {
  const vars = {}
  for (const e of repo?.env || []) {
    if (!e.secret) vars[e.name] = e.value
    else {
      const v = await tokenValue(envSecretName(repo.id, e.name))
      if (v) vars[e.name] = v
    }
  }
  return vars
}
