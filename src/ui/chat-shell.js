/**
 * A shell into the open chat's container, in a drawer between the log and the composer
 * (ui-conversation.md *Shell drawer*; what it may reach, and why no `su`, is auth.md's).
 *
 * Loaded the first time the drawer opens: it brings xterm with `TermScreen`, most of the page's
 * weight, and a phone never wants it (the drawer is not built for one).
 *
 * One drawer serves every chat. Each chat's shells keep their widgets while it is one of the
 * four chats shown last; an older one's are disposed, and the server's kept output (512 KB,
 * read from offset 0) fills them again when it is shown. The drawer's height is one for every
 * chat, the browser's like the sidebar's width.
 */
import { closeShell, fetchShells, openChatShell } from '../api.js'
import { ICON } from './shell.js'
import { TermScreen } from './term-screen.js'

const H_KEY = 'outpost.drawerHeight'
const H_DEFAULT = 320
const H_MIN = 160
/** Chats whose widgets are kept; the server's own cap is three shells a chat. */
const KEEP_CHATS = 4
const PER_CHAT = 3
const STOPPED = 'The container is stopped — Resume the chat to start it'
/** A stop the server reported while the roster still said running is asked again after this. */
const STOPPED_RETRY_MS = 5000
/** Where the drawer is hidden by the stylesheet: nothing is opened for a drawer nobody sees. */
const NARROW = '(max-width: 1099px)'

const EXPAND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></svg>'

