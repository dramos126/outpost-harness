/**
 * Outside services Outpost can act on for a chat: GitHub and Jenkins. Each is a small set of
 * calls made with a secret from the store, on the server, so a session gets a tool and a
 * result and never the credential (docs/proposals/harness.md, *Integrations reach a chat as
 * tools*).
 *
 * Configuration is `integrations` in `settings.json`: `{ github: { secret }, jenkins: { url,
 * user, secret } }` — names of secrets, never values, so the file stays exportable.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readSettings, saveIntegrations } from './config.mjs'
import { addToken, gitEnvFor, listSecrets, removeSecret, secretKind, tokenValue } from './secrets/index.mjs'
import { scrub } from './search/index.mjs'
import { notifySettings } from './notify/index.mjs'

const UA = 'outpost (+https://github.com/dramos126/outpost-harness)'

/**
 * The secret each integration keeps its own token under, when the token is given to the
 * integration itself (`saveIntegration`). One per integration, named after it.
 */
const OWN_SECRET = Object.freeze({ github: 'github', jenkins: 'jenkins' })
/** The token Jenkins presents when it posts a result to `/api/jenkins/notify`. */
const NOTIFY_SECRET = 'jenkins-notify'

/**
 * The integrations as the page draws them: what `settings.json` names, and for each whether it
 * has a token and the last few characters of it. Never the token.
 */
export async function integrationsView() {
  const { integrations } = await readSettings()
  const hints = new Map((await listSecrets()).filter((s) => s.kind === 'token').map((s) => [s.name, s.hint]))
  const view = (i) => ({ ...i, configured: Boolean(i.secret && hints.has(i.secret)), hint: hints.get(i.secret) || '' })
  const j = integrations.jenkins
  return {
    github: view(integrations.github),
    jenkins: { ...view(j), notifyConfigured: Boolean(j.notifySecret && hints.has(j.notifySecret)), notifyHint: hints.get(j.notifySecret) || '' },
  }
}

/**
 * Make Jenkins's notify token: random, kept in the store, and handed back this once so the
 * owner can paste it into a Jenkins credential — the one value that ever leaves the store, and
 * only in the answer to making it (setup.md). Replaces any token there was, so the copy Jenkins
 * holds stops working until the new one is pasted.
 */
export async function generateNotifyToken() {
  const token = randomBytes(32).toString('base64url')
  await addToken(NOTIFY_SECRET, token)
  const { integrations } = await readSettings()
  await saveIntegrations({ ...integrations, jenkins: { ...integrations.jenkins, notifySecret: NOTIFY_SECRET } })
  return { token, integrations: await integrationsView() }
}

/**
 * Whether `offered` (the request's `Authorization`) is the token Jenkins was given for posting
 * results. False when none is saved: the endpoint is closed until the owner sets one.
 */
