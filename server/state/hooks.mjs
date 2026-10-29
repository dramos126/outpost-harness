/**
 * Live session state, as reported by Claude Code's own hooks.
 *
 * The harness adapter can only see what a session has already written to disk: a transcript
 * that grew, and a pid that still exists. That is enough to say "this session is alive and
 * touched something recently", and not enough for anything else — a session blocked on a
 * permission prompt, one that finished a minute ago, and one sitting at an empty prompt all
 * look identical from the outside.
 *
 * So the sessions tell us instead. Each project's `.claude/settings.json` points a handful of
 * hooks at `POST /api/hook`, and what lands here is the difference between a list where
 * every chat reads the same and one that is actually worth looking at.
 *
 * This store is the *only* place that knows what a hook payload looks like. Everything
 * downstream reads the small normalised record built at the bottom of `recordHookEvent`.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { readJsonFile } from '../lib/fsutil.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.OUTPOST_DATA || path.join(here, '..', '..', 'data')
const STORE_FILE = path.join(DATA_DIR, 'hooks.json')

/** Drop a session's state this long after its last event, so the file cannot grow forever. */
const TTL_MS = 14 * 24 * 60 * 60 * 1000
/** A `running` claim older than this is not believed — the session died mid-turn. */
const RUNNING_TTL_MS = 60 * 60 * 1000
/** How long to sit on writes. A tool-heavy turn fires several events a second. */
const FLUSH_MS = 250

/**
 * What one hook can make this store hold. Every limit here is far above anything a real
 * session sends and is for the hook that is not one: `/api/hook` takes whatever a process on
 * this machine posts, and before these a loop of made-up session ids grew the map, the file
 * rewritten every 250 ms and every scan without end.
 *
 * `SESSION_ID`: Claude Code's ids are UUIDs; this asks only for an id-shaped string, so a CLI
 * that changed its format would not silently lose every hook. `MAX_SESSIONS`: fourteen days of
 * a busy machine's sessions with room over; past it the longest-quiet record goes, ended ones
 * first. `MAX_SUBAGENTS`: a session with this many agents out at once is not a real one.
 * `MAX_PATH`: a `cwd` or `transcript_path` is a key other code looks things up by, so one too
 * long is refused rather than cut to a path that names something else.
 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/
const MAX_SESSIONS = 2000
const MAX_SUBAGENTS = 50
const MAX_PATH = 4096
/** Free text shown on a card (a notification's message, an error): a few lines' worth. */
const TEXT_CAP = 500
/** A name — a tool, an agent type, an event, a failure kind. MCP tool names run long; none this long. */
const NAME_CAP = 200
/** `steps` stops here: far past any real turn, and a number a looping hook cannot grow without end. */
const MAX_STEPS = 99999

/**
 * Also `tool` (`{ sessionId, cwd, tool, input }`) on each `PreToolUse`, and `toolDone`
 * (`{ sessionId, cwd, tools }`) when calls finish, whether they worked or not (`batchTools`).
 *
 * Fires `event` with `{ sessionId, status }` on every write to the store. The push channel
 * (`server/events.mjs`) listens, so a page learns a session moved the moment the session says
 * so rather than on its next poll. The payload is the normalised record's two fields and never
 * the hook event itself: this store is the only place that knows what a hook looks like.
 */
export const hookEvents = new EventEmitter()

/** @type {Map<string, object> | null} sessionId -> record */
let store = null
/**
 * sessionId -> the tools `PreToolUse` named since the session's last `PostToolBatch` or `Stop`,
 * for `toolDone`. The template installs no `PostToolUse` (the table in hooks.md), so a batch's
 * end is the first word that its calls finished. Memory only: lost on a restart, the poll
 * covers it.
 */
const batchTools = new Map()
let flushTimer = null
let writing = Promise.resolve()

async function load() {
  if (store) return store
  // Starts empty rather than failing the scan when the file is unreadable — but set aside
  // first, never left in place to be flushed over a few seconds later. A read that fails
  // outright (permissions, not parsing) starts empty too: live state is rebuilt by the next
  // hook, and nothing here is worth refusing to boot for.
  const raw = await readJsonFile(STORE_FILE, { aside: true }).catch((err) => {
    console.warn(`[outpost] ${err.message}; starting with no hook state`)
    return undefined
  })
  const loaded = new Map()
  const now = Date.now()
  for (const [id, rec] of Object.entries(raw?.sessions || {})) {
    if (rec && typeof rec === 'object' && now - (rec.updatedAt || 0) < TTL_MS) loaded.set(id, rec)
  }
  store = loaded
  return store
}

