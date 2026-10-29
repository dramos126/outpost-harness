/**
 * Model names, for reading and for matching.
 *
 * Two different vocabularies meet in the UI and neither is the other's. A thread's `model` is
 * whatever the transcript recorded — `claude-opus-5`, `claude-haiku-4-5-20251001` — or, for a
 * session that has not answered yet, the alias out of the CLI's settings (`opus[1m]`). The
 * model *picker* speaks in nicknames and blurbs: "Opus (1M context)", "Haiku 4.5 · Fastest for
 * quick answers". Neither is derivable from the other, so this module does the two jobs that
 * need doing across them: print an id, and guess which picker row an id belongs to.
 */

/** `1m` -> `1M`, `200k` -> `200K`. A size suffix reads wrong in lower case. */
const upperSize = (s) => s.replace(/(\d+)\s*([kmb])\b/gi, (_, n, unit) => `${n}${unit.toUpperCase()}`)

/**
 * An id stripped back to the part that names a model: the vendor prefix off the front, the
 * snapshot date off the back, and a `[1m]`-style context suffix set aside. `claude-opus-5` and
 * `opus[1m]` and `claude-haiku-4-5-20251001` all reduce to something comparable with what the
 * picker prints.
 */
function parts(model) {
  const raw = String(model || '').trim()
  const bracket = /^(.*?)\[([^\]]+)\]$/.exec(raw)
  return {
    raw,
    base: (bracket ? bracket[1] : raw)
      .replace(/^claude-/, '')
      .replace(/-\d{8}$/, '')
      .trim(),
    suffix: bracket ? upperSize(bracket[2].trim()) : '',
  }
}

/**
 * A model id as a person would say it: `claude-opus-5` -> `Opus 5`, `claude-fable-5-1` ->
 * `Fable 5.1`, `claude-haiku-4-5-20251001` -> `Haiku 4.5`, `opus[1m]` -> `Opus (1M)`.
 *
 * The date suffix goes because a snapshot date is not what anyone is checking when they glance
 * at a card, and it is the difference between a tag that fits and one that is elided. Anything
 * that does not look like a Claude id at all is printed as it came, since a model this does not
 * recognise is exactly the case where inventing a nicer name would be inventing information.
 */
export function modelLabel(model) {
  const { raw, base, suffix } = parts(model)
  if (!raw) return ''
  if (!base) return raw
  const [family, ...version] = base.split('-')
  if (!/^[a-z]+$/i.test(family)) return raw
  const name = family[0].toUpperCase() + family.slice(1)
  const number = version.join('.')
  return [number ? `${name} ${number}` : name, suffix ? `(${suffix})` : ''].filter(Boolean).join(' ')
}

/** Lower case, letters and digits only — so `Fable 5.1` and `claude-fable-5-1` can be compared. */
const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Which picker row a model id is, if it can be told.
 *
 * The row's *blurb* names the model — "Haiku 4.5 · Fastest for quick answers" — while its
 * label is a nickname that does not ("Haiku", "Default (recommended)"). So the match is made
 * against the blurb up to its first `·`, from either end: an id can be longer than the blurb
 * says (`claude-haiku-4-5-20251001` against "Haiku 4.5") or shorter (`claude-opus-5` against
 * "Opus 5 with 1M context").
 *
 * "Default" is excluded because it is a pointer at another row rather than a model of its own,
 * and it carries that row's blurb — leaving two rows matching, which is how you end up with a
 * tick beside the wrong one. An ambiguous answer is returned as no answer for the same reason:
 * this only ever decides where a tick is drawn, and a tick in the wrong place is worse than
 * none at all.
 */
export function currentModelIndex(models, model) {
  // Keyed off `base`, not the raw id: a blurb never carries the vendor prefix or the snapshot
  // date, so comparing against `claude-opus-5` whole matches nothing at all.
  const want = key(parts(model).base)
  if (!want) return -1
  const hits = []
  ;(models || []).forEach((m, i) => {
    if (/^default\b/i.test(m.label || '')) return
    const blurb = key(String(m.description || '').split('·')[0])
    if (blurb && (blurb.startsWith(want) || want.startsWith(blurb))) hits.push(i)
  })
  return hits.length === 1 ? hits[0] : -1
}
