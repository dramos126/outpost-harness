/**
 * The page's skeleton: the sidebar with the chat list, the main pane the conversation and the
 * settings view take turns in, toasts, and the hint pill.
 *
 * One `data-view` attribute on the root says what the page is showing — `list`, `chat` or
 * `settings` — and CSS does the rest. On a wide screen the sidebar is always there and the
 * attribute only decides what fills the main pane; at phone width the list and the chat are
 * two screens and the attribute is which one you are on. There is no second layout: the same
 * elements are shown or hidden, so nothing can be reachable on one and missing on the other.
 */
import { MARK } from './favicon.js'
import { GLYPH } from './marks.js'

export const ICON = {
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  bubble: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  forward: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m21 12-8.5 8.5a5 5 0 0 1-7-7L14 5a3.3 3.3 0 0 1 4.7 4.7L10.5 18a1.7 1.7 0 0 1-2.4-2.4L16 7.7"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3a1 1 0 0 1 .7.3l6 6a1 1 0 0 1-1.4 1.4L13 6.4V20a1 1 0 1 1-2 0V6.4l-4.3 4.3a1 1 0 1 1-1.4-1.4l6-6A1 1 0 0 1 12 3z"/></svg>',
  term: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12 15h5"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="6.5" width="11" height="11" rx="2"/></svg>',
  panel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>',
  // A folder: Files, in the tool row (`file` reads as one document).
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  // Four corners out: a file over the chat and the column (Files' Expand).
  expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>',
  // An arrow into a bracket, →]: Hand off, carrying on into the next conversation. Not the
  // box-with-arrow, which reads as Share.
  handoff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/></svg>',
  // A pushpin; the stylesheet fills it when on.
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 3h6l-1 7 4 4v3H6v-3l4-4z"/></svg>',
}

const SIDE_DEFAULT = 300
const SIDE_MIN = 220
const SIDE_MAX = 520
const SIDE_KEY = 'outpost.sideWidth'
const SIDE_COLLAPSED_KEY = 'outpost.sideCollapsed'
/** The details column: wider than the chat list by default, because a diff needs the room. */
const RIGHT_DEFAULT = 400
const RIGHT_MIN = 300
/** Up from 760 for the reading width: a file wants room that Workspace and Activity do not (ui-details.md). */
const RIGHT_MAX = 1000
const RIGHT_KEY = 'outpost.rightWidth'
/** The column's second width, in force in Files mode, remembered on its own. */
const READ_DEFAULT = 760
const READ_KEY = 'outpost.readWidth'
/** What the chat column keeps in Files mode: the reading width yields to it on a narrow window. */
const CHAT_MIN = 480
/** How far the sheet's handle is pulled down before letting go closes it; shorter snaps back, so a tap never closes. */
const SWIPE_CLOSE_PX = 40
/** Which of the details column's sections are open: `{ workspace, activity }`, per browser like the width. Files has none: on a wide screen it is not in the stacked view at all, and is the whole column in its mode. */
const SECTIONS_KEY = 'outpost.rightSections'
/** Which of the sidebar's tabs is showing, `chats` or `routines`, per browser like the width. */
const TAB_KEY = 'outpost.sideTab'

/** A stored object, or `{}` for none or one that will not parse — the defaults then stand. */
const readJson = (s) => {
  try {
    const v = JSON.parse(s || '{}')
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

// Storage can throw or come back empty (private window, blocked site data); the sidebar must
// still render at its default then.
const store = {
  get(key) {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value)
    } catch {}
  },
}

const clampSide = (w) => Math.min(SIDE_MAX, Math.max(SIDE_MIN, Math.round(w)))
const clampRight = (w) => Math.min(RIGHT_MAX, Math.max(RIGHT_MIN, Math.round(w)))

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** The page's own phone breakpoint, the same two conditions the stylesheet uses (ui.md). */
const PHONE = '(max-width: 760px), (max-height: 500px)'
export const isPhone = () => typeof matchMedia === 'function' && matchMedia(PHONE).matches

/** Where the details column is a bottom sheet (ui-details.md): Files keeps its list in the stack there, and has no mode header. */
const SHEET = '(max-width: 1099px)'
const isSheet = () => typeof matchMedia === 'function' && matchMedia(SHEET).matches

