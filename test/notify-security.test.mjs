// A Discord post carries hook and chat text (resilience.md): it may not break out of its quote
// into Outpost's own voice, and no mention in it may ping. discord.mjs imports nothing that
// reads a path, so it is safe to import as is.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { postDiscord, quote } from '../server/notify/discord.mjs'

test('a quote is one line whatever line breaks the text holds', () => {
  assert.equal(quote('Rate limited'), '> Rate limited')
  assert.equal(quote('a\nRestarting automatically at **now**\r\n\nb c'), '> a Restarting automatically at **now** b c')
  assert.equal(quote(undefined), '> ')
})

test('every post tells Discord to parse no mentions, and still sends the embed', async (t) => {
  let sent
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    sent = { url, body: JSON.parse(init.body) }
    return new Response(null, { status: 204 })
  })
  const r = await postDiscord('https://discord.com/api/webhooks/1/x', { title: 'Stalled', description: '@everyone look' })
  assert.deepEqual(r, { ok: true })
  assert.deepEqual(sent.body.allowed_mentions, { parse: [] })
  assert.equal(sent.body.embeds[0].description, '@everyone look')
  assert.equal(sent.body.username, 'Outpost')
})
