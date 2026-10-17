import { describe, expect, it } from 'vitest'
import {
  CLAUDE_CODE_SETUP_DOCS_URL,
  claudeCodeSetupCommand,
  claudeCodeSetupNeed,
} from '../../src/renderer/components/chat/accounts/claude-code-setup'
import en from '../../src/shared/i18n/en/chat'
import pt from '../../src/shared/i18n/pt-BR/chat'

describe('Claude Code setup guidance', () => {
  it('asks to install or update only when Claude Code is missing or too old', () => {
    expect(claudeCodeSetupNeed(null)).toBeNull()
    expect(
      claudeCodeSetupNeed({ state: 'unavailable', authenticated: false, errorCode: 'claude-code-not-installed' })
    ).toBe('install')
    expect(
      claudeCodeSetupNeed({ state: 'unavailable', authenticated: false, errorCode: 'claude-code-incompatible' })
    ).toBe('update')
    expect(claudeCodeSetupNeed({ state: 'unavailable', authenticated: false, error: 'permission denied' })).toBeNull()
    expect(
      claudeCodeSetupNeed({ state: 'error', authenticated: false, errorCode: 'claude-authentication-required' })
    ).toBeNull()
    expect(claudeCodeSetupNeed({ state: 'signed-out', authenticated: false })).toBeNull()
  })

  it('gives the official installer for each system and the self-update for an old version', () => {
    expect(claudeCodeSetupCommand('install', 'linux')).toBe('curl -fsSL https://claude.ai/install.sh | bash')
    expect(claudeCodeSetupCommand('install', 'mac')).toBe('curl -fsSL https://claude.ai/install.sh | bash')
    expect(claudeCodeSetupCommand('install', 'win')).toBe('irm https://claude.ai/install.ps1 | iex')
    expect(claudeCodeSetupCommand('update', 'linux')).toBe('claude update')
    expect(new URL(CLAUDE_CODE_SETUP_DOCS_URL).origin).toBe('https://code.claude.com')
  })

  it.each([en, pt])('names the shell of every system', (locale) => {
    for (const os of ['mac', 'linux', 'win'] as const) {
      expect(locale.settings[`claudeCodeInstallShell_${os}`].length).toBeGreaterThan(0)
    }
    expect(locale.settings.claudeCodeInstallHintRemote).toContain('{{host}}')
  })
})
