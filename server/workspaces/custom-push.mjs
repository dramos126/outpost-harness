/**
 * The custom push setting's Test, and the rule that nothing is saved without it
 * (docs/proposals/settings.md, phase 2, question 14).
 *
 * Two halves. `readSentence` has the CLI turn the owner's sentence into steps — one short
 * run with every tool off, so it can read and answer and nothing else. `checkSteps` then asks,
 * with real calls, whether Outpost can do each step: the branch is there or may be made, the
 * push tool allows that target, Jenkins is configured, the job is visible and takes those
 * parameters. The first half is the only part a model has a say in, and what it answers is cut
 * down to the shapes in push-steps.mjs before anything looks at it.
 *
 * A sentence that passes is remembered here, by where it would apply, and `customForSave`
 * hands a save its steps only from that record — the page sends the sentence, never the
 * steps, so what is saved is what was tested.
 */
import os from 'node:os'
import { spawn } from 'node:child_process'
import { listRepos } from './catalogue.mjs'
import { git, validBranchName } from './git.mjs'
import { describeStep, normaliseSteps } from './push-steps.mjs'
import { CLAUDE_BIN, claudeEnv } from '../claude-auth.mjs'
import { githubRepoAccess, githubRepoOf, integrationsView, jenkinsJobParameters, jobAllowed, remoteFor } from '../integrations.mjs'

/** Reading one sentence takes seconds; a run still going after this is not going to answer. */
const READ_TIMEOUT_MS = 90 * 1000
/** A pass is good for a day: long enough to press Save, short enough that what it checked still holds. */
const PASS_TTL_MS = 24 * 60 * 60 * 1000

const SYSTEM = `You turn one sentence, written by the owner of a git repository, into the steps a program will carry out each time a chat's finished work is pushed. You change nothing and run nothing; you only answer, with JSON.

Before any step, the program has already merged the latest main branch into the chat's work branch and pushed the work branch under its own name. Give only what the sentence asks for beyond that, in the order it asks, as steps of these kinds:

- {"kind":"push","to":B} — land the work on branch B. B is "$MAIN" for the repository's main branch, however the sentence calls it ("main", "master", "the main branch"); "$WORK" when the sentence wants only the work branch itself pushed; otherwise the branch's name as written. Add "force":true only when the sentence asks for a force push.
- {"kind":"pr","from":A,"to":B} — open a pull request from branch A into branch B. A is "$PUSHED" unless the sentence names the branch it comes from.
- {"kind":"jenkins","job":J,"params":{"NAME":"value"}} — start the Jenkins job J. A value meaning the branch that was pushed is "$PUSHED", the work branch "$WORK", the main branch "$MAIN"; any other value as written. No parameters is {}.
- {"kind":"unsupported","text":T} — any part of the sentence that is none of the above (running a command, deploying over ssh, deleting a branch, tagging, telling someone), with T that part in the sentence's own words.

Never add a step the sentence does not ask for, and never leave a part of it out: what does not fit is "unsupported". Words like "by default" are not a step. Answer {"steps":[...]} and nothing else.`

const SCHEMA = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['push', 'pr', 'jenkins', 'unsupported'] },
          to: { type: 'string' },
          from: { type: 'string' },
          force: { type: 'boolean' },
          job: { type: 'string' },
          params: { type: 'object' },
          text: { type: 'string' },
        },
        required: ['kind'],
      },
    },
  },
  required: ['steps'],
}

/**
 * Run the CLI once with the sentence on stdin; resolve its stdout. Signed in the way chats are
 * (`env`, claude-auth.mjs), so the reading spends what they spend.
 */
function runCli(args, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, { cwd: os.tmpdir(), env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('it took too long to answer'))
    }, READ_TIMEOUT_MS)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(e.code === 'ENOENT' ? `the ${CLAUDE_BIN} program is not on this machine's PATH` : e.message))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      // The CLI reports a failed run in its JSON as well as its exit code; the JSON says why.
      if (out.trim()) resolve(out)
      else reject(new Error(err.trim().split('\n').slice(-1)[0] || `the CLI exited ${code}`))
    })
    child.stdin.end(input)
  })
}

/**
 * The first half: the sentence as steps. A one-off `claude -p` with no tools at all
 * (`--tools ""`, no MCP servers), no hooks or CLAUDE.md (`--safe-mode`) and nothing written
 * to disk (`--no-session-persistence`) — so it cannot change anything, is not a row in any
 * roster, and is never indexed. It costs a little of the plan's usage each press.
 */
