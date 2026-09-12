import { afterEach, describe, expect, it, vi } from 'vitest'
import { type GrokOAuthClient, GrokOAuthError } from '../../src/main/chat/grok-subscription/oauth'
import {
  GrokNotAuthenticatedError,
  GrokSubscriptionManager,
  resolveGrokOAuthClientId,
} from '../../src/main/chat/grok-subscription/manager'
import { createGrokTokenStore, type GrokTokenBundle } from '../../src/main/chat/grok-subscription/token-store'

/** Fake JWT with a `sub` claim: identity comes from id_token, never access tokens. */
function idTokenWithSubject(sub: string): string {
  const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${b64({ alg: 'none' })}.${b64({ sub })}.sig`
}

function memoryStore(initial: GrokTokenBundle | null = null) {
  let bundle = initial
  return createGrokTokenStore({
    getPersisted: () => (bundle ? JSON.stringify(bundle) : null),
    setPersisted: (_key, value) => {
      bundle = JSON.parse(value) as GrokTokenBundle
      return true
    },
    removePersisted: () => {
      bundle = null
      return true
    },
    secureStorageMode: () => 'secure',
  })
}

function baseOAuthMock() {
  return {
    refresh: vi.fn(),
    fetchUserInfo: vi.fn(async () => ({ email: 'u@x.ai', name: 'User', planType: 'SuperGrok' })),
    startBrowserLogin: vi.fn(),
    startDeviceFlow: vi.fn(),
    completeBrowserLogin: vi.fn(),
    pollForDeviceToken: vi.fn(),
    discover: vi.fn(),
  }
}

function makeManager(options: {
  store: ReturnType<typeof memoryStore>
  oauth?: ReturnType<typeof baseOAuthMock>
  fetch?: typeof fetch
  now?: () => number
}) {
  const oauth = options.oauth ?? baseOAuthMock()
  const manager = new GrokSubscriptionManager({
    getOAuthClientId: () => 'client',
    createOAuthClient: () => oauth as unknown as GrokOAuthClient,
    tokenStore: options.store,
    now: options.now ?? (() => Date.now()),
    fetch: options.fetch ?? (vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch),
    getUserAgent: () => 'maestrly-test',
    createLoginId: () => 'sess-' + Math.random().toString(36).slice(2),
  })
  return { oauth, manager }
}

const withSession = (
  bundle: Partial<GrokTokenBundle> & { refreshToken: string; accessToken: string }
): GrokTokenBundle => ({
  sessionId: 'sess-stable',
  expiresAt: Date.now() + 3_600_000,
  ...bundle,
})

describe('resolveGrokOAuthClientId', () => {
  it('uses the public Grok-CLI/OpenCode client by default in every build', () => {
    expect(resolveGrokOAuthClientId({ packaged: true })).toBe('b1a00492-073a-47ea-816f-4c329264a828')
    expect(resolveGrokOAuthClientId({ packaged: false })).toBe('b1a00492-073a-47ea-816f-4c329264a828')
  })

  it('allows build or development overrides', () => {
    expect(
      resolveGrokOAuthClientId({
        packaged: true,
        buildClientId: 'build-client',
      })
    ).toBe('build-client')
    expect(
      resolveGrokOAuthClientId({
        packaged: false,
        developmentClientId: 'dev-client',
      })
    ).toBe('dev-client')
  })
})

describe('GrokSubscriptionManager', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('deduplicates proactive refresh and rotates tokens', async () => {
    const now = 1_000_000
    let refreshCalls = 0
    const store = memoryStore(
      withSession({
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: now + 30_000,
      })
    )
    const { oauth, manager } = makeManager({
      store,
      now: () => now,
      oauth: {
        ...baseOAuthMock(),
        refresh: vi.fn(async () => {
          refreshCalls += 1
          await new Promise((r) => setTimeout(r, 5))
          return {
            accessToken: 'new-access',
            refreshToken: 'new-refresh',
            expiresAt: now + 3_600_000,
          }
        }),
      },
    })

    const [a, b] = await Promise.all([manager.getAccessToken(), manager.getAccessToken()])
    expect(a).toBe('new-access')
    expect(b).toBe('new-access')
    expect(refreshCalls).toBe(1)
    expect(store.get()?.refreshToken).toBe('new-refresh')
  })

  it('rotating refresh neither increments the epoch nor announces an account change', async () => {
    const now = 1_000_000
    const store = memoryStore(
      withSession({
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: now + 30_000,
      })
    )
    const { oauth, manager } = makeManager({
      store,
      now: () => now,
      oauth: {
        ...baseOAuthMock(),
        refresh: vi.fn(async () => ({
          accessToken: 'rotated-access',
          refreshToken: 'rotated-refresh',
          expiresAt: now + 3_600_000,
        })),
      },
    })
    const authUpdated = vi.fn()
    manager.onAuthUpdated(authUpdated)
    const identityBefore = manager.getAccountIdentity()

    await manager.getAccessToken()

    expect(identityBefore.fingerprint).not.toBeNull()
    expect(manager.getAccountIdentity()).toEqual(identityBefore)
    expect(authUpdated).not.toHaveBeenCalled()
    expect(store.get()?.refreshToken).toBe('rotated-refresh')
    expect(store.get()?.sessionId).toBe('sess-stable')
    // Operations admitted before refresh remain valid; refresh is not an identity boundary.
    expect(() => manager.assertAccountIdentity(identityBefore)).not.toThrow()
  })

  it('preserves stable id_token subject across rotating refresh tokens', async () => {
    const now = 1_000_000
    const store = memoryStore(
      withSession({
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: now + 30_000,
        idToken: idTokenWithSubject('user-42'),
      })
    )
    const { oauth, manager } = makeManager({
      store,
      now: () => now,
      oauth: {
        ...baseOAuthMock(),
        refresh: vi.fn(async () => ({
          accessToken: 'new-access',
          refreshToken: 'new-refresh',
          expiresAt: now + 3_600_000,
          idToken: idTokenWithSubject('user-42'),
        })),
      },
    })
    const identityBefore = manager.getAccountIdentity()

    await manager.getAccessToken()

    expect(identityBefore.fingerprint).toMatch(/^sha256:sub:/)
    expect(manager.getAccountIdentity()).toEqual(identityBefore)
    expect(() => manager.assertAccountIdentity(identityBefore)).not.toThrow()
  })

  it('increments epoch and invalidates admitted operations when subject changes', async () => {
    const now = 1_000_000
    const store = memoryStore(
      withSession({
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: now + 30_000,
        idToken: idTokenWithSubject('user-42'),
      })
    )
    const { oauth, manager } = makeManager({
      store,
      now: () => now,
      oauth: {
        ...baseOAuthMock(),
        refresh: vi.fn(async () => ({
          accessToken: 'new-access',
          refreshToken: 'new-refresh',
          expiresAt: now + 3_600_000,
          idToken: idTokenWithSubject('user-999'),
        })),
      },
    })
    const authUpdated = vi.fn()
    manager.onAuthUpdated(authUpdated)
    const identityBefore = manager.getAccountIdentity()

    await manager.getAccessToken()

    expect(manager.getAccountIdentity().epoch).toBe(identityBefore.epoch + 1)
    expect(manager.getAccountIdentity().fingerprint).not.toBe(identityBefore.fingerprint)
    expect(authUpdated).toHaveBeenCalledTimes(1)
    expect(() => manager.assertAccountIdentity(identityBefore)).toThrow(/Grok account changed/)
  })

  it('clears the session and increments epoch on invalid_grant', async () => {
    const store = memoryStore(
      withSession({
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: Date.now() - 1_000,
      })
    )
    const { oauth, manager } = makeManager({
      store,
      oauth: {
        ...baseOAuthMock(),
        refresh: vi.fn(async () => {
          throw new GrokOAuthError('invalid_grant', 'revoked')
        }),
      },
    })
    const identityBefore = manager.getAccountIdentity()
    const authUpdated = vi.fn()
    manager.onAuthUpdated(authUpdated)

    await expect(manager.getAccessToken()).rejects.toBeInstanceOf(GrokOAuthError)
    expect(store.get()).toBeNull()
    expect(manager.getAccountIdentity().fingerprint).toBeNull()
    expect(manager.getAccountIdentity().epoch).toBe(identityBefore.epoch + 1)
    expect(authUpdated).toHaveBeenCalled()
    expect(() => manager.resolveRuntimeCredential()).toThrow(GrokNotAuthenticatedError)
  })

  it('authenticatedFetch overwrites Authorization without mutating the original headers', async () => {
    const store = memoryStore(withSession({ accessToken: 'live-access', refreshToken: 'live-refresh' }))
    const seenAuth: string[] = []
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      seenAuth.push(headers.get('Authorization') ?? '')
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    const manager = new GrokSubscriptionManager({
      getOAuthClientId: () => 'client',
      createOAuthClient: () => ({}) as GrokOAuthClient,
      tokenStore: store,
      now: () => Date.now(),
      fetch: fetchImpl as unknown as typeof fetch,
      getUserAgent: () => 'maestrly-test',
    })

    const original = { Authorization: 'Bearer dummy-from-sdk', Accept: 'application/json' }
    await manager.authenticatedFetch('https://api.x.ai/v1/models', { headers: original })
    expect(seenAuth[0]).toBe('Bearer live-access')
    expect(original.Authorization).toBe('Bearer dummy-from-sdk')
    expect(manager.resolveRuntimeCredential().fingerprint).not.toContain('live-access')
    expect(() => manager.resolveRuntimeCredential().apiKey).not.toThrow()
  })

  it('refreshes near-expiry tokens before authenticatedFetch', async () => {
    const now = 1_000_000
    const store = memoryStore(
      withSession({
        accessToken: 'expiring-access',
        refreshToken: 'old-refresh',
        expiresAt: now + 60_000,
      })
    )
    const { oauth, manager } = makeManager({
      store,
      now: () => now,
      oauth: {
        ...baseOAuthMock(),
        refresh: vi.fn(async () => ({
          accessToken: 'fresh-access',
          refreshToken: 'rotated-refresh',
          expiresAt: now + 3_600_000,
        })),
      },
    })
    const identity = manager.getAccountIdentity()
    const seenAuth: string[] = []
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      seenAuth.push(new Headers(init?.headers).get('Authorization') ?? '')
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    // Replace the dependency-provided fetch with a spy.
    ;(manager as unknown as { dependencies: { fetch: typeof fetch } }).dependencies.fetch =
      fetchImpl as unknown as typeof fetch

    const response = await manager.authenticatedFetch('https://api.x.ai/v1/models')
    expect(response.status).toBe(200)
    expect(seenAuth[0]).toBe('Bearer fresh-access')
    // Normal refresh does not abort previously admitted operations.
    expect(() => manager.assertAccountIdentity(identity)).not.toThrow()
  })

  it('retries authenticatedFetch after 401 with the same account', async () => {
    const now = 1_000_000
    const store = memoryStore(
      withSession({
        accessToken: 'live-access',
        refreshToken: 'live-refresh',
        expiresAt: now + 3_600_000,
      })
    )
    const { oauth, manager } = makeManager({
      store,
      now: () => now,
      oauth: {
        ...baseOAuthMock(),
        refresh: vi.fn(async () => ({
          accessToken: 'retried-access',
          refreshToken: 'rotated-refresh',
          expiresAt: now + 3_600_000,
        })),
      },
    })
    const identity = manager.getAccountIdentity()
    // Capture headers at call time because retries mutate the same Headers object.
    const seenAuth: string[] = []
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      seenAuth.push(new Headers(init?.headers).get('Authorization') ?? '')
      const call = seenAuth.length
      return call === 1
        ? new Response('{"error":"expired"}', { status: 401 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    ;(manager as unknown as { dependencies: { fetch: typeof fetch } }).dependencies.fetch =
      fetchImpl as unknown as typeof fetch

    const result = await manager.authenticatedFetch('https://api.x.ai/v1/models', {
      headers: { Accept: 'application/json' },
    })
    expect(result.status).toBe(200)
    expect(seenAuth).toEqual(['Bearer live-access', 'Bearer retried-access'])
    expect(() => manager.assertAccountIdentity(identity)).not.toThrow()
  })

  it('rejects token delivery outside api.x.ai', async () => {
    const store = memoryStore(withSession({ accessToken: 'live-access', refreshToken: 'live-refresh' }))
    const manager = new GrokSubscriptionManager({
      getOAuthClientId: () => 'client',
      createOAuthClient: () => ({}) as GrokOAuthClient,
      tokenStore: store,
      now: () => Date.now(),
      fetch: vi.fn() as unknown as typeof fetch,
      getUserAgent: () => 'maestrly-test',
    })
    await expect(manager.authenticatedFetch('https://evil.example/v1/models')).rejects.toThrow(/non-xAI/)
  })

  it('clears credentials and authentication on logout', async () => {
    const store = memoryStore(withSession({ accessToken: 'live-access', refreshToken: 'live-refresh' }))
    const manager = new GrokSubscriptionManager({
      getOAuthClientId: () => 'client',
      createOAuthClient: () => ({}) as GrokOAuthClient,
      tokenStore: store,
      now: () => Date.now(),
      fetch: vi.fn() as unknown as typeof fetch,
      getUserAgent: () => 'maestrly-test',
    })
    await manager.logout()
    expect(store.get()).toBeNull()
    expect(() => manager.resolveRuntimeCredential()).toThrow(GrokNotAuthenticatedError)
  })

  it('prevents token persistence when logout interrupts refresh', async () => {
    const now = 1_000_000
    let resolveRefresh!: (bundle: GrokTokenBundle) => void
    const store = memoryStore(
      withSession({
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: now + 30_000,
      })
    )
    const { oauth, manager } = makeManager({
      store,
      now: () => now,
      oauth: {
        ...baseOAuthMock(),
        refresh: vi.fn(
          () =>
            new Promise<GrokTokenBundle>((resolve) => {
              resolveRefresh = resolve
            })
        ),
      },
    })

    const pending = manager.getAccessToken().catch((error) => error)
    await vi.waitFor(() => expect(oauth.refresh).toHaveBeenCalledTimes(1))
    await manager.logout()
    resolveRefresh({
      accessToken: 'stale-access',
      refreshToken: 'stale-refresh',
      expiresAt: now + 3_600_000,
    })

    const outcome = await pending
    expect(outcome).toBeInstanceOf(GrokOAuthError)
    expect(store.get()).toBeNull()
  })

  it('awaits refresh and invalidates pending persistence on dispose', async () => {
    const now = 1_000_000
    let resolveRefresh!: (bundle: GrokTokenBundle) => void
    const store = memoryStore(
      withSession({
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: now + 30_000,
      })
    )
    const { oauth, manager } = makeManager({
      store,
      now: () => now,
      oauth: {
        ...baseOAuthMock(),
        refresh: vi.fn(
          () =>
            new Promise<GrokTokenBundle>((resolve) => {
              resolveRefresh = resolve
            })
        ),
      },
    })

    const pending = manager.getAccessToken().catch((error) => error)
    await vi.waitFor(() => expect(oauth.refresh).toHaveBeenCalledTimes(1))
    const disposing = manager.dispose()
    resolveRefresh({
      accessToken: 'stale-access',
      refreshToken: 'stale-refresh',
      expiresAt: now + 3_600_000,
    })

    await disposing
    const outcome = await pending
    expect(outcome).toBeInstanceOf(GrokOAuthError)
    // Stale refresh did not persist; the previous bundle remains intact.
    expect(store.get()?.accessToken).toBe('old-access')
    expect(manager.isDisposed).toBe(true)
  })

  it('cancels pending login when a new login starts', async () => {
    const now = 1_000_000
    const store = memoryStore()
    let loginCalls = 0
    const listeners: Array<{
      waitForCallback: () => Promise<never>
      close: ReturnType<typeof vi.fn<() => Promise<void>>>
    }> = []
    const { manager } = makeManager({
      store,
      now: () => now,
      oauth: {
        ...baseOAuthMock(),
        startBrowserLogin: vi.fn(async () => {
          loginCalls += 1
          const listener = {
            redirectUri: `http://127.0.0.1:${56_121 + loginCalls}/callback`,
            port: 56_121 + loginCalls,
            waitForCallback: () => new Promise<never>(() => {}),
            close: vi.fn(async () => {}),
          }
          listeners.push(listener)
          return {
            authUrl: `https://auth.x.ai/oauth2/authorize?login=${loginCalls}`,
            redirectUri: listener.redirectUri,
            state: 'state',
            nonce: 'nonce',
            pkce: { verifier: 'v', challenge: 'c' },
            discovery: {
              authorizationEndpoint: 'https://auth.x.ai/oauth2/authorize',
              tokenEndpoint: 'https://auth.x.ai/oauth2/token',
              deviceAuthorizationEndpoint: 'https://auth.x.ai/oauth2/device/code',
              userinfoEndpoint: 'https://auth.x.ai/oauth2/userinfo',
            },
            listener,
          }
        }),
        completeBrowserLogin: vi.fn(async (_session: unknown, signal?: AbortSignal) => {
          // Real GrokOAuthClient contract: waits for the callback, rejects on abort, and closes the listener.
          const listener = listeners[listeners.length - 1]
          try {
            await new Promise<never>((_resolve, reject) => {
              if (signal?.aborted) return reject(new GrokOAuthError('cancelled', 'cancelled'))
              signal?.addEventListener('abort', () => reject(new GrokOAuthError('cancelled', 'cancelled')), {
                once: true,
              })
            })
          } finally {
            await listener.close()
          }
        }),
      },
    })

    const first = await manager.startLogin('browser')
    const second = await manager.startLogin('browser')
    expect(first.loginId).not.toBe(second.loginId)
    // Cancellation closes the first login listener.
    await vi.waitFor(() => expect(listeners[0].close).toHaveBeenCalled())

    const completion = await manager.waitForLogin(first.loginId)
    expect(completion.success).toBe(false)
    expect(manager.getLoginStatus(first.loginId)?.state).toBe('cancelled')
    // The second login remains pending.
    expect(manager.getLoginStatus(second.loginId)?.state).toBe('pending')
  })

  it('logout during a pending browser callback closes the listener and clears registrations', async () => {
    const now = 1_000_000
    const store = memoryStore()
    const listener = {
      redirectUri: 'http://127.0.0.1:56121/callback',
      port: 56_121,
      waitForCallback: () => new Promise<never>(() => {}),
      close: vi.fn(async () => {}),
    }
    const { manager } = makeManager({
      store,
      now: () => now,
      oauth: {
        ...baseOAuthMock(),
        startBrowserLogin: vi.fn(async () => ({
          authUrl: 'https://auth.x.ai/oauth2/authorize',
          redirectUri: listener.redirectUri,
          state: 'state',
          nonce: 'nonce',
          pkce: { verifier: 'v', challenge: 'c' },
          discovery: {
            authorizationEndpoint: 'https://auth.x.ai/oauth2/authorize',
            tokenEndpoint: 'https://auth.x.ai/oauth2/token',
            deviceAuthorizationEndpoint: 'https://auth.x.ai/oauth2/device/code',
            userinfoEndpoint: 'https://auth.x.ai/oauth2/userinfo',
          },
          listener,
        })),
        completeBrowserLogin: vi.fn(async (_session: unknown, signal?: AbortSignal) => {
          try {
            await new Promise<never>((_resolve, reject) => {
              if (signal?.aborted) return reject(new GrokOAuthError('cancelled', 'cancelled'))
              signal?.addEventListener('abort', () => reject(new GrokOAuthError('cancelled', 'cancelled')), {
                once: true,
              })
            })
          } finally {
            await listener.close()
          }
        }),
      },
    })

    const attempt = await manager.startLogin('browser')
    await manager.logout()
    expect(listener.close).toHaveBeenCalled()
    expect(manager.getLoginStatus(attempt.loginId)).toBeNull()
  })
})
