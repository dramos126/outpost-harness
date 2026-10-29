/**
 * A file out of a chat's workspace, for the page's Files section (ui-details.md): the report a
 * session wrote into `temp/` and told the person to read, as it stands on disk now.
 *
 * The workspace folder is mounted into the chat's container at its host path (launchers.md),
 * so everything a session writes under a checkout, its `temp/`, or the container's home is on
 * this disk and outlives the container. What is read here is bounded to that folder: a path
 * outside it, or a link that leads out of it, is refused — the page could otherwise name any
 * file on this machine. Capped: text at 512 KB, cut; bytes (a picture, a PDF, a download) at
 * 8 MB or 64 MB, refused whole — the viewer is for a report, not a dump.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { WORKSPACES_DIR } from './index.mjs'

/** The most of one file that travels to the page; the rest is said to be cut. */
export const FILE_BYTES = 512 * 1024
/**
 * The most of one file `/api/file/bytes` sends for the viewer to draw (an image, a PDF), and the
 * most for the Download link. Past either it is refused whole, never cut: half an image is no image.
 */
export const BIN_BYTES = 8 * 1024 * 1024
export const DOWNLOAD_BYTES = 64 * 1024 * 1024

/**
 * The types the viewer draws from bytes, by extension; anything else is `application/octet-stream`.
 * Never sniffed and never `text/html`: the bytes become a blob URL in the page's origin.
 */
const BYTE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
  pdf: 'application/pdf',
}

export const contentTypeOf = (p) => BYTE_TYPES[String(p).toLowerCase().split('.').pop()] || 'application/octet-stream'

/**
 * The whole of an open file, refused past `maxBytes`: `{ ok, bytes, size, modifiedAt, type }`, or
 * `{ ok: false, tooBig, size, error }`. Read to the size it had when stat'd, so a file growing
 * under the read never sends more than its `Content-Length`.
 */
export async function bytesOf(fh, name, maxBytes) {
  const st = await fh.stat()
  if (st.size > maxBytes) return { ok: false, tooBig: true, size: st.size, error: `That file is ${Math.ceil(st.size / 1048576)} MB, over the ${maxBytes / 1048576} MB this sends` }
  const bytes = Buffer.alloc(st.size)
  let at = 0
  while (at < bytes.length) {
    const { bytesRead } = await fh.read(bytes, at, bytes.length - at, at)
    if (!bytesRead) break
    at += bytesRead
  }
  return { ok: true, bytes: bytes.subarray(0, at), size: st.size, modifiedAt: st.mtimeMs, type: contentTypeOf(name) }
}

export const workspaceDir = (m) => path.join(WORKSPACES_DIR, String(m?.id || ''))

/**
 * `p` as an absolute path inside the workspace `m`, or `''` when it is not — by its letters
 * alone, before any link is followed. A relative path is taken from the session's cwd.
 */
export function insideWorkspace(m, p, cwd = '') {
  const dir = workspaceDir(m)
  if (!m?.id) return ''
  const s = String(p || '')
  if (!s || s.startsWith('~')) return ''
  const abs = path.resolve(s.startsWith('/') ? s : path.join(cwd || dir, s))
  return abs === dir || abs.startsWith(dir + path.sep) ? abs : ''
}

/**
 * Whether a path in the workspace is where scratch lives: outside every checkout, or in a
 * checkout's `temp/`, where sessions are told to keep it (workspaces.md `WORK_RULE`). The Files
 * list uses it to keep a cited source file out of the list while keeping a report a session
 * made with Bash rather than Write.
 */
export function scratchLike(m, abs) {
  for (const r of m?.repos || []) {
    const root = String(r.path || '')
    if (!root || !(abs === root || abs.startsWith(root + path.sep))) continue
    return abs.startsWith(path.join(root, 'temp') + path.sep)
  }
  return true
}

/**
 * Code, by its extension: what a session Writes as part of the work rather than for a person to
 * read. Never a report, a note, a table or a page (md, txt, html, json, yaml, csv, images, pdf):
 * those are what an answer points a person at.
 */
const SOURCE_EXT = new Set(
  'js mjs cjs jsx ts tsx mts cts py pyi go rs java rb sh bash zsh c h cpp cc cxx hpp hh cs kt kts swift lua pl pm r php scala dart sql css scss less vue svelte toml ini cfg'.split(' ')
)

/** Whether `p` names a source file (`SOURCE_EXT`), for the Files list's one rule (`placeFiles`). */
export function sourceLike(p) {
  const name = path.basename(String(p || ''))
  const dot = name.lastIndexOf('.')
  return dot > 0 && SOURCE_EXT.has(name.slice(dot + 1).toLowerCase())
}

