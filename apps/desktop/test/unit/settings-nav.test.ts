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
    expect(ids).toEqual(['chat', 'platform', 'usage', 'appearance', 'tools', 'execution', 'privacy'])
    expect(settingsViewSource).toContain("{section === 'chat' && <MaestrlyChatSection")
    expect(settingsViewSource).not.toContain("{section === 'clis' && <MaestrlyChatSection")
  })

  it('translates the new item into English and pt-BR', () => {
    expect(resources.en.ui.settings.nav.chat).toBe('Maestrly Chat')
    expect(resources['pt-BR'].ui.settings.nav.chat).toBe('Maestrly Chat')
    expect(resources.en.ui.settings.nav.platform).toBe('Platform')
    expect(resources['pt-BR'].ui.settings.nav.platform).toBe('Plataforma')
  })

  it('accepts direct navigation to the Maestrly Chat settings section', () => {
    const panelsSource = source('../../src/renderer/lib/use-main-panels.ts')
    const settingsContextSource = source('../../src/renderer/lib/use-settings.tsx')
    const appSource = source('../../src/renderer/DesktopApp.tsx')

    expect(settingsContextSource).toContain('openSettings: (sectionOrEvent?: SettingsSection | SyntheticEvent) => void')
    expect(panelsSource).toContain(
      "const openSettings = useCallback((sectionOrEvent: SettingsSection | SyntheticEvent = 'chat')"
    )
    expect(appSource).toContain('initialSection={settingsSection}')
    expect(settingsViewSource).toContain('useState<SettingsSection>(initialSection)')
    expect(chatMessageListSource).toContain("message.errorCode === 'claude-authentication-required'")
    expect(chatMessageListSource).toContain("openSettings('chat')")
    expect(resources.en.chat.messages.manageClaudeConnection).toBe('Manage Claude connection')
    expect(resources['pt-BR'].chat.messages.manageClaudeConnection).toBe('Gerenciar conexão Claude')
  })
})
