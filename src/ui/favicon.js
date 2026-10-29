/**
 * The mark and the tab's icon.
 *
 * The mark is an O ring with a post through its top and a dot at its centre, on an accent
 * rounded square. Drawn inline, its colours come from the stylesheet (`.markart`), so it follows
 * a changed accent with nothing here re-run. public/icon.svg is the same drawing on the default
 * accent: an installed app's icon cannot follow the theme.
 *
 * The tab's icon carries state instead: ring and post alone, amber when a chat needs you, the
 * accent while one is working, grey otherwise, so a tab in the background says which. A data
 * URL cannot read a custom property, so the colour is read off the root when it is drawn.
 */

export const MARK =
  `<svg class="markart" viewBox="0 0 24 24" aria-hidden="true">` +
  `<rect class="sq" width="24" height="24" rx="6"/>` +
  `<circle class="fg" cx="12" cy="13.5" r="5.5" fill="none" stroke-width="2"/>` +
  `<path class="fg" d="M12 4v6" stroke-width="2" stroke-linecap="round"/>` +
  `<circle class="dot" cx="12" cy="13.5" r="1.6"/>` +
  `</svg>`

let last = ''
/** What the icon was last told: the chats' state from each roster, the update from each build check. */
const state = { needsYou: false, working: false, update: false }

/** Point the tab's icon at the state of every chat shown: needs you, else working, else at rest. */
export function setFavicon({ needsYou = false, working = false } = {}) {
  state.needsYou = needsYou
  state.working = working
  draw()
}

/**
 * A newer page is on the server: a dot at the icon's top right, beside the post. The footer's
 * version line says it too, but a background tab, or a phone on an open chat, shows only this.
 */
export function setFaviconUpdate(update) {
  state.update = update
  draw()
}

function draw() {
  const link = document.querySelector('link[rel="icon"]')
  if (!link) return
  const css = getComputedStyle(document.documentElement)
  const token = state.needsYou ? '--orange' : state.working ? '--accent' : '--grey'
  const colour = css.getPropertyValue(token).trim() || 'currentColor'
  const dot = state.update ? `<circle cx="26" cy="6" r="5" fill="${css.getPropertyValue('--accent').trim() || 'currentColor'}"/>` : ''
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<circle cx="16" cy="18.5" r="9" fill="none" stroke="${colour}" stroke-width="3.5"/>` +
    `<path d="M16 3v12" stroke="${colour}" stroke-width="3.5" stroke-linecap="round"/>` +
    dot +
    `</svg>`
  const href = `data:image/svg+xml,${encodeURIComponent(svg)}`
  // Every roster calls this; the browser refetches an icon on each assignment, so only a change is made.
  if (href === last) return
  last = href
  link.href = href
}
