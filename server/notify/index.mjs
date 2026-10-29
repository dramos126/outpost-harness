/**
 * Telling you about a session when you are not looking at the page.
 *
 * The whole point of the stalled status is the case where you are *not* watching: a rate limit
 * that lands twenty minutes into a long run is precisely the one nobody sees. A toast in a tab
 * that is not in front of anybody is not a notification, so this reaches off the machine.
 *
 * The webhook URL is a credential — anyone holding it can post into that channel as you — so
 * it is a secret in the store (`discord-webhook`, setup.md), like every other credential
 * Outpost holds, and never handed back to the page: the settings UI gets "configured, ending
 * in …abc123" and a box to replace it. Whether restarts are worth a message is a setting, in
 * `settings.json` with the rest, so it travels with an export and the URL is re-entered with
 * the other secrets on a new machine — one list, not two (docs/proposals/settings.md, phase 3).
 *
 * What each event is worth saying is here; how to talk to Discord is `discord.mjs`. A second
 * destination is a sibling of that file and a branch in `deliver`, not a change to any caller.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readJsonFile } from '../lib/fsutil.mjs'
import { readSettings, writeSettings } from '../config.mjs'
import { addToken, removeSecret, tokenValue } from '../secrets/index.mjs'
import { postDiscord, looksLikeWebhook, tablesAsLists, quote, COLOR } from './discord.mjs'

/** Where the webhook used to live, read once to move it into the store and then removed. */
const OLD_FILE = process.env.OUTPOST_NOTIFY || path.join(os.homedir(), '.outpost-notify.json')
/** The secret the webhook URL is kept under. */
export const WEBHOOK_SECRET = 'discord-webhook'

/** Whether the old file has been looked for this run: it is moved once, and then is not there. */
let migrated = false

/**
 * The old file, moved: its URL into the store, its switch into `settings.json`, then the file
 * removed so the credential is not in two places. Done once, on the first read after the
 * upgrade; a file that will not parse is set aside rather than read as "nothing configured",
 * as before.
 */
async function migrate() {
  const raw = await readJsonFile(OLD_FILE, { aside: true }).catch((err) => {
    console.warn(`[outpost] ${err.message}; its webhook was not moved`)
    return undefined
  })
  if (!raw) return
  const url = typeof raw.discordWebhook === 'string' ? raw.discordWebhook.trim() : ''
  if (url && !(await tokenValue(WEBHOOK_SECRET))) await addToken(WEBHOOK_SECRET, url)
  if (raw.onRestart === true) {
    const s = await readSettings()
    await writeSettings({ ...s, notify: { ...s.notify, onRestart: true } })
  }
  await fsp.rm(OLD_FILE, { force: true })
  console.log(`[outpost] moved the Discord webhook from ${OLD_FILE} into the secret store`)
}

/**
 * The webhook and the switch, read each time rather than kept: both are cheap reads of files
 * read on change, and a webhook removed under Keys and tokens has to stop the next message,
 * not the next restart.
 */
async function load() {
  if (!migrated) {
    migrated = true
    await migrate().catch((err) => console.warn(`[outpost] could not move the old webhook file: ${err?.message || err}`))
  }
  return { discordWebhook: await tokenValue(WEBHOOK_SECRET), onRestart: Boolean((await readSettings()).notify?.onRestart) }
}

/**
 * What the page is allowed to know: whether it is set up, and just enough of the URL to
 * recognise which webhook it is. Never the URL.
 */
export async function notifySettings() {
  const c = await load()
  return {
    configured: Boolean(c.discordWebhook),
    hint: c.discordWebhook ? `…${c.discordWebhook.slice(-6)}` : '',
    onRestart: c.onRestart,
  }
}

/**
 * Save the settings. An empty `discordWebhook` clears it; an absent one leaves whatever is
 * stored alone, so the page can toggle `onRestart` without having to hold the credential in
 * order to send it back.
 */
export async function saveNotifySettings({ discordWebhook, onRestart }) {
  await load()
  try {
    if (discordWebhook !== undefined) {
      const url = String(discordWebhook || '').trim()
      if (url && !looksLikeWebhook(url)) {
        return { ok: false, error: 'That does not look like a Discord webhook URL' }
      }
      if (url) await addToken(WEBHOOK_SECRET, url)
      else await removeSecret(WEBHOOK_SECRET).catch(() => {})
    }
    if (onRestart !== undefined) {
      const s = await readSettings()
      await writeSettings({ ...s, notify: { ...s.notify, onRestart: Boolean(onRestart) } })
    }
  } catch (err) {
    return { ok: false, error: `Could not save: ${err?.message || err}` }
  }
  return { ok: true, ...(await notifySettings()) }
}

