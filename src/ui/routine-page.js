/**
 * A routine's page in the main pane (routines.md *Its page*): its header — trigger and next
 * run, repos, model, what a run may do — with Run now, Pause and Change…; the flow, drawn from
 * its steps; and its runs, newest first. Choosing a run draws its path on the flow and fills
 * the details column with that run's summary and execution log (`RunPanel`, ui-details.md).
 *
 * The roster carries only a routine's list fields, so the page reads the whole routine and its
 * runs itself (`/api/routines`, `/runs`), again whenever the roster says the routine moved.
 */
import { deleteRoutine, fetchRoutineRunLog, fetchRoutineRuns, fetchRoutines, makeCallToken, runRoutineNow, saveRoutine, saveRoutineLayout } from '../api.js'
import { FlowView, TONE, etaWords, failedAt, failedWords, took, typicalTimes } from './flow.js'
import { modelLabel } from './models.js'
import { OUTCOME_WORDS, nextWords } from './routines.js'
import { ICON } from './shell.js'
import { copyText } from './settings/integrations.js'
import { when } from './when.js'

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** What a run may do without asking, in the page's words (ui.md, 2026-10-03). */
const MAY_DO = {
  dontAsk: 'never asks; refuses instead',
  acceptEdits: 'edits its own files; refuses the rest',
  plan: 'plans only',
}

/** The chat list's status classes, so a run's dot is the same colour as a routine's. */
const RUN_DOT = { running: 'working', done: 'done', 'needs-you': 'waiting', failed: 'blocked' }

/** While a run is going, its log is read again this often while it shows. */
const LIVE_LOG_MS = 5000

/**
 * While a run is going, its runs are read again this often: the roster's line moves only when a
 * run starts or ends, so without it the step a run is in, and its estimate, stood still.
 */
const LIVE_RUNS_MS = 10000

/**
 * After a box is dropped, how long the page waits for another before it saves where they all
 * are: arranging a flow is several drags, and one save for them is enough.
 */
const LAYOUT_SAVE_MS = 600

/**
 * A layout as one comparable string, '' for none: the server writes back what it was sent, but
 * the order of its keys is not a thing to depend on.
 */
export function layoutKey(layout) {
  const ids = layout && typeof layout === 'object' ? Object.keys(layout).sort() : []
  return ids.length ? JSON.stringify(ids.map((id) => [id, layout[id]?.x, layout[id]?.y])) : ''
}

/** A run's tokens, when it says: a count, or `{ total }`. */
function tokenWords(t) {
  const n = typeof t === 'number' ? t : t && typeof t === 'object' ? Number(t.total) || 0 : 0
  return n > 0 ? `${n >= 1000 ? `${Math.round(n / 1000)}k` : n} tokens` : ''
}