/**
 * Persist on a timer rather than per event. Writes are chained so two flushes can never
 * interleave their temp file, and a failure is swallowed: losing hook state costs the page
 * some fidelity after a restart, and is never worth taking a request down for.
 */
function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    const sessions = Object.fromEntries(store)
    writing = writing.then(async () => {
      try {
        await fsp.mkdir(DATA_DIR, { recursive: true })
        const tmp = STORE_FILE + '.tmp'
        await fsp.writeFile(tmp, JSON.stringify({ version: 1, sessions }, null, 2))
        await fsp.rename(tmp, STORE_FILE)
      } catch {
        /* see above */
      }
    })
  }, FLUSH_MS)
  flushTimer.unref?.()
}

const str = (v) => (typeof v === 'string' ? v : '')
/** A name from the payload, bounded (`NAME_CAP`). */
const name = (v) => str(v).slice(0, NAME_CAP)

/**
 * Which notification types actually mean "this session cannot go on without you".
 *
 * `idle_prompt` is deliberately *not* in here. Claude Code fires it about a minute after a
 * session goes quiet, which is a minute after every `Stop` — so counting it as waiting
 * converted each finished thread into a `?` of its own accord, `done` survived only in the
 * gap between the two events, and the "need you" counter climbed as the sessions went quiet.
 * The cost of leaving it out: a turn that ends by asking you something reads as done rather
 * than waiting. Claude Code fires no hook that distinguishes the two — a question and a
 * summary both arrive as `Stop` — so the choice is which way to be wrong, and a `?` that
 * means "nobody has typed here lately" is the more expensive one.
 */
const WAITING_NOTIFICATIONS = new Set([
  'permission_prompt',
  'agent_needs_input',
  'elicitation_dialog',
  'elicitation_url_dialog',
])

/**
 * What a dead turn died of, and whether trying again is the answer.
 *
 * `StopFailure` carries the kind in `error` — one of these eleven strings — alongside an
 * optional `error_details`. Three classes are the only distinction anything downstream acts
 * on:
 *
 *   `transient`  the weather, not this session. Nothing about the prompt is wrong and the
 *                same one sent later works. This is the class a restart can fix, so it is
 *                the one resilience automates against.
 *   `account`    no retry helps, and no other session on this machine will fare better: the
 *                credential, the plan or the org is what is wrong.
 *   `turn`       this turn is dead and re-sending it dies the same way. It wants a different
 *                prompt, not another go at the same one.
 *
 * `transient` is *not* "will resume". Claude Code stops the turn either way and fires no
 * hook to say it came back — the claim being made is only that a retry would work. Saying
 * "resuming" of a session that is in fact sitting dead at its prompt is the more expensive
 * lie, because it is the one that stops you going to look. See the decision in hooks.md.
 */
const STOP_FAILURES = {
  rate_limit: { class: 'transient', label: 'Rate limited' },
  overloaded: { class: 'transient', label: 'API overloaded' },
  server_error: { class: 'transient', label: 'API server error' },
  authentication_failed: { class: 'account', label: 'Authentication failed' },
  oauth_org_not_allowed: { class: 'account', label: 'Org not allowed' },
  account_on_hold: { class: 'account', label: 'Account on hold' },
  billing_error: { class: 'account', label: 'Billing problem' },
  invalid_request: { class: 'turn', label: 'Invalid request' },
  model_not_found: { class: 'turn', label: 'Model not found' },
  max_output_tokens: { class: 'turn', label: 'Hit the output limit' },
  unknown: { class: 'turn', label: 'Unknown API error' },
}

/**
 * A kind this table has never heard of — a newer CLI than the one this was read off. Called
 * a turn failure rather than a transient one deliberately: the cost of being wrong that way
 * is a chat that looks worse than it is, and the other way is one that quietly waits
 * for a retry that will never work.
 */
const UNCLASSIFIED = { class: 'turn', label: 'API error' }

/** The kind this event names, and how it is classified. A missing kind is `unknown`, which
 *  is a real entry in the table above — so the two never disagree about what to call it. */
