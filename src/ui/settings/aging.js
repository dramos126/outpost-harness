/**
 * Settings → Storage and aging: what the disk holds, the three numbers, and Run the pass now.
 */
import { fetchAging, runAgingNow, saveAging } from '../../api.js'
import { when } from '../when.js'

/** The disk's rows, by the field of `/api/aging` each shows; drawn with spinners until the `du` answers. */
const DISK = [
  ['workspacesBytes', 'Workspaces'],
  ['mirrorsBytes', 'Mirrors'],
  ['freeBytes', 'Free on that disk'],
]
const SPIN = '<span class="spin" role="status" aria-label="Measuring"></span>'
const diskRows = (cell) => DISK.map(([key, label]) => `<div class="kv"><span>${label}</span><b>${cell(key)}</b></div>`).join('')

export const html = `
        <section class="group" id="g-aging">
          <h3>Storage and aging</h3>
          <p class="lede">A session quiet for some hours is ended to give its memory back; its chat stays in the list, and your next message resumes it. A chat idle for days is archived. A while after a chat is archived — by that, or by you — its workspace is deleted, and until then it can be restored from Archived. Only a workspace whose every checkout is clean and pushed is deleted. One with unpushed work is kept and says so. The disk budget takes the oldest clean workspaces first.</p>
          <div class="disk">${diskRows(() => SPIN)}</div>
          <div class="aging-last"></div>
          <form class="aging-form">
            <div class="row"><label class="sub"><span>End a quiet session, hours (0 = never)</span><input class="input" name="endIdleHours" size="5" disabled /></label><label class="sub"><span>Archive when idle, days</span><input class="input" name="idleDays" size="5" disabled /></label><label class="sub"><span>Delete, days after archive</span><input class="input" name="deleteDays" size="5" disabled /></label><label class="sub"><span>Disk budget, GB (0 = none)</span><input class="input" name="diskBudgetGB" size="5" disabled /></label></div>
            <div class="row"><button class="btn primary" type="submit" disabled>Save</button><button class="btn ghost" type="button" data-aging="run" disabled>Run the pass now</button></div>
            <div class="state aging-state" data-state="off"></div>
          </form>
        </section>`

export const methods = {
  /**
   * The settings come first and the sizes after: the sizes are a `du` of every workspace,
   * seconds on a full disk, and the fields stayed blank waiting on them. Until the settings
   * answer the form is locked: a blank field saves as 0, so a Save pressed on the empty form
   * turned ending, archiving and the budget off.
   */
  loadAging() {
    this.$('.disk').innerHTML = diskRows(() => SPIN)
    this._agingLock(true)
    fetchAging({ measure: false })
      .then((s) => this.setAging(s))
      .catch(() => {
        // Numbers already on the form (a refresh after a pass) are still the saved ones.
        if (this.$('.aging-form').elements.idleDays.value !== '') this._agingLock(false)
      })
    fetchAging()
      .then((s) => this._agingSizes(s))
      .catch(() => {
        this.$('.disk').innerHTML = diskRows(() => 'Not measured')
      })
  },

  /** The form and the last pass; the sizes are `_agingSizes`, so a late `du` cannot overwrite a field being typed in. */
  setAging(status) {
    this.$('.aging-last').innerHTML = status.lastTickAt ? `<div class="kv"><span>Last pass</span><b>${when(status.lastTickAt)}</b></div>` : ''
    const f = (n) => this.$('.aging-form').elements[n]
    const s = status.settings || {}
    f('endIdleHours').value = String(s.endIdleHours ?? 6)
    f('idleDays').value = String(s.idleDays ?? 14)
    f('deleteDays').value = String(s.deleteDays ?? 5)
    f('diskBudgetGB').value = String(s.diskBudgetGB ?? 0)
    this._agingLock(false)
  },

  _agingSizes(status) {
    const gb = (b) => `${(b / 1073741824).toFixed(b > 10737418240 ? 0 : 1)} GB`
    this.$('.disk').innerHTML = diskRows((key) => gb(status[key] || 0))
    if (status.lastTickAt) this.$('.aging-last').innerHTML = `<div class="kv"><span>Last pass</span><b>${when(status.lastTickAt)}</b></div>`
  },

  _agingLock(locked) {
    for (const el of this.$('.aging-form').elements) el.disabled = locked
  },

  _wireAging() {
    const form = this.$('.aging-form')
    const state = form.querySelector('.aging-state')
    const say = (text, kind = 'off') => {
      state.dataset.state = kind
      state.textContent = text
    }
    const f = (n) => form.elements[n]
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      say('Saving…', 'loading')
      try {
        const res = await saveAging({ endIdleHours: f('endIdleHours').value, idleDays: f('idleDays').value, deleteDays: f('deleteDays').value, diskBudgetGB: f('diskBudgetGB').value })
        this.setAging(res)
        this.onToast('Aging saved')
        say('')
      } catch (err) {
        say(err.message || 'Could not save that', 'err')
      }
    })
    form.querySelector('[data-aging=run]').addEventListener('click', async () => {
      // A pass with deletions takes a minute; the sizes on screen are from before it, and a
      // dimmed button alone read as a pass that had finished and freed nothing.
      say('Running the pass…', 'loading')
      this.$('.disk').innerHTML = diskRows(() => SPIN)
      this._agingLock(true)
      try {
        const r = await runAgingNow()
        if (!r.ok) say(r.error || 'The pass did not run', 'err')
        else {
          const n = (k) => (r[k] || []).length
          say(`Ended ${n('ended')} quiet, archived ${n('archived')}, deleted ${n('deleted')}, kept ${n('kept')} for unpushed work, ${n('budget')} for the budget`, 'on')
        }
      } catch (err) {
        say(err.message || 'The pass did not run', 'err')
      }
      this.loadAging()
    })
  },
}
