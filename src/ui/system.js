/**
 * The machine's CPU, memory and disk, as one line beside the Archived link (ui.md). Small on
 * purpose: it is a glance at whether the box is struggling, not a monitor. The arrow at its end
 * opens `SystemDetail`, a window with each core, memory and each disk — enough
 * to skip opening a terminal for htop, not a monitor either.
 */
import { fetchSystemDetail } from '../api.js'
import { ICON } from './shell.js'

/** Same thresholds as the plan bars (usage.js), so one colour means one thing in the sidebar. */
function severity(percent) {
  if (percent >= 85) return 'hot'
  if (percent >= 60) return 'warn'
  return 'ok'
}

function gb(bytes) {
  const g = bytes / 1024 ** 3
  return g >= 100 ? `${Math.round(g)} GB` : `${g.toFixed(1)} GB`
}

export class SystemLine {
  constructor(el, { onMore } = {}) {
    this.el = el
    this.last = ''
    el.addEventListener('click', (e) => {
      if (e.target.closest('.sys-more')) onMore?.()
    })
  }

  set(sys) {
    const items = [
      sys?.cpu && { label: 'CPU', ...sys.cpu, title: `CPU ${sys.cpu.percent}% across ${sys.cpu.cores} cores` },
      sys?.memory && { label: 'MEM', ...sys.memory, title: `Memory ${gb(sys.memory.used)} of ${gb(sys.memory.total)}` },
      sys?.disk && { label: 'Disk', ...sys.disk, title: `Workspace disk ${gb(sys.disk.used)} of ${gb(sys.disk.total)}` },
    ].filter(Boolean)
    const html = items
      .map(
        (i) =>
          `<span class="sys-i ${severity(i.percent)}" title="${i.title}">` +
          `<span class="sys-l">${i.label}</span><span class="sys-bar"><i style="width:${i.percent}%"></i></span>` +
          `<span class="sys-p">${i.percent}%</span></span>`
      )
      .join('') + `<button class="sys-more" aria-label="Machine details" title="Machine details">${ICON.forward}</button>`
    if (html === this.last) return
    this.last = html
    this.el.innerHTML = html
    this.el.hidden = !items.length
  }
}

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function size(bytes) {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)} TB`
  if (bytes >= 1024 ** 3) return gb(bytes)
  return `${Math.round(bytes / 1024 ** 2)} MB`
}

function uptime(s) {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  return d ? `${d}d ${h}h` : `${h}h ${Math.floor((s % 3600) / 60)}m`
}

const pct = (used, total) => (total ? Math.round((100 * used) / total) : 0)

/** A disk's used share as text: a terabyte volume with a few hundred MB on it is "<1%", not an empty "0%". */
function pctText(used, total) {
  const p = total ? (100 * used) / total : 0
  return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`
}

/** A number and its unit, split so the unit can be drawn smaller: "106 GB" → ["106", "GB"]. */
function split(text) {
  const i = text.lastIndexOf(' ')
  return [text.slice(0, i), text.slice(i + 1)]
}

