/**
 * The launcher: how Outpost reaches a session it started.
 *
 * There is one way now. Every chat is a structured session — a process under a transient
 * systemd unit, typed to over a FIFO, read through its transcript and its stream, asking
 * through Outpost's approval tool (structured.mjs). The pane-driven tmux launcher, the Mac
 * deep-link launcher and the quick session in a local checkout went with the decision that
 * Outpost lists only the chats it started, in workspaces it made (chats.md, workspaces.md):
 * nothing here reads a screen, walks a process tree or opens somebody else's window.
 *
 * The shape every caller sees is unchanged — one object from `activeLauncher()`, each method
 * taking the thread the page handed back — so the API, the retry supervisor and the
 * workspace layer did not move when the old launchers went. A thread that is not a session
 * Outpost started simply has nothing here to answer for it, and the roster does not list it.
 */
import * as structured from './structured.mjs'
import { sessionIdOf } from '../scan.mjs'

/**
 * The models a new chat can be started on, as the CLI's own stable aliases. Not a list of
 * model names, which go stale the week a model ships: an alias is what `--model` takes and
 * what the CLI resolves to its current meaning. A full model name typed into the field beside
 * them is passed through as is.
 */
export const MODEL_ALIASES = Object.freeze([
  { label: 'Default', description: 'Whatever the CLI is configured for' },
  { label: 'Opus', description: 'Opus · the most capable, for complex work' },
  { label: 'Sonnet', description: 'Sonnet · fast and capable, for everyday work' },
  { label: 'Haiku', description: 'Haiku · fastest, for quick answers' },
  { label: 'Fable', description: 'Fable · the newest, with the strongest safeguards' },
])

let cached = null

/** `claude-opus-5-5[1m]` and `claude-opus-5-5` are one model for this: the transcript names the second. */
const bare = (model) => String(model || '').replace(/\[.*\]$/, '')

/**
 * The context window the session works to, or 0 when no stream of it has said
 * (ui-conversation.md: the header then judges the context by its token count alone). Newest
 * unit first, so a restart whose first turn has not ended yet still has the window its last
 * unit reported. The model
 * the session answered on is preferred; failing a match, the largest window listed, since the
 * CLI's own side requests run on smaller models than the conversation.
 */
async function contextWindowOf(recs, model) {
  for (const rec of [...recs].sort((a, b) => b.startedAt - a.startedAt)) {
    const windows = await structured.contextWindows(rec)
    const entries = Object.entries(windows)
    if (!entries.length) continue
    const hit = entries.find(([m]) => bare(m) === bare(model))
    return hit ? hit[1] : Math.max(...entries.map(([, n]) => n))
  }
  return 0
}

/**
 * The model a session was moved to and has not answered on yet, or ''. Pending until its first
 * answer after the change (`contextAt`, harnesses.md), whatever model that answer names: one on
 * the old model means the change did not take, and the button should say what it runs on,
 * not what was hoped. An alias matches a full name that carries it (`opus`, `claude-opus-4-1`);
 * `default` names no model, so it stays pending until that answer.
 */
export function modelPending(thread, wanted) {
  if (!wanted?.model || (thread?.contextAt || 0) > wanted.at) return ''
  const want = String(wanted.model).toLowerCase()
  const now = String(thread?.model || '').toLowerCase()
  return now && want !== 'default' && (now === want || now.includes(want)) ? '' : want
}

const recOf = (thread) => structured.recordForSession(sessionIdOf(thread?.harness, thread?.ref))

/** @type {Map<string, Promise<object>>} session id -> its resume in flight */
const resuming = new Map()

/**
 * Restart an ended session and wait for it to come up, once per session at a time: two
 * messages sent to it together must not start two units on one conversation.
 */
function resumeOnce(rec) {
  let job = resuming.get(rec.sessionId)
  if (!job) {
    job = (async () => {
      const r = await structured.restart(rec)
      if (!r.ok) return r
      const up = await structured.awaitStart(r.target)
      return up.ok ? { ok: true, record: r.record } : up
    })().finally(() => resuming.delete(rec.sessionId))
    resuming.set(rec.sessionId, job)
  }
  return job
}

/** A method that needs the session's record, or an honest answer when the thread has none. */
const withRecord = (fn) => async (thread, ...rest) => {
  const rec = await recOf(thread)
  if (!rec) return { ok: false, error: 'That is not a session Outpost started' }
  return fn(rec, thread, ...rest)
}

