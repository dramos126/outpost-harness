/**
 * The Files viewer's code view (ui-details.md): one file in CodeMirror 6, read-only — line
 * numbers, highlighting, folding, search (Ctrl/Cmd-F), bracket matching, the active line.
 *
 * CodeMirror is larger than the rest of the page, so `files.js` imports this module the first
 * time a code file opens on a wide screen, and nothing `main.js` imports statically may import
 * it (the terminal's rule, ui.md). Each language is its own dynamic import in `PACKS`, so a
 * Python file costs the core and one pack; a pack arrives after the text is drawn and is swapped
 * in, and an extension with no pack is the plain view.
 *
 * Every colour is a token: the theme and the highlight style name `var(--…)`, so a preset change
 * recolours an open view. `getComputedStyle` reads only whether the preset is dark, for
 * CodeMirror's own base theme (the search panel's buttons, the fold marker).
 */
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view'
import { HighlightStyle, StreamLanguage, bracketMatching, codeFolding, foldGutter, foldKeymap, syntaxHighlighting } from '@codemirror/language'
import { defaultKeymap } from '@codemirror/commands'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { tags as t } from '@lezer/highlight'

/** A legacy mode (`@codemirror/legacy-modes`) as a language: what has no Lezer pack of its own. */
const legacy = (load, name) => () => load().then((m) => StreamLanguage.define(m[name]))

/** Each pack, loaded on first use. Every `import()` here is a chunk of its own. */
const PACKS = {
  javascript: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  typescript: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
  tsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true, jsx: true })),
  python: () => import('@codemirror/lang-python').then((m) => m.python()),
  markdown: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  json: () => import('@codemirror/lang-json').then((m) => m.json()),
  css: () => import('@codemirror/lang-css').then((m) => m.css()),
  html: () => import('@codemirror/lang-html').then((m) => m.html()),
  yaml: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  sql: () => import('@codemirror/lang-sql').then((m) => m.sql()),
  go: () => import('@codemirror/lang-go').then((m) => m.go()),
  rust: () => import('@codemirror/lang-rust').then((m) => m.rust()),
  java: () => import('@codemirror/lang-java').then((m) => m.java()),
  shell: legacy(() => import('@codemirror/legacy-modes/mode/shell'), 'shell'),
  toml: legacy(() => import('@codemirror/legacy-modes/mode/toml'), 'toml'),
  dockerfile: legacy(() => import('@codemirror/legacy-modes/mode/dockerfile'), 'dockerFile'),
  properties: legacy(() => import('@codemirror/legacy-modes/mode/properties'), 'properties'),
  diff: legacy(() => import('@codemirror/legacy-modes/mode/diff'), 'diff'),
  xml: legacy(() => import('@codemirror/legacy-modes/mode/xml'), 'xml'),
  ruby: legacy(() => import('@codemirror/legacy-modes/mode/ruby'), 'ruby'),
  lua: legacy(() => import('@codemirror/legacy-modes/mode/lua'), 'lua'),
  swift: legacy(() => import('@codemirror/legacy-modes/mode/swift'), 'swift'),
  perl: legacy(() => import('@codemirror/legacy-modes/mode/perl'), 'perl'),
  r: legacy(() => import('@codemirror/legacy-modes/mode/r'), 'r'),
  powershell: legacy(() => import('@codemirror/legacy-modes/mode/powershell'), 'powerShell'),
  protobuf: legacy(() => import('@codemirror/legacy-modes/mode/protobuf'), 'protobuf'),
  cmake: legacy(() => import('@codemirror/legacy-modes/mode/cmake'), 'cmake'),
  groovy: legacy(() => import('@codemirror/legacy-modes/mode/groovy'), 'groovy'),
  c: legacy(() => import('@codemirror/legacy-modes/mode/clike'), 'c'),
  cpp: legacy(() => import('@codemirror/legacy-modes/mode/clike'), 'cpp'),
  csharp: legacy(() => import('@codemirror/legacy-modes/mode/clike'), 'csharp'),
  kotlin: legacy(() => import('@codemirror/legacy-modes/mode/clike'), 'kotlin'),
  scala: legacy(() => import('@codemirror/legacy-modes/mode/clike'), 'scala'),
  dart: legacy(() => import('@codemirror/legacy-modes/mode/clike'), 'dart'),
}

/** By extension, lower-cased. Anything not here is the plain view. */
const BY_EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  py: 'python', pyi: 'python',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  json: 'json', jsonc: 'json', webmanifest: 'json',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', htm: 'html', xhtml: 'html', vue: 'html', svelte: 'html',
  yaml: 'yaml', yml: 'yaml',
  sql: 'sql',
  go: 'go',
  rs: 'rust',
  java: 'java',
  sh: 'shell', bash: 'shell', zsh: 'shell', ksh: 'shell', mk: 'shell',
  toml: 'toml',
  dockerfile: 'dockerfile', containerfile: 'dockerfile',
  ini: 'properties', cfg: 'properties', conf: 'properties', properties: 'properties', env: 'properties',
  diff: 'diff', patch: 'diff',
  xml: 'xml', xsd: 'xml', xsl: 'xml', plist: 'xml', csproj: 'xml', svg: 'xml',
  rb: 'ruby', lua: 'lua', swift: 'swift', pl: 'perl', pm: 'perl', r: 'r', ps1: 'powershell', proto: 'protobuf', cmake: 'cmake',
  groovy: 'groovy', gradle: 'groovy',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', cs: 'csharp', kt: 'kotlin', kts: 'kotlin', scala: 'scala', dart: 'dart',
}

