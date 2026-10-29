// The routine flow's layout (src/ui/flow.js), as the approval card feeds it: steps with no
// `next`, and a gate given as the server's words.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GRID, alignTo, etaWords, failedAt, failedWords, layoutFlow, pathOf, routeEdges, typicalTimes } from '../src/ui/flow.js'
import { layoutKey } from '../src/ui/routine-page.js'

test('a card’s steps, which carry no next, run one after the other to done', () => {
  const card = {
    when: 'Every day at 11:00 PM',
    triggers: [{ tz: 'America/Chicago' }],
    gate: 'Only if a chat was active or main moved on docs since the last run',
    steps: [
      { id: 's1', title: 'Read the digest' },
      { id: 's2', title: 'Update the docs' },
    ],
  }
  const { nodes, edges } = layoutFlow(card)
  const pairs = edges.map((e) => `${e.from}>${e.to}`)
  assert.deepEqual(pairs.sort(), ['gate>end:nothing', 'gate>s:s1', 's:s1>s:s2', 's:s2>end:done', 'trigger>gate'].sort())
  assert.equal(nodes.find((n) => n.id === 'gate').m, card.gate)
  // Left to right: every forward arrow ends in a later column.
  const x = new Map(nodes.map((n) => [n.id, n.x]))
  for (const e of edges) assert.ok(x.get(e.to) > x.get(e.from), `${e.from} → ${e.to}`)
})

test('a step’s own next is followed, and a routine with no gate has none drawn', () => {
  const r = {
    when: 'Weekdays at 4:15 PM',
    gate: null,
    steps: [
      { id: 's1', title: 'Check', next: [{ to: 'end:done', label: 'clean' }, { to: 'end:needs-you', label: 'unsure' }] },
    ],
  }
  const { nodes, edges } = layoutFlow(r)
  assert.ok(!nodes.some((n) => n.id === 'gate'))
  assert.deepEqual(edges.map((e) => e.label).filter(Boolean).sort(), ['clean', 'unsure'])
})

test('a run stopped by the gate lights the way to nothing', () => {
  const r = { when: 'Every day at 11:00 PM', gate: { kind: 'activity', repos: [] }, steps: [{ id: 's1', title: 'Work' }] }
  const layout = layoutFlow(r)
  const { lit, edges } = pathOf(layout, r, { at: 1, by: 'trigger', outcome: 'nothing', reason: 'gate', steps: [] })
  assert.ok(lit.has('end:nothing'))
  assert.ok(edges.has('gate>end:nothing'))
  assert.ok(!edges.has('gate>s:s1'))
})

test('a routine started only by a call says so on its trigger box, with where it is called', () => {
  const r = { triggers: [{ kind: 'call', name: 'website-push' }], gate: null, steps: [{ id: 's1', title: 'Work' }] }
  const t = layoutFlow(r).nodes.find((n) => n.id === 'trigger')
  assert.equal(t.k, '↯ Call')
  assert.equal(t.v, 'On a call to "website-push"')
  assert.equal(t.m, 'POST /api/triggers/website-push')
  // The server's words win when given; a time beside the call keeps the clock's box and zone.
  const mixed = { when: 'Every day at 11:00 PM, On a call to "x"', triggers: [{ kind: 'cron', tz: 'UTC' }, { kind: 'call', name: 'x' }], steps: [] }
  const m = layoutFlow(mixed).nodes.find((n) => n.id === 'trigger')
  assert.equal(m.k, '⏰ Trigger')
  assert.equal(m.v, mixed.when)
  assert.equal(m.m, 'UTC')
})

const three = {
  when: 'Every day at 11:00 PM',
  gate: { kind: 'activity', repos: [] },
  steps: [
    { id: 's1', title: 'Read the digest' },
    { id: 's2', title: 'Update the docs' },
    { id: 's3', title: 'Push' },
  ],
}