/** Post a test message, so "configured" can mean "verified" rather than "typed". */
export async function testNotify() {
  const c = await load()
  if (!c.discordWebhook) return { ok: false, error: 'No Discord webhook is configured' }
  return postDiscord(c.discordWebhook, {
    title: 'Outpost is wired up',
    description: 'This is a test message. Stalled sessions and failed restarts will arrive here.',
    color: COLOR.green,
  })
}

/**
 * A time for a reader, not for this process. Discord's `<t:seconds:t>` renders in the timezone
 * of whoever is looking; formatting it here stamps the server's, and this one runs in UTC, so
 * "restarting at 06:44 PM" arrived under a post Discord had already localised to 2:33 PM.
 */
const clock = (ts) => (ts ? `<t:${Math.floor(ts / 1000)}:t>` : '')

/** A name for the session, best effort: the thread's title, else the repo it is in. */
const nameOf = (e) =>
  e.thread?.title || e.label || (e.cwd ? path.basename(e.cwd) : '') || 'A session'

const SUMMARY_MAX = 3500
const summaryOf = (text) => {
  const t = String(text).trim()
  return t.length > SUMMARY_MAX ? `${t.slice(0, SUMMARY_MAX).trimEnd()}…\n\n*The rest is in the chat in Outpost.*` : t
}

const whereOf = (e) => e.thread?.project || (e.cwd ? path.basename(e.cwd) : '')

/**
 * One event -> what to say about it, or `null` for one not worth a message.
 *
 * `restarted` is the only optional one, and it is off by default: on a bad afternoon it is
 * five messages per session saying the machine is handling it, which is exactly the traffic
 * that teaches you to mute a channel — and muting it loses the one message that mattered.
 */
