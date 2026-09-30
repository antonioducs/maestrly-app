import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as electron from 'electron'
import { FLEET_BOT_ENV } from '@maestrly/bot-fleet-protocol'
import type { IpcRegistrar } from '../../src/main/ipc-registrar'

const source = (file: string) => readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8')

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
})

describe("a bot's own Maestrly window", () => {
  it('tells the renderer it runs inside a bot from the bot mode environment', async () => {
    vi.stubEnv(FLEET_BOT_ENV.mode, '1')
    vi.resetModules()
    expect((await import('../../src/preload/api-app')).appApi.platformInfo.botMode).toBe(true)
    vi.stubEnv(FLEET_BOT_ENV.mode, '')
    vi.resetModules()
    expect((await import('../../src/preload/api-app')).appApi.platformInfo.botMode).toBe(false)
  })

  it('keeps only the chat settings and leaves Maestro out, in the desktop order', async () => {
    const { BOT_INSTANCE_CHAT_TABS, BOT_INSTANCE_SETTINGS_SECTIONS, chatSettingsTabFor } = await import(
      '../../src/renderer/lib/bot-instance'
    )
    expect(BOT_INSTANCE_SETTINGS_SECTIONS).toEqual(['chat'])
    expect(BOT_INSTANCE_CHAT_TABS).toEqual(['accounts', 'models', 'tools', 'skills', 'prompts', 'components'])
    expect(chatSettingsTabFor('accounts')).toBe('accounts')
    expect(chatSettingsTabFor('skills')).toBe('skills')
    expect(chatSettingsTabFor('mcp')).toBe('tools')
  })

  it('mounts only the settings in a bot, never the chats, workspaces or fleet views', () => {
    expect(source('renderer/App.tsx')).toContain(
      'window.api.platformInfo.botMode ? <BotInstanceApp /> : <DesktopApp />'
    )
    const bot = source('renderer/BotInstanceApp.tsx')
    expect(bot).toContain('<SettingsView')
    expect(bot).toContain('sections={BOT_INSTANCE_SETTINGS_SECTIONS}')
    expect(bot).toContain('tabs: BOT_INSTANCE_CHAT_TABS')
    expect(bot).toContain('appToolsLocked: true')
    for (const other of ['DesktopApp', 'Sidebar', 'ChatView', 'BotView', 'useFleet', 'Onboarding'])
      expect(bot).not.toContain(other)
    // The gateway's "show accounts / skills / MCP" request lands here; the full desktop never runs in a bot.
    expect(bot).toContain('window.api.onFleetInstanceOpenAccounts(')
    expect(source('renderer/DesktopApp.tsx')).not.toContain('onFleetInstanceOpenAccounts')
  })

  it('hides the window on close: destroying it would stop the bot control server', () => {
    const bot = source('renderer/BotInstanceApp.tsx')
    expect(bot).toContain('onClose={() => void window.api.fleetInstanceHideWindow()}')
    // Electron's window.close() destroys the window without a preventable `close` event.
    expect(bot).not.toMatch(/window\.close\(/)
  })

  it("drops the menu bar from a bot's settings window: File → Quit restarts the bot's app mid-turn", () => {
    const main = source('main/index.ts')
    expect(main).toMatch(/show: !isBotMode\(\) && !startHidden,[\s\S]*if \(isBotMode\(\)\) mainWindow\.removeMenu\(\)/)
  })

  it('shows one section without a section list, the chosen tabs only, and Maestrly tools locked on', () => {
    const settings = source('renderer/components/SettingsView.tsx')
    expect(settings).toContain('const showNav = navItems.length > 1')
    expect(settings).toMatch(/\{showNav && \(\s*<nav/)
    expect(settings).toContain('<MaestrlyChatSection t={t} chat={chat} />')
    const chat = source('renderer/components/chat/ApiKeySettings.tsx')
    expect(chat).toMatch(
      /export function ApiKeySettings\(\{[\s\S]*appToolsLocked = false,[\s\S]*backgroundCompactionLocked = false/
    )
    expect(source('renderer/BotInstanceApp.tsx')).toContain('backgroundCompactionLocked: true')
    expect(chat).toContain('visibleTabs.map((tab, index)')
    expect(chat).toMatch(/shown\('maestro'\) && \(/)
    expect(chat).toContain("lockedDescriptionKey={appToolsLocked ? 'plusMenu.appToolsBotLocked' : undefined}")
  })

  it('hides the sender window only in bot mode', async () => {
    const hide = vi.fn()
    // Other tests reset the module registry: spy on the Electron stub instance the handler will import.
    const stub = await import('electron')
    vi.spyOn(stub.BrowserWindow, 'fromWebContents').mockReturnValue({ hide } as unknown as electron.BrowserWindow)
    const { registerFleetInstanceIpc } = await import('../../src/main/fleet/instance/ipc')
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const register = (channel: string, fn: (...args: unknown[]) => unknown): void => {
      handlers.set(channel, fn)
    }
    registerFleetInstanceIpc({ handle: register, mhandle: register, on: register, mon: register } as IpcRegistrar)
    await handlers.get('fleet:instance:hide')?.({ sender: {} })
    expect(hide).not.toHaveBeenCalled()
    vi.stubEnv(FLEET_BOT_ENV.mode, '1')
    await handlers.get('fleet:instance:hide')?.({ sender: {} })
    expect(hide).toHaveBeenCalledTimes(1)
  })
})
