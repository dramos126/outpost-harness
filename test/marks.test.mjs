// The shared status marks (src/ui/marks.js): which glyph a status earns, and the slot's HTML.
// Idle, dormant and asleep draw an empty slot so titles still line up beside the marked rows.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GLYPH, markFor, statusMark } from '../src/ui/marks.js'

test('markFor names a glyph only for a state that differs in kind', () => {
  assert.equal(markFor('working'), 'spin')
  assert.equal(markFor('waiting'), 'ask')
  assert.equal(markFor('blocked'), 'error')
  assert.equal(markFor('stalled'), 'paused')
  assert.equal(markFor('done'), 'check')
  for (const s of ['idle', 'sleeping', 'celebrating', '', undefined]) assert.equal(markFor(s), '', String(s))
})

test('statusMark draws the spinner, a glyph, or an empty slot', () => {
  assert.equal(statusMark('working'), '<i class="mark working m-spin"><span class="spin"></span><i class="dot"></i></i>')
  assert.equal(statusMark('waiting'), `<i class="mark waiting m-ask">${GLYPH.ask}</i>`)
  assert.equal(statusMark('idle'), '<i class="mark idle"></i>')
  assert.equal(statusMark(''), '<i class="mark idle"></i>')
})

test('a title is the slot hover, its quotes escaped', () => {
  assert.equal(statusMark('done', 'Say "hi"'), `<i class="mark done m-check" title="Say &quot;hi&quot;">${GLYPH.check}</i>`)
})