/** How a run went, in one line: its ending, how long it took, what it spent, how it started. */
export function runLine(run) {
  return [
    OUTCOME_WORDS[run.outcome] || run.outcome,
    run.endedAt && run.at ? took(run.endedAt - run.at) : '',
    tokenWords(run.tokens),
    run.by && run.by !== 'trigger' ? 'by hand' : '',
    run.call ? `called "${run.call}"` : '',
    run.skipGate ? 'check skipped' : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

/** The fields the server derives, which a PUT does not carry back. */
function stored(routine) {
  const { lastRun, next, when: words, running, calls, finished, layout, ...rest } = routine
  return rest
}

/**
 * The `curl` that calls a trigger, for the token's one showing: what a person pastes into a
 * script or a webhook's settings. Single quotes, since the token is base64url and the URL has
 * none, so the line pastes into any POSIX shell unchanged.
 */
export function callCurl(url, token) {
  return `curl -X POST ${url} -H 'Authorization: Bearer ${token}' -H 'Content-Type: application/json' -d '{}'`
}

/**
 * A call trigger's token state in words — the same shape as Jenkins's notify token in
 * Settings: its last characters once made, and what not having one means.
 */
export function callState(call) {
  return call.configured ? `Token made — ending ${call.hint}` : 'No token yet — every call is refused'
}

/**
 * Delete's confirm in words: the routine by name, and that its runs' log stays on this machine
 * (routines.md: the runs are the machine's history and are not removed with the definition).
 * A routine a defining chat made (`definedBy`) takes that chat with it.
 */
export function deleteWords(routine) {
  const name = routine?.name || 'Untitled routine'
  return {
    head: `Delete “${name}”?`,
    why: [
      'It stops running and leaves Routines. Its run log is kept on this machine.',
      routine?.definedBy ? 'The chat that defined it is deleted too.' : '',
    ]
      .filter(Boolean)
      .join(' '),
  }
}

/**
 * What the toast says once a routine is deleted, and its kind: a defining chat the delete refused
 * is kept as a draft (routines.md *Defining chats*), and the person is told where it went.
 */
export function deletedWords(name, chats = []) {
  const kept = (chats || []).filter((c) => c && c.deleted === false)
  const who = name || 'The routine'
  if (!kept.length) return [`${who} deleted`, '']
  return [`${who} deleted — its defining chat could not be, and is kept under Drafts${kept[0].error ? `: ${kept[0].error}` : ''}`, 'err']
}

export class RoutinePage {
  /**
   * `onBack()` returns to the list; `onRight()` toggles the details column; `onRunChosen(routine,
   * run, byPerson)` says which run is showing, for the details column; `onChange(routine)` asks a
   * chat for a change; `onGone()` is the routine deleted; `repoName(id)` names a repo.
   */
  constructor(main, { onBack, onRight, onRunChosen, onChange, onGone, onToast, repoName }) {
    this.onBack = onBack
    this.onRight = onRight
    this.onRunChosen = onRunChosen
    this.onChange = onChange
    this.onGone = onGone
    this.onToast = onToast
    this.repoName = repoName
    this.id = ''
    this.routine = null
    this.runs = []
    this.runId = ''
    this.summaryKey = ''
    this.el = document.createElement('section')
    this.el.className = 'routine-view'
    this.el.hidden = true
    this.el.innerHTML = `
      <header class="rv-head">
        <button class="btn icon back" data-act="back" aria-label="Back">${ICON.back}</button>
        <div class="text"><h1 class="title"></h1><div class="meta"></div></div>
        <div class="rv-actions">
          <span class="run-now"><button class="btn primary" data-act="run" title="Start a run now; it is logged as by hand">Run now</button><label class="skip" title="Run the steps even if the check finds nothing new — for testing on a quiet day"><input type="checkbox" /> skip the check</label></span>
          <button class="btn" data-act="pause"></button>
          <button class="btn" data-act="change" title="Opens the chat that defines this routine — or starts one — to say what to change; it asks you to approve the change">Change…</button>
          <span class="rv-more"><button class="btn icon" data-act="more" title="More" aria-label="More" aria-haspopup="menu" aria-expanded="false">⋯</button><span class="menu" role="menu" hidden><button type="button" role="menuitem" data-act="reset-layout" title="Put every box back where Outpost lays it out" hidden>Reset layout</button><button type="button" class="danger" role="menuitem" data-act="delete">Delete…</button></span></span>
          <button class="btn icon" data-act="right" title="Details" aria-label="Details">${ICON.panel}</button>
        </div>
        <div class="rv-calls" hidden>
          <div class="list"></div>
          <div class="call-once" hidden>
            <p class="why"><b>Copy it now — Outpost will not show it again.</b> If it is lost, make a new one.</p>
            <div class="row"><code class="mono call-value"></code><button class="btn sm" type="button" data-call="copy" data-what="token">Copy</button></div>
            <div class="sub">Call it with</div>
            <div class="row"><code class="mono call-curl"></code><button class="btn sm" type="button" data-call="copy" data-what="curl">Copy</button></div>
            <p class="why">The body, JSON up to 16 KB, reaches the run as data to read, never as instructions. A call while a run is still going is skipped, not queued.</p>
            <button class="btn sm" type="button" data-call="done">Done — I have copied it</button>
          </div>
        </div>
      </header>
      <div class="rv-body">
        <div class="rv-flow"></div>
        <div class="rv-runs"><div class="h">Runs</div><div class="strip"></div></div>
      </div>`
    main.appendChild(this.el)
    this.$ = (sel) => this.el.querySelector(sel)
    // Boxes are dragged here and where they are left is saved on its own (routines.md
    // *Layouts*): no Save button, and a failed save is a toast.
    this.flow = new FlowView(this.$('.rv-flow'), { edit: true, onDrop: (layout, moved) => this.dropped(layout, moved) })
    // The layout on screen (`layoutKey`), a save waiting on its debounce or in flight, and a
    // redraw held while a box was in hand.
    this.drawnKey = ''
    this.saveTimer = 0
    this.sending = 0
    this.heldDraw = false
    // Delete's confirm, a dialog over the page in the New chat dialog's shape: a routine and
    // its place in Routines go together, and a stray tap in a menu should not do it.
    this.confirmEl = document.createElement('div')
    this.confirmEl.className = 'modal rv-confirm'
    this.confirmEl.hidden = true
    this.confirmEl.innerHTML = `
      <div class="sheet" role="alertdialog" aria-modal="true" aria-labelledby="rv-confirm-title" aria-describedby="rv-confirm-why">
        <header><h2 id="rv-confirm-title"></h2></header>
        <div class="body"><p class="why" id="rv-confirm-why"></p></div>
        <footer class="row"><button class="btn" type="button" data-confirm="no">Cancel</button><button class="btn danger" type="button" data-confirm="yes">Delete</button></footer>
      </div>`
    document.body.appendChild(this.confirmEl)
    this._wire()
  }

  _wire() {
    this.confirmEl.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-confirm]')
      if (b?.dataset.confirm === 'yes') this.remove(b)
      else if (b || e.target === this.confirmEl) this.closeConfirm()
    })
    // While the dialog is up its keys are its own: Esc cancels, and the page's shortcuts (Esc
    // leaving the routine, C opening New chat) on window do not fire under it.
    document.addEventListener('keydown', (e) => {
      if (this.confirmEl.hidden) return
      e.stopPropagation()
      if (e.key === 'Escape') this.closeConfirm()
    })
    // A press anywhere but the menu closes it.
    document.addEventListener('click', (e) => {
      if (!this.$('.rv-more .menu').hidden && !e.target.closest?.('.rv-more')) this.closeMenu()
    })
    this.$('.rv-calls').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-call]')
      if (b) this.callAct(b)
    })
    this.$('.rv-head').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]')
      if (!b) return
      const act = b.dataset.act
      if (act === 'back') this.onBack()
      else if (act === 'right') this.onRight()
      else if (act === 'run') this.runNow(b)
      else if (act === 'pause') this.togglePause(b)
      else if (act === 'change' && this.routine) this.onChange(this.routine)
      else if (act === 'more') this.toggleMenu()
      else if (act === 'delete') this.askDelete()
      else if (act === 'reset-layout') this.resetLayout()
    })
    this.$('.strip').addEventListener('click', (e) => {
      const b = e.target.closest('[data-run]')
      if (b) this.choose(b.dataset.run, true)
    })
  }

  /** Open routine `id`, on run `runId` when one is named (a run waiting on you), else its newest. */
  show(id, runId = '') {
    if (id !== this.id) {
      this.flushLayout()
      this.drawnKey = ''
      this.heldDraw = false
      this.routine = null
      this.runs = []
      this.runId = ''
      this.shape = ''
      this.summaryKey = ''
      this.$('.title').textContent = ''
      this.$('.meta').textContent = 'Loading…'
      this.$('.strip').innerHTML = ''
      this.putAway()
      this.callArmed = ''
      this.$('.rv-calls').hidden = true
    }
    this.id = id
    this.wantRun = runId
    this.closeMenu()
    this.closeConfirm()
    this.el.hidden = false
    this.load()
  }

  hide() {
    this.flushLayout()
    this.el.hidden = true
    this.id = ''
    this.summaryKey = ''
    clearTimeout(this.runsTimer)
    this.closeMenu()
    this.closeConfirm()
    // A token left on screen would be there for the next person to open the page.
    this.putAway()
  }

  /**
   * The roster's line for this routine. Its last run, running flag or pause moving is the cue
   * to read the routine and its runs again; anything else in the roster is not this page's.
   */
  setSummary(sum) {
    if (!this.id || !sum || sum.id !== this.id) return
    const key = JSON.stringify([sum.lastRun, sum.running, sum.enabled, sum.name, sum.when])
    if (!this.summaryKey) {
      this.summaryKey = key
      return
    }
    if (key === this.summaryKey) return
    this.summaryKey = key
    this.load()
  }

  async load() {
    const id = this.id
    const seq = (this.seq = (this.seq || 0) + 1)
    let list
    let runs
    try {
      ;[list, runs] = await Promise.all([fetchRoutines(), fetchRoutineRuns(id).catch(() => ({ runs: [] }))])
    } catch (err) {
      if (seq === this.seq) this.$('.meta').textContent = err.message || 'Could not read this routine'
      return
    }
    if (seq !== this.seq || id !== this.id) return
    const routine = (list.routines || []).find((r) => r.id === id)
    if (!routine) {
      this.routine = null
      this.$('.title').textContent = 'Routine not found'
      this.$('.meta').textContent = 'It may have been deleted.'
      this.$('.strip').innerHTML = ''
      return
    }
    this.routine = routine
    this.runs = Array.isArray(runs.runs) ? runs.runs : []
    this.paintHead()
    // Redrawn only when its shape moves, so a new run does not throw away a view panned by hand
    // — and never under a box in hand: the drop redraws it. A layout saved here is already on
    // screen; one changed in another tab is put in place with the view left as it is, unless a
    // save of this page's is still on its way, which wins.
    const shape = JSON.stringify([routine.triggers, routine.gate, routine.steps, routine.when, routine.repos])
    const saving = Boolean(this.saveTimer || this.sending) && this.pendingId === id
    if (shape !== this.shape) {
      if (this.flow.dragging) this.heldDraw = true
      else {
        this.shape = shape
        const layout = saving ? this.pendingLayout : routine.layout || null
        this.flow.draw(routine, this.repoName, layout)
        this.drawnKey = layoutKey(layout)
      }
    } else if (!saving && !this.flow.dragging && layoutKey(routine.layout) !== this.drawnKey && this.flow.place(routine.layout || null)) {
      this.drawnKey = layoutKey(routine.layout)
    }
    this.paintMenu()
    const want = this.wantRun && this.runs.some((r) => r.runId === this.wantRun) ? this.wantRun : ''
    if (want) this.wantRun = ''
    const keep = this.runs.some((r) => r.runId === this.runId) ? this.runId : ''
    // A run named on opening — the one waiting on you — is shown as if tapped: its question is
    // in the details column, which a phone keeps closed until asked.
    this.choose(want || keep || this.runs[0]?.runId || '', Boolean(want))
    this.watchRuns()
  }

  /** Read the runs again in `LIVE_RUNS_MS` while one is going; stops once none is. */
  watchRuns() {
    clearTimeout(this.runsTimer)
    this.runsTimer = 0
    if (!this.id || !this.runs.some((r) => r.outcome === 'running')) return
    this.runsTimer = setTimeout(() => this.readRuns(), LIVE_RUNS_MS)
  }

  async readRuns() {
    const id = this.id
    const seq = this.seq
    const runs = await fetchRoutineRuns(id).catch(() => null)
    // A load since has the newer read, and the page may have moved on.
    if (seq !== this.seq || id !== this.id) return
    if (runs && Array.isArray(runs.runs)) {
      this.runs = runs.runs
      this.choose(this.runs.some((r) => r.runId === this.runId) ? this.runId : this.runs[0]?.runId || '', false)
    }
    this.watchRuns()
  }

  paintHead() {
    const r = this.routine
    const paused = r.enabled === false
    this.$('.title').innerHTML = `${escape(r.name || 'Untitled routine')}${paused ? ' <span class="tag">paused</span>' : ''}`
    const repos = (r.repos || []).map((x) => this.repoName(x.id)).filter(Boolean)
    this.$('.meta').textContent = [
      r.when,
      paused ? 'paused' : nextWords(r.next?.[0]) || 'not due again',
      repos.length ? repos.join(', ') : 'no repos',
      r.model ? modelLabel(r.model) : 'default model',
      `${MAY_DO[r.permissionMode || 'dontAsk'] || r.permissionMode}`,
    ]
      .filter(Boolean)
      .join(' · ')
    this.$('.meta').title = r.prompt || ''
    this.$('[data-act=pause]').textContent = paused ? 'Resume' : 'Pause'
    this.$('[data-act=pause]').title = paused ? 'Let its trigger start runs again' : 'Stop its trigger starting runs; Run now still works'
    // Skipping the check means something only where there is one.
    this.$('.skip').hidden = !r.gate
    this.paintCalls()
  }

  /**
   * Each call trigger under the header: its name, the URL it is called at, and whether this
   * machine holds its token (`configured`, `hint` — never the token). The token's one showing
   * sits in `.call-once`, outside the list, so a repaint on the next roster does not take it.
   */
  paintCalls() {
    const calls = Array.isArray(this.routine?.calls) ? this.routine.calls : []
    const box = this.$('.rv-calls')
    box.hidden = !calls.length
    this.$('.rv-calls .list').innerHTML = calls
      .map((c) => {
        const make = this.callArmed === c.name ? 'Replace it? The old token stops working' : c.configured ? 'Replace token' : 'Make token'
        return (
          `<div class="call"><span class="what">On a call to <b>${escape(c.name)}</b></span>` +
          `<code class="mono url">POST ${escape(location.origin + c.path)}</code>` +
          `<span class="state" data-state="${c.configured ? 'on' : 'off'}">${escape(callState(c))}</span>` +
          `<button class="btn sm" type="button" data-call="make" data-name="${escape(c.name)}">${escape(make)}</button></div>`
        )
      })
      .join('')
  }

  putAway() {
    const once = this.$('.call-once')
    once.hidden = true
    this.$('.call-value').textContent = ''
    this.$('.call-curl').textContent = ''
  }

  async callAct(b) {
    const act = b.dataset.call
    if (act === 'done') return this.putAway()
    if (act === 'copy') {
      const el = this.$(b.dataset.what === 'curl' ? '.call-curl' : '.call-value')
      try {
        await copyText(el)
        b.textContent = 'Copied'
        setTimeout(() => (b.textContent = 'Copy'), 1500)
      } catch {
        this.onToast('Could not reach the clipboard — select it and copy it', 'err')
      }
      return
    }
    if (act !== 'make' || !this.routine) return
    const name = b.dataset.name
    const call = (this.routine.calls || []).find((c) => c.name === name)
    // Replacing is two presses, as Jenkins's notify token is: whatever holds the old one stops working.
    if (call?.configured && this.callArmed !== name) {
      this.callArmed = name
      this.paintCalls()
      setTimeout(() => {
        if (this.callArmed !== name) return
        this.callArmed = ''
        if (this.routine) this.paintCalls()
      }, 6000)
      return
    }
    this.callArmed = ''
    b.disabled = true
    const id = this.id
    try {
      const res = await makeCallToken(id, name)
      if (!res.ok || !res.token) return this.onToast(res.error || 'Could not make a token', 'err')
      if (id !== this.id) return
      const fresh = (res.routines || []).find((r) => r.id === id)
      if (fresh) this.routine = fresh
      const url = location.origin + (res.path || `/api/triggers/${name}`)
      this.$('.call-value').textContent = res.token
      this.$('.call-curl').textContent = callCurl(url, res.token)
      this.$('.call-once').hidden = false
      this.paintCalls()
      this.onToast(`Token made for "${name}" — copy it now; it is not shown again`)
    } catch (err) {
      this.onToast(err.message || 'Could not make a token', 'err')
    } finally {
      b.disabled = false
    }
  }

  paintRuns() {
    const el = this.$('.strip')
    if (!this.runs.length) {
      el.innerHTML = `<div class="nothing">No runs yet. Run now starts one.</div>`
      return
    }
    // A failed run is its own red chip saying where it failed (`failedAt`), so a strip of runs
    // shows which one broke, and at which step, without opening each.
    el.innerHTML = this.runs
      .map((run) => {
        const failed = failedWords(failedAt(run, this.routine))
        return (
          `<button class="run ${RUN_DOT[run.outcome] || ''}${failed ? ' failed' : ''}" data-run="${escape(run.runId)}" aria-pressed="${run.runId === this.runId}">` +
          `<span class="w"><i class="dot"></i>${escape(when(run.at))}</span>` +
          (failed ? `<span class="f">${escape(failed)}</span>` : '') +
          `<span class="x">${escape(runLine(run))}</span></button>`
        )
      })
      .join('')
  }

  /** Show run `runId` on the flow and in the details column; `byPerson` when it was tapped. */
  choose(runId, byPerson) {
    this.runId = runId
    const run = this.runs.find((r) => r.runId === runId) || null
    this.paintRuns()
    const failed = failedWords(failedAt(run, this.routine))
    // A running run's estimates come from the runs kept, so a first run has none.
    const typical = run?.outcome === 'running' ? typicalTimes(this.runs) : null
    const eta = typical ? etaWords(run.at, typical.run) : ''
    const note = run ? [when(run.at), failed || 'the path this run took', eta].filter(Boolean).join(' · ') : ''
    this.flow.show(run, note, typical)
    this.onRunChosen(this.routine, run, byPerson)
  }

  async runNow(b) {
    if (!this.routine) return
    const skip = !this.$('.skip').hidden && this.$('.skip input').checked
    b.disabled = true
    try {
      const res = await runRoutineNow(this.id, skip)
      if (!res.ok) return this.onToast(res.error || 'Could not start it', 'err')
      this.onToast(`${this.routine.name} started${skip ? ', check skipped' : ''}`)
      if (res.run?.runId) this.wantRun = res.run.runId
      this.load()
    } catch (err) {
      this.onToast(err.message || 'Could not start it', 'err')
    } finally {
      b.disabled = false
    }
  }

  async togglePause(b) {
    if (!this.routine) return
    const enabled = this.routine.enabled === false
    b.disabled = true
    try {
      const res = await saveRoutine({ ...stored(this.routine), enabled })
      if (!res.ok) return this.onToast(res.error || 'Could not change it', 'err')
      this.onToast(enabled ? `${this.routine.name} resumed` : `${this.routine.name} paused`)
      this.load()
    } catch (err) {
      this.onToast(err.message || 'Could not change it', 'err')
    } finally {
      b.disabled = false
    }
  }

  /**
   * A box was let go (`FlowView` `onDrop`). Moved, every box placed by hand is saved a moment
   * later, once for a run of drags; a redraw held while it was in hand is done now.
   */
  dropped(layout, moved) {
    if (moved) {
      const id = this.id
      this.pendingId = id
      this.pendingLayout = layout
      this.drawnKey = layoutKey(layout)
      clearTimeout(this.saveTimer)
      this.flushSave = () => {
        this.saveTimer = 0
        this.flushSave = null
        this.sendLayout(id, layout)
      }
      this.saveTimer = setTimeout(this.flushSave, LAYOUT_SAVE_MS)
      this.paintMenu()
    }
    if (this.heldDraw) {
      this.heldDraw = false
      this.load()
    }
  }

  /** A save still waiting on its debounce goes now: leaving the page must not lose the last drag. */
  flushLayout() {
    if (!this.saveTimer) return
    clearTimeout(this.saveTimer)
    this.flushSave?.()
  }

  async sendLayout(id, layout) {
    this.sending++
    try {
      const res = await saveRoutineLayout(id, layout)
      if (!res.ok) throw new Error(res.error || 'refused')
      if (id === this.id && this.routine) this.routine.layout = res.layout
    } catch (err) {
      this.onToast(`Could not save where the boxes are — ${err.message || 'try again'}`, 'err')
    } finally {
      this.sending--
    }
  }

  /** Reset layout: the saved one goes, every box back where Outpost puts it, fitted. */
  async resetLayout() {
    this.closeMenu()
    if (!this.routine) return
    const id = this.id
    clearTimeout(this.saveTimer)
    this.saveTimer = 0
    this.flushSave = null
    this.pendingId = id
    this.pendingLayout = null
    this.sending++
    try {
      const res = await saveRoutineLayout(id, null)
      if (!res.ok) throw new Error(res.error || 'refused')
      if (id !== this.id || !this.routine) return
      this.routine.layout = null
      this.drawnKey = ''
      this.flow.draw(this.routine, this.repoName, null)
      this.paintMenu()
    } catch (err) {
      this.onToast(`Could not reset the layout — ${err.message || 'try again'}`, 'err')
    } finally {
      this.sending--
    }
  }

  /** Reset layout is in the ⋯ only while a layout is saved. */
  paintMenu() {
    this.$('[data-act=reset-layout]').hidden = !this.drawnKey
  }

  /** The header's ⋯: Reset layout and Delete live behind it, away from Run now, Pause and Change…. */
  toggleMenu(open = this.$('.rv-more .menu').hidden) {
    this.$('.rv-more .menu').hidden = !open
    this.$('[data-act=more]').setAttribute('aria-expanded', String(open))
  }

  closeMenu() {
    this.toggleMenu(false)
  }

  /** Delete…: the confirm, naming the routine and what stays (`deleteWords`). */
  askDelete() {
    this.closeMenu()
    if (!this.routine) return
    const { head, why } = deleteWords(this.routine)
    this.confirmEl.querySelector('h2').textContent = head
    this.confirmEl.querySelector('.why').textContent = why
    this.confirmEl.hidden = false
    // Cancel has the focus, so an Enter pressed out of habit keeps the routine.
    this.confirmEl.querySelector('[data-confirm=no]').focus()
  }

  closeConfirm() {
    if (this.confirmEl.hidden) return
    this.confirmEl.hidden = true
    if (!this.el.hidden) this.$('[data-act=more]').focus()
  }

  /** The confirm's Delete: the routine goes, and the page with it. */
  async remove(b) {
    if (!this.routine) return this.closeConfirm()
    b.disabled = true
    try {
      const res = await deleteRoutine(this.id)
      if (!res.ok) return this.onToast(res.error || 'Could not delete it', 'err')
      this.confirmEl.hidden = true
      this.onToast(...deletedWords(this.routine.name, res.chats))
      this.onGone()
    } catch (err) {
      this.onToast(err.message || 'Could not delete it', 'err')
    } finally {
      b.disabled = false
    }
  }
}

