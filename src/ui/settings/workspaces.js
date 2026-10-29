/**
 * Settings → Workspaces: the workspaces waiting on a person's decision, which nothing else on
 * the page reaches or acts on, so unseen they live for good (ui-settings.md *Workspaces*).
 *
 * - Without a chat: a ready workspace the roster carries no thread for, which the chat list stops
 *   showing two minutes after its launch (chats.md). Chat 2a862bbc lost its transcript, its
 *   thread went with the hook entry, and its workspace could then be deleted only over the API.
 * - Kept: every chat archived, and aging refused the delete (aging.md) — unpushed or uncommitted
 *   work, or a checkout that is no longer a repo. One row per workspace: several archived chats
 *   share one, and the Archived list's rows are chats.
 *
 * `heldWorkspaces` decides both, for these lists and for the badges main.js draws from every
 * roster, so the count and the lists cannot disagree. Delete is two presses, the second forced:
 * each row already lists what the delete loses.
 */
import { deleteWorkspace, fetchHeldWork, fetchThreads } from '../../api.js'
import { when } from '../when.js'
import { escape } from './escape.js'

export const html = `
        <section class="group" id="g-stranded">
          <h3>Without a chat</h3>
          <p class="lede">A workspace whose chat no longer shows in the list: its session never wrote a conversation, or the conversation is gone.</p>
          <div class="ws-list" data-list="stranded"></div>
        </section>
        <section class="group" id="g-kept">
          <h3>Archived, kept</h3>
          <p class="lede">Every chat archived, but aging will not delete the workspace: it holds work that is not pushed, or a checkout it cannot read. It stays until you push it from its chat or delete it here.</p>
          <div class="ws-list" data-list="kept"></div>
        </section>`

/** A launch younger than this still shows in the chat list as starting (chats.md). */
const STARTING_MS = 120000

/** The workspaces waiting on a decision: `{ stranded, kept }`, from one roster. */
export function heldWorkspaces(threads = [], workspaces = [], now = Date.now()) {
  const mine = new Map()
  for (const t of threads) {
    const id = t.workspace?.id
    if (id) mine.set(id, [...(mine.get(id) || []), t])
  }
  // A routine's run is meant to have no chat (routines.md): hidden while it runs and when it
  // ends with nothing to say, then deleted on a timer. It is a decision only once aging has
  // kept it for the work it holds.
  const quietRun = (w) => Boolean(w.routine?.id) && !w.aging?.kept
  // A routine's defining chat (`defines`, routines.md) is the Routines tab's: a draft whose session
  // has not spoken yet is its Draft row there, not a workspace stranded here.
  const stranded = workspaces.filter((w) => !mine.has(w.id) && !quietRun(w) && !w.defines && w.status === 'ready' && now - (w.launch?.at || w.createdAt || 0) >= STARTING_MS)
  const kept = workspaces.filter((w) => w.aging?.kept && !w.defines && mine.has(w.id) && mine.get(w.id).every((t) => t.archived))
  return { stranded, kept, chatsOf: (id) => mine.get(id) || [] }
}

/** What a checkout holds that a delete would lose, in a few words, or `''`. */
function atRisk(repo) {
  const g = repo.git
  if (!g) return ''
  if (g.broken) return 'checkout is no longer a git repo'
  if (!g.clean) return `${g.changed} uncommitted file${g.changed === 1 ? '' : 's'}`
  if (!g.pushed && g.ahead) return `${g.ahead} unpushed commit${g.ahead === 1 ? '' : 's'}`
  return ''
}

/**
 * One workspace as a row: its id, each checkout and what it holds, then `more` lines, and under
 * them the commits and files themselves once `fillHeld` has them. `restore` is the chat Restore
 * opens, the workspace's newest; a workspace with no chat has none.
 */
function row(w, more, restore = '') {
  const repos = (w.repos || []).map((r) => {
    const risk = atRisk(r)
    return `${escape(r.name || r.id)}${r.branch ? ` <span class="mono">${escape(r.branch)}</span>` : ''}${risk ? ` · ${escape(risk)}` : ''}`
  })
  const holds = (w.repos || []).some((r) => atRisk(r))
  return (
    `<div class="stranded-row row between">` +
    `<span class="who"><b class="mono">${escape(w.id)}</b><small>${repos.join('; ') || 'no repo'}</small>${more.map((m) => `<small>${m}</small>`).join('')}` +
    (holds ? `<span class="ws-held" data-held="${escape(w.id)}"></span>` : '') +
    `</span>` +
    `<span class="row">` +
    (restore ? `<button class="btn sm ghost" data-ws-restore="${escape(restore)}">Restore</button>` : '') +
    `<button class="btn sm ghost danger" data-ws-delete="${escape(w.id)}">Delete</button>` +
    `</span>` +
    `</div>`
  )
}

