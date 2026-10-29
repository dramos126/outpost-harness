/**
 * The Files section of the details column (ui-details.md): what the chat wrote or pointed you
 * at, and a viewer that draws one of them by its kind — Markdown rendered, JSON pretty, a CSV as
 * a table (each with Raw), HTML in a sandboxed frame of a ticketed document the server sends
 * (`fetchPreview`) and an SVG as a picture (each
 * with Source), code in the code view (`code-view.js`, loaded on first use and never in the
 * sheet), a picture or a PDF from its bytes as an object URL, and a card with Download for the
 * rest — with every version the session wrote, Copy, and Expand, which takes the whole pane for
 * a wide table or a long line.
 *
 * The list is the transcript's (harnesses.md `readFiles`), placed on disk by the server, so it
 * is still there after the chat's container is gone; what opens is the file on disk now, with
 * each earlier Write a version behind it. "For you" is what an answer named — a session's own
 * way of saying "read this" — and "Also written" the rest. A path clicked in a message lands
 * here too (`open`), whether or not it is in the list.
 *
 * "Browse" is a third group: a tree of what the chat's container sees — the workspace folder,
 * and its own /tmp while it runs — one folder asked for at a time (`/api/dir`). Its state is
 * kept apart from `files`, so the list's re-read never resets a tree someone is walking.
 */
import { fetchDir, fetchFile, fetchFileBytes, fetchFiles, fetchPreview, findFiles } from '../api.js'
import { copyString, renderMarkdown } from './markdown.js'
import { clearable, ICON } from './shell.js'
import { when } from './when.js'

/** How often the list is re-read while the section shows: a chat writes a report once a turn, not once a second. */
const FILES_EVERY_MS = 15000
/** The server's cap on one file (workspaces.md *Files*), named in the note under a cut file. */
const CUT_AT = '512 KB'
/** The most rows of a CSV or TSV drawn as a table; past it a line says so. */
const TABLE_ROWS = 2000
/** An SVG on disk is read as bytes for its picture; up to the text cap its text is kept for Source and Copy. */
const SVG_TEXT_MAX = 512 * 1024
/** The hosts a blocked-requests line names in its hover before "and N more". */
const BLOCKED_HOSTS = 5

/**
 * How a file is drawn, by its name: `markdown` (Rendered | Raw), `json` (Pretty | Raw), `table`
 * (a CSV or TSV: Table | Raw), `html` (Preview | Source), `image` and `pdf` (from their bytes;
 * an SVG with Preview | Source), else `text` — the code view, or the "no preview" card when the
 * server says it is not text (`binary`).
 */
const KINDS = [
  [/\.(md|markdown|mdx)$/i, 'markdown'],
  [/\.json$/i, 'json'],
  [/\.(csv|tsv)$/i, 'table'],
  [/\.(html?|xhtml)$/i, 'html'],
  [/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i, 'image'],
  [/\.pdf$/i, 'pdf'],
]
const kindOf = (path) => KINDS.find(([re]) => re.test(path))?.[1] || 'text'
const isSvg = (path) => /\.svg$/i.test(path)
/** Each view's segmented control: the drawn view (`rendered`), then the text (`raw`). */
const SEG = {
  markdown: ['Rendered', 'Raw'],
  json: ['Pretty', 'Raw'],
  table: ['Table', 'Raw'],
  html: ['Preview', 'Source'],
  svg: ['Preview', 'Source'],
}

/**
 * The code view (`code-view.js`, CodeMirror), loaded the first time a code file opens on a wide
 * screen and kept for the page's life. Never under 1100 px: there code is a plain `<pre>`.
 */
let codeView = null
let codeLoading = null