/** A log event's time, to the second: a run's events are seconds apart. */
const clock = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '')

/** A tool call's input in a few words: the command, the file, or the start of the JSON. */
function inputWords(input) {
  if (input == null) return ''
  if (typeof input !== 'object') return String(input).slice(0, 200)
  const pick = input.command || input.file_path || input.path || input.pattern || input.url || input.query
  if (pick) return String(pick).slice(0, 200)
  const json = JSON.stringify(input)
  return json.length > 200 ? `${json.slice(0, 199)}…` : json
}

/** Who started a run, from its `started` event: a person, a call by its trigger's name, or the clock. */
export function startedBy(ev) {
  if (ev.by && ev.by !== 'trigger') return 'by hand'
  return ev.call ? `by a call to "${ev.call}"` : 'by its trigger'
}

/**
 * What a call carried, as the log keeps it (cut by the server as a tool's input is): the JSON,
 * or the cut text itself when the whole was too long and only its start was kept.
 */
export function carriedWords(carried) {
  if (carried && typeof carried === 'object' && !Array.isArray(carried) && Object.keys(carried).length === 1 && typeof carried.cut === 'string') return carried.cut
  return JSON.stringify(carried) ?? 'null'
}

/** The log's events that are the run's rather than a step's: they go Before or After the steps. */
const RUN_EVENTS = new Set(['started', 'gate', 'ended', 'commit', 'push', 'promoted', 'deleted'])