/** By the whole name, for the files whose name is their type. A Makefile reads well enough as shell. */
const BY_NAME = {
  makefile: 'shell', gnumakefile: 'shell', dockerfile: 'dockerfile', containerfile: 'dockerfile', jenkinsfile: 'groovy',
  gemfile: 'ruby', rakefile: 'ruby', 'cmakelists.txt': 'cmake', '.bashrc': 'shell', '.zshrc': 'shell', '.profile': 'shell', '.env': 'properties',
}

/** The language of a file name (`''` for the plain view), or of a name the caller gives (`json`). */
export function languageOf(name) {
  const base = String(name || '').split('/').pop().toLowerCase()
  if (PACKS[base]) return base
  if (BY_NAME[base]) return BY_NAME[base]
  const dot = base.lastIndexOf('.')
  return dot > 0 ? BY_EXT[base.slice(dot + 1)] || '' : ''
}

const loaded = new Map()
/** A pack, imported once for the page's life. */
function pack(lang) {
  if (!loaded.has(lang)) loaded.set(lang, PACKS[lang]().catch(() => (loaded.delete(lang), null)))
  return loaded.get(lang)
}

const tint = (pct) => `color-mix(in srgb, var(--accent) ${pct}%, transparent)`

const theme = EditorView.theme({
  '&': { height: '100%', color: 'var(--text)', backgroundColor: 'var(--code)', fontSize: '12px', borderRadius: '8px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.5' },
  '.cm-content': { caretColor: 'transparent' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--text3)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'var(--code)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text2)' },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { backgroundColor: tint(32) },
  '.cm-content ::selection': { backgroundColor: tint(32) },
  '.cm-searchMatch': { backgroundColor: tint(22), outline: `1px solid ${tint(60)}` },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: tint(50) },
  '.cm-selectionMatch': { backgroundColor: tint(14) },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: tint(28), outline: 'none' },
  '&.cm-focused .cm-nonmatchingBracket': { color: 'var(--red)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--fill)', border: 'none', color: 'var(--text2)' },
  '.cm-foldGutter span': { color: 'var(--text3)' },
  '.cm-panels': { backgroundColor: 'var(--raised)', color: 'var(--text)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--sep)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--sep)' },
  '.cm-panel.cm-search': { fontFamily: 'var(--font)', fontSize: '12.5px', padding: '6px 8px' },
  '.cm-textfield': { border: '1px solid var(--sep)', borderRadius: '6px', backgroundColor: 'var(--bg)', color: 'var(--text)' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--fill)', border: 'none', borderRadius: '6px', color: 'var(--text)' },
})

/** The syntax colours, the stylesheet's `--syn-*` tokens (ui.md: every colour is a token on `:root`). */
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: 'var(--syn-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.meta], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.typeName, t.className, t.namespace, t.tagName, t.heading], color: 'var(--syn-type)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.variableName), t.labelName], color: 'var(--syn-def)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--syn-prop)' },
  { tag: [t.punctuation, t.bracket, t.operator, t.separator, t.processingInstruction], color: 'var(--text2)' },
  { tag: t.heading, fontWeight: '650' },
  { tag: t.strong, fontWeight: '650' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: [t.link, t.url], color: 'var(--syn-string)', textDecoration: 'underline' },
  { tag: t.invalid, color: 'var(--red)' },
])

/**
 * Draw `text` read-only into `parent`, highlighted as `lang` (`languageOf`; `''` is plain) once
 * its pack arrives. Answers `destroy`, which the caller runs before the element goes.
 */
export function mountCode(parent, text, lang) {
  const language = new Compartment()
  const dark = getComputedStyle(document.documentElement).colorScheme.includes('dark')
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        // Not editable is not focusable: a tab stop lets a click give the view the keys, so Ctrl-F is its search.
        EditorView.contentAttributes.of({ tabindex: '0' }),
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        drawSelection(),
        highlightActiveLine(),
        codeFolding(),
        foldGutter(),
        bracketMatching(),
        highlightSelectionMatches(),
        search({ top: true }),
        syntaxHighlighting(highlight),
        keymap.of([...searchKeymap, ...foldKeymap, ...defaultKeymap]),
        theme,
        EditorView.darkTheme.of(dark),
        language.of([]),
      ],
    }),
  })
  // The page's own keys (`c` opens New chat, `n` the next chat) never see a key typed in here.
  view.dom.addEventListener('keydown', (e) => e.stopPropagation())
  let alive = true
  if (lang && PACKS[lang]) {
    pack(lang).then((ext) => {
      if (alive && ext) view.dispatch({ effects: language.reconfigure(ext) })
    })
  }
  return {
    destroy() {
      alive = false
      view.destroy()
    },
  }
}
