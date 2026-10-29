/**
 * The plan's limits: every bar, always open, at the foot of the sidebar.
 *
 * It holds its place with a spinner until the first answer, so the sidebar does not jump when
 * the bars arrive. If that answer carries no limits (usage.md) it is hidden again, so a machine
 * with no Claude login does not keep a panel that can only apologise.
 */
import { ICON } from './shell.js'

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** How full a bar reads: nothing to think about, worth knowing, about to stop you. */
function severity(percent) {
  if (percent === null || percent === undefined) return ''
  if (percent >= 85) return 'hot'
  if (percent >= 60) return 'warn'
  return 'ok'
}

/** When a limit comes back: the clock time you plan around, and whether it is soon. */
function resetsIn(iso) {
  if (!iso) return ''
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  const mins = Math.max(0, Math.round((at - Date.now()) / 60000))
  const when =
    at - Date.now() < 20 * 3600_000
      ? new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : new Date(at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const left = d ? `${d}d ${h}h ${mins % 60}m` : h ? `${h}h ${mins % 60}m` : `${mins % 60}m`
  return `Resets ${when} · in ${left}`
}

function ago(ts) {
  if (!ts) return 'never'
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export class Usage {
  constructor(el) {
    this.el = el
    this.last = ''
    this.el.classList.add('loading')
    // Placeholders in the real markup, hidden under the spinner, so the loading panel is the
    // loaded one's height without a hand-measured min-height to drift. Three is what a plan has.
    const placeholder =
      '<div class="u-row"><div class="u-top"><span class="u-label">&nbsp;</span></div>' +
      '<div class="u-bar"></div><div class="u-reset">&nbsp;</div></div>'
    // On a phone the card is a footer's worth of a short screen, so it folds to one line like
    // the machine's (ui.md); the line opens it. Drawn always and shown by the stylesheet only.
    this.el.innerHTML = `
      <button class="u-line" aria-expanded="false" aria-label="Plan limits"><span class="u-name">Claude</span></button>
      <div class="panel">
        <div class="head"><span class="u-plan">&nbsp;</span><span class="u-fresh"></span></div>
        <div class="rows">${placeholder.repeat(3)}</div>
        <div class="u-loading" role="status" aria-label="Loading usage"><span class="spin"></span></div>
      </div>`
    this.line = this.el.querySelector('.u-line')
    this.line.addEventListener('click', () => {
      const open = this.el.classList.toggle('open')
      this.line.setAttribute('aria-expanded', String(open))
    })
  }

  show() {
    this.el.hidden = false
  }

  /** No answer yet, and why the last ask failed: on the spinner, for a hover. */
  waiting(why) {
    this.el.querySelector('.u-loading').title = why ? `Not loaded yet: ${why}` : ''
  }

  /** The server had nothing to report: give the space back. */
  hide() {
    this.el.hidden = true
  }

  set(usage) {
    // The minute is part of the signature because "checked 4m ago" and "in 2h 14m" are: the
    // server serves the same payload for a minute, and without this the panel would keep
    // whatever countdown it was first drawn with.
    const signature = `${JSON.stringify(usage ?? null)}~${Math.floor(Date.now() / 60000)}`
    if (this.last === signature) return
    this.last = signature

    this.el.classList.remove('loading')

    const rows = []
    for (const limit of usage?.limits ?? []) {
      rows.push(
        `<div class="u-row ${severity(limit.percent)}${limit.active ? ' active' : ''}">` +
          `<div class="u-top"><span class="u-label">${escape(limit.label)}</span><span class="u-pct">${limit.percent}%</span></div>` +
          `<div class="u-bar"><i style="width:${limit.percent}%"></i></div>` +
          `<div class="u-reset">${escape(resetsIn(limit.resetsAt))}</div></div>`
      )
    }
    if (usage?.credits) {
      rows.push(
        `<div class="u-row ${severity(usage.credits.percent)}">` +
          `<div class="u-top"><span class="u-label">Extra usage credits</span><span class="u-pct">${usage.credits.percent}%</span></div>` +
          `<div class="u-bar"><i style="width:${usage.credits.percent}%"></i></div>` +
          (usage.credits.usedLabel ? `<div class="u-reset">${escape(usage.credits.usedLabel)} spent</div>` : '') +
          `</div>`
      )
    }
    this.el.querySelector('.rows').innerHTML = rows.length
      ? rows.join('')
      : `<div class="u-empty">${escape(usage?.error || 'No usage limits to report.')}</div>`

    // The folded line: the session and the fullest other limit, which is the one that stops you.
    const [first, ...rest] = usage?.limits ?? []
    const fullest = rest.reduce((a, b) => (!a || b.percent > a.percent ? b : a), null)
    const items = [first, fullest].filter(Boolean)
    this.line.innerHTML =
      `<span class="u-name">Claude</span>` +
      (items.length
        ? items
            .map(
              (l) =>
                `<span class="sys-i ${severity(l.percent)}"><span class="sys-l">${escape(l.label.replace(/^Current /, '').replace(/^./, (c) => c.toUpperCase()))}</span>` +
                `<span class="sys-bar"><i style="width:${l.percent}%"></i></span><span class="sys-p">${l.percent}%</span></span>`
            )
            .join('')
        : `<span class="sys-i">${escape(usage?.error ? 'Not loaded' : 'No limits')}</span>`) +
      `<span class="u-chev">${ICON.forward}</span>`

    // "Max" alone read as a label nobody could place; the heading names the product and the plan.
    const plan = usage?.plan ? `${usage.plan[0].toUpperCase()}${usage.plan.slice(1)} plan` : 'plan'
    this.el.querySelector('.u-plan').textContent = `Claude ${plan}`
    this.el.querySelector('.u-fresh').textContent = usage?.stale
      ? `last known, ${ago(usage.fetchedAt)}`
      : `checked ${ago(usage?.fetchedAt)}`
  }
}
