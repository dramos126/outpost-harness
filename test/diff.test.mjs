// The routine card's line diff (src/ui/diff.js; ui-conversation.md, the routine card): what an
// update changes in a prompt, shown instead of the old and new prompts printed whole.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffLines } from '../src/ui/diff.js'

test('lines kept, removed and added, in order', () => {
  const d = diffLines('one\ntwo\nthree\nfour', 'one\nTWO\nthree\nfour\nfive')
  assert.deepEqual(
    d.map((x) => `${x.op}${x.text}`),
    [' one', '-two', '+TWO', ' three', ' four', '+five']
  )
})

test('a one-paragraph prompt is compared by its sentences', () => {
  const d = diffLines('Read the digest. Update the docs. Push.', 'Read the digest. Update the docs and lint them. Push.')
  assert.deepEqual(
    d.filter((x) => x.op !== ' ').map((x) => `${x.op}${x.text}`),
    ['-Update the docs.', '+Update the docs and lint them.']
  )
})

test('nothing in common: all of one out, all of the other in', () => {
  const d = diffLines('a\nb\nc', 'x\ny\nz')
  assert.equal(d.filter((x) => x.op === '-').length, 3)
  assert.equal(d.filter((x) => x.op === '+').length, 3)
})
