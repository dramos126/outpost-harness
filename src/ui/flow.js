/**
 * A routine drawn as a flow (ui.md *The flow*): the trigger, the gate, the steps and the
 * endings, laid out left to right by Outpost from `steps`, on a canvas that pans by dragging and
 * zooms by wheel, pinch or buttons, with Fit to show it whole. A run drawn on it lights the path
 * that run took. On a routine's page a box can be dragged elsewhere (`edit`), and where it was
 * left is the page's to save (routines.md *Layouts*).
 *
 * Nothing here changes the routine itself: that is asked of a chat.
 */

/**
 * A box's width, its least height, and the room between columns and between boxes in a
 * column. A box is as tall as its text (`measure`, `FlowView.draw`): at a fixed height a step's
 * detail was cut mid-word and its title ran under the box's edge (the owner's review).
 */
const ROOMY = { nodeW: 200, nodeH: 64, endW: 150, endH: 52, gapX: 56, gapY: 22 }
/**
 * The approval card's: narrower boxes and gaps, so a flow of a few steps fits the bar's width
 * at a size that still reads, rather than shrunk to a grey strip.
 */
const COMPACT = { nodeW: 150, nodeH: 60, endW: 120, endH: 48, gapX: 34, gapY: 14 }
/** After the last wheel or drag, how long the canvas stays a moving layer before it is redrawn sharp. */
const SETTLE_MS = 150
/** An arrowhead's length. */
const HEAD = 7
/** How far a curve runs straight out of a box before it turns, at least. */
const CURVE = 28
/** Room under the boxes for an edge that goes back to an earlier column. */
const BACK_ROOM = 34
const ZOOM_MIN = 0.25
const ZOOM_MAX = 3
/** Fit never blows a small flow up past this: two boxes at 300% read as a mistake. */
const FIT_MAX = 1.5
const FIT_PAD = 32

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** One box's markup, for the canvas and for measuring it (`_measurer`) alike. */
function nodeHtml(n, style) {
  return (
    `<div class="node ${n.kind}" data-n="${escape(n.id)}" style="${style}" title="${escape([n.v, n.m].filter(Boolean).join('\n'))}">` +
    `<div class="k"><span>${escape(n.k)}</span><span class="tt"></span></div>` +
    `<div class="v">${escape(n.v)}</div>` +
    (n.m ? `<div class="m">${escape(n.m)}</div>` : '') +
    `</div>`
  )
}

/** What each ending says, and what it means for the person. */
const ENDS = {
  'end:done': { v: 'done', m: 'a note in the run log' },
  'end:needs-you': { v: 'needs you', m: 'opens a chat' },
  'end:nothing': { v: 'nothing', m: 'a line in the log' },
}

/** A step's box id, as `mark` takes it. */
export const stepNode = (id) => `s:${id}`

/**
 * The trigger's box. A routine started only by calls says so, with where it is called; one with
 * a time says its words and zone. The server's `when` already reads `On a call to "<name>"`; a
 * card's routine may come without it, so the words are made from the triggers then.
 */
function triggerNode(routine) {
  const triggers = Array.isArray(routine.triggers) ? routine.triggers : []
  const calls = triggers.filter((t) => t?.kind === 'call' && t.name)
  const onlyCalls = calls.length > 0 && calls.length === triggers.length
  const v = routine.when || calls.map((t) => `On a call to "${t.name}"`).join(', ') || 'By hand'
  if (onlyCalls) {
    const m = calls.length === 1 ? `POST /api/triggers/${calls[0].name}` : 'a POST with its token'
    return { id: 'trigger', kind: 'trigger', k: '↯ Call', v, m }
  }
  return { id: 'trigger', kind: 'trigger', k: '⏰ Trigger', v, m: triggers.find((t) => t?.tz)?.tz || '' }
}

/**
 * The boxes and arrows of a routine, before placing. `repoName(id)` names a gate's repos.
 * Every step's `next` is followed; one with none goes on to the step after it and the last to
 * `end:done`, as the store reads it (routines.md).
 * An ending is drawn only when something leads to it. A gate given as words (the card's) is
 * drawn with those words.
 */
function graphOf(routine, repoName) {
  const nodes = []
  const edges = []
  const have = new Set()
  const add = (n) => {
    if (have.has(n.id)) return
    have.add(n.id)
    nodes.push(n)
  }
  const steps = Array.isArray(routine.steps) ? routine.steps : []
  add(triggerNode(routine))
  const first = steps[0] ? stepNode(steps[0].id) : 'end:done'
  if (routine.gate) {
    const repos = typeof routine.gate === 'string' ? [] : (routine.gate.repos || []).map(repoName).filter(Boolean)
    const m = typeof routine.gate === 'string' ? routine.gate : `chats active${repos.length ? `, or main moved on ${repos.join(', ')}` : ''}, since the last run`
    add({ id: 'gate', kind: 'gate', k: '◇ Check', v: 'Anything new?', m })
    edges.push({ from: 'trigger', to: 'gate' })
    edges.push({ from: 'gate', to: first, label: 'yes' })
    edges.push({ from: 'gate', to: 'end:nothing', label: 'no' })
  } else {
    edges.push({ from: 'trigger', to: first })
  }
  steps.forEach((s, i) => add({ id: stepNode(s.id), kind: 'step', k: `Step ${i + 1}`, v: s.title || s.id, m: s.detail || '', step: s.id }))
  steps.forEach((s, i) => {
    const next = Array.isArray(s.next) && s.next.length ? s.next : [{ to: steps[i + 1]?.id ?? 'end:done' }]
    for (const n of next) {
      const to = String(n.to || '').startsWith('end:') ? n.to : stepNode(n.to)
      edges.push({ from: stepNode(s.id), to, label: n.label || '' })
    }
  })
  // Endings last, so each sits in the column after whatever leads to it.
  for (const e of edges) if (ENDS[e.to]) add({ id: e.to, kind: 'end', k: 'End', ...ENDS[e.to] })
  if (have.has('end:nothing') && routine.gate) nodes.find((n) => n.id === 'end:nothing').m = 'no session, no tokens'
  // An arrow to a step the routine does not have is dropped rather than drawn into nothing.
  return { nodes, edges: edges.filter((e) => have.has(e.from) && have.has(e.to)) }
}

