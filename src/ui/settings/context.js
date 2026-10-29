/**
 * Settings → Context: when the conversation header calls a chat's context large. Four numbers
 * and a Save. The shares are fractions on the server and percents here, because "50" is what
 * a person types; the server refuses nothing, it keeps the default for a number it cannot use.
 */
import { fetchContextLimits, saveContextLimits } from '../../api.js'

export const html = `
        <section class="group" id="g-context">
          <h3>Context</h3>
          <p class="lede">Every message re-sends the whole conversation, so a long chat costs more with each one. The size in a chat's header turns orange, then red, at whichever of these it reaches first. Red also lights up Compact.</p>
          <form class="context-form">
            <div class="row"><label class="sub"><span>Orange from, tokens</span><input class="input" name="warnTokens" size="8" inputmode="numeric" /></label><label class="sub"><span>or % of the window</span><input class="input" name="warnShare" size="4" inputmode="numeric" /></label></div>
            <div class="row"><label class="sub"><span>Red from, tokens</span><input class="input" name="alertTokens" size="8" inputmode="numeric" /></label><label class="sub"><span>or % of the window</span><input class="input" name="alertShare" size="4" inputmode="numeric" /></label></div>
            <div class="row"><button class="btn primary" type="submit">Save</button></div>
            <div class="state context-state" data-state="off"></div>
          </form>
        </section>`

export const methods = {
  setContextLimits(limits) {
    const f = (n) => this.$('.context-form').elements[n]
    f('warnTokens').value = String(limits.warnTokens)
    f('warnShare').value = String(Math.round(limits.warnShare * 100))
    f('alertTokens').value = String(limits.alertTokens)
    f('alertShare').value = String(Math.round(limits.alertShare * 100))
  },

  _wireContextLimits() {
    const form = this.$('.context-form')
    const state = form.querySelector('.context-state')
    const say = (text, kind = 'off') => {
      state.dataset.state = kind
      state.textContent = text
    }
    // "200,000" and "50%" are how the numbers get typed; read as NaN they would quietly save the default.
    const f = (n) => Number(form.elements[n].value.replace(/[\s,_%]/g, ''))
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      try {
        const res = await saveContextLimits({
          warnTokens: f('warnTokens'),
          warnShare: f('warnShare') / 100,
          alertTokens: f('alertTokens'),
          alertShare: f('alertShare') / 100,
        })
        this.setContextLimits(res.limits)
        this.onToast('Context thresholds saved')
        say('')
      } catch (err) {
        say(err.message || 'Could not save that', 'err')
      }
    })
  },
}
