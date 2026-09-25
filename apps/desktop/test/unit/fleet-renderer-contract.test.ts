import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

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
  it('subscribes to all fleet state streams and disposes subscriptions', () => {
    const hook = source('lib/fleet/use-fleet.ts')
    for (const event of ['onFleetConnection', 'onFleetEvent', 'onFleetDigest']) expect(hook).toContain(event)
    for (const unsubscribe of ['offConnection()', 'offEvent()', 'offDigest()']) expect(hook).toContain(unsubscribe)
  })
  it('exposes keyboard accessible bot tabs and keeps the screen and settings extension points', () => {
    const view = source('components/fleet/BotView.tsx')
    expect(view).toContain('role="tablist"')
    expect(view).toContain('onKeyDown={onKeyDown}')
    expect(view).toContain("tab === 'conversation'")
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
  it('compares Mac and bot versions and displays the gateway independently', () => {
    const server = source('components/fleet/ServerView.tsx')
    expect(server).toContain('botsWithDifferentVersion(bots, version)')
    expect(server).toContain('bot.appVersion ??')
    expect(server).toContain('server.gatewayVersion')
  })
})
