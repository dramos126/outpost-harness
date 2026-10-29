/**
 * Settings → General → Containers: how hard the fence around each chat's container is drawn
 * (launchers.md). Three switches and a port range, each with one line of what it does and what
 * to verify once it is on. Every switch applies to chats started or restarted afterwards, never
 * to one already running — said once, below the heading.
 *
 * Each switch moves when the server says it moved, never on the click: `free` Bash is refused
 * unless the mounts are already narrow and the network private (config.mjs guards it), so the
 * toggle has to show the server's truth or it would report a fence that is not there. The
 * private network is the same: the server tries it before saving it, and says why it would not.
 */
import { fetchContainers, saveContainers } from '../../api.js'

export const html = `
        <section class="group" id="g-containers">
          <h3>Containers</h3>
          <p class="lede">Every chat runs in a container of its own. These harden it, in order: narrow what it can write, give it a private network, then let Bash run without asking. Each applies to chats started or restarted after you change it. None can be checked on a machine without Podman, so turn each on and watch one chat before the next.</p>
          <div class="state" data-state="loading">Checking…</div>
          <label class="switch-row">
            <span><b>Narrow what it can write</b><small>A config home of its own; the CLI's hooks, the trust record and other chats' transcripts read-only or hidden; each mirror's git config and hooks read-only. Verify: a chat still starts, commits, and its transcript shows here.</small></span>
            <button class="toggle" role="switch" aria-checked="false" data-containers="mounts"></button>
          </label>
          <label class="switch-row">
            <span><b>Private network</b><small>Its own network namespace; only Outpost's port reaches the host. Verify: the chat still reaches Outpost (it answers prompts) and the internet (an install works), and declared ports open.</small></span>
            <button class="toggle" role="switch" aria-checked="false" data-containers="network"></button>
          </label>
          <label class="switch-row">
            <span><b>Bash without asking</b><small>Only with the two above on. Bash, WebFetch and WebSearch run unprompted inside the fence; the deny list, the approval tool and MCP prompts still work. Verify: a plain command runs with no prompt, and <code>git push</code> is still refused.</small></span>
            <button class="toggle" role="switch" aria-checked="false" data-containers="bash"></button>
          </label>
          <label class="switch-row ports">
            <span><b>Host ports for declared ports</b><small>The range a repo's declared ports are published to, one block for one firewall rule.</small></span>
            <span class="range"><input class="input" name="portFrom" size="6" inputmode="numeric" /> – <input class="input" name="portTo" size="6" inputmode="numeric" /></span>
          </label>
          <div class="row"><button class="btn sm" data-containers="ports">Save range</button></div>
        </section>`

export const methods = {
  _wireContainers() {
    const g = this.$('#g-containers')
    const state = g.querySelector('.state')
    const toggles = { mounts: g.querySelector('[data-containers=mounts]'), network: g.querySelector('[data-containers=network]'), bash: g.querySelector('[data-containers=bash]') }
    const f = (n) => g.querySelector(`input[name=${n}]`)
    // The hardened side of each switch is the "on" position.
    const ON = { mounts: 'narrow', network: 'private', bash: 'free' }
    let cur = { mounts: 'wide', network: 'host', bash: 'ask', portFrom: 41000, portTo: 41999 }
    const paint = (c) => {
      cur = c
      state.dataset.state = c.mounts === 'narrow' && c.network === 'private' ? 'on' : 'off'
      state.textContent = `Mounts ${c.mounts} · network ${c.network} · Bash ${c.bash}`
      for (const [k, el] of Object.entries(toggles)) el.setAttribute('aria-checked', String(c[k] === ON[k]))
      f('portFrom').value = String(c.portFrom)
      f('portTo').value = String(c.portTo)
    }
    const fail = (err) => {
      state.dataset.state = 'err'
      state.textContent = err
    }
    this.loadContainers = () => fetchContainers().then((r) => paint(r.containers)).catch((err) => fail(err.message || 'Could not read the container settings'))
    this.loadContainers()

    g.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-containers]')
      if (!b) return
      const act = b.dataset.containers
      b.disabled = true
      try {
        let next
        if (act === 'ports') next = { ...cur, portFrom: Number(f('portFrom').value), portTo: Number(f('portTo').value) }
        else next = { ...cur, [act]: cur[act] === ON[act] ? { mounts: 'wide', network: 'host', bash: 'ask' }[act] : ON[act] }
        const res = await saveContainers(next)
        paint(res.containers)
        // `free` Bash snaps back to `ask` unless the mounts are narrow and the network private;
        // say why rather than leave a toggle that would not move.
        if (act === 'bash' && next.bash === 'free' && res.containers.bash !== 'free') this.onToast('Narrow the mounts and turn on the private network first')
        // The private network is tried on this machine before it is saved; a refusal carries
        // podman's reason, so the switch stays off with the why beside it rather than silently.
        else if (res.refused) fail(res.refused)
        else this.onToast('Container settings saved — applies to chats started or restarted from now')
      } catch (err) {
        fail(err.message || 'Could not save that')
      } finally {
        b.disabled = false
      }
    })
  },
}