function compose(event, config) {
  const who = nameOf(event)
  const where = whereOf(event)
  const suffix = where ? ` · ${where}` : ''

  switch (event.event) {
    case 'stalled':
      return {
        title: `Stalled — ${event.failure.label}`,
        description: [
          `**${who}**${suffix} stopped mid-turn.`,
          event.failure.detail ? quote(event.failure.detail) : '',
          event.nextAt
            ? `Restarting automatically at **${clock(event.nextAt)}** — ${event.why}.`
            : 'Nothing is scheduled; it needs you.',
        ]
          .filter(Boolean)
          .join('\n\n'),
        color: COLOR.amber,
      }

    case 'broken':
      return {
        title: `Needs you — ${event.failure.label}`,
        description: [
          `**${who}**${suffix} stopped and will not be restarted automatically.`,
          event.failure.detail ? quote(event.failure.detail) : '',
          event.failure.class === 'account'
            ? 'This is your account rather than this session — every session on the machine is affected.'
            : 'Retrying this turn would fail the same way; it needs a different prompt.',
        ]
          .filter(Boolean)
          .join('\n\n'),
        color: COLOR.red,
      }

    case 'restarted':
      if (!config.onRestart) return null
      return {
        title: `Restarted — attempt ${event.attempt} of ${event.max}`,
        description: `**${who}**${suffix} was sent on again after **${event.failure.label}**.`,
        color: COLOR.grey,
        footer: event.manual ? 'You asked for this one' : 'Automatic',
      }

    case 'exhausted':
      return {
        title: `Gave up after ${event.attempts} attempts`,
        description: `**${who}**${suffix} has stalled ${event.attempts} times on **${event.failure.label}**. Outpost will not try again on its own — restart it from the panel when you are ready.`,
        color: COLOR.red,
      }

    // A limit reset with a chat too large to wake by itself (resilience.md): the person chooses
    // between resuming at the price of a full rewrite and starting fresh from the handoff.
    case 'held':
      return {
        title: 'Limit reset — held for you',
        description: `**${who}**${suffix} stopped on **${event.failure.label}**, and the limit has reset. It carries ${Math.round((event.context || 0) / 1000)}k tokens of context, above red, so it was not sent on: resuming rewrites all of it at full price. Resume it, or start it fresh from its handoff, in Outpost.`,
        color: COLOR.amber,
      }

    // A handoff written while the person was away (handoff.md `tellReady`): what asked for it,
    // and that it waits in the chat to start fresh from.
    case 'handoff-ready': {
      const why = { away: 'you went away', idle: 'it sat idle 50 minutes, before its cache expired', limit: 'the plan neared its limit' }[event.trigger] || 'it was asked for'
      return {
        title: 'Handoff ready',
        description: `**${who}**${suffix} wrote its handoff because ${why}${event.how === 'fallback' ? ' — summarised from the transcript, so read it first' : ''}. Start fresh from it in Outpost when you are back.`,
        color: COLOR.green,
      }
    }

    case 'gave-up':
      return {
        title: 'Could not restart',
        description: [`**${who}**${suffix} stalled and Outpost could not send to it.`, quote(event.reason)].join('\n\n'),
        color: COLOR.red,
      }

    // A routine's run ending (routines.md): a `done` says what it changed, a `needs-you` the
    // question it was promoted to a chat with, a failure what stopped it. A `nothing` is never
    // told — a run with nothing to say is the point of a routine.
    case 'routine-ended': {
      const words = { done: 'done', 'needs-you': 'needs you', failed: `failed (${event.reason || 'error'})` }
      return {
        title: `Routine ${words[event.outcome] || event.outcome} — ${event.label}`,
        // The run's own text is the report the owner made the routine for, so it goes in the
        // message; cut to fit under Discord's 4096-character description with room to spare.
        description: event.summary
          ? `**${who}**${event.outcome === 'needs-you' ? ' needs you; it is a chat in Outpost now.' : event.outcome === 'done' ? ' is done.' : ' stopped.'}\n\n${summaryOf(event.summary)}`
          : `**${who}** ${event.outcome === 'done' ? 'is done' : `stopped (${words[event.outcome] || event.outcome})`}. Open it in Outpost to read what it did.`,
        color: event.outcome === 'done' ? COLOR.grey : event.outcome === 'needs-you' ? COLOR.amber : COLOR.red,
      }
    }

    // A Jenkins job has started building a repo that does not name it (jenkins-results.mjs):
    // told once, since what it asks for is the owner's decision and the first chat to want it
    // will ask anyway.
    case 'jenkins-new-job':
      return {
        title: `New Jenkins job — ${event.job}`,
        description: [
          `**${event.job}** builds **${event.label}**, and is not one of its Jenkins jobs yet.`,
          `Its chats can already read its builds, logs and tests. To let them start and stop it, tick it under Tools on ${event.label}'s page in Outpost's Settings › Repos — or say yes when a chat asks.`,
        ].join('\n\n'),
        color: COLOR.grey,
      }

    // A build failed that no chat was waiting on, and its repo asked for a chat to look into
    // it (jenkins-results.mjs `failureChats`): one was started, or the one already on it told.
    case 'jenkins-failure-chat':
      return {
        title: `${event.job} #${event.number} ${String(event.result || 'FAILURE').toLowerCase()} — ${event.again ? 'its chat was told' : 'a chat is looking into it'}`,
        description: event.again
          ? `The chat already looking into **${event.job}** on **${event.label}** has been told of this failure too.`
          : `No chat was waiting on this build, so Outpost started one on **${event.label}** to find out why it failed. It reads and reports; it changes nothing. Open it in Outpost.`,
        color: COLOR.red,
      }

    // A chat's own message, sent with `discord_send` because the person asked it to report
    // there (integrations.md): the chat's words, under its name so a channel of several says who.
    case 'chat-message':
      return {
        title: event.title || `From ${who}`,
        description: summaryOf(tablesAsLists(event.message)),
        color: COLOR.green,
        footer: `${who}${suffix}`,
      }

    case 'routine-failed':
      return {
        title: `Routine could not start — ${event.label}`,
        description: quote(event.error),
        color: COLOR.red,
      }

    default:
      return null
  }
}

/**
 * Raise an event. Never throws and never blocks anything real: every caller is a supervisor
 * or a request handler that has already done the useful part of its job.
 */
export async function notify(event) {
  try {
    const c = await load()
    if (!c.discordWebhook) return { ok: false, error: 'not configured' }
    const message = compose(event, c)
    if (!message) return { ok: true, skipped: true }
    return await postDiscord(c.discordWebhook, message)
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
}