// Storage can throw (private window, blocked site data); the drawer then opens at its default.
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

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export class ChatShell {
  /**
   * `el` is the panel's drawer slot, `log` the log it shares its height with; `onChange()` says
   * the drawer opened or closed, for the tool row's toggle.
   */
  constructor(el, { log, onToast, onChange }) {
    this.el = el
    this.logEl = log
    this.onToast = onToast || (() => {})
    this.onChange = onChange || (() => {})
    /** thread id -> { screens: Map<id, TermScreen>, current, open, listed, busy, stoppedAt, error }, least recently shown first */
    this.chats = new Map()
    this.thread = null
    this.account = ''
    this.expanded = false
    el.innerHTML = `
      <div class="cshell-grip" role="separator" aria-orientation="horizontal" aria-label="Resize the shell" tabindex="0" title="Drag to resize; double-click to reset"></div>
      <div class="cshell-head">
        <div class="cshell-tabs" role="tablist"></div>
        <span class="cshell-stopped" hidden>${STOPPED}</span>
        <button class="cshell-add" type="button" data-cs="add" title="Another shell in this container" aria-label="Another shell">+</button>
        <span class="cshell-where"></span>
        <button class="btn icon sm ghost" type="button" data-cs="expand" aria-pressed="false" title="As tall as the log">${EXPAND}</button>
        <button class="btn icon sm ghost" type="button" data-cs="hide" title="Hide — the shells stay open" aria-label="Hide the shell">${ICON.close}</button>
      </div>
      <div class="cshell-body"><div class="cshell-say" hidden></div></div>`
    this.$ = (sel) => el.querySelector(sel)
    this.body = this.$('.cshell-body')
    const h = Number(store.get(H_KEY))
    this.height = Number.isFinite(h) && h >= H_MIN ? h : H_DEFAULT
    el.style.setProperty('--drawer-h', `${this.height}px`)
    this._wire()
  }

  /** Whether the drawer is open for thread `id` (the toggle's `aria-pressed`). */
  isOpen(id = this.thread?.id) {
    return Boolean(id && this.chats.get(id)?.open)
  }

  /** The chat now showing, or `null`: on every show and every roster. */
  set(thread) {
    const was = this.thread?.id
    this.thread = thread?.container ? thread : null
    if (this.thread && this.thread.id !== was) this._touch(this.thread.id)
    this._paint()
  }

  /** The tool row's button: open the drawer on this chat, or hide it. */
  toggle(thread) {
    if (!thread?.container) return
    this.thread = thread
    const c = this._touch(thread.id)
    c.open = !c.open
    c.error = ''
    this._paint({ focus: c.open })
    this.onChange()
  }

  /** A chat's entry, made if need be and moved to the most recent; the oldest past four disposed. */
  _touch(id) {
    let c = this.chats.get(id)
    if (c) this.chats.delete(id)
    else c = { screens: new Map(), current: '', open: false, listed: false, busy: false, stoppedAt: 0, error: '' }
    this.chats.set(id, c)
    for (const [old, entry] of this.chats) {
      if (this.chats.size <= KEEP_CHATS) break
      if (old === id) continue
      // Only the widgets go; the shells stay open on the server, and a re-show lists them again.
      for (const s of entry.screens.values()) s.dispose()
      this.chats.delete(old)
    }
    return c
  }

  _paint({ focus = false } = {}) {
    const t = this.thread
    const c = t ? this.chats.get(t.id) : null
    const open = Boolean(c?.open)
    this.el.hidden = !open
    // Server-said stopped while the roster says running: asked again after a pause.
    if (c?.stoppedAt && (!t.canSend || Date.now() - c.stoppedAt > STOPPED_RETRY_MS)) c.stoppedAt = 0
    const stopped = open && (!t.canSend || Boolean(c.stoppedAt))
    // Stopped, the drawer is its header row saying so: no body, no grip, and never the log's place.
    // Running again, it is back at its height.
    this.el.toggleAttribute('data-stopped', stopped)
    this.$('.cshell-grip').hidden = stopped
    this.body.hidden = stopped
    this.el.closest('.convo')?.classList.toggle('shell-full', open && this.expanded && !stopped)
    for (const entry of this.chats.values()) for (const s of entry.screens.values()) s.el.hidden = !(open && !stopped && entry === c && s.id === c.current)
    if (!open) return
    const say = this.$('.cshell-say')
    const why = stopped ? '' : c.error || (c.busy && !c.screens.size ? 'Opening a shell…' : '')
    say.textContent = why
    say.hidden = !why
    say.classList.toggle('err', Boolean(c.error))
    this._paintHead(t, c, stopped)
    const s = c.screens.get(c.current)
    if (s && !stopped)
      requestAnimationFrame(() => {
        s.fit()
        if (focus && !s.ended) s.term.focus()
      })
    // Nothing is listed or opened for a stopped container, nor for a drawer the stylesheet hides;
    // the roster's next `canSend` repaints this and it carries on.
    if (stopped || c.busy || c.error || window.matchMedia(NARROW).matches) return
    if (!c.listed) this._list(t, c, focus)
    else if (!c.screens.size) this._open(t, c, focus)
  }

  _paintHead(t, c, stopped) {
    const ids = [...c.screens.keys()]
    this.$('.cshell-tabs').innerHTML = ids
      .map((id, i) => {
        const s = c.screens.get(id)
        const on = id === c.current
        return `<span class="cshell-tab${on ? ' on' : ''}${s.ended ? ' ended' : ''}"><button type="button" role="tab" aria-selected="${on}" data-tab="${escape(id)}" title="${s.ended ? 'Ended' : `Shell ${i + 1}`}">${i + 1}</button>${
          on ? `<button type="button" class="x" data-end="${escape(id)}" title="End this shell" aria-label="End shell ${i + 1}">×</button>` : ''
        }</span>`
      })
      .join('')
    const live = [...c.screens.values()].filter((s) => !s.ended).length
    this.$('.cshell-add').hidden = stopped || live >= PER_CHAT
    this.$('.cshell-stopped').hidden = !stopped
    this.$('.cshell-where').hidden = stopped
    this.$('[data-cs=expand]').hidden = stopped
    const account = c.screens.get(c.current)?.account || this.account
    this.$('.cshell-where').textContent = ['podman exec', String(t.id).slice(0, 8), account].filter(Boolean).join(' · ')
    this.$('.cshell-where').title = `A shell in this chat's container, as ${account || 'you'} — it reaches what the chat reaches, nothing on the host`
    this.$('[data-cs=expand]').setAttribute('aria-pressed', String(this.expanded))
  }

  /** The chat's shells the server lists — opened before a reload, on another device, or disposed here. */
  async _list(t, c, focus) {
    c.busy = true
    try {
      const res = await fetchShells()
      this.account = res.account || this.account
      if (this.chats.get(t.id) !== c) return
      const mine = (res.shells || []).filter((s) => s.kind === 'container' && s.chat === t.id).sort((a, b) => a.openedAt - b.openedAt)
      for (const s of mine) this._attach(c, s)
      if (!c.current && mine.length) c.current = mine.at(-1).id
      c.listed = true
    } catch (err) {
      c.error = err.message || 'Could not list the shells'
    } finally {
      c.busy = false
    }
    if (this.thread?.id === t.id) this._paint({ focus })
  }

  /** A widget for a shell the server has, read from its offset 0 (`TermScreen` starts there). */
  _attach(c, shell) {
    if (c.screens.has(shell.id)) return
    const s = new TermScreen(this.body, shell, {
      background: '--code',
      onEnded: () => {
        if (this.thread && this.chats.get(this.thread.id) === c) this._paint()
      },
      onDrawn: () => {},
    })
    c.screens.set(shell.id, s)
  }

  async _open(t, c, focus = true) {
    c.busy = true
    this._paint()
    // Sized to the drawer before anything is drawn, so bash's first prompt is laid out right.
    const box = this.body.getBoundingClientRect()
    const cols = Math.max(20, Math.floor((box.width - 16) / 7.8))
    const rows = Math.max(4, Math.floor((box.height || H_DEFAULT) / 17))
    try {
      const res = await openChatShell(t, rows, cols)
      if (res.stopped) c.stoppedAt = Date.now()
      else if (res.ok === false) c.error = res.error || 'Could not open a shell'
      else if (this.chats.get(t.id) === c) {
        this._attach(c, res.shell)
        c.current = res.shell.id
      }
    } catch (err) {
      c.error = err.message || 'Could not open a shell'
    } finally {
      c.busy = false
    }
    if (this.thread?.id === t.id) this._paint({ focus })
  }

  /** × on a tab: ended on the server and its widget dropped. The last one closes the drawer. */
  async _end(c, id) {
    const s = c.screens.get(id)
    if (!s) return
    try {
      await closeShell(id)
    } catch (err) {
      if (!s.ended && !/No such terminal/.test(err.message || '')) this.onToast(err.message || 'Could not end it', 'err')
    }
    s.dispose()
    c.screens.delete(id)
    if (c.current === id) c.current = [...c.screens.keys()].at(-1) || ''
    if (!c.screens.size) {
      c.open = false
      this.onChange()
    }
    this._paint({ focus: true })
  }

  _setHeight(h) {
    // "The log's height" is the room the two share: the log as it would be with no drawer.
    const room = this.logEl.offsetHeight + this.el.offsetHeight
    this.height = Math.round(Math.max(H_MIN, Math.min(Math.max(H_MIN, room), h)))
    this.el.style.setProperty('--drawer-h', `${this.height}px`)
  }

  _setExpanded(on) {
    this.expanded = on
    this._paint()
  }

  _wire() {
    this.el.addEventListener('click', (e) => {
      const t = this.thread
      const c = t ? this.chats.get(t.id) : null
      if (!c) return
      const b = e.target.closest('button')
      if (!b) return
      if (b.dataset.tab) {
        c.current = b.dataset.tab
        this._paint({ focus: true })
      } else if (b.dataset.end) this._end(c, b.dataset.end)
      else if (b.dataset.cs === 'add') {
        c.error = ''
        if (!c.busy) this._open(t, c, true)
      } else if (b.dataset.cs === 'expand') this._setExpanded(!this.expanded)
      else if (b.dataset.cs === 'hide') {
        c.open = false
        this._paint()
        this.onChange()
      }
    })
    // The grips' pattern (shell.js): pointer capture, so the drag carries on off the handle.
    const grip = this.$('.cshell-grip')
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      grip.setPointerCapture(e.pointerId)
      this.el.classList.add('resizing')
      if (this.expanded) {
        this.height = this.el.offsetHeight
        this._setExpanded(false)
      }
    })
    grip.addEventListener('pointermove', (e) => {
      if (!grip.hasPointerCapture(e.pointerId)) return
      this._setHeight(this.el.getBoundingClientRect().bottom - e.clientY)
    })
    const end = (e) => {
      if (!grip.hasPointerCapture(e.pointerId)) return
      grip.releasePointerCapture(e.pointerId)
      this.el.classList.remove('resizing')
      store.set(H_KEY, String(this.height))
    }
    grip.addEventListener('pointerup', end)
    grip.addEventListener('pointercancel', end)
    grip.addEventListener('dblclick', () => {
      this._setHeight(H_DEFAULT)
      store.set(H_KEY, String(this.height))
    })
    grip.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 40 : 10
      if (e.key === 'ArrowUp') this._setHeight(this.height + step)
      else if (e.key === 'ArrowDown') this._setHeight(this.height - step)
      else return
      e.preventDefault()
      store.set(H_KEY, String(this.height))
    })
    // The drawer changes size with its grip, the window and the details column.
    new ResizeObserver(() => {
      const c = this.thread ? this.chats.get(this.thread.id) : null
      const s = c?.screens.get(c.current)
      if (s && !s.el.hidden) s.fit()
    }).observe(this.body)
  }
}
