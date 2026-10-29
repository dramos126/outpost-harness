/**
 * The conversation panel: what a session has said, drawn as chat, kept live — and, where the
 * launcher allows, the place you talk back.
 *
 * Reads the transcript the harness already writes. It tails rather than reloads: every poll
 * asks the server for what came after the offset it was last given, and appends.
 *
 * Tool calls are not in the log. A session's transcript is mostly tool traffic, and drawing
 * each call inline buries the two sentences the model actually said. They go to the Activity
 * panel (activity.js) in groups — a group is the run of calls between two things somebody
 * said — and the log keeps a "N steps" marker where each run was, which lists the run's calls
 * in place, one line each, every line opening its row in the panel. A result arrives as its own item and is patched into its row over there,
 * because when the file is being tailed it usually lands in a later read than the call.
 *
 * What you can do to a session depends on whether its unit is running. A running one can
 * be typed to, answered, and interrupted; one whose unit is gone can be resumed. The panel
 * shows only the controls that apply, and none where the launcher cannot act.
 */
import {
  addRepoToChat,
  applyRescan,
  registerRepoToChat,
  rescanRepo,
  scanRepo,
  fetchImage,
  fetchTranscript,
  fetchPrompt,
  sendPrompt,
  respondPrompt,
  pickOption,
  interruptThread,
  restartThread,
  resumeThread,
  uploadFile,
  fetchModels,
  setThreadModel,
  fetchEfforts,
  setThreadEffort,
  renameThread,
  askHandoff,
  cancelHandoff,
  dismissHandoff,
  fetchHandoff,
  goAway,
  comeBack,
} from '../api.js'
import { FlowView, stepNode } from './flow.js'
import { diffLines } from './diff.js'
import { modelLabel, currentModelIndex } from './models.js'
import { copyString, renderMarkdown } from './markdown.js'
import { ICON, isPhone } from './shell.js'
import { localizeResets, when } from './when.js'
import { DEFINING_PLACEHOLDER, definingWords } from '../state/threads.js'
import { HANDOFF_LEAD, HANDOFF_TRIGGER, cutHandoff, handoffChoice, handoffSections, handoffState, handoffWaits } from '../state/handoff.js'

/**
 * The safety net under the push channel. The server says when a thread moved and the page
 * re-tails on that (`nudge`), so this is only for a session whose transcript grows with no
 * hook to say so and no roster change to notice it by — and for a stream that is down.
 */
const POLL_MS = 10000

/**
 * How long a queued message outlives its turn before the page stops waiting for it. A turn
 * that ends takes the queue straight into the next one, so the real message is in the
 * transcript well inside this; the grace covers the roster saying "at rest" a beat early.
 */
const QUEUED_GRACE_MS = 30000
/** How close to the bottom counts as "reading the latest" — appends then keep you there. */
const STICK_PX = 48
/**
 * One page of history, in transcript bytes: the first load and each page read on the way up.
 * Most of a transcript is tool traffic, so this is some fifty items; a chat with three
 * earlier conversations drew some 1,400 on open, each one a Markdown render or an Activity row.
 */
const PAGE_BYTES = 256 * 1024
/** Results held for calls not drawn yet (`patchResult`); a page boundary cuts a handful. */
const ORPHANS_MAX = 500
/** A message of yours past either of these is drawn clamped to three lines (`clampPaste`). */
const PASTE_LINES = 8
const PASTE_CHARS = 600
/** The top of an empty log: the one-line note, then the way to earlier pages, which go under it. */
const LOG_HEAD = '<div class="note" hidden></div><button type="button" class="more" hidden></button>'

/** A coarse pointer and no hover: a phone or a tablet, where Enter should not send. */
const TOUCH = typeof matchMedia === 'function' && matchMedia('(pointer: coarse) and (hover: none)').matches

/** How far the log must travel one way before a phone's header folds or unfolds: a jitter is not a scroll. */
const COLLAPSE_PX = 24
/** The fold's transition (styles.css) and a little over: the log's resize under it moves the scroll, which is not the reader's. */
const FOLD_HOLD_MS = 260

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/**
 * What Outpost is willing to say about a dead turn, per class (hooks.md owns the classes).
 *
 * Each is advice, not a diagnosis: the point of splitting `StopFailure` at all was that "try
 * it again in a bit" and "go and fix your billing" had been telling you the same thing. The
 * transient line stops short of "it will resume" on purpose — Claude Code ends the turn
 * either way, and the session really is sitting dead at its prompt until somebody re-sends.
 */
const FAILURE_ADVICE = {
  transient: 'The turn stopped on something temporary — sending it again later should work.',
  account: 'The turn stopped on your account, not on this session. No retry will help until it is sorted.',
  turn: 'The turn itself failed. Sending the same thing again will fail the same way.',
}

/** The header's failure tag: what it died of, with the API's own words behind the hover. */
const failureTag = (failure) => {
  const advice = FAILURE_ADVICE[failure.class] || FAILURE_ADVICE.turn
  const title = [advice, failure.detail].filter(Boolean).join('\n\n')
  return `<span class="tag fail ${escape(failure.class)}" title="${escape(title)}">${escape(failure.label)}</span>`
}

/** "in 42m", "in 2h 10m" — a wait measured in tens of minutes, so seconds are noise. */
const until = (ts) => {
  const mins = Math.max(0, Math.round((ts - Date.now()) / 60000))
  if (mins < 1) return 'any moment'
  if (mins < 60) return `in ${mins}m`
  return `in ${Math.floor(mins / 60)}h ${mins % 60}m`
}

/**
 * What the supervisor intends to do about this one. Three states worth distinguishing, and
 * the last is the one that needs a person: a countdown, a spent budget, and the case where
 * nothing is scheduled at all because the failure was never the retryable kind.
 */
const retryTag = (retry) => {
  if (!retry) return ''
  const max = retry.max || 5
  const spent = `${retry.attempts} of ${max} attempts used`
  // Held after a limit reset (resilience.md): nothing is scheduled; the person chooses.
  if (retry.held) return `<span class="tag retry" title="The plan limit has reset, but this chat carries ${exact(retry.heldContext)} tokens of context, above red, so Outpost did not send it on: resuming rewrites all of it at full price. Resume it, or start fresh from its handoff.">held · limit reset</span>`
  if (retry.exhausted) {
    // Escaped: the error is the session's own text, and a quote in it would end the attribute.
    const why = retry.lastError ? `\n\n${escape(retry.lastError)}` : ''
    return `<span class="tag retry spent" title="Outpost has stopped trying — ${spent}.${why}">gave up · ${retry.attempts}/${max}</span>`
  }
  if (!retry.nextAt) return ''
  return `<span class="tag retry" title="Restarting automatically — ${escape(retry.why)}. ${spent}.">restarts ${escape(until(retry.nextAt))}</span>`
}

const CARD_TITLE = { create: 'New routine', update: 'Change to a routine', delete: 'Delete this routine?' }

/** A next run in the viewer's own zone: "Mon 6 Oct, 4:15 PM", in the browser's locale. */
const RUN_AT = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })

/**
 * The card's routine as flow.js reads one: its trigger in words, the gate as the server's words
 * (or none), and the steps with each one's `next`, as the store keeps them.
 */
const cardRoutine = (card, when) => ({
  when,
  triggers: card.tz ? [{ tz: card.tz }] : [],
  gate: card.gate || null,
  steps: card.steps,
})

/**
 * The boxes an update changes, read off `changes` (routines-tools.md, *Made from a chat*): the
 * trigger for a new time or zone, the gate for a new gate, and each step whose title the old
 * steps did not have — the server gives the old steps as their titles joined by " → ".
 */
function changedBoxes(card) {
  const out = new Set()
  for (const c of card.changes || []) {
    if (c.field === 'when' || c.field === 'timezone') out.add('trigger')
    if (c.field === 'gate') out.add('gate')
    if (c.field === 'steps') {
      const was = new Set(String(c.from || '').split(' → '))
      for (const st of card.steps || []) if (!was.has(st.title)) out.add(stepNode(st.id))
    }
  }
  return out
}

/** A change too long to read inline: over this, or more than one line, it folds to a count. */
const LONG_CHANGE = 120

/**
 * One line of an update's changes. A short one reads "field: from → to"; a long one — a prompt,
 * most often — folds to its counts and opens on what moved: the changed lines with one line of
 * context around each run, the rest elided. Printed whole, old and new, a prompt pushed Allow
 * and Deny off the screen (the owner's, 2026-10-15).
 */
function changeHtml(c) {
  const from = String(c.from ?? '')
  const to = String(c.to ?? '')
  if (from.length + to.length <= LONG_CHANGE && !/\n/.test(from + to)) return `<li><b>${escape(c.field)}</b>: ${escape(from)} → ${escape(to)}</li>`
  const diff = diffLines(from, to)
  const added = diff.filter((d) => d.op === '+').length
  const removed = diff.filter((d) => d.op === '-').length
  const near = (k) => diff.slice(Math.max(0, k - 1), k + 2).some((d) => d.op !== ' ')
  const rows = []
  let gap = false
  diff.forEach((d, k) => {
    if (d.op === ' ' && !near(k)) {
      if (!gap) rows.push('<div class="dl gap">…</div>')
      gap = true
      return
    }
    gap = false
    rows.push(`<div class="dl ${d.op === '+' ? 'add' : d.op === '-' ? 'del' : ''}">${escape(d.text) || '&nbsp;'}</div>`)
  })
  return (
    `<li class="long"><details><summary><b>${escape(c.field)}</b> changed · ` +
    `<span class="add">+${added}</span> <span class="del">−${removed}</span> · show changes</summary>` +
    `<div class="diff">${rows.join('')}</div></details></li>`
  )
}

/**
 * Fill (or empty and hide) the routine card in the permission bar (routines.md): what will
 * be saved, drawn as a wireframe of the routine rather than the tool's input. Its trigger, gate,
 * steps and endings are the routine page's flow (flow.js), small, on a canvas that pans and
 * zooms when it does not fit, its boxes where the routine's page has them; an update outlines
 * the boxes it changes. The next runs
 * are in the viewer's zone, and say so when that is not the routine's: a cron read in the
 * wrong timezone shows as runs at the wrong hour here, before Approve, not on the first run.
 * Every field is the server's text, so every one is escaped.
 */
/** The list drawn once in full: a chat that moved a folder of runs names hundreds, and the bar scrolls. */
const FILES_SHOWN = 200

/**
 * The files Outpost asks to remove from a dataset's source (`card.kind === 'files'`,
 * workspaces/index.mjs): a title and every path, so the yes is given to a list read, not a
 * count. Left as painted on a repeat of the same card, like the routine's, so the list stays
 * where it was scrolled to.
 */
function paintFiles(el, card) {
  el.hidden = !card
  const key = card ? JSON.stringify(card) : ''
  if (el.dataset.key === key) return
  el.dataset.key = key
  if (!card) {
    el.innerHTML = ''
    return
  }
  const files = Array.isArray(card.files) ? card.files : []
  const more = files.length - FILES_SHOWN
  el.innerHTML =
    `<div class="t">${escape(card.title || '')}</div>` +
    `<ul>${files.slice(0, FILES_SHOWN).map((f) => `<li>${escape(f)}</li>`).join('')}</ul>` +
    (more > 0 ? `<div class="more">…and ${more} more</div>` : '')
}

function paintCard(el, card) {
  el.hidden = !card
  // Every poll of the bar repaints; the same card left as it is keeps the prompt box where the
  // person scrolled it, rather than throwing them back to its top every few seconds.
  const key = card ? JSON.stringify(card) : ''
  if (el.dataset.key === key) return
  el.dataset.key = key
  // The last card's canvas watches its size; it goes with the card.
  el._flow?.destroy()
  el._flow = null
  if (!card) {
    el.innerHTML = ''
    return
  }
  const mine = Intl.DateTimeFormat().resolvedOptions().timeZone
  const yours = card.tz && card.tz !== mine ? ` your time (${mine})` : ''
  const next = (card.next || []).map((ms) => RUN_AT.format(new Date(ms)))
  // A one-shot's single run is its "when": "Once, Mon, Oct 5, 12:00 PM" rather than "Once · …
  // · next Mon, Oct 5, 12:00 PM", which said the one time twice over.
  const once = card.when === 'Once' && next.length === 1
  const when = once
    ? escape([`Once, ${next[0]}${yours}`, card.tz].join(' · '))
    : `${escape([card.when, card.tz].filter(Boolean).join(' · '))} · ${
        next.length ? escape(`next${yours ? `, in${yours}:` : ''} ${next.join(' · ')}`) : '<span class="warn">will not run again</span>'
      }`
  const steps = Array.isArray(card.steps) ? card.steps : []
  // Steps are drawn, so their change says what they were; "a → b → c" → "d → e" read as one
  // more arrow chain beside the flow's own.
  const changes = (card.changes || [])
    .map((c) =>
      c.field === 'steps' && steps.length
        ? `<li><b>steps</b>: were ${escape(c.from)} — new or changed ones are outlined below</li>`
        : changeHtml(c)
    )
    .join('')
  // An update's prompt is folded: what moved in it is in the changes above, and the whole of it
  // stays a click away. A new routine's is open, since all of it is what is being approved.
  const prompt = card.prompt
    ? card.action === 'create'
      ? `<div class="p">${escape(card.prompt)}</div>`
      : `<details class="pd"><summary>The prompt a run is given · ${String(card.prompt).split('\n').length} lines</summary><div class="p">${escape(card.prompt)}</div></details>`
    : ''
  el.className = `sched-card${card.action === 'delete' ? ' delete' : ''}`
  el.innerHTML =
    `<div class="t">${escape(CARD_TITLE[card.action] || 'Routine')}</div>` +
    `<div class="n">${escape(card.name)}</div>` +
    // Whose routine this is (update and delete only): the bar hides the question that also
    // says it, so without this line a chat reworking another's run reads like one tidying its own.
    (card.madeBy ? `<div class="l${card.madeBy === 'Made by this chat' ? '' : ' warn'}">${escape(card.madeBy)}</div>` : '') +
    `<div class="l">${when}</div>` +
    `<div class="l">${escape([(card.repos || []).join(', '), card.model || 'default model', card.mayDo].filter(Boolean).join(' · '))}</div>` +
    (changes ? `<ul class="chg">${changes}</ul>` : '') +
    (steps.length ? `<div class="card-flow"></div>` : '') +
    prompt +
    (card.results ? `<div class="l">Results → ${escape(card.results)}</div>` : '')
  if (!steps.length) return
  // Fit no larger than life: a two-step routine blown up fills the bar for nothing.
  el._flow = new FlowView(el.querySelector('.card-flow'), { fitMax: 1, wheel: 'pinch', compact: true })
  // Drawn as its page lays it out (`card.layout`, routines.md *Layouts*), and never dragged here.
  el._flow.draw(cardRoutine(card, once ? `Once, ${next[0]}` : card.when), undefined, card.layout || null)
  el._flow.mark(changedBoxes(card))
}

