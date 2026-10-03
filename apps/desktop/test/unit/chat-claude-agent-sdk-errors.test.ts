import { describe, expect, it } from 'vitest'
import {
  CLAUDE_REFRESH_CONTENTION_RETRY_DELAYS_MS,
  ClaudeSubscriptionError,
  claudeOAuthRefreshContentionMessage,
  claudeRefreshContentionRetryDelay,
  claudeRuntimeErrorMessage,
  claudeSubscriptionErrorMessage,
  isClaudeAuthenticationRequired,
  isClaudeModelUnavailable,
  isClaudeOAuthRefreshContention,
  redactClaudeCredentials,
} from '../../src/main/chat/claude-agent-sdk/errors'

// Claude Code 2.1.284 diagnostics: SDK/print mode, interactive mode, and the lock error itself.
const sdkContention =
  'Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute, and if it persists close other Claude Code processes or sign in again'
const interactiveContention =
  'Could not refresh your login because another Claude Code process is refreshing it (or exited mid-refresh) · Try again in a minute; if it keeps happening, close other Claude Code windows or sign in again with /login'
const lockContention = 'Lock acquisition failed after 5 attempts: another process is refreshing'

describe('Claude Agent SDK error sanitization', () => {
  it('redacts bearer headers, credential variables, query parameters and token shapes', () => {
    const exposed = [
      'Authorization: Bearer bearer-secret',
      'ANTHROPIC_API_KEY=env-secret',
      'CLAUDE_CODE_OAUTH_TOKEN="oauth-secret"',
      'https://example.test/fail?access_token=query-secret&next=1',
      'sk-ant-directsecret123',
    ].join('\n')
    const redacted = redactClaudeCredentials(exposed)

    for (const secret of ['bearer-secret', 'env-secret', 'oauth-secret', 'query-secret', 'directsecret123']) {
      expect(redacted).not.toContain(secret)
    }
    expect(redacted.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(5)
    expect(redacted).toContain('Authorization: Bearer [REDACTED]')
    expect(redacted).toContain('next=1')
  })

  it('sanitizes typed, native and string runtime errors without hiding useful context', () => {
    expect(
      claudeSubscriptionErrorMessage(
        new ClaudeSubscriptionError('claude-runtime-failed', 'runtime failed: Authorization: Bearer private')
      )
    ).toBe('runtime failed: Authorization: Bearer [REDACTED]')
    expect(claudeSubscriptionErrorMessage(new Error('backend rejected api_key=private'))).toBe(
      'backend rejected api_key=[REDACTED]'
    )
    expect(claudeSubscriptionErrorMessage('oauth_token=private')).toBe('oauth_token=[REDACTED]')
  })

  it('classifies terminal OAuth failures without treating unrelated runtime failures as reauthentication', () => {
    expect(isClaudeAuthenticationRequired({ status: 401, message: 'request failed' })).toBe(true)
    expect(isClaudeAuthenticationRequired(new Error('OAuth token expired. Please run claude auth login.'))).toBe(true)
    expect(isClaudeAuthenticationRequired({ errors: ['authentication_error: invalid bearer token'] })).toBe(true)
    expect(isClaudeAuthenticationRequired(new Error('GitHub API returned 401 Unauthorized'))).toBe(false)
    expect(isClaudeAuthenticationRequired(new Error('MCP server authentication failed'))).toBe(false)
    expect(isClaudeAuthenticationRequired(new Error('model is unavailable for this account'))).toBe(false)
    expect(isClaudeAuthenticationRequired(new Error('Claude transport disconnected'))).toBe(false)
  })

  it('treats OAuth refresh lock contention as transient, never as a required sign-in', () => {
    for (const diagnostic of [sdkContention, interactiveContention, lockContention]) {
      expect(isClaudeAuthenticationRequired(new Error(diagnostic))).toBe(false)
      expect(isClaudeAuthenticationRequired({ errors: [diagnostic] })).toBe(false)
      expect(isClaudeOAuthRefreshContention(new Error(diagnostic))).toBe(true)
    }
    // A terminal failure reported with it still requires a sign-in.
    expect(isClaudeAuthenticationRequired({ errors: [sdkContention, 'OAuth token revoked · Please run /login'] })).toBe(
      true
    )
    expect(isClaudeOAuthRefreshContention(new Error('OAuth token expired. Please run claude auth login.'))).toBe(false)
    expect(isClaudeOAuthRefreshContention(new Error('Claude transport disconnected'))).toBe(false)
  })

  it('reads refresh contention from SDK failure envelopes but never from model output', () => {
    const envelope = (error?: string) => ({
      type: 'assistant',
      ...(error ? { error } : {}),
      message: { content: [{ type: 'text', text: sdkContention }] },
    })
    expect(isClaudeOAuthRefreshContention(envelope('server_error'))).toBe(true)
    expect(isClaudeOAuthRefreshContention(envelope())).toBe(false)
    expect(
      isClaudeOAuthRefreshContention({ type: 'result', subtype: 'success', is_error: true, result: sdkContention })
    ).toBe(true)
    expect(
      isClaudeOAuthRefreshContention({ type: 'result', subtype: 'success', is_error: false, result: sdkContention })
    ).toBe(false)
    expect(claudeOAuthRefreshContentionMessage({ errors: ['unrelated', sdkContention] })).toBe(sdkContention)
    expect(claudeOAuthRefreshContentionMessage(new Error('Claude transport disconnected'))).toBeNull()
  })

  it('spaces refresh contention retries past a stale lock, with jitter, then stops', () => {
    const delays = CLAUDE_REFRESH_CONTENTION_RETRY_DELAYS_MS.map((_, attempt) =>
      claudeRefreshContentionRetryDelay(attempt)
    )
    delays.forEach((delay, attempt) => {
      expect(delay).toBeGreaterThanOrEqual(CLAUDE_REFRESH_CONTENTION_RETRY_DELAYS_MS[attempt])
      expect(delay).toBeLessThan(CLAUDE_REFRESH_CONTENTION_RETRY_DELAYS_MS[attempt] + 1_000)
    })
    // Claude Code drops a lock as stale after 60 s without updates.
    expect(CLAUDE_REFRESH_CONTENTION_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0)).toBeGreaterThan(60_000)
    expect(claudeRefreshContentionRetryDelay(CLAUDE_REFRESH_CONTENTION_RETRY_DELAYS_MS.length)).toBeNull()
  })

  it('normalizes unavailable-model diagnostics without swallowing unrelated failures', () => {
    const diagnostic =
      "There's an issue with the selected model (claude-fable-5-1). It may not exist or you may not have access to it."
    expect(isClaudeModelUnavailable(diagnostic)).toBe(true)
    expect(claudeRuntimeErrorMessage(diagnostic, 'claude-fable-5-1')).toContain(
      'Claude model “claude-fable-5-1” is not available'
    )
    expect(isClaudeModelUnavailable('network timeout')).toBe(false)
  })
})
