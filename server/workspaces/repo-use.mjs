/**
 * How often each repo is picked in New chat, so the dialog can list the most used first.
 *
 * Kept in the data dir, not the catalogue: it is this machine's habit, not a setting, and the
 * catalogue is the portable file an export carries. Counted from the dialog only — a routine
 * firing every hour would otherwise bury the repos the person actually opens.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.OUTPOST_DATA || path.join(here, '..', '..', 'data')
const FILE = path.join(DATA_DIR, 'repo-use.json')

/** `{ [repoId]: { chats, at } }`; an unreadable file reads as none yet — losing an order costs nothing. */
async function load() {
  try {
    const raw = JSON.parse(await fsp.readFile(FILE, 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

export const repoUse = () => load()

let writing = Promise.resolve()

/** One more chat on each of `ids`. Writes queue so two chats started at once both count. */
export function noteRepoUse(ids) {
  writing = writing.catch(() => {}).then(async () => {
    const use = await load()
    for (const id of ids) use[id] = { chats: (use[id]?.chats || 0) + 1, at: Date.now() }
    await fsp.mkdir(DATA_DIR, { recursive: true })
    const tmp = `${FILE}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(use) + '\n')
    await fsp.rename(tmp, FILE)
  })
  return writing
}