const failureOf = (event) => {
  const kind = name(event.error) || 'unknown'
  return { kind, ...(STOP_FAILURES[kind] || UNCLASSIFIED) }
}

/**
 * The tools whose one-line description is worth keeping beside the name.
 *
 * A session that dispatches an agent reads "Running Agent" for as long as that takes and never
 * says what was delegated — which is the least informative moment on the whole card, because it
 * is also the longest one and the one where the parent has gone quiet. The description is right
 * there in `tool_input` and was being dropped on the floor.
 *
 * `Agent` is what this CLI calls it; `Task` is the older name for the same tool and costs
 * nothing to keep. Deliberately not every tool that carries a `description`: `Bash` has one too,
 * and a card that reads "Running Bash: list the files" for the second a `ls` takes is noise
 * where this is signal. Widening the set means widening it here and nowhere else.
 */
const DESCRIBED_TOOLS = new Set(['Agent', 'Task'])

/** The description this event carries, if the tool is one of the above. First line, bounded. */
function toolDetailOf(event) {
  if (!DESCRIBED_TOOLS.has(name(event.tool_name))) return ''
  const input = event.tool_input
  if (!input || typeof input !== 'object') return ''
  return str(input.description).split('\n')[0].slice(0, 120)
}

/**
 * Which subagents this session still has out, once this event is applied. `[{ id, type }]`.
 *
 * `SubagentStart` and `SubagentStop` bracket every agent a session spawns, and a *background*
 * one outlives the turn that spawned it: Claude Code ends the parent turn, fires `Stop`, and
 * re-invokes the session later when the agent reports. So this list is the only thing that
 * separates "this session finished" from "this session handed the work to something else and
 * stopped talking" — which look identical from every other hook, and which is why a session
 * with a background agent mid-flight used to read `done`, and then `idle` the moment anybody
 * cleared the ✓ it had no business wearing.
 *
 * Tracked by `agent_id` rather than counted, because both payloads carry one: a repeated
 * event cannot then inflate the total, and a stop for an agent nobody recorded is visibly a
 * no-op instead of a decrement that steals a live agent's place. `agent_type` rides along so
 * the card can name what it is waiting on. An agent that arrives with no id — an older CLI
 * than this was read off — falls back to position, oldest out first, which is what counting
 * did and no worse.
 *
 * Drift is the expected failure rather than a surprise: an agent killed mid-run, or one that
 * hits a usage limit, fires no `SubagentStop` at all, and the entry is stuck out. `SessionStart`
 * clears it on the next run, and `liveAgents` drops it an hour after it was last heard from.
 */
function subagentsAfter(event, prev, now) {
  // An entry from before `seenAt` existed is stamped now, so it gets a full hour from here
  // rather than vanishing the moment this shipped.
  const held = liveAgents(
    (Array.isArray(prev.subagents) ? prev.subagents : []).map((a) => (a.seenAt ? a : { ...a, seenAt: now })),
    now,
  )
  const id = name(event.agent_id)
  switch (event.hook_event_name) {
    case 'SubagentStart':
      if (id && held.some((a) => a.id === id)) return held
      // Past the cap a new agent is not tracked rather than an old one dropped: dropping one
      // still out would land a `done` over a session plainly working.
      if (held.length >= MAX_SUBAGENTS) return held
      return [...held, { id, type: name(event.agent_type), seenAt: now }]
    case 'SubagentStop': {
      const at = id ? held.findIndex((a) => a.id === id) : held.findIndex((a) => !a.id)
      // Unknown id: something we never saw start. Dropping the oldest instead would end an
      // agent that is genuinely still out, so leave the list alone and let the TTL clean up.
      if (at === -1) return id ? held : held.slice(1)
      return [...held.slice(0, at), ...held.slice(at + 1)]
    }
    // A started or resumed session is a new process. Whatever the last one had out is gone
    // with it, and carrying the list over would leave the new one unable to finish.
    case 'SessionStart':
      return []
    default: {
      // Anything the agent itself fires — its tool calls arrive under the parent's session id,
      // carrying its `agent_id` — is proof it is still alive.
      const seen = id ? held.map((a) => (a.id === id ? { ...a, seenAt: now } : a)) : held
      // An agent ended by `TaskStop` fires no `SubagentStop` either, and its task id is its
      // `agent_id`. Left in, a chat whose session stopped its own agent read "Waiting on …" for
      // the hour `liveAgents` takes. Dropped on the call, not its result: a stop that fails
      // because the task is already gone means it is not running either way.
      const stopped = stoppedTask(event)
      return stopped ? seen.filter((a) => a.id !== stopped) : seen
    }
  }
}

