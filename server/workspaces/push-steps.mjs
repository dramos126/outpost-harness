/**
 * The steps of a custom push setting: what the owner's sentence ("push to dev, then open a PR
 * to main") becomes once it has been read, and the only shape `pushWork` will carry out.
 *
 * Pure, with no imports, because both config files keep these — `settings.json` for the
 * instance-wide default and `catalogue.json` for a repo's own — and each normalises what it
 * reads. A step that is not one of these shapes is dropped on the way in, so a hand edit or an
 * import can never hand the push tool something it does not know how to do.
 *
 * - `{ kind: 'push', to }` — land the work on a branch: `$MAIN` (the repo's main branch,
 *   whatever it is called), `$WORK` (the work branch under its own name, which every push does
 *   anyway), or a branch by name. `force` is kept only so the Test can refuse it.
 * - `{ kind: 'pr', from, to }` — open a pull request.
 * - `{ kind: 'jenkins', job, params }` — start a Jenkins job; a value may hold `$WORK` or
 *   `$MAIN`.
 * - `{ kind: 'unsupported', text }` — a part of the sentence Outpost has no way to do. Only
 *   ever seen by the Test, which fails on it; never saved.
 */

const str = (v) => (typeof v === 'string' ? v.trim() : '')

/** `$MAIN` and `$WORK` as written, any other name as a branch. */
const branchOf = (v) => str(v)

/**
 * The steps as read, in order, with `$PUSHED` — "the branch that was just pushed" — replaced
 * by the branch the last push step before it names, or the work branch when there is none. So
 * nothing downstream has to track it, and a saved step says which branch it means.
 */
export function normaliseSteps(raw) {
  const out = []
  let pushed = '$WORK'
  const fill = (v) => str(v).replaceAll('$PUSHED', pushed)
  for (const s of Array.isArray(raw) ? raw : []) {
    const kind = str(s?.kind)
    if (kind === 'push') {
      const to = branchOf(s.to) || '$MAIN'
      if (to === '$PUSHED') continue
      out.push({ kind, to, ...(s.force === true ? { force: true } : {}) })
      pushed = to
    } else if (kind === 'pr') {
      out.push({ kind, from: fill(s.from) || pushed, to: fill(s.to) || '$MAIN' })
    } else if (kind === 'jenkins') {
      const params = {}
      for (const [k, v] of Object.entries(s.params && typeof s.params === 'object' ? s.params : {})) {
        if (str(k)) params[str(k)] = fill(String(v ?? ''))
      }
      if (str(s.job)) out.push({ kind, job: str(s.job), params })
      else out.push({ kind: 'unsupported', text: 'a Jenkins job with no name' })
    } else {
      out.push({ kind: 'unsupported', text: str(s?.text) || 'a step Outpost does not know' })
    }
  }
  return out
}

/**
 * A saved custom push, `{ sentence, steps }`, or null for one that cannot be carried out:
 * no sentence, no steps, or a step the Test would have refused.
 */
export function normaliseCustom(raw) {
  const sentence = str(raw?.sentence)
  const steps = normaliseSteps(raw?.steps)
  if (!sentence || !steps.length || steps.some((s) => s.kind === 'unsupported' || s.force)) return null
  return { sentence, steps }
}

/**
 * A step in words, for the Test's list, the push tool's answer and the log. `main` is what
 * `$MAIN` is called where that is known (one repo); "the main branch" where it is not.
 */
export function describeStep(step, { main = '' } = {}) {
  const name = (b) => (b === '$WORK' ? 'the work branch' : b === '$MAIN' ? main || 'the main branch' : b)
  if (step.kind === 'push') {
    if (step.to === '$WORK') return `${step.force ? 'force push' : 'push'} the work branch`
    return `${step.force ? 'force push' : 'push'} to ${name(step.to)}`
  }
  if (step.kind === 'pr') return `open a pull request from ${name(step.from)} to ${name(step.to)}`
  if (step.kind === 'jenkins') {
    const params = Object.entries(step.params || {}).map(([k, v]) => `${k} set to ${name(v)}`)
    return `start the ${step.job} Jenkins job${params.length ? ` with ${params.join(', ')}` : ''}`
  }
  return step.text
}