/**
 * A run's execution log by step (ui-details.md *Run*): `{ before, steps, after }`. Each step
 * group is one `started`…end of a step, `{ step, status, at, endedAt, events }`, holding the
 * events logged while it was open — its tool calls. The run's own events (`RUN_EVENTS`) go
 * Before until a step has started and After from then on; anything else logged while no step
 * was open joins the step before it, or Before when there is none. A step's `started` and its
 * end are the group's header, not lines in it. A step that never ended keeps `started`, no
 * `endedAt`; an end with no start seen is a group of its own.
 */
export function groupLog(events) {
  const before = []
  const after = []
  const steps = []
  let open = null
  for (const ev of Array.isArray(events) ? events : []) {
    if (ev.event === 'step') {
      if (ev.status === 'started') {
        open = { step: ev.step, status: 'started', at: ev.at || 0, endedAt: 0, events: [] }
        steps.push(open)
        continue
      }
      const g = steps.findLast((x) => x.step === ev.step && !x.endedAt)
      if (g) Object.assign(g, { status: ev.status, endedAt: ev.at || 0 })
      else steps.push({ step: ev.step, status: ev.status, at: ev.at || 0, endedAt: ev.at || 0, events: [] })
      if (g === open) open = null
      continue
    }
    if (RUN_EVENTS.has(ev.event)) (steps.length ? after : before).push(ev)
    else (open || steps[steps.length - 1] || { events: before }).events.push(ev)
  }
  return { before, steps, after }
}