/**
 * Columns by the longest path from the trigger, so every arrow runs left to right; an arrow
 * back to an earlier box (a loop) is drawn under the boxes. Relaxed at most once per box, so a
 * loop cannot spin. In a column, boxes are ordered by where the boxes leading to them sit,
 * which keeps most arrows from crossing. `measure(n, w)`, when given, is a box's height at
 * width `w` (the page's, from the drawn text); never less than the size's least height.
 * `saved` is where the person dragged boxes to, `{ [boxId]: { x, y } }` in the page's pixels
 * (routines.md *Layouts*): those boxes sit there, every other keeps its automatic place, and an
 * id the routine no longer has is ignored. Answers `{ nodes, edges, bounds, width, height }`,
 * `bounds` being what the drawing covers, which may start left of or above 0.
 */
export function layoutFlow(routine, repoName = (id) => id, size = ROOMY, measure = null, saved = null) {
  const { nodeW: NODE_W, nodeH: NODE_H, endW: END_W, endH: END_H, gapX: GAP_X, gapY: GAP_Y } = size
  const { nodes, edges } = graphOf(routine, repoName)
  // A loop's closing arrow is found by walking from the trigger: one that leads back to a box
  // still being walked. Leaving those out, what is left has no loop, and its longest paths
  // are the columns.
  const out = new Map(nodes.map((n) => [n.id, []]))
  for (const e of edges) out.get(e.from).push(e)
  const loops = new Set()
  const seen = new Map()
  const walk = (id) => {
    seen.set(id, 'on')
    for (const e of out.get(id)) {
      if (seen.get(e.to) === 'on') loops.add(e)
      else if (!seen.has(e.to)) walk(e.to)
    }
    seen.set(id, 'done')
  }
  walk('trigger')
  for (const n of nodes) if (!seen.has(n.id)) walk(n.id)
  const forward = edges.filter((e) => !loops.has(e))
  const rank = new Map(nodes.map((n) => [n.id, 0]))
  for (let pass = 0; pass < nodes.length; pass++) {
    let moved = false
    for (const e of forward) {
      const r = rank.get(e.from) + 1
      if (r > rank.get(e.to)) {
        rank.set(e.to, r)
        moved = true
      }
    }
    if (!moved) break
  }
  const sparse = []
  for (const n of nodes) {
    n.w = n.kind === 'end' ? END_W : NODE_W
    const least = n.kind === 'end' ? END_H : NODE_H
    n.h = Math.max(least, Math.ceil(measure?.(n, n.w) || 0))
    const r = rank.get(n.id)
    ;(sparse[r] ||= []).push(n)
  }
  const columns = Array.from(sparse, (c) => c || [])
  const colX = []
  let x = 0
  for (let r = 0; r < columns.length; r++) {
    colX[r] = x
    x += Math.max(0, ...columns[r].map((n) => n.w)) + GAP_X
  }
  const colH = (col) => col.reduce((h, n) => h + n.h, 0) + GAP_Y * Math.max(0, col.length - 1)
  const height = Math.max(NODE_H, ...columns.map(colH))
  const byId = new Map(nodes.map((n) => [n.id, n]))
  for (let r = 0; r < columns.length; r++) {
    const col = columns[r]
    if (r > 0) {
      const at = (n) => {
        const ys = edges.filter((e) => e.to === n.id && rank.get(e.from) < r).map((e) => byId.get(e.from).y + byId.get(e.from).h / 2)
        return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : height / 2
      }
      col.sort((a, b) => at(a) - at(b))
    }
    let y = (height - colH(col)) / 2
    for (const n of col) {
      n.x = colX[r] + (Math.max(...col.map((c) => c.w)) - n.w) / 2
      n.y = y
      y += n.h + GAP_Y
    }
  }
  // A box the person dragged sits where they left it (ui.md *The flow*); the rest, and a step
  // added since, keep the automatic place. Kept in the page's pixels and scaled for a smaller
  // size, so the approval card draws the same arrangement in its narrower boxes.
  const sx = (NODE_W + GAP_X) / (ROOMY.nodeW + ROOMY.gapX)
  const sy = (NODE_H + GAP_Y) / (ROOMY.nodeH + ROOMY.gapY)
  for (const n of nodes) {
    const p = saved && Object.hasOwn(saved, n.id) ? saved[n.id] : null
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) Object.assign(n, { x: p.x * sx, y: p.y * sy, placed: true })
  }
  for (const e of edges) {
    e.id = `${e.from}>${e.to}`
    e.loop = loops.has(e)
  }
  const flow = { nodes, edges, gapX: GAP_X, scale: { x: sx, y: sy } }
  routeEdges(flow)
  return flow
}

