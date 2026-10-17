import { describe, expect, it, vi } from 'vitest'
import { normalizeClaudeLoginCode, startClaudeDesktopLogin } from '../../src/main/chat/claude-agent-sdk/desktop-login'
import { CLAUDE_LOGIN_CODE_MAX_LENGTH } from '../../src/shared/chat'
import type {
  ClaudeInteractiveLogin,
  ClaudeSubscriptionLoginResult,
} from '../../src/main/chat/claude-agent-sdk/manager'

const AUTO_URL =
  'https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A45678%2Fcallback&state=s'
const MANUAL_URL =
  'https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s'

const result = { ok: true, status: { authenticated: true } } as ClaudeSubscriptionLoginResult

function fakeManager(urls: { autoUrl?: string; manualUrl?: string } = {}) {
  const interactive: ClaudeInteractiveLogin = {
    autoUrl: urls.autoUrl ?? AUTO_URL,
    manualUrl: urls.manualUrl ?? MANUAL_URL,
    submitCode: vi.fn(),
    cancel: vi.fn(),
    done: Promise.resolve(result),
  }
  return {
    interactive,
    manager: {
      login: vi.fn(async () => result),
      startInteractiveLogin: vi.fn(async () => interactive),
    },
  }
}

describe('Claude desktop sign-in', () => {
  it.each(['linux', 'darwin'] as const)('hands the sign-in pages to Maestrly on %s', async (platform) => {
    const { manager, interactive } = fakeManager()
    const login = await startClaudeDesktopLogin(manager, platform)
    expect(manager.startInteractiveLogin).toHaveBeenCalledOnce()
    expect(manager.login).not.toHaveBeenCalled()
    expect(login).toMatchObject({ authUrl: AUTO_URL, manualUrl: MANUAL_URL })
    expect(login.submitCode('  code-123#state  ')).toBe(true)
    expect(interactive.submitCode).toHaveBeenCalledWith('code-123#state')
    await expect(login.done).resolves.toBe(result)
  })

  it('keeps Claude Code opening the browser itself on Windows', async () => {
    const { manager } = fakeManager()
    const login = await startClaudeDesktopLogin(manager, 'win32')
    expect(manager.login).toHaveBeenCalledOnce()
    expect(manager.startInteractiveLogin).not.toHaveBeenCalled()
    expect(login).toMatchObject({ authUrl: null, manualUrl: null })
    expect(login.submitCode('code')).toBe(false)
    await expect(login.done).resolves.toBe(result)
  })

  it('refuses malformed codes without writing them to Claude Code', async () => {
    const { manager, interactive } = fakeManager()
    const login = await startClaudeDesktopLogin(manager, 'linux')
    for (const code of ['', '   ', 'one\ntwo', 'tab\there', 'x'.repeat(CLAUDE_LOGIN_CODE_MAX_LENGTH + 1), 'código']) {
      expect(login.submitCode(code)).toBe(false)
    }
    expect(interactive.submitCode).not.toHaveBeenCalled()
  })

  it('drops a sign-in page outside Claude and keeps the other one', async () => {
    const { manager, interactive } = fakeManager({ autoUrl: 'https://evil.example/authorize' })
    const login = await startClaudeDesktopLogin(manager, 'linux')
    expect(login).toMatchObject({ authUrl: null, manualUrl: MANUAL_URL })
    expect(interactive.cancel).not.toHaveBeenCalled()

    const manualOnly = fakeManager({ manualUrl: 'http://claude.com/plain-http' })
    const withoutManual = await startClaudeDesktopLogin(manualOnly.manager, 'darwin')
    expect(withoutManual).toMatchObject({ authUrl: AUTO_URL, manualUrl: null })
    expect(withoutManual.submitCode('code')).toBe(false)
  })

  it('cancels a sign-in whose pages are all unexpected', async () => {
    const { manager, interactive } = fakeManager({
      autoUrl: 'https://evil.example/a',
      manualUrl: 'https://user:pass@claude.com/b',
    })
    await expect(startClaudeDesktopLogin(manager, 'linux')).rejects.toThrow('unexpected sign-in address')
    expect(interactive.cancel).toHaveBeenCalledOnce()
  })

  it('normalizes pasted codes', () => {
    expect(normalizeClaudeLoginCode(' abc#def ')).toBe('abc#def')
    expect(normalizeClaudeLoginCode('abc\r\n')).toBe('abc')
    expect(normalizeClaudeLoginCode('a b')).toBeNull()
    expect(normalizeClaudeLoginCode('abc\u0000')).toBeNull()
    expect(normalizeClaudeLoginCode(42)).toBeNull()
    expect(normalizeClaudeLoginCode(undefined)).toBeNull()
  })
})