test('a failed run failed at the step that says failed, else the one started and never ended', () => {
  const said = { outcome: 'failed', steps: [{ step: 's1', status: 'done', at: 1, endedAt: 2 }, { step: 's2', status: 'failed', at: 2, endedAt: 3 }] }
  assert.deepEqual(failedAt(said, three), { step: 's2', n: 2, title: 'Update the docs' })
  assert.equal(failedWords(failedAt(said, three)), 'Failed at step 2 · Update the docs')
  const stalled = { outcome: 'failed', reason: 'stalled', steps: [{ step: 's1', status: 'done', at: 1, endedAt: 2 }, { step: 's2', status: 'started', at: 2 }] }
  assert.equal(failedAt(stalled, three).step, 's2')
  // Every step ended and none failed: it broke after the last, and no box is the red one.
  const after = { outcome: 'failed', reason: 'error', steps: [{ step: 's1', status: 'done', at: 1, endedAt: 2 }] }
  assert.equal(failedWords(failedAt(after, three)), 'Failed after step 1 · Read the digest')
  assert.equal(pathOf(layoutFlow(three), three, after).failed, '')
  assert.equal(failedAt({ outcome: 'done', steps: [] }, three), null)
})

test('a failed run lights the path to its failed step and names that box', () => {
  const layout = layoutFlow(three)
  const run = { at: 1, by: 'trigger', outcome: 'failed', reason: 'error', steps: [{ step: 's1', status: 'done', at: 1, endedAt: 2 }, { step: 's2', status: 'started', at: 2 }] }
  const { lit, edges, failed, tone } = pathOf(layout, three, run)
  assert.equal(failed, 's:s2')
  assert.equal(tone, 'bad')
  assert.ok(edges.has('s:s1>s:s2'))
  assert.ok(!lit.has('s:s3'))
  assert.ok(!edges.has('s:s2>s:s3'))
})

test('a run that never got a session failed before it started: the trigger alone, and red', () => {
  const layout = layoutFlow(three)
  const run = { at: 1, by: 'trigger', outcome: 'failed', reason: 'preparation', steps: [] }
  assert.equal(failedWords(failedAt(run, three)), 'Failed before it started')
  const { lit, edges, failed } = pathOf(layout, three, run)
  assert.equal(failed, 'trigger')
  assert.deepEqual([...lit.keys()], ['trigger'])
  assert.equal(edges.size, 0)
})

test('typical times are the median of finished steps and done runs; a first run has none', () => {
  const MIN = 60_000
  const T = 1_700_000_000_000
  const past = (n, s1) => ({ runId: `r${n}`, at: T, endedAt: T + 10 * MIN, outcome: 'done', steps: [{ step: 's1', status: 'done', at: T, endedAt: T + s1 }] })
  const runs = [
    past(1, 2 * MIN),
    past(2, 4 * MIN),
    // A stalled run's step does not count, nor a failed run's length, nor a skipped step.
    { runId: 'r3', at: T, endedAt: T + 99 * MIN, outcome: 'failed', steps: [{ step: 's1', status: 'started', at: T }, { step: 's2', status: 'skipped', at: T, endedAt: T }] },
    past(4, 30 * MIN),
  ]
  const t = typicalTimes(runs)
  assert.equal(t.steps.get('s1'), 4 * MIN)
  assert.equal(t.run, 10 * MIN)
  assert.ok(!t.steps.has('s2'))
  const first = typicalTimes([{ runId: 'r1', at: T, outcome: 'running', steps: [{ step: 's1', status: 'started', at: T }] }])
  assert.equal(first.steps.size, 0)
  assert.equal(first.run, null)
  assert.equal(etaWords(T, null, T + 1), '')
  assert.equal(etaWords(T, MIN, T + 2 * MIN), 'over its usual 1m 00s')
  assert.match(etaWords(T, 2 * MIN, T + MIN), /^done ~/)
})

