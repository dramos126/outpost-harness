/**
 * The status marks: one glyph per state that differs in kind, in the status colours, in a
 * 12 px slot that is drawn empty when nothing is worth a mark so titles still line up. The
 * chat list, the routines list and the Routines tab's badge all draw from here, so a ? reads
 * the same wherever it is (ui.md *Status marks*).
 *
 * Working is the strip's spinner (`.spin`), a still dot under reduced motion; the other glyphs
 * are SVG on `currentColor`, coloured by the status class the slot carries.
 */

const svg = (body) => `<svg viewBox="0 0 12 12" aria-hidden="true">${body}</svg>`

export const GLYPH = {
  // A filled disc with the sign knocked out of it: legible at 12 px where an outline is not.
  ask: svg(
    '<circle cx="6" cy="6" r="6" fill="currentColor"/><path d="M4.4 4.6a1.6 1.6 0 1 1 2.3 1.4c-.5.3-.7.6-.7 1.1v.3" fill="none" stroke="var(--mark-ink)" stroke-width="1.3" stroke-linecap="round"/><circle cx="6" cy="9.2" r=".75" fill="var(--mark-ink)"/>'
  ),
  error: svg(
    '<circle cx="6" cy="6" r="6" fill="currentColor"/><path d="M6 3v3.6" stroke="var(--mark-ink)" stroke-width="1.4" stroke-linecap="round"/><circle cx="6" cy="8.9" r=".8" fill="var(--mark-ink)"/>'
  ),
  paused: svg('<rect x="2.5" y="2" width="2.6" height="8" rx="1" fill="currentColor"/><rect x="6.9" y="2" width="2.6" height="8" rx="1" fill="currentColor"/>'),
  check: svg('<path d="M2 6.4l2.6 2.6L10 3.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'),
}

/** The glyph a status earns, or '' for none: idle, dormant and asleep say nothing. */
export function markFor(status) {
  switch (status) {
    case 'working':
      return 'spin'
    case 'waiting':
      return 'ask'
    case 'blocked':
      return 'error'
    case 'stalled':
      return 'paused'
    // `done` is a finished turn not yet opened: opening the chat acks it back to idle (chats.md).
    case 'done':
      return 'check'
    default:
      return ''
  }
}

/**
 * The slot, as HTML: `<i class="mark <status>">` holding the spinner, a glyph or nothing.
 * `title` is the slot's hover, for a state the glyph alone does not say.
 */
export function statusMark(status, title = '') {
  const kind = markFor(status)
  const tip = title ? ` title="${String(title).replace(/"/g, '&quot;')}"` : ''
  const inner = kind === 'spin' ? '<span class="spin"></span><i class="dot"></i>' : kind ? GLYPH[kind] : ''
  return `<i class="mark ${status || 'idle'}${kind ? ` m-${kind}` : ''}"${tip}>${inner}</i>`
}
