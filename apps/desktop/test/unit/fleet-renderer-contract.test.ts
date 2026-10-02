import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { resources } from '../../src/shared/i18n/resources'

const source = (path: string) => readFileSync(new URL(`../../src/renderer/${path}`, import.meta.url), 'utf8')

describe('fleet renderer wiring', () => {
  it('routes owner memory from the fleet sidebar to the main view', () => {
    expect(source('lib/use-main-panels.ts')).toContain("{ kind: 'memory' }")
    expect(source('DesktopApp.tsx')).toContain("fleetView?.kind === 'memory'")
    expect(source('DesktopApp.tsx')).toContain('<OwnerMemoryView')
    const sidebar = source('components/fleet/FleetSidebarPanel.tsx')
    expect(sidebar).toContain('onOpenOwnerMemory')
    expect(sidebar).toContain("selected === 'memory'")
    expect(sidebar).toContain("t('sidebar.ownerMemory')")
  })

  it('routes fleet views through the main override and clears them for local conversations', () => {
    const panels = source('lib/use-main-panels.ts')
    expect(panels).toContain("(fleetView ? 'fleet' : null)")
    expect(panels).toContain('setFleetView(null)')
    expect(panels).toContain('setActive(null)')
  })
  it('marks the Bots tab as experimental', () => {
    const header = source('components/sidebar/SidebarHeader.tsx')
    expect(header).toMatch(/item === 'bots' &&[\s\S]{0,240}t\('sidebar\.experimental'\)/)
    for (const catalog of [resources.en.ui, resources['pt-BR'].ui])
      expect(catalog.sidebar.experimental).toBe('Experimental')
  })
  it('subscribes to all fleet state streams and disposes subscriptions', () => {
    const hook = source('lib/fleet/use-fleet.ts')
    for (const event of ['onFleetConnection', 'onFleetEvent']) expect(hook).toContain(event)
    for (const unsubscribe of ['offConnection()', 'offEvent()']) expect(hook).toContain(unsubscribe)
  })
  it('exposes keyboard accessible bot tabs and keeps the screen and settings extension points', () => {
    const view = source('components/fleet/BotView.tsx')
    expect(view).toContain('role="tablist"')
    expect(view).toContain('onKeyDown={onKeyDown}')
    for (const component of ['BotWorkspace', 'BotConversation', 'BotScreen', 'BotSettings'])
      expect(view).toContain(`<${component}`)
    expect(view).toContain("['conversation', 'screen', 'settings']")
  })
  it('keeps foreign takeovers in view mode and blocks resume actions', () => {
    const screen = source('components/fleet/BotScreen.tsx')
    const view = source('components/fleet/BotView.tsx')
    const conversation = source('components/fleet/BotConversation.tsx')
    expect(screen).toContain('ownsTakeover(takeover, fleet.state.connection.deviceId)')
    expect(screen).toContain("const mode = human ? 'control' : 'view'")
    expect(screen).toContain('screen.footerOther')
    expect(screen).toContain('screen.takeConflict')
    for (const component of [view, conversation]) {
      expect(component).toContain('disabled={takeoverBlocksResume(bot.takeover)}')
      expect(component).toContain("t('action.resumeBlocked')")
    }
  })
  it('shows bot updates and updates bots in one click wherever the bot server shows', () => {
    const sidebar = source('components/fleet/FleetSidebarPanel.tsx')
    expect(sidebar).toContain('<BotUpdateBanner')
    expect(sidebar).toMatch(/<EnvironmentHeader[\s\S]{0,200}update=/)
    const header = source('components/sidebar/SidebarHeader.tsx')
    expect(header).toMatch(/item === 'bots' &&[\s\S]{0,600}t\('sidebar\.botUpdate'\)/)
    expect(source('components/fleet/ServerView.tsx')).toContain('<BotUpdateBanner')
    expect(source('components/settings/FleetSettings.tsx')).toContain('fleetUpdateBots')
    expect(source('DesktopApp.tsx')).toContain('useBotUpdates(fleet)')
    const banner = source('components/fleet/BotUpdateBanner.tsx')
    for (const key of [
      'updates.available',
      'updates.updateBots',
      'updates.updatingServer',
      'updates.waiting',
      'updates.behind',
    ])
      expect(banner).toContain(`'${key}'`)
    for (const catalog of [resources.en, resources['pt-BR']]) {
      for (const key of [
        'available',
        'availableVersion',
        'availableNoVersion',
        'updateBots',
        'updatingServer',
        'waiting',
        'waitingNone',
        'pendingShort',
        'behind',
        'failed',
        'unsupported',
      ])
        expect(catalog.fleet.updates[key as keyof typeof catalog.fleet.updates], key).toEqual(expect.any(String))
      expect(catalog.ui.sidebar.botUpdate).toEqual(expect.any(String))
    }
    expect(resources.en.fleet.botServer.panel.update).toBe('Update bots')
    expect(resources['pt-BR'].fleet.botServer.panel.update).toBe('Atualizar bots')
  })
  it('schedules, forces and cancels an environment update from its view, naming the bots it waits for', () => {
    const view = source('components/fleet/EnvironmentView.tsx')
    for (const text of [
      'environmentUpdateState(',
      'updateBlockers(',
      "fleetEnvironmentUpdate(environment.id, 'now')",
      "fleet.updateEnvironment(environment.id, 'idle')",
      'fleet.cancelEnvironmentUpdate(environment.id)',
      "t('updates.cancel')",
      "t('updates.pendingTitle')",
      "t('updates.nextStart')",
      "'updateNow'",
    ])
      expect(view, text).toContain(text)
    for (const catalog of [resources.en.fleet, resources['pt-BR'].fleet]) {
      for (const status of ['working', 'waiting', 'human'] as const)
        expect(catalog.updates.busy[status]).toEqual(expect.any(String))
      for (const key of [
        'pendingTitle',
        'pendingNote',
        'waitingSince',
        'updateNow',
        'cancel',
        'confirmNowTitle',
        'confirmNow_one',
        'confirmNow_other',
        'confirmNowIdle',
        'nextStart',
      ] as const)
        expect(catalog.updates[key], key).toEqual(expect.any(String))
    }
  })
  it('shows the runtimes an environment reports and checks them from its view', () => {
    const view = source('components/fleet/EnvironmentView.tsx')
    expect(view).toContain('<EnvironmentRuntimes environment={environment} fleet={fleet} />')
    const runtimes = source('components/fleet/EnvironmentRuntimes.tsx')
    expect(runtimes).toContain('fleet.checkEnvironmentRuntimes(environment.id)')
    expect(runtimes).toContain('FLEET_RUNTIME_UPDATES_FEATURE')
    for (const catalog of [resources.en.fleet, resources['pt-BR'].fleet]) {
      const copy = catalog.environment.runtimes
      for (const key of ['title', 'note', 'lastChecked', 'neverChecked', 'manual', 'check', 'unsupported', 'restart'])
        expect(copy[key as keyof typeof copy], key).toEqual(expect.any(String))
      for (const id of ['claude-code', 'codex'] as const) {
        expect(copy.name[id]).toEqual(expect.any(String))
        expect(copy.pending[id]).toContain('{{version}}')
      }
      for (const source of ['image', 'managed'] as const) expect(copy.source[source]).toEqual(expect.any(String))
      for (const state of [
        'idle',
        'checking',
        'up-to-date',
        'available',
        'downloading',
        'verifying',
        'installing',
        'validating',
        'rolling-back',
        'failed',
      ] as const)
        expect(copy.state[state], state).toEqual(expect.any(String))
    }
  })
  it('compares Mac and bot versions and displays the gateway independently', () => {
    const server = source('components/fleet/ServerView.tsx')
    expect(server).toContain('botsWithDifferentVersion(bots, version)')
    expect(server).toContain('bot.appVersion ??')
    expect(server).toContain('server.gatewayVersion')
  })
})

