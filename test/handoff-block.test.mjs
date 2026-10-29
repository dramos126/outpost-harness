// The handoff's block in the log (ui-conversation.md, state/handoff.js): which state it shows,
// the handoff cut out of the answer that carries it, and its line of section names.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cutHandoff, handoffChoice, handoffSections, handoffState, handoffWaits, unsavedWork } from '../src/state/handoff.js'
import { wantsYou } from '../src/state/threads.js'

test('the state follows the roster, being written first', () => {
  assert.equal(handoffState(null), '')
  assert.equal(handoffState({ handoff: null }), '')
  assert.equal(handoffState({ handoff: { asking: true, at: 1 }, retry: { held: true } }), 'progress')
  assert.equal(handoffState({ handoff: { at: 1 }, retry: { held: true } }), 'held')
  assert.equal(handoffState({ handoff: { away: true } }), 'away')
  assert.equal(handoffState({ handoff: { at: 1, stale: false } }), 'ready')
  assert.equal(handoffState({ handoff: { at: 1, stale: true } }), 'stale')
  assert.equal(handoffState({ handoff: { error: 'no markers' } }), 'error')
})

test('a handoff is cut out of its answer by its nonce, the rest kept', () => {
  const text = 'Committed as 9f8e7d6.\n\n### Handoff · a1b2c3\n### Goal\nShip it.\n### End of handoff · a1b2c3\nThat is all.'
  const cut = cutHandoff(text)
  assert.equal(cut.handoff, '### Goal\nShip it.')
  assert.equal(cut.rest, 'Committed as 9f8e7d6.\n\nThat is all.')
})

test('markers whose nonces differ are not a handoff', () => {
  assert.equal(cutHandoff('### Handoff · a1b2c3\nx\n### End of handoff · ffffff'), null)
  assert.equal(cutHandoff('Just an answer.'), null)
})

test('section names come from headings, else bold leads', () => {
  assert.equal(handoffSections('### Goal\nx\n### Done\ny\n### Next:\nz'), 'Goal · Done · Next')
  assert.equal(handoffSections('**Goal**: x\n**Next**: y'), 'Goal · Next')
  assert.equal(handoffSections('plain text only'), '')
})

test('Hand off asks which way only where the session could be asked', () => {
  const now = Date.now()
  assert.equal(handoffChoice({ canSend: true, contextAt: now - 5 * 60_000 }, now), true)
  assert.equal(handoffChoice({ canSend: true, contextAt: 0 }, now), true)
  assert.equal(handoffChoice({ canSend: true, contextAt: now - 61 * 60_000 }, now), false)
  assert.equal(handoffChoice({ canSend: true, contextAt: now, failure: { label: 'overloaded' } }, now), false)
  assert.equal(handoffChoice({ canSend: false, contextAt: now }, now), false)
})

test('a ready handoff you asked for waits under Needs you until set aside, used or outdated', () => {
  const ready = (h) => ({ handoff: { at: 1, stale: false, asking: false, ...h } })
  assert.equal(handoffWaits(ready({ trigger: 'button' })), true)
  assert.equal(handoffWaits(ready({ trigger: 'away' })), true)
  assert.equal(handoffWaits(ready({ trigger: 'idle' })), false)
  assert.equal(handoffWaits(ready({ trigger: 'limit' })), false)
  assert.equal(handoffWaits(ready({ trigger: 'button', dismissed: true })), false)
  assert.equal(handoffWaits(ready({ trigger: 'button', stale: true })), false)
  assert.equal(handoffWaits({ handoff: { asking: true, trigger: 'button' } }), false)
  assert.equal(wantsYou(ready({ trigger: 'button' }), 'done'), true)
  assert.equal(wantsYou(ready({ trigger: 'idle' }), 'done'), false)
})

test('unsaved work is uncommitted changes, or commits not on the remote', () => {
  assert.equal(unsavedWork(null), false)
  assert.equal(unsavedWork([{ git: null }]), false)
  assert.equal(unsavedWork([{ git: { clean: true, ahead: 0 } }]), false)
  assert.equal(unsavedWork([{ git: { clean: false } }]), true)
  assert.equal(unsavedWork([{ git: { clean: true, ahead: 2, pushed: false } }]), true)
  assert.equal(unsavedWork([{ git: { clean: true, ahead: 2, pushed: true } }]), false)
  assert.equal(unsavedWork([{ git: { exists: false, clean: false } }]), false)
})

test("/away all's toast names the chats it asked or marked, each by id", async () => {
  const { awayLinks } = await import('../src/ui/conversation.js')
  const lines = awayLinks([
    { id: 't1', title: 'Settings', outcome: 'asked' },
    { id: 't2', title: 'Docs', outcome: 'skipped', why: 'below orange' },
    { id: 't3', title: '', outcome: 'refused', why: 'it is busy' },
  ])
  assert.deepEqual(lines, [
    { id: 't1', label: 'Settings — writing its handoff' },
    { id: 't3', label: 'Untitled — could not be asked: it is busy' },
  ])
})