/**
 * A clear button right after a search input. The stylesheet hides it while the placeholder
 * shows, so a value set or emptied in code never leaves it stale; a click empties the box,
 * fires `input` so the filter re-runs, and keeps the focus in it.
 */
export function clearable(input) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'clear-search'
  b.title = 'Clear'
  b.setAttribute('aria-label', 'Clear search')
  b.innerHTML = ICON.close
  b.addEventListener('click', () => {
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.focus()
  })
  input.after(b)
}

/** Less than this between the page and what is visible is a scrolled toolbar, not a keyboard. */
const KEYBOARD_MIN_PX = 150

/**
 * While a phone's keyboard is up, the page is as tall as what is left above it. iOS lays the
 * keyboard over the page rather than shrinking it, so whatever sat at the foot — the
 * terminal's keys, under a terminal whose own field is at the top — went behind it.
 */
export function fitKeyboard(root = document.documentElement) {
  const vv = window.visualViewport
  if (!vv) return
  const fit = () => {
    // A pinch zoom shrinks what is visible too, but changes the scale; a keyboard does not.
    if (vv.scale < 1.01 && innerHeight - vv.height > KEYBOARD_MIN_PX) {
      root.style.setProperty('--kb-h', `${vv.height}px`)
      root.dataset.kb = ''
      // iOS scrolls the page to bring a field into view; with the page now the visible
      // height, that scroll would only leave a gap at the top.
      scrollTo(0, 0)
    } else if ('kb' in root.dataset) {
      root.style.removeProperty('--kb-h')
      delete root.dataset.kb
    }
  }
  vv.addEventListener('resize', fit)
  vv.addEventListener('scroll', fit)
}