/** A checkout's commits and files as lines: `abc1234 subject`, `docs/bugs.md +24 −0`, `x.mjs new`. */
function heldLines(repo, many) {
  const lines = []
  const where = many ? `${escape(repo.name || repo.id)}: ` : ''
  for (const c of repo.commits || []) lines.push(`${where}<span class="mono">${escape(c.sha)}</span> ${escape(c.subject)}`)
  if (repo.moreCommits) lines.push(`${where}and ${repo.moreCommits} more commit${repo.moreCommits === 1 ? '' : 's'}`)
  for (const f of repo.files || []) {
    const what = f.state === 'new' ? 'new' : f.state === 'deleted' ? 'deleted' : `+${f.added} −${f.removed}`
    lines.push(`${where}<span class="mono">${escape(f.path)}</span> ${what}`)
  }
  if (repo.moreFiles) lines.push(`${where}and ${repo.moreFiles} more file${repo.moreFiles === 1 ? '' : 's'}`)
  return lines
}

export const methods = {
  /** Read the roster and draw both lists. */
  async loadWorkspaceDecisions() {
    try {
      const { threads = [], workspaces = [] } = await fetchThreads()
      this.setWorkspaceDecisions(heldWorkspaces(threads, workspaces))
    } catch {
      this.setWorkspaceDecisions(null)
    }
  },

  setWorkspaceDecisions(held) {
    this.wsArmed = ''
    const stranded = this.$('[data-list=stranded]')
    const kept = this.$('[data-list=kept]')
    if (!held) {
      stranded.innerHTML = kept.innerHTML = `<p class="why">Could not read the workspaces.</p>`
      return
    }
    stranded.innerHTML = held.stranded.length
      ? held.stranded.map((w) => row(w, [`started ${escape(when(w.createdAt))}`])).join('')
      : `<p class="why">None — every workspace has its chat.</p>`
    kept.innerHTML = held.kept.length
      ? held.kept
          .map((w) => {
            // Newest first: Restore opens the chat that was last at work in it.
            const chats = [...held.chatsOf(w.id)].sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))
            const names = chats.slice(0, 2).map((t) => escape(t.title || 'Untitled')).join(', ') + (chats.length > 2 ? ', …' : '')
            return row(w, [`${chats.length} chat${chats.length === 1 ? '' : 's'}: ${names}`, w.aging?.archivedAt ? `archived ${escape(when(w.aging.archivedAt))}` : ''].filter(Boolean), chats[0]?.id || '')
          })
          .join('')
      : `<p class="why">None — every archived workspace can age out.</p>`
    this.setWorkspaceBadgeCount(held.stranded.length + held.kept.length)
    for (const w of [...held.stranded, ...held.kept]) this.fillHeld(w.id)
  },

  /** The commits and files a row's workspace holds, asked for once the row is drawn. */
  async fillHeld(id) {
    const el = this.$(`[data-held="${id}"]`)
    if (!el) return
    try {
      const res = await fetchHeldWork(id)
      const repos = (res.repos || []).filter((r) => r.commits?.length || r.files?.length)
      el.innerHTML = repos.flatMap((r) => heldLines(r, repos.length > 1)).map((l) => `<small>${l}</small>`).join('')
    } catch {
      /* the row still says what it holds in counts */
    }
  },

  /** The count on the Workspaces menu item. */
  setWorkspaceBadgeCount(n) {
    const b = this.$('.set-link[data-page=workspaces] .ws-badge')
    if (!b) return
    b.hidden = !n
    b.textContent = n ? String(n) : ''
  },

  _wireWorkspaceDecisions() {
    const page = this.$('.set-page[data-page=workspaces]')
    // A failed delete is a toast naming the workspace: a line at the page's foot named none, and
    // one inside the row grew it and moved its buttons as it appeared.
    const fail = (id, text) => this.onToast(`${id}: ${text}`, 'err')
    page.addEventListener('click', async (e) => {
      // Restore is the Archived list's: the chat is restored, its session resumed, and it opens.
      const r = e.target.closest('[data-ws-restore]')
      if (r) return this.onRestore(r.dataset.wsRestore)
      const b = e.target.closest('[data-ws-delete]')
      if (!b) return
      const id = b.dataset.wsDelete
      // Two presses: the first only arms this one. The second is the forced delete. Every row here
      // holds work and lists it, so the server's refusal could only repeat what the row says —
      // the panel's third press, Delete anyway, was a click that told nobody anything.
      if (this.wsArmed !== id) {
        for (const other of page.querySelectorAll('[data-ws-delete]')) other.textContent = 'Delete'
        this.wsArmed = id
        b.textContent = 'Confirm delete'
        return
      }
      b.disabled = true
      try {
        const res = await deleteWorkspace(id, true)
        if (!res.ok) return fail(id, res.error || 'Could not delete that workspace')
        this.onToast('Workspace deleted')
        await this.loadWorkspaceDecisions()
      } catch (err) {
        fail(id, err.message || 'Could not delete that workspace')
      } finally {
        b.disabled = false
      }
    })
  },
}
