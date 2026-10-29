/**
 * Settings › General › Export and import: the catalogue and settings out as a file, and in
 * from one. It was "Moving house", which said where you might be going rather than what the
 * two buttons do.
 */
import { exportSetup, importSetup } from '../../api.js'

export const html = `
        <section class="group" id="g-setup">
          <h3>Export and import</h3>
          <p class="lede">The catalogue and these settings export as one file and import on another Outpost. Secrets never do: they are named, not carried. After an import this says what the new machine still needs, and where each is entered; About this machine keeps the list.</p>
          <div class="row"><button class="btn" data-setup="export">Export setup</button><label class="btn ghost">Import setup<input type="file" accept="application/json" hidden name="import" /></label></div>
          <div class="row lock-confirm" hidden><label class="sub grow"><span>This import changes a locked variable — your Outpost password to confirm</span><input class="input" name="lockPassword" type="password" autocomplete="current-password" /></label><button class="btn" data-setup="confirm">Import</button></div>
          <div class="state setup-state" data-state="off"></div>
          <div class="setup-missing"></div>
        </section>`

export const methods = {
  _wireSetup() {
    const g = this.$('#g-setup')
    const state = g.querySelector('.setup-state')
    const say = (text, kind = 'off') => {
      state.dataset.state = kind
      state.textContent = text
    }
    g.querySelector('[data-setup=export]').addEventListener('click', async () => {
      try {
        const data = await exportSetup()
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = `outpost-setup-${new Date().toISOString().slice(0, 10)}.json`
        a.click()
        setTimeout(() => URL.revokeObjectURL(a.href), 2000)
        say(`Exported ${data.catalogue.repos.length} repo${data.catalogue.repos.length === 1 ? '' : 's'} and ${data.settings.environments.length} environment${data.settings.environments.length === 1 ? '' : 's'}`, 'on')
      } catch (err) {
        say(err.message || 'Could not export', 'err')
      }
    })
    // A file that changes a locked variable of a repo already here is refused until the owner's
    // password comes with it (setup.md), asked for as the repo page's Environment asks: the
    // field opens under the buttons, and Import sends the same file again with it.
    const lock = g.querySelector('.lock-confirm')
    const lockPassword = g.querySelector('input[name=lockPassword]')
    let pending = null
    const run = async (payload) => {
      try {
        const res = await importSetup(payload)
        if (!res.ok) return say(res.error || 'Could not import', 'err')
        pending = null
        lock.hidden = true
        lockPassword.value = ''
        this.onCatalogue(res.repos || [])
        this.setEnvironments(res.settings?.environments || [])
        say(`Imported ${res.repos.length} repo${res.repos.length === 1 ? '' : 's'} and ${res.settings.environments.length} host${res.settings.environments.length === 1 ? '' : 's'}.`, 'on')
        g.querySelector('.setup-missing').innerHTML = this.missingHtml(res.missing || [])
        this.checkMachine()
      } catch (err) {
        if (pending && /locked variable/i.test(err.message || '')) {
          lock.hidden = false
          lockPassword.value = ''
          lockPassword.focus()
        }
        say(err.message || 'That file is not a setup export', 'err')
      }
    }
    const confirmImport = () => pending && lockPassword.value && run({ ...pending, password: lockPassword.value })
    g.querySelector('[data-setup=confirm]').addEventListener('click', confirmImport)
    lockPassword.addEventListener('keydown', (e) => e.key === 'Enter' && confirmImport())
    g.querySelector('input[name=import]').addEventListener('change', async (e) => {
      const file = e.target.files?.[0]
      if (!file) return
      lock.hidden = true
      lockPassword.value = ''
      try {
        pending = JSON.parse(await file.text())
      } catch (err) {
        pending = null
        say(err.message || 'That file is not a setup export', 'err')
        return
      } finally {
        e.target.value = ''
      }
      await run(pending)
    })
  },
}
