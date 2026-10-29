/**
 * What `/registerRepo` can read off a repo for its catalogue entry (workspaces.md, *The
 * catalogue*): its setup commands from the lockfiles, and the Environment names its `.env`
 * example lists. Files come through `read(relPath)`, which answers the text or null — the same
 * shape `detectPorts` reads — so this reads a bare mirror with `git show` and runs nothing of
 * the repo's: an unknown repo's scripts run only as setup, once the owner has said yes.
 *
 * A suggestion, shown on a card for the owner to confirm or edit in Settings › Repos.
 */

const parseJson = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * The install commands a repo's lockfiles call for, one per toolchain, in the order a setup
 * runs them. Only a lockfile, or a manifest whose tool has one obvious install, makes a line:
 * a `pyproject.toml` with no lock could mean pip, poetry, hatch or uv, so it makes none.
 */
export async function detectSetup(read) {
  const out = []
  const pkgText = await read('package.json')
  if (pkgText) {
    const pkg = parseJson(pkgText)
    const pm = String(pkg?.packageManager || '')
    if (await read('pnpm-lock.yaml')) out.push('corepack pnpm install --frozen-lockfile')
    else if (await read('yarn.lock')) {
      // A vendored yarn (Outpost's own) is run through node, as the repo pins it; otherwise
      // corepack, `--immutable` on Berry and `--frozen-lockfile` on Classic.
      const yarnPath = /^\s*yarnPath:\s*["']?([^"'\n]+?)["']?\s*$/m.exec((await read('.yarnrc.yml')) || '')?.[1]
      const berry = Boolean(yarnPath) || /^yarn@(?:[2-9]|\d{2,})/.test(pm) || Boolean(await read('.yarnrc.yml'))
      if (yarnPath) out.push(`node ${yarnPath} install --immutable`)
      else out.push(berry ? 'corepack yarn install --immutable' : 'corepack yarn install --frozen-lockfile')
    } else if (await read('package-lock.json')) out.push('npm ci')
    else if (/^pnpm@/.test(pm)) out.push('corepack pnpm install')
    else if (/^yarn@/.test(pm)) out.push('corepack yarn install')
    else out.push('npm install')
  }
  // uv is not a Debian package: installed into the project's venv, which `uv sync` then uses.
  if (await read('uv.lock')) out.push('python3 -m venv .venv && .venv/bin/pip install uv && .venv/bin/uv sync')
  else if (await read('poetry.lock')) out.push('poetry install')
  else if (await read('requirements.txt')) out.push('python3 -m venv .venv && .venv/bin/pip install -r requirements.txt')
  // Gradle and Maven fetch their dependencies; the repo's own wrapper first, since it pins the
  // version the build was written for. No daemon: a setup container is thrown away after.
  const gradle = (await read('build.gradle.kts')) || (await read('build.gradle')) || (await read('settings.gradle.kts')) || (await read('settings.gradle'))
  if (await read('gradlew')) out.push('./gradlew --no-daemon dependencies')
  else if (gradle) out.push('gradle --no-daemon dependencies')
  else if (await read('pom.xml')) out.push((await read('mvnw')) ? './mvnw -B dependency:go-offline' : 'mvn -B dependency:go-offline')
  if (await read('go.mod')) out.push('go mod download')
  if (await read('Cargo.toml')) out.push('cargo fetch')
  if (await read('Gemfile.lock')) out.push('bundle install')
  return out
}

/**
 * The Debian packages the repo's build needs that Outpost's base image (containers/base: Node,
 * git, python3, make, g++) lacks — proposed for the repo's `packages`, which Outpost builds into
 * its chats' image, so a Kotlin repo's setup and chats have a JDK without anyone building an
 * image by hand. Bookworm's names; only what the scan can see.
 */
export async function detectPackages(read) {
  const out = []
  const gradle = (await read('build.gradle.kts')) || (await read('build.gradle')) || (await read('settings.gradle.kts')) || (await read('settings.gradle'))
  const pom = await read('pom.xml')
  if ((await read('gradlew')) || gradle || pom) out.push('openjdk-17-jdk-headless')
  // A build with no wrapper runs the tool itself. Bookworm's Gradle is old (4.4), so a wrapper
  // is what works; Maven's is current enough.
  if (gradle && !(await read('gradlew'))) out.push('gradle')
  if (pom && !(await read('gradlew')) && !gradle && !(await read('mvnw'))) out.push('maven')
  // The base has python3 but neither venv nor pip (Debian splits them out).
  if ((await read('uv.lock')) || (await read('requirements.txt'))) out.push('python3-venv', 'python3-pip')
  else if (await read('poetry.lock')) out.push('python3-poetry')
  if (await read('go.mod')) out.push('golang-go')
  if (await read('Cargo.toml')) out.push('cargo')
  if (await read('Gemfile.lock')) out.push('ruby-full', 'ruby-bundler')
  return out
}

/**
 * The variables a repo's `.env` example names, as Environment entries with no value. Every one
 * is a secret to fill in: an empty plain value would be written to `.env.local` as set, where
 * a secret with no value is left out until it has one (environment.mjs `envVars`). The owner
 * turns the ordinary ones plain in Settings › Repos.
 */
export async function detectEnv(read) {
  for (const name of ['.env.example', '.env.sample', '.env.template', '.env.dist', '.env.local.example']) {
    const text = await read(name)
    if (!text) continue
    const seen = new Set()
    const out = []
    for (const m of text.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]{0,63})\s*=/gm)) {
      if (seen.has(m[1])) continue
      seen.add(m[1])
      out.push({ name: m[1], value: '', secret: true, locked: false })
    }
    return { from: name, env: out }
  }
  return { from: '', env: [] }
}
