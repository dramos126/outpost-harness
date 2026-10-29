/**
 * The settings view: a menu of pages on the left and the chosen page beside it. Each group is
 * a file under `settings/` that brings its section of the markup and its methods; this file
 * decides which page each group is on, wires them once, and reads their state when the view
 * opens.
 *
 * It used to be one long scroll of cards, eleven of them, centred in the pane with the space
 * beside them empty — a page that did not look like the rest of Outpost. The menu fills that
 * space, a page is sections divided by a hairline rather than cards, and General is what
 * opens. On a phone there is no room for the menu beside anything, so Settings opens on the
 * list of pages and a page is a screen of its own, with Back to the list (ui-settings.md).
 *
 * Everything but appearance lives on the server and is fetched, saved and tested over the API.
 */
import { fetchContextLimits, fetchEnvironments, fetchGitIdentity, fetchIntegrations, fetchPushDefault, fetchSecrets } from '../api.js'
import { ICON, isPhone } from './shell.js'
import * as appearance from './settings/appearance.js'
import * as catalogue from './settings/catalogue.js'
import * as secrets from './settings/secrets.js'
import * as environments from './settings/environments.js'
import * as integrations from './settings/integrations.js'
import * as aging from './settings/aging.js'
import * as workspaces from './settings/workspaces.js'
import * as setup from './settings/setup.js'
import * as notify from './settings/notify.js'
import * as account from './settings/account.js'
import * as about from './settings/about.js'
import * as context from './settings/context.js'
import * as containers from './settings/containers.js'

// main.js applies the cached look on boot, before there is a view, and the roster's on each
// push; it imports all three from here.
export { applyRosterAppearance, applyTheme, readTheme } from './settings/appearance.js'

/**
 * The pages, in menu order, and the groups each holds, in page order. The first is the one a
 * wide screen opens on. A page with one group draws no heading for it: the page's title says
 * it already.
 */
const PAGES = [
  { id: 'general', title: 'General', groups: [appearance, context, notify, account, setup, containers, about] },
  { id: 'repos', title: 'Repos', groups: [catalogue] },
  { id: 'integrations', title: 'Integrations', groups: [integrations, environments] },
  { id: 'keys', title: 'Keys and tokens', groups: [secrets] },
  { id: 'workspaces', title: 'Workspaces', groups: [workspaces] },
  { id: 'storage', title: 'Storage', groups: [aging] },
  // The host's shell, drawn into the slot by main.js while this page shows (terminal.js).
  { id: 'terminal', title: 'Terminal', groups: [{ html: '<div class="term-slot"></div>' }] },
]

export class SettingsView {
  /**
   * `onBack()` returns to the chats; `onLogout()` ends this browser's session;
   * `ensureModels()` fetches the model list for the New chat dialog the first time the page
   * needs it. `onTerminal(slot)` says the Terminal page opened, with the element to draw it
   * in, and `onTerminal(null)` that it was left: a host shell lives only while its page shows.
   */
  constructor(el, { onToast, onBack, onLogout, ensureModels, onCatalogue, onRestore, onTerminal }) {
    this.onTerminal = onTerminal || (() => {})
    this.el = el
    this.onToast = onToast
    this.onRestore = onRestore || (() => {})
    this.onCatalogue = onCatalogue || (() => {})
    this.catalogue = []
    this.editing = ''
    this.onBack = onBack
    this.onLogout = onLogout
    this.ensureModels = ensureModels
    this.account = { passwordAuth: false, user: '' }
    this.about = { launcher: '', harnesses: [] }
    this.page = PAGES[0].id
    this.el.innerHTML = `
      <header class="view-head">
        <button class="btn icon back" data-act="back" aria-label="Back">${ICON.back}</button>
        <h1>Settings</h1>
      </header>
      <div class="set-body">
        <nav class="set-nav" aria-label="Settings">${PAGES.map(
          (p) => `<button type="button" class="set-link" data-page="${p.id}">${p.title}${p.id === 'workspaces' ? '<span class="ws-badge" hidden></span>' : ''}<span class="chev" aria-hidden="true">›</span></button>`
        ).join('')}</nav>
        <div class="set-pages">${PAGES.map(
          (p) => `<div class="set-page" data-page="${p.id}" hidden><h2 class="set-title">${p.title}</h2>${p.groups.map((g) => g.html).join('')}</div>`
        ).join('')}</div>
      </div>`
    this.$ = (sel) => this.el.querySelector(sel)
    this._wire()
    this.paintTheme()
  }