test('a running step says when it should be done, and a step ahead how long it usually takes', () => {
  const layout = layoutFlow(three)
  const MIN = 60_000
  const T = 1_700_000_000_000
  const run = { at: T, by: 'trigger', outcome: 'running', steps: [{ step: 's1', status: 'done', at: T, endedAt: T + MIN }, { step: 's2', status: 'started', at: T + MIN }] }
  const typical = { steps: new Map([['s2', 5 * MIN], ['s3', 3 * MIN]]), run: null }
  const { lit, ahead } = pathOf(layout, three, run, typical, T + 2 * MIN)
  assert.match(lit.get('s:s2').time, /^now · done ~/)
  assert.equal(lit.get('s:s1').time, '1m 00s')
  assert.equal(ahead.get('s:s3'), 'usually 3m 00s')
  assert.ok(!ahead.has('s:s1'))
  // With nothing to go on it says "now" as before; a run that ended has no estimates.
  assert.equal(pathOf(layout, three, run).lit.get('s:s2').time, 'now')
  assert.equal(pathOf(layout, three, { ...run, outcome: 'done' }, typical).ahead.size, 0)
})

test('a box is as tall as its measured text, never less than its least height, and its column makes room', () => {
  const r = {
    when: 'Every day at 11:30 PM',
    gate: null,
    steps: [
      { id: 's1', title: 'Short' },
      { id: 's2', title: 'Long', detail: 'many words '.repeat(30) },
    ],
  }
  const plain = layoutFlow(r)
  const measured = layoutFlow(r, undefined, undefined, (n) => (n.m && n.m.length > 100 ? 180 : 20))
  const long = measured.nodes.find((n) => n.id === 's:s2')
  const short = measured.nodes.find((n) => n.id === 's:s1')
  assert.equal(long.h, 180)
  assert.equal(short.h, plain.nodes.find((n) => n.id === 's:s1').h, 'a short box keeps its least height')
  assert.ok(measured.height >= 180)
  // Every edge still meets its boxes at their middles, whatever their heights.
  const byId = new Map(measured.nodes.map((n) => [n.id, n]))
  for (const e of measured.edges) {
    const a = byId.get(e.from)
    assert.ok(e.d.startsWith(`M${a.x + a.w} ${a.y + a.h / 2}`), e.id)
  }
})

test('every edge ends in an arrowhead on its box', () => {
  const r = {
    when: 'Weekdays at 4:15 PM',
    gate: null,
    steps: [
      { id: 'a', title: 'A', next: [{ to: 'b' }] },
      { id: 'b', title: 'B', next: [{ to: 'end:done', label: 'clean' }, { to: 'a', label: 'again' }] },
    ],
  }
  const { nodes, edges } = layoutFlow(r)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  for (const e of edges) {
    const b = byId.get(e.to)
    assert.ok(e.head, e.id)
    const [, x, y] = /^M(-?[\d.]+) (-?[\d.]+)/.exec(e.head).map(Number)
    const forward = Math.abs(x - b.x) < 0.01 && Math.abs(y - (b.y + b.h / 2)) < 0.01
    const back = Math.abs(x - (b.x + b.w / 2)) < 0.01 && Math.abs(y - (b.y + b.h)) < 0.01
    assert.ok(forward || back, `${e.id}'s arrowhead points at ${x},${y}, not at its box`)
  }
})

// ── a layout the person dragged (ui.md *The flow*, routines.md *Layouts*) ─────────────────

const chain = {
  when: 'Every day at 11:00 PM',
  gate: null,
  steps: [
    { id: 'a', title: 'A' },
    { id: 'b', title: 'B' },
    { id: 'c', title: 'C' },
  ],
}

/** Where an arrowhead's tip is, and the box side it touches: 'left', 'top' or 'bottom'. */
function tipOn(e, b) {
  const [, x, y] = /^M(-?[\d.]+) (-?[\d.]+)/.exec(e.head).map(Number)
  const near = (p, q) => Math.abs(p - q) < 0.01
  if (near(x, b.x) && near(y, b.y + b.h / 2)) return 'left'
  if (near(x, b.x + b.w) && near(y, b.y + b.h / 2)) return 'right'
  if (near(y, b.y) && x >= b.x && x <= b.x + b.w) return 'top'
  if (near(y, b.y + b.h) && x >= b.x && x <= b.x + b.w) return 'bottom'
  return `nowhere (${x},${y})`
}