export async function jenkinsNotifyAllowed(offered) {
  const { integrations } = await readSettings()
  const name = integrations?.jenkins?.notifySecret
  const value = name ? await tokenValue(name) : ''
  if (!value) return false
  const a = Buffer.from(String(offered || ''))
  const b = Buffer.from(`Bearer ${value}`)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Save one integration, and nothing about the other. Each section of the page is its own:
 * the token is pasted into the integration it is for, not made under Keys and tokens first
 * and then chosen from a list — two steps on two pages for one thing, which is how it was.
 *
 * `token` is stored in the secret store under the integration's own name and replaces
 * whatever was there; `clear` removes it. Neither ever comes back out (setup.md). A body that
 * names an existing `secret` instead — the old shape — still chooses it.
 */
export async function saveIntegration(which, body = {}) {
  if (!OWN_SECRET[which]) throw new Error('An integration is github or jenkins')
  const { integrations } = await readSettings()
  const next = { ...integrations[which] }
  if (which === 'jenkins') {
    if (body.url !== undefined) next.url = String(body.url || '')
    if (body.user !== undefined) next.user = String(body.user || '')
  }
  // Jenkins's second token, the one it posts results with: pasted, kept, never shown again.
  if (which === 'jenkins') {
    const notify = String(body.notifyToken || '').trim()
    if (body.clearNotify) {
      if (next.notifySecret === NOTIFY_SECRET) await removeSecret(NOTIFY_SECRET)
      next.notifySecret = ''
    } else if (notify) {
      if (notify.length < 16) throw new Error('Make the notify token at least 16 characters — it is all that stands between the LAN and this endpoint')
      await addToken(NOTIFY_SECRET, notify)
      next.notifySecret = NOTIFY_SECRET
    }
  }
  const token = String(body.token || '').trim()
  if (body.clear) {
    if (next.secret === OWN_SECRET[which]) await removeSecret(OWN_SECRET[which])
    next.secret = ''
  } else if (token) {
    await addToken(OWN_SECRET[which], token)
    next.secret = OWN_SECRET[which]
  } else if (body.secret !== undefined) {
    next.secret = String(body.secret || '')
  }
  await saveIntegrations({ ...integrations, [which]: next })
  return integrationsView()
}

/**
 * A repo's access choice for "this machine's own access" — the user's ssh setup on this box.
 * Spelled out because the empty choice now means the GitHub integration: on a GitHub repo an
 * empty `auth` used to be this, and it does not travel to another machine.
 */
export const MACHINE_ACCESS = '@machine'

/**
 * How Outpost reaches a repo for its own git work — cloning and fetching the mirror, Push,
 * Finish, the catalogue's Test: `{ url, env, via }`, the address to use and the environment
 * that carries the credential.
 *
 * - A secret named on the repo: that secret. A token goes over https, so a GitHub ssh address
 *   is rewritten to its https form; a key goes over the address as written.
 * - No choice, on a GitHub repo, with the GitHub integration configured: the integration's
 *   token, over https. This is the default, and the first time Outpost reaches GitHub
 *   without the owner's own ssh key (docs/proposals/settings.md, phase 2).
 * - `MACHINE_ACCESS`, or no choice where no integration applies: the address as written and
 *   whatever this machine's user can already reach.
 *
 * The address is passed to each git call rather than written into the mirror's `origin`,
 * which stays as catalogued: a session that runs `git push` in its own checkout uses
 * `origin`, and until a chat has a push tool of its own that is how it lands its work.
 */
export async function remoteFor(repo) {
  const url = String(repo?.url || '')
  const auth = String(repo?.auth || '')
  if (auth === MACHINE_ACCESS) return { url, env: {}, via: 'machine' }
  // The address goes to `gitEnvFor` too: a token is handed to that address's host and no other.
  if (auth) {
    const token = (await secretKind(auth)) === 'token'
    const to = token ? httpsFor(url) : url
    return { url: to, env: await gitEnvFor(auth, to), via: 'secret' }
  }
  const gh = githubRepoOf(url)
  const { integrations } = await readSettings()
  const name = integrations?.github?.secret
  if (gh && name && (await tokenValue(name))) return { url: httpsFor(url), env: await gitEnvFor(name, httpsFor(url)), via: 'github' }
  return { url, env: {}, via: 'machine' }
}

/** A GitHub address in its https form, which a token can authenticate; anything else as given. */
function httpsFor(url) {
  const gh = githubRepoOf(url)
  return gh ? `https://github.com/${gh.owner}/${gh.repo}.git` : url
}

/**
 * The tools of these that can work: a GitHub tool needs the GitHub integration configured,
 * a Jenkins tool needs Jenkins's address and token, `discord_send` a saved webhook. A repo whose policy grants a tool that
 * cannot work used to offer it anyway, and the chat learned it was "not configured" by
 * calling it.
 */
export async function usableTools(names) {
  const v = await integrationsView()
  const jenkins = v.jenkins.configured && Boolean(v.jenkins.url)
  // `jenkins_wait` is answered by Jenkins posting results as much as by asking it, so the
  // notify token alone is enough for it.
  const hearing = jenkins || v.jenkins.notifyConfigured
  // The host tools wait for some host to have something a chat may do (hosts.mjs).
  const hosts = (await readSettings()).environments.some((e) => e.actions?.length)
  const discord = names.includes('discord_send') && (await notifySettings()).configured
  return names.filter(
    (n) => !(n.startsWith('github_') && !v.github.configured) && !(n === 'jenkins_wait' ? !hearing : n.startsWith('jenkins_') && !jenkins) && !(n.startsWith('host_') && !hosts) && !(n === 'discord_send' && !discord)
  )
}

/** `git@github.com:owner/repo.git` or `https://github.com/owner/repo` → `{ owner, repo }`. */
export function githubRepoOf(url) {
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(String(url || ''))
  return m ? { owner: m[1], repo: m[2] } : null
}

async function githubToken() {
  const { integrations } = await readSettings()
  const name = integrations?.github?.secret
  if (!name) throw new Error('GitHub is not configured — paste a token in Settings › Integrations › GitHub')
  const value = await tokenValue(name)
  if (!value) throw new Error(`The GitHub secret "${name}" is not a token in the store`)
  return value
}

/**
 * When the token stops working, as GitHub says on every answer to a fine-grained token
 * (`github-authentication-token-expiration`), or `''` for a token that does not expire or
 * has not been used yet. Kept from the last call so Test can say it: a year-long token is
 * one nobody remembers making, and the day it lapses every GitHub tool stops at once.
 */
let tokenExpiresAt = ''

async function github(pathname, { method = 'GET', body, raw = false } = {}) {
  const token = await githubToken()
  const res = await fetch(`https://api.github.com${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': UA,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  })
  tokenExpiresAt = res.headers.get('github-authentication-token-expiration') || ''
  // A job's log is a redirect to a signed address, followed by fetch without the token.
  if (raw && res.ok) return res.text()
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    // GitHub puts the reason in `errors`, and "Validation Failed" alone says nothing: a pull
    // request with nothing in it came back as exactly that from the first real one tried.
    const why = (Array.isArray(data.errors) ? data.errors : []).map((e) => e?.message || [e?.resource, e?.field, e?.code].filter(Boolean).join(' ')).filter(Boolean)
    throw new Error(`GitHub ${res.status}: ${data.message || res.statusText}${why.length ? ` — ${why.join('; ')}` : ''}`)
  }
  return data
}

export async function testGithub() {
  try {
    const me = await github('/user')
    // "2027-10-03 10:00:00 -0400" as GitHub writes it; handed on as written, and as epoch
    // ms where it parses, so the page can say "expires 3 Oct 2027".
    const at = Date.parse(tokenExpiresAt.replace(' ', 'T').replace(/ ([+-]\d{2})(\d{2})$/, '$1:$2').replace(/ UTC$/, 'Z'))
    return { ok: true, login: me.login, expires: tokenExpiresAt, expiresAt: Number.isFinite(at) ? at : 0 }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

/** Pull requests for a branch, with the combined status of the first one's head. */
export async function githubPullStatus(repoUrl, branch) {
  const r = githubRepoOf(repoUrl)
  if (!r) throw new Error('That repo is not on GitHub')
  const query = branch ? `?state=all&head=${encodeURIComponent(`${r.owner}:${branch}`)}&per_page=5` : '?state=open&per_page=10'
  const pulls = await github(`/repos/${r.owner}/${r.repo}/pulls${query}`)
  const out = []
  for (const p of pulls) {
    const entry = { number: p.number, title: p.title, state: p.merged_at ? 'merged' : p.state, draft: Boolean(p.draft), url: p.html_url, head: p.head?.ref, base: p.base?.ref }
    if (out.length === 0 && p.head?.sha) {
      try {
        const status = await github(`/repos/${r.owner}/${r.repo}/commits/${p.head.sha}/status`)
        entry.checks = status.state
      } catch {
        /* no status is a fact too */
      }
    }
    out.push(entry)
  }
  return out
}

/** Open a pull request from a chat's branch to the base. Answers the PR's number and URL. */
export async function githubCreatePull(repoUrl, { head, base, title, body = '' }) {
  const r = githubRepoOf(repoUrl)
  if (!r) throw new Error('That repo is not on GitHub')
  const existing = await github(`/repos/${r.owner}/${r.repo}/pulls?state=open&head=${encodeURIComponent(`${r.owner}:${head}`)}&per_page=1`)
  if (existing.length) return { number: existing[0].number, url: existing[0].html_url, existing: true }
  const pr = await github(`/repos/${r.owner}/${r.repo}/pulls`, { method: 'POST', body: { head, base, title, body } })
  return { number: pr.number, url: pr.html_url, existing: false }
}

/** `/repos/<owner>/<repo>` for a GitHub address; anything else is refused in words. */
function repoApi(repoUrl) {
  const r = githubRepoOf(repoUrl)
  if (!r) throw new Error('That repo is not on GitHub')
  return `/repos/${r.owner}/${r.repo}`
}

/** A comment's or an issue's text as a tool answers it: scrubbed, and cut at `max` characters. */
const said = (text, max) => {
  const t = scrub(String(text || '').replace(/\r\n/g, '\n').trim())
  return t.length > max ? `${t.slice(0, max)}…(${t.length - max} more characters)` : t
}

/**
 * One pull request: by number, else the newest for `branch`, an open one first. Throws a
 * sentence when there is none.
 */
export async function githubPull(repoUrl, { number = 0, branch = '' } = {}) {
  const api = repoApi(repoUrl)
  let n = Number(number) || 0
  if (!n) {
    if (!branch) throw new Error('Name the pull request by number: this chat has opened none')
    const { owner } = githubRepoOf(repoUrl)
    const list = await github(`${api}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=5`)
    const pick = list.find((p) => p.state === 'open') || list[0]
    if (!pick) throw new Error(`No pull request for ${branch}`)
    n = pick.number
  }
  const p = await github(`${api}/pulls/${n}`)
  return {
    number: p.number,
    title: p.title,
    state: p.merged_at ? 'merged' : p.state,
    draft: Boolean(p.draft),
    mergeable: p.mergeable,
    head: p.head?.ref,
    headSha: p.head?.sha,
    base: p.base?.ref,
    author: p.user?.login || '',
    url: p.html_url,
  }
}

/**
 * What was said on a pull request, oldest first, the last `limit`: each review's verdict and
 * text, each line comment with its file and line, and the conversation. A review that only
 * holds line comments has no text of its own and is not listed apart from them. The first
 * hundred of each kind are read (GitHub's page), which `capped` says.
 */
export async function githubPullComments(repoUrl, number, { limit = 20, chars = 2000 } = {}) {
  const api = repoApi(repoUrl)
  const [reviews, inline, talk] = await Promise.all([
    github(`${api}/pulls/${number}/reviews?per_page=100`),
    github(`${api}/pulls/${number}/comments?per_page=100`),
    github(`${api}/issues/${number}/comments?per_page=100`),
  ])
  const verdict = { APPROVED: 'approved', CHANGES_REQUESTED: 'requested changes', COMMENTED: 'commented', DISMISSED: 'review dismissed' }
  const all = [
    ...reviews
      .filter((r) => r.state !== 'PENDING' && (r.body?.trim() || r.state !== 'COMMENTED'))
      .map((r) => ({ at: r.submitted_at, who: r.user?.login || '?', what: verdict[r.state] || r.state.toLowerCase(), body: said(r.body, chars) })),
    ...inline.map((c) => ({
      at: c.created_at,
      who: c.user?.login || '?',
      what: `on ${c.path}${c.line ?? c.original_line ? `:${c.line ?? c.original_line}` : ''}${c.line == null ? ' (outdated)' : ''}${c.in_reply_to_id ? ', replying' : ''}`,
      body: said(c.body, chars),
    })),
    ...talk.map((c) => ({ at: c.created_at, who: c.user?.login || '?', what: 'said', body: said(c.body, chars) })),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)))
  return { total: all.length, comments: all.slice(-limit), capped: [reviews, inline, talk].some((x) => x.length >= 100) }
}

/** An issue (or a pull request read as one): its text, labels, and its last `comments` comments. */
export async function githubIssue(repoUrl, number, { comments = 10, chars = 2000, bodyChars = 16000 } = {}) {
  const api = repoApi(repoUrl)
  const i = await github(`${api}/issues/${number}`)
  const replies = i.comments && comments ? await github(`${api}/issues/${number}/comments?per_page=100`) : []
  return {
    number: i.number,
    title: i.title,
    state: i.state_reason && i.state === 'closed' ? `closed (${i.state_reason.replace(/_/g, ' ')})` : i.state,
    pull: Boolean(i.pull_request),
    author: i.user?.login || '',
    labels: (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
    assignees: (i.assignees || []).map((a) => a.login),
    url: i.html_url,
    body: said(i.body, bodyChars),
    total: i.comments || 0,
    comments: replies.slice(-comments).map((c) => ({ at: c.created_at, who: c.user?.login || '?', body: said(c.body, chars) })),
  }
}

/**
 * GitHub Actions runs, newest first, for a branch or a commit. GitHub filters by a whole commit
 * hash only, so a short one is matched here against the latest fifty.
 */
export async function githubRuns(repoUrl, { branch = '', commit = '', limit = 10 } = {}) {
  const api = repoApi(repoUrl)
  const sha = String(commit || '').trim().toLowerCase()
  const q = new URLSearchParams({ per_page: String(sha && sha.length < 40 ? 50 : limit) })
  if (branch) q.set('branch', branch)
  if (sha.length === 40) q.set('head_sha', sha)
  const d = await github(`${api}/actions/runs?${q}`)
  const runs = (d.workflow_runs || []).filter((r) => !sha || r.head_sha.startsWith(sha)).slice(0, limit)
  return {
    total: sha && sha.length < 40 ? runs.length : d.total_count || 0,
    runs: runs.map((r) => ({
      id: r.id,
      workflow: r.name,
      title: r.display_title || '',
      branch: r.head_branch,
      commit: String(r.head_sha).slice(0, 7),
      event: r.event,
      result: r.status === 'completed' ? r.conclusion : r.status,
      attempt: r.run_attempt || 1,
      at: r.run_started_at || r.created_at,
      url: r.html_url,
    })),
  }
}

/**
 * The end of an Actions job's log, up to its last error — the lines after it are the clean-up
 * steps, which say nothing: `keep` lines and at most `bytes` of them. Each line loses its
 * timestamp and colours, GitHub's `##[group]` marks become `▸`, and one over a thousand
 * characters keeps its start, as a Jenkins log's does. Scrubbed. `{ text, lines, of }`.
 */
export function actionsLogEnd(text, { lines: keep = 80, bytes = Infinity } = {}) {
  const all = String(text)
    .split('\n')
    .map((l) =>
      l
        .replace(/^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '')
        .replace(/\x1b\[[0-9;]*m/g, '')
        .replace(/^##\[group\]/, '▸ ')
        .replace(/\r$/, '')
    )
    .filter((l) => l && l !== '##[endgroup]')
    .map((l) => (l.length > 1000 ? `${l.slice(0, 300)}…(${l.length - 300} more characters)` : l))
  let end = all.length
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].startsWith('##[error]')) {
      end = i + 1
      break
    }
  }
  const shown = []
  let size = 0
  for (let i = end - 1; i >= 0 && shown.length < keep; i--) {
    const n = Buffer.byteLength(all[i]) + 1
    if (size + n > bytes) break
    size += n
    shown.unshift(all[i])
  }
  return { text: scrub(shown.join('\n')), lines: shown.length, of: end }
}

/** A job or step that did not get through: a cancelled one is how a run that "failed" can have no failed job. */
const BAD = new Set(['failure', 'timed_out', 'cancelled', 'startup_failure'])

/**
 * One Actions run: its jobs, and for each of the first five that did not get through, the steps
 * that did not and the end of its log (`actionsLogEnd`).
 */
export async function githubRun(repoUrl, runId, { lines = 80, bytes = Infinity } = {}) {
  const api = repoApi(repoUrl)
  const run = await github(`${api}/actions/runs/${runId}`)
  const { jobs = [] } = await github(`${api}/actions/runs/${runId}/jobs?per_page=100&filter=latest`)
  const failed = []
  for (const j of jobs.filter((x) => BAD.has(x.conclusion)).slice(0, 5)) {
    const steps = (j.steps || []).filter((s) => BAD.has(s.conclusion)).map((s) => s.name)
    try {
      const log = actionsLogEnd(await github(`${api}/actions/jobs/${j.id}/logs`, { raw: true }), { lines, bytes })
      failed.push({ name: j.name, result: j.conclusion, steps, ...log, url: j.html_url })
    } catch (err) {
      failed.push({ name: j.name, result: j.conclusion, steps, text: `(no log: ${err.message})`, lines: 0, of: 0, url: j.html_url })
    }
  }
  return {
    id: run.id,
    workflow: run.name,
    branch: run.head_branch,
    commit: String(run.head_sha || '').slice(0, 7),
    result: run.status === 'completed' ? run.conclusion : run.status,
    url: run.html_url,
    jobs: jobs.map((j) => ({ name: j.name, result: j.status === 'completed' ? j.conclusion : j.status })),
    failed,
  }
}

/**
 * Merge a pull request. With no `method`, the first the repo allows of merge, squash and
 * rebase: a repo that allows only squash answers a plain merge with a 405. `sha` makes GitHub
 * refuse if the branch moved since it was read.
 */
export async function githubMergePull(repoUrl, number, { method = '', sha = '' } = {}) {
  const api = repoApi(repoUrl)
  let how = String(method || '').trim()
  if (!how) {
    const repo = await github(api)
    how = repo.allow_merge_commit !== false ? 'merge' : repo.allow_squash_merge !== false ? 'squash' : 'rebase'
  }
  if (!['merge', 'squash', 'rebase'].includes(how)) throw new Error('method is merge, squash or rebase')
  const r = await github(`${api}/pulls/${number}/merge`, { method: 'PUT', body: { merge_method: how, ...(sha ? { sha } : {}) } })
  return { sha: r.sha, method: how }
}

/**
 * What the token may do with a repo, asked of GitHub: `{ push }`. The custom push Test's
 * check that a branch "may be made" — a real call, where reading the repo proves nothing
 * about writing to it.
 */
export async function githubRepoAccess(repoUrl) {
  const r = githubRepoOf(repoUrl)
  if (!r) throw new Error('That repo is not on GitHub')
  const data = await github(`/repos/${r.owner}/${r.repo}`)
  return { push: Boolean(data.permissions?.push) }
}

async function jenkinsConfig() {
  const { integrations } = await readSettings()
  const j = integrations?.jenkins
  if (!j?.url || !j?.secret) throw new Error('Jenkins is not configured — set its URL, user and token in Settings › Integrations › Jenkins')
  const token = await tokenValue(j.secret)
  if (!token) throw new Error(`The Jenkins secret "${j.secret}" is not a token in the store`)
  return { url: j.url.replace(/\/+$/, ''), user: j.user || '', token }
}

async function jenkins(pathname, { method = 'GET', form, raw = false } = {}) {
  const c = await jenkinsConfig()
  // A queue item's address comes back whole from Jenkins; anything else is a path under it.
  const res = await fetch(/^https?:\/\//.test(pathname) ? pathname : `${c.url}${pathname}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${c.user}:${c.token}`).toString('base64')}`,
      'User-Agent': UA,
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`Jenkins ${res.status}: ${res.statusText}`)
  if (raw) return res
  const text = await res.text()
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return { raw: text.slice(0, 500) }
  }
}

/** `folder/job` → `/job/folder/job/job`, which is how Jenkins addresses a job in a folder. */
const jobPath = (job) =>
  String(job || '')
    .split('/')
    .filter(Boolean)
    .map((p) => `/job/${encodeURIComponent(p)}`)
    .join('')

/** `owner/repo` of any address GitHub or another host would give: what two remote URLs are compared on. */
const repoKey = (url) =>
  String(url || '')
    .trim()
    .toLowerCase()
    .replace(/\.git\/?$/, '')
    .replace(/\/+$/, '')
    .split(/[/:]/)
    .slice(-2)
    .join('/')

/** How long the job index is reused: a repo's page, every chat's read tools and the hourly discovery pass all ask it. */
const JOB_INDEX_TTL_MS = 60 * 1000
let jobIndex = { at: 0, jobs: null }

/**
 * Every job this login can see, and which repos its recent builds checked out: `[{ name,
 * kind, branches, repos }]`, `repos` as `owner/repo` keys read off the git plugin's
 * `remoteUrls` — for a multibranch job, any branch's. One call to Jenkins, reused for a minute.
 * A folder's jobs are listed as `folder/job`; a multibranch job is one entry, since a repo's
 * list naming it covers its branches.
 */
export async function jenkinsJobIndex() {
  if (jobIndex.jobs && Date.now() - jobIndex.at < JOB_INDEX_TTL_MS) return jobIndex.jobs
  const data = await jenkins('/api/json?tree=jobs[name,_class,lastBuild[actions[remoteUrls]],jobs[name,_class,lastBuild[actions[remoteUrls]]]]')
  const urls = (j) => (j?.lastBuild?.actions || []).flatMap((a) => (a?.remoteUrls || []).map(repoKey))
  const out = []
  for (const j of data.jobs || []) {
    const cls = String(j._class || '')
    if (/Folder$/.test(cls)) {
      for (const c of j.jobs || []) out.push({ name: `${j.name}/${c.name}`, kind: 'job', branches: [], repos: [...new Set(urls(c))] })
    } else if (/MultiBranchProject$/.test(cls)) {
      const branches = j.jobs || []
      out.push({ name: j.name, kind: 'multibranch', branches: branches.map((b) => b.name), repos: [...new Set(branches.flatMap(urls))] })
    } else {
      out.push({ name: j.name, kind: 'job', branches: [], repos: [...new Set(urls(j))] })
    }
  }
  jobIndex = { at: Date.now(), jobs: out }
  return out
}

/**
 * The job list for a repo's page: every job, `builds` true where its builds checked out
 * `repoUrl`. That is the suggestion.
 */
export async function listJenkinsJobs(repoUrl = '') {
  const want = repoUrl ? repoKey(repoUrl) : ''
  return (await jenkinsJobIndex()).map(({ repos, ...j }) => ({ ...j, builds: Boolean(want && repos.includes(want)) }))
}

/**
 * Whether `job` — or the multibranch job or folder it sits under — builds the repo at
 * `repoUrl`, by the index. False for a job Jenkins does not list.
 */
export async function jobBuildsRepo(job, repoUrl) {
  const want = repoKey(repoUrl)
  const j = String(job || '').replace(/^\/+|\/+$/g, '')
  const hit = (await jenkinsJobIndex()).find((e) => j === e.name || j.startsWith(`${e.name}/`))
  return Boolean(hit && want && hit.repos.includes(want))
}

export { repoKey }

/**
 * Whether `job` is one a repo's list allows: the job itself, or a branch or job under one it
 * names — `docs-site` allows `docs-site/main`. A folder name allows nothing by being a
 * prefix of a word: `docs` does not allow `docs-site`.
 */
export function jobAllowed(job, list) {
  const j = String(job || '').trim().replace(/^\/+|\/+$/g, '')
  return (list || []).some((n) => j === n || j.startsWith(`${n}/`))
}

export async function testJenkins() {
  try {
    const data = await jenkins('/api/json?tree=jobs[name]')
    return { ok: true, jobs: (data.jobs || []).map((j) => j.name).slice(0, 50) }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

/**
 * A job's last build, or the one asked for: by `number`, or by `commit` — the build that
 * checked that commit out (`buildOfCommit`). `lastBuild` keeps its name whichever it is, so
 * the tool reads one shape.
 */
export async function jenkinsJobStatus(job, { number = 0, commit = '' } = {}) {
  const data = await jenkins(`${jobPath(job)}/api/json?tree=name,color,inQueue,lastBuild[number,result,timestamp,building,url,duration]`)
  let b = data.lastBuild || null
  const wanted = commit ? await buildOfCommit(job, commit) : Number(number) || 0
  if (commit && !wanted) return { job: data.name, color: data.color, inQueue: Boolean(data.inQueue), lastBuild: null, missing: `no build of ${String(commit).slice(0, 7)} among its last thirty` }
  if (wanted && wanted !== b?.number) b = await jenkins(`${jobPath(job)}/${wanted}/api/json?tree=number,result,timestamp,building,url,duration`)
  return {
    job: data.name,
    color: data.color,
    inQueue: Boolean(data.inQueue),
    lastBuild: b ? { number: b.number, result: b.building ? 'BUILDING' : b.result, at: b.timestamp, url: b.url, durationMs: b.duration } : null,
  }
}

/**
 * Whether a job is there for this login, and the parameters it takes: `{ job, buildable,
 * params }`, or null for a job Jenkins answers 404 to — which is also what it says of one the
 * login may not see. For the custom push Test, which starts nothing.
 */
export async function jenkinsJobParameters(job) {
  let data
  try {
    data = await jenkins(`${jobPath(job)}/api/json?tree=name,buildable,property[parameterDefinitions[name]]`)
  } catch (err) {
    if (/^Jenkins 404/.test(err.message)) return null
    throw err
  }
  const params = (data.property || []).flatMap((p) => (p.parameterDefinitions || []).map((d) => d.name)).filter(Boolean)
  return { job: data.name, buildable: data.buildable !== false, params }
}

/**
 * Start a build. An API token is exempt from Jenkins's CSRF crumb, so none is fetched.
 * `queueUrl` is the queue item Jenkins answers with, which becomes the build's number once
 * an executor takes it (`jenkinsQueueItem`) — how Outpost follows a build it started.
 */
export async function jenkinsBuild(job, params = {}) {
  const keys = Object.keys(params || {})
  const pathname = keys.length ? `${jobPath(job)}/buildWithParameters` : `${jobPath(job)}/build`
  const res = await jenkins(pathname, { method: 'POST', form: keys.length ? params : { delay: '0sec' }, raw: true })
  const location = res.headers.get('location') || ''
  return { ok: true, job, queued: true, queueUrl: /\/queue\/item\/\d+/.test(location) ? location.replace(/\/?$/, '/') : '' }
}

/** A queue item: `{ number, cancelled, why }` — `number` once the build has started. */
export async function jenkinsQueueItem(queueUrl) {
  const data = await jenkins(`${queueUrl}api/json?tree=cancelled,why,executable[number]`)
  return { number: data.executable?.number || 0, cancelled: Boolean(data.cancelled), why: data.why || '' }
}

/**
 * A build named by number, or by one of Jenkins's own names for one — `lastBuild`,
 * `lastFailedBuild`, `lastCompletedBuild` — which is what a tool gets when it names none.
 */
const buildRef = (number) => (/^\d+$/.test(String(number || '')) ? String(number) : /^last(Failed|Completed|Successful|Unsuccessful)?Build$/.test(String(number || '')) ? String(number) : 'lastBuild')

/** Jenkins's 404 is also what a login is told of a job or build it may not see. */
const notFound = (err) => /^Jenkins 404/.test(String(err?.message || ''))

/**
 * One build: `{ job, number, result, building, url, failed }` — `result` null while it runs,
 * `failed` the stages its log shows failing (`stagesOfLog`), read only for a build that did
 * not succeed.
 */
export async function jenkinsBuildResult(job, number) {
  const data = await jenkins(`${jobPath(job)}/${buildRef(number)}/api/json?tree=number,result,building,url`)
  let failed = []
  if (!data.building && data.result && data.result !== 'SUCCESS') {
    try {
      failed = stagesOfLog((await consoleOf(job, data.number)).text).failed
    } catch {
      /* no log to read: the result stands alone */
    }
  }
  return { job, number: data.number, result: data.building ? null : data.result || null, building: Boolean(data.building), url: data.url || '', failed }
}

/** How much of a console log is read: a build that printed more keeps its last this-many bytes. */
const LOG_CAP = 8 * 1024 * 1024

/** A build's console as plain text, `{ text, cut }` — `cut` when only its end was kept. */
async function consoleOf(job, number) {
  const res = await jenkins(`${jobPath(job)}/${number}/consoleText`, { raw: true })
  const buf = Buffer.from(await res.arrayBuffer())
  const cut = buf.length > LOG_CAP
  return { text: (cut ? buf.subarray(buf.length - LOG_CAP) : buf).toString('utf8'), cut }
}

/**
 * Which stage each line of a pipeline's console belongs to, and which stages failed, from the
 * log alone. No plugin is needed — the Pipeline Stage View (`wfapi`) and Blue Ocean are not
 * on every Jenkins, and were on neither of this one's ends when this was written — because a
 * pipeline marks its stages in the log: `[Pipeline] { (Build)` opens one, `[Pipeline] }`
 * closes a block, and inside `parallel` each branch's own lines are prefixed `[Branch] `.
 * A stage failed when a line in it says so: `script returned exit code` with a non-zero code,
 * or a line starting `ERROR:`. `{ lines, stageOf, failed }`, the stages in the order they
 * first failed.
 */
export function stagesOfLog(text) {
  const lines = String(text || '').split('\n')
  const stack = []
  const branches = new Set()
  const stageOf = []
  const failed = []
  for (const line of lines) {
    const open = /^\[Pipeline\] \{ \((Branch: )?(.+)\)\s*$/.exec(line)
    if (open) {
      if (open[1]) branches.add(open[2])
      stack.push(open[2])
      stageOf.push(open[2])
      continue
    }
    if (/^\[Pipeline\] \{\s*$/.test(line)) stack.push(null)
    else if (/^\[Pipeline\] \}\s*$/.test(line)) stack.pop()
    const prefix = /^\[([^\]]+)\] /.exec(line)?.[1]
    const stage = prefix && branches.has(prefix) ? prefix : [...stack].reverse().find(Boolean) || ''
    stageOf.push(stage)
    if (stage && /script returned exit code [1-9]|^(?:\[[^\]]+\] )?ERROR: /.test(line) && !failed.includes(stage)) failed.push(stage)
  }
  return { lines, stageOf, failed }
}

/**
 * The `jenkins_build_log` tool's answer: `{ job, number, result, building, url, failed,
 * sections: [{ stage, text, lines, of }], tail, tailLines, cut }`. For each failed stage the
 * last `lines` of what it printed, within `bytes`, and how many it printed (`of`); when the log
 * names no failed stage, its last `lines` instead. Scrubbed the way the
 * search index scrubs prompts (integrations.md, question 4): a build prints its environment
 * more often than anybody means it to. Never indexed, never stored — read, scrubbed, answered.
 */
export async function jenkinsBuildLog(job, number, { lines: keep = 80, bytes = Infinity } = {}) {
  const b = await jenkins(`${jobPath(job)}/${buildRef(number)}/api/json?tree=number,result,building,url`)
  const { text, cut } = await consoleOf(job, b.number)
  const parsed = stagesOfLog(text)
  // Jenkins's own `[Pipeline] …` bookkeeping says nothing a reader wants; what the steps printed
  // does. The end is kept, `keep` lines and at most `bytes` of them. A line over a thousand
  // characters — a minified bundle, a blob — keeps its start and says how much went: whole, one
  // filled the answer and pushed out the error printed after it.
  const clip = (l) => (l.length > 1000 ? `${l.slice(0, 300)}…(${l.length - 300} more characters)` : l)
  const pick = (want) => {
    const all = parsed.lines.filter((l, i) => want(parsed.stageOf[i]) && !/^\[Pipeline\] /.test(l)).map(clip)
    const shown = []
    let size = 0
    for (let i = all.length - 1; i >= 0 && shown.length < keep; i--) {
      const n = Buffer.byteLength(all[i]) + 1
      if (size + n > bytes) {
        if (!shown.length) shown.unshift(`…${Buffer.from(all[i]).subarray(-Math.max(0, bytes - 1)).toString('utf8')}`)
        break
      }
      size += n
      shown.unshift(all[i])
    }
    return { text: scrub(shown.join('\n')), lines: shown.length, of: all.length }
  }
  const sections = parsed.failed.map((stage) => ({ stage, ...pick((s) => s === stage) }))
  const tail = sections.length ? null : pick(() => true)
  return {
    job,
    number: b.number,
    result: b.building ? 'BUILDING' : b.result,
    building: Boolean(b.building),
    url: b.url || '',
    failed: parsed.failed,
    sections,
    tail: tail ? tail.text : '',
    tailLines: tail ? { lines: tail.lines, of: tail.of } : null,
    cut,
  }
}

/**
 * The `jenkins_test_report` tool's answer, or null for a build that published no test report
 * (Jenkins answers 404): `{ failCount, passCount, skipCount, failing: [{ name, status,
 * error, stack }] }`, the first `limit` failing cases, each message and stack cut short and
 * scrubbed.
 */
export async function jenkinsTestReport(job, number, { limit = 30 } = {}) {
  let data
  try {
    data = await jenkins(`${jobPath(job)}/${buildRef(number)}/testReport/api/json?tree=failCount,passCount,skipCount,suites[cases[className,name,status,errorDetails,errorStackTrace]]`)
  } catch (err) {
    if (notFound(err)) return null
    throw err
  }
  const failing = (data.suites || [])
    .flatMap((s) => s.cases || [])
    .filter((c) => c.status === 'FAILED' || c.status === 'REGRESSION')
    .slice(0, limit)
    .map((c) => ({
      name: [c.className, c.name].filter(Boolean).join(' › '),
      status: c.status,
      error: scrub(String(c.errorDetails || '').slice(0, 800)),
      stack: scrub(String(c.errorStackTrace || '').split('\n').slice(0, 12).join('\n')),
    }))
  return { failCount: data.failCount || 0, passCount: data.passCount || 0, skipCount: data.skipCount || 0, failing }
}

/**
 * The `jenkins_job_info` tool's answer: what a job takes and what it has done lately —
 * `{ job, buildable, inQueue, params: [{ name, type, description, default, choices }],
 * builds: [{ number, result, at, durationMs }], branches }`. `branches` for a multibranch
 * job, whose builds live under `job/<branch>`.
 */
export async function jenkinsJobInfo(job) {
  const data = await jenkins(
    `${jobPath(job)}/api/json?tree=name,buildable,inQueue,property[parameterDefinitions[name,type,description,defaultParameterValue[value],choices]],builds[number,result,timestamp,duration,building]{0,10},jobs[name]`
  )
  const params = (data.property || []).flatMap((p) => p.parameterDefinitions || []).map((d) => ({
    name: d.name,
    type: String(d.type || '').replace(/ParameterDefinition$/, ''),
    description: String(d.description || '').slice(0, 300),
    default: d.defaultParameterValue?.value ?? '',
    choices: Array.isArray(d.choices) ? d.choices : [],
  }))
  const builds = (data.builds || []).map((b) => ({ number: b.number, result: b.building ? 'BUILDING' : b.result, at: b.timestamp, durationMs: b.duration }))
  return { job: data.name, buildable: data.buildable !== false, inQueue: Boolean(data.inQueue), params, builds, branches: (data.jobs || []).map((j) => j.name) }
}

/**
 * A build of `commit`, newest first, among a job's last thirty: the git plugin records what
 * each build checked out (`lastBuiltRevision`). A prefix of seven or more matches.
 */
async function buildOfCommit(job, commit) {
  const sha = String(commit || '').trim().toLowerCase()
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error('A commit is seven to forty hex characters')
  const data = await jenkins(`${jobPath(job)}/api/json?tree=builds[number,actions[lastBuiltRevision[SHA1]]]{0,30}`)
  const hit = (data.builds || []).find((b) => (b.actions || []).some((a) => String(a?.lastBuiltRevision?.SHA1 || '').startsWith(sha)))
  return hit ? hit.number : 0
}

/**
 * The poller's lookup for a pushed commit: the number of a build of it among the job's last
 * thirty, or 0 — also for a job or branch Jenkins does not have (yet), which is what a
 * multibranch job says of a branch it has not indexed.
 */
export async function jenkinsBuildOfCommit(job, commit) {
  try {
    return await buildOfCommit(job, commit)
  } catch (err) {
    if (notFound(err)) return 0
    throw err
  }
}

/** Stop a running build. A build already finished is left as it is; Jenkins says nothing either way. */
export async function jenkinsAbort(job, number) {
  if (!/^\d+$/.test(String(number || ''))) throw new Error('Name the build to stop by its number')
  await jenkins(`${jobPath(job)}/${number}/stop`, { method: 'POST', raw: true })
  return jenkinsBuildResult(job, number)
}
