/**
 * Files attached to a prompt from the page — screenshots mostly, and PDFs and text files.
 *
 * The page uploads a file once and `/api/send` names it by the path handed back; the
 * launcher reads the file and puts it in the message as an image or document block
 * (launchers.md), choosing by the extension saved here.
 * `/api/send` refuses a path that is not under this directory, so the page can name a file it
 * uploaded and nothing else on disk.
 *
 * The extension comes from the MIME type, never from the name the browser sent, and the
 * directory segment is sanitised to a safe alphabet: nothing the page says decides where on
 * disk a file lands, only what it is called within a folder we chose.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

const TYPES = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['application/pdf', 'pdf'],
])

/** Decoded bytes, not base64 — a screenshot is a few hundred KB; this leaves room for a big one. */
export const MAX_BYTES = 12 * 1024 * 1024

/**
 * A text file goes into the prompt whole, so its cap is in tokens, not disk: 256 KB is about
 * 64k tokens, a large file, and past it the session is better told to read one from its checkout.
 */
export const MAX_TEXT_BYTES = 256 * 1024

/**
 * Text is judged by its bytes, not its type: a browser calls `.md` nothing, `.ts` a video and
 * `.log` whatever the OS says. UTF-8 that decodes, without a NUL, is text; anything else is not.
 */
const isText = (bytes) => {
  if (bytes.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/**
 * A name from the safe alphabet. A name of dots alone is replaced too: the alphabet allows `.`,
 * so a folder of `..` survived it and `path.join` wrote the upload one level above the uploads
 * directory.
 */
const safe = (s) => {
  const name = String(s || '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)
  return /^\.*$/.test(name) ? 'file' : name
}

/**
 * Save one upload. `folder` groups files by thread; `name` only survives as a hint in the
 * filename. Returns the absolute path to put in the prompt.
 */
export async function saveUpload(baseDir, { folder, name, type, data }) {
  if (typeof data !== 'string' || !data) return { ok: false, error: 'No file data' }
  const bytes = Buffer.from(data, 'base64')
  if (!bytes.length) return { ok: false, error: 'File data was not valid base64' }
  if (bytes.length > MAX_BYTES) return { ok: false, error: `That file is over ${Math.round(MAX_BYTES / 1048576)} MB` }
  const mime = String(type || '').toLowerCase()
  let ext = TYPES.get(mime)
  // A type we do not take as an image or PDF may still be text; an image type never is.
  if (!ext && !mime.startsWith('image/') && isText(bytes)) {
    if (bytes.length > MAX_TEXT_BYTES) return { ok: false, error: `A text file can be at most ${MAX_TEXT_BYTES / 1024} KB` }
    ext = 'txt'
  }
  if (!ext) return { ok: false, error: 'Only images (PNG, JPEG, GIF, WebP), PDFs and text files can be attached' }

  const dir = path.join(baseDir, safe(folder))
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  // A text file keeps its own extension in the stem (`notes.md.txt`): the session is told the
  // file's name, and `notes` alone would not say what is in it.
  const given = String(name || (ext === 'txt' ? 'file' : 'image'))
  const stem = safe(ext === 'txt' ? path.basename(given) : path.basename(given, path.extname(given)))
  const file = path.join(dir, `${Date.now().toString(36)}-${stem}.${ext}`)
  await fsp.writeFile(file, bytes, { mode: 0o600 })
  return { ok: true, path: file, bytes: bytes.length }
}

/**
 * The name a saved upload was given by the person, for the session and the log: the
 * timestamp off the front and, for text, the `.txt` this file added (`notes.md.txt` → `notes.md`).
 */
export const uploadTitle = (file) => {
  const base = path.basename(file).replace(/^[0-9a-z]+-/, '')
  return base.endsWith('.txt') ? base.slice(0, -4) : base
}