/**
 * How long a run took and what it spent, for the summary: "took 2m 14s · 34k tokens", or
 * "running for 3m 02s" while it goes.
 */
export function runFacts(run, now = Date.now()) {
  const long =
    run.outcome === 'running' ? (run.at ? `running for ${took(now - run.at)}` : '') : run.endedAt && run.at ? `took ${took(run.endedAt - run.at)}` : ''
  return [long, tokenWords(run.tokens)].filter(Boolean).join(' · ')
}

/**
 * The details column for a routine (ui-details.md *Run*): the chosen run's summary — its ending,
 * how long and what it spent, where it failed, its words, its commits — then its execution log
 * grouped by step, each group folded as the chat's "N steps" are, and Open the chat for a run
 * that became one.
 */
export class RunPanel {
  /** `findChat(run)` is the chat a run became, if it did; `onOpenChat(threadId)` opens it. */
  constructor(el, { findChat, onOpenChat, onToast }) {
    this.el = el
    this.findChat = findChat
    this.onOpenChat = onOpenChat
    this.onToast = onToast
    this.routine = null
    this.run = null
    this.events = []
    // The log's groups open, by key ('before', 'after', 's<i>'): kept across the repaint a live
    // run's log gets every few seconds, emptied for another run.
    this.opened = new Set()
    this.visible = false
    this.el.addEventListener('click', (e) => {
      const g = e.target.closest('button[data-group]')
      if (g) {
        const k = g.dataset.group
        if (!this.opened.delete(k)) this.opened.add(k)
        return this.paint()
      }
      const b = e.target.closest('button[data-act]')
      if (!b) return
      if (b.dataset.act === 'chat') {
        const t = this.run && this.findChat(this.run)
        if (t) this.onOpenChat(t.id)
      } else if (b.dataset.act === 'copy') this.copy()
    })
  }