/** The task a `TaskStop` call is ending, or ''. */
function stoppedTask(event) {
  if (event.hook_event_name !== 'PreToolUse' || str(event.tool_name) !== 'TaskStop') return ''
  const input = event.tool_input
  return input && typeof input === 'object' ? name(input.task_id) : ''
}

/**
 * The agents heard from within `RUNNING_TTL_MS`. A background agent that dies — killed, or out
 * of usage — fires no `SubagentStop`, and the session's TTL never catches it while the parent
 * keeps taking turns: each `Stop` re-reads the dead entry as "Waiting on …" and renews the
 * claim. So each agent ages on its own clock. An agent alive in a single long tool call is
 * silent too, and an hour is the same trade the session's TTL makes.
 */
function liveAgents(list, now) {
  return list.filter((a) => !a.seenAt || now - a.seenAt <= RUNNING_TTL_MS)
}

/**
 * What the session left running in the background, once this event is applied:
 * `[{ id, type, description }]`. A Bash call sent to the background, or one that outran its
 * timeout and was moved there, keeps its process alive after the turn ends: a chat reading
 * done was found holding three cores with greps the session had stopped waiting on
 * (2026-10-14). Nothing in the status says so, and must not: the session is at its prompt.
 *
 * `Stop` carries the CLI's own list (`background_tasks`), so each turn's end replaces this
 * outright rather than it being kept by counting. Between two `Stop`s it only shrinks: the
 * task-notification a finished task wakes the session with arrives as a `UserPromptSubmit`
 * naming its `<task-id>`, and a `TaskStop` or `KillShell` call names the one it ends. A
 * task that starts mid-turn shows from that turn's `Stop`, while the chat already reads
 * working. Agents are left out: `subagents` holds those, and a background one is in both.
 *
 * No hour's ageing, unlike `liveAgents`: a dev server in the background runs for a day, and
 * its turn's `Stop` is the last word on it until the next.
 */
function backgroundAfter(event, prev, now) {
  const held = Array.isArray(prev.backgroundTasks) ? prev.backgroundTasks : []
  switch (event.hook_event_name) {
    case 'SessionStart':
      return []
    case 'Stop': {
      const list = Array.isArray(event.background_tasks) ? event.background_tasks : []
      return list
        .filter((t) => t && typeof t === 'object' && str(t.status) === 'running' && !str(t.type).includes('agent'))
        .slice(0, MAX_SUBAGENTS)
        .map((t) => ({
          id: name(t.id),
          type: name(t.type),
          description: (str(t.description) || str(t.command)).split('\n')[0].slice(0, 120),
          // First seen at a `Stop`, kept across the next ones: the payload carries no start time.
          since: held.find((h) => h.id === name(t.id))?.since || now,
        }))
    }
    case 'UserPromptSubmit': {
      const done = [...str(event.prompt).matchAll(/<task-notification>\s*<task-id>([^<]{1,200})<\/task-id>/g)].map((m) => m[1])
      return done.length ? held.filter((t) => !done.includes(t.id)) : held
    }
    case 'PreToolUse': {
      const input = event.tool_input && typeof event.tool_input === 'object' ? event.tool_input : {}
      const tool = str(event.tool_name)
      const ended = tool === 'TaskStop' ? name(input.task_id) : tool === 'KillShell' ? name(input.shell_id) : ''
      return ended ? held.filter((t) => t.id !== ended) : held
    }
    default:
      return held
  }
}

/**
 * Tool calls since the person last typed, once this event is applied: the chat list's "step N".
 * Counted on `PreToolUse`, which fires once per call; reset by `UserPromptSubmit` and
 * `SessionStart`, the start of a turn and of a process.
 *
 * A subagent's calls count. They arrive under the parent's session id with an `agent_id`, and
 * the Hard rule that keeps those off the parent's *status* is about who needs you — a subagent's
 * prompt is not the parent's. This is about how much has been done on your behalf since you
 * last spoke, and an agent's calls are that work; leaving them out would hold the count still
 * through the longest stretch of a turn, while the parent waits on what it dispatched.
 *
 * A task-notification waking the session arrives as a `UserPromptSubmit` and resets it too: it
 * is a new turn, and its steps are that turn's.
 */
