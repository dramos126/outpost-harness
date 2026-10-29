/**
 * A file path as a session writes one in prose: `temp/report.md`, `/home/x/repo/docs/a.md`,
 * `./src/main.js:42`. One rule for both sides — the harness uses it to list the files a chat
 * pointed the person at (harnesses.md `readFiles`), and the page uses the same rule to make
 * that token a link (ui-conversation.md) — so what the list calls a mention is exactly what the
 * log draws as one. No node import here on purpose: the page bundles this file.
 *
 * What counts: at least one `/`, a last segment with an extension, and a boundary on each side.
 * A bare `README.md` is a word, not a path; a folder is not a file; a `/` inside a URL is
 * never at a boundary (the character before it is `:` or a letter), and a `](` before the token
 * is a Markdown link's own address. A trailing `:42` is a line reference and rides as `line`,
 * outside the path. Punctuation after the token (`temp/x.md.`, `temp/x.md,`) stays outside it.
 * The page runs this on escaped text, so `;` is a boundary (`&quot;temp/x.md&quot;`).
 */
export const PATH_TOKEN =
  /(^|[\s(\[{<>"'`*_,;=])(?<!\]\()((?:~|\.{1,2})?\/(?:[\w.+@%-]+\/)*[\w.+@%-]*\.[A-Za-z0-9]{1,8}|(?:[\w.+@%-]+\/)+[\w.+@%-]*\.[A-Za-z0-9]{1,8})(:\d{1,6})?(?=$|[^\w/.+@%-]|\.(?!\w))/g

/** Every path token in `text`: `{ path, line }`, in order, duplicates kept. */
export function pathMentions(text) {
  const out = []
  for (const m of String(text || '').matchAll(PATH_TOKEN)) out.push({ path: m[2], line: m[3] ? Number(m[3].slice(1)) : 0 })
  return out
}
