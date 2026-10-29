/**
 * Declared ports for a containerised chat (docs/modules/launchers.md): working out which ports
 * a repo probably serves on (a suggestion for the catalogue form), and handing each declared
 * port a free host port to publish to when a chat starts.
 *
 * A chat on the private network reaches Outpost but nothing a dev server it runs binds is on the
 * host any more — the network is its own. So each port the repo declares is published to a host
 * port from one configured range (`containers.portFrom..portTo`, config.mjs), so one firewall
 * rule covers the lot, and the assignment is kept on the chat's manifest and reused across
 * restarts and resumes (workspaces.md) so a link does not move under the owner.
 */
import net from 'node:net'

/** The most ports a repo may declare: enough for an app, an API and a worker or two, no wall of them. */
export const MAX_PORTS = 5

const PORT_RE = /\b([1-9][0-9]{2,4})\b/

/** A framework's default port when its config or a dev script names it but no number: a good guess. */
const FRAMEWORK_DEFAULTS = [
  { re: /\bvite\b/, port: 5173, label: 'Vite' },
  { re: /\bnext\b/, port: 3000, label: 'Next.js' },
  { re: /\breact-scripts\b/, port: 3000, label: 'React' },
  { re: /\bnuxt\b/, port: 3000, label: 'Nuxt' },
  { re: /\bng serve\b|\@angular/, port: 4200, label: 'Angular' },
  { re: /\bastro\b/, port: 4321, label: 'Astro' },
  { re: /\bremix\b/, port: 3000, label: 'Remix' },
  { re: /\bstorybook\b/, port: 6006, label: 'Storybook' },
  { re: /\bgatsby\b/, port: 8000, label: 'Gatsby' },
  { re: /\bdjango\b|manage\.py runserver/, port: 8000, label: 'Django' },
  { re: /\bflask\b/, port: 5000, label: 'Flask' },
  { re: /\buvicorn\b|\bfastapi\b/, port: 8000, label: 'FastAPI' },
  { re: /\brails\b/, port: 3000, label: 'Rails' },
]

const clamp = (n) => Number.isInteger(n) && n >= 1 && n <= 65535

/** Where a Ktor or Spring Boot app keeps its config: a fixed path, so no listing is needed. */
const JVM_CONFIGS = ['application.conf', 'application.yaml', 'application.yml', 'application.properties'].map((f) => `src/main/resources/${f}`)

/**
 * The config keys that are the server's own port. Only these: a bare `port` is as often a
 * database's or a client's, and a wrong guess publishes a port nothing listens on.
 */
const SERVER_PORT_KEY = /(?:^|\.)(?:deployment|server)\.port$/

