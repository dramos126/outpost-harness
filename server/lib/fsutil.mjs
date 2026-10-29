/**
 * Filesystem helpers shared by every harness adapter.
 *
 * Nothing in here knows about a particular harness — an adapter is free to ignore the lot
 * and read its data however it likes. See `server/harnesses/README.md` for the contract.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

/** Read the first chunk of a file without pulling a 12MB transcript into memory. */
export async function readHead(file, bytes) {
  const fh = await fsp.open(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    const text = buf.subarray(0, bytesRead).toString('utf8')
    // Drop a trailing partial line so JSON.parse never sees half a record.
    return bytesRead === bytes ? text.slice(0, text.lastIndexOf('\n') + 1) : text
  } finally {
    await fh.close()
  }
}

/**
 * Read the last chunk of a file — the mirror of `readHead`, for what a transcript says *now*
 * rather than what it said when it started.
 *
 * The leading partial line is dropped for the same reason `readHead` drops the trailing one:
 * a read that begins partway through the file begins inside some record. A chunk boundary can
 * also land mid-codepoint, which makes that first line unparseable rather than merely
 * incomplete — either way it is the line that gets thrown away.
 */
export async function readTail(file, bytes) {
  const fh = await fsp.open(file, 'r')
  try {
    const { size } = await fh.stat()
    const start = Math.max(0, size - bytes)
    const buf = Buffer.allocUnsafe(size - start)
    const { bytesRead } = await fh.read(buf, 0, buf.length, start)
    const text = buf.subarray(0, bytesRead).toString('utf8')
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
  } finally {
    await fh.close()
  }
}

/** Parse a JSONL blob, skipping the partial or malformed lines a live file always has. */
export function jsonLines(text) {
  const out = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      out.push(JSON.parse(t))
    } catch {
      /* partial or malformed line — skip */
    }
  }
  return out
}

/**
 * A JSON file Outpost keeps its own state in: the parsed value, or `undefined` when there is
 * no file yet — which is the normal first run.
 *
 * A file that is there and will not parse is not "no file", and reading it as one is how a
 * store gets wiped: the caller starts empty, and its next save writes that emptiness over
 * whatever a person could still have mended. So this throws, naming the file, and the caller's
 * write never happens. With `aside`, for a store Outpost cannot run without, the file is
 * renamed out of the way instead — kept whole beside where it was, said in the log — and the
 * caller starts empty on purpose.
 */
export async function readJsonFile(file, { aside = false } = {}) {
  let text
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return undefined
    throw new Error(`${file} is not readable: ${err.message}`)
  }
  try {
    return JSON.parse(text)
  } catch (err) {
    if (!aside) throw new Error(`${file} is not valid JSON (${err.message}); it was left as it is`)
    const kept = `${file}.unreadable-${Date.now()}`
    await fsp.rename(file, kept)
    console.warn(`[outpost] ${file} is not valid JSON (${err.message}); kept as ${kept}, starting empty`)
    return undefined
  }
}

export async function listFiles(dir, filter) {
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.filter((e) => e.isFile() && filter(e.name)).map((e) => path.join(dir, e.name))
}

export async function listDirs(dir) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name))
  } catch {
    return []
  }
}

/** Does this path exist at all? Adapters use it to answer `detect()`. */
export async function exists(p) {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

export const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