function stepsAfter(event, prev) {
  const held = Number.isInteger(prev.steps) && prev.steps > 0 ? prev.steps : 0
  switch (event.hook_event_name) {
    case 'SessionStart':
    case 'UserPromptSubmit':
      return 0
    case 'PreToolUse':
      return Math.min(held + 1, MAX_STEPS)
    default:
      return held
  }
}

/** What the card says while a turn is held open by the agents it dispatched. */
function waitingOn(subagents) {
  if (subagents.length === 1 && subagents[0].type) return `Waiting on the ${subagents[0].type} subagent`
  return `Waiting on ${subagents.length} subagent${subagents.length === 1 ? '' : 's'}`
}

/**
 * One hook event -> the state it implies, or `null` to leave the state alone and update only
 * the bookkeeping around it. `subagents` is the count `subagentsAfter` just worked out.
 *
 * The trap this avoids: `PostToolUseFailure` fires for a `grep` that matched nothing as
 * readily as for a broken build, and a session that shrugs one off and carries on is not
 * blocked. So a failed tool records an error *string* without claiming the session errored.
 * Only `StopFailure` — where the turn itself died — does that.
 */
function statusFor(event, subagents) {
  switch (event.hook_event_name) {
    case 'SessionStart':
      return 'idle'
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolBatch':
    // Dispatching an agent is work, and the session is working for as long as it is out.
    case 'SubagentStart':
      return 'running'
    // Deliberately no status of its own. The parent is usually woken by the report and will
    // say what it is doing within the second; when the `Stop` it owes was deferred by this
    // very agent, the case below hands back the `done` that was held back. Claiming either
    // from here would be guessing at which.
    case 'SubagentStop':
      return null
    // A subagent's own tool calls and notifications fire under its *parent's* session id
    // (the hard rule above, for `PreToolUse`/`PostToolBatch`) — Claude Code has no other id
    // to put on them. `agent_id` says who this event is really about, and reading either of
    // these as the parent needing you would flag the parent "waiting on you" for a prompt
    // that lives in the subagent's own turn, with nothing pending in the parent's transcript
    // to answer. See the decision below.
    case 'PermissionRequest':
      return str(event.agent_id) ? null : 'waiting'
    case 'Notification':
      return !str(event.agent_id) && WAITING_NOTIFICATIONS.has(str(event.notification_type)) ? 'waiting' : null
    case 'Stop':
      // The parent turn ended, which is only "finished" if nothing it started is still going.
      // A background agent outlives the turn that dispatched it, and the session is working on
      // your behalf until the last one reports — so the `done` is deferred, not dropped.
      return subagents.length ? 'running' : 'done'
    case 'StopFailure':
      // A rate limit and a dead credential are not the same news. `stalled` is the turn that
      // died of something that clears on its own; `error` is the one that needs you.
      return failureOf(event).class === 'transient' ? 'stalled' : 'error'
    case 'SessionEnd':
      return 'ended'
    default:
      return null
  }
}

/**
 * Room for one more session: the store at `MAX_SESSIONS` loses an ended record if it has one,
 * else the one quiet longest. A real session that loses its record this way reads by inference
 * until its next hook writes a new one — the cost of a cap, paid only past it.
 */
function makeRoom() {
  if (store.size < MAX_SESSIONS) return
  let victim = null
  let oldest = Infinity
  for (const [id, rec] of store) {
    if (rec.status === 'ended') {
      victim = id
      break
    }
    if ((rec.updatedAt || 0) < oldest) {
      oldest = rec.updatedAt || 0
      victim = id
    }
  }
  if (victim !== null) {
    store.delete(victim)
    batchTools.delete(victim)
  }
}

/**
 * Record one hook event. Returns the resulting record, or `null` for a payload that is not a
 * hook: no session id, one that is not shaped like one, or a path longer than any real one —
 * see `SESSION_ID` and `MAX_PATH`.
 */
