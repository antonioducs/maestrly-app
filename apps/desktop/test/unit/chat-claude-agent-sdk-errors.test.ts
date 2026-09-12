import { describe, expect, it } from 'vitest'
import {
  ClaudeSubscriptionError,
  claudeRuntimeErrorMessage,
  claudeSubscriptionErrorMessage,
  isClaudeAuthenticationRequired,
  isClaudeModelUnavailable,
  redactClaudeCredentials,
} from '../../src/main/chat/claude-agent-sdk/errors'

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
