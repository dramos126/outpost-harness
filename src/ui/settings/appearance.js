/**
 * Settings → Appearance: the look, `{ preset, accent, font, mono }`, saved on the server and
 * cached in this browser so it is applied on boot before the first roster. The group picks a
 * preset, an accent and two families, shows them on a preview built from the page's own
 * classes, and saves each change as it is made.
 */
import { saveAppearance } from '../../api.js'
import { MARK } from '../favicon.js'
import { statusMark } from '../marks.js'

const KEY = 'outpost.appearance'
/** The cache before the look moved to the server: `dark`, `light` or `system`. Read once, as a fallback. */
const LEGACY_KEY = 'outpost.theme'
const PRESETS = ['graphite', 'paper', 'midnight', 'ember', 'system']
/** The presets whose tokens are a light scheme; every other one is dark. */
const LIGHT = new Set(['paper'])
const DEFAULTS = Object.freeze({ preset: 'graphite', accent: '', font: 'system', mono: 'system', width: 'wide' })
/**
 * Reading width: what `--measure`, the log's column cap, is set to. `wide` is the stylesheet's
 * own value, so it clears the inline one; `full` is the pane, as a percentage of the grid.
 */
const WIDTHS = Object.freeze({ comfortable: '760px', wide: '', full: '100%' })
const LIGHT_QUERY = '(prefers-color-scheme: light)'

/**
 * The server's `normaliseAppearance` (config.mjs) again, for a cache this page cannot trust:
 * the accent and the families go into CSS custom properties, so anything wider is refused.
 */
function normalise(raw) {
  const s = (v) => (typeof v === 'string' ? v.trim() : '')
  const family = (v) => (/^[A-Za-z0-9][A-Za-z0-9 _-]{0,59}$/.test(s(v)) && s(v).toLowerCase() !== 'system' ? s(v) : 'system')
  return {
    preset: PRESETS.includes(s(raw?.preset)) ? s(raw.preset) : DEFAULTS.preset,
    accent: /^#[0-9a-f]{6}$/i.test(s(raw?.accent)) ? s(raw.accent).toLowerCase() : '',
    font: family(raw?.font),
    mono: family(raw?.mono),
    width: Object.hasOwn(WIDTHS, s(raw?.width)) ? s(raw.width) : DEFAULTS.width,
  }
}

/** The cached look; graphite unless somebody chose otherwise. */
export function readTheme() {
  try {
    const cached = localStorage.getItem(KEY)
    if (cached) return normalise(JSON.parse(cached))
    const legacy = localStorage.getItem(LEGACY_KEY)
    return { ...DEFAULTS, preset: legacy === 'light' ? 'paper' : legacy === 'system' ? 'system' : 'graphite' }
  } catch {
    return { ...DEFAULTS }
  }
}

/** `system` is graphite or paper by the device's setting, decided here so the light values live in one block. */
const resolvePreset = (preset) => (preset !== 'system' ? preset : matchMedia(LIGHT_QUERY).matches ? 'paper' : 'graphite')

/** Relative luminance of `#rrggbb` (WCAG). */
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * Text on a chosen accent: white, or a near-black when that reads better. Not `var(--bg)`:
 * on paper that is white too, and a pale accent would carry white text.
 */
function textOn(hex) {
  const l = luminance(hex)
  return 1.05 / (l + 0.05) >= (l + 0.05) / (luminance('#121214') + 0.05) ? '#ffffff' : '#121214'
}

let current = ''
let listening = false

