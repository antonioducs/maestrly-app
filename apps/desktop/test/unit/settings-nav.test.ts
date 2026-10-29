import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resources } from '../../src/shared/i18n/resources'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

const navSource = source('../../src/renderer/components/settings/nav.tsx')
const settingsViewSource = source('../../src/renderer/components/SettingsView.tsx')
const chatMessageListSource = source('../../src/renderer/components/chat/ChatMessageList.tsx')

describe('settings navigation', () => {
  it('keeps Maestrly Chat without an external CLI section', () => {
    const ids = [...navSource.matchAll(/\{ id: '([^']+)'/g)].map((match) => match[1])
    expect(ids).toEqual([
      'chat',
      'fleet',
      'computers',
      'runner',
      'usage',
      'appearance',
      'tools',
      'artifacts',
      'execution',
      'privacy',
      'updates',
    ])
    // The section renders inside the profile of the host chosen in Settings.
    expect(settingsViewSource).toContain("{section === 'chat' && inProfile(<MaestrlyChatSection")
    expect(settingsViewSource).not.toContain("{section === 'clis' && <MaestrlyChatSection")
  })

  it('translates the new item into English and pt-BR', () => {
    expect(resources.en.ui.settings.nav.chat).toBe('Maestrly Chat')
    expect(resources['pt-BR'].ui.settings.nav.chat).toBe('Maestrly Chat')
    expect(resources.en.ui.settings.nav.fleet).toBe('Bot servers')
    expect(resources['pt-BR'].ui.settings.nav.fleet).toBe('Servidores de bots')
    expect(resources.en.ui.settings.nav.computers).toBe('Computers')
    expect(resources['pt-BR'].ui.settings.nav.computers).toBe('Computadores')
    expect(resources.en.ui.settings.nav.runner).toBe('Runner')
    expect(resources['pt-BR'].ui.settings.nav.runner).toBe('Runner')
  })

  it('offers Computers only where Settings can leave for a paired computer', () => {
    // A bot's own settings window, for one, has no machine switcher to show a paired computer in.
    expect(settingsViewSource).toContain("(item) => item.id !== 'computers' || onOpenHost")
    expect(settingsViewSource).toContain("{section === 'computers' && onOpenHost && <ComputersSection")
  })

  it('shows the runner section for this computer, outside the profile of the host chosen in Settings', () => {
    expect(settingsViewSource).toContain("{section === 'runner' && <RunnerSection t={t} />}")
    expect(settingsViewSource).not.toContain('inProfile(<RunnerSection')
    expect(settingsViewSource).not.toMatch(/PROFILE_SECTIONS[^\n]*'runner'/)
  })

  it('accepts direct navigation to the Maestrly Chat settings section', () => {
    const panelsSource = source('../../src/renderer/lib/use-main-panels.ts')
    const settingsContextSource = source('../../src/renderer/lib/use-settings.tsx')
    const appSource = source('../../src/renderer/DesktopApp.tsx')

    expect(settingsContextSource).toContain(
      'export type OpenSettings = (sectionOrEvent?: SettingsSection | SyntheticEvent, options?: OpenSettingsOptions) => void'
    )
    expect(panelsSource).toContain(
      "(sectionOrEvent: SettingsSection | SyntheticEvent = 'chat', options?: OpenSettingsOptions) => {"
    )
    expect(appSource).toContain('initialSection={settingsSection}')
    // A chat tab and a host (Chat → Plugins of a remote conversation's host) travel as a request.
    expect(appSource).toContain('request={settingsRequest}')
    expect(settingsViewSource).toContain('useState<SettingsSection>(initialSection)')
    expect(chatMessageListSource).toContain("message.errorCode === 'claude-authentication-required'")
    expect(chatMessageListSource).toContain("openSettings('chat')")
    expect(resources.en.chat.messages.manageClaudeConnection).toBe('Manage Claude connection')
    expect(resources['pt-BR'].chat.messages.manageClaudeConnection).toBe('Gerenciar conexão Claude')
  })
})