/** The real path of `abs`, or `''` when it is missing or when following its links leaves the workspace. */
export async function realInside(m, abs) {
  const dir = workspaceDir(m)
  try {
    const [real, realDir] = await Promise.all([fsp.realpath(abs), fsp.realpath(dir)])
    return real === realDir || real.startsWith(realDir + path.sep) ? real : ''
  } catch {
    return ''
  }
}

/**
 * A workspace file placed and bounded for a read: `{ abs, real }`, or the answer to send instead —
 * outside by its letters or its real path, a NUL, `missing`, or a folder.
 */
async function placeForRead(m, p, cwd) {
  if (String(p ?? '').includes('\0')) return { answer: { ok: false, error: 'That is not a path' } }
  const abs = insideWorkspace(m, p, cwd)
  if (!abs) return { answer: { ok: false, error: "That file is not in this chat's workspace", outside: true } }
  const real = await realInside(m, abs)
  if (!real) {
    const st = await fsp.lstat(abs).catch(() => null)
    return { answer: st ? { ok: false, error: 'That link leads out of the workspace', outside: true } : { ok: true, path: abs, text: '', missing: true } }
  }
  const st = await fsp.stat(real)
  if (!st.isFile()) return { answer: { ok: false, error: 'That is a folder, not a file' } }
  return { abs, real }
}

/**
 * One file, as text: `{ ok, path, text, size, modifiedAt, truncated }`; `{ ok: true, missing }`
 * when it is not on disk; `binary: true` with no text for a file that is not text (a NUL in its
 * first `FILE_BYTES`), whose bytes are `readWorkspaceBytes`'s; `ok: false` with the reason for a
 * path outside the workspace or a folder.
 */
export async function readWorkspaceFile(m, p, { cwd = '', maxBytes = FILE_BYTES } = {}) {
  const { answer, abs, real } = await placeForRead(m, p, cwd)
  if (answer) return answer
  const fh = await fsp.open(real)
  try {
    const st = await fh.stat()
    const buf = Buffer.alloc(Math.min(st.size, maxBytes))
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    const head = buf.subarray(0, bytesRead)
    if (head.includes(0)) return { ok: true, path: abs, text: '', binary: true, size: st.size, modifiedAt: st.mtimeMs, truncated: false }
    return { ok: true, path: abs, text: head.toString('utf8'), size: st.size, modifiedAt: st.mtimeMs, truncated: st.size > maxBytes }
  } finally {
    await fh.close()
  }
}

/**
 * One file's bytes, bounded as `readWorkspaceFile` is, for `/api/file/bytes`: `bytesOf`'s answer,
 * or that function's refusals and `missing`.
 */
export async function readWorkspaceBytes(m, p, { cwd = '', maxBytes = BIN_BYTES } = {}) {
  const { answer, abs, real } = await placeForRead(m, p, cwd)
  if (answer) return answer
  const fh = await fsp.open(real)
  try {
    return { ...(await bytesOf(fh, abs, maxBytes)), path: abs }
  } finally {
    await fh.close()
  }
}

/**
 * The harness's list of what a chat wrote or mentioned (harnesses.md `readFiles`), each
 * checked against the disk: `onDisk`, `size`, `modifiedAt`, and `path` made absolute. A path
 * the session only mentioned — never written through its Write tool — stays listed only when
 * it is on disk and scratch-like, so the source files an answer cites are not the list. One
 * Written by the session that is `sourceLike` loses its `mentionedAt` (kept as `cited`): an
 * answer citing code it just changed is not saying read this, so it is never "For you".
 */
export async function placeFiles(m, files, cwd = '') {
  const out = []
  for (const f of files) {
    const abs = insideWorkspace(m, f.path, cwd)
    const entry = { ...f, path: abs || f.path, inWorkspace: Boolean(abs), onDisk: false, size: 0, modifiedAt: 0 }
    if (abs) {
      const real = await realInside(m, abs)
      const st = real ? await fsp.stat(real).catch(() => null) : null
      if (st?.isFile()) Object.assign(entry, { onDisk: true, size: st.size, modifiedAt: st.mtimeMs })
    }
    if (entry.writes.length && entry.mentionedAt && sourceLike(entry.path)) {
      entry.cited = true
      entry.mentionedAt = 0
    }
    if (entry.writes.length || (entry.onDisk && scratchLike(m, abs))) out.push(entry)
  }
  return out
}