export function applyTheme(appearance) {
  const look = normalise(appearance)
  current = JSON.stringify(look)
  const root = document.documentElement
  root.dataset.preset = resolvePreset(look.preset)
  if (look.accent) {
    root.style.setProperty('--accent', look.accent)
    root.style.setProperty('--accent-text', textOn(look.accent))
  } else {
    root.style.removeProperty('--accent')
    root.style.removeProperty('--accent-text')
  }
  if (look.font !== 'system') root.style.setProperty('--font', `'${look.font}', system-ui, sans-serif`)
  else root.style.removeProperty('--font')
  if (look.mono !== 'system') root.style.setProperty('--mono', `'${look.mono}', ui-monospace, monospace`)
  else root.style.removeProperty('--mono')
  if (WIDTHS[look.width]) root.style.setProperty('--measure', WIDTHS[look.width])
  else root.style.removeProperty('--measure')
  paintThemeColor()
  // Follow the device while the choice is `system`: one listener, checking the choice when it fires.
  if (!listening) {
    listening = true
    matchMedia(LIGHT_QUERY).addEventListener('change', () => {
      const now = readTheme()
      if (now.preset === 'system') applyTheme(now)
    })
  }
  try {
    localStorage.setItem(KEY, current)
  } catch {
    /* private window — the choice lasts for this page */
  }
}

/**
 * The browser's own bar takes the preset's sidebar colour, which is what meets it at the top of
 * the list. Empty before the stylesheet has loaded; the next apply (every roster) fills it.
 */
function paintThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]')
  const side = getComputedStyle(document.documentElement).getPropertyValue('--side').trim()
  if (meta && side) meta.setAttribute('content', side)
}

/** In flight: a roster read before the save landed would put the old look back for a tick. */
let saving = 0

/** The roster's `appearance`: applied when it differs from what this page shows. Null until one is saved. */
export function applyRosterAppearance(appearance) {
  if (!appearance || saving) {
    paintThemeColor()
    return false
  }
  if (JSON.stringify(normalise(appearance)) === current) {
    paintThemeColor()
    return false
  }
  applyTheme(appearance)
  return true
}

/** The four presets as cards, in the order a person meets them; `system` is the checkbox under them. */
const THEMES = [
  { id: 'graphite', name: 'Graphite', note: 'default' },
  { id: 'midnight', name: 'Midnight', note: '' },
  { id: 'ember', name: 'Ember', note: '' },
  { id: 'paper', name: 'Paper', note: 'light' },
]

/**
 * The accents offered. The one place a literal colour lives outside the stylesheet: these are
 * choices, not the page's look. None is amber or green, which mean needs-you and healthy.
 */
const SWATCHES = [
  { name: 'Teal', hex: '#14b8a6' },
  { name: 'Blue', hex: '#1a73e8' },
  { name: 'Violet', hex: '#8b7cf6' },
  { name: 'Orange', hex: '#e5703a' },
  { name: 'Rose', hex: '#e0547a' },
  { name: 'Lime', hex: '#9bbf2e' },
]

/**
 * Families a machine often has installed, as examples. Each is saved as its plain name and
 * `applyTheme` puts it in front of the system stack, so one the machine lacks falls back to
 * System. Nothing is fetched: a web font would be a request to somebody else on every load.
 */