test('a saved box sits where it was left, the rest keep their automatic places, and an unknown id is ignored', () => {
  const auto = layoutFlow(chain)
  const where = (l) => new Map(l.nodes.map((n) => [n.id, [n.x, n.y]]))
  const saved = { 's:b': { x: 40, y: 400 }, 's:gone': { x: 9, y: 9 }, gate: { x: 1, y: 1 } }
  const placed = layoutFlow(chain, undefined, undefined, null, saved)
  const a = where(auto)
  const p = where(placed)
  assert.deepEqual(p.get('s:b'), [40, 400])
  for (const id of ['trigger', 's:a', 's:c', 'end:done']) assert.deepEqual(p.get(id), a.get(id), id)
  assert.ok(!placed.nodes.some((n) => n.id === 's:gone' || n.id === 'gate'))
  assert.ok(placed.nodes.find((n) => n.id === 's:b').placed)
  // A step added since the layout was saved lands where the automatic layout puts it.
  const four = { ...chain, steps: [...chain.steps, { id: 'd', title: 'D' }] }
  const grown = where(layoutFlow(four, undefined, undefined, null, saved))
  assert.deepEqual(grown.get('s:d'), where(layoutFlow(four)).get('s:d'))
})

test('with nothing saved, the drawing is the automatic one', () => {
  const r = { ...chain, steps: [{ id: 'a', title: 'A', next: [{ to: 'b' }] }, { id: 'b', title: 'B', next: [{ to: 'end:done' }, { to: 'a', label: 'again' }] }] }
  const auto = layoutFlow(r)
  const none = layoutFlow(r, undefined, undefined, null, {})
  assert.deepEqual(
    none.edges.map((e) => [e.d, e.head]),
    auto.edges.map((e) => [e.d, e.head])
  )
  // Today's forward arrow: right side to left side, bending half a gap short of the target.
  const ab = auto.edges.find((e) => e.id === 's:a>s:b')
  const b = auto.nodes.find((n) => n.id === 's:b')
  assert.equal(tipOn(ab, b), 'left')
  // The loop's closing arrow still goes under and up into its box from below.
  const back = auto.edges.find((e) => e.id === 's:b>s:a')
  assert.equal(tipOn(back, auto.nodes.find((n) => n.id === 's:a')), 'bottom')
})

