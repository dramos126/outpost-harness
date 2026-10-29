/**
 * Every name the code uses exists.
 *
 * `yarn typecheck` parses the JavaScript but does not check it (tsconfig.json, `checkJs:
 * false`), and the build bundles whatever parses — so a name that does not exist ships, and
 * fails only when the line runs. 8de25a0 is the case: `${e}` from a Groovy sample sat
 * unescaped inside a template literal in a settings file, threw a ReferenceError as the module
 * loaded, and the whole page drew nothing.
 *
 * Turning `checkJs` on reports hundreds of implicit-`any` complaints that are not faults (the
 * punchlist's ratchet). This takes one class out of that run — "cannot find name" — which in
 * this codebase is always a fault, and was zero errors when it was added. Names Vite fills in
 * at build time (`define` in vite.config.js) are not faults, and are read from there.
 *
 * Without `--strict`, reports and exits 0, like the other checks (checks.md); CI runs it with.
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

const strict = process.argv.includes('--strict')
const NOT_FOUND = /error TS(2304|2552):/

let out = ''
try {
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json', '--checkJs', '--pretty', 'false'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
} catch (err) {
  // tsc exits non-zero on the implicit-`any` noise this check ignores; only its output matters.
  out = String(/** @type {any} */ (err).stdout || '')
}

const defined = new Set([...fs.readFileSync('vite.config.js', 'utf8').matchAll(/\b(__[A-Z0-9_]+__)\s*:/g)].map((m) => m[1]))
const faults = out
  .split('\n')
  .filter((line) => NOT_FOUND.test(line))
  .filter((line) => {
    const name = /Cannot find name '([^']+)'/.exec(line)?.[1]
    return !(name && defined.has(name))
  })

if (!faults.length) {
  console.log('check-names: every name is defined')
  process.exit(0)
}
console.log(`check-names: ${faults.length} name${faults.length === 1 ? '' : 's'} that do not exist — each throws when its line runs:\n`)
for (const line of faults) console.log(`  ${line}`)
process.exit(strict ? 1 : 0)
