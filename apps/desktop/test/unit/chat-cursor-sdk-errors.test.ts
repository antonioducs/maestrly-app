import { describe, expect, it } from 'vitest'
import {
  classifyCursorSdkError,
  CursorSdkError,
  cursorSdkErrorMessage,
  isCursorAuthenticationRequired,
  redactCursorCredentials,
} from '../../src/main/chat/cursor-sdk/errors'

describe('Cursor SDK error sanitization', () => {
  it('redacts bearer headers, env vars, query params and key shapes', () => {
    const exposed = [
      'Authorization: Bearer bearer-secret',
      'CURSOR_API_KEY=env-secret',
      'apiKey=inline-secret',
      'https://example.test/fail?access_token=query-secret&next=1',
      'key_abcdefghijklmnopqrstuv',
      'crsr_abcdefghijklmnopqrstuv',
    ].join('\n')
    const redacted = redactCursorCredentials(exposed)

    for (const secret of [
      'bearer-secret',
      'env-secret',
      'inline-secret',
      'query-secret',
      'key_abcdefghijklmnopqrstuv',
      'crsr_abcdefghijklmnopqrstuv',
    ]) {
      expect(redacted).not.toContain(secret)
    }
    expect(redacted.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(5)
    expect(redacted).toContain('Authorization: Bearer [REDACTED]')
    expect(redacted).toContain('next=1')
  })

  it('sanitizes typed, native and string runtime errors', () => {
    expect(
      cursorSdkErrorMessage(
        new CursorSdkError('cursor-runtime-failed', 'runtime failed: Authorization: Bearer private')
      )
    ).toBe('runtime failed: Authorization: Bearer [REDACTED]')
    expect(cursorSdkErrorMessage(new Error('backend rejected api_key=private'))).toBe(
      'backend rejected api_key=[REDACTED]'
    )
    expect(cursorSdkErrorMessage('oauth_token=private')).toBe('oauth_token=[REDACTED]')
  })

  it('classifies auth failures without treating unrelated errors as reauth', () => {
    expect(isCursorAuthenticationRequired({ name: 'AuthenticationError', message: 'nope' })).toBe(true)
    expect(isCursorAuthenticationRequired({ status: 401, message: 'request failed' })).toBe(true)
    expect(isCursorAuthenticationRequired(new Error('Invalid API key'))).toBe(true)
    expect(isCursorAuthenticationRequired(new Error('not logged in'))).toBe(true)
    expect(isCursorAuthenticationRequired(new Error('model is unavailable for this account'))).toBe(false)
    expect(isCursorAuthenticationRequired(new Error('MCP server authentication failed'))).toBe(false)
    expect(isCursorAuthenticationRequired(new Error('Cursor transport disconnected'))).toBe(false)
  })

  it('maps SDK error names and codes to stable product codes', () => {
    expect(classifyCursorSdkError({ name: 'RateLimitError', message: 'slow down' })).toBe('cursor-rate-limited')
    expect(classifyCursorSdkError({ name: 'ConfigurationError', message: 'bad model' })).toBe('cursor-configuration')
    expect(classifyCursorSdkError({ name: 'AgentBusyError', message: 'busy' })).toBe('cursor-agent-busy')
    expect(classifyCursorSdkError({ name: 'AgentNotFoundError', message: 'missing' })).toBe('cursor-agent-not-found')
    expect(classifyCursorSdkError({ name: 'NetworkError', message: 'down' })).toBe('cursor-network')
    expect(classifyCursorSdkError({ code: 429, message: 'limit' })).toBe('cursor-rate-limited')
    expect(classifyCursorSdkError({ code: 'aborted', message: 'stop' })).toBe('cursor-cancelled')
    expect(classifyCursorSdkError(new Error('unsupported platform win32/arm64'))).toBe('cursor-platform-unsupported')
    expect(classifyCursorSdkError(new Error('something weird'))).toBe('cursor-runtime-failed')
    expect(classifyCursorSdkError(new CursorSdkError('cursor-agent-busy', 'x'))).toBe('cursor-agent-busy')
  })

  it('returns a stable auth message for authentication-required failures', () => {
    expect(cursorSdkErrorMessage({ name: 'AuthenticationError', message: 'CURSOR_API_KEY=leak' })).toMatch(
      /Sign in again/
    )
    expect(cursorSdkErrorMessage({ name: 'AuthenticationError', message: 'CURSOR_API_KEY=leak' })).not.toContain('leak')
  })
})
