/**
 * The workspace panel: what a chat has checked out, on which branch, how far it has got, and
 * the things you can do about it — push a branch, read the preparation log, delete the lot.
 *
 * The top section of the details column on a wide screen, a sheet over the chat on a phone.
 * It draws from the roster's `workspaces` and nothing else, so it is right whenever the list is.
 */
import { fetchTokens, fetchWorkspaceLog, fetchWorkspacePorts, pinWorkspace } from '../api.js'

/** Builds shown before Show more: the latest few are what anybody looks at. */
const BUILDS_FOLDED = 3

/**
 * How often a working chat's token figures are asked again. The server reads the whole
 * transcript when it has moved; once a minute is plenty for a number nobody watches tick.
 */
const TOKENS_EVERY_MS = 60_000

/** How often the panel asks which published ports are listening: a host-side connect, kept gentle. */
const PORTS_EVERY_MS = 10_000

/** 1234 → "1.2k", 1234567 → "1.2M": a count read at a glance, not to the unit. */
function count(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`
  return String(n || 0)
}

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function ago(ts) {
  if (!ts) return ''
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m old`
  if (s < 86400) return `${Math.floor(s / 3600)}h old`
  return `${Math.floor(s / 86400)}d old`
}

/** "5m", "3h", "2d": how long ago, short enough for a pill. */
function since(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/**
 * One line of the column: a status dot (`ok` green, `warn` orange, `bad` red, `off` grey,
 * `busy` the accent), a short label in a fixed column, then the value, so Build, Port and Ages
 * read down one edge. `value` is markup the caller has escaped.
 */
const line = (tone, label, value, cls = '') =>
  `<div class="line${cls ? ` ${cls}` : ''}" data-tone="${tone}"><span class="dot"></span><span class="key">${label}</span><span class="val">${value}</span></div>`

/** A status pill on a checkout's card: green when settled, orange when work is not safe yet. */
const pill = (tone, text) => `<span class="pill" data-tone="${tone}">${text}</span>`

export class WorkspacePanel {
  /** `onPush(id, repo)`, `onFinish(id, repo, mode)`, `onDelete(id, force)`, `onRetry(id)`, `onRoutine(ws)`. */
  constructor(el, { onPush, onFinish, onDelete, onRetry, onToast, onRoutine }) {
    this.el = el
    this.onRoutine = onRoutine || (() => {})
    this.onRetry = onRetry || (() => {})
    this.onFinish = onFinish || (() => {})
    this.onPush = onPush
    this.onDelete = onDelete
    this.onToast = onToast
    this.ws = null
    this.thread = null
    this.logOpen = false
    this.log = ''
    this.armed = false
    this.refusal = ''
    this.tokens = null
    this.tokensFor = ''
    this.tokensAt = 0
    // Which of this chat's published ports have something listening, and when it was last asked.
    this.portStatus = {}
    /** The server's LAN address, for port links when the page came through a name. */
    this.portAddress = ''
    this.portsAt = 0
    this.el.innerHTML = `<div class="body"></div>`
    this.el.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]')
      if (!b) return
      const act = b.dataset.act
      if (act === 'push') this.push(b.dataset.repo)
      else if (act === 'finish') this.finish(b.dataset.repo, b.dataset.mode)
      else if (act === 'log') this.toggleLog()
      else if (act === 'retry') this.retry()
      else if (act === 'delete') this.remove(false)
      else if (act === 'force') this.remove(true)
      else if (act === 'routine') this.onRoutine(this.ws)
      else if (act === 'pin') this.pin(!this.ws?.pinned)
      else if (act === 'builds') {
        this.allBuilds = !this.allBuilds
        this.paint()
      }
    })
  }

  /** The workspace to draw, and the thread it carries if one has appeared. */
  set(ws, thread) {
    const changed = ws?.id !== this.ws?.id
    this.ws = ws
    this.thread = thread
    if (changed) {
      this.armed = false
      this.allBuilds = false
      this.refusal = ''
      this.logOpen = ws ? ws.status !== 'ready' : false
      this.log = ''
      if (this.logOpen) this.loadLog()
    }
    // While it is preparing the log is the thing to watch; keep it fresh on every roster.
    if (this.logOpen && ws && ws.status === 'preparing') this.loadLog()
    const tid = thread?.id || ''
    if (tid !== this.tokensFor) {
      this.tokensFor = tid
      this.tokens = null
      this.tokensAt = 0
    }
    if (tid && Date.now() - this.tokensAt > TOKENS_EVERY_MS) this.loadTokens()
    if (changed) {
      this.portStatus = {}
      this.portsAt = 0
    }
    // A listening check is a host-side connect, so it is asked no faster than the roster refreshes
    // this panel, and only while the chat has ports.
    if (ws?.status === 'ready' && (ws.container?.ports || []).length && Date.now() - this.portsAt > PORTS_EVERY_MS) this.loadPorts()
    this.paint()
  }

  /** Pin or unpin this chat; drawn at once, and the next roster confirms it. */
  async pin(pinned) {
    const ws = this.ws
    if (!ws) return
    try {
      const res = await pinWorkspace(ws.id, pinned)
      if (!res.ok) throw new Error(res.error || 'Could not change the pin')
      if (this.ws?.id === ws.id) {
        this.ws = { ...this.ws, pinned: res.pinned }
        this.paint()
      }
      this.onToast(res.pinned ? 'Pinned — not archived or deleted until you unpin it' : 'Unpinned')
    } catch (err) {
      this.onToast(err.message || 'Could not change the pin', 'err')
    }
  }

  /** Which published ports have something listening (dimmed until they do), on a gentle throttle. */
  async loadPorts() {
    const id = this.ws?.id
    if (!id) return
    this.portsAt = Date.now()
    try {
      const res = await fetchWorkspacePorts(id)
      if (this.ws?.id !== id) return
      this.portStatus = Object.fromEntries((res.ports || []).map((p) => [p.host, p.listening]))
      this.portAddress = res.address || ''
      this.paint()
    } catch {
      /* the panel shows what it had */
    }
  }

  /**
   * The Ports section: one line per declared port, `label  internal → host:port` as a plain-http
   * link, dimmed until something is listening. The host is the page's own when it was loaded by IP
   * or as localhost (a tunnel keeps working); under a name, which is a proxy in front of Outpost
   * that does not carry the chat's ports, it is the server's LAN address. Grouped under the repo
   * name only when more than one of the chat's repos has ports. Absent when the chat has none.
   */
  portsSection(parts) {
    const ports = this.ws?.container?.ports || []
    if (!ports.length) return
    const repos = new Set(ports.map((p) => p.repo))
    const group = repos.size > 1
    const byAddress = /^(\d+\.){3}\d+$|^\[|^localhost$/.test(location.hostname)
    const host = byAddress || !this.portAddress ? location.hostname : this.portAddress
    let lastRepo = ''
    for (const p of ports) {
      if (group && p.repo !== lastRepo) {
        parts.push(`<div class="why port-repo">${escape(p.repoName || p.repo)}</div>`)
        lastRepo = p.repo
      }
      if (p.clash) {
        const why = p.reserved ? "is Outpost's own and is never published — give it" : "clashes with another repo's — give one"
        parts.push(line('warn', 'Port', `<span class="why">${escape(p.label)} · port ${p.internal} ${why} a different port in Settings › Repos</span>`, 'port'))
        continue
      }
      const live = this.portStatus[p.host]
      const href = `http://${host}:${p.host}`
      parts.push(
        line(
          live ? 'ok' : 'off',
          'Port',
          `<b>${escape(p.label)}</b> <span class="why mono">${p.internal} → <a href="${escape(href)}" target="_blank" rel="noopener">${escape(host)}:${p.host}</a></span> ` +
            `<span class="why">${live ? 'listening' : 'nothing yet'}</span>`,
          `port${live ? '' : ' idle'}`
        )
      )
    }
  }

  /** The thread's token figures (usage.md), drawn as two lines under Session. */
  async loadTokens() {
    const thread = this.thread
    if (!thread) return
    this.tokensAt = Date.now()
    try {
      const res = await fetchTokens(thread)
      if (this.tokensFor !== thread.id) return
      this.tokens = res?.ok ? res : null
      this.paint()
    } catch {
      /* the panel shows what it had */
    }
  }

  async loadLog() {
    if (!this.ws) return
    const id = this.ws.id
    try {
      const res = await fetchWorkspaceLog(id)
      if (this.ws?.id !== id) return
      this.log = res.log || ''
      this.paint()
    } catch {
      /* the panel shows what it had */
    }
  }

  toggleLog() {
    this.logOpen = !this.logOpen
    if (this.logOpen) this.loadLog()
    this.paint()
  }

  async push(repoId) {
    if (!this.ws) return
    for (const b of this.el.querySelectorAll('button[data-act=push]')) b.disabled = true
    try {
      await this.onPush(this.ws.id, repoId)
    } finally {
      this.paint()
    }
  }

  /** Two presses, like delete: the first says what will land where, the second does it. */
  async finish(repoId, mode) {
    if (!this.ws) return
    const key = `${repoId}:${mode}`
    if (this.armedFinish !== key) {
      this.armedFinish = key
      this.paint()
      setTimeout(() => {
        if (this.armedFinish === key) {
          this.armedFinish = ''
          this.paint()
        }
      }, 8000)
      return
    }
    this.armedFinish = ''
    for (const b of this.el.querySelectorAll('button[data-act=finish]')) b.disabled = true
    try {
      await this.onFinish(this.ws.id, repoId, mode)
    } finally {
      this.paint()
    }
  }

  async retry() {
    if (!this.ws) return
    const res = await this.onRetry(this.ws.id)
    if (res?.ok) {
      this.logOpen = true
      this.loadLog()
    }
  }

  async remove(force) {
    if (!this.ws) return
    if (!force && !this.armed) {
      this.armed = true
      this.paint()
      setTimeout(() => {
        this.armed = false
        this.paint()
      }, 6000)
      return
    }
    this.armed = false
    const res = await this.onDelete(this.ws.id, force)
    this.refusal = res?.refused ? res.error : ''
    this.paint()
  }

  /**
   * Two lines: what the chat spent — requests, then reads, writes and output, which is the order
   * they usually come in by size — and what the harness cost it. Exact figures in the hover.
   */
  tokensRows() {
    const t = this.tokens
    if (!t || !t.total?.turns) return ''
    // A chat started fresh from a handoff (handoff.md) is drawn for its whole life: `lifetime`
    // sums every conversation it has had; this one's alone is in the hover.
    const life = t.lifetime || null
    const s = life ? life.total : t.total
    const one = (x, subs) => `${x.turns} requests (${subs || 0} by subagents) · fresh input ${x.input} · cache read ${x.cacheRead} · cache written ${x.cacheWrite} · output ${x.output}`
    const exact = life
      ? `Across ${life.conversations} conversations: ${one(s, life.subagents?.turns)}\n\nThis conversation: ${one(t.total, t.subagents?.turns)}`
      : `${one(s, t.subagents?.turns)}${t.cli ? ` · $${t.cli.costUSD.toFixed(2)} at API prices, by the CLI's own count` : ''}`
    const w = t.waste
    const r = w.restarts
    // The counts for the line: the chat's whole life where there is one, else this conversation.
    const n = life ? { refusals: life.waste.refusals, restarts: life.waste.restarts, cold: life.waste.cold } : { refusals: w.refusals, restarts: r.total, cold: w.cold }
    const bits = []
    if (n.refusals) bits.push(`${n.refusals} refused chain${n.refusals === 1 ? '' : 's'}`)
    if (n.restarts) bits.push(`${n.restarts} restart${n.restarts === 1 ? '' : 's'}`)
    if (n.cold.turns) bits.push(`${n.cold.turns} cold (${count(n.cold.tokens)} rewritten)`)
    const why = `${life ? 'This conversation — ' : ''}Refused Bash chains ${w.refusals} · restarts in place ${r.total} (effort ${r.effort}, repo added ${r.addRepo}, resume ${r.resume ?? 'unknown'}) · requests that began with a cold cache ${w.cold.turns}: ${w.cold.expired} after an idle hour, ${w.cold.modelSwitch ?? 0} on a model switch, ${w.cold.invalidated} otherwise (a restart, most often) · retries sent ${w.retries} · notes sent ${w.notes} · handoffs asked for ${w.handoffs ?? 0} · fixed per session ≈${t.overhead?.tokens ?? '?'} tokens`
    return (
      `<span class="k">Tokens</span><span class="v" title="${escape(exact)}">${count(s.turns)} req · ${count(s.cacheRead)} read · ${count(s.cacheWrite)} written · ${count(s.output)} out${life ? ` · ${life.conversations} conversations` : ''}</span>` +
      `<span class="k">Harness cost</span><span class="v" title="${escape(why)}">${bits.length ? bits.join(' · ') : 'none seen'}</span>`
    )
  }

  paint() {
    const body = this.el.querySelector('.body')
    const ws = this.ws
    // Every chat has a workspace now and the tab is not offered without one (chats.md); this
    // only covers a paint between a workspace going and the selection catching up.
    if (!ws) return
    const parts = [`<div class="name"><b>${escape(ws.name)}</b><span class="mono">${escape(ws.id)}</span></div>`]
    if (ws.status === 'preparing') {
      parts.push(`<div class="state preparing"><span class="spin"></span>${escape(ws.step || 'Preparing…')}</div>`)
    } else if (ws.status === 'failed') {
      parts.push(
        `<div class="state failed"><span class="grow">Preparation failed: ${escape(ws.error || 'unknown error')}</span>` +
          `<button class="btn sm" data-act="retry" title="Run the preparation again, with the repo's settings as they are now">Try again</button></div>`
      )
    } else if (ws.startFailure) {
      // Prepared, but the container never ran the CLI — podman's reason is what to act on,
      // most often a Settings › Containers switch this machine cannot honour (launchers.md).
      parts.push(
        `<div class="state failed"><span class="grow">The session didn't start${ws.startFailure.log ? '' : ' and left no error'}</span>` +
          `<button class="btn sm" data-act="retry" title="${ws.startFailure.resumed ? 'Restart it, the conversation resumed, with the settings as they are now' : 'Prepare and start it again, with the settings as they are now'}">Try again</button></div>` +
          (ws.startFailure.log ? `<pre class="log">${escape(ws.startFailure.log)}</pre>` : '')
      )
    }
    if (ws.repos.length) {
      for (const r of ws.repos) {
        const g = r.git
        // The card's pills: green where the work is settled, orange where it is not safe yet
        // (uncommitted, unpushed, a missing checkout), plain for the counts in between.
        const pills = []
        if (g) {
          if (!g.exists) pills.push(pill('warn', 'checkout missing'))
          else {
            pills.push(g.clean ? pill('ok', 'clean') : pill('warn', `${g.changed} uncommitted`))
            if (g.ahead) pills.push(pill('', `${g.ahead} ahead of ${escape(r.base)}`))
            if (g.behind) pills.push(pill('', `${g.behind} behind`))
            pills.push(g.pushed ? (g.remoteBranch ? pill('ok', 'pushed') : pill('', 'nothing to push')) : pill('warn', 'not pushed'))
          }
        }
        if (r.landedAt) pills.push(pill('ok', `landed on ${escape(r.base)} · ${since(r.landedAt)}`))
        parts.push(
          `<div class="checkout">` +
            `<b class="repo">${escape(r.name)}</b>` +
            // A checkout with no branch is at the base's latest, waiting for work to start
            // (workspaces-git.md); "…" read as still loading.
            `<div class="row wrap"><span class="chip mono">${escape(r.branch || `${r.base || 'main'} · no work yet`)}</span>` +
            `<span class="why">from <span class="mono">${escape(r.base || '?')}</span></span></div>` +
            (pills.length ? `<div class="pills">${pills.join('')}</div>` : '') +
            (r.work ? `<div class="why">${escape(r.work)}</div>` : '') +
            (r.data || [])
              .map(
                (d) =>
                  `<div class="why">${escape(d.kind)} from ${escape(d.env || 'here')} → <span class="mono">${escape(d.to)}</span>${
                    d.bytes ? ` · ${(d.bytes / 1048576).toFixed(d.bytes > 10485760 ? 0 : 1)} MB` : ''
                  } · ${escape(ago(d.at))}</div>`
              )
              .join('') +
            (r.oneOff ? `<div class="why">Added to be read — not in Settings › Repos, so it is not pushed</div>` : '') +
            (r.branch && !r.oneOff && g && g.exists && (g.ahead || !g.pushed) && g.clean
              ? `<div class="row wrap">` +
                (!g.pushed ? `<button class="btn sm" data-act="push" data-repo="${escape(r.id)}">Push branch</button>` : '') +
                ['push', 'pr']
                  .sort((a) => (a === (r.finish || 'push') ? -1 : 1))
                  .map((mode) => {
                    const armed = this.armedFinish === `${r.id}:${mode}`
                    const label = mode === 'push' ? `Merge ${escape(r.base)} in and push to it` : 'Open a pull request'
                    const armedLabel = mode === 'push' ? `Push ${escape(r.branch)} to ${escape(r.base)}?` : `Open the PR?`
                    return `<button class="btn sm${mode === (r.finish || 'push') ? '' : ' ghost'}${armed ? ' danger' : ''}" data-act="finish" data-repo="${escape(r.id)}" data-mode="${mode}">${armed ? armedLabel : label}</button>`
                  })
                  .join('') +
                `</div>`
              : '') +
            (r.pr ? `<div class="why">PR <a href="${escape(r.pr.url)}" target="_blank" rel="noopener">#${r.pr.number}</a></div>` : '') +
            `</div>`
        )
      }
    } else {
      parts.push(`<div class="why">No code in this chat. It runs in an empty folder of its own.</div>`)
    }
    // Its Jenkins builds (integrations-ci.md): the ones it started and the ones its pushes
    // triggered, as Outpost has heard of them — newest first, the latest three, the rest
    // behind Show more so a busy chat's section does not grow down the column (the owner's).
    if (ws.builds?.length) {
      const shown = this.allBuilds ? ws.builds : ws.builds.slice(0, BUILDS_FOLDED)
      for (const b of shown) {
        // A build still going is orange: the work is not known safe until it is green.
        const tone = { SUCCESS: 'ok', FAILURE: 'bad', UNSTABLE: 'bad', ABORTED: 'off' }[b.result] || 'warn'
        const what = b.job ? `${escape(b.job)}${b.number ? ` #${b.number}` : ''}` : `a build of <span class="mono">${escape(b.commit.slice(0, 7))}</span>`
        const word = { QUEUED: 'queued', RUNNING: 'running', WAITING: 'waiting for a build' }[b.result] || escape(b.result.toLowerCase())
        const link = b.url ? `<a href="${escape(b.url)}" target="_blank" rel="noopener">${what}</a>` : what
        parts.push(
          line(
            tone,
            'Build',
            `<span class="head">${link}<span class="why">${word} · ${b.why === 'started' ? 'started here' : 'from a push'} · ${escape(ago(b.at))}</span></span>` +
              (b.subject ? `<span class="subject" title="${escape(b.subject)}">${b.commit ? `<span class="mono">${escape(b.commit.slice(0, 7))}</span> ` : ''}${escape(b.subject)}</span>` : ''),
            'build'
          )
        )
      }
      if (ws.builds.length > BUILDS_FOLDED) {
        parts.push(`<button class="btn sm ghost more" data-act="builds">${this.allBuilds ? 'Show less' : `Show ${ws.builds.length - BUILDS_FOLDED} more`}</button>`)
      }
    }
    this.portsSection(parts)
    if (ws.aging) {
      const a = ws.aging
      const said = ws.pinned
        ? 'Pinned — never archived or deleted by aging. Its session is still ended when quiet; a message resumes it.'
        : a.kept
        ? `Kept: ${escape(a.kept)} Push the branch, or delete it yourself.`
        : a.unseen && !a.aged
        ? 'Not archived while it has something you have not seen. The clock starts when you read it.'
        : a.aged
          ? 'Aged out — its session was ended. The workspace goes when it is clean and pushed.'
          : a.archiveAt
            ? `Idle ${a.idleDays}d · ages out ${escape(new Date(a.archiveAt).toLocaleDateString([], { day: 'numeric', month: 'short' }))}`
            : 'Aging is off.'
      // Kept is the one state that wants something of you; pinned is safe for good.
      const tone = ws.pinned ? 'ok' : a.kept ? 'warn' : 'off'
      parts.push(
        line(tone, 'Ages', `<span class="why">${said}</span>`, 'ages') +
          `<div class="row wrap"><button class="btn sm ghost" data-act="pin" title="A pinned chat is never archived or deleted by aging">${ws.pinned ? 'Unpin' : 'Pin this chat'}</button></div>`
      )
    }
    parts.push(`<div class="label">Session</div>`)
    // Two columns, the key in a fixed 90 px: keys hard left and values hard right left the
    // column's width of air between them.
    parts.push(
      `<div class="kvgrid">` +
        `<span class="k">Model</span><span class="v">${escape(ws.model || 'default')}</span>` +
        // In a container — every new chat; one started before that, on this machine, says so.
        `<span class="k">Runs in</span><span class="v" title="${escape(ws.container?.image || '')}">${ws.container?.image ? 'a container of its own' : 'this machine'}` +
        (ws.container?.why ? `<span class="why ws-runs">${escape(ws.container.why)}</span>` : '') +
        `</span>` +
        `<span class="k" title="Without asking, it may">May</span><span class="v">${escape({ acceptEdits: 'edit its own files', default: 'nothing', plan: 'plan only', dontAsk: 'nothing, and it never asks' }[ws.permissionMode] || 'edit its own files')}</span>` +
        (ws.tools?.length ? `<span class="k">Tools</span><span class="v chips">${ws.tools.map((t) => `<span class="chip mono">${escape(t)}</span>`).join('')}</span>` : '') +
        (ws.prompt
          ? `<span class="k">First prompt</span><span class="v">${ws.promptSentAt ? 'sent' : ws.promptError ? escape(ws.promptError) : 'pending'}</span>`
          : '') +
        this.tokensRows() +
        `</div>`
    )
    parts.push(`<div class="row wrap actions">`)
    // Preparation's log only where preparation failed — then there is no chat, and no setup
    // pill, to say why (the owner's: setup and its logs are the pill's, not this section's).
    if (ws.status === 'failed') parts.push(`<button class="btn sm ghost" data-act="log">${this.logOpen ? 'Hide the preparation log' : 'Preparation log'}</button>`)
    if (ws.prompt || ws.repos.length) parts.push(`<button class="btn sm ghost" data-act="routine" title="Opens New chat asking for a routine from this chat's prompt and checkouts; that chat asks you to approve it">Make a routine of this…</button>`)
    parts.push(
      this.armed
        ? `<button class="btn sm danger" data-act="delete">Delete it?</button>`
        : `<button class="btn sm ghost" data-act="delete">Delete workspace</button>`
    )
    parts.push(`</div>`)
    if (this.refusal) {
      parts.push(
        `<div class="state failed">${escape(this.refusal)}</div><div class="row"><button class="btn sm danger" data-act="force">Delete anyway</button></div>`
      )
    }
    if (this.logOpen && ws.status !== 'ready') parts.push(`<pre class="log">${escape(this.log || '(nothing yet)')}</pre>`)
    body.innerHTML = parts.join('')
  }
}