describe('fleet provisioning wiring', () => {
  it('offers importing during creation', () => {
    expect(source('components/fleet/CreateBotDialog.tsx')).toContain('<MacImportPicker')
  })
  it('renders bot accounts and skills in settings', () => {
    const settings = source('components/fleet/BotSettings.tsx')
    expect(settings).toContain('<BotAccountsSection')
    expect(settings).toContain('<BotSkillsMcpSection')
  })
  it('starts and cancels remote sign-ins without opening URLs in the renderer', () => {
    const login = source('lib/fleet/use-bot-login.ts')
    expect(login).toContain('fleetLoginStart')
    expect(login).toContain('fleetLoginCancel')
    // The dialog and the cards of a new bot sign in through the same hook.
    for (const name of ['BotLoginDialog', 'BotLoginCard']) {
      const component = source(`components/fleet/${name}.tsx`)
      expect(component, name).toContain('useBotLogin(')
      expect(component, name).not.toContain('window.open')
    }
    expect(login).not.toContain('window.open')
  })
  it('avoids native select controls in provisioning', () => {
    for (const name of [
      'MacImportPicker',
      'MacImportDialog',
      'BotLoginDialog',
      'BotLoginCard',
      'CreateBotDialog',
      'CreateBotImportSection',
      'CreateBotProgress',
      'BotAccountsSection',
      'BotSkillsMcpSection',
    ]) {
      expect(source(`components/fleet/${name}.tsx`)).not.toMatch(/<select\b/)
    }
  })
})