/** The last fifteen minutes as a line, scaled to `max`. Nothing until there are two samples. */
function spark(values, max) {
  if (values.length < 2 || !(max > 0)) return '<div class="sd-spark"></div>'
  const step = 100 / (values.length - 1)
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(23 - (22 * Math.min(v, max)) / max).toFixed(1)}`).join(' ')
  return (
    `<svg class="sd-spark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">` +
    `<polyline points="${points}" vector-effect="non-scaling-stroke"/></svg>`
  )
}

function tile(sev, label, note, value, foot) {
  return (
    `<div class="sd-tile ${sev}"><div class="sd-k"><span>${label}</span><span>${note}</span></div>` +
    `<div class="sd-v">${value}</div>${foot}</div>`
  )
}

/** The 15-, 5- and 1-minute loads read oldest first, and which way they are heading. */
function trend([l1, l5, l15]) {
  const word = l1 > l15 * 1.1 + 0.05 ? 'rising' : l1 < l15 * 0.9 - 0.05 ? 'falling' : 'steady'
  return `${l15.toFixed(2)} → ${l5.toFixed(2)} → ${l1.toFixed(2)}, ${word}`
}

/**
 * The one thing worth knowing, or nothing. First match wins: a full disk or memory breaks
 * things outright; a load the CPU is not explaining is the one the bars alone hide.
 */
function verdict(d, loadPct, memPct, tightest) {
  if (tightest && severity(tightest.pct) === 'hot') return ['hot', `${tightest.mount} nearly full`]
  if (severity(memPct) === 'hot') return ['hot', 'Memory nearly full']
  if (loadPct >= 60 && d.cpu.percent < 40) {
    return [severity(loadPct), `Load high, CPU idle — likely IO wait${d.cpu.iowait >= 5 ? ` (${d.cpu.iowait}%)` : ''}`]
  }
  if (severity(d.cpu.percent) !== 'ok') return [severity(d.cpu.percent), 'CPU busy']
  if (severity(loadPct) !== 'ok') return [severity(loadPct), 'Load high']
  return null
}

/** Polled only while open and the tab is visible. */
const DETAIL_POLL_MS = 2500

export class SystemDetail {
  constructor(root) {
    this.open = false
    this.timer = null
    this.el = document.createElement('div')
    this.el.className = 'modal sysdetail'
    this.el.hidden = true
    this.el.innerHTML = `
      <div class="sheet" role="dialog" aria-labelledby="sysdetail-title">
        <header class="row between">
          <div><h2 id="sysdetail-title">This machine</h2><div class="sub"></div></div>
          <div class="row sd-head"><span class="sd-pill" hidden></span>
          <button class="btn icon" data-act="close" aria-label="Close">${ICON.close}</button></div>
        </header>
        <div class="body"><div class="nothing">Reading…</div></div>
      </div>`
    root.appendChild(this.el)
    this.body = this.el.querySelector('.body')
    this.sub = this.el.querySelector('.sub')
    this.pill = this.el.querySelector('.sd-pill')
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el || e.target.closest('[data-act=close]')) this.hide()
    })
    document.addEventListener('keydown', (e) => {
      if (!this.open || e.key !== 'Escape') return
      // The page's own Esc, on window, would otherwise also close the open chat.
      e.stopPropagation()
      this.hide()
    })
  }

  async show() {
    this.open = true
    this.el.hidden = false
    await this.refresh()
  }

  hide() {
    this.open = false
    this.el.hidden = true
    clearTimeout(this.timer)
    this.timer = null
  }

  async refresh() {
    clearTimeout(this.timer)
    if (!this.open) return
    if (!document.hidden) {
      try {
        const d = await fetchSystemDetail()
        if (this.open) this.paint(d)
      } catch (err) {
        if (this.open) this.body.innerHTML = `<div class="nothing">${escape(err.message || 'Could not read the machine')}</div>`
      }
    }
    if (this.open) this.timer = setTimeout(() => this.refresh(), DETAIL_POLL_MS)
  }

  paint(d) {
    const n = d.cores.length || 1
    const m = d.memory
    const hist = d.history || []
    this.sub.textContent = `up ${uptime(d.uptime)} · ${n} cores · ${gb(m.total)}`

    const loadPct = Math.round((100 * d.load[0]) / n)
    const memPct = pct(m.used, m.total)
    const disks = d.disks.map((x) => ({ ...x, pct: pct(x.used, x.used + x.free) }))
    const tightest = disks.reduce((a, b) => (!a || b.pct > a.pct ? b : a), null)

    const v = verdict(d, loadPct, memPct, tightest)
    this.pill.hidden = !v
    if (v) {
      this.pill.className = `sd-pill ${v[0]}`
      this.pill.textContent = v[1]
    }

    // A block per core reads at four or eight; past that it is noise, so only the spread is told.
    // Each block fills from its foot, grey unless that core is in trouble, like the tile itself.
    const cores =
      d.cores.length <= 8
        ? `<div class="sd-blocks">${d.cores.map((c, i) => `<span class="sd-core ${severity(c)}" title="Core ${i + 1}: ${c}%"><i style="height:${c}%"></i></span>`).join('')}</div>` +
          `<span class="sd-per" title="${d.cores.map((c, i) => `Core ${i + 1}: ${c}%`).join('\n')}">${d.cores.join('·')}</span>`
        : `<span>cores ${Math.min(...d.cores)}–${Math.max(...d.cores)}%</span>`
    // Cache is drawn after used and clamped to what is left: available memory counts some of it already.
    const cache = Math.min(m.cache || 0, m.total - m.used)
    const stack =
      `<div class="sd-stack"><i class="u" style="width:${(100 * m.used) / m.total}%"></i>` +
      `<i class="c" style="width:${(100 * cache) / m.total}%"></i></div>`
    const [free, freeUnit] = tightest ? split(size(tightest.free)) : ['–', '']
    const others = disks.filter((x) => x !== tightest)
    const diskNote = tightest
      ? `${escape(tightest.mount)} at ${tightest.pct}%` + (others.length ? ` · others under ${Math.max(...others.map((x) => x.pct)) + 1}%` : '')
      : 'None found'
    const [memUsed] = split(gb(m.used))
    const loads = hist.map((h) => h.load)

    const tiles =
      `<div class="sd-tiles">` +
      tile(
        severity(loadPct),
        'Load',
        '15 min',
        `${d.load[0].toFixed(2)}<small> / ${n}</small>`,
        spark(loads, Math.max(n, ...loads)) + `<div class="sd-f">${trend(d.load)}</div>`
      ) +
      tile(
        severity(d.cpu.percent),
        'CPU',
        '15 min',
        `${d.cpu.percent}<small>%</small>`,
        spark(hist.map((h) => h.cpu), 100) + `<div class="sd-f sd-cpu">${cores}</div>`
      ) +
      tile(severity(memPct), 'Memory', '15 min', `${memUsed}<small> / ${gb(m.total)}</small>`, spark(hist.map((h) => h.memory), m.total) + stack) +
      tile(
        tightest ? severity(tightest.pct) : 'ok',
        'Disk',
        'tightest',
        `${free}<small> ${freeUnit} free</small>`,
        `<div class="sd-f">${diskNote}</div>` +
          (tightest ? `<span class="sys-bar ${severity(tightest.pct)}"><i style="width:${tightest.pct}%"></i></span>` : '')
      ) +
      `</div>`

    const legend =
      `<span class="sd-legend"><span><i class="u"></i>used ${gb(m.used)}</span>` +
      (m.cache != null ? `<span><i class="c"></i>cache ${gb(cache)}</span>` : '') +
      `<span><i></i>free ${gb(m.total - m.used - cache)}</span>` +
      (m.swapTotal ? `<span>swap ${gb(m.swapUsed)} / ${gb(m.swapTotal)}</span>` : '') +
      `</span>`

    const rows = disks
      .map(
        (x) =>
          `<span class="sd-mount" title="${escape(x.mount)}">${escape(x.mount)}</span>` +
          `<span class="sys-bar ${severity(x.pct)}"><i style="width:${x.pct}%"></i></span>` +
          `<span class="sd-num dim">${pctText(x.used, x.used + x.free)}</span>` +
          `<span class="sd-num">${size(x.free)}</span><span class="sd-num dim">${size(x.total)}</span>`
      )
      .join('')

    const html =
      tiles +
      `<section><h3>Memory ${legend}</h3>${stack}</section>` +
      `<section><h3>Disks</h3>` +
      (rows
        ? `<div class="sd-disks"><span>Mount</span><span class="sd-used">Used</span><span class="sd-num">Free</span><span class="sd-num">Size</span>${rows}</div>`
        : '<div class="sd-note">None found</div>') +
      `</section>`
    if (html !== this.last) this.body.innerHTML = this.last = html
  }
}