  /** The routine and run to show; the log is read again only when the run's record moved. */
  set(routine, run) {
    const key = run ? `${routine?.id}/${JSON.stringify(run)}` : ''
    this.routine = routine
    if (key === this.key) return this.paint()
    const sameRun = this.run && run && this.run.runId === run.runId
    this.key = key
    this.run = run
    if (!sameRun) {
      this.events = []
      this.opened = new Set()
    }
    this.paint()
    if (run) this.readLog()
    this.shown(this.visible)
  }

  /** Whether the section is on screen: a running run's log is followed only while it is. */
  shown(on) {
    this.visible = on
    clearInterval(this.timer)
    if (on && this.run?.outcome === 'running') this.timer = setInterval(() => this.readLog(), LIVE_LOG_MS)
  }

  async readLog() {
    const run = this.run
    if (!run || !this.routine) return
    try {
      const res = await fetchRoutineRunLog(this.routine.id, run.runId)
      if (this.run !== run) return
      this.events = Array.isArray(res.events) ? res.events : []
      this.paint()
    } catch {
      /* the summary still stands; the log is read again on the next change */
    }
  }

  stepTitle(id) {
    const steps = this.routine?.steps || []
    const i = steps.findIndex((s) => s.id === id)
    return i < 0 ? String(id) : `Step ${i + 1} · ${steps[i].title || id}`
  }

