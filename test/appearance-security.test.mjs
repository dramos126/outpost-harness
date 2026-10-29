// The look is written by the page into CSS custom properties on every open tab (ui.md), so the
// settings file must never hold an accent or a font family wider than a colour or a name: a
// value like `x; background: url(…)` would be a declaration injected into every tab.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-appearance-'))
// Set before config.mjs is imported: catalogue.mjs fixes CONFIG_DIR at import, and the default
// is the owner's real `~/.outpost/config`.
process.env.OUTPOST_CONFIG = tmp
const { readAppearance, readSettings, saveAppearance } = await import('../server/config.mjs')

after(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('nothing saved: the roster carries null and the endpoint the default', async () => {
  assert.equal((await readSettings()).appearance, null)
  assert.deepEqual(await readAppearance(), { preset: 'graphite', accent: '', font: 'system', mono: 'system', width: 'wide' })
})

test('a usable look is kept as given, the accent lower-cased', async () => {
  const saved = await saveAppearance({ preset: 'midnight', accent: '#14B8A6', font: 'Inter', mono: 'JetBrains Mono', width: 'comfortable' })
  assert.deepEqual(saved, { preset: 'midnight', accent: '#14b8a6', font: 'Inter', mono: 'JetBrains Mono', width: 'comfortable' })
  assert.deepEqual((await readSettings()).appearance, saved)
})

test('anything that could carry a declaration falls back to its default', async () => {
  const saved = await saveAppearance({
    preset: 'paper; color: red',
    accent: 'red; background: url(https://example.com/x)',
    font: "Inter', sans-serif; background: url(x); --a: '",
    mono: 'a'.repeat(80),
    width: '100vw; color: red',
  })
  assert.deepEqual(saved, { preset: 'graphite', accent: '', font: 'system', mono: 'system', width: 'wide' })
  const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8'))
  assert.deepEqual(raw.appearance, saved)
})

test('saving the look leaves the other settings alone', async () => {
  const before = await readSettings()
  await saveAppearance({ preset: 'system' })
  const now = await readSettings()
  assert.equal(now.appearance.preset, 'system')
  assert.deepEqual(now.context, before.context)
  assert.deepEqual(now.aging, before.aging)
})