  _wire() {
    this.$('[data-act=back]').addEventListener('click', () => this.back())
    this.$('.set-nav').addEventListener('click', (e) => {
      const b = e.target.closest('[data-page]')
      if (b) this.openPage(b.dataset.page)
    })
    this._wireAppearance()
    this._wireContextLimits()
    this._wireAccount()
    this._wireNotify()
    this._wireCatalogue()
    this._wireSecrets()
    this._wireEnvironments()
    this._wireSetup()
    this._wireAging()
    this._wireWorkspaceDecisions()
    this._wireIntegrations()
    this._wireContainers()
    this._wireAbout()
  }

  /** Show one page. On a phone that is a screen of its own, titled with the page's name. */
  openPage(id) {
    const page = PAGES.find((p) => p.id === id) || PAGES[0]
    if (this.page === 'terminal' && page.id !== 'terminal') this.onTerminal(null)
    this.page = page.id
    this.el.dataset.page = page.id
    for (const el of this.el.querySelectorAll('.set-page')) el.hidden = el.dataset.page !== page.id
    for (const b of this.el.querySelectorAll('.set-link')) {
      if (b.dataset.page === page.id) b.setAttribute('aria-current', 'page')
      else b.removeAttribute('aria-current')
    }
    this.el.dataset.set = 'page'
    this.$('.view-head h1').textContent = isPhone() ? page.title : 'Settings'
    this.$('.set-pages').scrollTop = 0
    if (page.id === 'terminal') this.onTerminal(this.$('.term-slot'))
  }

  /** The list of pages, as the whole screen. Only a phone ever shows it alone. */
  showMenu() {
    if (this.page === 'terminal') this.onTerminal(null)
    this.el.dataset.set = 'menu'
    this.$('.view-head h1').textContent = 'Settings'
  }

  /** Back: from a page to the list on a phone, otherwise out of Settings to the chats. */
  back() {
    if (isPhone() && this.el.dataset.set === 'page') this.showMenu()
    else this.onBack()
  }

  /**
   * Called when the view opens. A wide screen opens on General, every time — Settings is
   * visited, not lived in, so the page last looked at is not remembered. A phone opens on the
   * list. Every group's state is read now, not at boot.
   */
  show() {
    this.el.hidden = false
    // A repo's page left open last time is not where Settings opens; the list is.
    this.$('.cat-form').hidden = true
    this.$('.cat-list').hidden = false
    this.$('.cat-lede').hidden = false
    this.$('.push-default').hidden = false
    // A notify token shown once is not still on screen the next time Settings opens.
    this.$('.notify-once').hidden = true
    this.$('.notify-value').textContent = ''
    // General is open underneath the phone's list too, so a screen that widens — a rotated
    // tablet, a dragged window — has a page to show beside the menu rather than an empty pane.
    this.openPage(PAGES[0].id)
    if (isPhone()) this.showMenu()
    this.ensureModels()
    fetchSecrets()
      .then((r) => this.setSecrets(r.secrets || []))
      .catch(() => {})
    fetchEnvironments()
      .then((r) => this.setEnvironments(r.environments || []))
      .catch(() => {})
    this.loadAging()
    this.loadWorkspaceDecisions()
    fetchContextLimits()
      .then((r) => this.setContextLimits(r.limits))
      .catch(() => {})
    fetchIntegrations()
      .then((r) => this.setIntegrations(r.integrations || {}))
      .catch(() => {})
    fetchGitIdentity()
      .then((r) => this.setGitIdentity(r))
      .catch(() => {})
    fetchPushDefault()
      .then((r) => this.setPushDefault(r.push))
      .catch(() => {})
    this.loadContainers?.()
  }
}

// Each group brings its own methods; the view is one object, so they share `this` — the
// secrets list feeds three other groups' dropdowns, and that is why they are not separate views.
const GROUPS = { appearance, context, catalogue, secrets, environments, integrations, aging, workspaces, setup, notify, account, about, containers }
// One object means one namespace, and `Object.assign` lets a later group's method replace an
// earlier one's without a word: Jenkins's `_wireNotify` was replaced by Discord's, so Generate
// was never wired and Discord's listeners went on twice. A clash is said on the console.
const owners = new Map()
for (const [group, m] of Object.entries(GROUPS)) {
  for (const name of Object.keys(m.methods || {})) {
    if (owners.has(name)) console.error(`[outpost] settings: ${group} and ${owners.get(name)} both define ${name}; ${group}'s wins and the other's never runs`)
    owners.set(name, group)
  }
}
Object.assign(SettingsView.prototype, ...Object.values(GROUPS).map((g) => g.methods))