  /** One event as a line: what happened, in a few words, its inputs never its results. */
  line(ev) {
    const b = (s) => `<b>${escape(s)}</b>`
    const code = (s) => `<code>${escape(s)}</code>`
    switch (ev.event) {
      case 'started':
        return `${b('Started')} · ${startedBy(ev)}${ev.skipGate ? ' · check skipped' : ''}${
          ev.call && ev.carried !== undefined ? `<code class="carried">${escape(carriedWords(ev.carried))}</code>` : ''
        }`
      case 'gate':
        return `${b('Check')}${ev.why ? ` · ${escape(ev.why)}` : ''} → ${ev.ran ? 'run' : 'stop'}`
      case 'step':
        return `${b(this.stepTitle(ev.step))} · ${escape(ev.status || '')}`
      case 'tool':
        return `${escape(ev.name || 'tool')} ${code(inputWords(ev.input))}`
      case 'commit':
        return `${b('Commit')} ${code(String(ev.sha || '').slice(0, 9))} · ${escape(ev.repo || '')}`
      case 'push':
        return `${b('Push')} ${escape(ev.repo || '')} → ${code(ev.ref || '')}`
      case 'ended':
        return `${b(`Ended: ${OUTCOME_WORDS[ev.outcome] || ev.outcome || ''}`)}${ev.text ? ` · ${escape(ev.text)}` : ''}`
      case 'promoted':
        return `${b('Became a chat')}`
      case 'deleted':
        return 'Workspace deleted'
      default:
        return escape(ev.event || '')
    }
  }