/** Room an arrow needs between two boxes to be drawn straight across it rather than around. */
const MIN_RUN = 2 * HEAD + 4
/** Snap a dragged box to this grid, in the page's pixels: boxes line up without trying. */
export const GRID = 8
/** With Shift held, how near a box's centre must come to a joined box's to be lined up with it. */
export const ALIGN_REACH = 64

/**
 * Shift while dragging (the owner's, 2026-10-15): `node` at (`x`, `y`) lines up, centre to
 * centre, with the box it is joined to whose centre is nearest on each axis, within
 * `ALIGN_REACH` — level with it, so the arrow between them is straight, or under it. Each axis
 * on its own, so a box can be level with one and under another. Answers the place and the
 * guides to draw: `{ x, y, guides: [{ axis: 'h' | 'v', at, from, to }] }`.
 */
export function alignTo(layout, node, x, y, reach = ALIGN_REACH) {
  const joined = new Set()
  for (const e of layout.edges) {
    if (e.from === node.id && e.to !== node.id) joined.add(e.to)
    if (e.to === node.id && e.from !== node.id) joined.add(e.from)
  }
  const others = layout.nodes.filter((n) => joined.has(n.id))
  const cx = x + node.w / 2
  const cy = y + node.h / 2
  const nearest = (centre, of) => {
    let best = null
    for (const n of others) {
      const d = Math.abs(of(n) - centre)
      if (d <= reach && (!best || d < best.d)) best = { n, d }
    }
    return best?.n || null
  }
  const guides = []
  const level = nearest(cy, (n) => n.y + n.h / 2)
  if (level) {
    y = level.y + level.h / 2 - node.h / 2
    guides.push({ axis: 'h', at: level.y + level.h / 2, from: Math.min(x, level.x), to: Math.max(x + node.w, level.x + level.w) })
  }
  const under = nearest(cx, (n) => n.x + n.w / 2)
  if (under) {
    x = under.x + under.w / 2 - node.w / 2
    guides.push({ axis: 'v', at: under.x + under.w / 2, from: Math.min(y, under.y), to: Math.max(y + node.h, under.y + under.h) })
  }
  return { x, y, guides }
}

/** How far a press may wander and still be a press, not a drag. */
const CLICK_SLOP = 4

/**
 * Route every arrow of `flow` — or only those touching box `only` while it is dragged — and
 * work out what the drawing covers (`bounds`), so Fit takes in everything, a box dragged above
 * or left of the trigger included.
 */
export function routeEdges(flow, only = null) {
  const byId = new Map(flow.nodes.map((n) => [n.id, n]))
  for (const e of flow.edges) {
    if (only && e.from !== only && e.to !== only) continue
    routeEdge(e, byId.get(e.from), byId.get(e.to), flow.nodes)
  }
  if (only) return flow
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
  const take = (x0, y0, x1, y1) => {
    box.x0 = Math.min(box.x0, x0)
    box.y0 = Math.min(box.y0, y0)
    box.x1 = Math.max(box.x1, x1)
    box.y1 = Math.max(box.y1, y1)
  }
  for (const n of flow.nodes) take(n.x, n.y, n.x + n.w, n.y + n.h)
  for (const e of flow.edges) {
    take(...e.box)
    // A label's room, roughly: 11px text at about 6.5px a character, its baseline at `ly`.
    if (e.label) take(e.lx, e.ly - 12, e.lx + e.label.length * 6.5, e.ly + 4)
  }
  if (!Number.isFinite(box.x0)) Object.assign(box, { x0: 0, y0: 0, x1: 0, y1: 0 })
  flow.bounds = { x: box.x0, y: box.y0, w: box.x1 - box.x0, h: box.y1 - box.y0 }
  flow.width = flow.bounds.w
  flow.height = flow.bounds.h
  return flow
}

/**
 * One arrow's path (`d`), its arrowhead (`head`, a shape of its own so a run's path colours it),
 * its label's place (`lx`, `ly`) and what it covers (`box`). In order:
 * - target to the right: a curve from the source's right side to the target's left;
 * - a dragged box below or above the other: a curve from the source's bottom (or top) to the
 *   target's top (or bottom);
 * - otherwise — a loop's closing arrow, or a target dragged behind its source — a curve down
 *   from the source, under every box in between, and up into the target from below.
 * Every curve leaves and arrives square to the box, so its arrowhead lies along it.
 */
function routeEdge(e, a, b, nodes) {
  const placed = Boolean(a.placed || b.placed)
  if (a === b) return under(e, a, b, nodes)
  // The room between the two boxes on each side of the source. In the automatic layout a
  // target is always to the right, but for a loop's closing arrow, which goes under. Once a
  // box has been placed by hand, the arrow leaves from whichever side faces the target with
  // the most room: before, a box dragged to the left on the same row was reached the long
  // way, down and around under both (the owner's, 2026-10-15).
  const room = {
    right: b.x - (a.x + a.w),
    left: placed ? a.x - (b.x + b.w) : -Infinity,
    down: placed ? b.y - (a.y + a.h) : -Infinity,
    up: placed ? a.y - (b.y + b.h) : -Infinity,
  }
  if (e.loop && !placed) return under(e, a, b, nodes)
  const [side, gap] = Object.entries(room).reduce((best, x) => (x[1] > best[1] ? x : best))
  if (gap < MIN_RUN) return under(e, a, b, nodes)
  if (side === 'right') return sideways(e, a, b, 1)
  if (side === 'left') return sideways(e, a, b, -1)
  return upright(e, a, b, side === 'down' ? 1 : -1)
}

