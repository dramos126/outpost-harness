/**
 * Install Outpost's hooks into a repo's `.claude/settings.json`.
 *
 * Merging rather than writing: that file is somebody's actual project configuration, and it
 * may already carry hooks that have nothing to do with us. So every event we touch keeps
 * whatever was there and gains one entry, and an entry we already wrote is updated in place
 * rather than duplicated — running this twice is the same as running it once.
 *
 *   yarn hooks <repo> [--url http://127.0.0.1:5274/api/hook] [--dry-run]
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATE = path.join(here, '..', 'templates', 'hooks', 'settings.json')
const DEFAULT_URL = 'http://127.0.0.1:5274/api/hook'

function parseArgs(argv) {
  const args = { repo: '', url: DEFAULT_URL, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') args.dryRun = true
    else if (a === '--url') args.url = argv[++i] || DEFAULT_URL
    else if (a.startsWith('--url=')) args.url = a.slice(6)
    else if (!args.repo) args.repo = a
  }
  return args
}

/**
 * Ours, and therefore replaceable. Anything else in the array is left strictly alone.
 *
 * Two shapes to recognise, not one: ten events post over `http`, and `SessionStart` shells
 * out to curl because Claude Code never delivers that event to an http hook — see hooks.md.
 * An installed-before-that entry is still ours and still matched, so the upgrade replaces it
 * in place rather than leaving a dead http hook next to the working command one.
 */
const isOurs = (entry) =>
  entry &&
  Array.isArray(entry.hooks) &&
  entry.hooks.some(
    (h) =>
      h &&
      ((h.type === 'http' && typeof h.url === 'string' && h.url.endsWith('/api/hook')) ||
        (h.type === 'command' && typeof h.command === 'string' && h.command.includes('/api/hook')))
  )

/**
 * Point one hook at the chosen endpoint. An http hook carries it in a field; a command hook
 * carries it inside the shell line, where the template's default is the thing to swap out.
 */
function applyUrl(hook, url) {
  if (hook.type === 'command' && typeof hook.command === 'string') {
    hook.command = hook.command.split(DEFAULT_URL).join(url)
    return
  }
  hook.url = url
}

async function main() {
  const { repo, url, dryRun } = parseArgs(process.argv.slice(2))
  if (!repo) {
    console.error('usage: yarn hooks <repo> [--url <endpoint>] [--dry-run]')
    process.exit(1)
  }

  const root = path.resolve(repo)
  const stat = await fsp.stat(root).catch(() => null)
  if (!stat?.isDirectory()) {
    console.error(`Not a directory: ${root}`)
    process.exit(1)
  }

  const template = JSON.parse(await fsp.readFile(TEMPLATE, 'utf8'))
  const settingsPath = path.join(root, '.claude', 'settings.json')

  let settings = {}
  try {
    settings = JSON.parse(await fsp.readFile(settingsPath, 'utf8'))
  } catch (err) {
    // A missing file is the normal case. A malformed one is not something to overwrite:
    // that is somebody's config, and clobbering it is worse than refusing.
    if (err.code !== 'ENOENT') {
      console.error(`Could not read ${settingsPath} — ${err.message}`)
      console.error('Refusing to overwrite it. Fix or move it, then run this again.')
      process.exit(1)
    }
  }

  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {}

  const added = []
  const updated = []
  for (const [event, entries] of Object.entries(template.hooks)) {
    const ours = JSON.parse(JSON.stringify(entries[0]))
    for (const h of ours.hooks) applyUrl(h, url)

    const existing = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []
    const at = existing.findIndex(isOurs)
    if (at === -1) {
      settings.hooks[event] = [...existing, ours]
      added.push(event)
    } else {
      existing[at] = ours
      settings.hooks[event] = existing
      updated.push(event)
    }
  }

  const json = JSON.stringify(settings, null, 2) + '\n'
  if (dryRun) {
    console.log(`--- ${settingsPath} (dry run) ---`)
    console.log(json)
    return
  }

  await fsp.mkdir(path.dirname(settingsPath), { recursive: true })
  await fsp.writeFile(settingsPath, json)

  console.log(`Hooks installed → ${settingsPath}`)
  console.log(`  endpoint: ${url}`)
  if (added.length) console.log(`  added:    ${added.join(', ')}`)
  if (updated.length) console.log(`  updated:  ${updated.join(', ')}`)
  console.log('\nRestart any Claude Code session already running in this repo to pick them up.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
