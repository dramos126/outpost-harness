/**
 * One terminal's screen: the xterm widget, the keystrokes it sends, and the output it reads
 * (ui.md). Apart from TerminalView (terminal.js) because a second place draws the same screen.
 *
 * Its output is read from the server by offset, so a phone that drops the connection carries
 * on from where it was rather than from the start.
 */
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { shellInput, shellResize, streamShell } from '../api.js'

/**
 * The keys a phone's keyboard does not have, as the bytes a terminal sends for them. Ctrl-C
 * above all: without it nothing started on a phone can be stopped.
 */
export const KEYS = [
  // Enter first: with the phone's keyboard down there was no way to send one (the owner,
  // at a password prompt, 2026-10-04).
  ['⏎', '\r'],
  // Up and down walk the shell's history. Esc, Ctrl-D and left/right went unused (2026-10-07).
  ['↑', '\x1b[A'],
  ['↓', '\x1b[B'],
  ['Tab', '\t'],
  ['Ctrl-C', '\x03'],
]

/**
 * The last line the terminal printed before our own "[ended …]" note — "su: Authentication
 * failure" after a wrong password — so the view that covers the output still says why.
 */
export function lastLine(term) {
  const buf = term.buffer.active
  for (let y = buf.length - 1; y >= 0; y--) {
    const text = buf.getLine(y)?.translateToString(true).trim() || ''
    if (text && !/^\[(ended|this terminal is gone)/.test(text)) return text
  }
  return ''
}

/** `su` is what logs the terminal in, so its errors arrive as "su: …"; said plainly here. */
export function reason(line) {
  if (/^su: Authentication failure/i.test(line)) return 'Wrong password'
  return line.replace(/^su: /, '')
}

export class TermScreen {
  /**
   * A widget for `shell` (`{ id, account, ended }` as the server lists it), appended to
   * `parent` hidden, and reading at once. `onEnded(screen)` when it ends or is gone from the
   * server; `onDrawn(screen)` once xterm has drawn what it was given. `background` names the
   * colour token the screen is drawn on: `--bg` for the host terminal, the sunken `--code` for
   * a chat's container shell, so the two never look alike (ui-conversation.md).
   */
  constructor(parent, shell, { onEnded, onDrawn, background = '--bg' }) {
    this.onEnded = onEnded
    this.onDrawn = onDrawn
    const el = document.createElement('div')
    el.className = 'term-screen'
    el.hidden = true
    parent.appendChild(el)
    const css = getComputedStyle(document.documentElement)
    const bg = css.getPropertyValue(background).trim() || '#000'
    // A token with alpha (`--code` is a tint, not a colour) is drawn by the element under a
    // transparent xterm, so it lies on the page's own background as it does everywhere else.
    const tint = /^rgba|^hsla|transparent|^#[0-9a-f]{8}$/i.test(bg) || /\/\s*[\d.]+%?\s*\)$/.test(bg)
    if (tint) el.style.background = `var(${background})`
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: css.getPropertyValue('--mono').trim() || 'monospace',
      fontSize: window.matchMedia('(max-width: 760px)').matches ? 12 : 13,
      scrollback: 5000,
      allowTransparency: tint,
      theme: { background: tint ? 'rgba(0, 0, 0, 0)' : bg, foreground: css.getPropertyValue('--text').trim() || '#ddd' },
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(el)
    this.id = shell.id
    this.account = shell.account
    this.el = el
    this.term = term
    this.fitAddon = fitAddon
    this.at = 0
    this.ended = Boolean(shell.ended)
    this.abort = null
    this.sizeTimer = 0
    this.disposed = false
    // Keystrokes in order: each waits for the one before, so a fast typist's letters are not
    // reordered by two requests racing.
    let queue = Promise.resolve()
    term.onData((data) => {
      if (this.ended) return
      queue = queue.then(() => shellInput(this.id, data).catch(() => {}))
    })
    term.onResize(({ rows, cols }) => {
      clearTimeout(this.sizeTimer)
      this.sizeTimer = setTimeout(() => shellResize(this.id, rows, cols).catch(() => {}), 150)
    })
    this._read()
  }

  /** Read until it ends; a dropped connection is picked up again from the last offset. */
  async _read() {
    while (!this.ended && !this.disposed) {
      this.abort = new AbortController()
      try {
        await streamShell(this.id, this.at, {
          signal: this.abort.signal,
          onData: (bytes, at) => {
            this.term.write(bytes, () => this.onDrawn(this))
            this.at = at
          },
          onExit: (code) => {
            this.ended = true
            this.term.write(`\r\n\x1b[2m[ended${code !== '' ? `, exit ${code}` : ''}]\x1b[0m\r\n`, () => this.onDrawn(this))
            this.onEnded(this)
          },
        })
      } catch (err) {
        if (this.abort.signal.aborted) return
        // Gone from the server — closed elsewhere, or Outpost restarted under it.
        if (/No such terminal/.test(err.message || '')) {
          this.ended = true
          this.term.write('\r\n\x1b[2m[this terminal is gone — Outpost may have restarted]\x1b[0m\r\n')
          this.onEnded(this)
          return
        }
      }
      if (!this.ended) await new Promise((r) => setTimeout(r, 1500))
    }
  }

  fit() {
    try {
      this.fitAddon.fit()
    } catch {
      /* not laid out yet */
    }
  }

  /** Stop reading and remove the widget. */
  dispose() {
    this.disposed = true
    this.abort?.abort()
    this.term.dispose()
    this.el.remove()
  }
}
