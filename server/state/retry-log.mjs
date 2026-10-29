/**
 * What the supervisor decided, and why, kept where a person can read it afterwards.
 *
 * The schedule in `retry.mjs` is the one part of this project that reasons about the *future*,
 * and it was the only part that left no trace. Everything it decides is held in a record that
 * is deleted the moment the session recovers — so reconstructing a real episode meant the
 * session transcript, `retries.json`'s mtime, the systemd journal and a screenshot of a Discord
 * message, and even then it could not say which of two candidate causes produced the defect
 * (bugs.md, the two restart-schedule entries). This file is the answer to that: one line per
 * decision, written before the thing it describes can be undone.
 *
 * JSONL rather than prose because the interesting fields are structured — a published reset
 * time, which window it came from, an attempt count — and a line that has to be parsed with a
 * regex is a line that gets parsed wrong. `tools/retry-log.mjs` renders it for reading.
 *
 * Only decisions are written. A tick that finds nothing due writes nothing, which is what keeps
 * this readable: a quiet day is an empty file, not fourteen hundred lines saying so.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.OUTPOST_DATA || path.join(here, '..', '..', 'data')

export const LOG_FILE = path.join(DATA_DIR, 'retry-log.jsonl')
/** One generation back. Kept because an episode can straddle a rotation. */
export const PREV_FILE = path.join(DATA_DIR, 'retry-log.1.jsonl')

/**
 * How big the live file gets before it rotates. Generous on purpose: an episode is a handful
 * of lines, so a megabyte is months of them, and the whole value of this file is being able to
 * read back to a stall that happened while nobody was watching.
 */
const MAX_BYTES = 1024 * 1024

/** Bytes in the live file, or null until the first write bothers to look. */
let size = null
/** Writes are chained, so two decisions in the same tick cannot interleave their lines. */
let writing = Promise.resolve()

/**
 * Append one decision. Never throws and never blocks a caller that has to get on with it: the
 * awaited promise is offered for tests, and the supervisor deliberately does not wait on it.
 * A lost line costs a diagnosis, and there is nothing useful to report a failed log write to —
 * the same posture as every other write in this module's neighbourhood.
 */
export function logDecision(event, fields = {}) {
  let line
  try {
    line = JSON.stringify({ t: new Date().toISOString(), event, ...fields }) + '\n'
  } catch {
    // A field that will not serialise (a cycle, a BigInt) must not take the supervisor down.
    return writing
  }

  writing = writing.then(async () => {
    try {
      await fsp.mkdir(DATA_DIR, { recursive: true })
      if (size === null) size = await fsp.stat(LOG_FILE).then((s) => s.size, () => 0)
      // Rotate before the write rather than after, so the live file never exceeds the cap.
      // Guarded on there being something to rotate: renaming a file that does not exist throws,
      // and losing the first line of a fresh log to that would be a silly way to fail.
      if (size > 0 && size + line.length > MAX_BYTES) {
        await fsp.rename(LOG_FILE, PREV_FILE)
        size = 0
      }
      await fsp.appendFile(LOG_FILE, line)
      size += line.length
    } catch {
      /* a lost line costs a diagnosis, never a restart */
    }
  })
  return writing
}

/**
 * Decisions back off disk, oldest first, across the rotation.
 *
 * A line that will not parse is skipped rather than fatal — a torn write at the tail of the
 * file is the ordinary way this ends when the process is killed mid-append, and one bad line is
 * not a reason to refuse to show the ninety good ones.
 */
export async function readDecisions({ session = '', limit = 0 } = {}) {
  const out = []
  for (const file of [PREV_FILE, LOG_FILE]) {
    const raw = await fsp.readFile(file, 'utf8').catch(() => '')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let rec
      try {
        rec = JSON.parse(line)
      } catch {
        continue
      }
      if (session && rec.session !== session && !String(rec.session || '').startsWith(session)) continue
      out.push(rec)
    }
  }
  return limit > 0 ? out.slice(-limit) : out
}