const sizeText = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n || 0} B`)

/**
 * A CSV or TSV's rows, quoted fields kept whole (a delimiter or line break inside quotes, `""`
 * for a quote). Stops after `max` rows, so a long file costs only what is drawn.
 */
export function parseDelimited(text, sep, max = Infinity) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length && rows.length < max; i++) {
    const c = text[i]
    if (quoted) {
      if (c !== '"') field += c
      else if (text[i + 1] === '"') {
        field += '"'
        i++
      } else quoted = false
    } else if (c === '"' && field === '') quoted = true
    else if (c === sep) {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if ((field || row.length) && rows.length < max) rows.push([...row, field])
  return rows
}

/** The filter box shows once the two lists hold more than this. */
const FILTER_FROM = 8
/** From this many characters the filter also searches the whole workspace (`/api/find`). */
const FIND_FROM = 2
const FIND_DEBOUNCE_MS = 250
/** The most expanded folders remembered per chat. */
const EXPANDED_MAX = 200
/** The sheet (ui.md): Browse and the workspace search are a wide screen's, so under it neither is built. */
const SHEET = '(max-width: 1099px)'

// Storage can throw (private window, blocked site data); the tree then just forgets.
/** Whether the expanded layer shows the list pane beside the viewer: `false` once hidden for wide content. */
const TREE_KEY = 'outpost.expandTree'
/** The layer's list pane width, dragged by its grip: 180 px up to half the layer, 220 by default. */
const TREE_W_KEY = 'outpost.expandTreeWidth'
const TREE_W_DEFAULT = 220
const TREE_W_MIN = 180

const store = {
  get(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || 'null')
    } catch {
      return null
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {}
  },
}


const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export class FilesPanel {
  /**
   * `root` is where the expanded layer goes (the app element); `onActive()` says Files mode was
   * entered or left (`active`); `onZoom(url)` opens an image in the conversation's own zoom
   * (ui-conversation.md).
   */
  constructor(el, root, { onToast, onActive, onZoom } = {}) {
    this.el = el
    this.root = root
    this.onToast = onToast || (() => {})
    this.onActive = onActive || (() => {})
    // Files mode, the one place it lives (ui-details.md): '' off; 'file' entered by opening a
    // file, so closing it leaves; 'list' entered deliberately (Browse unfolded, the heading, a
    // path link), so closing a file opened from there returns to the list at full height.
    this.mode = ''
    this.onZoom = onZoom || (() => {})
    // The open file's object URLs (its image or PDF, a download), revoked when it closes or another opens.
    this.blobs = []
    // The code views drawn in each container (the section's body, the expanded layer), destroyed before a repaint.
    this.views = new Map()
    this.thread = null
    this.files = null // the list, or null until read
    this.error = ''
    this.at = 0 // when the list was last asked for
    this.loading = false
    // What the viewer holds: { path, version, raw, loading, text, missing, truncated, error, modifiedAt, at }.
    this.file = null
    this.full = null // closes the expanded layer, while one is up
    this.fullEl = null
    // Browse: what is remembered per chat, and each folder read so far by key (`w:<path>` for
    // the workspace, `w:` its top; `t:<path>` for the container's /tmp).
    this.browse = { open: false, expanded: new Set(), ignored: false }
    this.dirs = new Map()
    this.query = ''
    this.found = null // the workspace search's answer: { q, loading, dir, paths, capped, error }
    this.findSeq = 0
    this.findTimer = 0
    // What the chat's session was on the last `set`: a change means another container, whose /tmp the tree has not read.
    this.dead = undefined
    this.sheet = typeof matchMedia === 'function' ? matchMedia(SHEET) : null
    // Crossing 1100 px re-reads the filter — the search stops in the sheet and starts again past
    // it — and repaints an open file, so code swaps between the `<pre>` and the code view (loaded
    // once, kept) and a PDF between its card and its frame.
    this.sheet?.addEventListener('change', () => {
      this.onFilter()
      this.paintView()
      // The layer is a wide screen's: the sheet already is the file over the chat.
      if (this.narrow) this.collapse()
    })
    // Two boxes: the list pane (the filter, the lists, Browse) and the viewer. On a wide screen in
    // Files mode they are side by side; in the sheet the viewer, while a file is open, is alone.
    // The filter sits outside the painted list, so a repaint never takes its focus or its text.
    this.el.innerHTML =
      `<div class="fside"><div class="ffilter" hidden><input type="search" class="input" placeholder="Filter files" aria-label="Filter files" autocomplete="off" spellcheck="false" /></div>` +
      `<div class="body"></div></div><div class="fmain" hidden></div>`
    this.filterEl = this.el.querySelector('.ffilter')
    this.filterInput = this.filterEl.querySelector('input')
    this.sideEl = this.el.querySelector('.fside')
    this.listEl = this.el.querySelector('.body')
    this.viewEl = this.el.querySelector('.fmain')
    this.el.addEventListener('click', (e) => this.onClick(e))
    this.el.addEventListener('change', (e) => this.onChange(e))
    this.filterInput.addEventListener('input', () => this.onFilter())
    clearable(this.filterInput)
    // The HTML preview's frames report what they refused (server/lib/preview.mjs), for the blocked line.
    window.addEventListener('message', (e) => this.onBlocked(e))
    this.paint()
  }

  /**
   * Whether Files is in its mode: the column's only content, at the reading width (ui-details.md).
   * In from `open`, Browse unfolded, or `activate`; out by `close` (when a file brought it in),
   * Browse folded, `deactivate`, or a change of chat.
   */
  get active() {
    return Boolean(this.mode)
  }

  /** Whether a file is open: the mode header's Expand is there only while one is. */
  get viewing() {
    return Boolean(this.file)
  }

  /** Enter Files mode deliberately: a path link in a message, or the Files heading unfolded. */
  activate(silent = false) {
    if (this.mode === 'list') return
    this.mode = 'list'
    if (!silent) this.onActive()
  }

  /** Leave Files mode (a section heading clicked): an open file is put away with it. */
  deactivate(silent = false) {
    if (!this.mode && !this.file) return
    this.mode = ''
    if (this.file) this.close(true)
    this.paint()
    if (!silent) this.onActive()
  }

  /** The thread the section is for; a change puts the open file away. `showing` says the body is painted. */
  set(thread, showing) {
    const changed = thread?.id !== this.thread?.id
    // Resume, after a reboot or a crash, starts another container: `structuredDead` is the roster's
    // field that flips with it (launchers.md), so its old /tmp answer — `absent` above all — goes.
    const dead = Boolean(thread?.structuredDead)
    const restarted = !changed && dead !== this.dead
    this.dead = dead
    this.thread = thread
    if (changed) {
      this.files = null
      this.error = ''
      this.at = 0
      if (this.file) this.close(true)
      this.mode = ''
      this.resetBrowse()
      this.paint()
    } else if (restarted && this.forgetTmp()) this.paintList()
    if (thread && showing && Date.now() - this.at > FILES_EVERY_MS) this.load()
  }

  async load() {
    const thread = this.thread
    if (!thread || this.loading) return
    this.loading = true
    this.at = Date.now()
    try {
      const r = await fetchFiles(thread)
      if (this.thread?.id !== thread.id) return
      this.files = r.files || []
      this.error = ''
    } catch (err) {
      if (this.thread?.id !== thread.id) return
      this.error = err.message || 'Could not read the files'
    } finally {
      this.loading = false
    }
    this.paintList()
  }

  entry(path) {
    return (this.files || []).find((f) => f.path === path) || null
  }

  /**
   * Open a file: from the list, or a path a message named. Its disk copy unless a `version`
   * (a Write's tool-use id) is asked for; one not on disk any more falls back to the newest
   * version the transcript holds. `root` `tmp` is a file in the container's own /tmp, which
   * has no versions.
   */
  async open(path, version = '', root = 'workspace') {
    const thread = this.thread
    if (!thread || !path) return
    const kind = kindOf(path)
    const raw = this.file?.path === path ? this.file.raw : false
    this.dropBlobs()
    this.file = { path, version, raw, root, kind, loading: true }
    if (!this.mode) this.mode = 'file'
    this.onActive()
    this.paint()
    const r = await this.read(thread, path, version, root, kind)
    if (this.thread?.id !== thread.id || this.file?.path !== path || this.file.version !== version || this.file.root !== root) {
      if (r.url) URL.revokeObjectURL(r.url)
      return
    }
    if (r.ok && r.missing && !version && root !== 'tmp') {
      const newest = this.entry(path)?.writes?.[0]?.id
      if (newest) return this.open(path, newest)
    }
    if (r.url) this.blobs.push(r.url)
    this.file = { ...this.file, ...r, abs: r.path || path, path, version, raw, root, kind, loading: false }
    this.paint()
  }

  /**
   * What the viewer draws, read for its kind. An image or a PDF on disk is its bytes, as an
   * object URL (`url`), an SVG's text read off the same bytes for Source; a version is the
   * Write's text, so an SVG version is made a blob here and any other picture's version is shown
   * as the text it is. JSON is parsed once, here.
   */
  async read(thread, path, version, root, kind) {
    try {
      if ((kind === 'image' || kind === 'pdf') && !version) {
        const r = await fetchFileBytes(thread, path, root)
        if (r.ok) {
          const text = isSvg(path) && r.blob.size <= SVG_TEXT_MAX ? await r.blob.text() : undefined
          return { ok: true, url: URL.createObjectURL(r.blob), size: r.blob.size, modifiedAt: r.modifiedAt, text }
        }
        return r.missing ? { ok: true, missing: true } : r.tooBig ? { ok: true, tooBig: true, size: r.size || 0 } : r
      }
      if (kind === 'html') {
        // The text for Source and Copy, and the preview's ticketed URL beside it: one mint per
        // open, so a repaint reuses `preview` and a new open (another version) mints again.
        const [r, p] = await Promise.all([
          fetchFile(thread, path, version, root),
          fetchPreview(thread, path, version, root).catch((err) => ({ ok: false, error: err.message || 'Could not preview it' })),
        ])
        return { ...r, preview: p.ok ? p.url : '', previewError: p.ok ? '' : p.error || 'Could not preview it' }
      }
      const r = await fetchFile(thread, path, version, root)
      if (r.ok && !r.missing && !r.binary && kind === 'image' && isSvg(path)) return { ...r, url: URL.createObjectURL(new Blob([r.text], { type: 'image/svg+xml' })) }
      if (r.ok && kind === 'json' && !r.binary && !r.missing) {
        try {
          return { ...r, pretty: JSON.stringify(JSON.parse(r.text), null, 2) }
        } catch {
          return { ...r, invalid: true }
        }
      }
      return r
    } catch (err) {
      return { ok: false, error: err.message || 'Could not read it' }
    }
  }

  /** Revoke the open file's object URLs: its picture, its PDF, a download. */
  dropBlobs() {
    for (const url of this.blobs) URL.revokeObjectURL(url)
    this.blobs = []
  }

  /**
   * Put the viewer away; the list comes back, and Files mode ends if the file brought it in.
   * `silent` when the caller is painting already.
   */
  close(silent = false) {
    this.collapse()
    this.dropBlobs()
    this.file = null
    if (this.mode === 'file') this.mode = ''
    if (silent) return
    this.onActive()
    this.paint()
  }

  /**
   * The Download link: the file's bytes fetched on demand under the larger cap, then an `<a
   * download>` to them, followed once here and left in place to tap — a click after an await
   * can be refused, a tap never is.
   */
  async download() {
    const f = this.file
    const thread = this.thread
    if (!f || !thread || f.downloading || f.downloadUrl) return
    f.downloading = true
    this.paintView()
    let r
    try {
      r = await fetchFileBytes(thread, f.path, f.root, true)
    } catch (err) {
      r = { ok: false, error: err.message || 'Could not download it' }
    }
    f.downloading = false
    if (this.file !== f) return
    if (!r.ok) {
      this.onToast(r.missing ? 'That file is not there now' : r.error || 'Could not download it', 'error')
    } else {
      f.downloadUrl = URL.createObjectURL(r.blob)
      this.blobs.push(f.downloadUrl)
    }
    this.paintView()
    if (f.downloadUrl) this.viewEl.querySelector('a[download]')?.click()
  }

  onClick(e) {
    const b = e.target.closest('[data-act]')
    if (!b || !this.el.contains(b) && !this.fullEl?.contains(b)) return
    const act = b.dataset.act
    if (act === 'open') this.open(b.dataset.path, b.dataset.version || '', b.dataset.root || 'workspace')
    else if (act === 'browse') this.toggleBrowse()
    else if (act === 'folder') this.toggleFolder(b.dataset.key)
    else if (act === 'close') this.close()
    else if (act === 'raw' || act === 'rendered') {
      if (!this.file) return
      this.file.raw = act === 'raw'
      this.paintView()
      } else if (act === 'copy') this.copy()
    else if (act === 'zoom') {
      if (this.file?.url) this.onZoom(this.file.url)
    } else if (act === 'download') this.download()
    else if (act === 'expand') this.expand()
    else if (act === 'collapse') this.collapse()
    else if (act === 'leave') this.deactivate()
    else if (act === 'tree') this.toggleTree()
  }

  onChange(e) {
    if (e.target.closest('input[data-ignored]')) {
      this.browse.ignored = e.target.checked
      this.saveBrowse()
      this.paintList()
      return
    }
    const s = e.target.closest('select[data-version]')
    if (s && this.file) this.open(this.file.path, s.value)
  }

  // ── Browse ──────────────────────────────────────────────────────────────────────────────

  get browseKey() {
    return `outpost.browse.${this.thread?.id || ''}`
  }

  /** A change of chat: its own remembered tree, nothing read yet, the filter emptied. */
  resetBrowse() {
    const saved = this.thread ? store.get(this.browseKey) : null
    this.browse = {
      open: Boolean(saved?.open),
      expanded: new Set(Array.isArray(saved?.expanded) ? saved.expanded.filter((k) => typeof k === 'string') : []),
      ignored: Boolean(saved?.ignored),
    }
    this.dirs = new Map()
    clearTimeout(this.findTimer)
    this.findSeq++
    this.found = null
    this.query = ''
    this.filterInput.value = ''
  }

  saveBrowse() {
    if (!this.thread) return
    const { open, expanded, ignored } = this.browse
    store.set(this.browseKey, { open, expanded: [...expanded].slice(-EXPANDED_MAX), ignored })
  }

  toggleBrowse() {
    this.browse.open = !this.browse.open
    // Reopened, it asks for the container's /tmp again: one may have started since.
    if (this.browse.open) this.forgetTmp()
    this.saveBrowse()
    // Unfolded, the tree wants the column's height: Files mode. Folded, the stacked view is back —
    // unless a file is open beside the list, which then holds the mode until it is closed.
    this.mode = this.browse.open ? 'list' : this.file ? 'file' : ''
    this.paintList()
    this.onActive()
  }

  /** Open a folder (read once, then kept), or close it — which forgets it and what is under it, so reopening reads it fresh. */
  toggleFolder(key) {
    if (!key) return
    const { expanded } = this.browse
    if (expanded.has(key)) {
      expanded.delete(key)
      for (const k of [...this.dirs.keys()]) if (k === key || k.startsWith(`${key}/`)) this.dirs.delete(k)
    } else expanded.add(key)
    this.saveBrowse()
    this.paintList()
  }

  /** Forget every folder of the container's /tmp, so the next paint asks again; whether there was any. */
  forgetTmp() {
    let any = false
    for (const k of [...this.dirs.keys()]) if (k.startsWith('t:')) any = this.dirs.delete(k) || any
    return any
  }

  /** Under 1100 px: no Browse, and the filter narrows the lists only. */
  get narrow() {
    return Boolean(this.sheet?.matches)
  }

  /** Ask for one folder unless it is asked already; the answer repaints. */
  need(key) {
    const thread = this.thread
    if (!thread || this.dirs.has(key)) return
    this.dirs.set(key, { loading: true })
    const root = key.startsWith('t:') ? 'tmp' : 'workspace'
    fetchDir(thread, root, key.slice(2))
      .catch((err) => ({ ok: false, error: err.message || 'Could not read it' }))
      .then((r) => {
        if (this.thread?.id !== thread.id || !this.dirs.has(key)) return
        // A folder under /tmp read from another container than the top was: the whole /tmp is stale.
        const top = this.dirs.get('t:/tmp')
        if (key.startsWith('t:') && key !== 't:/tmp' && top && !top.loading && (r.since || '') !== (top.since || '')) {
          this.forgetTmp()
          this.paintList()
          return
        }
        this.dirs.set(key, { ...r, loading: false })
        this.paintList()
      })
  }

  onFilter() {
    this.query = this.filterInput.value
    const q = this.query.trim()
    clearTimeout(this.findTimer)
    const seq = ++this.findSeq
    if (q.length < FIND_FROM || this.narrow) this.found = null
    else {
      if (this.found?.q !== q) this.found = { q, loading: true, paths: [] }
      const thread = this.thread
      this.findTimer = setTimeout(async () => {
        let r
        try {
          r = await findFiles(thread, q)
        } catch (err) {
          r = { ok: false, error: err.message || 'Could not search' }
        }
        // The newest answer wins: a slower one for an older query is dropped.
        if (seq !== this.findSeq || this.thread?.id !== thread?.id) return
        this.found = { ...r, q, loading: false }
        this.paintList()
      }, FIND_DEBOUNCE_MS)
    }
    this.paintList()
  }

  /** What the filter holds while it shows; a hidden box filters nothing. */
  get filterText() {
    return this.filterShown ? this.query.trim().toLowerCase() : ''
  }

  get filterShown() {
    return (this.files?.length || 0) > FILTER_FROM
  }

  /** Whether `path` under `root` is the open file, for its row's mark in the list and the tree. */
  isOpen(path, root = 'workspace') {
    const f = this.file
    return Boolean(f) && (f.root || 'workspace') === root && (f.abs === path || f.path === path)
  }

  browseHtml() {
    const q = this.filterText
    const searching = q.length >= FIND_FROM
    const open = this.browse.open || searching
    const head =
      `<div class="g-head bhead"><button type="button" class="btoggle" data-act="browse" aria-expanded="${open}"><span class="bchev" data-open="${open}" aria-hidden="true"></span>Browse</button>` +
      `<label class="bign"><input type="checkbox" data-ignored${this.browse.ignored ? ' checked' : ''} />show ignored</label></div>`
    const body = !open ? '' : searching ? this.foundHtml() : this.treeHtml()
    return `<section class="fgroup fbrowse">${head}${body}</section>`
  }

  /** The search's matches as flat rows, each its path from the workspace down. */
  foundHtml() {
    const f = this.found
    if (!f || f.loading) return `<div class="bnote">Searching…</div>`
    if (f.ok === false) return `<div class="bnote">${escape(f.error || 'Could not search')}</div>`
    if (!f.paths?.length) return `<div class="bnote">No file in the workspace matches.</div>`
    const rows = f.paths.map(
      (rel) =>
        `<button type="button" class="brow${this.isOpen(`${f.dir}/${rel}`) ? ' on" aria-current="true' : ''}" data-act="open" data-path="${escape(`${f.dir}/${rel}`)}" title="${escape(rel)}"><span class="bname">${escape(rel)}</span></button>`
    )
    return `<div class="btree">${rows.join('')}${f.capped ? `<div class="bnote">and more</div>` : ''}</div>`
  }

  treeHtml() {
    let html = this.levelHtml('w:', 0)
    this.need('t:/tmp')
    const tmp = this.dirs.get('t:/tmp')
    // The container's /tmp, only while it runs: an `absent` answer draws nothing at all.
    if (tmp && !tmp.loading && tmp.ok && !tmp.absent) {
      const open = this.browse.expanded.has('t:/tmp')
      html += this.folderRow('t:/tmp', '/tmp', 0, open, 'container · while running')
      if (open) html += this.levelHtml('t:/tmp', 1)
    }
    return `<div class="btree">${html}</div>`
  }

  /** One folder's entries at `depth`, each open folder's own entries under it. */
  levelHtml(key, depth) {
    this.need(key)
    const d = this.dirs.get(key)
    const note = (text) => `<div class="bnote" style="--depth:${depth}">${escape(text)}</div>`
    if (!d || d.loading) return note('Loading…')
    if (d.ok === false) return note(d.error || 'Could not read it')
    const tmp = key.startsWith('t:')
    const base = tmp ? key.slice(2) : d.path
    const rows = []
    for (const e of d.entries || []) {
      if (e.ignored && !this.browse.ignored) continue
      const path = `${base}/${e.name}`
      const ign = e.ignored ? ' ign' : ''
      if (e.kind === 'dir') {
        const k = `${tmp ? 't' : 'w'}:${path}`
        const open = this.browse.expanded.has(k)
        rows.push(this.folderRow(k, e.name, depth, open, !tmp && depth === 0 && e.name === 'home' ? 'container $HOME' : '', ign))
        if (open) rows.push(this.levelHtml(k, depth + 1))
      } else if (e.kind === 'file') {
        const on = this.isOpen(path, tmp ? 'tmp' : 'workspace') ? ' on" aria-current="true' : ''
        rows.push(
          `<button type="button" class="brow${ign}${on}" style="--depth:${depth}" data-act="open" data-path="${escape(path)}" data-root="${tmp ? 'tmp' : 'workspace'}" title="${escape(path)}">` +
            `<span class="bchev blank" aria-hidden="true"></span><span class="bname">${escape(e.name)}</span></button>`
        )
      } else {
        // A link or anything else is shown for what it is, and opens nothing: a link is never followed.
        rows.push(
          `<div class="brow muted${ign}" style="--depth:${depth}" title="${escape(e.kind === 'link' ? 'A link, not followed' : 'Not a file or a folder')}">` +
            `<span class="bchev blank" aria-hidden="true"></span><span class="bname">${escape(e.name)}</span><span class="bhint">${e.kind}</span></div>`
        )
      }
    }
    if (!rows.length) rows.push(note(d.entries?.length ? 'Only ignored files here' : 'Empty'))
    if (d.capped) rows.push(note('more not shown'))
    return rows.join('')
  }

  folderRow(key, name, depth, open, hint = '', cls = '') {
    return (
      `<button type="button" class="brow${cls}" style="--depth:${depth}" data-act="folder" data-key="${escape(key)}" aria-expanded="${open}">` +
      `<span class="bchev" data-open="${open}" aria-hidden="true"></span><span class="bname">${escape(name)}</span>` +
      `${hint ? `<span class="bhint">${escape(hint)}</span>` : ''}</button>`
    )
  }

  async copy() {
    try {
      await copyString(this.file?.text || '')
      this.onToast('Copied')
    } catch {
      this.onToast('Could not copy', 'error')
    }
  }

  /** Both boxes: the list (whose row for the open file is marked) and the viewer. */
  paint() {
    this.paintList()
    this.paintView()
  }

  paintList() {
    this.filterEl.hidden = !this.filterShown
    // The list is repainted every re-read; where it was scrolled to stays.
    const top = this.listEl.scrollTop
    this.listEl.innerHTML = this.listHtml()
    this.listEl.scrollTop = top
  }

  paintView() {
    this.el.toggleAttribute('data-viewing', Boolean(this.file))
    this.viewEl.hidden = !this.file
    const code = []
    this.fill(this.viewEl, this.file ? this.viewerHtml(code) : '', code)
  }

  /**
   * Put `html` in `box` and draw each code view it holds (`[data-code]`, the text in `code` by
   * index); the views drawn there before are destroyed first, since `innerHTML` only drops them.
   */
  fill(box, html, code) {
    for (const v of this.views.get(box) || []) v.destroy()
    box.innerHTML = html
    const views = []
    if (codeView) for (const el of box.querySelectorAll('[data-code]')) views.push(codeView.mountCode(el, code[+el.dataset.code].text, code[+el.dataset.code].lang))
    this.views.set(box, views)
  }

  /**
   * Text as code: the code view on a wide screen once its module is here, else a mono `<pre>` —
   * always under 1100 px, where the module is never asked for, and on a wide screen while it
   * loads (its arrival repaints). `lang` names the language for `languageOf`: the file's own
   * name, or `json` and `markdown` for a Pretty or Raw view.
   */
  codeHtml(text, lang, code) {
    if (this.narrow || !codeView) {
      if (!this.narrow) this.loadCode()
      return `<pre class="fraw">${escape(text)}</pre>`
    }
    code.push({ text, lang: codeView.languageOf(lang) })
    return `<div class="fcm" data-code="${code.length - 1}"></div>`
  }

  loadCode() {
    if (codeView || codeLoading) return
    codeLoading = import('./code-view.js')
      .then((m) => {
        codeView = m
        if (this.file && !this.narrow) {
          this.paintView()
              }
      })
      .catch(() => {
        // Not reached (offline, a new build since): the `<pre>` stays, and the next paint asks again.
        codeLoading = null
      })
  }

  listHtml() {
    return this.listsHtml() + (this.thread && !this.narrow ? this.browseHtml() : '')
  }

  /** "For you" and "Also written", narrowed by the filter to the files whose folder and name hold it. */
  listsHtml() {
    if (this.error) return `<div class="nothing">${escape(this.error)}</div>`
    if (!this.files) return `<div class="nothing">Loading…</div>`
    if (!this.files.length) return `<div class="nothing">Nothing written yet.</div>`
    const latest = (f) => Math.max(f.mentionedAt || 0, f.writes[0]?.at || 0, f.modifiedAt || 0)
    const q = this.filterText
    const shown = q ? this.files.filter((f) => `${this.shortDir(f.path)}${f.path.split('/').pop()}`.toLowerCase().includes(q)) : this.files
    if (!shown.length) return `<div class="nothing">No file in these lists matches.</div>`
    const sorted = [...shown].sort((a, b) => latest(b) - latest(a))
    const group = (title, list) =>
      list.length ? `<section class="fgroup"><div class="g-head">${title}</div>${list.map((f) => this.rowHtml(f)).join('')}</section>` : ''
    return group('For you', sorted.filter((f) => f.mentionedAt)) + group('Also written', sorted.filter((f) => !f.mentionedAt))
  }

  rowHtml(f) {
    const n = f.writes.length
    const at = f.onDisk ? f.modifiedAt : f.writes[0]?.at || f.mentionedAt
    const bits = [when(at)]
    if (n > 1) bits.push(`${n} versions`)
    if (!f.onDisk) bits.push(n ? 'not on disk now' : 'gone')
    const on = this.isOpen(f.path)
    return (
      `<button type="button" class="frow${f.onDisk ? '' : ' gone'}${on ? ' on' : ''}"${on ? ' aria-current="true"' : ''} data-act="open" data-path="${escape(f.path)}" data-version="${escape(f.onDisk ? '' : f.writes[0]?.id || '')}" title="${escape(f.path)}">` +
      `<span class="fname">${escape(f.path.split('/').pop())}</span><span class="fdir">${escape(this.shortDir(f.path))}</span>` +
      `<span class="fmeta">${escape(bits.join(' · '))}</span></button>`
    )
  }

  /** The folder as the chat would say it: from the workspace down, so `temp/` reads as `outpost/temp/`. */
  shortDir(p, root = 'workspace') {
    // A file in the container's /tmp is shown at its path in there; it has no workspace to start from.
    if (root === 'tmp') return `${p.slice(0, p.lastIndexOf('/'))}/`
    const i = p.indexOf('/workspaces/')
    const parts = (i >= 0 ? p.slice(i + '/workspaces/'.length).split('/').slice(1) : p.split('/')).slice(0, -1)
    return parts.length ? `${parts.join('/')}/` : ''
  }

  /**
   * The viewer, in the column or in the expanded layer alike. One header row for every kind — the
   * name over its folder, the version, Copy, and a way out: Back at the left in the sheet, a × at
   * the right on a wide screen (Expand is the mode header's, shell.js) — and the kind's segmented
   * control on the row under it, where it has one. `code` collects the text of each code view for
   * `fill`.
   */
  viewerHtml(code) {
    const f = this.file
    const tmp = f.root === 'tmp'
    // A file in the container's /tmp is never in the list and has no versions: the transcript's Writes are workspace paths.
    const entry = tmp ? null : this.entry(f.path)
    const writes = entry?.writes || []
    const onDisk = entry ? entry.onDisk : !f.missing && !f.version
    const options = []
    if (onDisk) options.push({ v: '', label: `${tmp ? 'In the container' : 'On disk'} · changed ${when(entry?.modifiedAt || f.modifiedAt || 0)}` })
    writes.forEach((w, i) => options.push({ v: w.id, label: `Written ${when(w.at)}${i === 0 && !onDisk ? ' · latest' : ''}` }))
    const versions =
      options.length > 1
        ? `<select class="fversion" data-version aria-label="Version">${options.map((o) => `<option value="${escape(o.v)}"${o.v === f.version ? ' selected' : ''}>${escape(o.label)}</option>`).join('')}</select>`
        : options[0]
          ? `<span class="fwhen">${escape(options[0].label)}</span>`
          : ''
    const head = this.narrow ? `<button type="button" class="btn icon sm" data-act="close" title="Back to the list" aria-label="Back">${ICON.back}</button>` : ''
    const shut = this.narrow ? '' : `<button type="button" class="btn icon sm" data-act="close" title="Close the file" aria-label="Close the file">${ICON.close}</button>`
    const view = this.viewOf(f)
    // Copy is the text's: a picture (an SVG aside), a PDF or a file with no preview has none to give.
    const copy = typeof f.text === 'string' && !f.loading && !f.binary && !f.missing ?`<button type="button" class="btn icon sm" data-act="copy" title="Copy the text" aria-label="Copy">${ICON.copy}</button>` : ''
    // The HTML preview's blocked line sits beside its control, filled in place as reports come (`paintBlocked`).
    const blocked = view === 'html' && !f.raw ? this.blockedHtml() : ''
    const seg = SEG[view]
      ? `<div class="ftools"><span class="seg" role="group" aria-label="View">` +
        `<button type="button" data-act="rendered" aria-checked="${!f.raw}">${SEG[view][0]}</button><button type="button" data-act="raw" aria-checked="${f.raw}">${SEG[view][1]}</button></span>${blocked}</div>`
      : ''
    return (
      `<div class="fview">` +
      `<div class="fhead">${head}<span class="fpath" title="${escape(f.path)}">${escape(f.path.split('/').pop())}<small>${escape(this.shortDir(f.path, f.root))}</small></span>${versions}${copy}${shut}</div>` +
      seg +
      this.contentHtml(code) +
      `</div>`
    )
  }

  /**
   * How the open file is drawn now: its kind, unless what came back says otherwise — `none` (the
   * card) for a file that is not text or too big to send, `text` for a picture or a PDF read as a
   * version's text, `svg` for an SVG drawn whose text is here too, `json` only while it parses.
   */
  viewOf(f) {
    if (f.loading || f.ok === false || f.missing) return ''
    if (f.binary || f.tooBig) return 'none'
    if (f.kind === 'image' && f.url && isSvg(f.path) && typeof f.text === 'string') return 'svg'
    if (f.kind === 'image' || f.kind === 'pdf') return f.url ? f.kind : 'text'
    if (f.kind === 'json' && f.invalid) return 'text'
    return f.kind
  }

  contentHtml(code) {
    const f = this.file
    if (f.loading) return `<div class="nothing">Loading…</div>`
    if (f.ok === false) return `<div class="nothing">${escape(f.error || 'Could not read it')}</div>`
    if (f.missing && f.root === 'tmp') return `<div class="nothing">Not in the container now; its /tmp goes with it.</div>`
    if (f.missing) return `<div class="nothing">Not on disk now${this.entry(f.path)?.writes?.length ? '' : ', and no version of it is in the transcript'}.</div>`
    const name = f.path.split('/').pop()
    const view = this.viewOf(f)
    if (view === 'none') return `<div class="fbody"><div class="fcard"><span>No preview · ${escape(sizeText(f.size))}</span>${this.downloadHtml()}</div></div>`
    if (view === 'image' || (view === 'svg' && !f.raw)) return `<div class="fbody"><button type="button" class="fpic" data-act="zoom" title="View full size"><img src="${escape(f.url)}" alt="${escape(name)}" /></button></div>`
    if (view === 'pdf') {
      // A frame on a wide screen; in the sheet a link to tap, since `window.open` after an await is
      // blocked on iOS and a phone's frame shows one page at best.
      if (!this.narrow) return `<div class="fbody fframe"><iframe class="fpdf" src="${escape(f.url)}" title="${escape(name)}"></iframe></div>`
      return `<div class="fbody"><div class="fcard"><span>PDF · ${escape(sizeText(f.size))}</span><a class="btn sm" href="${escape(f.url)}" target="_blank" rel="noopener">Open</a></div></div>`
    }
    const cut = f.truncated ? `<div class="fnote">Cut at ${CUT_AT}; the rest is on disk. ${this.downloadHtml()}</div>` : ''
    if (view === 'html' && !f.raw) {
      if (!f.preview) return `<div class="fbody"><div class="nothing">${escape(f.previewError || 'Could not preview it')}</div></div>`
      // The server's ticketed document in a frame of an opaque origin: `allow-scripts` alone —
      // no same origin, forms, popups or top navigation — under the policy its response sends.
      // Never `srcdoc` or a blob URL: either inherits the page's policy, and a blob has the
      // page's origin, the token with it (Hard rules).
      const frame = `<iframe class="fhtml" sandbox="allow-scripts" referrerpolicy="no-referrer" title="${escape(`Preview of ${name}`)}" src="${escape(f.preview)}"></iframe>`
      return `<div class="fbody fframe">${frame}${cut}</div>`
    }
    const views = code.length
    let body
    if (view === 'markdown') body = f.raw ? this.codeHtml(f.text, 'markdown', code) : `<div class="doc">${renderMarkdown(f.text)}</div>`
    else if (view === 'json') body = this.codeHtml(f.raw ? f.text : f.pretty, 'json', code)
    else if (view === 'table') body = f.raw ? this.codeHtml(f.text, '', code) : this.tableHtml(f.text, /\.tsv$/i.test(f.path) ? '\t' : ',')
    else body = (f.kind === 'json' && f.invalid && !f.truncated ? `<div class="fnote top">Not valid JSON.</div>` : '') + this.codeHtml(f.text, name, code)
    return `<div class="fbody${code.length > views ? ' fcode' : ''}">${body}${cut}</div>`
  }

  /** The Download control: a button until the bytes are here, then the link itself. */
  downloadHtml() {
    const f = this.file
    if (f.downloadUrl) return `<a class="btn sm" href="${escape(f.downloadUrl)}" download="${escape(f.path.split('/').pop())}">Download</a>`
    return `<button type="button" class="btn sm" data-act="download"${f.downloading ? ' disabled' : ''}>${f.downloading ? 'Fetching…' : 'Download'}</button>`
  }

  /**
   * A report from an HTML preview's frame (server/lib/preview.mjs `PREVIEW_LISTENER`). Taken only
   * from a frame this viewer drew — `source` is its window — and only `url` and `directive` are read.
   * Each frame keeps its own list and the line shows the longest, so a repaint, which loads the
   * file again and refuses the same requests, keeps the count rather than doubling it; a new
   * open (another file or version) starts from none.
   */
  onBlocked(e) {
    const d = e.data
    if (!d || typeof d !== 'object' || d.outpostPreview !== 'blocked' || !this.file || !e.source) return
    const boxes = [this.viewEl]
    if (!boxes.some((box) => [...box.querySelectorAll('iframe.fhtml')].some((el) => el.contentWindow === e.source))) return
    const url = String(d.url || '').slice(0, 400)
    // A refusal with a URL is a request that did not leave; `eval` and the like are not requests.
    // `directive` is the other field the contract carries; the line has no use for it yet.
    if (!/^[a-z][\w+.-]*:/i.test(url) && url !== 'data' && url !== 'blob') return
    const b = (this.file.blocked ||= { frames: new Map() })
    if (!b.frames.has(e.source)) b.frames.set(e.source, [])
    b.frames.get(e.source).push(url)
    this.paintBlocked()
  }

  /** The blocked line's text and hover: the requests refused, the hosts first. */
  blockedText() {
    const b = this.file?.blocked
    if (!b) return { text: '', title: '' }
    const urls = [...b.frames.values()].reduce((a, l) => (l.length > a.length ? l : a), [])
    const hosts = [...new Set(urls.map((u) => {
      try {
        return new URL(u).host || u
      } catch {
        return u
      }
    }))]
    if (!urls.length) return { text: '', title: '' }
    const more = hosts.length > BLOCKED_HOSTS ? ` and ${hosts.length - BLOCKED_HOSTS} more` : ''
    return {
      text: `Blocked ${urls.length} request${urls.length === 1 ? '' : 's'} to the network`,
      title: `Refused: ${hosts.slice(0, BLOCKED_HOSTS).join(', ')}${more}`,
    }
  }

  blockedHtml() {
    const { text, title } = this.blockedText()
    return `<span class="fblocked" title="${escape(title)}"${text ? '' : ' hidden'}>${escape(text)}</span>`
  }

  /** The blocked line updated where it is drawn: a repaint would load the frame, and the file, again. */
  paintBlocked() {
    const { text, title } = this.blockedText()
    for (const box of [this.viewEl]) {
      for (const el of box.querySelectorAll('.fblocked')) {
        el.textContent = text
        el.title = title
        el.hidden = !text
      }
    }
  }

  /** A CSV or TSV as a table: a sticky header row, mono cells, the first `TABLE_ROWS` rows. */
  tableHtml(text, sep) {
    const rows = parseDelimited(text, sep, TABLE_ROWS + 2)
    if (!rows.length) return `<div class="nothing">Empty.</div>`
    const [head, ...rest] = rows
    const shown = rest.slice(0, TABLE_ROWS)
    const cells = (row, tag) => row.map((c) => `<${tag}>${escape(c)}</${tag}>`).join('')
    return (
      `<table class="ftable"><thead><tr>${cells(head, 'th')}</tr></thead>` +
      `<tbody>${shown.map((r) => `<tr>${cells(r, 'td')}</tr>`).join('')}</tbody></table>` +
      (rest.length > TABLE_ROWS ? `<div class="fnote">Showing the first ${TABLE_ROWS} rows.</div>` : '')
    )
  }

  /**
   * Files mode over the chat column and the details column together, for a wide table or long
   * code: the mode header (its own `.fmode`, the shell's `.rmode` drawn again — the back link,
   * the Files chip, the list pane's toggle, Close) over the two panes, which are the column's
   * own boxes moved in while the layer is up and back after, so every paint of the list or the
   * viewer reaches it. A capturing Escape closes it and stops there, so the chat's own Escape —
   * back to the list — does not fire with it (the image zoom does the same, ui-conversation.md).
   */
  expand() {
    if (this.full || !this.file || this.narrow) return
    const layer = document.createElement('div')
    layer.className = 'fileview-full'
    layer.toggleAttribute('data-notree', store.get(TREE_KEY) === false)
    layer.innerHTML =
      `<div class="fmode"><button type="button" class="fmode-back" data-act="leave" title="Back to Workspace and Activity">← Workspace · Activity</button>` +
      `<span class="fmode-name">Files</span>` +
      `<button type="button" class="btn icon sm ghost" data-act="tree" aria-pressed="${!layer.hasAttribute('data-notree')}" title="Show or hide the list beside the file" aria-label="The list">${ICON.panel}</button>` +
      `<button type="button" class="btn icon sm ghost" data-act="collapse" title="Back to the column (Esc)" aria-label="Close">${ICON.close}</button></div>` +
      `<div class="fpanes"><div class="ftree-grip" role="separator" aria-orientation="vertical" aria-label="Resize the list" tabindex="0" title="Drag to resize; double-click to reset"></div></div>`
    layer.addEventListener('click', (e) => this.onClick(e))
    layer.addEventListener('change', (e) => this.onChange(e))
    const onKey = (e) => {
      // Escape in the code view's search closes the search, not the layer.
      if (e.key !== 'Escape' || e.target?.closest?.('.cm-panels')) return
      e.stopPropagation()
      this.collapse()
    }
    window.addEventListener('keydown', onKey, true)
    this.full = () => {
      this.movePanes(this.el)
      layer.remove()
      window.removeEventListener('keydown', onKey, true)
      this.full = null
      this.fullEl = null
    }
    this.fullEl = layer
    this.root.appendChild(layer)
    this.movePanes(layer.querySelector('.fpanes'))
    this.treeWidth = Number(store.get(TREE_W_KEY)) || TREE_W_DEFAULT
    this.setTreeWidth(this.treeWidth, false)
    this.wireTreeGrip(layer.querySelector('.ftree-grip'))
  }

  /** The list pane's width in the layer, clamped to 180 px … half the layer; `save` remembers it. */
  setTreeWidth(w, save) {
    const layer = this.fullEl
    if (!layer) return
    const max = Math.max(TREE_W_MIN, layer.clientWidth / 2)
    this.treeWidth = Math.round(Math.min(max, Math.max(TREE_W_MIN, w)))
    layer.style.setProperty('--tree-w', `${this.treeWidth}px`)
    layer.querySelector('.ftree-grip')?.setAttribute('aria-valuenow', String(this.treeWidth))
    if (save) store.set(TREE_W_KEY, this.treeWidth)
  }

  /**
   * The shell's grip pattern (shell.js `_wireRight`): pointer capture so the drag carries on off
   * the grip, `resizing` on the layer meanwhile, arrows at 10 px (40 with Shift), double-click
   * back to the default. Hidden with the pane, so a hidden list is never resized.
   */
  wireTreeGrip(grip) {
    const layer = this.fullEl
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      grip.setPointerCapture(e.pointerId)
      layer.classList.add('resizing')
    })
    grip.addEventListener('pointermove', (e) => {
      if (!grip.hasPointerCapture(e.pointerId)) return
      this.setTreeWidth(e.clientX - layer.querySelector('.fpanes').getBoundingClientRect().left, false)
    })
    const end = (e) => {
      if (!grip.hasPointerCapture(e.pointerId)) return
      grip.releasePointerCapture(e.pointerId)
      layer.classList.remove('resizing')
      this.setTreeWidth(this.treeWidth, true)
    }
    grip.addEventListener('pointerup', end)
    grip.addEventListener('pointercancel', end)
    grip.addEventListener('dblclick', () => this.setTreeWidth(TREE_W_DEFAULT, true))
    grip.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 40 : 10
      if (e.key === 'ArrowRight') this.setTreeWidth(this.treeWidth + step, true)
      else if (e.key === 'ArrowLeft') this.setTreeWidth(this.treeWidth - step, true)
      else return
      e.preventDefault()
    })
  }

  /**
   * The list pane and the viewer into `box` (the layer's, or back to the column). The list keeps
   * where it was scrolled to; the viewer is drawn again, since a moved frame reloads and a moved
   * code view is best mounted afresh.
   */
  movePanes(box) {
    const top = this.listEl.scrollTop
    box.append(this.sideEl, this.viewEl)
    this.listEl.scrollTop = top
    this.paintView()
  }

  /** The layer's list pane, shown or hidden for wide content; remembered. */
  toggleTree() {
    if (!this.fullEl) return
    const hide = !this.fullEl.hasAttribute('data-notree')
    this.fullEl.toggleAttribute('data-notree', hide)
    this.fullEl.querySelector('[data-act=tree]')?.setAttribute('aria-pressed', String(!hide))
    store.set(TREE_KEY, !hide)
  }

  collapse() {
    this.full?.()
  }
}
