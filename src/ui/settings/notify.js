/**
 * Settings → Notifications: the Discord webhook, a test, and the restarts switch.
 *
 * The webhook is write-only — the page is told "configured, ending …abc123" and never the URL
 * (resilience.md) — and the switch moves when the server says it moved, never on the click,
 * because a toggle that slid across on its own would report a preference the supervisor has
 * never heard of.
 */
import { fetchNotify, saveNotify, testNotify } from '../../api.js'

export const html = `
        <section class="group" id="g-notify">
          <h3>Notifications</h3>
          <p class="lede">A stalled session matters most when you are not looking at this page. Paste a Discord webhook and Outpost will tell you there.</p>
          <div class="state" data-state="loading">Checking…</div>
          <input class="hook" type="password" autocomplete="off" spellcheck="false" placeholder="https://discord.com/api/webhooks/…" />
          <div class="row">
            <button class="btn primary" data-notify="save">Save</button>
            <button class="btn" data-notify="test">Send a test</button>
            <button class="btn ghost" data-notify="clear">Clear</button>
          </div>
          <label class="switch-row">
            <span><b>Tell me about restarts</b><small>A message each time Outpost sends a stalled session on again.</small></span>
            <button class="toggle" role="switch" aria-checked="false" data-notify="restarts"></button>
          </label>
        </section>`

export const methods = {
  _wireNotify() {
    const g = this.$('#g-notify')
    const input = g.querySelector('.hook')
    const state = g.querySelector('.state')
    const opt = g.querySelector('[data-notify=restarts]')

    const paint = (s) => {
      state.dataset.state = s.configured ? 'on' : 'off'
      state.textContent = s.configured ? `Configured — webhook ending ${s.hint}` : 'Not configured — nothing is sent anywhere.'
      // Never repopulated with the URL, because the server does not return it. An empty box
      // over a configured webhook means "leave it alone".
      input.value = ''
      input.placeholder = s.configured ? 'Paste a new webhook to replace it' : 'https://discord.com/api/webhooks/…'
      opt.setAttribute('aria-checked', String(Boolean(s.onRestart)))
    }
    const fail = (err) => {
      state.dataset.state = 'err'
      state.textContent = err
    }
    this.loadNotify = () => fetchNotify().then(paint).catch((err) => fail(err.message || 'Could not read the notification settings'))
    this.loadNotify()

    g.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-notify]')
      if (!b) return
      const act = b.dataset.notify
      b.disabled = true
      try {
        if (act === 'save') {
          if (!input.value.trim()) return fail('Paste a webhook URL first')
          const res = await saveNotify({ discordWebhook: input.value.trim() })
          if (!res.ok) return fail(res.error || 'Could not save that')
          paint(res)
          this.onToast('Webhook saved')
        } else if (act === 'clear') {
          const res = await saveNotify({ discordWebhook: '' })
          if (!res.ok) return fail(res.error || 'Could not clear it')
          paint(res)
          this.onToast('Webhook cleared')
        } else if (act === 'test') {
          const res = await testNotify()
          if (!res.ok) return fail(res.error || 'The test message did not go through')
          this.onToast('Test message sent')
        } else if (act === 'restarts') {
          // Sent on its own, with no `discordWebhook` beside it: the server reads an absent one
          // as "leave it alone", which is what lets this be a toggle at all.
          const next = opt.getAttribute('aria-checked') !== 'true'
          const res = await saveNotify({ onRestart: next })
          if (!res.ok) return fail(res.error || 'Could not change that')
          paint(res)
          this.onToast(next ? 'Restarts will be announced' : 'Restarts will not be announced')
        }
      } catch (err) {
        fail(err.message || 'That did not work')
      } finally {
        b.disabled = false
      }
    })
  },
}