export async function readSentence(sentence) {
  const args = [
    '-p',
    '--safe-mode',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--permission-prompts',
    'none',
    '--model',
    'sonnet',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(SCHEMA),
    '--system-prompt',
    SYSTEM,
    '--tools',
    '',
  ]
  const out = await runCli(args, `The sentence: ${sentence}`, await claudeEnv())
  let answer
  try {
    answer = JSON.parse(out)
  } catch {
    throw new Error('the CLI did not answer in JSON')
  }
  if (answer.is_error) throw new Error(String(answer.result || 'the run failed').slice(0, 300))
  let data = answer.structured_output
  if (!data) {
    const m = /\{[\s\S]*\}/.exec(String(answer.result || ''))
    try {
      data = m ? JSON.parse(m[0]) : null
    } catch {
      data = null
    }
  }
  if (!Array.isArray(data?.steps)) throw new Error('the answer held no steps')
  return normaliseSteps(data.steps)
}

/**
 * What a repo's remote holds right now: its branches and which is main. Asked the way a
 * chat's mirror would be (`remoteFor`), so a pass means the credential a push will use
 * reached it. `{ error }` when it could not be reached.
 */
async function remoteState(repo) {
  try {
    const remote = await remoteFor(repo)
    const out = await git(['ls-remote', '--symref', remote.url, 'HEAD', 'refs/heads/*'], { env: remote.env, timeout: 20000 })
    const heads = new Set([...out.matchAll(/\trefs\/heads\/(\S+)$/gm)].map((m) => m[1]))
    const head = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(out)
    // Whether the token may write, where GitHub can be asked; unknown elsewhere, and the push says.
    let writable = null
    if (remote.via === 'github') writable = (await githubRepoAccess(repo.url)).push
    return { heads, main: repo.baseBranch || (head ? head[1] : ''), writable }
  } catch (err) {
    return { error: err.message }
  }
}

/** One step against one repo: `{ ok, why }`, `why` a reason when it fails and a note when it passes. */
async function checkStep(step, repo, state, ctx) {
  const fail = (why) => ({ ok: false, why })
  const pass = (why = '') => ({ ok: true, why })
  if (step.kind === 'unsupported') return fail('Outpost has no way to do this — a push can land on a branch, open a pull request and start a Jenkins job')

  if (step.kind === 'jenkins') {
    // The same for every repo, so asked of Jenkins once a Test.
    ctx.jenkins ||= new Map()
    if (!ctx.jenkins.has(step.job)) ctx.jenkins.set(step.job, checkJenkins(step))
    const there = await ctx.jenkins.get(step.job)
    if (!there.ok) return there
    // And on this repo's list: a push starts only a job its repo names (integrations-ci.md).
    if (repo && !jobAllowed(step.job, repo.jenkinsJobs)) return fail(`${step.job} is not one of ${repo.name}'s Jenkins jobs — tick it under Tools on the repo's page`)
    return there
  }

  const name = (b) => (b === '$MAIN' ? state?.main || '' : b)
  if (step.kind === 'push') {
    if (step.force) return fail('The push tool never force pushes')
    if (step.to === '$WORK') return pass()
    if (!repo) return (await validBranchName(step.to === '$MAIN' ? 'main' : step.to)) ? pass() : fail(`"${step.to}" is not a name git accepts for a branch`)
    if (state.error) return fail(`${repo.name} could not be reached: ${state.error}`)
    const target = name(step.to)
    if (!target) return fail(`Could not work out ${repo.name}'s main branch`)
    if (!(await validBranchName(target))) return fail(`"${target}" is not a name git accepts for a branch`)
    // The push tool pushes a chat's own work branch, the main branch and a branch the setting
    // names — never another chat's work branch, which is what a name under the template is.
    const prefix = String(repo.branchTemplate || 'outpost/{slug}').split('{')[0]
    if (prefix && target.startsWith(prefix)) return fail(`${target} is named like a chat's work branch (${prefix}…), and the push tool pushes only a chat's own`)
    if (state.writable === false) return fail(`The GitHub token cannot push to ${repo.name}`)
    ctx.made.add(target)
    return state.heads.has(target) ? pass() : pass(`${target} does not exist yet — the first push makes it`)
  }

  if (step.kind === 'pr') {
    if (!(await integrationsView()).github.configured) return fail('GitHub is not configured — paste a token in Settings › Integrations › GitHub')
    if (!repo) return pass()
    if (!githubRepoOf(repo.url)) return fail(`${repo.name} is not on GitHub, so there is nowhere to open a pull request`)
    if (state.error) return fail(`${repo.name} could not be reached: ${state.error}`)
    try {
      await githubRepoAccess(repo.url)
    } catch (err) {
      return fail(`The GitHub token cannot see ${repo.name}: ${err.message}`)
    }
    const [from, to] = [name(step.from), name(step.to)]
    if (from === to) return fail(`A pull request needs two branches, and both of these are ${to}`)
    const there = (b) => b === '$WORK' || state.heads.has(b) || ctx.made.has(b)
    if (!there(to)) return fail(`${to} does not exist, and no step before this one pushes to it`)
    if (!there(from)) return fail(`${from} does not exist, and no step before this one pushes to it`)
    return pass()
  }
  return fail('Outpost does not know this step')
}

