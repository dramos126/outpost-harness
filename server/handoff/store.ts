/**
 * Each chat's handoff and the state of asking for one, by workspace id, in `handoffs.json` in
 * the data directory.
 *
 * On disk and not only in the transcript, for two reasons. A handoff is the thing a fresh
 * conversation starts from, and the conversation it came out of may be read by nobody again.
 * And what the triggers have promised — a chat marked away, a timer due at a minute, a request
 * waiting on its answer — has to outlive a deploy, which restarts Outpost under every chat; a
 * due time held in memory is a timer that a push to main silently cancels.
 *
 * Written through on every change, like the retry budget (resilience.md): it changes a few
 * times an hour. A file that will not parse is set aside rather than written over.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJsonFile } from '../lib/fsutil.mjs'
import type { Handoff } from './rules.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.OUTPOST_DATA || path.join(here, '..', '..', 'data')
const STORE_FILE = path.join(DATA_DIR, 'handoffs.json')

/** A request sent to a session and not yet answered. */
export type Pending = { sessionId: string; at: number; nonce: string; trigger: string; context: number }

export type ChatHandoff = {
  /** The latest handoff, used or not. */
  current: Handoff | null
  pending: Pending | null
  /** Why the last request gave no handoff, for the card; '' when it did. */
  lastError: string
  /** `/away` arrived while the session was busy: ask when its turn ends. */
  away: { at: number } | null
  /** The idle timer: ask at `dueAt` if the session has not answered since `contextAt`. */
  idle: { sessionId: string; dueAt: number; contextAt: number } | null
  /** The plan window a pre-limit request was already made in, so it is made once per window. */
  limitWindow: string
}

const blank = (): ChatHandoff => ({ current: null, pending: null, lastError: '', away: null, idle: null, limitWindow: '' })

let store: Map<string, ChatHandoff> | null = null
let writing: Promise<void> = Promise.resolve()

export async function load(): Promise<Map<string, ChatHandoff>> {
  if (store) return store
  const raw: any = await readJsonFile(STORE_FILE, { aside: true }).catch((err: Error) => {
    console.warn(`[outpost] ${err.message}; starting with no handoffs`)
    return undefined
  })
  const loaded = new Map<string, ChatHandoff>()
  for (const [id, rec] of Object.entries(raw?.chats || {})) {
    if (rec && typeof rec === 'object') loaded.set(id, { ...blank(), ...(rec as object) })
  }
  store = loaded
  return store
}

export function persist(): Promise<void> {
  if (!store) return writing
  const chats = Object.fromEntries(store)
  writing = writing.then(async () => {
    try {
      await fsp.mkdir(DATA_DIR, { recursive: true })
      const tmp = STORE_FILE + '.tmp'
      await fsp.writeFile(tmp, JSON.stringify({ version: 1, chats }, null, 2))
      await fsp.rename(tmp, STORE_FILE)
    } catch (err) {
      console.warn(`[outpost] handoffs not saved: ${(err as Error).message}`)
    }
  })
  return writing
}

/** A chat's record, made if it has none. */
export async function chat(workspaceId: string): Promise<ChatHandoff> {
  const s = await load()
  let rec = s.get(workspaceId)
  if (!rec) {
    rec = blank()
    s.set(workspaceId, rec)
  }
  return rec
}

/** A chat's record if it has one, without making one. */
export async function peek(workspaceId: string): Promise<ChatHandoff | null> {
  return (await load()).get(workspaceId) || null
}

/** Change a chat's record and write it through. */
export async function update(workspaceId: string, change: (rec: ChatHandoff) => void): Promise<ChatHandoff> {
  const rec = await chat(workspaceId)
  change(rec)
  await persist()
  return rec
}

/** Every chat that has a record. */
export async function all(): Promise<Array<[string, ChatHandoff]>> {
  return [...(await load()).entries()]
}

/** Forget a chat whose workspace is gone. */
export async function forget(workspaceId: string): Promise<void> {
  const s = await load()
  if (s.delete(workspaceId)) await persist()
}