export class Shell {
  /**
   * `onNewChat()` opens the New chat dialog; `onSettings()` and `onBack()` move between
   * views; `onSearch(text)` filters the list; `onRightToggle()` says a section of the details
   * column was folded or opened (or the sheet's breakpoint crossed), `onRightMode(on)` that a
   * heading or the mode header's back link asks Files mode in or out (ui-details.md),
   * `onFileExpand()` the mode header's Expand, and `onRightClose()` that the column was closed; `onArchived()` flips
   * the list between the live chats and the archived ones; `onBulk()` is the bulk archive's
   * button, pressed, and `onBulkCancel()` its Cancel. `onTab(tab)` is the sidebar's tab changed.
   * `onNewRoutine()` is the same New button pressed while Routines shows.
   */
  constructor(root, { onNewChat, onNewRoutine, onSettings, onBack, onSearch, onRightToggle, onRightMode, onFileExpand, onRightClose, onArchived, onBulk, onBulkCancel, onTab }) {
    this.onTab = onTab || (() => {})
    this.onArchived = onArchived
    this.onBulk = onBulk || (() => {})
    this.onBulkCancel = onBulkCancel || (() => {})
    this.onNewChat = onNewChat
    this.onNewRoutine = onNewRoutine || (() => {})
    this.onSettings = onSettings
    this.onBack = onBack
    this.onSearch = onSearch
    this.onRightToggle = onRightToggle || (() => {})
    this.onRightMode = onRightMode || (() => {})
    this.onFileExpand = onFileExpand || (() => {})
    this.onRightClose = onRightClose || (() => {})
    // The details column's mode, as `setRight` was last told: 'files' while Files is its only content.
    this.rightMode = ''
    this.el = document.createElement('div')
    this.el.className = 'app'
    this.el.dataset.view = 'list'
    this.el.innerHTML = `
      <aside class="side">
        <header class="side-head">
          <div class="brand"><span class="logo">${MARK}</span><span class="word">outpost_</span><span class="need" hidden></span></div>
          <button class="btn icon" id="btn-settings" title="Settings" aria-label="Settings">${ICON.gear}<span class="ws-badge" hidden></span></button>
          <button class="btn icon side-toggle" id="btn-collapse" title="Hide the chat list" aria-label="Hide the chat list">${ICON.panel}</button>
        </header>
        <div class="side-tabs" role="tablist" aria-label="Chats or routines"><button class="tab" role="tab" data-tab="chats">${ICON.bubble}<span>Chats</span></button><button class="tab" role="tab" data-tab="routines"><span class="glyph" aria-hidden="true">↻</span><span>Routines</span><span class="n" hidden></span></button></div>
        <div class="side-tools">
          <label class="search">${ICON.search}<input type="search" placeholder="Search chats" autocomplete="off" spellcheck="false" /></label>
          <button class="btn primary icon" id="btn-new" title="New chat (C)" aria-label="New chat">${ICON.plus}</button>
          <button class="btn icon" id="btn-bulk"></button>
        </div>
        <div class="picking" hidden><span>Tap the chats to archive, then press Archive.</span><button class="btn ghost" id="btn-bulk-cancel">Cancel</button></div>
        <div class="chats"></div>
        <div class="routines" hidden></div>
        <div class="found" hidden></div>
        <button class="archived-link" id="btn-archived" hidden></button>
        <footer class="side-foot">
          <div class="sys" hidden></div>
          <div class="usage" hidden></div>
          <div class="link" hidden title="The live connection to the server is down — showing the last known state">Reconnecting…</div>
          <div class="link partial" hidden>Some chats could not be read</div>
          <div class="ver"><span class="ver-label">build</span><i class="ver-dot" hidden></i><span class="ver-id"></span><span class="ver-next" hidden></span><button class="btn ghost ver-reload" hidden>Reload</button></div>
        </footer>
      </aside>
      <div class="side-grip" role="separator" aria-orientation="vertical" aria-label="Resize the chat list" tabindex="0" title="Drag to resize; double-click to reset"></div>
      <main class="main">
        <div class="empty">
          <div class="mark">${MARK}</div>
          <h2>Outpost</h2>
          <p>Pick a chat on the left, or start a new one.</p>
        </div>
        <section class="settings-view" hidden></section>
      </main>
      <div class="right-grip" role="separator" aria-orientation="vertical" aria-label="Resize the details column" tabindex="0" title="Drag to resize; double-click to reset"></div>
      <aside class="right" hidden>
        <div class="right-handle" aria-hidden="true" title="Swipe down to close"><span></span></div>
        <button class="btn icon right-close" data-act="close" title="Close" aria-label="Close">${ICON.close}</button>
        <div class="rmode" hidden>
          <button type="button" class="rmode-back" data-rmode="leave" title="Back to Workspace and Activity">← Workspace · Activity</button>
          <span class="rmode-name">Files</span>
          <button type="button" class="btn icon sm ghost" data-rmode="expand" title="Open over the chat; Esc closes" aria-label="Expand" hidden>${ICON.expand}</button>
        </div>
        <div class="rsec" data-sec="workspace">
          <button class="rsec-head" data-sec="workspace" aria-expanded="true"><span class="chev" aria-hidden="true"></span>Workspace</button>
          <section class="wspanel"></section>
        </div>
        <div class="rsec" data-sec="activity">
          <button class="rsec-head" data-sec="activity" aria-expanded="true"><span class="chev" aria-hidden="true"></span>Activity</button>
          <section class="actpanel"></section>
        </div>
        <div class="rsec" data-sec="files">
          <button class="rsec-head" data-sec="files" aria-expanded="true"><span class="chev" aria-hidden="true"></span>Files</button>
          <section class="filespanel"></section>
        </div>
        <div class="rsec" data-sec="run">
          <button class="rsec-head" data-sec="run" aria-expanded="true"><span class="chev" aria-hidden="true"></span>Run</button>
          <section class="runpanel"></section>
        </div>
      </aside>
      <div class="toasts"></div>
      <div class="hint"></div>`
    root.appendChild(this.el)
    this.$ = (sel) => this.el.querySelector(sel)
    this.chats = this.$('.chats')
    this.routinesEl = this.$('.routines')
    this.runEl = this.$('.runpanel')
    this.found = this.$('.found')
    this.main = this.$('.main')
    this.settingsEl = this.$('.settings-view')
    this.usageEl = this.$('.usage')
    this.sysEl = this.$('.sys')
    this.wsEl = this.$('.wspanel')
    this.rightEl = this.$('.right')
    this.actEl = this.$('.actpanel')
    this.filesEl = this.$('.filespanel')
    this.sideWidth = clampSide(Number(store.get(SIDE_KEY)) || SIDE_DEFAULT)
    this.sideCollapsed = store.get(SIDE_COLLAPSED_KEY) === '1'
    this.rightWidth = clampRight(Number(store.get(RIGHT_KEY)) || RIGHT_DEFAULT)
    this.readWidth = clampRight(Number(store.get(READ_KEY)) || READ_DEFAULT)
    // Whether Files is in its mode: the reading width is the one in force and the one the grip sets.
    this.reading = false
    this.expanded = { workspace: true, activity: true, run: true, ...readJson(store.get(SECTIONS_KEY)) }
    // A `files` key saved before Files lost its fold state is not read.
    delete this.expanded.files
    this.tab = store.get(TAB_KEY) === 'routines' ? 'routines' : 'chats'
    this._applySide()
    this._applyTab()
    this._applyRight()
    this._wire()
    this._wireSide()
    this._wireRight()
  }

