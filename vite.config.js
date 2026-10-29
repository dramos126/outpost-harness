import { execFileSync } from 'node:child_process'
import { defineConfig } from 'vite'
import { apiMiddleware } from './server/api.mjs'
import { BIND_HOST, PORT, TOKEN, assertSafeBind, accessUrl, passwordAuthEnabled, setupRequired } from './server/auth.mjs'

assertSafeBind()

/** Serves /api from inside the Vite dev server, so `npm run dev` is the whole game. */
const api = () => ({
  name: 'outpost-api',
  configureServer(server) {
    server.middlewares.use((req, res, next) => (req.url?.startsWith('/api/') || req.url === '/mcp' ? apiMiddleware(req, res, next) : next()))

    // Vite prints its own Local/Network lines, and neither carries the token — so following
    // them lands on a dashboard that 401s and looks broken. `npm run serve` already prints
    // the working link; the dev server is the one people actually start, so it has to too.
    server.httpServer?.once('listening', () => {
      // Setup mode counts: its link is the only way to set the first password, and a dev
      // server that printed nothing left a fresh box with a page that says "find the link".
      const gated = TOKEN || passwordAuthEnabled() || setupRequired()
      if (gated) console.log(`\n  Outpost → ${accessUrl()}`)
      if (passwordAuthEnabled()) console.log('  Password auth is on — the page will ask you to log in.')
      if (setupRequired()) console.log('  No password yet. Open that link once to set one; nothing else answers until you do.')
      if (TOKEN) console.log('  Token auth is on. Open that link once; the page remembers it.')
      if (gated) console.log('')
    })
  },
})

/**
 * One id per build, in two places: compiled into the page as `__OUTPOST_BUILD__`, and written
 * to `dist/build.json` for the server to hand out with the roster. A tab left open across a
 * deploy is running the last build's page against the new server and nothing on screen says
 * so; the two ids disagreeing is how it finds out. The dev server compiles in an empty one,
 * which the page reads as "never stale" — a `dist/` left over from an old build would
 * otherwise tell every dev page it was out of date.
 */
const BUILD = Date.now().toString(36)
/**
 * The commit the page is built from, for the footer's version line: `package.json` says 1.0.0
 * for every build, so the commit is what names one. Its subject rides in `build.json` only, for
 * an older page's hover on what the new one brings. '' outside a git checkout.
 */
const git = (...args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}
const COMMIT = git('rev-parse', '--short', 'HEAD')
const SUBJECT = git('log', '-1', '--format=%s')
const build = () => ({
  name: 'outpost-build',
  apply: 'build',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'build.json', source: JSON.stringify({ build: BUILD, commit: COMMIT, subject: SUBJECT }) + '\n' })
  },
})

export default defineConfig(({ command }) => ({
  plugins: [api(), build()],
  define: { __OUTPOST_BUILD__: JSON.stringify(command === 'build' ? BUILD : ''), __OUTPOST_COMMIT__: JSON.stringify(command === 'build' ? COMMIT : '') },
  server: {
    // PORT and OUTPOST_HOST let a second copy run alongside the first, and let the VM serve
    // the LAN. Both are read in `server/auth.mjs`, which is also what refuses to bind wide
    // without a token.
    port: PORT,
    // Two things the defaults get wrong for us, both because hooks post to a *hardcoded*
    // address, which makes it part of the contract rather than a convenience:
    //
    //   host: Vite's default `localhost` resolves to `::1` alone on some machines, and a
    //     server reachable only over IPv6 refuses every hook — and every browser that
    //     prefers IPv4 — while looking perfectly healthy in the terminal.
    //   strictPort: drifting to 5275 when 5274 is taken is worse than not starting. Every
    //     hook would quietly fail against the old address and every chat would just look
    //     dead, with nothing on screen to say why.
    host: BIND_HOST,
    strictPort: true,
  },
  build: { target: 'esnext' },
}))