const launcher = {
  id: 'structured',
  name: 'structured',
  canSend: true,
  canLaunch: true,
  canKill: true,

  /**
   * Whether this session is one Outpost started. The retry supervisor asks before it tracks a
   * stall: hooks are installed per user, so a session started by hand reports its failures
   * here too, and nothing below can reach one.
   */
  owns: async (sessionId) => Boolean(sessionId && (await structured.recordForSession(sessionId))),

  /** Which threads this launcher can drive: the ones in its registry, while their unit lives. */
  async annotate(threads) {
    const recs = await structured.allRecords()
    const byId = new Map(recs.filter((r) => r.sessionId).map((r) => [r.sessionId, r]))
    for (const t of threads) {
      const rec = byId.get(sessionIdOf(t.harness, t.ref))
      if (!rec) {
        t.canSend = false
        continue
      }
      const live = await structured.latestForSession(rec.sessionId)
      const alive = live ? await structured.isLive(live) : false
      t.structured = true
      t.canSend = alive
      // A unit that is gone — a reboot, a crash — leaves a session Resume brings back.
      t.structuredDead = !alive
      // Whether its newest unit runs in a container: the page offers a shell into it only then
      // (auth.md — a shell into a session on the host would be the host without its login).
      t.container = Boolean((live || rec).container)
      // A request on the approval bar is the session waiting on you, whatever the hook store
      // last heard: its prompt never reaches a hook (structured.mjs `askingLine`). A session
      // whose unit has gone can still carry one: Outpost's own standing question (a dataset's
      // deletions) outlives the session, and a promoted run's was asked after its end.
      const asked = live || rec
      const asking = alive || structured.isAsking(asked) ? structured.askingLine(asked) : ''
      if (asking) {
        t.running = false
        t.unread = true
        t.done = false
        t.activity = asking
        // What it asks, for the row to quote; over whatever the hook overlay set, for the reason above.
        t.ask = structured.askOf(asked)
      }
      const own = recs.filter((r) => r.sessionId === rec.sessionId)
      t.contextWindow = await contextWindowOf(own, t.model)
      // The newest change asked of any of its units: a restart is a new record without one.
      const wanted = own.map((r) => r.modelWanted).filter(Boolean).sort((a, b) => b.at - a.at)[0]
      t.modelPending = modelPending(t, wanted)
    }
    return threads
  },

  /** A session whose unit is gone: start another with `--resume`. */
  resume: withRecord(async (rec) => {
    if (await structured.isAlive(rec)) return { ok: false, error: 'That session is already running' }
    return structured.restart(rec)
  }),

  /** The answer being written right now, or `''`. */
  async partialText(thread) {
    const rec = await recOf(thread)
    return rec ? structured.partialText(rec) : ''
  },

  /** The conversation rebuilt from the session's own streams, for when its transcript is gone; null if none. */
  streamRecords: (thread, after = 0) => structured.streamRecords(sessionIdOf(thread?.harness, thread?.ref), after),

  /**
   * With `resume`, a message to a session whose unit has gone resumes it first, then is
   * delivered: aging ends quiet sessions to give their memory back (aging.md), and typing is
   * how a person carries on. Only the person's own send passes it — a note, a handoff request
   * or the retry supervisor waking an ended session would undo aging behind everyone's back.
   */
  sendPrompt: withRecord(async (rec, _t, text, { resume = false, ...opts } = {}) => {
    if (!resume || (await structured.isAlive(rec))) return structured.sendPrompt(rec, text, opts)
    const up = await resumeOnce(rec)
    return up.ok ? structured.sendPrompt(up.record, text, opts) : up
  }),
  /** When the session's newest unit started, epoch ms, or 0: a resume is activity aging must see. */
  async startedAt(thread) {
    return (await recOf(thread))?.startedAt || 0
  },
  describePrompt: async (thread) => {
    const rec = await recOf(thread)
    return rec ? structured.describePrompt(rec) : { asking: false, options: [], question: '' }
  },
  answerPrompt: withRecord((rec, _t, what, opts) => structured.answer(rec.workspaceId, what, opts)),
  interrupt: withRecord((rec) => structured.interrupt(rec)),
  stopTask: withRecord((rec, _t, taskId) => structured.stopTask(rec, taskId)),

  async readModels() {
    return { ok: true, models: MODEL_ALIASES }
  },
  setModel: withRecord(async (rec, _t, model) => {
    const r = await structured.setModel(rec, String(model || '').split(/\s+/)[0].toLowerCase())
    return r.ok ? { ok: true, model } : r
  }),
  // No slider to read: the CLI's own levels, the top one withheld from Haiku as the slider withholds it.
  readEfforts: withRecord(async (rec, thread) => ({
    ok: true,
    levels: /haiku/i.test(thread?.model || rec.model || '') ? ['low', 'medium', 'high', 'max'] : ['low', 'medium', 'high', 'max', 'ultracode'],
  })),
  // Not a control request (the CLI refuses `set_effort`): a restart in place with a settings
  // override keyed on the model the stream's init line names — the same conversation, a
  // different effort from the next answer on.
  setEffort: withRecord(async (rec, thread, effort) => {
    const model = (await structured.latestForSession(rec.sessionId))?.model || rec.model || thread?.model || ''
    if (!model || !/^claude-/.test(model)) return { ok: false, error: 'Let the session speak once first, so its model is known' }
    const settings = JSON.stringify({ modelSettings: { [model]: { effortLevel: String(effort) } } })
    const r = await structured.restart(rec, { extraArgs: ['--settings', settings] })
    return r.ok ? { ok: true, effort: String(effort) } : r
  }),
  runCommand: withRecord(async (rec, _t, command) => {
    const name = String(command || '').replace(/^\//, '')
    if (name === 'compact') return structured.sendPrompt(rec, '/compact')
    return { ok: false, error: `/${name} is not available` }
  }),
  killSession: withRecord((rec) => structured.kill(rec)),
  /** A new conversation in the session's place, `prompt` its first message (handoff.md). */
  startFresh: withRecord((rec, _t, prompt) => structured.startFresh(rec, prompt)),
  /** Whether the session's unit is running — asked of systemd, never read off the thread. */
  async isAlive(thread) {
    const rec = await recOf(thread)
    return rec ? structured.isAlive(rec) : false
  },
  isQuiet: withRecord(async (rec, thread) => {
    if (structured.isAsking(rec)) return { quiet: false, reason: 'It is asking you something' }
    if (thread?.running) return { quiet: false, reason: 'It is working again' }
    return { quiet: true, reason: '' }
  }),
}

export async function activeLauncher() {
  if (!cached) cached = launcher
  return cached
}