  /**
   * The width in force: the reading width while Files is in its mode, held back so the chat column
   * keeps `CHAT_MIN` — a 760 px column on a 1300 px window would leave the conversation nothing.
   */
  _rightWidthNow() {
    if (!this.reading) return this.rightWidth
    const room = this.el.clientWidth - (this.$('.side')?.offsetWidth || 0) - CHAT_MIN
    return Math.max(RIGHT_MIN, Math.min(this.readWidth, room))
  }

  _applyRight() {
    const w = this._rightWidthNow()
    this.el.style.setProperty('--right-w', `${w}px`)
    this.$('.right-grip').setAttribute('aria-valuenow', String(w))
  }

  /** The grip sets whichever width is in force: dragging in Files mode sets the reading width. */
  _setRightWidth(w, save) {
    if (this.reading) this.readWidth = clampRight(w)
    else this.rightWidth = clampRight(w)
    this._applyRight()
    if (save) this._saveRightWidth()
  }

  _saveRightWidth() {
    if (this.reading) store.set(READ_KEY, String(this.readWidth))
    else store.set(RIGHT_KEY, String(this.rightWidth))
  }

  /** Told whether Files is in its mode (main.js `paintRight`): the column switches width, and back when it leaves. */
  setReading(on) {
    if (this.reading === Boolean(on)) return
    this.reading = Boolean(on)
    this._applyRight()
  }