export async function recordHookEvent(event) {
  if (!event || typeof event !== 'object') return null
  const sessionId = str(event.session_id)
  if (!SESSION_ID.test(sessionId)) return null
  if (str(event.cwd).length > MAX_PATH || str(event.transcript_path).length > MAX_PATH) return null

  await load()
  const now = Date.now()
  if (!store.has(sessionId)) makeRoom()
  const prev = store.get(sessionId) || {}
  const subagents = subagentsAfter(event, prev, now)
  const next = statusFor(event, subagents)

  const rec = {
    sessionId,
    status: next || prev.status || 'idle',
    cwd: str(event.cwd) || prev.cwd || '',
    transcriptPath: str(event.transcript_path) || prev.transcriptPath || '',
    lastEvent: name(event.hook_event_name),
    lastEventAt: now,
    updatedAt: now,
    // What it is doing, for the thread card. Cleared on every event that is not a tool call,
    // so a finished session does not sit there claiming it is still running Bash. `toolDetail`
    // is the one-line description of what that call was for, and clears with it — a description
    // outliving the tool it belonged to is worse than none.
    tool: '',
    toolDetail: '',
    message: prev.message || '',
    error: prev.error || '',
    // What the last turn died of, or null. `error` is a string for a person to read and can
    // come from a tool failure too; this is the classified thing, and only `StopFailure`
    // ever sets it.
    failure: prev.failure || null,
    // The agents still out, and whether a `Stop` is owed once the last one lands.
    subagents,
    pendingStop: Boolean(prev.pendingStop),
    // What it left running in the background, for the row's terminal mark (`backgroundAfter`).
    backgroundTasks: backgroundAfter(event, prev, now),
    startedAt: prev.startedAt || now,
    // When the current turn ended, or 0 while one is under way. `done` cannot say it: a person
    // reading the thread turns it `idle` within seconds (`markIdle`), and the routine runner,
    // checking once a minute, then never saw the run finish and waited out its quiet fallback.
    turnEndedAt: prev.turnEndedAt || 0,
    // Tool calls since the person last typed, for the row's "step N" (`stepsAfter`).
    steps: stepsAfter(event, prev),
    // What a `waiting` is waiting on, 'permission' or 'question', so the row can say which
    // without reading the hook (the thread's `ask`). Kept until the next wait sets it again:
    // it is read only while the status is `waiting`, and a `SubagentStop` keeps that status.
    askKind: prev.askKind || '',
  }

  // Any event showing the *parent* itself executing settles a deferred `Stop`: whatever it is
  // doing now will end in a `Stop` of its own. Two things are deliberately not that. `Stop`,
  // which reads `running` only when it is the one doing the deferring. And anything carrying
  // an `agent_id` — a subagent's own tool calls fire `PreToolUse` under its *parent's* session
  // id, and reading those as the parent working threw away the owed `done` on the first thing
  // the agent touched, which is to say almost always.
  if (next === 'running' && !str(event.agent_id) && event.hook_event_name !== 'Stop') rec.pendingStop = false

  switch (event.hook_event_name) {
    case 'SessionStart':
      // A resumed session is a fresh turn's worth of state; nothing before it still holds.
      rec.startedAt = now
      rec.message = ''
      rec.error = ''
      rec.failure = null
      rec.pendingStop = false
      rec.turnEndedAt = 0
      break
    case 'UserPromptSubmit':
      // A new turn: whatever the last one was waiting on, or died of, is over.
      rec.message = ''
      rec.error = ''
      rec.failure = null
      rec.turnEndedAt = 0
      break
    case 'PreToolUse':
    case 'PostToolUse':
      rec.tool = name(event.tool_name)
      rec.toolDetail = toolDetailOf(event)
      // A routine's execution log keeps each call's input (routines.md). Told from here, the
      // one place that reads a payload, and only the input: never `tool_response`.
      if (event.hook_event_name === 'PreToolUse') hookEvents.emit('tool', { sessionId, cwd: rec.cwd, tool: str(event.tool_name), input: event.tool_input })
      break
    case 'PermissionRequest':
      // Only the parent's own dialog belongs on its card — see `statusFor`.
      if (str(event.agent_id)) break
      rec.tool = name(event.tool_name)
      rec.toolDetail = toolDetailOf(event)
      rec.message = 'Needs permission for ' + (rec.tool || 'a tool')
      rec.askKind = 'permission'
      break
    case 'Notification':
      if (next === 'waiting') {
        // PreToolUse has just named the tool the prompt is about; keep it, so the card can say
        // "needs permission for Bash" rather than the generic line. The description goes with
        // it — they are one fact, and splitting them here is how the pair drifts apart.
        rec.tool = prev.tool || ''
        rec.toolDetail = prev.toolDetail || ''
        const text = (str(event.message) || str(event.notification_message)).slice(0, TEXT_CAP)
        rec.message =
          text ||
          (str(event.notification_type) === 'permission_prompt' && rec.tool ? `Needs permission for ${rec.tool}` : 'Waiting on you')
        // Every other waiting type (`agent_needs_input`, the elicitation dialogs) is the session
        // asking for words or a choice, not for leave to run a tool.
        rec.askKind = str(event.notification_type) === 'permission_prompt' ? 'permission' : 'question'
      }
      break
    case 'PostToolUseFailure':
      // Bookkeeping only — see `statusFor`.
      rec.error = str(event.error).slice(0, TEXT_CAP)
      rec.tool = name(event.tool_name)
      rec.toolDetail = toolDetailOf(event)
      rec.status = prev.status || 'running'
      break
    case 'StopFailure': {
      // The kind is in `error`, not `error_type` — reading the field that does not exist is
      // how every failure of every sort read "API error" for its first six months.
      const f = failureOf(event)
      rec.failure = {
        kind: f.kind,
        class: f.class,
        label: f.label,
        // Whatever the API said — the reset time on a rate limit lives in here — for the one
        // place a person can hover it. Bounded like every other free string in this record.
        detail: str(event.error_details).slice(0, TEXT_CAP),
        at: now,
      }
      rec.error = f.label
      rec.message = ''
      break
    }
    case 'Stop':
      rec.message = ''
      rec.error = ''
      rec.failure = null
      if (subagents.length) {
        // Held back rather than shown. The card says what the session is actually doing —
        // "it stopped talking to you because it is waiting on something it dispatched" — and
        // the `done` this event would otherwise have set is owed until the last one lands.
        rec.pendingStop = true
        rec.message = waitingOn(subagents)
      }
      break
    case 'SubagentStop':
      // One in, others still out: the card names what is left. The last one in is below.
      if (rec.pendingStop && subagents.length) rec.message = waitingOn(subagents)
      break
    default:
      break
  }

  // The last agent out is gone — reported in, or aged out by `liveAgents` — and a `Stop` was
  // held waiting for exactly that: the turn that ended really is over. Usually overwritten a
  // second later by the parent waking to read the report — the probe has that arriving as a
  // `UserPromptSubmit` — which is the right way round: a `done` that is briefly premature
  // beats a `running` that outlives the session by an hour.
  // Only over the `running` the deferral set: a parent now asking you something stays asking.
  if (rec.pendingStop && !subagents.length && rec.status === 'running') {
    rec.status = 'done'
    rec.pendingStop = false
    rec.message = ''
    rec.error = ''
    rec.failure = null
  }
  if (rec.status === 'done' && prev.status !== 'done') rec.turnEndedAt = now

  store.set(sessionId, rec)
  scheduleFlush()
  hookEvents.emit('event', { sessionId, status: rec.status })
  // Calls finished, for whatever re-checks what they may have changed (unpushed.mjs). A failure
  // too: a `git commit` whose hook failed can still have left files changed.
  const kind = event.hook_event_name
  if (kind === 'PreToolUse') {
    if (!batchTools.has(sessionId)) batchTools.set(sessionId, new Set())
    batchTools.get(sessionId).add(str(event.tool_name))
  } else if (kind === 'PostToolBatch' || kind === 'Stop' || kind === 'SessionEnd') {
    const tools = [...(batchTools.get(sessionId) || [])]
    batchTools.delete(sessionId)
    if (tools.length) hookEvents.emit('toolDone', { sessionId, cwd: rec.cwd, tools })
  } else if (kind === 'PostToolUse' || kind === 'PostToolUseFailure') {
    hookEvents.emit('toolDone', { sessionId, cwd: rec.cwd, tools: [str(event.tool_name)] })
  }
  return rec
}