/** A port value, bare or as a `${ENV:default}` placeholder's default. */
const portValue = (raw) => Number((/^["']?(?:\$\{\w+:)?(\d{2,5})\b/.exec(String(raw).trim()) || [])[1])

/**
 * `[dottedKey, value]` for each `key = value` / `key: value` line of a HOCON, YAML or properties
 * file, its key prefixed with the blocks it sits in: HOCON nests by `{ }`, YAML by indentation.
 * Enough to tell `ktor.deployment.port` from a database's `port`; not a full parser of either.
 */
function configEntries(text) {
  const out = []
  const braces = []
  const indents = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s(#|\/\/).*$|^\s*(#|\/\/).*$/, '')
    if (!line.trim()) continue
    const indent = /^\s*/.exec(line)[0].length
    while (indents.length && indents[indents.length - 1].indent >= indent) indents.pop()
    const prefix = [...braces, ...indents.map((i) => i.key)].join('.')
    const full = (key) => (prefix ? `${prefix}.${key}` : key)
    const open = /^\s*([\w.-]+)\s*[:=]?\s*\{\s*$/.exec(line)
    const yamlBlock = /^\s*([\w.-]+)\s*:\s*$/.exec(line)
    const pair = /^\s*([\w.-]+)\s*[:=]\s*(.+?)\s*$/.exec(line)
    if (open) braces.push(open[1])
    else if (/^\s*\}\s*$/.test(line)) braces.pop()
    else if (yamlBlock) indents.push({ indent, key: yamlBlock[1] })
    else if (pair) out.push([full(pair[1]), pair[2]])
  }
  return out
}

/** A server started in code: Ktor's `embeddedServer(Netty, port = N)` or `(Netty, N)`, Javalin's `.start(N)`. */
const CODE_PORT_RES = [/embeddedServer\s*\([^)]*?\bport\s*=\s*(\d{2,5})\b/, /embeddedServer\s*\(\s*\w+\s*,\s*(\d{2,5})\b/, /Javalin\b[\s\S]{0,200}?\.start\s*\(\s*(\d{2,5})\s*\)/]

/** Source files that start a JVM server: an entry point's name under `src/main`, a handful at most. */
const ENTRY_FILE = /^src\/main\/(?:kotlin|java)\/(?:.*\/)?(?:\w*Application|Main|App|Server)\.(?:kt|java)$/
const MAX_ENTRY_FILES = 8

/**
 * Likely ports for a repo, from files read through `read(relPath)` (which answers the file's
 * text or null — so this is the same whether the caller reads a working tree or `git show`s a
 * bare mirror), and `list()`, the repo's tracked paths, for files whose path is not fixed (a JVM
 * entry point under its package). Up to `MAX_PORTS`, unique by port, each with a label saying
 * where it was seen. A suggestion only: the owner confirms or edits it in Settings › Repos.
 *
 * Sources, in the order they are trusted: an explicit `EXPOSE` or compose mapping or a `PORT=`
 * in a `.env` example is a real number the repo wrote down; a dev script's `--port N`; a JVM
 * app's config or the port its entry point starts a server on; then a framework default when a
 * tool is named but no number is.
 */
export async function detectPorts(read, list = async () => []) {
  const found = []
  const add = (port, label) => {
    if (!clamp(port) || found.some((f) => f.port === port) || found.length >= MAX_PORTS) return
    found.push({ port, label: String(label).slice(0, 24) })
  }

  // Dockerfile EXPOSE — the port the image itself declares.
  for (const name of ['Dockerfile', 'dockerfile']) {
    const text = await read(name)
    if (!text) continue
    for (const m of text.matchAll(/^\s*EXPOSE\s+([0-9\s]+)/gim)) for (const p of m[1].split(/\s+/)) if (p) add(Number(p), 'Docker EXPOSE')
  }
  // Compose: the container side of a `"host:container"` mapping (or a bare port).
  for (const name of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    const text = await read(name)
    if (!text) continue
    for (const m of text.matchAll(/-\s*["']?(?:\d+:)?(\d{2,5})(?:\/\w+)?["']?\s*$/gim)) add(Number(m[1]), 'compose')
  }
  // `.env` examples: a `PORT=` or `*_PORT=` the repo ships.
  for (const name of ['.env.example', '.env.sample', '.env.defaults', '.env', '.env.local.example']) {
    const text = await read(name)
    if (!text) continue
    for (const m of text.matchAll(/^\s*([A-Z0-9_]*PORT)\s*=\s*["']?(\d{2,5})/gim)) add(Number(m[2]), m[1])
  }
  // package.json dev/start scripts: an explicit `--port N` / `-p N` / `PORT=N`, else a framework.
  const pkgText = await read('package.json')
  if (pkgText) {
    let pkg
    try {
      pkg = JSON.parse(pkgText)
    } catch {
      pkg = null
    }
    for (const [name, cmd] of Object.entries(pkg?.scripts || {})) {
      if (!/^(dev|start|serve|preview)\b/.test(name) && !/dev|serve|preview/.test(String(cmd))) continue
      const line = String(cmd)
      const explicit = /(?:--port[=\s]+|-p[=\s]+|PORT=)(\d{2,5})/i.exec(line)
      if (explicit) add(Number(explicit[1]), `${name} script`)
      else for (const f of FRAMEWORK_DEFAULTS) if (f.re.test(line)) add(f.port, f.label)
    }
  }
  // Ktor / Spring Boot: the server port in its config, else where the entry point starts one.
  for (const name of JVM_CONFIGS) {
    const text = await read(name)
    if (!text) continue
    for (const [key, value] of configEntries(text)) if (SERVER_PORT_KEY.test(key)) add(portValue(value), key)
  }
  const entries = (await list().catch(() => [])).filter((p) => ENTRY_FILE.test(p)).slice(0, MAX_ENTRY_FILES)
  for (const name of entries) {
    const text = await read(name)
    if (!text) continue
    for (const re of CODE_PORT_RES) {
      const m = re.exec(text)
      if (m) add(Number(m[1]), name.split('/').pop())
    }
  }
  // Vite / Next config, or a JVM framework's default, left as a last resort when nothing above said a number.
  if (!found.length) {
    const build = [await read('build.gradle.kts'), await read('build.gradle'), await read('pom.xml')].filter(Boolean).join('\n')
    if (/\bio\.ktor\b/.test(build)) add(8080, 'Ktor')
    else if (/spring-boot/.test(build)) add(8080, 'Spring Boot')
    for (const [name, def] of [['vite.config.js', { port: 5173, label: 'Vite' }], ['vite.config.ts', { port: 5173, label: 'Vite' }], ['next.config.js', { port: 3000, label: 'Next.js' }]]) {
      const text = await read(name)
      if (!text) continue
      const m = PORT_RE.exec((/\bport\b\s*[:=]\s*(\d{2,5})/i.exec(text) || [])[0] || '')
      add(m ? Number(m[1]) : def.port, def.label)
    }
  }
  return found
}

/** Whether a host port can be bound right now on all interfaces: a cheap, honest check. */
function free(port) {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.once('listening', () => s.close(() => resolve(true)))
    s.listen(port, '0.0.0.0')
  })
}

/**
 * Give each internal port a host port from `[from, to]`, skipping any in `used` (host ports other
 * chats hold) and any the machine will not let us bind. `have` is the chat's existing assignment
 * `{ internal: host }`, reused so a restart keeps a port's link stable. Answers
 * `{ assigned: { internal: host }, exhausted: [internal…] }` — `exhausted` when the range ran out.
 */
export async function assignHostPorts(internals, { from, to, used = new Set(), have = {} }) {
  const assigned = {}
  const taken = new Set(used)
  const exhausted = []
  for (const internal of [...new Set(internals)]) {
    if (have[internal] && !taken.has(have[internal])) {
      assigned[internal] = have[internal]
      taken.add(have[internal])
      continue
    }
    let got = 0
    for (let p = from; p <= to; p++) {
      if (taken.has(p)) continue
      if (await free(p)) {
        got = p
        break
      }
    }
    if (got) {
      assigned[internal] = got
      taken.add(got)
    } else exhausted.push(internal)
  }
  return { assigned, exhausted }
}