const UI_FONTS = ['Inter', 'IBM Plex Sans', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Ubuntu', 'Noto Sans']
const MONO_FONTS = ['JetBrains Mono', 'IBM Plex Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', 'Menlo', 'Consolas', 'DejaVu Sans Mono']

/** WCAG's AA line for body text: the accent is drawn as link text and as a primary button's fill. */
const CONTRAST_MIN = 4.5

const options = (names) => ['<option value="system">System</option>', ...names.map((n) => `<option value="${n}">${n}</option>`)].join('')

/**
 * A preset drawn small: a sidebar and a pane in its own tokens, the accent as a short bar.
 * `data-preset` on the thumbnail is what colours it — the stylesheet's preset blocks match any
 * element carrying it, not only the root — so a preset's values live in one place.
 */
const thumb = (id) =>
  `<span class="ap-thumb" data-preset="${id}" aria-hidden="true">` +
  `<i class="ap-thumb-side"><b></b><b></b><b></b></i>` +
  `<i class="ap-thumb-pane"><b class="ap-thumb-accent"></b><b></b><b></b></i>` +
  `</span>`

/**
 * The live look in miniature, built from the page's own classes — the brand, the chat list's
 * Needs-you section and rows, the conversation's context bar and messages, the primary button, a workspace pill — so it cannot drift
 * from what it previews. No `data-preset` of its own: it inherits the root's, which is the point.
 * `inert`: nothing in it is a control.
 */
const PREVIEW = `
          <div class="ap-preview" inert aria-hidden="true">
            <div class="ap-pv-side">
              <div class="brand"><span class="logo">${MARK}</span><span class="word">outpost_</span></div>
              <div class="chats">
                <div class="sec needs">Needs you · 1</div>
                <div class="chat waiting needs"><span class="lead">${statusMark('waiting')}<i class="bg-mark"></i></span><div class="text"><div class="l1"><span class="t">Fix the login redirect</span><span class="trail"><span class="when">2m</span></span></div><div class="s"><span class="where"><span class="chip">outpost</span></span></div><div class="q">“Bash: git push origin fix-redirect”</div></div></div>
                <div class="sec">Today</div>
                <div class="chat working"><span class="lead">${statusMark('working')}<i class="bg-mark"></i></span><div class="text"><div class="l1"><span class="t">Disk headroom tile</span><span class="trail"><span class="w">Running Read</span><span class="sep">·</span><span class="when">5m</span></span></div><div class="s"><span class="where"><span class="chip">outpost</span><span class="chip more">+1</span></span></div></div></div>
                <div class="chat idle"><span class="lead">${statusMark('idle')}<i class="bg-mark"></i></span><div class="text"><div class="l1"><span class="t">Nightly backup notes</span><span class="trail"><span class="when">5h</span></span></div><div class="s"><span class="where"><span class="chip">ops</span></span></div></div></div>
              </div>
            </div>
            <div class="convo on ap-pv-pane">
              <div class="ctxbar"><span class="gauge"><span class="track"><i style="width: 19%"></i></span><span class="n">37k / 200k</span></span><button type="button" class="btn ghost">Compact</button></div>
              <div class="log">
                <div class="msg assistant"><div class="when">2:12 pm</div><div class="body"><p>The tests pass, and the redirect keeps the query string now.</p></div></div>
                <div class="msg user"><div class="when">you · 2:13 pm</div><div class="body">Commit it and open a pull request.</div></div>
                <div class="ap-pv-row"><button type="button" class="btn primary">Send</button><a>View the diff</a><span class="wspanel ap-pv-pill"><span class="pill" data-tone="ok">clean</span></span></div>
              </div>
            </div>
          </div>`

/** Settings › Appearance: theme, accent, fonts, a live preview, and Reset. */
export const html = `
        <section class="group halves" id="g-appearance">
          <h3>Appearance</h3>
          <div class="int-sub">
            <h4>Theme</h4>
            <div class="ap-themes" role="radiogroup" aria-label="Theme">${THEMES.map(
              (t) => `<button type="button" class="ap-theme" role="radio" aria-checked="false" data-theme-pick="${t.id}">${thumb(t.id)}<span class="ap-theme-name">${t.name}${t.note ? `<small> · ${t.note}</small>` : ''}</span></button>`
            ).join('')}</div>
            <label class="ap-follow"><input type="checkbox" /><span>Follow system light/dark <small>(Graphite ↔ Paper)</small></span></label>
          </div>
          <div class="int-sub">
            <h4>Accent</h4>
            <div class="ap-accent">
              <div class="ap-swatches" role="radiogroup" aria-label="Accent">${SWATCHES.map(
                (s) => `<button type="button" class="ap-swatch" role="radio" aria-checked="false" data-accent="${s.hex}" style="--swatch: ${s.hex}" title="${s.name} ${s.hex}" aria-label="${s.name}"></button>`
              ).join('')}</div>
              <span class="ap-divider" aria-hidden="true"></span>
              <label class="ap-custom"><span>Custom</span><input class="input mono ap-hex" maxlength="7" placeholder="#rrggbb" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="Custom accent, #rrggbb" /></label>
              <button type="button" class="btn ghost ap-default" aria-pressed="false" title="The theme's own accent">Default</button>
              <span class="ap-contrast" hidden></span>
            </div>
            <p class="why">Amber and green are not offered: amber means a chat needs you and green means healthy, in every theme.</p>
          </div>
          <div class="int-sub">
            <h4>Fonts</h4>
            <div class="row ap-fonts">
              <label class="sub"><span>UI</span><select class="select ap-font" data-family="font">${options(UI_FONTS)}</select></label>
              <label class="sub"><span>Mono</span><select class="select ap-font" data-family="mono">${options(MONO_FONTS)}</select></label>
            </div>
            <p class="why">A family this machine lacks falls back to System. Nothing is downloaded.</p>
          </div>
          <div class="int-sub">
            <h4>Reading width</h4>
            <div class="seg ap-width" role="radiogroup" aria-label="Reading width">
              <button type="button" role="radio" data-width="comfortable">Comfortable</button>
              <button type="button" role="radio" data-width="wide">Wide</button>
              <button type="button" role="radio" data-width="full">Full</button>
            </div>
            <p class="why">How wide the chat's column may grow on a wide window: 760 px, 960 px, or the whole pane. A phone always uses the screen.</p>
          </div>
          <div class="int-sub">
            <h4>Preview</h4>${PREVIEW}
          </div>
          <div class="row ap-reset"><button type="button" class="btn">Reset to default</button><span class="why">Graphite, its own accent, system fonts, wide.</span></div>
        </section>`

/** `#rrggbb` from what a person typed, `#` optional; '' when it is not one yet. */
function hexFrom(typed) {
  const t = String(typed || '').trim().toLowerCase()
  const h = t.startsWith('#') ? t : `#${t}`
  return /^#[0-9a-f]{6}$/.test(h) ? h : ''
}

/** WCAG contrast ratio of two `#rrggbb` colours; 0 when either is not one. */
function contrast(a, b) {
  if (!hexFrom(a) || !hexFrom(b)) return 0
  const [hi, lo] = [luminance(hexFrom(a)), luminance(hexFrom(b))].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** The preset last chosen by hand, so unticking Follow system goes back to it. */
let lastExplicit = ''
/** Saves in the order they were made: a hex typed fast must not land its middle value last. */
let queue = Promise.resolve()

export const methods = {
  _wireAppearance() {
    const g = this.$('#g-appearance')
    g.querySelector('.ap-themes').addEventListener('click', (e) => {
      const b = e.target.closest('[data-theme-pick]')
      if (b) this._saveAppearanceLook({ preset: b.dataset.themePick })
    })
    g.querySelector('.ap-follow input').addEventListener('change', (e) => {
      const on = /** @type {HTMLInputElement} */ (e.target).checked
      this._saveAppearanceLook({ preset: on ? 'system' : lastExplicit || resolvePreset('system') })
    })
    g.querySelector('.ap-swatches').addEventListener('click', (e) => {
      const b = e.target.closest('[data-accent]')
      if (b) this._saveAppearanceLook({ accent: b.dataset.accent })
    })
    const hex = g.querySelector('.ap-hex')
    // Applied the moment it is a colour; until then nothing changes, so typing is never a flash of nonsense.
    hex.addEventListener('input', () => {
      const h = hexFrom(hex.value)
      if (h && h !== readTheme().accent) this._saveAppearanceLook({ accent: h })
    })
    // Left half-typed, the field goes back to what is applied; emptied, it means the theme's own.
    hex.addEventListener('change', () => {
      if (!hex.value.trim()) this._saveAppearanceLook({ accent: '' })
      else if (!hexFrom(hex.value)) this.paintTheme()
    })
    g.querySelector('.ap-default').addEventListener('click', () => this._saveAppearanceLook({ accent: '' }))
    for (const sel of g.querySelectorAll('.ap-font')) {
      sel.addEventListener('change', () => this._saveAppearanceLook({ [sel.dataset.family]: sel.value }))
    }
    g.querySelector('.ap-width').addEventListener('click', (e) => {
      const b = e.target.closest('[data-width]')
      if (b) this._saveAppearanceLook({ width: b.dataset.width })
    })
    g.querySelector('.ap-reset .btn').addEventListener('click', () => this._saveAppearanceLook({ ...DEFAULTS }, true))
  },

  /**
   * One change to the look: applied at once, painted, then PUT. There is no Save button; a
   * refused save is a toast and the page keeps what it shows until the next roster says
   * otherwise. `whole` replaces the record (Reset) instead of changing one field of it.
   */
  _saveAppearanceLook(change, whole = false) {
    const look = whole ? { ...change } : { ...readTheme(), ...change }
    applyTheme(look)
    this.paintTheme()
    saving++
    queue = queue
      .then(() => saveAppearance(look))
      .catch((err) => this.onToast(`Appearance not saved: ${err.message}`, 'err'))
      .finally(() => saving--)
  },

  /** Paint the group from the applied look. main.js calls it when a roster changes the look. */
  paintTheme() {
    const g = this.$('#g-appearance')
    if (!g) return
    const look = readTheme()
    if (look.preset !== 'system') lastExplicit = look.preset
    // Following the device, the card checked is the one it resolved to: what is on screen.
    const shown = resolvePreset(look.preset)
    for (const b of g.querySelectorAll('[data-theme-pick]')) b.setAttribute('aria-checked', String(b.dataset.themePick === shown))
    // Named first: a line opening with `(` after the call above reads as calling its result.
    const follow = /** @type {HTMLInputElement} */ (g.querySelector('.ap-follow input'))
    follow.checked = look.preset === 'system'
    // A chosen accent is the accent in every preset, so each card shows it; none shows each preset's own.
    for (const t of g.querySelectorAll('.ap-thumb')) {
      const el = /** @type {HTMLElement} */ (t)
      if (look.accent) el.style.setProperty('--accent', look.accent)
      else el.style.removeProperty('--accent')
    }
    for (const b of g.querySelectorAll('[data-accent]')) b.setAttribute('aria-checked', String(b.dataset.accent === look.accent))
    g.querySelector('.ap-default').setAttribute('aria-pressed', String(!look.accent))
    const hex = /** @type {HTMLInputElement} */ (g.querySelector('.ap-hex'))
    if (document.activeElement !== hex) hex.value = look.accent
    for (const sel of g.querySelectorAll('.ap-font')) {
      const s = /** @type {HTMLSelectElement} */ (sel)
      const name = look[s.dataset.family || 'font']
      // A family saved elsewhere (another tab, an import) that is not among the examples is still shown.
      if (![...s.options].some((o) => o.value === name)) s.add(new Option(name, name))
      s.value = name
    }
    for (const b of g.querySelectorAll('[data-width]')) b.setAttribute('aria-checked', String(b.dataset.width === look.width))
    this.paintAppearanceContrast()
  },

  /**
   * The accent against the background it is drawn on, both read off the root after the apply,
   * so a preset's own accent and a custom one are judged the same way. Hidden when either is
   * not a plain hex (nothing to judge).
   */
  paintAppearanceContrast() {
    const pill = /** @type {HTMLElement} */ (this.$('#g-appearance .ap-contrast'))
    const css = getComputedStyle(document.documentElement)
    const ratio = contrast(css.getPropertyValue('--accent'), css.getPropertyValue('--bg'))
    pill.hidden = !ratio
    if (!ratio) return
    const ok = ratio >= CONTRAST_MIN
    const shown = Math.floor(ratio * 10) / 10
    pill.dataset.tone = ok ? 'ok' : 'warn'
    pill.textContent = ok ? `contrast ${shown}:1 ✓` : `contrast ${shown}:1 · low contrast`
    pill.title = `The accent on this theme's background. Links and buttons read well from ${CONTRAST_MIN}:1.`
  },
}