async function checkJenkins(step) {
  const fail = (why) => ({ ok: false, why })
  let job
  try {
    job = await jenkinsJobParameters(step.job)
  } catch (err) {
    return fail(err.message)
  }
  if (!job) return fail(`No job "${step.job}" that Outpost's Jenkins login can see`)
  if (!job.buildable) return fail(`${step.job} is disabled in Jenkins`)
  const asked = Object.keys(step.params || {})
  const missing = asked.filter((k) => !job.params.includes(k))
  if (missing.length) return fail(`${step.job} takes no parameter ${missing.join(' or ')} — ${job.params.length ? `it takes ${job.params.join(', ')}` : 'it takes none'}`)
  return { ok: true, why: '' }
}

/**
 * The second half: every step against every repo it would apply to, in order. One repo for a
 * repo's own setting; for the default, each repo that uses the default — a sentence that works
 * for one repo and not another fails, with the repo's name in the reason.
 */
export async function checkSteps(steps, repos) {
  const rows = steps.map((s) => ({ text: describeStep(s), ok: true, why: '' }))
  const ctx = {}
  for (const repo of repos.length ? repos : [null]) {
    const state = repo ? await remoteState(repo) : null
    ctx.made = new Set()
    for (const [i, step] of steps.entries()) {
      if (repos.length === 1 && state?.main) rows[i].text = describeStep(step, { main: state.main })
      const r = await checkStep(step, repo, state, ctx)
      const why = r.why && repos.length > 1 && step.kind !== 'jenkins' && step.kind !== 'unsupported' ? `${repo.name}: ${r.why}` : r.why
      if (!r.ok && rows[i].ok) Object.assign(rows[i], { ok: false, why })
      else if (r.ok && rows[i].ok && why && !rows[i].why.includes(why)) rows[i].why = [rows[i].why, why].filter(Boolean).join('; ')
    }
  }
  return rows
}

/** scope + sentence -> `{ steps, at }`, for the sentences that passed. In memory: a restart asks for the Test again. */
const passes = new Map()
const passKey = (scope, sentence) => `${scope}\n${sentence}`

/** Where a sentence applies: one repo, by its address, or every repo that uses the default. */
export const scopeFor = (repo) => (repo?.url ? `repo:${String(repo.url).trim()}` : 'default')

/**
 * The Test. `repo` is the repo's form as it stands (`{ name, url, auth, baseBranch,
 * branchTemplate }`) for a repo's own setting, or absent for the default. Answers `{ ok,
 * steps: [{ text, ok, why }] }`, or `{ ok: false, error }` when the sentence could not be
 * read at all. Changes nothing but the record of what passed.
 */
export async function testCustomPush({ sentence = '', repo = null } = {}) {
  const said = String(sentence || '').trim()
  if (!said) return { ok: false, error: 'Write what push should do first' }
  if (said.length > 500) return { ok: false, error: 'Keep it to a sentence — 500 characters at most' }
  let steps
  try {
    steps = await readSentence(said)
  } catch (err) {
    return { ok: false, error: `The sentence could not be read: ${err.message}` }
  }
  if (!steps.length) return { ok: false, error: 'Nothing in that sentence is something a push can do' }
  const one = repo?.url ? { name: String(repo.name || '').trim() || 'This repo', url: String(repo.url).trim(), auth: String(repo.auth || ''), baseBranch: String(repo.baseBranch || '').trim(), branchTemplate: String(repo.branchTemplate || '').trim(), jenkinsJobs: Array.isArray(repo.jenkinsJobs) ? repo.jenkinsJobs.map(String) : [] } : null
  const repos = one ? [one] : (await listRepos()).filter((r) => !r.push)
  const rows = await checkSteps(steps, repos)
  const ok = rows.every((r) => r.ok)
  const key = passKey(scopeFor(one), said)
  if (ok) passes.set(key, { steps, at: Date.now() })
  else passes.delete(key)
  return { ok, sentence: said, steps: rows, repos: repos.map((r) => r.name) }
}

/**
 * The `{ sentence, steps }` a save may keep, or a refusal. A sentence already saved there,
 * unchanged, keeps its steps; any other needs a Test that passed on exactly those words.
 */
export function customForSave(scope, sentence, existing) {
  const said = String(sentence || '').trim()
  if (!said) throw new Error('A custom push needs its sentence')
  if (existing?.sentence === said && existing.steps?.length) return existing
  const pass = passes.get(passKey(scope, said))
  if (!pass || Date.now() - pass.at > PASS_TTL_MS) throw new Error('Test this sentence first — a custom push is saved only once its Test passes on the sentence as written')
  return { sentence: said, steps: pass.steps }
}
