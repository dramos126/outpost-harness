/**
 * The host shell, Settings › Terminal (server/shell/index.mjs; ui.md).
 *
 * One at a time, and only while its page shows: leaving the page closes it (`closeAll`). It
 * was a row in the chat list beside the chats until 2026-10-15, but it is the machine's, not a
 * chat's, and the owner wanted it out of the list. It first asks which account to log in as,
 * filled in with the one Outpost runs as; the machine then asks that account's password in the
 * terminal itself. The widget itself is a TermScreen (term-screen.js).
 */
import { closeShell, openShell, shellInput } from '../api.js'
import { KEYS, TermScreen, lastLine, reason } from './term-screen.js'

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export class TerminalView {
  constructor(parent, { onToast }) {
    this.onToast = onToast
    this.el = document.createElement('section')
    this.el.className = 'term-view'
    this.el.hidden = true
    this.el.innerHTML = `
      <header class="term-head" hidden>
        <h2 class="term-title"></h2>
        <button class="btn sm ghost danger" data-term="close">Terminate</button>
      </header>
      <form class="term-open">
        <p class="why">A shell on <b class="term-host"></b>. The machine asks for the account's own password next — Outpost never sees it.</p>
        <div class="row"><label class="sub"><span>Log in as</span><input class="input" name="account" autocomplete="username" autocapitalize="off" spellcheck="false" required /></label><button class="btn primary" type="submit">Open</button></div>
        <div class="state term-say" data-state="off"></div>
      </form>
      <div class="term-screens"><div class="term-ended" hidden><h3>This terminal has ended</h3><p class="reason"></p><div class="row"><button class="btn ghost" type="button" data-term="close">Close</button><button class="btn primary" type="button" data-term="again">Open again</button></div></div></div>
      <form class="term-paste" hidden>
        <textarea class="input mono" name="paste" rows="2" placeholder="Long-press here, Paste, then Send" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>
        <div class="row"><button class="btn primary sm" type="submit">Send</button><button class="btn ghost sm" type="button" data-term="paste-cancel">Cancel</button></div>
      </form>
      <div class="term-keys" hidden><button class="btn sm" type="button" data-term="keyboard" title="Show the keyboard">Keyboard</button><button class="btn sm" type="button" data-term="paste">Paste</button>${KEYS.map(([label], i) => `<button class="btn sm" type="button" data-key="${i}">${escape(label)}</button>`).join('')}</div>`
    parent.appendChild(this.el)
    this.$ = (sel) => this.el.querySelector(sel)
    this.screens = new Map()
    this.current = ''
    this._wire()
  }

  /** The account to fill in and the machine's name, from `GET /api/shells`. */
  setDefaults({ account, host }) {
    this.$('input[name=account]').value ||= account || ''
    this.$('.term-host').textContent = host || 'this machine'
    this.host = host || ''
  }

  /** Show a terminal by id, or the "Log in as" form with none. */
  show(id = '') {
    this.el.hidden = false
    this.current = id
    for (const [sid, s] of this.screens) s.el.hidden = sid !== id
    const s = id ? this.screens.get(id) : null
    this.$('.term-open').hidden = Boolean(id)
    // An ended terminal takes no keys; it offers to start over instead.
    this.$('.term-keys').hidden = !s || s.ended
    this.$('.term-ended').hidden = !s?.ended
    this._paintReason(s)
    // The header's Terminate, under the page's own title; an ended one has Close in its card instead.
    this.$('.term-head').hidden = !s || s.ended
    this.$('.term-title').textContent = s ? `${s.account}@${this.host || 'host'}` : ''
    if (s) {
      requestAnimationFrame(() => {
        s.fit()
        // An ended one takes no typing; its focus would only hold the phone's keyboard up.
        if (s.ended) s.term.blur()
        else s.term.focus()
      })
    } else {
      this.$('input[name=account]').focus()
    }
  }

  /**
   * The page left: every terminal closed on the server and its widget dropped. `keepalive` for
   * the tab closing, so the request outlives the page.
   */
  closeAll({ keepalive = false } = {}) {
    this.el.hidden = true
    this.current = ''
    for (const [id, s] of this.screens) {
      // Ended ones too: the server lists an ended terminal for minutes unless told.
      closeShell(id, keepalive).catch(() => {})
      s.dispose()
    }
    this.screens.clear()
  }

  /** No terminal to be had (Outpost has no password of its own): the reason, and no Open. */
  refuse(why) {
    const say = this.$('.term-say')
    say.dataset.state = why ? 'err' : 'off'
    say.textContent = why
    this.$('.term-open button[type=submit]').disabled = Boolean(why)
  }

  /** Make sure a terminal the server lists has a widget and is reading — one opened on another device, or before a reload. */
  attach(shell) {
    if (this.screens.has(shell.id)) return this.screens.get(shell.id)
    const s = new TermScreen(this.$('.term-screens'), shell, {
      onEnded: (s) => {
        if (this.current === s.id && !this.el.hidden) this.show(s.id)
      },
      onDrawn: (s) => this._paintReason(s),
    })
    this.screens.set(shell.id, s)
    return s
  }

  /**
   * The ended view's reason, read from the screen once xterm has drawn what it was given: its
   * writes land later, and read at once the line was not there yet — empty on a phone.
   */
  _paintReason(s) {
    if (!s || this.current !== s.id) return
    const why = s.ended ? reason(lastLine(s.term)) : ''
    this.$('.term-ended .reason').textContent = why
    // It goes straight back to the password prompt, not to "Log in as": after a wrong
    // password that is a retry, and "Open again" read as starting over.
    this.$('[data-term=again]').textContent = why === 'Wrong password' ? 'Try again' : `Open again as ${s.account}`
  }

  /** Drop widgets for terminals the server no longer lists. */
  prune(ids) {
    for (const [id, s] of this.screens) {
      if (ids.has(id)) continue
      s.dispose()
      this.screens.delete(id)
    }
  }

  /**
   * Close a terminal on the server and drop its widget. Ended ones too: the server keeps an
   * ended terminal listed for minutes unless told, and the next refresh put it back.
   */
  async _drop(s) {
    try {
      await closeShell(s.id)
    } catch (err) {
      if (!s.ended && !/No such terminal/.test(err.message || '')) this.onToast(err.message || 'Could not terminate it', 'err')
    }
    s.ended = true
    this.prune(new Set([...this.screens.keys()].filter((id) => id !== s.id)))
  }

  _wire() {
    this.$('.term-open').addEventListener('submit', async (e) => {
      e.preventDefault()
      const say = this.$('.term-say')
      // Sized to the panel before anything is drawn, so the first prompt is laid out right.
      const box = this.$('.term-screens').getBoundingClientRect()
      const cols = Math.max(20, Math.floor((box.width - 16) / 7.8))
      const rows = Math.max(8, Math.floor((box.height || 400) / 17))
      try {
        const res = await openShell(this.$('input[name=account]').value, rows, cols)
        this.attach(res.shell)
        say.textContent = ''
        this.show(res.shell.id)
      } catch (err) {
        say.dataset.state = 'err'
        say.textContent = err.message || 'Could not open a terminal'
      }
    })
    // What was pasted into the box goes to the terminal as a paste — xterm marks it as one, so
    // a shell that knows bracketed paste does not run each line as it arrives.
    this.$('.term-paste').addEventListener('submit', (e) => {
      e.preventDefault()
      const form = e.currentTarget
      const s = this.screens.get(this.current)
      const text = form.elements.paste.value
      form.hidden = true
      if (s && !s.ended && text) {
        s.term.paste(text)
        s.term.focus()
      }
    })
    // A tap on a key would take focus from the terminal and drop a raised keyboard.
    this.$('.term-keys').addEventListener('pointerdown', (e) => e.preventDefault())
    this.el.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-term], button[data-key]')
      if (!b) return
      const s = this.screens.get(this.current)
      if (b.dataset.key !== undefined) {
        // No focus here: each key raised the phone's keyboard, which then hid the keys. The
        // keyboard stays as it was, because the row's pointerdown keeps focus where it is.
        if (s && !s.ended) shellInput(s.id, KEYS[Number(b.dataset.key)][1]).catch(() => {})
        return
      }
      // A phone raises its keyboard only for a focus inside a tap, never one made later, so
      // this button is the sure way to it.
      if (b.dataset.term === 'keyboard') s?.term.focus()
      else if (b.dataset.term === 'paste') {
        if (!s || s.ended) return
        // The clipboard straight in where the browser allows it — https, or localhost. On
        // plain http over the LAN, which is how Outpost is reached, it does not: a box to
        // paste into by hand instead, sent with Send.
        try {
          const text = await navigator.clipboard.readText()
          if (text) {
            s.term.paste(text)
            return
          }
        } catch {
          /* not allowed here: the box below */
        }
        const form = this.$('.term-paste')
        form.hidden = false
        form.elements.paste.value = ''
        form.elements.paste.focus()
      } else if (b.dataset.term === 'paste-cancel') this.$('.term-paste').hidden = true
      else if (b.dataset.term === 'again' && s) {
        // The same account through the open form, in place of the one that ended.
        await this._drop(s)
        this.$('input[name=account]').value = s.account
        // The form shown, so a refusal to open has somewhere to be read.
        this.show('')
        this.$('.term-open').requestSubmit()
      }
      else if (b.dataset.term === 'close' && s) {
        await this._drop(s)
        this.show('')
      }
    })
    // The panel changes size with the window, the sidebar, and a phone turned sideways.
    new ResizeObserver(() => {
      const s = this.screens.get(this.current)
      if (s && !this.el.hidden) s.fit()
    }).observe(this.$('.term-screens'))
  }
}