/** "just now", "14m ago", "2h 5m ago" — a handoff's age, the thing that says whether it still fits. */
const ago = (ts) => {
  const m = Math.round((Date.now() - ts) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  if (m < 24 * 60) return `${Math.floor(m / 60)}h ${m % 60}m ago`
  return when(ts)
}

/** The prompt cache's lifetime (usage.md `cold`): a message after it re-sends the whole context. */
const CACHE_TTL_MS = 60 * 60_000

/** "8s", "2m 14s", "1h 3m" — how long a run of steps took. */
const span = (ms) => {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** "152k", "1M" — a context to the thousand; the exact figure is in the hover. */
const kTokens = (n) => (n >= 1e6 ? `${Number((n / 1e6).toFixed(1))}M` : `${Math.max(1, Math.round(n / 1000))}k`)

const exact = (n) => Number(n || 0).toLocaleString('en-US')

/**
 * How large a context is against the thresholds in force (`contextLimits` on the roster): ''
 * below orange, 'warn', or 'alert'. Each band starts at its token count or its share of the
 * model's window, whichever comes first; with no window known, at the token count alone. No
 * limits — a settings file the server could not read — is no colour rather than a guess.
 */
const contextLevel = (tokens, window, limits) => {
  if (!limits || !tokens) return ''
  const over = (count, share) => tokens >= count || (window > 0 && tokens >= share * window)
  if (over(limits.alertTokens, limits.alertShare)) return 'alert'
  if (over(limits.warnTokens, limits.warnShare)) return 'warn'
  return ''
}

/** The thresholds in force, in words, for the context bar's hover. */
const limitsText = (window, limits) => {
  if (!limits) return 'No thresholds — the settings could not be read.'
  const pct = (s) => `${Math.round(s * 100)}%`
  if (!window) return `Orange from ${kTokens(limits.warnTokens)}, red from ${kTokens(limits.alertTokens)}. The model's context window is not known yet — the session reports it as a turn ends — so the token counts alone apply.`
  return `Orange from ${kTokens(limits.warnTokens)} or ${pct(limits.warnShare)} of the ${kTokens(window)} window, red from ${kTokens(limits.alertTokens)} or ${pct(limits.alertShare)} — whichever comes first.`
}

/**
 * What `/away` did, in a sentence for a toast (handoff.md): for one chat, what happened and
 * why; for all, a count of each outcome. `results` is the server's `[{ outcome, why }]`.
 */
export function awaySummary(results = [], all = false) {
  if (!all) {
    const r = results[0]
    if (!r) return 'Nothing to do'
    if (r.outcome === 'asked') return 'Away — the session is committing its work and writing its handoff'
    if (r.outcome === 'marked') return 'Away — its handoff is asked for the moment this turn ends'
    if (r.outcome === 'skipped') return `Nothing to hand off: ${r.why}`
    return `Could not ask for a handoff: ${r.why}`
  }
  const n = (k) => results.filter((r) => r.outcome === k).length
  const bits = []
  if (n('asked')) bits.push(`${n('asked')} writing a handoff`)
  if (n('marked')) bits.push(`${n('marked')} when their turn ends`)
  if (n('skipped')) bits.push(`${n('skipped')} left as they are`)
  if (n('refused')) bits.push(`${n('refused')} could not be asked`)
  return bits.length ? `Away: ${bits.join(', ')}` : 'Away: no chat has a running session'
}

/** The `/away` toast's outcome words, after each chat's name. */
const AWAY_WORDS = { asked: 'writing its handoff', marked: 'when its turn ends', refused: 'could not be asked' }
/** How many chats `/away all`'s toast names; its sentence has the counts of all of them. */
const AWAY_LINKS = 8

/**
 * `/away all`'s chats as lines for its toast, `[{ id, label }]`: each it asked or marked, and
 * each it could not ask with why, up to `AWAY_LINKS`; those it left as they were are only
 * counted. Each line opens its chat.
 */
export function awayLinks(results = []) {
  const named = results.filter((r) => r.id && r.outcome !== 'skipped')
  return named.slice(0, AWAY_LINKS).map((r) => ({ id: r.id, label: `${r.title || 'Untitled'} — ${AWAY_WORDS[r.outcome] || r.outcome}${r.outcome === 'refused' && r.why ? `: ${r.why}` : ''}` }))
}

export class Conversation {
  /**
   * `onClose()` is the ✕ — the caller owns selection, not this panel. `onToast(msg, kind)`
   * is how the panel reports; `onActed()` says "something changed, poll soon"; `onRight()`
   * toggles the details column and `onSteps(group, id)` opens it on a group of tool calls, or
   * on one call's row given its id;
   * `activity` is the panel the calls themselves go to; `onAgents()` opens the agent map and
   * `onCommands()` the commands map;
   * `onArchive()` is the page's, because it is one press from something irreversible and the
   * confirm in front of it belongs to one place; `onCancel()` takes that confirm down.
   * `onContext()` opens the Workspace section, where the chat's token lines are, from the
   * context bar. `onFiles()` is the tool row's Files button: Files mode in, or out while on.
   */
  constructor(root, { onClose, onOpen, onToast, onActed, onArchive, onFresh, onCancel, onRight, onSteps, onAgents, onCommands, onSetup, onContext, onCatalogue, onEditRepo, onFiles, activity } = {}) {
    this.onClose = onClose || (() => {})
    // Open another chat by its thread id: a line of `/away all`'s toast.
    this.onOpen = onOpen || (() => {})
    this.onFiles = onFiles || (() => {})
    // Whether the details column is open in Files mode, for the Files button's `aria-pressed`.
    this.filesOn = false
    this.onContext = onContext || (() => {})
    // `/registerRepo`: a register changes the catalogue, which the page holds; Edit in Settings
    // is the page's to open.
    this.onCatalogue = onCatalogue || (() => {})
    this.onEditRepo = onEditRepo || (() => {})
    // The `/registerRepo` card's scan, for the thread it was typed in: { threadId, said, scan }.
    this.registering = null
    // When the context bar calls a context large. The machine's setting, not the thread's, so a
    // change of chat keeps it; null until the first roster, and then no colour is drawn.
    this.limits = null
    // Repaints the header the moment the open chat's cache goes cold (`paintHeader`).
    this.coldTimer = null
    this.onAgents = onAgents || (() => {})
    this.onCommands = onCommands || (() => {})
    // The setup pill (`paintSetup`) opens the chat's setup in the details column.
    this.onSetup = onSetup || (() => {})
    this.onRight = onRight || (() => {})
    this.onSteps = onSteps || (() => {})
    this.activity = activity || { reset() {}, add() {}, patch() {}, steps() { return null } }
    this.onToast = onToast || (() => {})
    this.onActed = onActed || (() => {})
    this.onArchive = onArchive || (() => {})
    // Start fresh from the handoff: the page's, like Archive, because a stale or fallback
    // handoff goes through its one confirm (chats.md).
    this.onFresh = onFresh || (() => {})
    this.onCancel = onCancel || (() => {})
    this.can = { send: false, launch: false }
    // Which action is one press from confirmed — '', 'archive' or 'fresh'. The page
    // arms and disarms it, and only ever one at a time.
    this.armed = ''
    this.armedWhy = ''
    // The handoff's block in the log (`paintHandoff`), whether its text is open, and the text.
    this.hoEl = null
    this.hoOpen = false
    this.handoffText = null
    // What the log has shown of the handoff being written, for its steps (`handoffStep`):
    // `at` the request's `askedAt`, then whether its commit and its summary have appeared.
    this.hoSteps = { at: 0, committed: false, writing: false }
    this.hoTick = null
    // The tool row's popover: which question it holds ('' for none), and the Hand off path in it.
    this.pop = ''
    this.hoPath = 'session'
    // Archive's Hand off first, waiting: `{ id, seen, at }`, the chat, whether its handoff has
    // been seen being written — after which it is asked again, once ready — and when it was asked.
    this.archiveAfter = null
    this.thread = null
    this.look = { key: '', status: '', accent: '' }
    this.offset = 0
    this.timer = null
    this.busy = '' // the id of the thread a read is out for
    this.epoch = 0 // counts resets, so a read can tell its log has been cleared under it
    this.files = [] // files waiting to go with the next prompt
    // Unsent drafts, by thread id. One panel serves every thread, so what is in the box has to
    // be put away with the thread it was typed to — see `stashDraft`.
    this.drafts = new Map()
    // Sent but not yet in the transcript, by thread id: [{ text, at }]. Kept across `reset`
    // like a draft, because it is still on its way to that thread — see `paintQueued`.
    this.queued = new Map()
    this.pending = new Map() // tool-use id -> "name  summary", for calls with no result yet: fallback text for a permission prompt
    this.group = null // the run of tool calls the foot of the log is in the middle of: { id, el, n }
    this.openSteps = new Map() // group id -> its inline steps block, while open (`toggleSteps`)
    this.liveEl = null // the live line, while the thread is working (`paintLive`)
    this.asking = false // a read of what the session is asking is in flight
    this.seen = new Set() // item ids already drawn; a re-read after a reset must not double up
    // Reading upwards (`loadEarlier`): `sources` is this conversation then its earlier ones,
    // newest first; `k` the one being read; `before` the byte the page above starts from,
    // `null` for "from its end". `null` until the first read, and `done` once all are drawn.
    this.back = null
    this.backBusy = false
    this.orphans = new Map() // tool-use id -> a result read before its call: a page above holds the call
    this.stuck = true // following the foot of the log; only scrolling changes it — see `_wire`
    // The phone header's fold (`foldOnScroll`): the log's last scrollTop, and how far it has
    // gone since it last changed direction (down positive).
    this.foldY = 0
    this.foldRun = 0
    this.foldHold = 0 // until when scrolls are the fold's own resize, not the reader's
    this.pictures = [] // object URLs of the images drawn in this log, revoked when it is cleared
    this.loading = Promise.resolve() // the image fetches, one behind another — see `picture`
    this.unzoom = null // closes the full-size view of an image, while one is open
    // The model menu. `models` is the same list for every chat, so it is fetched once per
    // panel and kept across selections rather than re-read per thread.
    this.models = []
    this.efforts = []
    /** Which model `efforts` was read for — the levels on offer depend on it. */
    this.effortsFor = null
    this.effortsError = ''
    this.modelsOpen = false
    this.modelBusy = false
    this.modelsError = ''
    /** The shell drawer (`chat-shell.js`), made the first time the tool row's button is pressed. */
    this.shells = null

    this.el = document.createElement('section')
    this.el.className = 'convo'
    this.el.innerHTML = `
      <header>
        <button class="btn icon back" id="btn-convo-close" title="Back to the list (Esc)" aria-label="Back">${ICON.back}</button>
        <div class="text">
          <div class="title"></div>
          <div class="defines" hidden></div>
          <div class="meta"></div>
        </div>
        <button class="btn icon ws" id="btn-convo-ws" title="Details — this chat's workspace and activity" aria-label="Details" hidden>${ICON.panel}</button>
      </header>
      <div class="toolrow">
        <div class="ctxbar" hidden></div>
        <div class="actions"></div>
        <div class="tpop" role="dialog" hidden></div>
      </div>
      <div class="models" hidden></div>
      <div class="log">${LOG_HEAD}</div>
      <div class="cshell" hidden></div>
      <div class="strip" hidden><button type="button" class="halt" data-act="interrupt" title="Interrupt the session · Esc" aria-label="Interrupt" hidden>${ICON.stop}Stop</button><i class="spin" hidden></i><i class="dot" hidden></i><span class="text"></span><div class="halt-pop" role="dialog" aria-label="Interrupt?" hidden><div class="head">Interrupt?</div><div class="why"></div><div class="row"><button type="button" class="btn" data-halt="no">Cancel</button><button type="button" class="btn amber" data-halt="all">Stop everything</button></div></div><button type="button" class="setup" hidden title="This chat's setup — its install and data — and its log"></button><button type="button" class="agents" title="Open the agent map">0 agents</button><button type="button" class="cmds" title="Commands sent to the background">${ICON.term}<span class="n">0</span></button></div>
      <div class="ask" hidden>
        <div class="head">Claude needs your permission</div>
        <pre class="q"></pre>
        <div class="sched-card" hidden></div>
        <div class="files-card" hidden></div>
        <div class="row">
          <button class="btn primary" data-answer="allow">Allow</button>
          <button class="btn" data-answer="always">Always allow</button>
          <button class="btn" data-answer="deny">Deny</button>
        </div>
        <div class="opts" hidden></div>
      </div>
      <div class="register" hidden></div>
      <div class="nocomposer" hidden></div>
      <form class="composer" hidden>
        <div class="slash" hidden></div>
        <div class="pending" hidden></div>
        <div class="row">
          <button class="btn icon" type="button" id="btn-attach" title="Attach an image, PDF or text file — or paste or drop one" aria-label="Attach a file">${ICON.clip}</button>
          <textarea rows="1" placeholder="Message this session…"></textarea>
          <button class="btn primary icon send" type="submit" title="Send (Enter)" aria-label="Send">${ICON.send}</button>
        </div>
        <input type="file" multiple hidden />
      </form>`
    root.appendChild(this.el)
    this.$ = (sel) => this.el.querySelector(sel)
    this.log = this.$('.log')
    this._wire()
  }

  /**
   * Whether the details column exists for this chat, whether it is showing, and whether it is in
   * Files mode (`files`, the tool row's Files button). `null` hides the column's button.
   */
  setRight(right) {
    const b = this.$('#btn-convo-ws')
    b.hidden = !right
    b.setAttribute('aria-pressed', String(Boolean(right?.open)))
    this.filesOn = Boolean(right?.open && right?.files)
    this.$('[data-act=files]')?.setAttribute('aria-pressed', String(this.filesOn))
  }

  _wire() {
    this.$('#btn-convo-close').addEventListener('click', () => this.onClose())
    // The title is the rename field: click it, type, Enter or click away to keep, Esc to drop.
    const title = this.$('.title')
    title.addEventListener('click', () => this.startRename())
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        this.endRename(true)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation() // Esc here leaves the field, not the chat
        this.endRename(false)
      }
    })
    title.addEventListener('blur', () => this.endRename(true))
    this.$('#btn-convo-ws').addEventListener('click', () => this.onRight())
    // The pills are rebuilt on every paint, so their clicks are delegated.
    this.$('.meta').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-head]')
      if (b?.dataset.head === 'id') this.copyIds()
    })
    // The context bar is rebuilt on every paint too: its gauge opens Workspace.
    // Folded on a phone, the row is a 3 px bar and a tap anywhere on it unfolds the header
    // rather than opening Workspace through a gauge too thin to aim at. The title would be the
    // obvious tap, but it is the rename field and a click there edits it.
    this.$('.toolrow').addEventListener(
      'click',
      (e) => {
        if (!('collapsed' in this.el.dataset)) return
        e.stopPropagation()
        this.fold(false)
      },
      true,
    )
    this.$('.ctxbar').addEventListener('click', (e) => {
      const b = e.target.closest('button')
      if (b?.dataset.head === 'context') this.onContext()
    })
    this.$('.strip .agents').addEventListener('click', () => this.onAgents())
    this.$('.strip .cmds').addEventListener('click', () => this.onCommands())
    this.$('.strip .setup').addEventListener('click', () => this.onSetup())
    // The log is drawn piecemeal and its steps blocks by `innerHTML`, so every click in it is
    // caught here: a line of a steps block opens its call in Activity; a run's marker opens or
    // closes its steps in place; an agent's marker opens its report in Activity.
    this.log.addEventListener('click', (e) => {
      const call = e.target.closest('button[data-call]')
      if (call) return this.onSteps(call.dataset.group, call.dataset.call)
      const b = e.target.closest('button.steps')
      if (b) return b.classList.contains('agent') ? this.onSteps(b.dataset.group) : this.toggleSteps(b)
      if (e.target.closest('button.more')) return this.loadEarlier()
      const ho = e.target.closest('.hblock button[data-ho]')
      if (ho) this.handoffAct(ho.dataset.ho)
    })
    // Following the foot is decided by scrolling and by nothing else. Measured at each append
    // instead, anything that resized the log without a scroll — the details column narrowing
    // it, the permission bar or a handoff block growing in it, a phone's keyboard — left
    // the newest lines more than `STICK_PX` below the fold, and every later message landed
    // out of sight: a chat opened "somewhere in the middle". A box that resizes while
    // following is taken back down. A hidden log has no height and keeps the last answer.
    this.log.addEventListener(
      'scroll',
      () => {
        const l = this.log
        if (l.clientHeight) this.stuck = l.scrollHeight - l.scrollTop - l.clientHeight < STICK_PX
        this.foldOnScroll()
        this.maybeEarlier()
      },
      { passive: true },
    )
    new ResizeObserver(() => {
      if (this.stuck) this.toFoot()
    }).observe(this.log)

    // The option buttons are rebuilt every time the question changes, so their clicks are
    // delegated; the three permission buttons are in the markup and bound once below.
    this.$('.opts').addEventListener('click', (e) => {
      const b = e.target.closest('[data-option]')
      if (b) this.pick(b.dataset.option, b.dataset.expect || '')
    })
    for (const b of this.el.querySelectorAll('.ask button')) {
      b.addEventListener('click', () => this.answer(b.dataset.answer))
    }

    const form = this.$('.composer')
    const box = form.querySelector('textarea')
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      this.send()
    })
    // Stop is the strip's, beside the working state, not the composer's: beside Send on a phone
    // the two were adjacent taps, and a message can still be queued while a turn runs.
    this.$('.strip .halt').addEventListener('click', () => this.askInterrupt())
    const pop = this.$('.strip .halt-pop')
    pop.addEventListener('click', (e) => {
      const b = e.target.closest('[data-halt]')
      if (!b) return
      this.closeHalt()
      if (b.dataset.halt === 'all') this.interrupt(true)
    })
    // Esc in the popover is its Cancel, and goes no further: the page's Esc closes the chat.
    pop.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      this.closeHalt()
    })
    // Enter sends from a keyboard with a Shift key to hold; a touch keyboard has none, and
    // there Enter is a new line and the button is how you send — the same split Messages makes.
    box.addEventListener('keydown', (e) => {
      // Esc in the box is Stop while a turn runs, and always asks first; Enter then stops, Esc cancels.
      if (e.key === 'Escape' && !this.$('.strip .halt').hidden) {
        e.preventDefault()
        this.askInterrupt({ key: true })
        return
      }
      // Tab takes the first suggestion of a `/` command (`paintSlash`).
      if (e.key === 'Tab' && !e.shiftKey && this.slashFirst) {
        e.preventDefault()
        this.takeSlash(this.slashFirst)
        return
      }
      if (e.key === 'Enter' && !e.shiftKey && !TOUCH) {
        e.preventDefault()
        this.send()
      }
    })
    box.addEventListener('input', () => {
      this.autosize()
      this.paintSlash()
    })
    this.$('.slash').addEventListener('click', (e) => {
      const b = e.target.closest('[data-fill]')
      if (b) this.takeSlash(b.dataset.fill)
    })

    // Three ways in for a file, one list out. Paste is the one people reach for with a
    // screenshot on the clipboard; drop is for a file; the button is for finding one. Which
    // files can go is the server's call (uploads.mjs), told on Send, so no type is filtered here.
    const picker = form.querySelector('input[type=file]')
    this.$('#btn-attach').addEventListener('click', () => picker.click())
    picker.addEventListener('change', () => {
      this.attach([...picker.files])
      picker.value = ''
    })
    box.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])]
      if (!files.length) return
      e.preventDefault()
      this.attach(files)
    })
    this.el.addEventListener('dragover', (e) => {
      if (!form.hidden && [...(e.dataTransfer?.types || [])].includes('Files')) {
        e.preventDefault()
        this.el.classList.add('dropping')
      }
    })
    this.el.addEventListener('dragleave', () => this.el.classList.remove('dropping'))
    this.el.addEventListener('drop', (e) => {
      this.el.classList.remove('dropping')
      if (form.hidden) return
      const files = [...(e.dataTransfer?.files || [])]
      if (!files.length) return
      e.preventDefault()
      this.attach(files)
    })
    this.$('.pending').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-remove]')
      if (!b) return
      this.files.splice(Number(b.dataset.remove), 1)
      this.paintPending()
    })

    // The tool row's popover (`openPop`) is redrawn per question, so its clicks are delegated.
    const tpop = this.$('.tpop')
    tpop.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-pop]')
      if (b) this.popAct(b.dataset.pop)
    })
    // Esc in it is its Cancel, and goes no further: the page's Esc closes the chat.
    tpop.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      this.closePop()
    })

    this.$('.actions').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]')
      if (!b) return
      if (b.dataset.act === 'restart') this.restart()
      else if (b.dataset.act === 'resume') this.resume()
      else if (b.dataset.act === 'archive') this.onArchive()
      else if (b.dataset.act === 'models') this.toggleModels()
      else if (b.dataset.act === 'handoff') this.handoffButton()
      else if (b.dataset.act === 'shell') this.toggleShell()
      else if (b.dataset.act === 'files') this.onFiles()
    })

    this.$('.register').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-reg]')
      if (!b) return
      if (b.dataset.reg === 'add') this.register()
      else if (b.dataset.reg === 'update') this.applyRescanCard()
      else if (b.dataset.reg === 'edit') {
        const draft = this.registering?.scan.repo
        this.clearRegister()
        if (draft) this.onEditRepo(draft)
      } else this.clearRegister()
    })

    this.$('.models').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-model], button[data-effort]')
      if (!b) return
      if (b.dataset.effort) this.chooseEffort(b.dataset.effort)
      else this.chooseModel(b.dataset.model)
    })
  }

  /** The roster's `contextLimits`: when the context bar turns orange and red, and Hand off with it. */
  setContextLimits(limits) {
    const next = limits || null
    if (JSON.stringify(next) === JSON.stringify(this.limits)) return
    this.limits = next
    if (!this.thread) return
    this.paintHeader()
    this.paintControls()
  }

  /** What the launcher on this server can do; decides which controls exist at all. */
  setCapabilities({ canSend = false, canLaunch = false } = {}) {
    this.can = { send: Boolean(canSend), launch: Boolean(canLaunch) }
    if (this.thread) this.paintControls()
  }

  /**
   * Put a confirm up for one of the things that cannot be taken back, or take it down. `kind`
   * is `'archive'`, `'fresh'` or `''` for none; `why` is the sentence it shows; `unsaved` says
   * the chat's checkouts hold work not yet safe (Archive's Hand off first).
   *
   * Archive asks in the tool row's popover, under the button pressed (`openPop`); Start fresh in
   * the handoff's block, in place of its buttons (2026-10-19). Archive's was a bar under the row
   * before that, and first a bar above the composer, the page's height from the press; before
   * that the button itself turned into "End it?", a question nobody recognised as one.
   *
   * The confirm itself belongs to the page rather than to this panel: one owner, one thing
   * armed at a time. Yes is the same call the button made, so the page sees a second
   * press and goes ahead; Cancel, Esc or a press elsewhere disarms (`closePop`).
   */
  arm(kind, why = '', { unsaved = false } = {}) {
    this.armed = String(kind || '')
    this.armedWhy = why
    if (this.thread) this.paintHandoff()
    if (this.armed !== 'archive') {
      if (this.pop === 'archive') this.closePop()
      return
    }
    const first = this.handoffFirst(unsaved)
    this.openPop('archive', {
      head: 'Archive this chat?',
      why: first ? `${why} ${first}` : why,
      verb: 'Archive',
      danger: true,
      extra: first ? { act: 'first', label: 'Hand off first' } : null,
    })
  }

  /**
   * Why to hand off before archiving, or '': work not yet safe or a context past orange, and no
   * handoff kept or being written. Needs a launcher that could start fresh from it later.
   */
  handoffFirst(unsaved) {
    const t = this.thread
    if (!t?.workspace || !this.can.launch) return ''
    const state = this.handoffState()
    if (state === 'ready' || state === 'progress') return ''
    const big = contextLevel(t.context, t.contextWindow || 0, this.limits) ? `${kTokens(t.context)} of context` : ''
    const what = [unsaved ? 'Unsaved work' : '', big].filter(Boolean)
    if (!what.length) return ''
    const joined = what.length === 2 ? `${what[0]} and ${what[1]}` : what[0][0].toUpperCase() + what[0].slice(1)
    return `${joined} — a handoff keeps the summary for later.`
  }

  /** Show `thread`'s conversation. A different thread starts over; the same one just refreshes. */
  show(thread, look = {}) {
    const changed = !this.thread || this.thread.id !== thread.id
    if (changed) {
      // Before the repaint, not after it in `reset`, or the button paints itself open for the
      // new thread and only corrects on the next poll.
      this.modelsOpen = false
      this.stashDraft()
      // The same chat carried on in a fresh conversation (handoff.md): the draft goes with it.
      const was = this.thread?.id
      if (was && this.drafts.has(was) && thread.earlier?.some((e) => e.id === was) && !this.drafts.has(thread.id)) {
        this.drafts.set(thread.id, this.drafts.get(was))
        this.drafts.delete(was)
      }
    }
    this.thread = thread
    this.look = { key: '', status: '', accent: '', ...look }
    this.paintHeader()
    this.paintControls()
    this.paintStatus()
    if (changed) {
      this.reset()
      this.restoreDraft()
      this.el.classList.add('on')
      // Said until the first read answers, so a slow one is a wait and not an empty chat.
      this.note({ loading: true })
      this.openedAt = performance.now()
      this.poll()
      this.schedule()
    }
    // After `reset`, which puts the last chat's card away, and the live line with it.
    this.paintHandoff()
    this.paintLive()
    // After `reset` too, which hid the last chat's shells: this chat's, if its drawer was open.
    this.shells?.set(thread)
  }

  /**
   * The tool row's terminal button: the shell drawer on this chat's container (`chat-shell.js`).
   * Imported the first time, never statically: it brings xterm (ui.md).
   */
  async toggleShell() {
    const t = this.thread
    if (!t?.container) return
    if (!this.shells) {
      try {
        const { ChatShell } = await import('./chat-shell.js')
        this.shells ||= new ChatShell(this.$('.cshell'), {
          log: this.log,
          onToast: this.onToast,
          onChange: () => this.$('[data-act=shell]')?.setAttribute('aria-pressed', String(this.shells.isOpen())),
        })
      } catch (err) {
        this.onToast(err.message || 'Could not load the shell', 'err')
        return
      }
    }
    // The chat may have moved on while the module loaded.
    if (this.thread?.id === t.id) this.shells.toggle(this.thread)
  }

  /**
   * The fallback tick. Ten seconds for a session at rest, whose log moves on push; one
   * second for one that is answering, because its partial answer lives only in the stream
   * and no hook fires per token.
   */
  schedule() {
    clearTimeout(this.timer)
    const fast = Boolean(this.thread?.structured && this.thread?.running)
    this.timer = setTimeout(() => {
      this.poll()
      this.schedule()
    }, fast ? 1000 : POLL_MS)
  }

  /**
   * The thread list refreshed; keep the header and controls honest without touching the log.
   * `moved` says the server saw this thread change — a hook landed, the transcript grew — so
   * the log is re-tailed now rather than on the slow fallback tick.
   */
  update(thread, look = {}, { moved = false } = {}) {
    if (!this.thread || this.thread.id !== thread.id) return
    this.thread = thread
    this.look = { key: '', status: '', accent: '', ...look }
    this.paintHeader()
    this.paintControls()
    this.paintStatus()
    this.paintHandoff()
    this.paintLive()
    // `canSend` and `container` move with the roster: a container that stopped or came back.
    this.shells?.set(thread)
    if (moved) this.poll()
  }

  hide() {
    if (!this.thread) return
    this.stashDraft()
    this.thread = null
    // Not in `reset`: `show` paints the new chat's header, arming its timer, before it resets.
    clearTimeout(this.coldTimer)
    this.coldTimer = null
    this.reset()
    this.el.classList.remove('on')
  }

  isOpen() {
    return Boolean(this.thread)
  }

  reset() {
    clearTimeout(this.timer)
    this.timer = null
    // A rename half typed belongs to the chat it was typed on; dropped, never saved onto the next.
    if (this.renaming) {
      this.renaming = ''
      const title = this.$('.title')
      title.contentEditable = 'false'
      title.classList.remove('editing')
    }
    // Stop everything, one click from ending the wrong chat's agents.
    this.closeHalt()
    // A question about this chat must not stand over the next one, nor an archive wait for it.
    this.closePop()
    this.archiveAfter = null
    this.paintPartial('')
    this.offset = 0
    // A read still out belongs to the log that was just cleared; `poll` drops its answer.
    this.epoch += 1
    this.busy = ''
    this.files = []
    this.paintPending()
    this.pending.clear()
    this.group = null
    this.activity.reset()
    // The steps blocks and the live line are the log's, emptied below; nothing of them carries over.
    this.openSteps.clear()
    this.liveEl = null
    this.seen.clear()
    this.unzoom?.()
    for (const url of this.pictures) URL.revokeObjectURL(url)
    this.pictures = []
    // The bar belongs to the thread it was read for, and nothing else takes it down: the next
    // `describeAsk` is a poll away, and it only *hides* the bar once an answer for the new
    // thread has come back. Left standing, another thread's question is on screen over this
    // one — and clicking it answers *this* one, which is the launcher's "nothing is asking"
    // refusal if you are lucky and somebody else's yes if you are not.
    this.clearAsk()
    // The register card is the thread's too: its Register adds to the chat showing.
    this.clearRegister()
    // So are its shells: hidden, not ended (`show` puts the next chat's up).
    this.shells?.set(null)
    // The list itself survives — it describes the machine, not the thread — but a menu left
    // standing would be showing the previous session's choices over a new one.
    this.modelsOpen = false
    this.modelsError = ''
    this.paintModels()
    this.log.innerHTML = LOG_HEAD
    this.back = null
    this.backBusy = false
    this.orphans.clear()
    this.stuck = true
    // Another chat opens with its header whole.
    this.fold(false)
    this.foldY = 0
    // Another chat's held note must not survive into this one's log; `paintRight` sets this
    // chat's.
    this.heldNote = null
    // The handoff block and the text read for it belong to the chat they were drawn for; the
    // log they sat in was emptied above.
    this.handoffText = null
    this.hoEl = null
    this.hoOpen = false
    this.hoSteps = { at: 0, committed: false, writing: false }
    // A read of another chat's text still out must not stop this chat's being read.
    this.hoReading = null
    clearInterval(this.hoTick)
    this.hoTick = null
    this.hoSince = 0
  }

  // ── painting ────────────────────────────────────────────────────────────────────────

  /**
   * Turn the title into a field. The name typed is Outpost's (chats.md): it beats the
   * automatic one and stays until it is changed or cleared, and clearing it — saving it empty —
   * hands the chat back to automatic naming.
   */
  startRename() {
    const title = this.$('.title')
    // A defining chat is headed by the routine it makes (`definingWords`), not a name to edit.
    if (!this.thread || this.renaming || this.thread.defines) return
    this.renaming = this.thread.id
    // The name the person set, to edit; otherwise whatever is showing, as a starting point.
    title.textContent = this.thread.title || ''
    title.contentEditable = 'plaintext-only'
    title.classList.add('editing')
    title.focus()
    getSelection()?.selectAllChildren(title)
  }

  async endRename(keep) {
    const title = this.$('.title')
    const id = this.renaming
    if (!id) return
    this.renaming = ''
    title.contentEditable = 'false'
    title.classList.remove('editing')
    const t = this.thread
    const typed = title.textContent.replace(/\s+/g, ' ').trim()
    const before = t?.title || ''
    if (t?.id === id) this.paintHeader()
    if (!keep || !t || t.id !== id || typed === before) return
    // Shown at once; the roster that follows the request agrees or puts it back.
    if (typed) t.title = typed
    this.paintHeader()
    try {
      await renameThread(t, typed)
      this.onToast(typed ? `Renamed to “${typed}”` : 'Name cleared — Outpost will name this chat', 'ok')
    } catch (err) {
      t.title = before
      if (this.thread?.id === id) this.paintHeader()
      this.onToast(`Could not rename: ${err.message}`, 'error')
    }
    this.onActed()
  }

  paintHeader() {
    const t = this.thread
    const title = this.$('.title')
    // A routine's defining chat (routines.md *Defining chats*) is headed by what it is for —
    // "Defining a routine", "Changing <name>" — with a line on what to say, since its log starts
    // empty and its first message is the routine described.
    const defining = definingWords(t.defines)
    const hint = this.$('.defines')
    hint.hidden = !defining
    hint.textContent = defining ? defining.hint : ''
    title.classList.toggle('fixed', Boolean(defining))
    if (defining) title.textContent = defining.head
    // Not over a name being typed: a roster arriving mid-rename would wipe it.
    else if (this.renaming !== t.id) title.textContent = t.title || 'Untitled thread'
    // The title is a short name for the goal or the latest prompt (chats.md), so on a long
    // thread it no longer says what the session was opened to do — and a first load of a big
    // transcript starts near its end, so scrolling back for that is not always an option either.
    // The name leads the hover: the title is one line, cut with an ellipsis on a phone.
    title.title = defining ? t.title || '' : [t.title || '', t.preview ? `Started with: ${t.preview}` : '', t.titleSource === 'person' ? 'Click to rename — save it empty to let Outpost name it' : 'Click to rename'].filter(Boolean).join('\n\n')
    // The row is what to know before sending, not where the chat is: status is the strip's,
    // the repo and branch are the Workspace section's, and the model is on its own button.
    const bits = []
    // What the last turn died of. First in the row: on the one thread in twenty that carries
    // one it is the thing you opened the panel to find out.
    if (t.failure) bits.push(failureTag(t.failure))
    // Next to it, never instead of it: what died and what is being done about it are two facts.
    if (t.retry) bits.push(retryTag(t.retry))
    // Its repo has no hooks, so "working" is the transcript's guess and outlives the turn (hooks.md).
    if (t.noHooks)
      bits.push(
        `<span class="tag nohooks" title="${escape(
          'No hook has reported this session, so its status is guessed from the transcript: it reads working for 30 minutes after the turn ends and never reads done. Install the hooks for its repo (yarn hooks <repo>, or yarn hooks ~ for every repo on the machine).'
        )}">no hooks</span>`
      )
    bits.push(this.idPill(t))
    const cold = this.coldPill(t)
    if (cold) bits.push(cold)
    this.$('.meta').innerHTML = bits.join('')
    this.armCold(t)
    this.paintContext()
  }

  /**
   * The chat's Outpost id — its workspace's, the name its folder, branch and logs go by — in
   * full, because eight characters is what a person types to find it. The click copies both
   * ids, since a bug report wants the session's too and nothing on the page shows it. A session
   * with no workspace has only its own.
   */
  idPill(t) {
    const ws = t.workspace?.id || ''
    const title = ws ? `This chat is ${ws}; its session is ${t.id}. Click to copy both.` : `Session ${t.id}. Click to copy it.`
    return `<button type="button" class="tag id" data-head="id" title="${escape(title)}">id ${escape(ws || t.id.slice(0, 8))}</button>`
  }

  async copyIds() {
    const t = this.thread
    if (!t) return
    const ws = t.workspace?.id || ''
    try {
      await copyString(ws ? `chat ${ws} · session ${t.id}` : t.id)
      this.onToast(ws ? `Copied chat ${ws} and its session id` : 'Copied the session id', 'ok')
    } catch {
      this.onToast('Could not reach the clipboard', 'error')
    }
  }

  /** Whether the open chat's cache has expired: idle past its lifetime, with a session to type to. */
  isCold(t, now = Date.now()) {
    return Boolean(t.canSend && !t.running && t.context && t.contextAt && now - t.contextAt > CACHE_TTL_MS)
  }

  /**
   * The context the session's last request carried, as a bar under the title with the count
   * beside it and Compact docked at its end. It is what the next message costs, which is why
   * it sits where you look before sending: every request re-sends the whole context. Accent
   * below the thresholds, orange from `warn`, red from `alert` — the configurable ones
   * (`contextLimits`), never a fixed share. With no window known the count stands alone and
   * the bar fills against the red threshold, the one size it is judged on then.
   */
  paintContext() {
    const t = this.thread
    const bar = this.$('.ctxbar')
    // Compact is a message to the session (launchers.md), so only a running one has it; the
    // bar shows for it even before the first turn has reported a context.
    const live = Boolean(t.canSend)
    if (!t.context && !live) {
      bar.hidden = true
      bar.innerHTML = ''
      return
    }
    const window = t.contextWindow || 0
    const level = contextLevel(t.context, window, this.limits)
    const parts = []
    if (t.context) {
      const share = window ? ` — ${Math.round((t.context / window) * 100)}% of the ${exact(window)}-token window` : ''
      const handoff = level && t.canSend && t.workspace ? '\n\nHand off, at the end of this row, writes what a fresh conversation needs, and starts one from it — far cheaper per message than carrying this.' : ''
      const title = `The session's last request carried ${exact(t.context)} tokens of context${share}. Every request re-sends all of it.\n\n${limitsText(window, this.limits)}${handoff}${
        t.workspace ? '\n\nClick for what this chat has spent.' : ''
      }`
      const full = window || this.limits?.alertTokens || t.context
      const pct = Math.max(1, Math.min(100, Math.round((t.context / full) * 100)))
      // A button only where there is a Workspace section to open; a session with no workspace has no token lines.
      const tag = t.workspace ? 'button' : 'span'
      parts.push(
        `<${tag}${tag === 'button' ? ' type="button" data-head="context"' : ''} class="gauge" title="${escape(title)}">` +
          `<span class="track"><i style="width:${pct}%"></i></span>` +
          `<span class="n">${kTokens(t.context)}${window ? ` / ${kTokens(window)} · ${Math.round((t.context / window) * 100)}%` : ''}</span></${tag}>`
      )
    } else {
      parts.push(`<span class="gauge" title="No request has reported its context yet — it shows when the first turn ends."><span class="track"></span><span class="n">no context yet</span></span>`)
    }
    // No Compact and no Clear beside it (2026-10-14): the way off a large context is Hand off,
    // at the row's end; `/compact` typed in the message box still reaches the CLI as its own
    // command, and clearing would be a new session under a new id, which New chat already is.
    bar.className = `ctxbar ${level}`
    bar.innerHTML = parts.join('')
    bar.hidden = false
  }

  /**
   * Once the last request is over an hour old, that the cache has gone cold: the next message
   * writes the whole context again at full price rather than reading it back at a tenth
   * (usage.md `cold` — most of the cache writes measured were exactly that). In the header,
   * where you look before sending.
   */
  coldPill(t) {
    if (!t.context || !this.isCold(t)) return ''
    const level = contextLevel(t.context, t.contextWindow || 0, this.limits)
    // Muted below orange: rewriting a small context is cheap, and a warning on every chat
    // left over lunch would teach you to ignore it.
    return `<span class="tag cold${level ? ' warn' : ''}" title="${escape(
      `Idle over an hour, so the prompt cache has expired: the next message re-sends all ${exact(t.context)} tokens of context at full price instead of reading them back cheaply.${
        t.workspace ? ' Hand off, in the row under the title, starts a fresh conversation from a summary instead.' : ''
      }`
    )}">cache cold · rewrites ${kTokens(t.context)}</span>`
  }

  /**
   * Repaint the header the moment the open chat's cache goes cold, so the pill is there
   * without a reload or a request to the server. One timer, re-armed on every paint — a roster
   * with a newer request moves it — and taken down when the panel is hidden.
   */
  armCold(t) {
    clearTimeout(this.coldTimer)
    this.coldTimer = null
    if (!t?.context || !t.contextAt || this.isCold(t)) return
    const wait = t.contextAt + CACHE_TTL_MS - Date.now()
    if (wait <= 0) return // past the hour but not cold for another reason — not typable, or working
    // A second over, so `isCold` agrees when it fires.
    this.coldTimer = setTimeout(() => {
      if (this.thread?.id === t.id) this.paintHeader()
    }, wait + 1000)
  }

  /**
   * Which controls apply right now. Absent rather than disabled: a button for something
   * this launcher cannot do is a promise the click will break.
   */
  /**
   * The strip above the composer, always there so the composer never jumps: a spinner and
   * the hook's own line while the session is working — "Running Bash: Fetch main", "Waiting
   * on 2 subagents" — and otherwise a dot in the status colour with the status word. The
   * subagent count rides beside it while any are out.
   */
  paintStatus() {
    const t = this.thread
    // `.strip`, not `.status`: the header once carried a `.tag.status` first in document order,
    // and that selector found the tag, hid it, and threw on its missing `.text`.
    const el = this.$('.strip')
    el.hidden = !t
    if (!t) return
    const running = Boolean(t.running)
    // A handoff being written spins here, the one spinner, the session asked or not: the block
    // in the log shows its steps as marks (2026-10-19).
    const handing = Boolean(t.handoff?.asking)
    el.querySelector('.spin').hidden = !running && !handing
    const dot = el.querySelector('.dot')
    dot.hidden = running || handing
    dot.className = `dot ${this.look.key || 'idle'}`
    // Asleep once the unit has gone — aging ended it — said beside the status word, never over
    // it: "Done" is the news, and the next message wakes it.
    const asleep = !running && t.structured && !t.canSend
    const word = this.look.status || 'Idle'
    const steps = running && t.steps > 0 ? ` · ${t.steps} step${t.steps === 1 ? '' : 's'}` : ''
    el.querySelector('.text').textContent = handing
      ? t.handoff.without
        ? 'Summarising the transcript into a handoff'
        : `Handing off · ${t.activity || 'writing the summary'}`
      : running
        ? `${t.activity || 'Working…'}${steps}`
        : asleep
          ? `${word} · asleep, your next message wakes it`
          : word
    // The count is always up, "0 agents" included, so it never appears out of nowhere; it
    // opens the map either way, which has every agent the session ever dispatched.
    const n = running && Array.isArray(t.subagents) ? t.subagents.length : 0
    const agents = el.querySelector('.agents')
    agents.hidden = false
    agents.classList.toggle('out', n > 0)
    agents.textContent = `${n} agent${n === 1 ? '' : 's'}`
    this.paintCommands()
    this.paintSetup()
  }

  /**
   * The commands the session left running in the background (hooks.md `backgroundTasks`): a
   * terminal and a count beside the agents, always up like it, at any status — a done chat is
   * exactly where one is forgotten. Pressed, it opens the commands map (`commands.js`), which
   * has the ended ones too. Not on an asleep chat: its session, and what it ran, are gone.
   */
  paintCommands() {
    const t = this.thread
    const asleep = t?.structured && !t.canSend
    const list = !t || asleep || !Array.isArray(t.backgroundTasks) ? [] : t.backgroundTasks
    const pill = this.$('.strip .cmds')
    pill.querySelector('.n').textContent = String(list.length)
    pill.classList.toggle('out', list.length > 0)
    pill.title = list.length ? `${list.length} running in the background — click to see, read or stop them` : 'Nothing running in the background — click for the ones that ran'
  }

  /** The chat's setup (`ws.setup`, workspaces.md), for the pill beside the agents count. */
  setSetup(setup) {
    this.setup = setup || null
    this.paintSetup()
  }

  /**
   * Setup's note held for a chat nobody has spoken in yet (`ws.heldNoteView`, workspaces.md):
   * drawn at the top of the log as the transcript's notes are, because sending it would give
   * the session a turn with nothing to answer. Gone once the first message carries the real
   * one into the transcript, so it is never drawn twice.
   */
  setHeldNote(view) {
    this.heldNote = view || null
    this.paintHeldNote()
  }

  paintHeldNote() {
    let el = this.log.querySelector('.onote.held')
    // Only over an empty log: anything in the transcript means the first message went, with the
    // note in front of it, and a roster that has not caught up yet would draw it twice.
    if (!this.heldNote || this.seen.size) {
      el?.remove()
      return
    }
    if (!el) {
      el = document.createElement('div')
      this.log.querySelector('.note')?.after(el)
    }
    el.className = `onote held ${this.heldNote.tone === 'failure' ? 'failed' : this.heldNote.tone === 'success' ? 'ok' : ''}`
    el.textContent = this.heldNote.text
  }

  /**
   * Setup as a pill in the strip's own row, so the composer never moves: a spinner and
   * "Setting up webapp" (or "1 of 2") while it runs, then "✓ webapp ready" (or "✓ 2 repos
   * ready") — a bare Ready read as the session or the agents being ready — ✗ Setup failed; hidden for a
   * chat with nothing to set up. It opens the setup and its log in the details column.
   */
  paintSetup() {
    const pill = this.$('.strip .setup')
    const repos = this.setup?.repos || []
    if (!this.thread || !repos.length) {
      pill.hidden = true
      return
    }
    const failed = repos.filter((r) => r.state === 'failed')
    const busy = repos.filter((r) => r.state === 'running' || r.state === 'pending')
    const finished = repos.filter((r) => r.state === 'done' || r.state === 'failed').length
    pill.hidden = false
    pill.dataset.state = busy.length ? 'running' : failed.length ? 'failed' : 'done'
    pill.innerHTML = busy.length
      ? `<i class="spin"></i>${escape(repos.length === 1 ? `Setting up ${repos[0].name}` : `Setting up ${finished + 1} of ${repos.length}`)}`
      : failed.length
        ? '✗ Setup failed'
        : `✓ ${escape(repos.length === 1 ? `${repos[0].name} ready` : `${repos.length} repos ready`)}`
  }

  paintControls() {
    const t = this.thread
    // `canSend` is the server's word, per thread: a session Outpost started whose unit is
    // running (launchers.md). The page never infers it from a live pid.
    const live = Boolean(t.canSend)
    const key = this.look.key
    // A session whose unit has gone cannot be moved onto anything: a menu left open over one
    // is a list whose every click would fail.
    if (!live) this.modelsOpen = false

    const acts = []
    // Stop is the strip's, first in it, under the same gate: a running unit
    // mid-turn. Hidden, not greyed, the rest of the time, and its popover goes with it.
    const halt = this.$('.strip .halt')
    halt.hidden = !(live && key === 'working')
    if (halt.hidden) this.closeHalt()
    // No Agents button: the strip's agent count is always up and opens the same map, finished
    // agents included. Its place is the pin's, shown only on a pinned chat (aging.md).
    if (t.workspace?.pinned) acts.push(`<span class="pinned" title="Pinned — not archived or deleted until unpinned. Unpin from its row in the list.">${ICON.pin}Pinned</span>`)
    // Only for a running session: the model is changed over its stream and the effort by a
    // restart in place (launchers.md). Dimmed and marked with a `~` when the model is the
    // CLI's configured default rather than one the session has answered on (`modelAssumed`,
    // harnesses.md) — the header's model tag said so until the button became the one place
    // the model is shown.
    // A change asked and not yet answered on (`modelPending`, launchers.md) is `Sonnet → Opus`:
    // the model is read off the last answer, so the button otherwise kept the old name until
    // the next one, with only a toast to say a change was coming.
    if (live) {
      const guess = Boolean(t.model && t.modelAssumed)
      const next = t.modelPending ? t.modelPending[0].toUpperCase() + t.modelPending.slice(1) : ''
      const why = next
        ? `Switching to ${next} — it takes effect on the session's next answer.\n\n`
        : guess
          ? 'Nothing said yet — this is the model it would start on.\n\n'
          : ''
      const now = [t.model ? modelLabel(t.model) : 'Model', t.effort].filter(Boolean).join(' · ')
      acts.push(
        `<button class="btn${this.modelsOpen ? ' on' : ''}${guess && !next ? ' guess' : ''}" data-act="models" title="${escape(why)}Change the model or the effort — for this session only, never your default">${guess && !next ? '~' : ''}${escape(next ? `${now} → ${next}` : now)} ▾</button>`
      )
    }
    // A stalled session is the one case where the useful action is "do that again". Offered
    // whenever the turn died on something retryable, whether the supervisor is still counting
    // down or has spent its five — the button is the way past the cap, which is the point of
    // having a cap rather than a machine that types forever (resilience.md).
    // Held after a limit reset, Resume — with the price on it — is the handoff block's, beside
    // Start fresh: the two choices the hold is for, in one place (resilience.md).
    if (live && t.failure?.class === 'transient' && !t.retry?.held)
      acts.push(`<button class="btn primary" data-act="restart" title="Send it on again now, without waiting for the schedule">${t.retry?.exhausted ? 'Restart it' : 'Restart now'}</button>`)
    if (this.can.launch && !live) acts.push(`<button class="btn primary" data-act="resume" title="Start the session again where it left off">Resume</button>`)
    // There is no Mark read: leaving a finished chat is how its ✓ is cleared (chats.md), and
    // a button for it was one more thing in a row that wraps on a phone. Compact is the context
    // bar's (`paintContext`).
    const far = []
    // Hand off: the session commits its work — never pushes — and writes the notes a fresh
    // conversation starts from (handoff.md). With Archive, because both are done to the
    // conversation, and only when it is worth pressing: the context orange or red, or the cache
    // gone cold — orange, and red in the red band, as the context bar is. As a
    // third button beside the model's it was there at any size, where a handoff saves nothing,
    // and pushed Archive onto a second line on a phone. `/handoff` in the message
    // box asks for one at any size.
    // A session that is not running, stopped on a failure, or gone cold is not asked — that
    // would rewrite its whole context — and the server writes the handoff without it instead.
    // Always shown on a workspace chat, live or not (2026-10-14; shown only in a band or cold,
    // it read as missing the rest of the time): neutral below the thresholds, orange from
    // `warnTokens`, red from `alertTokens` — the same bands as the bar, from Settings › General ›
    // Context. A stopped session gets the handoff written without it (handoff.md).
    if (t.workspace) {
      const level = contextLevel(t.context, t.contextWindow || 0, this.limits)
      const asking = Boolean(t.handoff?.asking)
      // A current handoff kept: the server would not write another, so the button goes to its
      // block, where Start fresh is — the block can scroll out of sight as the log grows.
      const ready = this.handoffState() === 'ready'
      // An icon like Files and the shell (2026-10-18), its hover one line: which way the handoff
      // is written is the block's to say, not the button's.
      const why = asking ? 'Handing off · a handoff is being written' : ready ? 'Handoff ready · go to it to start fresh' : 'Hand off · summarize and continue in a new session'
      far.push(`<button class="btn ghost icon${level ? ' nudge' : ''}${level === 'alert' ? ' alert' : ''}${ready ? ' ready' : ''}" data-act="handoff" title="${why}" aria-label="${asking ? 'Handing off' : ready ? 'Go to the handoff' : 'Hand off'}"${asking ? ' disabled' : ''}>${ICON.handoff}</button>`)
    }
    // Archive is offered for every thread, and deliberately not behind `canArchive`: that flag
    // says whether the *harness* has a record to flip (harnesses.md), which is false for every
    // session the CLI started. Archiving is Outpost's own list either way (chats.md), so
    // gating on it hid the button on precisely the sessions Outpost drives.
    //
    // The button never changes: the question it raises is the confirm bar's (`arm`).
    //
    // Hand off, Archive, Files and the shell are one set of icon buttons (2026-10-18), and
    // travel as one group, `far`, pushed to the end of the row with
    // `margin-left: auto`. As separate buttons with the margin on the first, a narrow row
    // wrapped Archive onto a line of its own at the left, away from where its confirm appears.
    // Not `right`: that is the details column's class, and its rules reached the button — a
    // border down its left side on a wide screen, and at phone width the sheet's `position:
    // fixed; bottom: 0`, which put a button on top of the composer.
    // A pinned chat cannot be archived by hand either: a pin that only held off aging let one
    // be archived by a stray press (2026-10-09). Unpinning is the way to archive it.
    const pinned = Boolean(t.workspace?.pinned)
    far.push(
      `<button class="btn ghost icon" data-act="archive" aria-label="Archive"${pinned ? ' disabled' : ''} title="${
        pinned
          ? 'Archive · pinned — unpin it from its row in the list to archive it'
          : live
          ? 'Archive · ends this session; it can be restored from Archived until its workspace is deleted (A)'
          : 'Archive · takes it off the list; it can be restored from Archived until its workspace is deleted (A)'
      }">${ICON.box}</button>`
    )
    // Files mode in the details column (ui-details.md), for a chat with a workspace. Hidden under
    // 1100 px, where the sheet's Files heading is the way in.
    if (t.workspace) {
      far.push(`<button class="btn ghost icon" data-act="files" aria-pressed="${this.filesOn}" title="Files · what the chat wrote, and its workspace" aria-label="Files">${ICON.folder}</button>`)
    }
    // A shell into the chat's container, only where there is one: a chat on the host gets none
    // (auth.md). Hidden under 1100 px with the drawer itself.
    if (t.container) {
      const on = Boolean(this.shells?.isOpen(t.id))
      far.push(`<button class="btn ghost icon" data-act="shell" aria-pressed="${on}" title="Shell · a terminal in this chat's container" aria-label="Shell">${ICON.term}</button>`)
    }
    acts.push(`<span class="far">${far.join('')}</span>`)
    const actions = this.$('.actions')
    actions.innerHTML = acts.join('')
    actions.hidden = acts.length === 0
    this.paintModels()

    // No status word gates the permission bar: the server is the only thing that knows what
    // is being asked. The transcript is written after the answer, and the hook status under a
    // standing prompt is whatever event fired last — `running` as often as `waiting`. Ask
    // whenever this session could be answered; it is one request for the one open panel.
    // A standing question of Outpost's own (a dataset's deletions) outlives the session, so a
    // chat whose unit has gone is asked too whenever the roster says it carries one.
    if (live || t.ask) this.describeAsk()
    else this.$('.ask').hidden = true

    // A session Outpost started whose unit has gone — aging ends quiet ones (aging.md) — is
    // still typed into: the server resumes it and then delivers the message (launchers.md).
    const typable = live || Boolean(this.can.launch && t.structured)
    const composer = this.$('.composer')
    composer.hidden = !typable
    composer.querySelector('textarea').placeholder = t.defines ? DEFINING_PLACEHOLDER : live ? 'Message this session…' : 'Message this session — it resumes where it left off…'
    // A box that was hidden could not be measured; a draft carried into this panel needs its
    // height worked out now that there is one to read.
    if (typable) this.autosize()
    // Where the composer would be, say why it is not: a panel that simply has no input box
    // reads as broken, not as "this session is not running".
    const why = this.$('.nocomposer')
    let reason = ''
    if (!typable && this.can.launch) reason = 'This session has stopped — Resume it to carry on.'
    else if (!typable) reason = 'This session cannot be typed into from here.'
    why.textContent = reason
    why.hidden = !reason
  }

  /** Take the permission bar down and empty it, so nothing of it can outlive its thread. */
  clearAsk() {
    const ask = this.$('.ask')
    ask.hidden = true
    this.askId = ''
    ask.querySelector('.q').textContent = ''
    ask.querySelector('.q').hidden = false
    paintCard(ask.querySelector('.sched-card'), null)
    const opts = ask.querySelector('.opts')
    opts.innerHTML = ''
    delete opts.dataset.html
    opts.hidden = true
    ask.querySelector('.row').hidden = false
  }

  /**
   * Show the permission bar if, and only if, the session is asking something — filled from
   * the request's own words: the exact command, and the real option wording on the buttons.
   * A bar that only says "needs permission" makes you go and look. If the server cannot be
   * asked, a tool call with no result yet is the fallback signal and its row the fallback
   * text.
   */
  async describeAsk() {
    if (this.asking) return // one read at a time; the next tick asks again
    this.asking = true
    const t = this.thread
    const ask = this.$('.ask')
    const q = ask.querySelector('.q')
    const card = ask.querySelector('.sched-card')
    const filesCard = ask.querySelector('.files-card')
    const [fallback = ''] = [...this.pending.values()].slice(-1)
    try {
      const d = await fetchPrompt(t)
      if (this.thread !== t) return
      if (!d.asking) {
        // Nothing is being asked, or it was answered from another device: nothing to click.
        ask.hidden = true
        paintCard(card, null)
        paintFiles(filesCard, null)
        return
      }
      q.textContent = d.question || fallback
      // A routine Outpost is asking to save is drawn as the card, which says everything the
      // one-line question does; any other ask has no card, so one left from the last never shows.
      // 'schedule' is the same card from a server not yet on routines, as a deploy lands.
      const sched = d.card?.kind === 'routine' || d.card?.kind === 'schedule' ? d.card : null
      paintCard(card, sched)
      // The files a publish would remove from a dataset's source are listed under the question,
      // which stays: the list is what the yes is for (workspaces-data.md).
      paintFiles(filesCard, d.card?.kind === 'files' ? d.card : null)
      q.hidden = Boolean(sched)
      ask.hidden = false
      // Which request this bar is for. It goes back with the answer, so a second click that
      // lands after the next request has taken the bar is refused rather than answering it.
      this.askId = d.id || ''
      const more = d.more > 0 ? ` · ${d.more} more waiting` : ''
      // A question the session asked gets a button per row, in its own order and words. A
      // permission prompt keeps the three fixed verbs, labelled by what the server sent.
      const question = d.kind === 'question'
      ask.querySelector('.head').textContent = (d.head || (question ? 'This session is asking you' : 'Claude needs your permission')) + more
      ask.querySelector('.row').hidden = question
      const opts = ask.querySelector('.opts')
      opts.hidden = !question
      if (question) {
        const html = d.options
          .map(
            (o) =>
              `<button class="btn opt" data-option="${escape(o.key)}" data-expect="${escape(`${o.text} ${o.detail}`.trim())}">` +
              `<b>${escape(o.text)}</b>${o.detail ? `<span>${escape(o.detail)}</span>` : ''}</button>`
          )
          .join('')
        // Rebuilt only when the options change: replacing them every tick swapped the button
        // under the pointer, and its hover style flashed off and on while you read it.
        if (opts.dataset.html !== html) {
          opts.innerHTML = html
          opts.dataset.html = html
        }
        return
      }
      const full = (o) => `${o.text} ${o.detail || ''}`.trim()
      const yes = d.options.find((o) => /^yes\b/i.test(o.text) && !/,\s*and\b/i.test(o.text))
      const always = d.options.find((o) => /^yes,\s*and\b/i.test(full(o)) && !/auto mode/i.test(full(o)))
      const bAllow = ask.querySelector('[data-answer=allow]')
      const bAlways = ask.querySelector('[data-answer=always]')
      bAllow.textContent = yes ? full(yes) : 'Allow'
      bAllow.hidden = !yes
      bAlways.textContent = always ? full(always).replace(/^yes,\s*and\s*/i, (m) => m[0].toUpperCase() + m.slice(1)) : 'Always allow'
      bAlways.hidden = !always
    } catch {
      // The server could not be asked; a pending call is the best signal left.
      if (this.thread !== t) return
      q.textContent = fallback
      q.hidden = false
      paintCard(card, null)
      paintFiles(filesCard, null)
      ask.hidden = !fallback
    } finally {
      this.asking = false
    }
  }

  // ── the handoff ─────────────────────────────────────────────────────────────────────

  /** Which state the open chat's handoff is in, for its block (`handoffState`, state/handoff.js). */
  handoffState() {
    return handoffState(this.thread)
  }

  /**
   * The handoff's block in the log: one object for the whole of it — asked, written, ready or
   * old — with its choices and its confirm inside it, where a bottom card, a toast, a pill and
   * a bar at the top each held a piece (2026-10-19). Steps are marks, never a spinner: the strip
   * is the one spinner (`paintStatus`). The text is read when the block is ready, once per
   * handoff, for the line of section names, and opened in place by View.
   */
  paintHandoff() {
    const t = this.thread
    const state = this.handoffState()
    if (!state) {
      this.tickHandoff(0)
      this.hoEl?.remove()
      this.hoEl = null
      this.hoOpen = false
      for (const n of this.log.querySelectorAll('.onote.hask.absorbed')) n.classList.remove('absorbed')
      return
    }
    const h = t.handoff || {}
    if (!this.hoEl) {
      this.hoEl = document.createElement('div')
      this.hoEl.setAttribute('role', 'group')
      this.hoEl.setAttribute('aria-label', 'Handoff')
    }
    const el = this.hoEl
    const kept = Boolean(h.at)
    const fallback = kept && h.how === 'fallback'
    const trigger = HANDOFF_TRIGGER[h.trigger] || ''
    if (kept && state !== 'progress' && this.handoffText?.at !== h.at && this.hoReading !== h.at) this.readHandoff()
    const text = kept && this.handoffText?.at === h.at ? this.handoffText.text : ''
    const btn = (ho, label, cls = '', title = '') =>
      `<button type="button" class="btn${cls ? ` ${cls}` : ''}" data-ho="${ho}"${title ? ` title="${escape(title)}"` : ''}>${escape(label)}</button>`
    const view = (cls) => (kept ? btn('view', this.hoOpen ? 'Hide' : 'View', cls) : '')
    const copy = kept ? btn('copy', 'Copy', 'ghost') : ''
    const fresh = (cls) =>
      kept && this.can.launch
        ? btn('fresh', 'Start fresh', cls, 'A new conversation in this chat — same workspace, branch and uncommitted changes — with this handoff as its first message. The session now running is ended; this conversation stays above the new one.')
        : ''
    const made = kept ? (fallback ? 'summarised from the transcript' : 'written by the session') : ''
    let mark = ''
    let what = ''
    let tag = ''
    let sub = ''
    let acts = ''
    let steps = ''
    if (state === 'progress') {
      mark = '●'
      what = h.without ? 'Summarising from the transcript' : 'Handing off'
      // One way only, so no popover asked: the head and this line say which, and why.
      if (h.without) sub = `${h.withoutWhy ? `${h.withoutWhy[0].toUpperCase()}${h.withoutWhy.slice(1)} — a` : 'A'} small model reads the conversation and the branch; the session is not asked.`
      steps = this.handoffSteps(h)
      acts = btn('cancel', 'Cancel', 'ghost', h.without ? 'Stop writing it' : 'Stop the turn writing it — the turn only, as Esc does; work committed so far stays committed')
    } else if (state === 'away') {
      mark = '⏸'
      what = 'Marked away · will hand off when this turn ends'
      acts = btn('back', 'Cancel', 'ghost', 'Take the mark down: no handoff is asked for when this turn ends')
    } else if (state === 'held') {
      const size = kTokens(t.retry.heldContext)
      mark = '!'
      what = 'Limit reset · held, not resumed'
      const handoff = !kept ? 'No handoff is kept for it.' : h.stale ? `Its handoff is from ${ago(h.at)}; the session has worked since.` : `Its handoff from ${ago(h.at)} is ${made}.`
      sub = `Resuming rewrites ${size} of context at full price. ${handoff}`
      // The two choices the hold is for, as equals: a new conversation from the handoff — or one
      // written first, without the session — and Resume with its price on it.
      const write = btn('write', 'Write a handoff', '', 'A small model summarises the transcript and the branch into a handoff — the session is not asked, so its context is not rewritten')
      const resume = t.canSend && t.failure?.class === 'transient' ? btn('resume', `Resume · rewrites ${size}`, '', `Send it on: the whole ${exact(t.retry.heldContext)}-token context is written to the cache again at full price`) : ''
      acts = view('ghost') + (kept && !h.stale ? fresh('') : write) + resume
    } else if (state === 'ready') {
      mark = '✓'
      what = `Handoff ready · ${ago(h.at)} · ${made}`
      if (fallback) tag = 'read it first'
      sub = handoffSections(text)
      // Summarised, the default is to read it: View leads and Start fresh asks first. Not now
      // takes it out of Needs you, where one you asked for waits (`handoffWaits`).
      const later = handoffWaits(t) ? btn('dismiss', 'Not now', 'ghost', 'Keep it here, and take this chat out of Needs you') : ''
      acts = later + view(fallback ? 'primary' : 'ghost') + copy + fresh(fallback ? '' : 'primary')
    } else if (state === 'stale') {
      mark = '○'
      what = `Handoff from ${ago(h.at)} · the session has worked since`
      sub = handoffSections(text)
      acts = view('ghost') + copy + btn('refresh', 'Refresh', 'primary', 'Write it again: the session has moved on since this one') + fresh('')
    } else {
      mark = '!'
      what = h.error
      acts = btn('retry', 'Retry', 'primary')
    }
    if (trigger && (state === 'progress' || state === 'ready' || state === 'stale')) what += ` · ${trigger}`
    // Start fresh from a stale or summarised handoff asks here, in place of the buttons.
    if (this.armed === 'fresh' && kept)
      acts = `<div class="hb-ask"><div class="head">Start fresh from this handoff?</div><div class="why">${escape(this.armedWhy || '')}</div><div class="row">${btn('no', 'Cancel')}${btn('yes', 'Start fresh', 'primary')}</div></div>`
    el.className = `hblock ${state}${fallback ? ' fallback' : ''}`
    el.title = kept
      ? `${exact(h.chars)} characters, made at ${exact(h.context)} tokens of context.${fallback ? " Written by a small model from the conversation's tail and the branch, not by the session: check it before starting from it." : ''}`
      : ''
    el.innerHTML =
      `<div class="hb-head"><span class="hb-mark" aria-hidden="true">${mark}</span><span class="hb-what">${escape(what)}</span>${tag ? `<span class="hb-tag">${escape(tag)}</span>` : ''}${state === 'progress' && h.askedAt ? '<span class="hb-time"></span>' : ''}</div>` +
      (sub ? `<div class="hb-sub">${escape(sub)}</div>` : '') +
      steps +
      (this.hoOpen && text ? `<div class="hb-body">${renderMarkdown(text)}</div>` : '') +
      (acts ? `<div class="hb-acts">${acts}</div>` : '')
    this.tickHandoff(state === 'progress' ? h.askedAt : 0)
    this.placeHandoff()
    // Archive's Hand off first: the handoff is kept, so Archive asks again; one that failed or
    // was cancelled lets the intent go, and the person asks again if they still want it.
    const after = this.archiveAfter
    if (after && after.id === t.id) {
      if (state === 'progress') after.seen = true
      // Never seen being written a minute on: that request failed before a roster showed it, and
      // a later handoff must not reopen Archive out of nowhere.
      else if (!after.seen && Date.now() - after.at > 60_000) this.archiveAfter = null
      else if (after.seen) {
        this.archiveAfter = null
        if (state === 'ready') setTimeout(() => this.thread?.id === t.id && this.onArchive())
      }
    }
  }

  /**
   * A handoff being written, as steps, each a mark: ✓ done, ● now, ○ to come, – skipped. The
   * session's are what the log has shown since the request (`handoffStep`): its commit, then the
   * summary's opening marker; one that went straight to the summary had nothing to commit. The
   * fallback is one step and its end: nothing reports from inside it.
   */
  handoffSteps(h) {
    const row = (m, text) => `<li class="${m === '●' ? 'now' : m === '✓' ? 'done' : ''}"><span class="hb-mark" aria-hidden="true">${m}</span>${escape(text)}</li>`
    if (h.without) return `<ol class="hb-steps">${row('●', 'Summarise the transcript and the branch')}${row('○', 'Ready')}</ol>`
    const s = this.hoSteps.at === h.askedAt ? this.hoSteps : { committed: false, writing: false }
    const commit = s.committed ? row('✓', 'Commit the work') : s.writing ? row('–', 'Commit the work · nothing to commit') : row('●', 'Commit the work')
    const write = s.writing ? row('●', 'Write the summary') : row('○', 'Write the summary')
    return `<ol class="hb-steps">${commit}${write}${row('○', 'Ready')}</ol>`
  }

  /**
   * The log showed a step of the handoff being written: `commit` (a `git commit` call) or
   * `writing` (the summary's opening marker). Steps belong to one request, by its `askedAt`.
   */
  handoffStep(kind, ts) {
    const h = this.thread?.handoff
    // `askedAt` is stamped as the request is sent, before the turn does anything: a commit or an
    // answer older than that is the turn before's.
    if (!h?.asking || h.without || !h.askedAt || !(Number(ts) >= h.askedAt - 5000)) return
    if (this.hoSteps.at !== h.askedAt) this.hoSteps = { at: h.askedAt, committed: false, writing: false }
    const key = kind === 'commit' ? 'committed' : 'writing'
    if (this.hoSteps[key]) return
    this.hoSteps[key] = true
    this.paintHandoff()
  }

  /** The block's elapsed time, "0:42", once a second while one is written; `0` stops it. */
  tickHandoff(since) {
    const paint = () => {
      const el = this.hoEl?.querySelector('.hb-time')
      if (!el) return
      const s = Math.max(0, Math.floor((Date.now() - since) / 1000))
      el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
    }
    // A new request (cancelled and asked again) restarts it, counting from its own start.
    if (!since || since !== this.hoSince) {
      clearInterval(this.hoTick)
      this.hoTick = null
      this.hoSince = since
    }
    if (!since) return
    paint()
    if (!this.hoTick) this.hoTick = setInterval(paint, 1000)
  }

  /**
   * Where the block sits: in place of the request it answers (the "Handoff asked for" note) when
   * that is drawn — a request being written, or the one a kept session-written handoff came
   * from — else at the foot, above the live line. While one is written it is sticky to the log's
   * foot (styles.css), so it is in sight without scrolling, and settles in place once ready.
   */
  placeHandoff() {
    const el = this.hoEl
    if (!el) return
    const stick = this.stuck
    const anchor = this.handoffAnchor()
    for (const n of this.log.querySelectorAll('.onote.hask.absorbed')) if (n !== anchor) n.classList.remove('absorbed')
    if (anchor) {
      anchor.classList.add('absorbed')
      if (anchor.nextElementSibling !== el) anchor.after(el)
    } else {
      const live = this.liveEl?.parentNode === this.log && !this.liveEl.nextElementSibling ? this.liveEl : null
      if (live) {
        if (live.previousElementSibling !== el) live.before(el)
      } else if (this.log.lastElementChild !== el) this.log.appendChild(el)
    }
    if (stick) this.toFoot()
  }

  /** The request note the block stands in for, or null: see `placeHandoff`. */
  handoffAnchor() {
    const h = this.thread?.handoff || {}
    const notes = [...this.log.querySelectorAll('.onote.hask')]
    const at = (n) => Number(n.dataset.ts) || 0
    // The note is written as the request is sent; `askedAt` is stamped just after.
    if (h.asking && !h.without) return notes.filter((n) => at(n) >= h.askedAt - 120_000).pop() || null
    if (!h.asking && h.at && h.how === 'session') return notes.filter((n) => at(n) <= h.at && at(n) >= h.at - 35 * 60_000).pop() || null
    return null
  }

  /** A press inside the block. */
  handoffAct(act) {
    if (act === 'view') return this.toggleHandoff()
    if (act === 'copy') return this.copyHandoff()
    if (act === 'fresh' || act === 'yes') return this.onFresh()
    if (act === 'no') return this.onCancel()
    if (act === 'write' || act === 'refresh' || act === 'retry') return this.handOff()
    if (act === 'resume') return this.restart()
    if (act === 'cancel') return this.cancelHandoff()
    if (act === 'dismiss' && this.thread)
      return dismissHandoff(this.thread)
        .then((res) => (res.ok ? this.onActed() : this.onToast(res.error || 'Could not set it aside', 'err')))
        .catch((err) => this.onToast(err.message || 'Could not set it aside', 'err'))
    if (act === 'back' && this.thread)
      comeBack(this.thread)
        .then(() => this.onActed())
        .catch((err) => this.onToast(err.message || 'Could not take the mark down', 'err'))
  }

  /**
   * The tool row's Hand off: asks for one, or — with a current handoff kept, which the server
   * would not write again — takes you to its block, where Start fresh is, wherever the log has
   * scrolled to.
   */
  handoffButton() {
    if (this.handoffState() === 'ready' && this.hoEl) {
      this.hoEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      return
    }
    if (this.pop === 'handoff') return this.closePop()
    // Only where there is a real choice: a session warm enough to be asked can also be passed
    // over for a summary. Anything else has one way, which the block's head then says (2026-10-19).
    if (!handoffChoice(this.thread)) return this.handOff()
    this.hoPath = 'session'
    this.paintHandoffPop()
  }

  /** The Hand off popover, for the path chosen in it (`hoPath`): what will happen, and the switch. */
  paintHandoffPop() {
    const t = this.thread
    const size = t.context ? kTokens(t.context) : 'its'
    const session = this.hoPath === 'session'
    this.openPop('handoff', {
      head: 'Hand off',
      why: session
        ? `The session commits its work and writes the summary — one turn, re-reading ${size} of context from the cache. About a minute or two.`
        : 'A small model summarises the transcript and the branch. The session is not asked and nothing is re-read. Read it before starting fresh.',
      alt: session ? 'Summarise without the session instead' : `Ask the session instead · re-reads ${size}`,
      verb: 'Hand off',
    })
  }

  /**
   * Put the tool row's popover up — a question anchored under the buttons that raised it, not a
   * modal: `head`, a sentence, an optional switch (`alt`), then Cancel and the verb. One at a
   * time; a press anywhere else, Esc, or a change of chat is Cancel.
   */
  openPop(kind, { head, why, alt = '', verb, danger = false, extra = null }) {
    const pop = this.$('.tpop')
    // Another question over an armed Archive takes the Archive down first: left armed, the next
    // press of Archive would go ahead with no question.
    if (this.pop === 'archive' && kind !== 'archive') this.closePop()
    this.pop = kind
    pop.innerHTML =
      `<div class="head">${escape(head)}</div><div class="why">${escape(why)}</div>` +
      (alt ? `<button type="button" class="alt" data-pop="alt">${escape(alt)}</button>` : '') +
      `<div class="row"><button type="button" class="btn" data-pop="no">Cancel</button>${extra ? `<button type="button" class="btn" data-pop="${extra.act}">${escape(extra.label)}</button>` : ''}<button type="button" class="btn ${danger ? 'danger' : 'primary'}" data-pop="yes">${escape(verb)}</button></div>`
    const opening = pop.hidden
    if (opening) this.popFrom = document.activeElement
    pop.hidden = false
    pop.querySelector('[data-pop=yes]').focus()
    if (!opening) return
    this.popAway = (e) => {
      if (!e.target.closest('.tpop, .actions .far')) this.closePop()
    }
    document.addEventListener('pointerdown', this.popAway, true)
  }

  closePop() {
    const pop = this.$('.tpop')
    const was = this.pop
    this.pop = ''
    // Archive's confirm is the page's: closing its question disarms it (`arm`).
    if (was === 'archive') this.onCancel()
    if (pop.hidden) return
    // Back to where the question was raised from, while focus is still in it.
    const back = pop.contains(document.activeElement) && this.popFrom?.isConnected ? this.popFrom : null
    pop.hidden = true
    pop.innerHTML = ''
    document.removeEventListener('pointerdown', this.popAway, true)
    this.popAway = null
    this.popFrom = null
    back?.focus()
  }

  /** A press in the popover. */
  popAct(act) {
    const kind = this.pop
    if (act === 'no') return this.closePop()
    if (kind === 'archive' && act === 'yes') return this.onArchive()
    // Hand off first: the default way, then the question again once the handoff is ready
    // (`paintHandoff`). This page's memory only: another device, or a reload, asks nothing.
    if (kind === 'archive' && act === 'first') {
      const id = this.thread?.id || ''
      this.closePop()
      return this.handOff().then((ok) => {
        if (ok && this.thread?.id === id) this.archiveAfter = { id, seen: false, at: Date.now() }
      })
    }
    if (kind === 'handoff' && act === 'alt') {
      this.hoPath = this.hoPath === 'session' ? 'without' : 'session'
      return this.paintHandoffPop()
    }
    if (kind === 'handoff' && act === 'yes') {
      const without = this.hoPath === 'without'
      this.closePop()
      return this.handOff({ without })
    }
  }

  /** The kept handoff's text, read once per handoff and kept until the chat changes. */
  async handoffBody() {
    const t = this.thread
    const at = t?.handoff?.at
    if (!at) return ''
    if (this.handoffText?.at === at) return this.handoffText.text
    const res = await fetchHandoff(t)
    if (this.thread?.id !== t.id) return ''
    const text = res?.handoff?.text || ''
    this.handoffText = { at: res?.handoff?.at || at, text }
    return text
  }

  /** Read the text for the block's line of sections, once per handoff, and paint it in. */
  async readHandoff() {
    const at = this.thread?.handoff?.at
    this.hoReading = at
    try {
      await this.handoffBody()
      if (this.thread?.handoff?.at === at) this.paintHandoff()
    } catch {
      // The line of sections is a nicety; View says why when the text cannot be read.
    }
  }

  async toggleHandoff() {
    if (this.hoOpen) {
      this.hoOpen = false
      this.paintHandoff()
      return
    }
    try {
      const text = await this.handoffBody()
      if (!text) return this.onToast('There is no handoff to show', 'err')
      this.hoOpen = true
      this.paintHandoff()
    } catch (err) {
      this.onToast(err.message || 'Could not read the handoff', 'err')
    }
  }

  async copyHandoff() {
    try {
      const text = await this.handoffBody()
      if (!text) return this.onToast('There is no handoff to copy', 'err')
      await copyString(text)
      this.onToast('Copied the handoff', 'ok')
    } catch (err) {
      this.onToast(err.message || 'Could not copy the handoff', 'err')
    }
  }

  /** The block's Cancel: nothing is said on a yes — the block goes with the next roster. */
  async cancelHandoff() {
    const t = this.thread
    if (!t) return
    try {
      const res = await cancelHandoff(t)
      if (!res.ok) return this.onToast(res.error || 'Could not cancel the handoff', 'err')
      if (res.error) this.onToast(`Cancelled, but the turn did not stop — ${res.error}`, 'err')
      this.onActed()
    } catch (err) {
      this.onToast(err.message || 'Could not cancel the handoff', 'err')
    }
  }

  /**
   * Ask for a handoff. A refusal says why — working, asking you, asked already — in a toast; a
   * yes says nothing here: the block appears with the next roster, and it is the feedback.
   */
  async handOff({ without = false } = {}) {
    const t = this.thread
    if (!t) return
    try {
      const res = await askHandoff(t, { without })
      if (!res.ok) {
        this.onToast(res.error || 'Could not ask for a handoff', 'err')
        return false
      }
      this.poll()
      this.onActed()
      return true
    } catch (err) {
      this.onToast(err.message || 'Could not ask for a handoff', 'err')
      return false
    }
  }

  // ── polling ─────────────────────────────────────────────────────────────────────────

  async poll() {
    if (!this.thread || document.hidden) return
    // One read at a time *per thread*. `busy` names the thread being read rather than saying
    // only that a read is out: as a plain flag, a read still in flight for the chat you just
    // left made the first read of the chat you opened return here, and the log stayed blank
    // until the ten-second fallback tick.
    const id = this.thread.id
    if (this.busy === id) return
    this.busy = id
    const thread = this.thread
    const epoch = this.epoch
    try {
      // The first read is the last page; the rest is read on the way up (`loadEarlier`).
      const res = await fetchTranscript(thread, this.offset, this.offset ? {} : { bytes: PAGE_BYTES })
      // The selection moved while we were waiting; this answer is for someone else. The epoch
      // covers leaving and coming back: the same thread, but a log that has been reset since.
      // By id, never by object: every roster hands `update` new objects for the same threads,
      // and the one the stream sends right after a load nearly always lands while the first
      // read is out — which threw that read away and left the log on "Loading…" until the
      // ten-second fallback tick.
      if (this.thread?.id !== id || this.epoch !== epoch) return
      const fetched = performance.now()
      this.offset = res.offset || this.offset
      this.note(res)
      if (res.messages?.length) this.append(res.messages)
      this.paintPartial(res.partial || '')
      this.settleQueued(res.messages || [])
      // Set up reading upwards; a chat started fresh reads on into its earlier conversations,
      // newest first (handoff.md).
      if (!this.back && !res.missing) {
        this.back = { sources: [thread, ...[...(thread.earlier || [])].reverse()], k: 0, before: res.start || 0, done: false }
        this.nextSource()
        this.paintMore()
        this.maybeEarlier()
      }
      // How long opening a chat took, split at the answer: "switching is slow" was reported,
      // and the server answers the first read in tens of milliseconds, so the console says
      // whether the wait was the request or the drawing. Once per open.
      // Measured to the frame after, so the browser's layout and paint count as drawing.
      if (this.openedAt) {
        const opened = this.openedAt
        const n = res.messages?.length || 0
        this.openedAt = 0
        requestAnimationFrame(() =>
          setTimeout(() => {
            const drawn = performance.now()
            console.info(`[outpost] opened a chat in ${Math.round(drawn - opened)} ms — request ${Math.round(fetched - opened)} ms, drawing ${Math.round(drawn - fetched)} ms, ${n} messages`)
          })
        )
      }
      // A standing prompt adds nothing to the transcript, so the poll that matters for the
      // permission bar is the one with no new messages. Ask every tick either way.
      if (thread.canSend) this.describeAsk()
      // An effort list that came back empty is asked for again while the menu is open,
      // rather than making somebody close and reopen it. One request per tick, and only
      // while the menu is actually showing.
      if (this.modelsOpen && !this.efforts.length && !this.modelBusy) this.loadMenu()
    } catch (err) {
      this.note({ error: err.message })
    } finally {
      if (this.busy === id && this.epoch === epoch) this.busy = ''
    }
  }

  /** Past a source read to its start, on to the next earlier one; `done` past the last. */
  nextSource() {
    const b = this.back
    while (b.before === 0) {
      b.k += 1
      b.before = null
      if (b.k >= b.sources.length) {
        b.done = true
        return
      }
    }
  }

  /**
   * On a phone, reading down folds the header to the title and a 3 px context bar, and reading
   * back up unfolds it: three rows of header were a fifth of the screen. Judged on distance
   * travelled one way (`COLLAPSE_PX`), so a jitter does not flip it. Programmatic scrolls —
   * following the foot, keeping the line while a page above is drawn — resync `foldY` where
   * they write `scrollTop` (`toFoot`, `prepend`), so only the reader's scroll counts.
   */
  foldOnScroll() {
    const l = this.log
    // iOS reports its rubber band past either end; the bounce back would read as a scroll up.
    const y = Math.max(0, Math.min(l.scrollTop, l.scrollHeight - l.clientHeight))
    const dy = y - this.foldY
    this.foldY = y
    if (!isPhone() || !l.clientHeight) return
    // Reading upwards for history: the page lands with a jump of its own height.
    if (this.backBusy || performance.now() < this.foldHold) {
      this.foldRun = 0
      return
    }
    // Nothing to scroll, or back at the top: no way left to bring the row back but a tap.
    if (l.scrollHeight <= l.clientHeight || y === 0) return this.fold(false)
    this.foldRun = Math.sign(dy) === Math.sign(this.foldRun) ? this.foldRun + dy : dy
    if (this.foldRun > COLLAPSE_PX) this.fold(true)
    else if (this.foldRun < -COLLAPSE_PX) this.fold(false)
  }

  /** Fold or unfold the phone header: `data-collapsed` on the panel, the rest is CSS. */
  fold(on) {
    if (on === 'collapsed' in this.el.dataset) return
    this.foldRun = 0
    this.foldHold = performance.now() + FOLD_HOLD_MS
    this.el.toggleAttribute('data-collapsed', on)
  }

  /** Read another page when the reader is within a screen of the top of what is drawn. */
  maybeEarlier() {
    const l = this.log
    if (this.back && !this.back.done && !this.backBusy && l.clientHeight && l.scrollTop < l.clientHeight) this.loadEarlier()
  }

  /**
   * The page above the top of the log: this conversation's, then its earlier ones', newest
   * first — the same log scrolled back, rather than a link to somewhere else, since the person
   * reading a fresh conversation is often checking what the handoff left out. Earlier
   * conversations are finished, so they are never tailed. Read as the reader nears the top,
   * never on open: a chat with three of them drew all three before its own first line.
   */
  async loadEarlier() {
    const b = this.back
    if (!this.thread || !b || b.done || this.backBusy) return
    const id = this.thread.id
    const epoch = this.epoch
    const src = b.sources[b.k]
    this.backBusy = true
    this.paintMore()
    let res
    try {
      res = await fetchTranscript(src, 0, b.before === null ? { bytes: PAGE_BYTES } : { before: b.before, bytes: PAGE_BYTES })
    } catch {
      res = null
    }
    if (this.thread?.id !== id || this.epoch !== epoch) return
    this.backBusy = false
    if (!res?.ok) {
      b.failed = true
      return this.paintMore()
    }
    b.failed = false
    b.before = res.start || 0
    if (res.messages?.length) this.prepend(res.messages, b.k ? src : null)
    this.nextSource()
    this.paintMore()
    // A page of nothing but tool calls draws a line or two; keep going until there is a screen above.
    requestAnimationFrame(() => this.maybeEarlier())
  }

  /** The control at the top of the log: there is more above, it is coming, or it failed. */
  paintMore() {
    const el = this.$('.more')
    const b = this.back
    el.hidden = !b || b.done
    el.disabled = this.backBusy
    el.textContent = this.backBusy ? 'Loading earlier…' : b?.failed ? 'Could not read earlier messages — try again' : 'Earlier messages'
  }

  /** The one line above the log: loading, nothing yet, or an error. */
  note(res) {
    const el = this.$('.note')
    let text = ''
    if (res.error) text = res.error
    else if (res.loading) text = 'Loading…'
    else if (res.missing && !this.seen.size) text = 'Nothing said yet'
    el.textContent = text
    el.hidden = !text
  }

  /** New items at the foot of the log, from a tail read. */
  append(items) {
    const stick = this.stuck
    this.log.appendChild(this.draw(items, null, this))
    this.paintHeldNote()
    this.placeLive()
    this.placeHandoff()
    if (stick) this.toFoot()
  }

  /**
   * A page read upwards, above what is drawn. The view stays on the line the reader was
   * looking at; the page grows above it. Its tool groups go in above Activity's too, and a
   * run of calls cut by the page boundary stays two groups rather than being stitched.
   */
  prepend(items, source) {
    const l = this.log
    const height = l.scrollHeight
    const top = l.scrollTop
    const sink = { group: null, at: this.activity.head(), above: true }
    let frag
    this.activity.above(() => (frag = this.draw(items, source, sink)))
    this.$('.more').after(frag)
    // The request a kept handoff answered may be on this page: the block moves up to it, from
    // below the line being read to above it, and the view keeps that line by its height too.
    const was = this.hoEl?.offsetTop ?? 0
    this.placeHandoff()
    const lift = this.hoEl && this.hoEl.offsetTop < was ? this.hoEl.offsetHeight + 14 : 0
    if (this.stuck) this.toFoot()
    else l.scrollTop = top + (l.scrollHeight - height) + lift
    this.foldY = l.scrollTop // the page's own height, not a scroll down (`foldOnScroll`)
  }

  toFoot() {
    this.log.scrollTop = this.log.scrollHeight
    this.foldY = this.log.scrollTop // following the foot is not reading down (`foldOnScroll`)
  }

  /**
   * Items as log elements, in a fragment. `source` is the earlier conversation they came from,
   * when not this thread's own. `sink` carries the run of tool calls the drawing is in the
   * middle of (`group`) and, for a page above, the Activity group it goes in before (`at`):
   * the tail's is the panel itself, a page's is its own.
   */
  draw(items, source, sink) {
    const frag = document.createDocumentFragment()
    for (const it of items) {
      if (it.kind === 'tool_result') {
        this.patchResult(it)
        continue
      }
      if (it.kind === 'agent_done') {
        if (!this.seen.has(it.id)) {
          this.seen.add(it.id)
          this.agentDone(it, frag, sink)
        }
        continue
      }
      if (this.seen.has(it.id)) continue
      this.seen.add(it.id)
      // Something Outpost sent the session — a Jenkins result that woke it — drawn as a note
      // in the log, never as a bubble of the person's (harnesses.md).
      if (it.kind === 'note') {
        const el = document.createElement('div')
        el.className = `onote ${it.tone === 'failure' ? 'failed' : it.tone === 'success' ? 'ok' : ''}`
        el.textContent = it.text
        // A handoff's request: where its block anchors, drawn in the note's place (`placeHandoff`).
        // Not in an earlier conversation's page, whose handoff was used.
        if (it.text === HANDOFF_LEAD && !source) {
          el.classList.add('hask')
          el.dataset.ts = String((typeof it.ts === 'number' ? it.ts : Date.parse(it.ts)) || 0)
        }
        frag.appendChild(el)
        sink.group = null
        continue
      }
      // The summary a session carried on from when its context ran out: a one-line marker
      // that unfolds the summary in place, never a bubble of the person's (harnesses.md).
      if (it.kind === 'compact') {
        const el = document.createElement('details')
        el.className = 'compacted'
        el.innerHTML = `<summary>Context compacted · ${when(it.ts)}</summary><div class="body"></div>`
        el.querySelector('.body').innerHTML = renderMarkdown(it.text)
        frag.appendChild(el)
        sink.group = null
        continue
      }
      // The handoff a fresh conversation started from (harnesses.md `handoff`): the divider
      // between this chat's conversations, and the handoff under it, open — it is what the new
      // session knows, and what the person reads to check it.
      if (it.kind === 'handoff') {
        const el = document.createElement('div')
        el.className = 'fresh'
        el.innerHTML = `<div class="divider"><span>Fresh start from handoff · ${escape(when(it.ts))}</span></div><details class="handoff-doc" open><summary>The handoff</summary><div class="body"></div></details>`
        el.querySelector('.body').innerHTML = renderMarkdown(it.text)
        frag.appendChild(el)
        sink.group = null
        continue
      }
      if (it.kind === 'tool') {
        this.step(it, frag, sink)
        continue
      }
      sink.group = null
      // Images sent together share one row of thumbnails rather than a bubble each.
      const last = frag.lastElementChild
      if (it.kind === 'image' && last?.classList.contains('image')) {
        this.picture(it, last.querySelector('.body'), source)
        continue
      }
      frag.appendChild(this.bubble(it, source))
    }
    return frag
  }

  /**
   * A background agent finished: its report goes to the Activity panel against the Agent
   * row, and the log gets a marker saying so where the notification arrived — a reader who
   * sees the session answer "the probe is written" wants to find the report that said it.
   */
  agentDone(it, frag, sink) {
    const group = this.activity.finishAgent(it, sink.at)
    const el = document.createElement('button')
    el.type = 'button'
    el.className = `steps agent${it.status === 'completed' ? '' : ' failed'}`
    el.dataset.group = group
    el.title = 'Show the agent\'s report in Activity'
    el.textContent = it.summary || 'Agent finished'
    frag.appendChild(el)
    sink.group = null
  }

  /**
   * A tool call: into the Activity panel, under the group the log is in the middle of — or a
   * new group, with a new marker in the log, if the last thing drawn was something said.
   * A call already there is an Agent call whose completion was drawn first, from a later page
   * (`finishAgent` stood a row in for it).
   */
  step(it, frag, sink) {
    if (this.activity.has(it.id)) return
    if (!sink.group) {
      const el = document.createElement('button')
      el.type = 'button'
      el.className = 'steps'
      el.dataset.group = it.id
      el.title = 'Show these steps here; each opens in Activity'
      el.setAttribute('aria-expanded', 'false')
      sink.group = { id: it.id, el, n: 0 }
      frag.appendChild(el)
    }
    sink.group.n += 1
    sink.group.el.textContent = `${sink.group.n} step${sink.group.n === 1 ? '' : 's'}`
    // Only calls at the foot can be the one a permission prompt is about. One from a page above
    // with no result — an interrupted call — would otherwise be the newest entry here.
    if (!sink.above) this.pending.set(it.id, `${it.name}  ${it.summary || ''}`.trim())
    // A handoff's first step, its commit (`handoffStep`): a call at the foot, after the request.
    if (!sink.above && it.name === 'Bash' && /\bgit\b[^\n]*\bcommit\b/.test(it.detail || '')) this.handoffStep('commit', it.ts)
    this.activity.add(it, sink.group.id, sink.at)
    this.refreshSteps(sink.group.id)
    const result = this.orphans.get(it.id)
    if (result) {
      this.orphans.delete(it.id)
      this.patchResult(result)
    }
  }

  /**
   * Open or close a run's steps in place, under its marker: a quiet block, `N steps · when ·
   * how long`, then a line per call, `tool  summary`, each opening its row in Activity, which
   * keeps the input, the result and the diff. Closed by default on every size; the open state
   * is the element's, so a chat opened again starts closed.
   */
  toggleSteps(marker) {
    const group = marker.dataset.group
    const open = this.openSteps.get(group)
    if (open) {
      open.remove()
      this.openSteps.delete(group)
      marker.setAttribute('aria-expanded', 'false')
      return
    }
    const block = document.createElement('div')
    block.className = 'stepsblock'
    marker.after(block)
    this.openSteps.set(group, block)
    marker.setAttribute('aria-expanded', 'true')
    this.paintSteps(block, group)
  }

  /** An open steps block, again, after its run grew or a result landed. */
  refreshSteps(group) {
    const block = this.openSteps.get(group)
    if (block?.isConnected) this.paintSteps(block, group)
  }

  paintSteps(block, group) {
    const d = this.activity.steps(group)
    if (!d?.calls.length) {
      block.innerHTML = '<div class="sb-head">These steps are not in Activity</div>'
      return
    }
    const n = d.calls.length
    const took = d.start && d.end > d.start ? span(d.end - d.start) : ''
    const head = [`${n} step${n === 1 ? '' : 's'}`, d.start ? when(d.start) : '', took].filter(Boolean).join(' · ')
    block.innerHTML =
      `<div class="sb-head">${escape(head)}</div>` +
      d.calls
        .map(
          (c) =>
            `<button type="button" class="sb-call" data-group="${escape(group)}" data-call="${escape(c.id)}" title="Open this call in Activity">` +
            `<span class="sb-tool">${escape(c.name)}</span><span class="sb-sum">${escape(c.summary)}</span></button>`
        )
        .join('')
  }

  /**
   * While the thread is working, one line under the last thing the session said (its time, or
   * the log's foot when the last thing is yours): `● <activity> · step <steps>`, from the
   * roster's `activity` and `steps` (hooks.md). Painted by `show` and `update` from the
   * roster, never from a read: a read only moves it back to its place (`placeLive`). The
   * strip keeps its own line, the only place the status word is.
   */
  paintLive() {
    const t = this.thread
    if (!t || this.look.key !== 'working') {
      this.liveEl?.remove()
      this.liveEl = null
      return
    }
    if (!this.liveEl) {
      this.liveEl = document.createElement('div')
      this.liveEl.className = 'live'
      this.liveEl.innerHTML = '<span class="lv-dot">●</span><span class="lv-text"></span>'
    }
    const steps = Number(t.steps) || 0
    this.liveEl.querySelector('.lv-text').textContent = [t.activity || 'Working', steps ? `step ${steps}` : ''].filter(Boolean).join(' · ')
    this.placeLive()
  }

  /** The live line under the last assistant message's time, or at the foot after anything else. */
  placeLive() {
    const el = this.liveEl
    if (!el) return
    const stick = this.stuck
    let last = this.log.lastElementChild
    if (last === el) last = el.previousElementSibling
    const at = last?.matches('.msg.assistant') ? last.querySelector(':scope > .when') : null
    if (at) {
      if (at.nextElementSibling !== el) at.after(el)
    } else if (this.log.lastElementChild !== el) this.log.appendChild(el)
    if (stick) this.toFoot()
  }

  /**
   * The answer being written, drawn at the foot of the log and replaced on every read; gone
   * the moment the whole message lands in the transcript, which the next append draws.
   */
  paintPartial(text) {
    let el = this.log.querySelector('.msg.partial')
    if (!text) {
      if (el) {
        el.remove()
        this.placeLive()
      }
      return
    }
    const stick = this.stuck
    if (!el) {
      el = document.createElement('div')
      el.className = 'msg assistant partial'
      el.innerHTML = `<div class="when">writing…</div><div class="body"></div>`
      this.log.appendChild(el)
      this.placeLive()
    }
    el.querySelector('.body').innerHTML = renderMarkdown(text)
    // The summary has begun once its opening marker is written (`handoffStep`).
    if (/^#{0,6}[ \t]*Handoff · [0-9a-f]{6}/m.test(text)) this.handoffStep('writing', Date.now())
    if (stick) this.toFoot()
  }

  /**
   * Take off the queue what this read brought back, then redraw what is left. A message sent
   * mid-turn is queued by the CLI and written to the transcript only beside the next tool
   * result — minutes behind a long command — so the page would show nothing between Send and
   * then. Matched by text, oldest first, against messages read *after* the send: the
   * transcript is the only copy, and a page-made id never reaches it. One the turn ended
   * without is dropped after `QUEUED_GRACE_MS`, so a send the CLI lost does not wait forever.
   */
  settleQueued(items) {
    const id = this.thread?.id
    const list = id && this.queued.get(id)
    if (!list) return this.paintQueued()
    const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim()
    for (const it of items) {
      if (it.role !== 'user' || it.kind !== 'text') continue
      const said = flat(it.text)
      const i = list.findIndex((q) => said.includes(flat(q.text)))
      if (i >= 0) list.splice(i, 1)
    }
    const now = Date.now()
    const left = this.thread.running ? list : list.filter((q) => now - q.at < QUEUED_GRACE_MS)
    if (left.length) this.queued.set(id, left)
    else this.queued.delete(id)
    this.paintQueued()
  }

  /** The queued messages, always the foot of the log: below the answer being written. */
  paintQueued() {
    for (const el of this.log.querySelectorAll('.msg.queued')) el.remove()
    const list = (this.thread && this.queued.get(this.thread.id)) || []
    if (!list.length) return
    const stick = this.stuck
    for (const q of list) {
      const el = document.createElement('div')
      el.className = 'msg user queued'
      el.title = 'Sent. The session takes it at its next step, and it shows here properly then.'
      el.innerHTML = `<div class="when"><span class="spin"></span>queued</div><div class="body"></div>`
      el.querySelector('.body').textContent = q.text
      this.log.appendChild(el)
    }
    this.placeLive()
    if (stick) this.toFoot()
  }

  bubble(it, source = null) {
    const el = document.createElement('div')
    el.className = `msg ${it.role}`
    el.innerHTML = `<div class="when">${when(it.ts)}</div><div class="body"></div>`
    const body = el.querySelector('.body')
    // What the session says is Markdown, and it is read here rather than in a terminal, so it
    // is drawn as Markdown — headings, tables and code blocks are most of a long answer, and
    // as source they are a wall of pipes and asterisks. What *you* typed is shown as typed:
    // a prompt is not a document, and formatting it would rewrite the thing you sent.
    if (it.kind === 'image') {
      el.classList.add('image')
      this.picture(it, body, source)
    } else if (it.kind === 'file') {
      el.classList.add('file')
      body.innerHTML = `${ICON.file}<span></span>`
      body.querySelector('span').textContent = it.name
    } else if (it.role === 'assistant') this.answerBody(body, localizeResets(it.text, it.ts), it.ts)
    else {
      body.textContent = it.text
      this.clampPaste(el, it.text)
    }
    if (it.role === 'user') el.querySelector('.when').textContent = `you · ${when(it.ts)}`
    return el
  }

  /**
   * An answer, as Markdown — with a handoff the session wrote between its markers (handoff.md)
   * folded to one line that opens on it: the block in the log is where a handoff is read and
   * used, and the same page drawn in full under it said everything twice.
   */
  answerBody(body, text, ts) {
    const cut = cutHandoff(text)
    if (cut) this.handoffStep('writing', ts)
    if (!cut) {
      body.innerHTML = renderMarkdown(text)
      return
    }
    body.innerHTML = `${cut.rest ? renderMarkdown(cut.rest) : ''}<details class="compacted"><summary>The handoff it wrote</summary><div class="body"></div></details>`
    body.querySelector('details .body').innerHTML = renderMarkdown(cut.handoff)
  }

  /**
   * A long message of yours — a pasted log, a file's worth of text — drawn three lines high
   * with "pasted · N lines" and Show more, so one paste does not push the answer to it a
   * screen down. Page-only: the open state is the element's and a repaint closes it again.
   */
  clampPaste(el, text) {
    const lines = String(text || '').split('\n').length
    if (lines <= PASTE_LINES && String(text || '').length <= PASTE_CHARS) return
    el.classList.add('long')
    const foot = document.createElement('div')
    foot.className = 'paste'
    foot.innerHTML = `<span></span><button type="button" class="show">Show more</button>`
    foot.querySelector('span').textContent = `pasted · ${lines} line${lines === 1 ? '' : 's'}`
    const btn = foot.querySelector('button')
    btn.addEventListener('click', () => {
      const open = el.classList.toggle('open')
      btn.textContent = open ? 'Show less' : 'Show more'
    })
    el.appendChild(foot)
  }

  /**
   * An attached image, drawn as itself rather than as the word for it — a screenshot is the
   * context for the prompt beside it, and it has to be there on the phone you moved to, not
   * only on the desktop it was pasted into. The bytes come out of the transcript on the
   * server (harnesses.md `readImage`), so nothing depends on this device ever having held it.
   *
   * Drawn as a thumbnail, one slot in the bubble's row, so a full-size screenshot does not
   * take a screen of the log; a click opens it full size.
   *
   * The slot starts as `[image]` and stays that way if the fetch fails. Fetches run one
   * behind another: each makes the server read the whole transcript, and a log opening on
   * ten screenshots should not ask for ten of those at once.
   */
  picture(it, body, source = null) {
    const slot = document.createElement('span')
    slot.className = 'pic-wait'
    slot.textContent = '[image]'
    body.appendChild(slot)
    // An image in an earlier conversation is in that conversation's transcript, not this one's.
    const thread = source || this.thread
    this.loading = this.loading.then(async () => {
      if (!slot.isConnected) return // the log moved on to another thread while this one queued
      let url = ''
      try {
        url = URL.createObjectURL(await fetchImage(thread, it.id))
        const img = new Image()
        img.alt = 'Attached image'
        img.src = url
        await img.decode()
        if (!slot.isConnected) throw new Error('gone')
        const stick = this.stuck
        const pic = document.createElement('button')
        pic.type = 'button'
        pic.className = 'pic'
        pic.title = 'View full size'
        pic.appendChild(img)
        pic.addEventListener('click', () => this.zoom(url))
        slot.replaceWith(pic)
        this.pictures.push(url)
        if (stick) this.toFoot()
      } catch {
        if (url) URL.revokeObjectURL(url)
      }
    })
  }

  /** The image at full size over the page. A click anywhere or Escape puts it away. */
  zoom(url) {
    this.unzoom?.()
    const box = document.createElement('div')
    box.className = 'lightbox'
    const img = new Image()
    img.alt = 'Attached image'
    img.src = url
    box.appendChild(img)
    // Capturing, and stopped there: Escape with a picture open closes the picture, not the
    // chat underneath it, which is what the page's own handler would do with the same key.
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      this.unzoom()
    }
    this.unzoom = () => {
      box.remove()
      window.removeEventListener('keydown', onKey, true)
      this.unzoom = null
    }
    box.addEventListener('click', () => this.unzoom())
    window.addEventListener('keydown', onKey, true)
    document.body.appendChild(box)
  }

  /**
   * A result read before its call is kept for it: the page that starts the log, and every
   * page read upwards, can open on results whose calls are on the page above.
   */
  patchResult(it) {
    if (!this.activity.has(it.id)) {
      if (this.orphans.size < ORPHANS_MAX) this.orphans.set(it.id, it)
      return
    }
    this.pending.delete(it.id)
    const group = this.activity.patch(it)
    if (group) this.refreshSteps(group)
  }

  // ── the draft ───────────────────────────────────────────────────────────────────────

  /**
   * Put the unsent draft away with the thread it was typed to, on the way out of it.
   *
   * One panel serves every thread, so the box is the same box — and it kept whatever was in it
   * across a selection, which read as a half-written prompt having followed you into somebody
   * else's conversation. One Enter there sends it to the wrong session. Clearing the box on
   * every switch fixes that and loses the paragraph you were part way through, so the draft is
   * kept per thread instead and comes back when you do.
   *
   * The attached files go with it: they are part of the same unsent prompt, and dropping them while
   * keeping the words would restore half of it.
   */
  stashDraft() {
    if (!this.thread) return
    const box = this.$('.composer textarea')
    const text = box ? box.value : ''
    if (!text.trim() && !this.files.length) this.drafts.delete(this.thread.id)
    else this.drafts.set(this.thread.id, { text, files: this.files })
  }

  /** Put this thread's draft back in the box, after `reset` has emptied it. */
  restoreDraft() {
    const draft = (this.thread && this.drafts.get(this.thread.id)) || { text: '', files: [] }
    const box = this.$('.composer textarea')
    if (box) box.value = draft.text
    this.files = [...draft.files]
    this.paintPending()
    this.autosize()
  }

  // ── attachments ─────────────────────────────────────────────────────────────────────

  /**
   * Grow the box to whatever is in it, and let it fall back when that is sent.
   *
   * A fixed two rows shows the tail of a paragraph and nothing else, and dragging the corner
   * to read the rest leaves the box that tall over every one-line message after it. The
   * height is measured rather than counted, because `rows` cannot know where the text wrapped:
   * `scrollHeight` is the wrapped height. It is cleared to `auto` first or the box could only
   * ever grow — `scrollHeight` never reports less than the height already standing. The CSS
   * min and max still hold: below the min the rest state is the same box it always was, above
   * the max it stops and scrolls rather than eating the log.
   */
  autosize() {
    const box = this.$('.composer textarea')
    if (!box || this.$('.composer').hidden) return // a hidden box measures 0 and would collapse
    box.style.height = 'auto'
    // `scrollHeight` counts content and padding; the box is `border-box`, so the border has to
    // go back on or the last line sits under a scrollbar that has no reason to be there.
    box.style.height = `${box.scrollHeight + box.offsetHeight - box.clientHeight}px`
  }

  attach(files) {
    this.files.push(...files)
    this.paintPending()
  }

  paintPending() {
    const el = this.$('.pending')
    if (!el) return
    el.innerHTML = this.files
      .map(
        (f, i) =>
          `<span class="chip">${f.type.startsWith('image/') ? `<img alt="" src="${URL.createObjectURL(f)}" />` : ICON.file}<span>${escape(f.name || 'file')}</span><button type="button" data-remove="${i}" title="Remove">✕</button></span>`
      )
      .join('')
    el.hidden = this.files.length === 0
  }

  // ── acting ──────────────────────────────────────────────────────────────────────────

  /** The repos `/addRepo` offers: the catalogue, from `main.js`. */
  setCatalogue(repos) {
    this.catalogue = Array.isArray(repos) ? repos : []
    this.paintSlash()
  }

  /**
   * Suggestions for a `/` command typed into the message box, above it. `/` alone (or the
   * start of the word) offers `/addRepo`; `/addRepo ` offers the catalogue's repos, narrowed by
   * what is typed after it. A command is the page's to carry out — `send` catches it — and is
   * never sent to the session as a message.
   */
  paintSlash() {
    const el = this.$('.slash')
    const value = this.$('.composer textarea').value
    const items = []
    const cmd = /^\/(addrepo|rescanrepo)(?:\s+(\S*))?$/i.exec(value)
    if (cmd && /\s/.test(value)) {
      const rescan = cmd[1].toLowerCase() === 'rescanrepo'
      const typed = (cmd[2] || '').toLowerCase()
      for (const r of this.catalogue || []) {
        if (typed && !r.id.includes(typed) && !r.name.toLowerCase().includes(typed)) continue
        items.push({ fill: `/${rescan ? 'rescanRepo' : 'addRepo'} ${r.id}`, label: r.name, hint: r.url })
      }
      if (!items.length && typed && !rescan) items.push({ fill: value, label: 'Not in Settings › Repos', hint: 'a git URL is added to this chat for reading only' })
    } else if (/^\/[a-z]*$/i.test(value)) {
      if ('/addrepo'.startsWith(value.toLowerCase())) items.push({ fill: '/addRepo ', label: '/addRepo', hint: 'add a repo to this chat — a name from Settings › Repos, or a git URL' })
      if ('/rescanrepo'.startsWith(value.toLowerCase())) items.push({ fill: '/rescanRepo ', label: '/rescanRepo', hint: 'read a repo in Settings › Repos again, and see what it would change in its settings' })
      if ('/registerrepo'.startsWith(value.toLowerCase())) items.push({ fill: '/registerRepo ', label: '/registerRepo', hint: 'add a repo to Settings › Repos from its git URL, its settings read off it, and to this chat' })
      if ('/away'.startsWith(value.toLowerCase())) {
        items.push({ fill: '/away', label: '/away', hint: 'you are going: this chat writes its handoff now, or when its turn ends' })
        items.push({ fill: '/away all', label: '/away all', hint: 'the same for every chat with a running session' })
      }
      if ('/handoff'.startsWith(value.toLowerCase())) items.push({ fill: '/handoff', label: '/handoff', hint: 'this chat commits its work and writes its handoff now, whatever its size' })
      // Only a workspace chat has the routine tools (routines-tools.md, *Made from a chat*).
      if (this.thread?.workspace?.id && '/createroutine'.startsWith(value.toLowerCase())) items.push({ fill: '/createRoutine ', label: '/createRoutine', hint: 'this chat drafts a routine from the conversation and asks you to approve it — add how you want it, e.g. every night at 11' })
      // The skill is copied into the chat's workspace, so only a workspace chat can take it (api.md).
      if (this.thread?.workspace?.id && '/securityaudit'.startsWith(value.toLowerCase())) items.push({ fill: '/securityAudit ', label: '/securityAudit', hint: "a full security audit of this chat's repo, by Cloudflare's skill, reading the code without running it — add a scope or quick/deep if you want" })
    }
    this.slashFirst = items[0] && items[0].fill !== value ? items[0].fill : ''
    el.hidden = !items.length
    el.innerHTML = items
      .map((i) => `<button type="button" class="slash-item" data-fill="${escape(i.fill)}"><b>${escape(i.label)}</b><span>${escape(i.hint || '')}</span></button>`)
      .join('')
  }

  takeSlash(fill) {
    const box = this.$('.composer textarea')
    box.value = fill
    box.focus()
    this.paintSlash()
  }

  /** `/addRepo <name or URL>`: the page's own command, answered here, not sent to the session. */
  async addRepoCommand(arg, said) {
    const ws = this.thread?.workspace
    if (!ws?.id) return this.onToast('This chat has no workspace to add a repo to', 'err')
    if (!arg) return this.onToast('Which repo? /addRepo <name from Settings › Repos, or a git URL>', 'err')
    this.onToast(`Adding ${arg}…`)
    // `said` is the command as typed: the chat shows it as yours, and the session answers it.
    const res = await addRepoToChat(ws.id, arg, said)
    if (!res.ok) throw new Error(res.error || 'Could not add that repo')
    this.onToast(`${res.repo} added${res.oneOff ? ' — for reading only, it is not in Settings › Repos' : ''}`)
    // The command is in the transcript now, as the person's; draw it without waiting a tick.
    this.poll()
    this.onActed()
  }

  /**
   * `/registerRepo <url>`: the page's, like `/addRepo`. The server reads the repo and answers
   * what a catalogue entry for it would hold, saving nothing; the card shows it, and its
   * Register saves it and adds it to this chat (ui-conversation.md).
   */
  async registerCommand(arg, said) {
    const ws = this.thread?.workspace
    if (!ws?.id) return this.onToast('This chat has no workspace to add a repo to', 'err')
    if (!arg) return this.onToast('Which repo? /registerRepo <git URL>', 'err')
    const threadId = this.thread.id
    this.onToast(`Reading ${arg}…`)
    const scan = await scanRepo(arg)
    if (!scan.ok) throw new Error(scan.error || 'Could not read that repo')
    // A scan is slow on a first clone: a chat left meanwhile does not get another's card.
    if (this.thread?.id !== threadId) return
    this.registering = { kind: 'register', threadId, said, scan }
    this.paintRegister()
  }

  /** The `/registerRepo` card: what Register will save, every field the server's text, escaped. */
  paintRegister() {
    const el = this.$('.register')
    const r = this.registering?.scan
    el.hidden = !r
    if (!r) {
      el.innerHTML = ''
      return
    }
    // A repo on an image of its own gets no packages built in: what that image should carry is said.
    const needs = r.image && r.needs?.length ? `<div class="needs">It runs on its own image, ${escape(r.image)}, which should have ${escape(r.needs.join(', '))}.</div>` : ''
    if (this.registering.kind === 'rescan') return this.paintRescan(el, r, needs)
    const d = r.repo
    const via = { github: 'the GitHub token', machine: "this machine's own access" }[r.via] || r.via
    const line = (k, v) => `<dt>${escape(k)}</dt><dd>${v}</dd>`
    const none = (t) => `<span class="none">${escape(t)}</span>`
    el.innerHTML =
      `<div class="head">Register ${escape(d.name)}?</div>` +
      `<dl class="card">` +
      line('URL', `<span class="mono">${escape(d.url)}</span>`) +
      line('Base branch', `${escape(r.base)} ${none("— the remote's default")}`) +
      line('Reached with', `${escape(via)} ✓`) +
      line('Setup', d.setup.length ? d.setup.map((c) => `<div class="mono">${escape(c)}</div>`).join('') : none('none found — nothing is installed')) +
      line('Ports', d.ports.length ? escape(d.ports.map((p) => `${p.port} (${p.label})`).join(', ')) : none('none found')) +
      line('Environment', d.env.length ? `${escape(d.env.map((e) => e.name).join(', '))} ${none(`— from ${r.envFrom}, values to fill in Settings`)}` : none('none found')) +
      line('Packages', d.packages?.length ? `${escape(d.packages.join(', '))} ${none('— built into its container by Outpost')}` : none('none needed')) +
      (Array.isArray(d.jenkinsJobs) ? line('Jenkins', d.jenkinsJobs.length ? escape(d.jenkinsJobs.join(', ')) : none('no job builds it')) : '') +
      `</dl>` +
      needs +
      `<div class="row"><button class="btn primary" data-reg="add">Register and add</button><button class="btn" data-reg="edit">Edit in Settings</button><button class="btn" data-reg="no">Cancel</button></div>`
  }

  /**
   * `/rescanRepo <name>`: a catalogued repo read again (workspaces.md). The card lists what the
   * scan would change, each ticked; Update saves the ticked ones and nothing else.
   */
  async rescanCommand(arg) {
    if (!arg) return this.onToast('Which repo? /rescanRepo <name from Settings › Repos>', 'err')
    const threadId = this.thread?.id
    this.onToast(`Reading ${arg} again…`)
    const scan = await rescanRepo(arg)
    if (!scan.ok) throw new Error(scan.error || 'Could not read that repo')
    if (this.thread?.id !== threadId) return
    if (!Object.keys(scan.changes).length && !(scan.image && scan.needs.length)) return this.onToast(`Nothing new in ${scan.name} — its settings match what the scan finds`, 'ok')
    this.registering = { kind: 'rescan', threadId, scan }
    this.paintRegister()
  }

  /** The rescan card: each change a tick with what is saved now and what it would be. */
  paintRescan(el, r, needs) {
    const c = r.changes
    const none = (t) => `<span class="none">${escape(t)}</span>`
    const cmds = (list) => (list.length ? list.map((x) => `<div class="mono">${escape(x)}</div>`).join('') : none('none'))
    const ports = (list) => (list.length ? escape(list.map((p) => `${p.port} (${p.label})`).join(', ')) : none('none'))
    const row = (key, label, body) => `<dt><label class="check"><input type="checkbox" data-change="${key}" checked /> ${escape(label)}</label></dt><dd>${body}</dd>`
    const rows =
      (c.setup ? row('setup', 'Setup', `${cmds(c.setup.from)}<div class="none">becomes</div>${cmds(c.setup.to)}`) : '') +
      (c.ports ? row('ports', 'Ports', `${ports(c.ports.from)} ${none('→')} ${ports(c.ports.to)}`) : '') +
      (c.packagesAdd ? row('packagesAdd', 'Packages', `${none('add')} ${escape(c.packagesAdd.join(', '))} ${none('— built into its container by Outpost')}`) : '') +
      (c.envAdd ? row('envAdd', 'Environment', `${none('add')} ${escape(c.envAdd.join(', '))} ${none(`— from ${r.envFrom}, values to fill in Settings`)}`) : '') +
      (c.jobsAdd ? row('jobsAdd', 'Jenkins', `${none('add')} ${escape(c.jobsAdd.join(', '))}`) : '')
    el.innerHTML =
      `<div class="head">Rescan ${escape(r.name)} <span class="none">· on ${escape(r.base)}</span></div>` +
      (rows ? `<dl class="card">${rows}</dl>` : `<div class="none">The settings match what the scan finds.</div>`) +
      needs +
      `<div class="row">${rows ? '<button class="btn primary" data-reg="update">Update</button>' : ''}<button class="btn" data-reg="no">${rows ? 'Cancel' : 'Close'}</button></div>`
  }

  /** The rescan card's Update: the ticked changes, saved onto the entry as it is now. */
  async applyRescanCard() {
    const reg = this.registering
    if (reg?.kind !== 'rescan' || this.thread?.id !== reg.threadId) return
    const ticked = new Set([...this.el.querySelectorAll('.register input[data-change]:checked')].map((b) => b.dataset.change))
    if (!ticked.size) return this.clearRegister()
    const c = reg.scan.changes
    const body = {
      id: reg.scan.id,
      ...(ticked.has('setup') ? { setup: c.setup.to } : {}),
      ...(ticked.has('ports') ? { ports: c.ports.to } : {}),
      ...(ticked.has('packagesAdd') ? { packagesAdd: c.packagesAdd } : {}),
      ...(ticked.has('envAdd') ? { envAdd: c.envAdd } : {}),
      ...(ticked.has('jobsAdd') ? { jobsAdd: c.jobsAdd } : {}),
    }
    for (const b of this.el.querySelectorAll('.register button')) b.disabled = true
    try {
      const res = await applyRescan(body)
      if (!res.ok) throw new Error(res.error || 'Could not update it')
      if (res.repos) this.onCatalogue(res.repos)
      this.clearRegister()
      this.onToast(`${res.repo} updated — chats started from now get it`, 'ok')
    } catch (err) {
      for (const b of this.el.querySelectorAll('.register button')) b.disabled = false
      this.onToast(err.message || 'Could not update it', 'err')
    }
  }

  clearRegister() {
    this.registering = null
    this.paintRegister()
  }

  /** The card's Register: saved to the catalogue, then added to this chat as `/addRepo` adds one. */
  async register() {
    const reg = this.registering
    const ws = this.thread?.workspace
    if (!reg || !ws?.id || this.thread.id !== reg.threadId) return
    for (const b of this.el.querySelectorAll('.register button')) b.disabled = true
    try {
      const res = await registerRepoToChat(ws.id, reg.scan.repo, reg.said)
      if (!res.ok) throw new Error(res.error || 'Could not register it')
      if (res.repos) this.onCatalogue(res.repos)
      this.clearRegister()
      this.onToast(`${res.repo} registered and added`, 'ok')
      this.poll()
      this.onActed()
    } catch (err) {
      for (const b of this.el.querySelectorAll('.register button')) b.disabled = false
      this.onToast(err.message || 'Could not register it', 'err')
    }
  }

  async send() {
    const box = this.$('.composer textarea')
    let text = box.value.trim()
    if ((!text && !this.files.length) || !this.thread) return
    // `/away` and `/away all` are the page's too (handoff.md): never sent to the session.
    const awayCmd = /^\/away(\s+all)?\s*$/i.exec(text)
    if (awayCmd) {
      try {
        const res = await goAway(awayCmd[1] ? null : this.thread)
        if (!res.ok) throw new Error(res.error || 'Could not mark it away')
        // `/away all` lists the chats it touched, each opening its chat (`awayLinks`).
        const links = awayCmd[1] ? awayLinks(res.results).map((l) => ({ label: l.label, run: () => this.onOpen(l.id) })) : []
        this.onToast(awaySummary(res.results, Boolean(awayCmd[1])), 'ok', { links })
        box.value = ''
        this.autosize()
        this.paintSlash()
        this.onActed()
      } catch (err) {
        this.onToast(err.message || 'Could not mark it away', 'err')
      }
      return
    }
    // `/handoff` is the Hand off button for a chat too small to be shown it: the page's, never
    // sent to the session, which would answer it as a question.
    if (/^\/handoff\s*$/i.test(text)) {
      box.value = ''
      this.autosize()
      this.paintSlash()
      await this.handOff()
      return
    }
    const rescan = /^\/rescanrepo(?:\s+(.*))?$/is.exec(text)
    if (rescan) {
      try {
        await this.rescanCommand((rescan[1] || '').trim())
        box.value = ''
        this.autosize()
        this.paintSlash()
      } catch (err) {
        this.onToast(err.message || 'Could not read that repo', 'err')
      }
      return
    }
    const register = /^\/registerrepo(?:\s+(.*))?$/is.exec(text)
    if (register) {
      try {
        await this.registerCommand((register[1] || '').trim(), text)
        box.value = ''
        this.autosize()
        this.paintSlash()
      } catch (err) {
        this.onToast(err.message || 'Could not read that repo', 'err')
      }
      return
    }
    const command = /^\/addrepo(?:\s+(.*))?$/is.exec(text)
    if (command) {
      try {
        await this.addRepoCommand((command[1] || '').trim(), text)
        box.value = ''
        this.autosize()
        this.paintSlash()
      } catch (err) {
        this.onToast(err.message || 'Could not add that repo', 'err')
      }
      return
    }
    if (/^\/createroutine\b/i.test(text) && !this.thread.workspace?.id) return this.onToast('Only a workspace chat can make a routine: start one from New chat', 'err')
    if (/^\/securityaudit\b/i.test(text) && !this.thread.workspace?.id) return this.onToast('Only a workspace chat can run a security audit: start one from New chat', 'err')
    const button = this.$('.composer button[type=submit]')
    button.disabled = true
    try {
      // Files go up first; the send names them by the paths handed back (api.md).
      const paths = []
      for (const f of this.files) paths.push(await uploadFile(this.thread, f))
      // `/createRoutine` and `/securityAudit` go to the session as typed, with Outpost's
      // request beside them (api.md): sent with this one message, never standing text (handoff.md's
      // rule). The words after `/createRoutine` or `/securityAudit` are the person's, how they want it.
      const command = /^\/createroutine\b/i.test(text) ? 'createRoutine' : /^\/securityaudit\b/i.test(text) ? 'securityAudit' : ''
      // The server starts an ended session before it delivers, which takes a few seconds.
      if (!this.thread.canSend) this.onToast('Resuming the session, then sending…')
      const said = text || (paths.length ? `Look at the attached ${this.files.every((f) => f.type.startsWith('image/')) ? 'image' : 'file'}${paths.length > 1 ? 's' : ''}.` : '')
      // Drawn at once, with a spinner, until the transcript has it (`settleQueued`). Queued
      // before the send, not after: a read out meanwhile can bring the message back, and an
      // entry made after that would wait for a copy already drawn.
      const queue = this.queued.get(this.thread.id) || []
      const entry = { text: said, at: Date.now() }
      queue.push(entry)
      this.queued.set(this.thread.id, queue)
      try {
        await sendPrompt(this.thread, said, paths, command)
      } catch (err) {
        queue.splice(queue.indexOf(entry), 1)
        this.paintQueued()
        throw err
      }
      this.paintQueued()
      box.value = ''
      this.autosize() // an empty box is a two-line box again, whatever it grew to
      this.files = []
      this.paintPending()
      // The tail will draw it within a poll; nudge one now so it does not feel lost.
      this.poll()
      this.onActed()
    } catch (err) {
      this.onToast(err.message || 'Could not send that', 'err')
    } finally {
      button.disabled = false
      box.focus()
    }
  }

  /** Pick a numbered row off a question the session asked. */
  async pick(option, expect) {
    if (!this.thread) return
    for (const b of this.el.querySelectorAll('.ask button')) b.disabled = true
    try {
      const res = await pickOption(this.thread, option, expect, this.askId)
      this.onToast(res.chose || 'Answered')
      // A set of questions moves straight to the next one; the next poll draws it.
      this.$('.ask').hidden = true
      this.askId = ''
      this.onActed()
    } catch (err) {
      this.onToast(err.message || 'Could not answer that', 'err')
    } finally {
      for (const b of this.el.querySelectorAll('.ask button')) b.disabled = false
    }
  }

  async answer(what) {
    if (!this.thread) return
    for (const b of this.el.querySelectorAll('.ask button')) b.disabled = true
    try {
      const res = await respondPrompt(this.thread, what, this.askId)
      this.onToast(res.chose ? `${res.chose}` : 'Answered')
      this.$('.ask').hidden = true
      this.askId = ''
      this.onActed()
      // Another request was standing behind this one: draw it now, not a poll from now.
      if (res.more) this.describeAsk()
    } catch (err) {
      this.onToast(err.message || 'Could not answer', 'err')
    } finally {
      for (const b of this.el.querySelectorAll('.ask button')) b.disabled = false
    }
  }

  // ── the model ───────────────────────────────────────────────────────────────────────

  /**
   * The model list, drawn under the action row.
   *
   * The tick is worked out from the thread's own `model` rather than taken from the list,
   * because the list is the same for every chat and says nothing about this one.
   * `currentModelIndex` returns nothing rather than guess when it cannot tell.
   */
  paintModels() {
    const el = this.$('.models')
    el.hidden = !this.modelsOpen
    if (!this.modelsOpen) return
    if (this.modelsError) {
      el.innerHTML = `<div class="why">${escape(this.modelsError)}</div>`
      return
    }
    if (!this.models.length) {
      el.innerHTML = `<div class="why">Reading the model list…</div>`
      return
    }
    const on = currentModelIndex(this.models, this.thread?.model)
    const rows = this.models
      .map(
        (m, i) =>
          `<button class="m${i === on ? ' on' : ''}" data-model="${escape(m.label)}"${this.modelBusy ? ' disabled' : ''}>` +
          `<span class="l">${escape(m.label)}</span><span class="d">${escape(m.description)}</span></button>`
      )
      .join('')
    // Effort is a scale of single words, so it is chips on one row rather than rows of its
    // own — and unlike the model it needs no matching heuristic: the levels and the
    // transcript's `effort` are the same words.
    const effort = this.thread?.effort || ''
    //
    // The row draws its own failure rather than going blank: a read that was refused says
    // why, where a row that simply vanished read as a broken feature.
    const chips = this.efforts.length
      ? `<div class="efforts">` +
        this.efforts
          .map(
            (level) =>
              `<button class="e${level.toLowerCase() === effort.toLowerCase() ? ' on' : ''}" data-effort="${escape(level)}"` +
              `${this.modelBusy ? ' disabled' : ''}>${escape(level)}</button>`
          )
          .join('') +
        `</div>`
      : `<div class="efforts"><span class="waiting">${escape(this.effortsError || 'Reading the effort levels…')}</span></div>`
    el.innerHTML =
      rows + chips + `<div class="why">This session only — your defaults for new sessions are left alone.</div>`
  }

  async toggleModels() {
    this.modelsOpen = !this.modelsOpen
    this.paintControls()
    // The model list describes the machine and is fetched once. The effort levels describe
    // the *session's current model* — Opus offers `ultracode`, Haiku does not — so they are
    // re-read whenever the model behind them has moved.
    if (!this.modelsOpen) return
    this.loadMenu()
  }

  /**
   * Fill the menu. The two lists are fetched independently and neither can cost the other.
   *
   * Sequentially, and independently: the model list is the CLI's aliases and needs no
   * session, while the effort levels are per thread and are refused for one Outpost did not
   * start. Behind one `Promise.all` a refused effort read emptied the whole menu, model list
   * included — which is what "the effort selector is not working" looked like.
   */
  async loadMenu() {
    const stale = this.effortsFor !== (this.thread?.model || '')
    const wantModels = !this.models.length
    const wantEfforts = stale || !this.efforts.length
    if (this.modelBusy || (!wantModels && !wantEfforts)) return
    const thread = this.thread
    this.modelBusy = true
    if (wantEfforts) this.effortsError = ''
    this.paintModels()

    // The selection can move while either of these is in flight; an answer for a thread that
    // is no longer showing belongs to nobody. By id: a roster landing mid-request replaces the
    // object without moving the selection (`poll`).
    const mine = () => this.thread?.id === thread?.id

    if (wantModels) {
      try {
        const res = await fetchModels(thread)
        if (!mine()) return this.done()
        this.models = res.models || []
        this.modelsError = this.models.length ? '' : 'That session listed no models'
      } catch (err) {
        if (!mine()) return this.done()
        this.modelsError = err.message || 'Could not read the model list'
      }
    }
    if (wantEfforts) {
      try {
        const res = await fetchEfforts(thread)
        if (!mine()) return this.done()
        this.efforts = res.levels || []
        this.effortsFor = thread.model || ''
        this.effortsError = this.efforts.length ? '' : 'That session listed no effort levels'
      } catch (err) {
        if (!mine()) return this.done()
        this.efforts = []
        this.effortsError = err.message || 'Could not read the effort levels'
      }
    }
    this.done()
  }

  /** Release the menu and repaint whatever came back. */
  done() {
    this.modelBusy = false
    this.paintModels()
  }

  /**
   * Move the session onto `label`. The thread's own model is left exactly as it was: it comes
   * from the transcript, and the transcript will not carry the new one until the session next
   * answers. Saying otherwise here would put a model on the card that nothing has run on.
   */
  /**
   * Move the session to `level`. Like the model, the thread's own `effort` is left as it was —
   * it is read from the transcript, which learns the new level when the session next answers.
   */
  async chooseEffort(level) {
    if (!this.thread || this.modelBusy) return
    this.modelBusy = true
    this.paintModels()
    try {
      const res = await setThreadEffort(this.thread, level)
      this.onToast(`At ${res.effort || level} effort for this session — it will show once it answers`)
      this.modelsOpen = false
    } catch (err) {
      this.onToast(err.message || 'Could not change the effort', 'err')
    } finally {
      this.modelBusy = false
      this.paintControls()
      this.onActed()
    }
  }

  async chooseModel(label) {
    if (!this.thread || this.modelBusy) return
    this.modelBusy = true
    this.paintModels()
    try {
      const res = await setThreadModel(this.thread, label)
      this.onToast(`On ${res.model || label} for this session from its next answer`)
      // The new model has its own effort scale, and the thread will not report the new model
      // until it answers — so drop the list rather than let a stale one look current.
      this.effortsFor = null
      this.efforts = []
      this.effortsError = ''
      this.modelsOpen = false
    } catch (err) {
      this.onToast(err.message || 'Could not change the model', 'err')
    } finally {
      this.modelBusy = false
      this.paintControls()
      this.onActed()
    }
  }

  /**
   * What Stop would end beyond the turn: the subagents and background commands the hook store
   * lists (hooks.md). Both lists are the roster's, so a command started in this very turn is
   * not in it until the turn's `Stop`, and is not stopped either.
   */
  haltWhat() {
    const t = this.thread
    const agents = Array.isArray(t?.subagents) ? t.subagents : []
    const commands = t?.structured && !t.canSend ? [] : Array.isArray(t?.backgroundTasks) ? t.backgroundTasks : []
    return { agents, commands }
  }

  /**
   * Stop, by the button or Esc in the box. On the button the turn alone goes on one press:
   * nothing else would be lost. With an agent or a background command out, the popover says
   * what goes with it. Esc always asks (`key`): it is the key people press to leave a field,
   * and one stray press ended a turn with no word (the owner, 2026-10-15).
   */
  askInterrupt({ key = false } = {}) {
    const { agents, commands } = this.haltWhat()
    const alone = !agents.length && !commands.length
    if (alone && !key) return this.interrupt(false)
    const pop = this.$('.strip .halt-pop')
    if (!pop.hidden) return this.closeHalt()
    pop.querySelector('[data-halt=all]').textContent = alone ? 'Stop' : 'Stop everything'
    const parts = []
    if (agents.length === 1) parts.push(`${agents[0].type ? `the ${agents[0].type} subagent` : 'its subagent'} mid-task`)
    else if (agents.length) parts.push(`${agents.length} subagents mid-task`)
    if (commands.length) parts.push(`${commands.length} background command${commands.length === 1 ? '' : 's'}`)
    if (!agents.length) parts.unshift('the turn')
    pop.querySelector('.why').textContent = `This stops ${parts.join(' and ')}. Partial work stays on disk.`
    pop.hidden = false
    this.haltFrom = document.activeElement
    pop.querySelector('[data-halt=all]').focus()
    // A press anywhere else is Cancel, as for any popover.
    this.haltAway = (e) => {
      if (!e.target.closest('.strip .halt-pop, .strip .halt')) this.closeHalt()
    }
    document.addEventListener('pointerdown', this.haltAway, true)
  }

  closeHalt() {
    const pop = this.$('.strip .halt-pop')
    if (pop.hidden) return
    pop.hidden = true
    document.removeEventListener('pointerdown', this.haltAway, true)
    this.haltAway = null
    // Back to where Esc was pressed, so the next one types into the box again.
    if (this.haltFrom?.isConnected && pop.contains(document.activeElement)) this.haltFrom.focus()
    this.haltFrom = null
  }

  /** `all` stops the agents and background commands too (`/api/interrupt`, launchers.md). */
  async interrupt(all = false) {
    if (!this.thread) return
    try {
      const r = await interruptThread(this.thread, { all })
      const n = (r.agents || 0) + (r.commands || 0)
      this.onToast(n ? `Interrupted · stopped ${[r.agents && `${r.agents} agent${r.agents === 1 ? '' : 's'}`, r.commands && `${r.commands} command${r.commands === 1 ? '' : 's'}`].filter(Boolean).join(' and ')}` : 'Interrupted')
      this.onActed()
    } catch (err) {
      this.onToast(err.message || 'Could not interrupt', 'err')
    }
  }

  /**
   * Send a stalled session on again. The refusals are worth showing rather than swallowing:
   * "it is working again" means the wait is already over and is good news, not an error.
   */
  async restart() {
    if (!this.thread) return
    try {
      const res = await restartThread(this.thread)
      if (!res.ok) return this.onToast(res.error || 'Could not restart it', 'err')
      this.onToast('Sent it on again')
      this.onActed()
    } catch (err) {
      this.onToast(err.message || 'Could not restart it', 'err')
    }
  }

  async resume() {
    const t = this.thread
    if (!t) return
    try {
      const res = await resumeThread(t)
      if (!res.ok) return this.onToast(res.error || 'Could not resume that session', 'err')
      this.onToast('Resumed — carrying on where it left off')
      this.onActed()
    } catch (err) {
      this.onToast(err.message || 'Could not resume that session', 'err')
    }
  }
}
