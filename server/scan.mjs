/**
 * Harness-agnostic thread scanning.
 *
 * This module knows nothing about any particular agent harness: it asks every harness that
 * is present on this machine for its threads, stamps each one with which harness it came
 * from, and hands back a single list sorted by recency. Everything harness-specific lives
 * in `server/harnesses/` — see the README there.
 */
import { HARNESSES, detectedHarnesses, harnessById } from './harnesses/index.mjs'

/**
 * Every thread from every detected harness.
 *
 * A harness that throws is skipped rather than allowed to take the scan down with it: one
 * broken adapter should cost you that harness's threads, not the whole roster.
 *
 * `failed` names the harnesses that were skipped. A list with a harness missing looks exactly
 * like a machine with no sessions, and a caller that *acts* on absence — aging archiving
 * what looks idle, a routine settling what looks finished — has to be able to tell the two
 * apart (aging.md, routines.md).
 */
export async function scanAll() {
  const harnesses = await detectedHarnesses()
  const failed = []
  const lists = await Promise.all(
    harnesses.map(async (h) => {
      try {
        const threads = await h.scanThreads()
        return threads.map((t) => ({ ...t, harness: h.id, harnessName: h.name }))
      } catch (err) {
        console.warn(`outpost: harness "${h.id}" failed to scan —`, err?.message || err)
        failed.push(h.id)
        return []
      }
    })
  )
  const threads = lists.flat()
  threads.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  return { threads, failed }
}

/** What Settings shows under This machine: which harnesses exist, and which were found here. */
export async function harnessStatus() {
  const detected = new Set((await detectedHarnesses()).map((h) => h.id))
  return HARNESSES.map((h) => ({ id: h.id, name: h.name, detected: detected.has(h.id) }))
}

const dispatch = (harnessId) => {
  const h = harnessById(harnessId)
  // The caller's mistake, not the server's: the API answers 400 with this rather than a 500.
  if (!h) throw Object.assign(new Error(`Unknown harness "${harnessId}"`), { status: 400 })
  return h
}

export const setThreadArchived = (harnessId, ref, archived) => dispatch(harnessId).setArchived(ref, archived)

/** Tell the harness Outpost put the session back at its prompt. Harmless if it has no notion of that. */
export const noteIdle = (harnessId, ref) => dispatch(harnessId).noteIdle?.(ref) ?? null

/** The id this thread's hooks report under, for callers keyed on live state. `''` if none. */
export const sessionIdOf = (harnessId, ref) => dispatch(harnessId).sessionIdOf?.(ref) || ''

/** The conversation behind a thread, or an honest "this harness cannot" if the adapter has none. */
export async function readTranscript(harnessId, ref, opts) {
  const h = dispatch(harnessId)
  if (!h.readTranscript) return { ok: false, error: `${h.name} does not expose transcripts` }
  return h.readTranscript(ref, opts)
}

/**
 * Records in the harness's own transcript shape as the page's items, or null from a harness that
 * cannot: how a conversation kept somewhere other than its transcript is drawn (api.md).
 */
export function messagesOf(harnessId, records) {
  const h = dispatch(harnessId)
  return h.toMessages ? h.toMessages(records) : null
}

/** One image out of a thread's conversation, as bytes, or a refusal from a harness that keeps none. */
export async function readImage(harnessId, ref, id) {
  const h = dispatch(harnessId)
  if (!h.readImage) return { ok: false, error: `${h.name} does not keep images` }
  return h.readImage(ref, id)
}

/** What the person has asked a thread lately (harnesses.md), or nothing from a harness that cannot say. */
export async function readPrompts(harnessId, ref, opts) {
  const h = dispatch(harnessId)
  if (!h.readPrompts) return { ok: false, first: '', recent: [] }
  return h.readPrompts(ref, opts)
}

/** What a thread has spent, request by request (harnesses.md), or nothing from a harness that cannot say. */
export async function readTokens(harnessId, ref, opts) {
  const h = dispatch(harnessId)
  if (!h.readTokens) return { ok: false, error: `${h.name} does not record what it spends` }
  return h.readTokens(ref, opts)
}

/** The subagents a thread has dispatched, or an empty list from a harness with no notion of them. */
export async function readAgents(harnessId, ref) {
  const h = dispatch(harnessId)
  if (!h.readAgents) return { ok: true, agents: [], missing: true }
  return h.readAgents(ref)
}

/** The commands a thread sent to the background, or an empty list from a harness with no notion of them. */
export async function readCommands(harnessId, ref) {
  const h = dispatch(harnessId)
  if (!h.readCommands) return { ok: true, commands: [], missing: true }
  return h.readCommands(ref)
}

/** The files a thread wrote or named in an answer, or an empty list from a harness with no notion of them. */
export async function readFiles(harnessId, ref, opts) {
  const h = dispatch(harnessId)
  if (!h.readFiles) return { ok: true, files: [], missing: true }
  return h.readFiles(ref, opts)
}

/** One version of a file a thread wrote, by the id `readFiles` gave; an honest refusal from a harness without it. */
export async function readFileVersion(harnessId, ref, id) {
  const h = dispatch(harnessId)
  if (!h.readFileVersion) return { ok: false, error: `${h.name} keeps no versions` }
  return h.readFileVersion(ref, id)
}
