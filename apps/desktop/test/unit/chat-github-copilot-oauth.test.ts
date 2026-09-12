import { describe, expect, it, vi } from 'vitest'
import { GitHubCopilotOAuthClient, type GitHubCopilotOAuthFetch } from '../../src/main/chat/github-copilot/oauth'

function response(payload: unknown, status = 200): Awaited<ReturnType<GitHubCopilotOAuthFetch>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  }
}

describe('GitHubCopilotOAuthClient', () => {
  it('starts public-client Device Flow without secrets', async () => {
    const fetch = vi.fn<GitHubCopilotOAuthFetch>(async () =>
      response({
        device_code: 'private-device-code',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://github.com/login/device',
        verification_uri_complete: 'https://github.com/login/device?user_code=ABCD-EFGH',
        expires_in: 900,
        interval: 5,
      })
    )
    const client = new GitHubCopilotOAuthClient({
      clientId: 'maestrly-public-client-id',
      dependencies: { fetch, now: () => 10_000 },
    })

    const authorization = await client.startDeviceFlow()

    expect(authorization).toEqual({
      deviceCode: 'private-device-code',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://github.com/login/device',
      verificationUriComplete: 'https://github.com/login/device?user_code=ABCD-EFGH',
      expiresAt: 910_000,
      intervalSeconds: 5,
    })
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('https://github.com/login/device/code')
    expect(init.method).toBe('POST')
    expect(new URLSearchParams(String(init.body))).toEqual(
      new URLSearchParams({ client_id: 'maestrly-public-client-id', scope: 'read:user' })
    )
    expect(String(init.body)).not.toMatch(/secret/i)
  })

  it('respects pending authorization and slow_down intervals', async () => {
    let now = 0
    const sleeps: number[] = []
    const payloads = [
      { error: 'authorization_pending' },
      { error: 'slow_down' },
      { access_token: 'gho_private_token', token_type: 'bearer', scope: 'read:user' },
    ]
    const fetch = vi.fn<GitHubCopilotOAuthFetch>(async () => response(payloads.shift()))
    const client = new GitHubCopilotOAuthClient({
      clientId: 'public-id',
      dependencies: {
        fetch,
        now: () => now,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds)
          now += milliseconds
        },
      },
    })

    const token = await client.pollForToken({
      deviceCode: 'device-private',
      userCode: 'PUBLIC-CODE',
      verificationUri: 'https://github.com/login/device',
      verificationUriComplete: null,
      expiresAt: 60_000,
      intervalSeconds: 5,
    })

    expect(token).toEqual({ accessToken: 'gho_private_token', tokenType: 'bearer', scope: 'read:user' })
    expect(sleeps).toEqual([5_000, 5_000, 10_000])
    expect(fetch).toHaveBeenCalledTimes(3)
    for (const [, init] of fetch.mock.calls) {
      const body = new URLSearchParams(String(init.body))
      expect([...body.keys()].sort()).toEqual(['client_id', 'device_code', 'grant_type'])
      expect(body.has('client_secret')).toBe(false)
    }
  })

  it('reports denial without exposing device codes', async () => {
    let now = 0
    const client = new GitHubCopilotOAuthClient({
      clientId: 'public-id',
      dependencies: {
        fetch: async () => response({ error: 'access_denied', error_description: 'The user denied the request' }),
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds
        },
      },
    })

    const promise = client.pollForToken({
      deviceCode: 'device-must-not-leak',
      userCode: 'CODE',
      verificationUri: 'https://github.com/login/device',
      verificationUriComplete: null,
      expiresAt: 10_000,
      intervalSeconds: 1,
    })

    await expect(promise).rejects.toMatchObject({ code: 'access_denied' })
    await expect(promise).rejects.not.toThrow(/device-must-not-leak/)
  })

  it('fails before network access without public client IDs', async () => {
    const fetch = vi.fn<GitHubCopilotOAuthFetch>()
    const client = new GitHubCopilotOAuthClient({ clientId: '', dependencies: { fetch } })

    await expect(client.startDeviceFlow()).rejects.toMatchObject({
      code: 'configuration_missing',
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})