  /** The same grip as the chat list's, on the other edge: it measures from the right. */
  _wireRight() {
    const grip = this.$('.right-grip')
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      grip.setPointerCapture(e.pointerId)
      this.el.classList.add('resizing')
    })
    grip.addEventListener('pointermove', (e) => {
      if (!grip.hasPointerCapture(e.pointerId)) return
      this._setRightWidth(this.el.getBoundingClientRect().right - e.clientX, false)
    })
    const end = (e) => {
      if (!grip.hasPointerCapture(e.pointerId)) return
      grip.releasePointerCapture(e.pointerId)
      this.el.classList.remove('resizing')
      this._saveRightWidth()
    }
    grip.addEventListener('pointerup', end)
    grip.addEventListener('pointercancel', end)
    grip.addEventListener('dblclick', () => this._setRightWidth(this.reading ? READ_DEFAULT : RIGHT_DEFAULT, true))
    // The reading width yields to the chat column's minimum, which a resize of the window moves.
    window.addEventListener('resize', () => {
      if (this.reading) this._applyRight()
    })
    grip.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 40 : 10
      if (e.key === 'ArrowLeft') this._setRightWidth(this.rightWidth + step, true)
      else if (e.key === 'ArrowRight') this._setRightWidth(this.rightWidth - step, true)
      else return
      e.preventDefault()
    })
    this._wireHandle()
    // Files keeps its list in the sheet's stack and not in the column's: crossing the line repaints.
    if (typeof matchMedia === 'function') matchMedia(SHEET).addEventListener('change', () => this.onRightToggle())
    this.rightEl.addEventListener('click', (e) => {
      const b = e.target.closest('.right-close, .rsec-head, [data-rmode]')
      if (!b) return
      if (b.dataset.act === 'close') return this.onRightClose()
      if (b.dataset.rmode === 'expand') return this.onFileExpand()
      if (b.dataset.rmode === 'leave') return this.onRightMode(false)
      // In Files mode the sheet's headings are drawn folded over saved states that were never
      // changed (on a wide screen they are hidden): a click leaves the mode and touches nothing saved.
      if (this.rightMode === 'files') return this.onRightMode(false)
      const sec = b.dataset.sec
      // The Files heading (the sheet's; a wide screen has none in the stack) has no fold of its own:
      // it is the way into the mode.
      if (sec === 'files') return this.onRightMode(true)
      this.expanded[sec] = !this.expanded[sec]
      store.set(SECTIONS_KEY, JSON.stringify(this.expanded))
      this.onRightToggle()
    })
  }

  /**
   * The sheet's handle (drawn under 1100 px only): dragged down it carries the sheet with the
   * finger, and let go past `SWIPE_CLOSE_PX` it closes it as the close button does; shorter, it
   * snaps back. The same pointer capture as the grips, so the drag keeps going off the handle.
   */
  _wireHandle() {
    const handle = this.$('.right-handle')
    let startY = 0
    let dy = 0
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      handle.setPointerCapture(e.pointerId)
      startY = e.clientY
      dy = 0
      this.rightEl.classList.add('dragging')
    })
    handle.addEventListener('pointermove', (e) => {
      if (!handle.hasPointerCapture(e.pointerId)) return
      dy = Math.max(0, e.clientY - startY)
      this.rightEl.style.transform = `translateY(${dy}px)`
    })
    const end = (e) => {
      if (!handle.hasPointerCapture(e.pointerId)) return
      handle.releasePointerCapture(e.pointerId)
      this.rightEl.classList.remove('dragging')
      this.rightEl.style.removeProperty('transform')
      if (e.type === 'pointerup' && dy > SWIPE_CLOSE_PX) this.onRightClose()
    }
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }

  /** Open a section of the details column if it was folded, remembered like a click on its heading. */
  expand(sec) {
    if (!(sec in this.expanded) || this.expanded[sec]) return
    this.expanded[sec] = true
    store.set(SECTIONS_KEY, JSON.stringify(this.expanded))
  }

  /**
   * The width lives in an inline `--side-w` on the root, which every grid rule already reads.
   * Collapsed removes it and lets the stylesheet narrow it to a rail: the sidebar keeps its
   * column and its colour and shows only its two header buttons, so one button both hides and
   * shows the list and Settings is never out of reach. Both only apply above phone width — the
   * stylesheet ignores them there.
   */
  _applySide() {
    this.el.dataset.side = this.sideCollapsed ? 'collapsed' : 'open'
    if (this.sideCollapsed) this.el.style.removeProperty('--side-w')
    else this.el.style.setProperty('--side-w', `${this.sideWidth}px`)
    this.$('.side-grip').setAttribute('aria-valuenow', String(this.sideWidth))
    const toggle = this.$('#btn-collapse')
    const label = this.sideCollapsed ? 'Show the chat list' : 'Hide the chat list'
    toggle.title = label
    toggle.setAttribute('aria-label', label)
    toggle.setAttribute('aria-expanded', String(!this.sideCollapsed))
  }

  _setSideWidth(w, save) {
    this.sideWidth = clampSide(w)
    this._applySide()
    if (save) store.set(SIDE_KEY, String(this.sideWidth))
  }

  _setCollapsed(collapsed) {
    this.sideCollapsed = collapsed
    this._applySide()
    store.set(SIDE_COLLAPSED_KEY, collapsed ? '1' : '0')
  }

  _wireSide() {
    this.$('#btn-collapse').addEventListener('click', () => this._setCollapsed(!this.sideCollapsed))
    const grip = this.$('.side-grip')
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      grip.setPointerCapture(e.pointerId)
      this.el.classList.add('resizing')
    })
    grip.addEventListener('pointermove', (e) => {
      if (!grip.hasPointerCapture(e.pointerId)) return
      this._setSideWidth(e.clientX - this.el.getBoundingClientRect().left, false)
    })
    const end = (e) => {
      if (!grip.hasPointerCapture(e.pointerId)) return
      grip.releasePointerCapture(e.pointerId)
      this.el.classList.remove('resizing')
      store.set(SIDE_KEY, String(this.sideWidth))
    }
    grip.addEventListener('pointerup', end)
    grip.addEventListener('pointercancel', end)
    grip.addEventListener('dblclick', () => this._setSideWidth(SIDE_DEFAULT, true))
    grip.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 40 : 10
      if (e.key === 'ArrowLeft') this._setSideWidth(this.sideWidth - step, true)
      else if (e.key === 'ArrowRight') this._setSideWidth(this.sideWidth + step, true)
      else return
      e.preventDefault()
    })
  }

  /**
   * The details column (a sheet on a phone): Workspace above Activity above Files, all showing
   * at once, each folded or open by its heading — the owner's layout, since Workspace is short
   * and Activity is read from its foot. `sections` is `{ workspace, activity, files, run }` as
   * booleans, which exist for this chat — or `run` alone, for a routine's page; with none, there is no column at all. A section alone
   * in the column cannot be folded away: it is all there is. `fill` names the section that
   * takes the height — Files in its mode, else Activity, else Workspace. Files is shown only in
   * its mode, or in the sheet's stack (its list); a wide screen's stack is Workspace and Activity. `mode: 'files'` is Files mode: on a wide
   * screen the mode header (`.rmode`) in place of the three headings and Files alone in two panes,
   * the stylesheet's; in the sheet Workspace and Activity drawn folded — either way their saved
   * states untouched. `viewing` (a file open) shows the header's Expand. Answers which sections
   * are showing their body, so the caller paints only those.
   */
  setRight({ sections = {}, open = false, fill = '', mode = '', viewing = false } = {}) {
    this.rightMode = mode
    const filesMode = mode === 'files' && Boolean(sections.files)
    const sheet = isSheet()
    this.rightEl.dataset.mode = filesMode ? 'files' : ''
    const head = this.$('.rmode')
    head.hidden = !filesMode
    head.querySelector('[data-rmode=expand]').hidden = !(filesMode && viewing)
    const present = Object.keys(sections).filter((k) => sections[k])
    const has = present.length > 0
    this.el.dataset.right = has ? (open ? 'open' : 'closed') : 'none'
    this.rightEl.hidden = !has || !open
    const alone = present.length === 1
    const showing = {}
    for (const sec of this.rightEl.querySelectorAll('.rsec')) {
      const name = sec.dataset.sec
      const body = Boolean(sections[name]) && (alone || (name === 'files' ? filesMode || sheet : !filesMode && this.expanded[name]))
      sec.hidden = !sections[name] || (name === 'files' && !filesMode && !sheet)
      sec.dataset.state = body ? 'open' : 'folded'
      const head = sec.querySelector('.rsec-head')
      head.setAttribute('aria-expanded', String(body))
      head.disabled = alone
      showing[name] = open && body
    }
    // Which share the height: Files in its mode takes it all; else an open Activity takes what
    // Workspace leaves; with Activity folded, Workspace takes it all.
    this.rightEl.dataset.fill = fill === 'files' && showing.files ? 'files' : showing.run ? 'run' : showing.activity ? 'activity' : 'workspace'
    return showing
  }

  _wire() {
    this.$('#btn-settings').addEventListener('click', () => this.onSettings())
    this.$('.side-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]')
      if (b) this.setTab(b.dataset.tab)
    })
    const input = this.$('.search input')
    input.addEventListener('input', () => this.onSearch(input.value))
    clearable(input)
    this.$('#btn-new').addEventListener('click', () => (this.tab === 'routines' ? this.onNewRoutine() : this.onNewChat()))
    this.$('#btn-archived').addEventListener('click', () => this.onArchived())
    this.$('#btn-bulk').addEventListener('click', () => this.onBulk())
    this.$('#btn-bulk-cancel').addEventListener('click', () => this.onBulkCancel())
    this.$('.ver-reload').addEventListener('click', () => location.reload())
    this.setBulk(null)
  }

  /**
   * The bulk archive's button (chats.md): an icon while off; while picking, "Archive · n" held
   * down, with the strip under the search saying what a tap does and offering Cancel. `n` is
   * null when off.
   */
  setBulk(n) {
    const el = this.$('#btn-bulk')
    const on = n !== null
    el.classList.toggle('on', on)
    el.classList.toggle('icon', !on)
    el.setAttribute('aria-pressed', String(on))
    el.innerHTML = on ? `Archive · ${n}` : ICON.box
    const label = on ? (n ? `Archive the ${n} picked chat${n === 1 ? '' : 's'} now` : 'Nothing picked — press to stop picking') : 'Archive several chats: pick the ones at rest, then press again'
    el.title = label
    el.setAttribute('aria-label', label)
    this.$('.picking').hidden = !on
  }

  /**
   * The way to the archived chats, at the foot of the list above the footer: how many there are, and — while the
   * list is showing them — the way back. Hidden when nothing is archived, so it is only ever
   * there when it leads somewhere.
   */
  setArchived(n, open) {
    const el = this.$('#btn-archived')
    el.hidden = !n
    el.textContent = open ? '‹ Back to chats' : `Archived · ${n}`
    el.setAttribute('aria-pressed', String(Boolean(open)))
  }

  /**
   * The sidebar's tab: Chats or Routines (routines.md *In the sidebar*). They share the search,
   * the width and the rail; what else in the sidebar is only the chats' is hidden by the
   * stylesheet off `data-tab`. Remembered, guarded like the width.
   */
  setTab(tab) {
    tab = tab === 'routines' ? 'routines' : 'chats'
    if (tab === this.tab) return
    this.tab = tab
    store.set(TAB_KEY, tab)
    this._applyTab()
    this.onTab(tab)
  }

  _applyTab() {
    const side = this.$('.side')
    side.dataset.tab = this.tab
    for (const b of this.el.querySelectorAll('.side-tabs .tab')) {
      const on = b.dataset.tab === this.tab
      b.classList.toggle('on', on)
      b.setAttribute('aria-selected', String(on))
    }
    this.chats.hidden = this.tab !== 'chats'
    this.routinesEl.hidden = this.tab !== 'routines'
    this.$('.search input').placeholder = this.tab === 'routines' ? 'Search routines' : 'Search chats'
    // The one New button is the tab's: a chat under Chats, under Routines a chat that defines a
    // routine (routines.md *Defining chats*), started at once with no form.
    const add = this.$('#btn-new')
    add.setAttribute('aria-label', this.tab === 'routines' ? 'New routine' : 'New chat')
    add.title = this.tab === 'routines' ? 'New routine: a chat to describe it in, which asks you to approve it' : 'New chat (C)'
  }

  /** The Routines tab's "? N": routines whose run came back as a chat that is waiting on you, in the rows' own ask glyph. */
  setRoutineCount(n) {
    const el = this.$('.side-tabs .n')
    el.hidden = !n
    el.innerHTML = n ? `${GLYPH.ask}<span>${Number(n)}</span>` : ''
    el.title = n ? `${n} routine${n === 1 ? '' : 's'} waiting on you` : ''
  }

  /** `list`, `chat`, `routine` or `settings`. The attribute is the whole of the routing. */
  setView(view) {
    // Back on the list, a phone lands at its top, where Needs you is: the list kept the
    // scroll it had when a chat was opened, so the next chat waiting was above the fold. Not on
    // a wide screen, where the list is beside the chat and was never left.
    if (view === 'list' && this.el.dataset.view !== 'list' && isPhone()) this.chats.scrollTop = 0
    this.el.dataset.view = view
    this.settingsEl.hidden = view !== 'settings'
    this.$('.empty').hidden = view !== 'list'
  }

  get view() {
    return this.el.dataset.view
  }

  /** The count beside the name: how many chats want a person right now. */
  setNeedsYou(n) {
    const el = this.$('.need')
    el.hidden = !n
    el.textContent = n ? String(n) : ''
    el.title = n ? `${n} chat${n === 1 ? '' : 's'} waiting on you` : ''
  }

  /** The dot on the gear: workspaces waiting on a decision in Settings › Workspaces. */
  setWorkspaceBadge(n) {
    const b = this.$('#btn-settings')
    b.querySelector('.ws-badge').hidden = !n
    b.title = n ? `Settings — ${n} workspace${n === 1 ? '' : 's'} to decide on` : 'Settings'
  }

  /** Hits from the index for the search box's words, drawn under the filtered list. */
  setFound(hits, query) {
    const el = this.found
    if (!query || !hits) {
      el.hidden = true
      el.innerHTML = ''
      return
    }
    el.hidden = false
    el.innerHTML =
      `<div class="sec">From memory and docs</div>` +
      (hits.length
        ? hits
            .map(
              (h) =>
                `<div class="hit"><div class="t"><span class="kind">${escape(h.kind)}</span>${escape(h.title)}</div><div class="s">${escape(h.snippet).replace(/«/g, '<mark>').replace(/»/g, '</mark>')}</div></div>`
            )
            .join('')
        : `<div class="nothing">Nothing in memory or docs matches.</div>`)
  }

  /** Say the stream is down and the page is working off its last fetch. */
  setLink(up) {
    this.$('.link').hidden = up
  }

  /**
   * Say the list is short of something: `failed` names the harnesses whose scan threw, whose
   * chats are therefore missing from it. Without this a list with chats missing reads as
   * those chats being gone.
   */
  setPartial(failed = []) {
    const el = this.$('.partial')
    el.hidden = !failed.length
    el.title = failed.length ? `The server could not read ${failed.join(', ')} just now — its chats are missing from this list until it can` : ''
  }

  /**
   * Say the page is older than the build the server now has, and offer the reload, on the
   * version line itself: a dot before this page's hash, `→ <new hash>` after it, Reload at the
   * end, the new commit's subject the hover. One line in both states, so nothing above it moves;
   * no toast — the tab's icon carries the dot to a phone or a background tab (`setFaviconUpdate`).
   * Never reloaded for you: a refresh loses the draft in the composer, so when is the person's call.
   */
  setStale(stale, next = { commit: '', subject: '' }) {
    const line = this.$('.ver')
    line.classList.toggle('stale', stale)
    this.$('.ver-dot').hidden = !stale
    this.$('.ver-reload').hidden = !stale
    const n = this.$('.ver-next')
    n.hidden = !stale || !next.commit
    n.textContent = `→ ${next.commit}`
    line.title = stale ? (next.subject ? `New version: ${next.subject}` : 'A new version of Outpost is on the server') : ''
  }

  /** What this page was built from, for the footer's version line; the reload joins it at the line's end (`setStale`). */
  setVersion(text, title) {
    this.$('.ver-id').textContent = text
    this.$('.ver-id').title = title
  }

  /**
   * How many chats are working, said on Reload before it is pressed — "Reload · 2 working" —
   * rather than a second press. A reload is the page's alone: each session is a systemd unit
   * around its container (launchers.md), and the page reads the roster, the push channel and
   * the open chat again on load (`#/chat/<id>`); only an unsent draft is lost.
   */
  setWorking(n) {
    const btn = this.$('.ver-reload')
    btn.textContent = n ? `Reload · ${n} working` : 'Reload'
    btn.title = n
      ? `${n} chat${n === 1 ? ' is' : 's are'} working. Sessions keep running in their containers; after the reload the live view reconnects to the same chat. An unsent draft is lost.`
      : 'Reloading comes back to the same chat; an unsent draft is lost.'
  }

  /**
   * A line at the foot of the screen that goes by itself. `action` (`{ label, run }`) puts a
   * button at its end — Archive's Undo — and `links` (`[{ label, run }]`) a line each under it —
   * `/away`'s chats; either makes it take presses, and it stays `ms` (ten seconds with an action,
   * the time to change your mind). A press runs it and closes the toast.
   */
  toast(message, kind = '', { action = null, links = [], ms = 0 } = {}) {
    const el = document.createElement('div')
    el.className = `toast ${kind}${action || links.length ? ' acts' : ''}`
    const text = document.createElement('span')
    text.textContent = message
    el.appendChild(text)
    let timer = 0
    const close = () => {
      clearTimeout(timer)
      if (!el.isConnected || el.classList.contains('leaving')) return
      el.classList.add('leaving')
      setTimeout(() => el.remove(), 260)
    }
    const button = (cls, label, run) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = cls
      b.textContent = label
      b.addEventListener('click', () => {
        close()
        run()
      })
      return b
    }
    if (action) el.appendChild(button('do', action.label, action.run))
    if (links.length) {
      const list = document.createElement('div')
      list.className = 'links'
      for (const l of links) list.appendChild(button('link', l.label, l.run))
      el.appendChild(list)
    }
    this.$('.toasts').appendChild(el)
    timer = setTimeout(close, ms || (action ? 10000 : links.length ? 8000 : 3600))
    return { close }
  }

  hint(text, ms = 3200) {
    const el = this.$('.hint')
    el.textContent = text
    el.classList.add('on')
    clearTimeout(this._hintTimer)
    this._hintTimer = setTimeout(() => el.classList.remove('on'), ms)
  }

  removeBoot() {
    const boot = document.querySelector('.boot')
    if (!boot) return
    boot.classList.add('gone')
    setTimeout(() => boot.remove(), 400)
  }
}