/** `dir` 1: from the source's right side into the target's left; -1: from its left into the target's right. */
function sideways(e, a, b, dir) {
  const x1 = dir > 0 ? a.x + a.w : a.x
  const y1 = a.y + a.h / 2
  const x2 = dir > 0 ? b.x : b.x + b.w
  const y2 = b.y + b.h / 2
  // The line stops short of the box and the arrowhead points into it. A curve whose ends leave
  // and arrive level, so the arrowhead lies along it; the owner found the right-angled elbows
  // jagged once boxes could be dragged anywhere.
  const end = x2 - dir * HEAD
  const flat = Math.abs(y1 - y2) < 1
  const dx = dir * Math.max(CURVE, Math.abs(end - x1) / 2)
  e.d = flat ? `M${x1} ${y1} H${end}` : `M${x1} ${y1} C${x1 + dx} ${y1} ${end - dx} ${y2} ${end} ${y2}`
  e.head = `M${x2} ${y2} L${end} ${y2 - HEAD / 2} L${end} ${y2 + HEAD / 2} Z`
  e.lx = flat ? Math.min(x1, end) + 6 : (x1 + end) / 2 + 6
  e.ly = flat ? y1 - 6 : (y1 + y2) / 2 - 6
  e.box = [Math.min(x1, x2), Math.min(y1, y2) - HEAD, Math.max(x1, x2), Math.max(y1, y2) + HEAD]
}

/** `dir` 1: down from the source's bottom into the target's top; -1: up from its top into the target's bottom. */
function upright(e, a, b, dir) {
  const ax = a.x + a.w / 2
  const bx = b.x + b.w / 2
  const ay = dir > 0 ? a.y + a.h : a.y
  const by = dir > 0 ? b.y : b.y + b.h
  const end = by - dir * HEAD
  const dy = dir * Math.max(CURVE, Math.abs(end - ay) / 2)
  e.d = Math.abs(ax - bx) < 1 ? `M${ax} ${ay} V${end}` : `M${ax} ${ay} C${ax} ${ay + dy} ${bx} ${end - dy} ${bx} ${end}`
  e.lx = (ax + bx) / 2 + 6
  e.ly = (ay + end) / 2 + 4
  e.head = `M${bx} ${by} L${bx - HEAD / 2} ${end} L${bx + HEAD / 2} ${end} Z`
  e.box = [Math.min(ax, bx) - HEAD, Math.min(ay, by), Math.max(ax, bx) + HEAD, Math.max(ay, by)]
}

function under(e, a, b, nodes) {
  // A box's arrow to itself leaves from its right half and comes back into its left.
  const ax = a === b ? a.x + (a.w * 3) / 4 : a.x + a.w / 2
  const bx = a === b ? b.x + b.w / 4 : b.x + b.w / 2
  const ay = a.y + a.h
  const by = b.y + b.h
  // Under every box the line passes beneath, the two it joins included.
  const lo = Math.min(ax, bx)
  const hi = Math.max(ax, bx)
  const yb = Math.max(...nodes.filter((n) => n.x <= hi && n.x + n.w >= lo).map((n) => n.y + n.h)) + BACK_ROOM / 2
  // One curve that dips to `yb` at its middle: a cubic's middle is an eighth of each end and
  // three quarters of its two control points, which share a height.
  const c = (yb - (ay + by + HEAD) / 8) / 0.75
  e.d = `M${ax} ${ay} C${ax} ${c} ${bx} ${c} ${bx} ${by + HEAD}`
  e.head = `M${bx} ${by} L${bx - HEAD / 2} ${by + HEAD} L${bx + HEAD / 2} ${by + HEAD} Z`
  e.lx = (ax + bx) / 2
  e.ly = yb - 5
  e.box = [lo - HEAD, Math.min(ay, by), hi + HEAD, yb + 4]
}

