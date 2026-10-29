// A chat list row (src/ui/chat-list.js) quoting a routine run that came back needing you: the
// quote is the run's own words and the thread has no ask. Reading the ask's kind there threw,
// and every roster push drew no list at all (2026-10-15).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChatList, statusWords } from '../src/ui/chat-list.js'

const list = () => new ChatList({ addEventListener() {} }, {})

test('a routine run that needs you is quoted from its run, with no ask on the thread', () => {
  const l = list()
  l.routines.set('r1', { lastRun: { outcome: 'needs-you', text: 'Which branch should I merge?' } })
  const now = Date.now()
  const t = { id: 't1', title: 'Nightly docs', routine: { id: 'r1', name: 'Nightly docs' }, unread: true, lastActivityAt: now, ask: null }
  const html = l.row(t, null, now)
  assert.match(html, /Which branch should I merge\?/)
  assert.doesNotMatch(html, /class="q perm"/)
})

test('a permission ask is still quoted as one', () => {
  const now = Date.now()
  const t = { id: 't2', title: 'Fix', unread: true, lastActivityAt: now, ask: { kind: 'permission', head: 'Bash: ls' } }
  assert.match(list().row(t, null, now), /class="q perm"/)
})

// The two-line row (ui.md *Chat list*): the status beside the time, where on the second line
// with no branch or model, and nothing there for a chat with no repo.
const ws = (repos, extra = {}) => ({ id: 'w1', name: 'Chat Oct 15', repos, ...extra })
const line = (html, cls) => new RegExp(`<div class="${cls}">([\\s\\S]*?)</div>`).exec(html)?.[1] ?? ''

test('a working chat says its tool beside the time, the detail in the hover', () => {
  const now = Date.now()
  const t = { id: 't3', title: 'Lists', running: true, activity: 'Running Agent: Find chat list code', lastActivityAt: now - 120000, workspace: ws([]) }
  const right = /<span class="trail">(.*?)<\/span><\/div>/.exec(list().row(t, null, now))?.[1] ?? ''
  assert.match(right, /title="Running Agent: Find chat list code">Running Agent</)
  assert.match(right, /<span class="when">2m<\/span>/)
})

test('a subagent wait and a stall are said short', () => {
  const t = { activity: 'Waiting on the trader subagent' }
  assert.equal(statusWords(t, 'working', '').short, 'Waiting on subagent')
  const now = Date.now()
  const s = statusWords({ retry: { nextAt: now + 42 * 60000 } }, 'stalled', '', now)
  assert.equal(s.short, 'Stalled · restarts 42m')
  assert.equal(statusWords({}, 'idle', '').short, '')
})

test('aging is an hourglass on the time only in its last day before archiving, its words in the hover', () => {
  const now = Date.now()
  const day = 86400000
  const at = (archiveDays, idleDays, left) => ({ id: 't4', title: 'Old', lastActivityAt: now, workspace: ws([], { aging: { archiveDays, idleDays, archiveAt: now + left } }) })
  assert.match(list().row(at(5, 4, day), null, now), /<span class="age" title="idle 4d · ages out tomorrow">⌛<\/span><span class="when">/)
  assert.doesNotMatch(list().row(at(14, 4, 10 * day), null, now), /class="age"/)
  // Archiving at three days: a chat idle one day of the three is not yet in its last day.
  assert.doesNotMatch(list().row(at(3, 1, 2 * day - 1), null, now), /class="age"/)
  assert.match(list().row(at(3, 2, day - 1), null, now), /class="age"/)
  // Quicker than three days, the window is the last third: eight hours of a one-day setting.
  assert.doesNotMatch(list().row(at(1, 0, 10 * 3600000), null, now), /class="age"/)
  assert.match(list().row(at(1, 0, 6 * 3600000), null, now), /class="age"/)
})

test('kept and aged out are no hourglass, only words in the row hover', () => {
  const now = Date.now()
  const kept = { id: 't4k', title: 'Old', lastActivityAt: now, workspace: ws([], { aging: { kept: true } }) }
  const html = list().row(kept, null, now)
  assert.doesNotMatch(html, /class="age"/)
  assert.match(html, /title="[^"]*Kept — has unpushed work/)
  const aged = { ...kept, workspace: ws([], { aging: { aged: true } }) }
  assert.doesNotMatch(list().row(aged, null, now), /class="age"/)
})

test('every row leads with the agent slot over the shell slot, the shell slot empty when nothing runs', () => {
  const now = Date.now()
  const idle = { id: 't9', title: 'Quiet', lastActivityAt: now, workspace: ws([]) }
  assert.match(list().row(idle, null, now), /<span class="lead"><i class="mark idle"><\/i><i class="bg-mark"><\/i><\/span>/)
  const busy = { ...idle, backgroundTasks: [{ id: 'b1', description: 'dev server' }, { id: 'b2' }] }
  assert.match(list().row(busy, null, now), /<span class="lead"><i class="mark idle"><\/i><span class="bg-mark" title="2 running in the background:[^"]*"[^>]*><svg[\s\S]*?<b>2<\/b><\/span><\/span>/)
  const l = list()
  l.set([], null, [{ id: 'w2', name: 'Starting', status: 'preparing' }])
  assert.match(l.el.innerHTML, /<span class="lead"><i class="mark working m-spin">[\s\S]*?<\/i><i class="bg-mark"><\/i><\/span>/)
})

