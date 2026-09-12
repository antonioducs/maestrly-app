import { describe, expect, it, vi } from 'vitest'
import {
  GrokOAuthClient,
  GrokOAuthError,
  accessTokenNeedsRefresh,
  generatePkce,
  parseOAuthCallbackInput,
  type GrokOAuthFetch,
} from '../../src/main/chat/grok-subscription/oauth'
import { redactGrokErrorMessage } from '../../src/main/chat/grok-subscription/errors'

function response(payload: unknown, status = 200): Awaited<ReturnType<GrokOAuthFetch>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  }
}

describe('Grok OAuth helpers', () => {
  it('generates distinct S256 verifier and challenge', () => {
    const pkce = generatePkce(() => Buffer.from('a'.repeat(48)))
    expect(pkce.verifier).toBeTruthy()
    expect(pkce.challenge).toBeTruthy()
    expect(pkce.challenge).not.toBe(pkce.verifier)
    expect(pkce.challenge).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('rejects invalid OAuth state without echoing tokens', () => {
    const result = parseOAuthCallbackInput(
      'http://127.0.0.1:56121/callback?code=secret-code&state=wrong',
      'expected-state'
    )
    expect(result).toEqual({ error: 'OAuth state mismatch.', code: 'state_mismatch' })
    expect(JSON.stringify(result)).not.toContain('secret-code')
  })

  it('detects expiry within a two-minute margin', () => {
    const now = 1_000_000
    expect(accessTokenNeedsRefresh({ accessToken: 'opaque', expiresAt: now + 60_000 }, now)).toBe(true)
    expect(accessTokenNeedsRefresh({ accessToken: 'opaque', expiresAt: now + 180_000 }, now)).toBe(false)
  })

  it('redacts device codes and JWTs from public messages', () => {
    const redacted = redactGrokErrorMessage(
      'Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig device_code=abc123 refresh_token=rt_secret'
    )
    expect(redacted).not.toContain('eyJ')
    expect(redacted).not.toContain('abc123')
    expect(redacted).not.toContain('rt_secret')
    expect(redacted).toContain('[REDACTED]')
  })
})

describe('GrokOAuthClient device flow', () => {
  it('requires a configured client ID', async () => {
    const client = new GrokOAuthClient({ clientId: '' })
    await expect(client.startDeviceFlow()).rejects.toMatchObject({ code: 'configuration_missing' })
  })

  it('handles pending and slow-down states without leaking codes', async () => {
    let now = 0
    const sleeps: number[] = []
    const payloads = [
      {
        authorization_endpoint: 'https://auth.x.ai/oauth2/authorize',
        token_endpoint: 'https://auth.x.ai/oauth2/token',
        device_authorization_endpoint: 'https://auth.x.ai/oauth2/device/code',
        userinfo_endpoint: 'https://auth.x.ai/oauth2/userinfo',
      },
      {
        device_code: 'private-device',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://auth.x.ai/device',
        expires_in: 900,
        interval: 5,
      },
      { error: 'authorization_pending' },
      { error: 'slow_down' },
      {
        access_token: 'access-secret',
        refresh_token: 'refresh-secret',
        expires_in: 3600,
      },
    ]
    const fetch = vi.fn<GrokOAuthFetch>(async () => response(payloads.shift()))
    const client = new GrokOAuthClient({
      clientId: 'maestrly-test-client',
      dependencies: {
        fetch,
        now: () => now,
        sleep: async (ms) => {
          sleeps.push(ms)
          now += ms
        },
      },
    })

    const authorization = await client.startDeviceFlow()
    expect(authorization.userCode).toBe('ABCD-EFGH')
    expect(authorization.deviceCode).toBe('private-device')

    const token = await client.pollForDeviceToken(authorization)
    expect(token.accessToken).toBe('access-secret')
    expect(token.refreshToken).toBe('refresh-secret')
    expect(sleeps).toEqual([5_000, 5_000, 10_000])

    for (const [, init] of fetch.mock.calls) {
      const body = String(init?.body ?? '')
      expect(body).not.toMatch(/secret/i)
      expect(JSON.stringify(init)).not.toMatch(/access-secret|refresh-secret/)
    }
  })

  it('propagates denied access without device codes', async () => {
    let now = 0
    const client = new GrokOAuthClient({
      clientId: 'public-id',
      dependencies: {
        fetch: async (url) => {
          if (String(url).includes('openid-configuration')) {
            return response({
              authorization_endpoint: 'https://auth.x.ai/oauth2/authorize',
              token_endpoint: 'https://auth.x.ai/oauth2/token',
              device_authorization_endpoint: 'https://auth.x.ai/oauth2/device/code',
              userinfo_endpoint: 'https://auth.x.ai/oauth2/userinfo',
            })
          }
          if (String(url).includes('device/code')) {
            return response({
              device_code: 'should-not-leak',
              user_code: 'CODE',
              verification_uri: 'https://auth.x.ai/device',
              expires_in: 60,
              interval: 1,
            })
          }
          return response({ error: 'access_denied', error_description: 'denied by user' })
        },
        now: () => now,
        sleep: async (ms) => {
          now += ms
        },
      },
    })
    const authorization = await client.startDeviceFlow()
    try {
      await client.pollForDeviceToken(authorization)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(GrokOAuthError)
      expect((error as Error).message).not.toContain('should-not-leak')
      expect((error as GrokOAuthError).code).toBe('access_denied')
    }
  })

  it('marks refresh invalid_grant failures', async () => {
    const client = new GrokOAuthClient({
      clientId: 'public-id',
      dependencies: {
        fetch: async () => response({ error: 'invalid_grant', error_description: 'revoked' }, 400),
        now: () => 0,
      },
    })
    await expect(client.refresh('rt')).rejects.toMatchObject({ code: 'invalid_grant' })
  })
})

describe('GrokOAuthClient device flow — token endpoint descoberto', () => {
  it('polls the exact discovered valid x.ai endpoint', async () => {
    let now = 0
    const discoveredTokenUrl = 'https://token-eu.x.ai/oauth2/token'
    const requestedUrls: string[] = []
    const payloads = [
      {
        authorization_endpoint: 'https://auth.x.ai/oauth2/authorize',
        token_endpoint: discoveredTokenUrl,
        device_authorization_endpoint: 'https://auth.x.ai/oauth2/device/code',
        userinfo_endpoint: 'https://auth.x.ai/oauth2/userinfo',
      },
      {
        device_code: 'device-secret',
        user_code: 'CODE',
        verification_uri: 'https://auth.x.ai/device',
        expires_in: 60,
        interval: 1,
      },
      { error: 'authorization_pending' },
      {
        access_token: 'access-secret',
        refresh_token: 'refresh-secret',
        expires_in: 3600,
      },
    ]
    const client = new GrokOAuthClient({
      clientId: 'public-id',
      dependencies: {
        fetch: async (url) => {
          requestedUrls.push(String(url))
          return response(payloads.shift())
        },
        now: () => now,
        sleep: async (ms) => {
          now += ms
        },
      },
    })

    const authorization = await client.startDeviceFlow()
    expect(authorization.tokenEndpoint).toBe(discoveredTokenUrl)

    const token = await client.pollForDeviceToken(authorization)
    expect(token.accessToken).toBe('access-secret')
    // Every poll (pending and success) uses exactly the discovered endpoint, never the hardcoded one.
    const tokenRequests = requestedUrls.filter((url) => url.includes('/token'))
    expect(tokenRequests.length).toBeGreaterThanOrEqual(2)
    expect(tokenRequests.every((url) => url === discoveredTokenUrl)).toBe(true)
    expect(requestedUrls).not.toContain('https://auth.x.ai/oauth2/token')
  })

  it('rejects discovered token_endpoint outside x.ai', async () => {
    const client = new GrokOAuthClient({
      clientId: 'public-id',
      dependencies: {
        fetch: async (url) => {
          if (String(url).includes('openid-configuration')) {
            return response({
              authorization_endpoint: 'https://auth.x.ai/oauth2/authorize',
              token_endpoint: 'https://evil.example/token',
              device_authorization_endpoint: 'https://auth.x.ai/oauth2/device/code',
              userinfo_endpoint: 'https://auth.x.ai/oauth2/userinfo',
            })
          }
          return response({ error: 'invalid_request' })
        },
        now: () => 0,
        sleep: async () => {},
      },
    })
    await expect(client.startDeviceFlow()).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('returns browser URLs without opening windows', async () => {
    const client = new GrokOAuthClient({
      clientId: 'public-id',
      dependencies: {
        fetch: async (url) => {
          if (String(url).includes('openid-configuration')) {
            return response({
              authorization_endpoint: 'https://auth.x.ai/oauth2/authorize',
              token_endpoint: 'https://auth.x.ai/oauth2/token',
              device_authorization_endpoint: 'https://auth.x.ai/oauth2/device/code',
              userinfo_endpoint: 'https://auth.x.ai/oauth2/userinfo',
            })
          }
          return response({ error: 'unexpected' })
        },
      },
    })
    const result = await client.startBrowserLogin()
    expect(result.authUrl).toContain('https://auth.x.ai/oauth2/authorize')
    expect(result.listener.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    // Without an openAuthorizeUrl dependency, return URLs and leave opening to
    // the renderer. Abort closes listeners without opening another tab.
    const controller = new AbortController()
    controller.abort()
    await expect(
      client.completeBrowserLogin({ ...result, listener: result.listener }, controller.signal)
    ).rejects.toMatchObject({ code: 'cancelled' })
  })
})