/**
 * Outpost itself put the session back at its prompt — a deny, an interrupt — and no hook
 * will say so: Claude Code fires nothing after an interrupted turn, so without this the
 * chat reads `waiting` until the next event, which may be never.
 */
export async function markIdle(sessionId) {
  await load()
  const prev = store.get(sessionId)
  if (!prev) return null
  // `failure` goes with it: every caller of this is a person having dealt with the thread —
  // a deny, an interrupt, marking a finished one read — and a tag still naming last turn's
  // rate limit over a session you have just been in is stale the moment you look at it.
  const rec = {
    ...prev,
    status: 'idle',
    tool: '',
    message: '',
    error: '',
    failure: null,
    // The deferred `Stop` goes too — every caller of this is a person having dealt with the
    // thread, and a `done` owed to a turn they have already answered is news to nobody. The
    // list stays: a background agent Outpost did not start is still out there, and its next
    // tool call is real activity whatever the person just did.
    pendingStop: false,
    lastEvent: 'OutpostAnswered',
    lastEventAt: Date.now(),
    updatedAt: Date.now(),
  }
  store.set(sessionId, rec)
  scheduleFlush()
  hookEvents.emit('event', { sessionId, status: rec.status })
  return rec
}

/**
 * Outpost stopped one of the session's background commands (launchers/tasks.mjs). The CLI wakes
 * the session to say so, and that turn's `Stop` would drop it too; this takes it off the pill now.
 */
