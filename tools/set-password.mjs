/**
 * Set the dashboard's username and password.
 *
 *   yarn passwd                 # prompts for both
 *   yarn passwd --user dave     # prompts for the password only
 *   yarn passwd --logout-all    # keep the password, drop every logged-in device
 *
 * The password is read with echo off and never taken as an argument: an argument is visible
 * in `ps` to every other user on the box, and lands in shell history besides.
 */
import readline from 'node:readline'
import { stdin, stdout } from 'node:process'
import {
  authFilePath,
  configuredUser,
  hasCredentials,
  revokeAllSessions,
  sessionCount,
  sessionDays,
  setPassword,
} from '../server/credentials.mjs'

const ask = (question) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: stdout })
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })

let piped = null
const pipedLines = () =>
  (piped ||= new Promise((resolve, reject) => {
    let data = ''
    stdin.setEncoding('utf8')
    stdin.on('data', (c) => (data += c))
    stdin.on('end', () => resolve(data.split('\n').map((l) => l.trim())))
    stdin.on('error', reject)
  }))

/**
 * Read a line without echoing it. `readline` has no supported way to do this, so the terminal
 * is put in raw mode and the keystrokes are assembled by hand.
 */
function askSecret(question) {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY) {
      // Piped input: hand out one line per call from a single read of stdin. Useful for
      // automation, and honest about the fact that nothing is being hidden. Read once rather
      // than per call because a stream that has already ended never fires 'end' again.
      pipedLines().then((lines) => resolve(lines.shift() ?? ''), reject)
      return
    }
    stdout.write(question)
    let value = ''
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const finish = (fn, value) => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener('data', onData)
      stdout.write('\n')
      fn(value)
    }
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish(resolve, value)
      if (ch === '\u0003') return finish(reject, new Error('cancelled'))
      if (ch === '\u007f' || ch === '\b') {
        value = value.slice(0, -1)
        return
      }
      // Printable only, which also drops the escape sequences an arrow key sends.
      if (ch >= ' ' && ch !== '\u001b') value += ch
    }
    stdin.on('data', onData)
  })
}

function parseArgs(argv) {
  const args = { user: '', logoutAll: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--logout-all') args.logoutAll = true
    else if (a === '--user') args.user = argv[++i] || ''
    else if (a.startsWith('--user=')) args.user = a.slice(7)
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.logoutAll) {
    const n = await revokeAllSessions()
    console.log(`Logged out ${n} device${n === 1 ? '' : 's'}. The password is unchanged.`)
    return
  }

  console.log('\nOutpost — set dashboard password\n')
  if (hasCredentials()) {
    console.log(`  Current user:  ${configuredUser()}`)
    console.log(`  Logged in now: ${sessionCount()} device(s) — changing the password logs them all out\n`)
  }

  const user = args.user || (await ask(`Username${hasCredentials() ? ` [${configuredUser()}]` : ''}: `)) || configuredUser()
  if (!user) {
    console.error('A username is required.')
    process.exit(1)
  }

  const password = await askSecret('Password (not shown): ')
  if (password.length < 8) {
    console.error('\nToo short — use at least 8 characters.')
    process.exit(1)
  }
  const again = await askSecret('Again: ')
  if (password !== again) {
    console.error('\nThose did not match. Nothing was changed.')
    process.exit(1)
  }

  await setPassword(user, password)
  console.log(`\nPassword set for "${user}".`)
  console.log(`  stored: ${authFilePath()}  (hashed with scrypt, mode 600)`)
  console.log(`  a login lasts ${sessionDays()} days, then asks again`)
  console.log('\nA running server picks this up on its own — no restart. Every device that was')
  console.log('logged in is logged out, including this one; open the dashboard and log in again.')
}

main().catch((err) => {
  if (err?.message === 'cancelled') {
    console.log('\nCancelled. Nothing was changed.')
    process.exit(1)
  }
  console.error(err)
  process.exit(1)
})