  /** Events as the log's lines. */
  lines(events) {
    return events.map((ev) => `<div class="ev"><span class="tm">${escape(clock(ev.at))}</span><span class="wh">${this.line(ev)}</span></div>`).join('')
  }

  /**
   * One folded group of the log: a header button — for a step its title, how it went and how
   * long it took — and, while open, its lines under it. `small` is Before and After.
   */
  group(key, head, events, { tone = '', small = false } = {}) {
    const open = this.opened.has(key)
    const n = `${events.length} event${events.length === 1 ? '' : 's'}`
    return (
      `<button type="button" class="rp-group${small ? ' small' : ''}" data-group="${escape(key)}" data-tone="${tone}" aria-expanded="${open}">` +
      `${head}<span class="g-n">${n}</span></button>` +
      (open ? `<div class="rp-block">${events.length ? this.lines(events) : '<div class="nothing">Nothing logged inside this step.</div>'}</div>` : '')
    )
  }

  /** The execution log, by step (`groupLog`); a run with no steps is a few lines, shown flat. */
  log(run, now) {
    if (!this.events.length) return `<div class="nothing">Nothing logged yet.</div>`
    const { before, steps, after } = groupLog(this.events)
    if (!steps.length) return this.lines(this.events)
    const fail = failedAt(run, this.routine)
    const lastOf = (step) => steps.findLastIndex((g) => g.step === step)
    const parts = []
    if (before.length) parts.push(this.group('before', `<span class="g-t">Before</span>`, before, { small: true }))
    steps.forEach((g, i) => {
      const going = g.status === 'started'
      const word = !going ? g.status : run.outcome === 'running' ? 'running' : fail?.step === g.step && !fail.after && lastOf(g.step) === i ? 'failed' : 'no end'
      const tone = { done: 'ok', failed: 'bad', running: 'run' }[word] || ''
      const long = g.endedAt && g.at ? took(g.endedAt - g.at) : going && run.outcome === 'running' && g.at ? took(now - g.at) : ''
      const head = `<span class="g-t">${escape(this.stepTitle(g.step))}</span><span class="g-o">${escape(word)}</span>${long ? `<span class="g-d">${escape(long)}</span>` : ''}`
      parts.push(this.group(`s${i}`, head, g.events, { tone }))
    })
    if (after.length) parts.push(this.group('after', `<span class="g-t">After</span>`, after, { small: true }))
    return parts.join('')
  }

  paint() {
    const run = this.run
    if (!run) {
      this.el.innerHTML = `<div class="body"><div class="nothing">${this.routine ? 'Choose a run to see what it did.' : ''}</div></div>`
      return
    }
    const now = Date.now()
    const tone = TONE[run.outcome] || ''
    const said = run.text || run.reason || (run.outcome === 'running' ? 'Running now.' : run.outcome === 'nothing' ? 'Nothing to do.' : '')
    const facts = runFacts(run, now)
    const failed = failedWords(failedAt(run, this.routine))
    const commits = (run.commits || [])
      .map((c) => `<li><code>${escape(String(c.sha || '').slice(0, 9))}</code> ${escape(c.repo || '')}${c.pushed ? ' · pushed' : ' · not pushed'}</li>`)
      .join('')
    const how = [startedBy(run), run.skipGate ? 'check skipped' : ''].filter(Boolean).join(' · ')
    const chat = this.findChat(run)
    this.hasChat = Boolean(chat)
    // A live run's log is repainted every few seconds; the column keeps its scroll through it.
    const top = this.el.querySelector('.body')?.scrollTop || 0
    this.el.innerHTML =
      `<div class="body">` +
      `<div class="rp-head"><div class="t">Run · ${escape(when(run.at))}</div><div class="x">${escape(how)}</div></div>` +
      `<div class="rp-summary" data-tone="${tone}"><b>${escape(OUTCOME_WORDS[run.outcome] || run.outcome || '')}</b>${
        facts ? `<div class="facts">${escape(facts)}</div>` : ''
      }${failed ? `<div class="failed">${escape(failed)}</div>` : ''}${said ? `<div>${escape(said)}</div>` : ''}${commits ? `<ul>${commits}</ul>` : ''}</div>` +
      `<div class="label">Execution log</div>` +
      `<div class="rp-log">${this.log(run, now)}</div>` +
      `<div class="row wrap actions">${chat ? `<button class="btn sm primary" data-act="chat">Open the chat</button>` : ''}<button class="btn sm ghost" data-act="copy">Copy log</button></div>` +
      `</div>`
    if (top) this.el.querySelector('.body').scrollTop = top
  }

  /** Repaint only when the chat a run became has appeared or gone: a rebuild loses the log's scroll. */
  refreshChat() {
    if (this.run && Boolean(this.findChat(this.run)) !== this.hasChat) this.paint()
  }

  copy() {
    const text = this.events.map((ev) => JSON.stringify(ev)).join('\n')
    navigator.clipboard?.writeText(text).then(
      () => this.onToast('Log copied'),
      () => this.onToast('Could not copy the log', 'err')
    )
  }
}