test('a box dragged left of its source is reached from the side facing it: out of the left, into the right — with its label on the route', () => {
  const r = { ...chain, steps: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B', next: [{ to: 'end:done', label: 'clean' }] }] }
  const auto = layoutFlow(r)
  const a = auto.nodes.find((n) => n.id === 's:a')
  // The ending, dragged to the left of the step that leads to it, level with it.
  const layout = layoutFlow(r, undefined, undefined, null, { 'end:done': { x: a.x - 300, y: a.y } })
  const end = layout.nodes.find((n) => n.id === 'end:done')
  const src = layout.nodes.find((n) => n.id === 's:b')
  const e = layout.edges.find((x) => x.id === 's:b>end:done')
  assert.equal(tipOn(e, end), 'right')
  const [, sx, sy] = /^M(-?[\d.]+) (-?[\d.]+)/.exec(e.d).map(Number)
  assert.equal(sx, src.x, 'leaves from the source’s left side')
  assert.equal(sy, src.y + src.h / 2)
  assert.ok(e.lx > end.x + end.w && e.lx < src.x, `label at ${e.lx},${e.ly}`)
  assert.ok(!/NaN|Infinity/.test(e.d + e.head))
})

test('a box dragged under or over its source is reached from the side facing it', () => {
  const auto = layoutFlow(chain)
  const a = auto.nodes.find((n) => n.id === 's:a')
  const below = layoutFlow(chain, undefined, undefined, null, { 's:b': { x: a.x + 30, y: a.y + a.h + 120 } })
  const e1 = below.edges.find((e) => e.id === 's:a>s:b')
  assert.equal(tipOn(e1, below.nodes.find((n) => n.id === 's:b')), 'top')
  const above = layoutFlow(chain, undefined, undefined, null, { 's:b': { x: a.x, y: a.y - a.h - 120 } })
  const e2 = above.edges.find((e) => e.id === 's:a>s:b')
  assert.equal(tipOn(e2, above.nodes.find((n) => n.id === 's:b')), 'bottom')
  assert.match(e2.d, /^M[\d.-]+ [\d.-]+ V[\d.-]+$/, 'straight up when the centres line up')
})

test('bounds take in every box, one dragged to negative coordinates included', () => {
  const layout = layoutFlow(chain, undefined, undefined, null, { 's:c': { x: -500, y: -320 } })
  const { x, y, w, h } = layout.bounds
  for (const n of layout.nodes) {
    assert.ok(n.x >= x && n.y >= y && n.x + n.w <= x + w && n.y + n.h <= y + h, n.id)
  }
  assert.ok(x <= -500 && y <= -320)
  assert.equal(layout.width, w)
})

test('routing one box again moves only its arrows, and a path still lights on a dragged layout', () => {
  const layout = layoutFlow(chain)
  const before = new Map(layout.edges.map((e) => [e.id, e.d]))
  const b = layout.nodes.find((n) => n.id === 's:b')
  Object.assign(b, { x: b.x, y: b.y + 200, placed: true })
  routeEdges(layout, 's:b')
  for (const e of layout.edges) {
    const touches = e.from === 's:b' || e.to === 's:b'
    assert.equal(e.d !== before.get(e.id), touches, e.id)
  }
  const run = { outcome: 'done', by: 'trigger', at: 1, steps: [{ step: 'a', status: 'done' }, { step: 'b', status: 'done' }, { step: 'c', status: 'done' }] }
  const { edges } = pathOf(layoutFlow(chain, undefined, undefined, null, { 's:b': { x: 0, y: 500 } }), chain, run)
  assert.ok(edges.has('s:a>s:b') && edges.has('s:c>end:done'))
})

test('the approval card draws the page’s layout scaled to its smaller boxes', () => {
  const COMPACT = { nodeW: 150, nodeH: 60, endW: 120, endH: 48, gapX: 34, gapY: 14 }
  const saved = { 's:b': { x: 256, y: 86 } }
  const card = layoutFlow(chain, undefined, COMPACT, null, saved)
  const b = card.nodes.find((n) => n.id === 's:b')
  assert.equal(b.x, 184)
  assert.equal(b.y, 74)
  assert.equal(GRID, 8)
})

test('a layout compares by its boxes, not the order of its keys', () => {
  assert.equal(layoutKey(null), '')
  assert.equal(layoutKey({}), '')
  assert.equal(layoutKey({ a: { x: 1, y: 2 }, b: { x: 3, y: 4 } }), layoutKey({ b: { x: 3, y: 4 }, a: { x: 1, y: 2 } }))
  assert.notEqual(layoutKey({ a: { x: 1, y: 2 } }), layoutKey({ a: { x: 1, y: 3 } }))
})

test('Shift lines a dragged box up, centre to centre, with a box it is joined to — never with one it is not', () => {
  const r = {
    when: 'Every day at 11:30 PM',
    gate: null,
    steps: [
      { id: 'a', title: 'A', next: [{ to: 'b' }] },
      { id: 'b', title: 'B', next: [{ to: 'end:done' }] },
    ],
  }
  const layout = layoutFlow(r)
  const a = layout.nodes.find((n) => n.id === 's:a')
  const b = layout.nodes.find((n) => n.id === 's:b')
  // B dragged 30px below level with A: lined up level, so the arrow between them is straight.
  const lined = alignTo(layout, b, b.x + 40, a.y + (a.h - b.h) / 2 + 30)
  assert.equal(lined.y + b.h / 2, a.y + a.h / 2)
  assert.ok(lined.guides.some((g) => g.axis === 'h' && g.at === a.y + a.h / 2))
  // Out of reach: left where it was put.
  const far = alignTo(layout, b, b.x + 40, a.y + 500)
  assert.equal(far.y, a.y + 500)
  // The trigger is not joined to B: nothing lines B up with it.
  const t = layout.nodes.find((n) => n.id === 'trigger')
  const near = alignTo(layout, b, t.x + 3, b.y + 400)
  assert.ok(!near.guides.some((g) => g.axis === 'v' && g.at === t.x + t.w / 2))
})