export async function dropBackgroundTask(sessionId, taskId) {
  await load()
  const prev = store.get(sessionId)
  if (!prev || !Array.isArray(prev.backgroundTasks)) return null
  const rec = { ...prev, backgroundTasks: prev.backgroundTasks.filter((t) => t.id !== taskId), updatedAt: Date.now() }
  store.set(sessionId, rec)
  scheduleFlush()
  hookEvents.emit('event', { sessionId, status: rec.status })
  return rec
}

/**
 * Outpost stopped one of the session's subagents (`/api/interrupt` with `all`). A stopped agent
 * fires no `SubagentStop`, as one ended by `TaskStop` fires none, and left in it would hold the
 * next `Stop` at "Waiting on …" for the hour `liveAgents` takes.
 */
export async function dropSubagent(sessionId, agentId) {
  await load()
  const prev = store.get(sessionId)
  if (!prev || !Array.isArray(prev.subagents)) return null
  const rec = { ...prev, subagents: prev.subagents.filter((a) => a.id !== agentId), updatedAt: Date.now() }
  store.set(sessionId, rec)
  scheduleFlush()
  hookEvents.emit('event', { sessionId, status: rec.status })
  return rec
}

/**
 * Every session state we hold, keyed by session id, with the stale entries dropped.
 *
 * "Stale" is not one rule. An ended session is gone the moment it says so. A `running` claim
 * that has not been renewed in an hour belongs to a session killed mid-turn — believing it
 * would leave a chat reading `running` forever, which is worse than showing nothing. Everything else just ages out on the TTL.
 */
/**
 * Whether any hook has ever reported this session, ended or stale included. `hookStates` drops
 * both, so its silence cannot tell "no hooks installed" from "reported, then went quiet".
 */
export async function hookEverSeen(sessionId) {
  await load()
  return store.has(sessionId)
}

export async function hookStates() {
  await load()
  const now = Date.now()
  const out = new Map()
  for (const [id, rec] of store) {
    if (rec.status === 'ended') continue
    // Past the TTL it goes from the map too, as `load` would drop it at the next boot: kept,
    // the map only grew between restarts. Ended and stale-running records stay for `hookEverSeen`.
    if (now - (rec.updatedAt || 0) > TTL_MS) {
      store.delete(id)
      continue
    }
    if (rec.status === 'running' && now - (rec.updatedAt || 0) > RUNNING_TTL_MS) continue
    // The same ageing `recordHookEvent` does, for a session that has gone quiet since: an agent
    // dead an hour is not counted above the composer, and a `Stop` held only for it is `done`.
    const subagents = liveAgents(Array.isArray(rec.subagents) ? rec.subagents : [], now)
    if (rec.subagents && subagents.length !== rec.subagents.length) {
      const owed = rec.pendingStop && !subagents.length && rec.status === 'running'
      out.set(
        id,
        owed
          ? { ...rec, subagents, status: 'done', pendingStop: false, message: '', turnEndedAt: rec.turnEndedAt || now }
          : { ...rec, subagents },
      )
      continue
    }
    out.set(id, rec)
  }
  return out
}