/** "8s", "2m 14s", "1h 3m". */
export function took(ms) {
  if (!(ms >= 0)) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

function median(list) {
  if (!list.length) return null
  const s = [...list].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * How long each step, and a whole run, usually takes, from the runs kept (routines.md, the last
 * thirty): the median of each step's `done` entries and of the runs that ended `done`. A median,
 * so one stalled run does not throw the estimate. A step that has never finished has none, so a
 * first run shows no estimate rather than a guess.
 */
export function typicalTimes(runs) {
  const steps = new Map()
  const whole = []
  for (const run of Array.isArray(runs) ? runs : []) {
    if (run.outcome === 'done' && run.at && run.endedAt > run.at) whole.push(run.endedAt - run.at)
    for (const s of Array.isArray(run.steps) ? run.steps : []) {
      if (s.status !== 'done' || !s.at || !(s.endedAt >= s.at)) continue
      if (!steps.has(s.step)) steps.set(s.step, [])
      steps.get(s.step).push(s.endedAt - s.at)
    }
  }
  return { steps: new Map([...steps].map(([k, v]) => [k, median(v)])), run: median(whole) }
}

/** A clock time, "10:42". */
export function clockAt(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/**
 * When something started at `at` that usually takes `usual` should be done: "done ~10:42", or
 * "over its usual 4m 10s" once that has passed; '' with no estimate.
 */
export function etaWords(at, usual, now = Date.now()) {
  if (!(usual > 0) || !at) return ''
  return at + usual > now ? `done ~${clockAt(at + usual)}` : `over its usual ${took(usual)}`
}

/** A run's outcome as the colour the path is drawn in. */
export const TONE = { done: 'ok', nothing: 'ok', 'needs-you': 'warn', failed: 'bad', running: 'run' }

/**
 * Where a failed run failed, from its own `steps` (ui.md *A routine's page*), or null for a run
 * that did not fail. The step that says `failed`; else the last one started and never ended —
 * the step it was in when it errored or stalled. A run with no steps never got a session to
 * run them (preparation, no session), so it failed before it started: `{ before: true }`. One
 * whose steps all ended and none failed broke after its last (`after: true`). `n` is the
 * step's place in the routine, 0 when the routine no longer has it.
 */
export function failedAt(run, routine) {
  if (run?.outcome !== 'failed') return null
  const steps = Array.isArray(run.steps) ? run.steps : []
  if (!steps.length) return { before: true }
  const hit = steps.findLast((s) => s.status === 'failed') || steps.findLast((s) => !s.endedAt)
  const s = hit || steps[steps.length - 1]
  const list = Array.isArray(routine?.steps) ? routine.steps : []
  const i = list.findIndex((x) => x.id === s.step)
  return { step: s.step, n: i + 1, title: i < 0 ? String(s.step) : list[i].title || s.step, ...(hit ? {} : { after: true }) }
}

/** A failed run's place in words: "Failed at step 2 · Read the digest", "Failed before it started". */
export function failedWords(f) {
  if (!f) return ''
  if (f.before) return 'Failed before it started'
  const where = f.n ? `step ${f.n} · ${f.title}` : f.title
  return `Failed ${f.after ? 'after' : 'at'} ${where}`
}

/**
 * The path a run took, from its own record: the trigger always; the gate unless the run
 * skipped it; each step it reported, with how long it took; the ending it said. An arrow is
 * lit when both its ends are, and an arrow to an ending only from the box the run left last —
 * so a branch not taken stays dim. A failed run names the box it failed in (`failed`, by
 * `failedAt`): the step, or the trigger for a run that failed before it started, whose path is
 * the trigger alone. While a run goes, with `typical` (`typicalTimes`), the step it is in says
 * when it should be done, and a step it has not reached how long it usually takes (`ahead`).
 */
export function pathOf(layout, routine, run, typical = null, now = Date.now()) {
  const lit = new Map()
  const ahead = new Map()
  if (!run) return { lit, ahead, edges: new Set(), tone: '', failed: '' }
  const clock = run.at ? clockAt(run.at) : ''
  lit.set('trigger', { time: run.by === 'trigger' ? clock : 'by hand' })
  const fail = failedAt(run, routine)
  if (fail?.before) return { lit, ahead, edges: new Set(), tone: TONE.failed, failed: 'trigger' }
  const gated = Boolean(routine.gate) && !run.skipGate
  if (gated) lit.set('gate', {})
  const last = new Map()
  for (const s of Array.isArray(run.steps) ? run.steps : []) last.set(s.step, s)
  const going = run.outcome === 'running'
  for (const [step, s] of last) {
    const eta = going && s.status === 'started' ? etaWords(s.at, typical?.steps.get(step), now) : ''
    const time = s.status === 'started' ? (going ? (eta ? `now · ${eta}` : 'now') : '') : s.at && s.endedAt ? took(s.endedAt - s.at) : ''
    lit.set(stepNode(step), { time, status: s.status })
  }
  if (going && typical) {
    for (const [step, usual] of typical.steps) {
      if (!last.has(step) && usual > 0) ahead.set(stepNode(step), `usually ${took(usual)}`)
    }
  }
  const end = `end:${run.outcome}`
  if (ENDS[end]) lit.set(end, {})
  const edges = new Set()
  const ran = new Set([...last.keys()].map(stepNode))
  for (const e of layout.edges) {
    if (!lit.has(e.from) || !lit.has(e.to)) continue
    if (ENDS[e.to]) {
      // The gate leads to "nothing" only when no step ran; a step to its ending only when no
      // step after it ran.
      const leftLast = e.from === 'gate' ? ran.size === 0 : !layout.edges.some((x) => x.from === e.from && ran.has(x.to))
      if (!leftLast) continue
    }
    edges.add(e.id)
  }
  const failed = fail && !fail.after && lit.has(stepNode(fail.step)) ? stepNode(fail.step) : ''
  return { lit, ahead, edges, tone: TONE[run.outcome] || '', failed }
}

export class FlowView {
  /**
   * `el` is emptied and becomes the canvas. `fitMax` caps Fit's zoom; `wheel: 'pinch'` leaves
   * a plain wheel to scroll what the canvas sits in and zooms only on a pinch (a wheel with
   * ctrlKey) — the approval card's, in a bar a wheel should still scroll past. `compact` draws
   * the card's smaller boxes, with less room around them on Fit. `edit` lets a box be dragged
   * (the routine's page); `onDrop(layout, moved)` hears each drag end, with every box placed by
   * hand so far, `{ [boxId]: { x, y } }` in the page's pixels.
   */
  constructor(el, { fitMax = FIT_MAX, wheel = 'zoom', compact = false, edit = false, onDrop = null } = {}) {
    this.el = el
    this.fitMax = fitMax
    this.boxes = compact ? COMPACT : ROOMY
    this.pad = compact ? 10 : FIT_PAD
    this.wheel = wheel
    this.edit = edit
    this.onDrop = onDrop
    this.saved = {}
    this.run = null
    this.note = ''
    this.typical = null
    this.drag = null
    this.el.classList.add('flow-canvas')
    this.el.classList.toggle('editable', edit)
    this.el.innerHTML = `
      <div class="flow"></div>
      <div class="flow-note"></div>
      <div class="flow-zoom">
        <button type="button" data-z="out" title="Zoom out" aria-label="Zoom out">−</button><span class="pct">100%</span><button type="button" data-z="in" title="Zoom in" aria-label="Zoom in">+</button>
        <button type="button" data-z="fit" title="Fit to the pane (or double-click the canvas)">Fit</button>
      </div>`
    this.flow = this.el.querySelector('.flow')
    this.view = { x: 0, y: 0, k: 1 }
    this.bounds = { x: 0, y: 0, w: 0, h: 0 }
    // Whether the view is the fitted one: a resize refits it then, and leaves a view the
    // person panned or zoomed alone.
    this.fitted = true
    this._wire()
  }

  /**
   * Draw a routine. `repoName(id)` names its repos; `saved` is where boxes were dragged to
   * (`layoutFlow`). Fitted, as a new drawing always is; the run shown stays shown.
   */
  draw(routine, repoName, saved = null) {
    this.routine = routine
    this.repoName = repoName
    this._lay(saved)
    this.fit()
  }

  /**
   * Put the boxes where `saved` says, as a layout changed in another tab: the view stays where
   * the person left it. Refused (false) while a box is being dragged.
   */
  place(saved) {
    if (this.drag || !this.routine) return false
    this._lay(saved)
    return true
  }

  /** Whether a box is being dragged now: a redraw then would pull it from under the pointer. */
  get dragging() {
    return Boolean(this.drag)
  }

  _lay(saved) {
    this._dropDrag()
    this.saved = saved && typeof saved === 'object' ? { ...saved } : {}
    this.layout = layoutFlow(this.routine, this.repoName, this.boxes, this._measurer(), this.saved)
    this._render()
    this.show(this.run, this.note, this.typical)
  }

  /**
   * The drawing: an SVG group per arrow (line, head, label), then the boxes. The SVG draws
   * outside its own box (`overflow: visible`), so a box dragged above or left of 0 keeps its
   * arrows; each group is kept (`edgeEls`) so a drag moves its arrows without a rebuild.
   */
  _render() {
    const { nodes, edges, bounds } = this.layout
    this.bounds = bounds
    this.flow.style.width = `${Math.max(0, bounds.x + bounds.w)}px`
    this.flow.style.height = `${Math.max(0, bounds.y + bounds.h)}px`
    this.flow.innerHTML =
      `<svg aria-hidden="true">` +
      edges
        .map(
          (e) =>
            `<g>` +
            // A gap in the canvas's colour under the line: where two cross, the later one cuts
            // the one beneath it, so each can be followed through the crossing.
            `<path class="case" d="${e.d}"/>` +
            `<path class="edge" data-e="${escape(e.id)}" d="${e.d}"/>` +
            `<path class="head" data-e="${escape(e.id)}" d="${e.head}"/>` +
            (e.label ? `<text class="lbl" data-e="${escape(e.id)}" x="${e.lx}" y="${e.ly}">${escape(e.label)}</text>` : '') +
            `</g>`
        )
        .join('') +
      `</svg>` +
      nodes.map((n) => nodeHtml(n, `left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px`)).join('') +
      `<div class="guide" hidden></div><div class="guide" hidden></div>`
    const groups = [...this.flow.querySelector('svg').children]
    this.edgeEls = groups.map((g) => ({ casing: g.children[0], path: g.children[1], head: g.children[2], lbl: g.children[3] || null }))
    this.guides = [...this.flow.querySelectorAll('.guide')]
  }

  /** Write arrows `which` (indexes into the layout's edges) back to the drawing. */
  _paintEdges(which) {
    for (const i of which) {
      const e = this.layout.edges[i]
      const el = this.edgeEls[i]
      el.casing.setAttribute('d', e.d)
      el.path.setAttribute('d', e.d)
      el.head.setAttribute('d', e.head)
      if (el.lbl) {
        el.lbl.setAttribute('x', String(e.lx))
        el.lbl.setAttribute('y', String(e.ly))
      }
    }
  }

  /**
   * Where the dragged box goes for the pointer's last move: on the page's grid, or with
   * `shift` lined up with a box it is joined to (`alignTo`). Pressing or letting go of Shift
   * mid-drag places it again without a move.
   */
  _placeDragged(shift) {
    const d = this.drag
    if (!d?.last) return
    const { x: sx, y: sy } = this.layout.scale
    const x = d.x0 + (d.last.clientX - d.sx) / this.view.k
    const y = d.y0 + (d.last.clientY - d.sy) / this.view.k
    const snap = (v, s) => Math.round(v / (GRID * s)) * GRID * s
    const lined = shift ? alignTo(this.layout, d.node, x, y, ALIGN_REACH * sx) : null
    d.node.x = lined ? lined.x : snap(x, sx)
    d.node.y = lined ? lined.y : snap(y, sy)
    d.guides = lined?.guides || []
    d.node.placed = true
    this._dragFrame()
  }

  /**
   * A box follows the pointer once a frame, however many moves arrive in it, with only its own
   * arrows routed again and written — a rebuild of the drawing per move is what would lag.
   */
  _dragFrame() {
    if (this.dragRaf) return
    this.dragRaf = requestAnimationFrame(() => {
      this.dragRaf = 0
      const d = this.drag
      if (!d) return
      d.el.style.left = `${d.node.x}px`
      d.el.style.top = `${d.node.y}px`
      routeEdges(this.layout, d.node.id)
      this._paintEdges(d.edges)
      this._paintGuides(d.guides || [])
    })
  }

  /** The dashed lines that say what a Shift-drag lined the box up with; none hides them. */
  _paintGuides(guides) {
    this.guides?.forEach((g, i) => {
      const at = guides[i]
      g.hidden = !at
      if (!at) return
      g.dataset.axis = at.axis
      g.style.left = `${at.axis === 'h' ? at.from : at.at}px`
      g.style.top = `${at.axis === 'h' ? at.at : at.from}px`
      g.style.width = at.axis === 'h' ? `${at.to - at.from}px` : ''
      g.style.height = at.axis === 'v' ? `${at.to - at.from}px` : ''
    })
  }

  /**
   * The drag ends: where the box was left joins `saved` (in the page's pixels), every arrow is
   * routed again — one passing under the box may move — and what the drawing covers is worked
   * out again for the next Fit. `onDrop` hears it, moved or not.
   */
  _endDrag() {
    const d = this.drag
    if (!d) return
    this._dropDrag()
    if (d.moved) {
      const { x: sx, y: sy } = this.layout.scale
      this.saved[d.node.id] = { x: Math.round(d.node.x / sx), y: Math.round(d.node.y / sy) }
      d.el.style.left = `${d.node.x}px`
      d.el.style.top = `${d.node.y}px`
      routeEdges(this.layout)
      this.bounds = this.layout.bounds
      this._paintEdges(this.layout.edges.map((_, i) => i))
    }
    this.onDrop?.({ ...this.saved }, d.moved)
  }

  /** Forget a drag without a word: the drawing it was in is being replaced. */
  _dropDrag() {
    if (this.dragRaf) cancelAnimationFrame(this.dragRaf)
    this.dragRaf = 0
    this.drag?.el.classList.remove('dragging')
    this._paintGuides([])
    this.el.classList.remove('box-drag')
    this.drag = null
  }

  /**
   * A box's height as the page draws it: the box at its width, height left to its text, in a
   * hidden copy inside the canvas so the canvas's own rules size it. Null where nothing can be
   * measured (a canvas not in the document), and the least heights stand.
   */
  _measurer() {
    if (!this.el.isConnected) return null
    const probe = document.createElement('div')
    probe.className = 'flow flow-probe'
    probe.setAttribute('aria-hidden', 'true')
    this.el.appendChild(probe)
    const cache = new Map()
    return (n, w) => {
      if (!cache.size) queueMicrotask(() => probe.remove())
      const key = `${w}|${n.kind}|${n.k}|${n.v}|${n.m}`
      if (!cache.has(key)) {
        probe.innerHTML = nodeHtml(n, `width:${w}px`)
        cache.set(key, probe.firstElementChild.getBoundingClientRect().height)
      }
      return cache.get(key)
    }
  }

  /**
   * Light the path `run` took, or none; `note` is the line under the canvas; `typical`
   * (`typicalTimes`) gives a running run its estimates.
   */
  show(run, note = '', typical = null) {
    this.run = run
    this.note = note
    this.typical = typical
    if (!this.layout) return
    const { lit, ahead, edges, tone, failed } = pathOf(this.layout, this.routine, run, typical)
    this.flow.dataset.tone = tone
    this.flow.classList.toggle('pathed', Boolean(run))
    for (const n of this.flow.querySelectorAll('.node')) {
      const on = lit.get(n.dataset.n)
      n.classList.toggle('taken', Boolean(on))
      n.classList.toggle('failed', n.dataset.n === failed)
      n.dataset.status = on?.status || ''
      n.querySelector('.tt').textContent = on?.time || ahead.get(n.dataset.n) || ''
    }
    for (const e of this.flow.querySelectorAll('[data-e]')) e.classList.toggle('taken', edges.has(e.dataset.e))
    this.el.querySelector('.flow-note').textContent = note
  }

  /**
   * The view, written once a frame however many wheel and pointer events arrive in it. While
   * it moves, the flow is its own layer (`moving`, `will-change`), so a frame moves a picture
   * rather than repainting the canvas and its dot grid; once it rests the class goes, and the
   * boxes are drawn sharp at the new zoom. Painting on every event was what made a small
   * routine lag.
   */
  _paint() {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      const { x, y, k } = this.view
      this.flow.style.transform = `translate(${x}px, ${y}px) scale(${k})`
      const pct = `${Math.round(k * 100)}%`
      if (pct !== this.pct) this.el.querySelector('.pct').textContent = this.pct = pct
    })
    this.el.classList.add('moving')
    clearTimeout(this.settle)
    this.settle = setTimeout(() => this.el.classList.remove('moving'), SETTLE_MS)
  }

  _zoomAt(k, cx, cy) {
    k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k))
    const v = this.view
    v.x = cx - (cx - v.x) * (k / v.k)
    v.y = cy - (cy - v.y) * (k / v.k)
    v.k = k
    this.fitted = false
    this._paint()
  }

  /**
   * The whole flow in the pane, centred, never larger than `FIT_MAX`: everything the drawing
   * covers (`bounds`), a box dragged above or left of the rest included.
   */
  fit() {
    const r = this.el.getBoundingClientRect()
    const b = this.bounds
    // Not on screen yet (another view showing): fitted when it is, by the resize observer.
    if (!r.width || !r.height || !b.w) {
      this.fitted = true
      return
    }
    const k = Math.max(ZOOM_MIN, Math.min(this.fitMax, (r.width - this.pad * 2) / b.w, (r.height - this.pad * 2) / Math.max(1, b.h)))
    this.view = { k, x: (r.width - b.w * k) / 2 - b.x * k, y: (r.height - b.h * k) / 2 - b.y * k }
    this.fitted = true
    this._paint()
  }

  _wire() {
    const el = this.el
    const local = (e) => {
      const r = el.getBoundingClientRect()
      return [e.clientX - r.left, e.clientY - r.top]
    }
    // A trackpad's pinch arrives as a wheel with ctrlKey, so one handler zooms for both.
    el.addEventListener(
      'wheel',
      (e) => {
        if (this.wheel === 'pinch' && !e.ctrlKey) return
        e.preventDefault()
        this._zoomAt(this.view.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), ...local(e))
      },
      { passive: false }
    )
    const pts = new Map()
    let last = null
    let pinch = 0
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.flow-zoom')) return
      el.setPointerCapture(e.pointerId)
      pts.set(e.pointerId, e)
      // One pointer on a box drags the box; on the background it pans. A second finger ends
      // a box's drag where it is, and the two pinch.
      const box = this.edit && this.layout && pts.size === 1 && e.button === 0 ? e.target.closest('.node') : null
      const node = box && this.flow.contains(box) ? this.layout.nodes.find((n) => n.id === box.dataset.n) : null
      if (node) {
        const edges = []
        this.layout.edges.forEach((x, i) => (x.from === node.id || x.to === node.id) && edges.push(i))
        this.drag = { id: e.pointerId, node, el: box, edges, sx: e.clientX, sy: e.clientY, x0: node.x, y0: node.y, moved: false }
      } else if (this.drag) this._endDrag()
      el.classList.add('drag')
      last = { x: e.clientX, y: e.clientY }
      pinch = 0
    })
    el.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return
      pts.set(e.pointerId, e)
      if (pts.size === 2) {
        const [a, b] = [...pts.values()]
        const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
        const r = el.getBoundingClientRect()
        if (pinch) this._zoomAt((this.view.k * d) / pinch, (a.clientX + b.clientX) / 2 - r.left, (a.clientY + b.clientY) / 2 - r.top)
        pinch = d
        return
      }
      const d = this.drag
      if (d && d.id === e.pointerId) {
        const dx = e.clientX - d.sx
        const dy = e.clientY - d.sy
        // A press that hardly moved is a press: the box stays, nothing is saved.
        if (!d.moved && Math.hypot(dx, dy) < CLICK_SLOP) return
        if (!d.moved) {
          d.moved = true
          d.el.classList.add('dragging')
          el.classList.add('box-drag')
        }
        // Pointer pixels over the zoom are the drawing's; the box snaps to the page's grid.
        d.last = e
        this._placeDragged(e.shiftKey)
        return
      }
      this.view.x += e.clientX - last.x
      this.view.y += e.clientY - last.y
      last = { x: e.clientX, y: e.clientY }
      this.fitted = false
      this._paint()
    })
    const up = (e) => {
      pts.delete(e.pointerId)
      if (this.drag?.id === e.pointerId) this._endDrag()
      pinch = 0
      if (!pts.size) el.classList.remove('drag')
      else {
        const p = [...pts.values()][0]
        last = { x: p.clientX, y: p.clientY }
      }
    }
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    el.addEventListener('dblclick', (e) => {
      if (!e.target.closest('.flow-zoom')) this.fit()
    })
    // Shift pressed or let go mid-drag lines the box up, or lets it go, where it is.
    const shift = (e) => {
      if (e.key === 'Shift' && this.drag?.moved) this._placeDragged(e.type === 'keydown')
    }
    window.addEventListener('keydown', shift)
    window.addEventListener('keyup', shift)
    this.unshift = () => {
      window.removeEventListener('keydown', shift)
      window.removeEventListener('keyup', shift)
    }
    el.querySelector('.flow-zoom').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-z]')
      if (!b) return
      const r = el.getBoundingClientRect()
      if (b.dataset.z === 'fit') this.fit()
      else this._zoomAt(this.view.k * (b.dataset.z === 'in' ? 1.25 : 1 / 1.25), r.width / 2, r.height / 2)
    })
    // The pane changes size when the details column opens or a window is dragged: a fitted
    // view stays fitted, one the person moved is theirs.
    if (typeof ResizeObserver === 'function') {
      this.observer = new ResizeObserver(() => {
        if (this.fitted) this.fit()
      })
      this.observer.observe(el)
    }
  }

  /** Stop watching the pane's size, for a canvas about to be thrown away. */
  destroy() {
    this.observer?.disconnect()
    this.unshift?.()
    this._dropDrag()
  }

  /** Outline the boxes `ids` as changed: what an update to a routine alters. */
  mark(ids) {
    for (const n of this.flow.querySelectorAll('.node')) n.classList.toggle('changed', ids.has(n.dataset.n))
  }
}