test('several repos are the first and +N, each with its branch in the hover; no branch or model on the row', () => {
  const now = Date.now()
  const repos = [{ id: 'outpost', branch: 'outpost/cards' }, { id: 'website-docs', branch: '' }, { id: 'ops', branch: 'main' }]
  const t = { id: 't5', title: 'Cards', model: 'claude-opus-5-5', preview: 'Two-line cards', lastActivityAt: now, workspace: ws(repos) }
  const html = list().row(t, null, now)
  const s = line(html, 's')
  assert.match(s, /title="outpost @ outpost\/cards\nwebsite-docs @ no branch yet\nops @ main"/)
  assert.match(s, /<span class="chip">outpost<\/span><span class="chip more">\+2<\/span>/)
  assert.doesNotMatch(s, />outpost\/cards</)
  assert.doesNotMatch(html, /class="m"/)
  assert.match(html, /title="Two-line cards\n[^"]+"/)
})

test('an unpushed repo is outlined, and +N is when a repo it hides is', () => {
  const now = Date.now()
  const row = (repos) => line(list().row({ id: 't9', title: 'U', lastActivityAt: now, workspace: ws(repos) }, null, now), 's')
  assert.match(row([{ id: 'outpost', unpushed: true }]), /<span class="chip unpushed">outpost<\/span>/)
  assert.match(row([{ id: 'outpost' }, { id: 'ops', unpushed: true }]), /<span class="chip">outpost<\/span><span class="chip more unpushed">\+1<\/span>/)
  assert.doesNotMatch(row([{ id: 'outpost' }, { id: 'ops' }]), /unpushed/)
})

test('a chat with no repo has a blank second line, or only its routine', () => {
  const now = Date.now()
  const plain = { id: 't6', title: 'Chat', project: 'Chat Oct 15', lastActivityAt: now, workspace: ws([]) }
  assert.doesNotMatch(line(list().row(plain, null, now), 's'), /chip/)
  const run = { ...plain, id: 't7', routine: { id: 'r1', name: 'Nightly docs' } }
  const chips = line(list().row(run, null, now), 's').match(/class="chip[^"]*"/g)
  assert.deepEqual(chips, ['class="chip r"'])
})

// The status mark (marks.js) in place of the dot: one glyph per state that differs in kind, an
// empty slot for the rest, so a ? reads the same here as in the routines list.
const markOf = (html) => /<i class="mark ([^"]*)"/.exec(html)?.[1] ?? null

test('each status gets its mark, and idle and dormant an empty slot', () => {
  const now = Date.now()
  const base = { id: 't8', title: 'Marks', lastActivityAt: now }
  const cases = [
    [{ running: true }, 'working m-spin'],
    [{ unread: true }, 'waiting m-ask'],
    [{ hasError: true }, 'blocked m-error'],
    [{ stalled: true }, 'stalled m-paused'],
    [{ done: true }, 'done m-check'],
    [{}, 'idle'],
    [{ lastActivityAt: now - 30 * 86400000 }, 'sleeping'],
  ]
  for (const [extra, cls] of cases) assert.equal(markOf(list().row({ ...base, ...extra }, null, now)), cls, JSON.stringify(extra))
})

test('an asleep chat wears no "zz"; that it is asleep is in the row hover', () => {
  const now = Date.now()
  const t = { id: 't9', title: 'Nap', preview: 'About naps', structured: true, canSend: false, lastActivityAt: now }
  const html = list().row(t, null, now)
  assert.doesNotMatch(html, /zz|dot-box/)
  assert.equal(markOf(html), 'idle')
  assert.match(html, /<button class="chat idle"[^>]* title="About naps\nAsleep — its session has ended; your next message wakes it">/)
})

test('a merged PR shows the check only while its turn is unopened, and keeps its row class', () => {
  const now = Date.now()
  const t = { id: 't10', title: 'Merged', prState: 'MERGED', lastActivityAt: now }
  const open = list().row(t, null, now)
  assert.match(open, /<button class="chat celebrating"/)
  assert.equal(markOf(open), 'idle')
  assert.equal(markOf(list().row({ ...t, done: true }, null, now)), 'done m-check')
})

test('a Starting row is the working mark, a failed one the error mark, and neither a trailing spinner', () => {
  const el = { addEventListener() {}, innerHTML: '' }
  const l = new ChatList(el, {})
  l.set([], null, [{ id: 'w1', name: 'Prep', status: 'preparing' }, { id: 'w2', name: 'Broke', status: 'failed', error: 'no disk' }])
  const [prep, failed] = el.innerHTML.split('<button').slice(1)
  assert.equal(markOf(prep), 'working m-spin')
  assert.equal(markOf(failed), 'blocked m-error')
  for (const row of [prep, failed]) assert.doesNotMatch(row, /<\/div><span class="spin"><\/span><\/button>/)
  assert.doesNotMatch(failed, /class="spin"/)
})
