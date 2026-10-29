/**
 * Outpost commands that hand a session a playbook: `/createRoutine` in the message box sends
 * the person's words with a lead alone, how to draft a routine from the conversation (routines-tools.md);
 * `/securityAudit` copies a vendored skill into the chat's workspace and points at it. The doc travels only
 * when asked for, never as standing text — a Claude skill's description would be carried by
 * every request of every session (docs/architecture.md, a feature pays for its tokens).
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * A fixed map, as `/api/context`'s is: the page names a command, never a file. `doc` is optional.
 * `skill` is a folder copied to `<workspace>/<into>/skill` on every send, so an update reaches the
 * next run; `{dir}` in its lead is `<workspace>/<into>`, and it needs a workspace chat.
 */
const COMMANDS = {
  createRoutine: {
    lead:
      'The person sent /createRoutine: draft a routine from this conversation — a short name; when it runs (cron or once, in the person\'s timezone); ' +
      'a gate (run only if a chat was active or main moved on given repos), or none; a few steps, a short title and a line of detail each; the repos it needs; ' +
      'and the prompt a run is given, written to stand alone, since the run sees none of this conversation. ' +
      'Ask only what you cannot tell from the conversation, then call routine_create; the person approves it on Outpost\'s bar. The words after the command are how the person wants it.',
  },
  securityAudit: {
    skill: 'vendor/security-audit',
    into: 'security-audit',
    lead:
      "The person sent /securityAudit: run a full audit of this chat's repo in the full audit mode of Cloudflare's security-audit skill — read {dir}/skill/SKILL.md and follow it. " +
      'With several repos, ask which unless the words after the command name one; those words are also the scope and profile, standard on the whole repo when they say none. ' +
      'Write the run to {dir}/runs/<repo-name>/run-<N>, outside every checkout. ' +
      "This container is not the sandbox the skill requires: run none of the target's code, and record each check that needed it as needs_validation. " +
      'With no node for its validators, record the run incomplete and say why.',
  },
}

/** A command's lead, for the token budget (tokens.ts): sent only when the person types it. */
export const commandLead = (command) => COMMANDS[command]?.lead || ''

/** Whether a command copies a skill into the chat's workspace, so a chat without one cannot take it. */
export const commandNeedsWorkspace = (command) => Boolean(Object.hasOwn(COMMANDS, command) && COMMANDS[command].skill)

/**
 * The message for an Outpost command: its lead and doc as a reminder, then what the person typed.
 * Null for an unknown command. `workspaceDir` is where a skill is copied; the caller checks
 * `commandNeedsWorkspace` first.
 */
export async function outpostCommandText(command, said, { workspaceDir = '' } = {}) {
  const c = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null
  if (!c) return null
  let lead = c.lead
  if (c.skill) {
    const dir = path.join(workspaceDir, c.into)
    // Replaced whole: a file dropped upstream must not linger from an earlier copy.
    await fsp.rm(path.join(dir, 'skill'), { recursive: true, force: true })
    await fsp.cp(path.join(here, '..', c.skill), path.join(dir, 'skill'), { recursive: true })
    lead = lead.replaceAll('{dir}', dir)
  }
  const doc = c.doc ? (await fsp.readFile(path.join(here, '..', c.doc), 'utf8')).trim() : ''
  return `<system-reminder>${[lead, doc].filter(Boolean).join('\n\n')}</system-reminder>\n\n${String(said || `/${command}`).trim()}`
}
