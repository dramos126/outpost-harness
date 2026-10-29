/**
 * One "back to the bottom" button for every scrolling box on the page — the log, Activity, a
 * setup log, an agent's conversation, the handoff text. Scroll events do not bubble but they
 * are captured, so one listener on the document hears them all and the last box scrolled is
 * the one the button serves. A per-box button would have to be added to each panel and would
 * be forgotten on the next one.
 *
 * The button is fixed to the page and placed over the box's bottom-right corner each time it
 * is checked, rather than living inside the box: the log is rebuilt by `innerHTML`, which
 * would take a child button with it.
 */

/** Far means more than most of a screenful of the box itself, and never a few lines. */
const FAR_MIN_PX = 240
const FAR_SHARE = 0.75
const INSET_PX = 14
/** While shown, the box can vanish or be covered without scrolling (a change of chat, a modal). */
const RECHECK_MS = 400

export function wireScrollFoot(doc = document) {
  const btn = doc.createElement('button')
  btn.type = 'button'
  btn.className = 'scrollfoot'
  btn.title = 'Scroll to the bottom'
  btn.setAttribute('aria-label', 'Scroll to the bottom')
  btn.textContent = '↓'
  btn.hidden = true
  doc.body.append(btn)

  let box = null
  let timer = 0
  let frame = 0
  // A smooth scroll down passes through "far" on its way and would bring the button back.
  let quietUntil = 0

  const hide = () => {
    btn.hidden = true
    clearInterval(timer)
    timer = 0
  }

  const check = () => {
    frame = 0
    if (!box || !box.isConnected || Date.now() < quietUntil) return hide()
    const gap = box.scrollHeight - box.scrollTop - box.clientHeight
    const r = box.getBoundingClientRect()
    if (gap <= Math.max(FAR_MIN_PX, box.clientHeight * FAR_SHARE) || !r.width || !r.height) return hide()
    // Only while the box is what you see there: a modal over it, or a panel slid away on a
    // phone, would otherwise leave the button floating over something else.
    const hit = doc.elementFromPoint(r.right - INSET_PX - 30, r.bottom - INSET_PX - 30)
    if (!hit || (hit !== btn && !box.contains(hit))) return hide()
    btn.style.right = `${Math.max(0, innerWidth - r.right) + INSET_PX}px`
    btn.style.bottom = `${Math.max(0, innerHeight - r.bottom) + INSET_PX}px`
    btn.hidden = false
    if (!timer) timer = setInterval(check, RECHECK_MS)
  }
  const soon = () => {
    if (!frame) frame = requestAnimationFrame(check)
  }

  doc.addEventListener(
    'scroll',
    (e) => {
      const el = e.target === doc ? doc.scrollingElement : e.target
      // Form fields scroll too, but the composer jumping to its end under the caret is not
      // what the button is for.
      if (!el || el.matches('textarea, input') || el.scrollHeight <= el.clientHeight) return
      box = el
      soon()
    },
    { capture: true, passive: true },
  )
  addEventListener('resize', soon, { passive: true })

  btn.addEventListener('click', () => {
    if (box) box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' })
    quietUntil = Date.now() + 1000
    hide()
  })
}
