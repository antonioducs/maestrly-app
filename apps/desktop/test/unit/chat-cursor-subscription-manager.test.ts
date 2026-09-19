import { withCursorAccountRun } from '../../src/main/chat/cursor-subscription/account-runs'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentOptions, LocalAgentStore, SDKAgent, SDKUser } from '@cursor/sdk'
import {
  CursorSubscriptionAccountChangedError,
  CursorSubscriptionManager,
  cursorIdentityFingerprint,
  getCursorSubscriptionManager,
  listCursorSubscriptionManagers,
  type CursorSubscriptionManagerDependencies,
  type CursorSubscriptionSdk,
} from '../../src/main/chat/cursor-subscription/manager'
import { createCursorTokenStore, type CursorTokenStore } from '../../src/main/chat/cursor-subscription/token-store'
import { listCursorAgentCleanup } from '../../src/main/chat/cursor-subscription/session-store'
import { closeDb, freshDb } from '../helpers/db'

function me(overrides: Partial<SDKUser> = {}): SDKUser {
  return {
    apiKeyName: 'maestrly',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

const COMPOSER_CATALOG = [
  {
    id: 'composer-2.5',
    displayName: 'Composer 2.5',
    parameters: [
      {
        id: 'fast',
        values: [
          { value: 'true', displayName: 'Fast' },
          { value: 'false', displayName: 'Standard' },
        ],
      },
    ],
  },
]

function inMemoryFakeStore(): LocalAgentStore {
  let disposed = false
  const assertAlive = (): void => {
    if (disposed) throw new Error('store already disposed')
  }
  return {
    dispose: vi.fn(async () => {
      disposed = true
    }),
    agents: {
      get: vi.fn(async () => {
        assertAlive()
        return null
      }),
      create: vi.fn(async (input: { agent: unknown }) => {
        assertAlive()
        return input.agent as never
      }),
      update: vi.fn(async (input: { agent: unknown }) => {
        assertAlive()
        return input.agent as never
      }),
      delete: vi.fn(async () => {
        assertAlive()
      }),
      list: vi.fn(async () => {
        assertAlive()
        return { items: [] }
      }),
    },
    runs: {
      get: async () => null,
      create: async (input: { run: unknown }) => input.run as never,
      update: async (input: { run: unknown }) => input.run as never,
      delete: async () => undefined,
      list: async () => ({ items: [] }),
    },
    checkpoints: {
      get: async () => null,
      create: async () => undefined,
      update: async () => undefined,
      delete: async () => undefined,
      list: async () => ({ items: [] }),
    },
    runEvents: {
      append: async () => undefined,
      list: async () => ({ items: [] }),
      delete: async () => undefined,
    },
  } as unknown as LocalAgentStore
}

function fakeStoreDispose(store: LocalAgentStore): ReturnType<typeof vi.fn> {
  return (store as unknown as { dispose: ReturnType<typeof vi.fn> }).dispose
}

function fakeStoreDelete(store: LocalAgentStore): ReturnType<typeof vi.fn> {
  return (store as unknown as { agents: { delete: ReturnType<typeof vi.fn> } }).agents.delete
}

function fakeSdk(options: {
  user?: SDKUser
  getUser?: () => SDKUser
  models?: unknown
  loginResult?:
    | { apiKey: string; email?: string; apiKeyExpiresAtMs: number }
    | ((callIndex: number) => { apiKey: string; email?: string; apiKeyExpiresAtMs: number })
  loginUrl?: string
}): CursorSubscriptionSdk {
  const user = options.user ?? me({ userId: 7, userEmail: 'a@example.com' })
  const getUser = options.getUser ?? (() => user)
  let loginCalls = 0
  return {
    Agent: {
      create: vi.fn(async (agentOptions) => ({
        agentId: 'agent-created',
        model: agentOptions.model,
        send: vi.fn(),
        close: vi.fn(),
        reload: vi.fn(),
        [Symbol.asyncDispose]: async () => undefined,
        listArtifacts: async () => [],
        downloadArtifact: async () => Buffer.alloc(0),
        getUsage: async () =>
          ({
            usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
            runs: [],
          }) as never,
      })),
      resume: vi.fn(async (agentId) => ({
        agentId,
        model: undefined,
        send: vi.fn(),
        close: vi.fn(),
        reload: vi.fn(),
        [Symbol.asyncDispose]: async () => undefined,
        listArtifacts: async () => [],
        downloadArtifact: async () => Buffer.alloc(0),
        getUsage: async () =>
          ({
            usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
            runs: [],
          }) as never,
      })),
    },
    Cursor: {
      me: vi.fn(async () => getUser()),
      models: { list: vi.fn(async () => options.models ?? COMPOSER_CATALOG) },
      auth: {
        login: vi.fn(async (loginOptions: { onLoginUrl?: (url: string) => void; signal?: AbortSignal } | undefined) => {
          const loginResult =
            typeof options.loginResult === 'function' ? options.loginResult(loginCalls) : options.loginResult
          loginCalls += 1
          loginOptions?.onLoginUrl?.(options.loginUrl ?? 'https://cursor.example/login')
          await new Promise((resolve, reject) => {
            loginOptions?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
            setTimeout(resolve, 20)
          })
          return loginResult ?? { apiKey: 'crsr_login_key', apiKeyExpiresAtMs: Date.now() + 100_000 }
        }),
      },
    },
  }
}

interface Harness {
  manager: CursorSubscriptionManager
  tokenStore: CursorTokenStore
  sdk: CursorSubscriptionSdk
  userDataPath: string
}

function memoryTokenStore(): CursorTokenStore {
  const persisted = new Map<string, string>()
  return createCursorTokenStore({
    getPersisted: (key) => persisted.get(key) ?? null,
    setPersisted: (key, value) => {
      persisted.set(key, value)
      return true
    },
    removePersisted: (key) => persisted.delete(key),
    secureStorageMode: () => 'unavailable',
  })
}

let loginSeq = 0

interface StoreProbe {
  openStore: (options: { stateRoot: string; workspaceRef: string }) => Promise<LocalAgentStore>
  created: LocalAgentStore[]
  opened: () => number
  stores: () => LocalAgentStore[]
}

function storeProbe(deferred?: () => Promise<void>): StoreProbe {
  const created: LocalAgentStore[] = []
  const openStore = async (): Promise<LocalAgentStore> => {
    if (deferred) await deferred()
    const store = inMemoryFakeStore()
    created.push(store)
    return store
  }
  return {
    openStore,
    created,
    opened: () => created.length,
    stores: () => [...created],
  }
}

function harness(
  overrides: {
    sdk?: CursorSubscriptionSdk
    tokenStore?: CursorTokenStore
    accountId?: string | null
    openStore?: (options: { stateRoot: string; workspaceRef: string }) => Promise<LocalAgentStore>
    removeDirectory?: (directory: string) => Promise<void>
  } = {}
): Harness {
  const userDataPath = mkdtempSync(path.join(os.tmpdir(), 'maestrly-cursor-mgr-'))
  const tokenStore = overrides.tokenStore ?? memoryTokenStore()
  const sdk = overrides.sdk ?? fakeSdk({})
  const deps: Partial<CursorSubscriptionManagerDependencies> = {
    accountId: overrides.accountId ?? null,
    tokenStore,
    getUserDataPath: () => userDataPath,
    ensureDirectory: async () => undefined,
    removeDirectory: overrides.removeDirectory ?? (async () => undefined),
    loadSdk: async () => sdk,
    openStore: overrides.openStore ?? (async () => inMemoryFakeStore()),
    createLoginId: () => `login-${++loginSeq}`,
  }
  return { manager: new CursorSubscriptionManager(deps), tokenStore, sdk, userDataPath }
}

describe('Cursor subscription manager', () => {
  afterEach(() => {
    for (const manager of listCursorSubscriptionManagers()) void manager.dispose()
  })

  it('cancels account-owned children on logout without cancelling another account', async () => {
    const first = harness()
    const second = harness({ accountId: 'acc_other' })
    const parent = new AbortController()
    const signals: AbortSignal[] = []
    const waitForAbort = (signal: AbortSignal): Promise<void> => {
      signals.push(signal)
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    }
    await first.manager.admitApiKey('test-first')
    await second.manager.admitApiKey('test-second')
    const firstWork = withCursorAccountRun({ manager: first.manager, signal: parent.signal }, waitForAbort)
    const secondWork = withCursorAccountRun({ manager: second.manager, signal: parent.signal }, waitForAbort)
    try {
      await first.manager.logout()
      expect(signals[0]!.aborted).toBe(true)
      expect(signals[1]!.aborted).toBe(false)
      expect(parent.signal.aborted).toBe(false)
    } finally {
      parent.abort()
      await Promise.all([firstWork, secondWork])
      await Promise.all([first.manager.dispose(), second.manager.dispose()])
      rmSync(first.userDataPath, { recursive: true, force: true })
      rmSync(second.userDataPath, { recursive: true, force: true })
    }
  })

  it('treats the SDK missing-agent deletion result as already cleaned', async () => {
    const store = inMemoryFakeStore()
    const { manager, userDataPath } = harness({ openStore: async () => store })
    try {
      fakeStoreDelete(store).mockRejectedValue(new Error('No agents matched delete filter'))
      await expect(manager.deleteAgent('already-gone')).resolves.toBeUndefined()
      await expect(manager.deleteAllManagedAgents()).resolves.toBeUndefined()
      fakeStoreDelete(store).mockRejectedValue(new Error('database locked'))
      await expect(manager.deleteAgent('still-pending')).rejects.toThrow('database locked')
    } finally {
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('admits a validated key and derives identity from userId', async () => {
    const { manager, tokenStore, sdk, userDataPath } = harness()
    try {
      const status = await manager.admitApiKey('crsr_secret_key')
      expect(status.authenticated).toBe(true)
      expect(status.accountFingerprint).toBe('user:7')
      expect(status.account).toMatchObject({ userId: 7, email: 'a@example.com' })
      expect(manager.getAccountIdentity().fingerprint).toBe('user:7')
      expect(tokenStore.get()).toBe('crsr_secret_key')
      expect(vi.mocked(sdk.Cursor.me)).toHaveBeenCalledWith({ apiKey: 'crsr_secret_key' })
      expect(userDataPath).toBeTruthy()
    } finally {
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('never exposes the key in status and reports the storage mode', async () => {
    const tokenStore = memoryTokenStore()
    const { manager, userDataPath } = harness({ tokenStore })
    try {
      await manager.admitApiKey('crsr_top_secret')
      const snapshot = manager.getStatusSnapshot()
      expect(snapshot).not.toBeNull()
      expect(JSON.stringify(snapshot)).not.toContain('crsr_top_secret')
      const status = await manager.getStatus(true)
      expect(JSON.stringify(status)).not.toContain('crsr_top_secret')
      expect(status.storageMode).toBe('memory')
    } finally {
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('increments the epoch and rejects old bindings when the user changes', async () => {
    let currentUser = me({ userId: 7, userEmail: 'a@example.com' })
    const sdk = fakeSdk({ getUser: () => currentUser })
    const { manager, userDataPath } = harness({ sdk })
    try {
      await manager.admitApiKey('crsr_a')
      const identityA = manager.getAccountIdentity()
      expect(identityA.fingerprint).toBe('user:7')

      await manager.admitApiKey('crsr_a_rotated')
      expect(manager.getAccountIdentity()).toEqual({ fingerprint: 'user:7', epoch: identityA.epoch })

      currentUser = me({ userId: 99, userEmail: 'b@example.com' })
      await manager.admitApiKey('crsr_b')
      const identityB = manager.getAccountIdentity()
      expect(identityB.fingerprint).toBe('user:99')
      expect(identityB.epoch).toBeGreaterThan(identityA.epoch)
      expect(() => manager.assertAccountIdentity(identityA)).toThrow(CursorSubscriptionAccountChangedError)
    } finally {
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('clears the key and identity on logout and increments the epoch', async () => {
    const { manager, tokenStore, userDataPath } = harness()
    try {
      await manager.admitApiKey('crsr_secret')
      const before = manager.getAccountIdentity()
      await manager.logout()
      expect(tokenStore.get()).toBeNull()
      expect(manager.getAccountIdentity().fingerprint).toBeNull()
      expect(manager.getAccountIdentity().epoch).toBeGreaterThan(before.epoch)
      const status = await manager.getStatus()
      expect(status.authenticated).toBe(false)
    } finally {
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('supersedes pending logins and supports cancellation', async () => {
    let urlA: string | null = null
    const sdk = fakeSdk({
      user: me({ userId: 1 }),
      loginUrl: 'https://cursor.example/url-a',
      loginResult: { apiKey: 'crsr_a', apiKeyExpiresAtMs: Date.now() + 10_000 },
    })
    const { manager, userDataPath } = harness({ sdk })
    try {
      const attemptA = await manager.startLogin()
      urlA = attemptA.loginUrl
      expect(urlA).toBe('https://cursor.example/url-a')
      const attemptB = await manager.startLogin()
      expect(attemptB.loginId).not.toBe(attemptA.loginId)
      const completionA = await manager.waitForLogin(attemptA.loginId)
      expect(completionA.success).toBe(false) // superseded/cancelled

      const attemptC = await manager.startLogin()
      expect(manager.cancelLogin(attemptC.loginId)).toBe(true)
      const completionC = await manager.waitForLogin(attemptC.loginId)
      expect(completionC.success).toBe(false)
    } finally {
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('settles cancelled logins even when the SDK ignores AbortSignal', async () => {
    const sdk = fakeSdk({
      user: me({ userId: 9 }),
      loginUrl: 'https://cursor.example/hang',
      loginResult: { apiKey: 'crsr_hang', apiKeyExpiresAtMs: Date.now() + 10_000 },
    })

    vi.mocked(sdk.Cursor.auth.login).mockImplementation(async (loginOptions) => {
      const options = loginOptions as { onLoginUrl?: (url: string) => void } | undefined
      options?.onLoginUrl?.('https://cursor.example/hang')
      await new Promise(() => {})
      return { apiKey: 'crsr_hang', apiKeyExpiresAtMs: Date.now() + 10_000 }
    })
    const { manager, tokenStore, userDataPath } = harness({ sdk })
    try {
      const attempt = await manager.startLogin()
      expect(attempt.loginUrl).toBe('https://cursor.example/hang')

      const waiting = manager.waitForLogin(attempt.loginId)
      manager.cancelPendingLogins()
      const cancelled = await Promise.race([
        waiting,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('waitForLogin did not settle after cancelPendingLogins')), 500)
        }),
      ])
      expect(cancelled.success).toBe(false)
      expect(manager.getLoginAttempt(attempt.loginId)?.state).toBe('cancelled')

      await manager.admitApiKey('crsr_pre')
      expect(tokenStore.get()).toBe('crsr_pre')
      const attempt2 = await manager.startLogin()
      const waiting2 = manager.waitForLogin(attempt2.loginId)
      const loggingOut = manager.logout()
      const cancelled2 = await Promise.race([
        waiting2,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('waitForLogin did not settle after logout')), 500)
        }),
      ])
      await loggingOut
      expect(cancelled2.success).toBe(false)
      expect(tokenStore.get()).toBeNull()
      expect(manager.getAccountIdentity().fingerprint).toBeNull()
    } finally {
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('persists the key and identity after login completes', async () => {
    const sdk = fakeSdk({
      user: me({ userId: 5, userEmail: 'ok@example.com' }),
      loginUrl: 'https://cursor.example/url',
      loginResult: { apiKey: 'crsr_login_final', apiKeyExpiresAtMs: Date.now() + 10_000 },
    })
    const { manager, tokenStore, userDataPath } = harness({ sdk })
    try {
      const attempt = await manager.startLogin()
      expect(attempt.loginUrl).toBe('https://cursor.example/url')
      const completion = await manager.waitForLogin(attempt.loginId)
      expect(completion.success).toBe(true)
      expect(tokenStore.get()).toBe('crsr_login_final')
      expect(manager.getAccountIdentity().fingerprint).toBe('user:5')
    } finally {
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('deduplicates models and resolves selections from the catalog', async () => {
    const sdk = fakeSdk({})
    const { manager, userDataPath } = harness({ sdk })
    try {
      await manager.admitApiKey('crsr_secret')
      const first = await manager.listModels()
      const second = await manager.listModels()
      expect(first.length).toBe(1)
      expect(second).toBe(first) // cache (mesma referência readonly)
      expect(vi.mocked(sdk.Cursor.models.list)).toHaveBeenCalledTimes(1)

      const standard = await manager.resolveModelSelection('composer-2.5', false)
      expect(standard).toMatchObject({
        modelId: 'composer-2.5',
        params: [{ id: 'fast', value: 'false' }],
      })
      await expect(manager.resolveModelSelection('ghost', false)).rejects.toThrow(/not found/)
      await expect(manager.resolveModelSelection('composer-2.5', true)).resolves.toMatchObject({
        params: [{ id: 'fast', value: 'true' }],
      })
    } finally {
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('resolves fast mode and reasoning effort independently', async () => {
    const sdk = fakeSdk({
      models: [
        {
          id: 'grok-4.6',
          displayName: 'Grok 4.6',
          parameters: [
            { id: 'fast', values: [{ value: 'true' }, { value: 'false' }] },
            { id: 'reasoning_effort', values: [{ value: 'low' }, { value: 'high' }, { value: 'xhigh' }] },
          ],
        },
      ],
    })
    const { manager, userDataPath } = harness({ sdk })
    try {
      await manager.admitApiKey('crsr_secret')
      await expect(manager.resolveModelSelection('grok-4.6', true, false, 'xhigh')).resolves.toMatchObject({
        modelId: 'grok-4.6',
        params: [
          { id: 'fast', value: 'true' },
          { id: 'reasoning_effort', value: 'xhigh' },
        ],
      })
      await expect(manager.resolveModelSelection('grok-4.6', false, false, 'medium')).rejects.toThrow(
        /does not advertise reasoning effort/
      )
    } finally {
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('injects the key and store and permits only MCP tools', async () => {
    const sdk = fakeSdk({})
    const { manager, userDataPath } = harness({ sdk })
    try {
      await manager.admitApiKey('crsr_secret')
      const lease = await manager.createAgent({
        model: { id: 'composer-2.5' },
        local: { cwd: '/repo', customTools: { probe: { description: 'x', execute: async () => 'ok' } } },
      })
      expect(lease.agent.agentId).toBe('agent-created')
      const create = vi.mocked(sdk.Agent.create)
      expect(create).toHaveBeenCalledTimes(1)
      const options = create.mock.calls[0][0] as Record<string, unknown>
      expect(options.tools).toEqual(['mcp'])
      expect(options.disallowedTools).toBeUndefined()
      expect(options.apiKey).toBe('crsr_secret')
      expect((options.local as Record<string, unknown>).store).toBeDefined()
      expect((options.local as Record<string, unknown>).cwd).toBe('/repo')
      expect((options.local as Record<string, unknown>).customTools).toBeDefined()

      expect(JSON.stringify(options)).not.toMatch(/"shell"/)
      expect(JSON.stringify(options)).not.toContain('"task"')
      expect(JSON.stringify(options)).not.toContain('"edit"')

      lease.release()
    } finally {
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('rejects agent creation and resume without credentials', async () => {
    const { manager, userDataPath } = harness()
    try {
      await expect(manager.createAgent({ model: { id: 'm' }, local: { cwd: '/x' } })).rejects.toThrow(
        /not authenticated/
      )
      await expect(manager.resumeAgent('agent-x')).rejects.toThrow(/not authenticated/)
    } finally {
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('isolates account keys and rejects unsafe account identifiers', async () => {
    const base = memoryTokenStore()
    const { manager: defaultManager, userDataPath } = harness({ tokenStore: base, accountId: null })
    const extra = new CursorSubscriptionManager({
      tokenStore: memoryTokenStore(),
      getUserDataPath: () => userDataPath,
      loadSdk: async () => fakeSdk({ user: me({ userId: 2 }) }),
      openStore: async () => inMemoryFakeStore(),
    })
    try {
      await defaultManager.admitApiKey('crsr_default')
      await extra.admitApiKey('crsr_extra')
      expect(defaultManager.getAccountIdentity().fingerprint).toBe('user:7')
      expect(extra.getAccountIdentity().fingerprint).toBe('user:2')
      expect(base.get()).toBe('crsr_default')
      expect(base.get()).not.toBe('crsr_extra')
    } finally {
      await defaultManager.dispose()
      await extra.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
    expect(() => getCursorSubscriptionManager('../../evil')).toThrow(/Invalid/)
    expect(() => getCursorSubscriptionManager('acc_A')).not.toThrow()
  })

  it('prefers userId for identity and never fingerprints the key', () => {
    expect(cursorIdentityFingerprint({ userId: 3 })).toBe('user:3')
    expect(cursorIdentityFingerprint({ userEmail: 'x@y.z' })).toBe('email:x@y.z')
    expect(cursorIdentityFingerprint({})).toBeNull()
    expect((cursorIdentityFingerprint({ userId: 3 }) ?? '').includes('crsr')).toBe(false)
  })

  it('reuses the resolved store across sequential operations', async () => {
    const probe = storeProbe()
    const { manager, userDataPath } = harness({ openStore: probe.openStore })
    try {
      await manager.admitApiKey('crsr_secret')
      const first = await manager.createAgent({ model: { id: 'm' }, local: { cwd: '/a' } })
      const second = await manager.createAgent({ model: { id: 'm' }, local: { cwd: '/b' } })
      const resumed = await manager.resumeAgent('agent-x', { model: { id: 'm' } })
      expect(probe.opened()).toBe(1)

      first.release()
      second.release()
      resumed.release()
    } finally {
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('deduplicates concurrent store opens', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const probe = storeProbe(() => gate)
    const { manager, userDataPath } = harness({ openStore: probe.openStore })
    try {
      await manager.admitApiKey('crsr_secret')
      const first = manager.createAgent({ model: { id: 'm' }, local: { cwd: '/a' } })
      const second = manager.createAgent({ model: { id: 'm' }, local: { cwd: '/b' } })
      release()
      const [lease1, lease2] = await Promise.all([first, second])
      expect(probe.opened()).toBe(1)
      expect(probe.stores()[0]).toBeDefined()
      lease1.release()
      lease2.release()
    } finally {
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('closes each resolved store exactly once on logout, reset, and disposal', async () => {
    const probe = storeProbe()
    const { manager, userDataPath } = harness({ openStore: probe.openStore })
    try {
      await manager.admitApiKey('crsr_secret')
      const firstLease = await manager.createAgent({ model: { id: 'm' }, local: { cwd: '/a' } })
      const firstStore = probe.stores()[0]
      const disposeFirst = fakeStoreDispose(firstStore)

      firstLease.release()

      await manager.logout()
      expect(disposeFirst).toHaveBeenCalledTimes(1)

      await manager.admitApiKey('crsr_secret')
      const secondLease = await manager.createAgent({ model: { id: 'm' }, local: { cwd: '/a' } })
      expect(probe.opened()).toBe(2)
      const secondStore = probe.stores()[1]
      const disposeSecond = fakeStoreDispose(secondStore)
      secondLease.release()

      await manager.resetLocalData()
      expect(disposeSecond).toHaveBeenCalledTimes(1)

      await manager.dispose()
      expect(disposeSecond).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('rolls back an in-flight creation before disposing its store after identity changes', async () => {
    let currentUser = me({ userId: 7, userEmail: 'a@example.com' })
    const sdk = fakeSdk({ getUser: () => currentUser })
    const probe = storeProbe()
    const { manager, userDataPath } = harness({ sdk, openStore: probe.openStore })
    try {
      await manager.admitApiKey('crsr_secret')
      let releaseCreate!: () => void
      const createGate = new Promise<void>((resolve) => {
        releaseCreate = resolve
      })
      let enterCreate!: () => void
      const createSeen = new Promise<void>((resolve) => {
        enterCreate = resolve
      })
      const create = vi.mocked(sdk.Agent.create)
      const originalCreate = create.getMockImplementation()!
      create.mockImplementationOnce(async (agentOptions: AgentOptions): Promise<SDKAgent> => {
        enterCreate()
        await createGate
        return originalCreate(agentOptions)
      })
      const creating = manager.createAgent({ model: { id: 'composer-2.5' }, local: { cwd: '/repo' } })
      await createSeen

      currentUser = me({ userId: 99, userEmail: 'b@example.com' })
      const changing = manager.admitApiKey('crsr_b')

      await new Promise((resolve) => setTimeout(resolve, 0))
      const capturedStore = probe.stores()[0]
      expect(fakeStoreDispose(capturedStore)).not.toHaveBeenCalled()
      releaseCreate()
      await expect(creating).rejects.toThrow(CursorSubscriptionAccountChangedError)
      await changing

      expect(fakeStoreDelete(capturedStore)).toHaveBeenCalledWith({ filter: { agentIds: ['agent-created'] } })
      expect(fakeStoreDelete(capturedStore).mock.invocationCallOrder[0]).toBeLessThan(
        fakeStoreDispose(capturedStore).mock.invocationCallOrder[0]
      )
      expect(fakeStoreDispose(capturedStore)).toHaveBeenCalledTimes(1)

      expect(manager.getAccountIdentity().fingerprint).toBe('user:99')

      await manager.admitApiKey('crsr_secret')
      const freshLease = await manager.createAgent({ model: { id: 'm' }, local: { cwd: '/a' } })
      expect(probe.opened()).toBe(2)
      const freshStore = probe.stores()[1]
      expect(fakeStoreDispose(freshStore)).not.toHaveBeenCalled()
      expect((create.mock.calls[1][0] as { local: { store: unknown } }).local.store).toBe(freshStore)
      freshLease.release()
    } finally {
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('waits for an in-flight lease before closing the store on logout', async () => {
    const probe = storeProbe()
    const sdk = fakeSdk({})
    const { manager, userDataPath } = harness({ sdk, openStore: probe.openStore })
    try {
      await manager.admitApiKey('crsr_secret')
      let releaseCreate!: () => void
      const createGate = new Promise<void>((resolve) => {
        releaseCreate = resolve
      })
      let enterCreate!: () => void
      const createSeen = new Promise<void>((resolve) => {
        enterCreate = resolve
      })
      const create = vi.mocked(sdk.Agent.create)
      const originalCreate = create.getMockImplementation()!
      create.mockImplementationOnce(async (agentOptions: AgentOptions): Promise<SDKAgent> => {
        enterCreate()
        await createGate
        return originalCreate(agentOptions)
      })
      const creating = manager.createAgent({ model: { id: 'm' }, local: { cwd: '/a' } })
      await createSeen

      const loggingOut = manager.logout()
      await new Promise((resolve) => setTimeout(resolve, 0))
      const capturedStore = probe.stores()[0]

      expect(fakeStoreDispose(capturedStore)).not.toHaveBeenCalled()
      releaseCreate()
      await expect(creating).rejects.toThrow(CursorSubscriptionAccountChangedError)
      await loggingOut
      expect(fakeStoreDispose(capturedStore)).toHaveBeenCalledTimes(1)

      await manager.dispose()
      expect(fakeStoreDispose(capturedStore)).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('waits for leases and store disposal before removing the directory on reset', async () => {
    const probe = storeProbe()
    const removeDir = vi.fn(async () => undefined)
    const { manager, sdk, tokenStore, userDataPath } = harness({
      openStore: probe.openStore,
      removeDirectory: removeDir,
    })
    try {
      await manager.admitApiKey('crsr_secret')
      let releaseCreate!: () => void
      const createGate = new Promise<void>((resolve) => {
        releaseCreate = resolve
      })
      let enterCreate!: () => void
      const createSeen = new Promise<void>((resolve) => {
        enterCreate = resolve
      })
      const create = vi.mocked(sdk.Agent.create)
      const originalCreate = create.getMockImplementation()!
      create.mockImplementationOnce(async (agentOptions: AgentOptions): Promise<SDKAgent> => {
        enterCreate()
        await createGate
        return originalCreate(agentOptions)
      })
      const creating = manager.createAgent({ model: { id: 'm' }, local: { cwd: '/a' } })
      await createSeen

      const resetting = manager.resetLocalData()
      await new Promise((resolve) => setTimeout(resolve, 0))
      const capturedStore = probe.stores()[0]
      expect(fakeStoreDispose(capturedStore)).not.toHaveBeenCalled()
      expect(removeDir).not.toHaveBeenCalled()
      releaseCreate()
      await expect(creating).rejects.toThrow(CursorSubscriptionAccountChangedError)
      await resetting

      expect(fakeStoreDispose(capturedStore)).toHaveBeenCalledTimes(1)
      expect(removeDir).toHaveBeenCalledTimes(1)
      expect(fakeStoreDispose(capturedStore).mock.invocationCallOrder[0]).toBeLessThan(
        removeDir.mock.invocationCallOrder[0]
      )

      expect(tokenStore.get()).toBeNull()
    } finally {
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('never deletes a resumed agent after an identity race', async () => {
    let currentUser = me({ userId: 7, userEmail: 'a@example.com' })
    const sdk = fakeSdk({ getUser: () => currentUser })
    const probe = storeProbe()
    const { manager, userDataPath } = harness({ sdk, openStore: probe.openStore })
    try {
      await manager.admitApiKey('crsr_secret')
      let releaseResume!: () => void
      const resumeGate = new Promise<void>((resolve) => {
        releaseResume = resolve
      })
      let enterResume!: () => void
      const resumeSeen = new Promise<void>((resolve) => {
        enterResume = resolve
      })
      const resume = vi.mocked(sdk.Agent.resume)
      const originalResume = resume.getMockImplementation()!
      resume.mockImplementationOnce(async (agentId: string, options?: Partial<AgentOptions>): Promise<SDKAgent> => {
        enterResume()
        await resumeGate
        return originalResume(agentId, options)
      })
      const resuming = manager.resumeAgent('agent-persisted', { model: { id: 'composer-2.5' } })
      await resumeSeen

      currentUser = me({ userId: 99, userEmail: 'b@example.com' })
      const changing = manager.admitApiKey('crsr_b')
      await new Promise((resolve) => setTimeout(resolve, 0))
      const capturedStore = probe.stores()[0]
      expect(fakeStoreDispose(capturedStore)).not.toHaveBeenCalled()
      releaseResume()
      await expect(resuming).rejects.toThrow(CursorSubscriptionAccountChangedError)
      await changing

      expect(fakeStoreDelete(capturedStore)).not.toHaveBeenCalled()
      expect(fakeStoreDispose(capturedStore)).toHaveBeenCalledTimes(1)
    } finally {
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('waits for an in-flight lease before disposing the store', async () => {
    const probe = storeProbe()
    const { manager, sdk, userDataPath } = harness({ openStore: probe.openStore })
    try {
      await manager.admitApiKey('crsr_secret')
      let releaseCreate!: () => void
      const createGate = new Promise<void>((resolve) => {
        releaseCreate = resolve
      })
      let enterCreate!: () => void
      const createSeen = new Promise<void>((resolve) => {
        enterCreate = resolve
      })
      const create = vi.mocked(sdk.Agent.create)
      const originalCreate = create.getMockImplementation()!
      create.mockImplementationOnce(async (agentOptions: AgentOptions): Promise<SDKAgent> => {
        enterCreate()
        await createGate
        return originalCreate(agentOptions)
      })
      const creating = manager.createAgent({ model: { id: 'm' }, local: { cwd: '/a' } })
      await createSeen
      const disposing = manager.dispose()
      await new Promise((resolve) => setTimeout(resolve, 0))
      const capturedStore = probe.stores()[0]

      expect(fakeStoreDispose(capturedStore)).not.toHaveBeenCalled()
      releaseCreate()
      const lease = await creating // Disposal preserves identity for an accepted lease.

      expect(fakeStoreDispose(capturedStore)).not.toHaveBeenCalled()
      lease.release()
      await disposing
      expect(fakeStoreDispose(capturedStore)).toHaveBeenCalledTimes(1)

      await expect(manager.createAgent({ model: { id: 'm' }, local: { cwd: '/a' } })).rejects.toThrow(/disposed/)
      expect(probe.opened()).toBe(1)
    } finally {
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('queues a durable tombstone when creation rollback cannot delete the agent', async () => {
    freshDb()
    try {
      let currentUser = me({ userId: 7, userEmail: 'a@example.com' })
      const sdk = fakeSdk({ getUser: () => currentUser })
      const probe = storeProbe()
      const { manager, userDataPath } = harness({ sdk, openStore: probe.openStore })
      try {
        await manager.admitApiKey('crsr_secret')
        let releaseCreate!: () => void
        const createGate = new Promise<void>((resolve) => {
          releaseCreate = resolve
        })
        let enterCreate!: () => void
        const createSeen = new Promise<void>((resolve) => {
          enterCreate = resolve
        })
        const create = vi.mocked(sdk.Agent.create)
        const originalCreate = create.getMockImplementation()!
        create.mockImplementationOnce(async (agentOptions: AgentOptions): Promise<SDKAgent> => {
          enterCreate()
          await createGate
          return originalCreate(agentOptions)
        })
        const creating = manager.createAgent({ model: { id: 'composer-2.5' }, local: { cwd: '/repo' } })
        await createSeen

        fakeStoreDelete(probe.stores()[0]).mockRejectedValue(new Error('store locked'))
        currentUser = me({ userId: 99, userEmail: 'b@example.com' })
        const changing = manager.admitApiKey('crsr_b')
        await new Promise((resolve) => setTimeout(resolve, 0))
        releaseCreate()
        await expect(creating).rejects.toThrow(CursorSubscriptionAccountChangedError)
        await changing

        const cleanup = listCursorAgentCleanup()
        expect(cleanup).toHaveLength(1)
        expect(cleanup[0]).toMatchObject({
          agentId: 'agent-created',
          attempts: 1,
          accountId: null,
          cwd: '/repo',
        })
        expect(cleanup[0].lastError).toMatch(/store locked/)

        expect(fakeStoreDispose(probe.stores()[0])).toHaveBeenCalledTimes(1)
      } finally {
        await manager.dispose()
        rmSync(userDataPath, { recursive: true, force: true })
      }
    } finally {
      closeDb()
    }
  })

  it('rejects agent deletion when its store cannot open', async () => {
    const { manager, userDataPath } = harness({
      openStore: async () => {
        throw new Error('store corrupt')
      },
    })
    try {
      await manager.admitApiKey('crsr_secret')
      await expect(manager.deleteAgent('agent-1')).rejects.toThrow('store corrupt')
      await expect(manager.deleteAllManagedAgents()).rejects.toThrow('store corrupt')
    } finally {
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('deletes missing agents idempotently', async () => {
    const probe = storeProbe()
    const { manager, userDataPath } = harness({ openStore: probe.openStore })
    try {
      await manager.admitApiKey('crsr_secret')
      await expect(manager.deleteAgent('never-existed')).resolves.toBeUndefined()
      const store = probe.stores()[0]
      expect(fakeStoreDelete(store)).toHaveBeenCalledWith({ filter: { agentIds: ['never-existed'] } })
    } finally {
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('never persists credentials from a superseded login', async () => {
    const sdk = fakeSdk({
      user: me({ userId: 2, userEmail: 'b@example.com' }),
      loginUrl: 'https://cursor.example/login',
      loginResult: (callIndex) =>
        callIndex === 0
          ? { apiKey: 'crsr_a', apiKeyExpiresAtMs: Date.now() + 10_000 }
          : { apiKey: 'crsr_b', apiKeyExpiresAtMs: Date.now() + 10_000 },
    })
    const { manager, tokenStore, userDataPath } = harness({ sdk })
    try {
      let releaseMeA!: () => void
      const meAGate = new Promise<void>((resolve) => {
        releaseMeA = resolve
      })

      let aAtMe!: () => void
      const aAtMeSeen = new Promise<void>((resolve) => {
        aAtMe = resolve
      })
      const meSpy = vi.mocked(sdk.Cursor.me)

      meSpy.mockImplementation(async (options?: { apiKey?: string }) => {
        if (options?.apiKey === 'crsr_a') {
          aAtMe()
          await meAGate
        }
        return me({ userId: 2, userEmail: 'b@example.com' })
      })
      const setSpy = vi.spyOn(tokenStore, 'set')

      const attemptA = await manager.startLogin()
      expect(attemptA.loginUrl).toBe('https://cursor.example/login')

      await aAtMeSeen

      const attemptB = await manager.startLogin()
      const completionB = await manager.waitForLogin(attemptB.loginId)
      expect(completionB.success).toBe(true)
      expect(tokenStore.get()).toBe('crsr_b')

      releaseMeA()
      const completionA = await manager.waitForLogin(attemptA.loginId)
      expect(completionA.success).toBe(false)
      expect(manager.getLoginAttempt(attemptA.loginId)?.state).toBe('cancelled')
      expect(setSpy).toHaveBeenCalledTimes(1)
      expect(tokenStore.get()).toBe('crsr_b')
      expect(manager.getAccountIdentity().fingerprint).toBe('user:2')
    } finally {
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('never persists credentials when login is cancelled during identity validation', async () => {
    const sdk = fakeSdk({
      user: me({ userId: 3, userEmail: 'c@example.com' }),
      loginUrl: 'https://cursor.example/login',
    })
    const { manager, tokenStore, userDataPath } = harness({ sdk })
    try {
      let releaseMe!: () => void
      const meGate = new Promise<void>((resolve) => {
        releaseMe = resolve
      })
      let meCalls = 0
      const meSpy = vi.mocked(sdk.Cursor.me)
      meSpy.mockImplementation(async () => {
        meCalls += 1
        if (meCalls === 1) await meGate
        return me({ userId: 3, userEmail: 'c@example.com' })
      })
      const setSpy = vi.spyOn(tokenStore, 'set')

      const attempt = await manager.startLogin()
      expect(manager.cancelLogin(attempt.loginId)).toBe(true)
      releaseMe()
      const completion = await manager.waitForLogin(attempt.loginId)
      expect(completion.success).toBe(false)
      expect(manager.getLoginAttempt(attempt.loginId)?.state).toBe('cancelled')
      expect(setSpy).not.toHaveBeenCalled()
      expect(tokenStore.get()).toBeNull()
      expect(manager.getAccountIdentity().fingerprint).toBeNull()
    } finally {
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('invalidates and closes a late store open during reset', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const probe = storeProbe(() => gate)
    const { manager, userDataPath } = harness({ openStore: probe.openStore })
    try {
      await manager.admitApiKey('crsr_secret')
      const opening = manager.createAgent({ model: { id: 'm' }, local: { cwd: '/a' } })
      const resetting = manager.resetLocalData()
      release()
      await Promise.allSettled([opening, resetting])
      expect(probe.opened()).toBe(1)
      const lateStore = probe.stores()[0]

      expect(fakeStoreDispose(lateStore)).toHaveBeenCalledTimes(1)

      await manager.admitApiKey('crsr_secret')
      const lease = await manager.createAgent({ model: { id: 'm' }, local: { cwd: '/a' } })
      expect(probe.opened()).toBe(2)
      lease.release()
    } finally {
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('keeps the store alive until the entire created-agent turn releases', async () => {
    const probe = storeProbe()
    const { manager, userDataPath } = harness({ openStore: probe.openStore })
    try {
      await manager.admitApiKey('crsr_secret')

      const lease = await manager.createAgent({ model: { id: 'm' }, local: { cwd: '/a' } })
      const store = probe.stores()[0]
      const dispose = fakeStoreDispose(store)

      const loggingOut = manager.logout()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(dispose).not.toHaveBeenCalled()

      lease.agent.close()
      const closeOrder = (lease.agent.close as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
      lease.release()
      await loggingOut
      expect(dispose).toHaveBeenCalledTimes(1)
      expect(closeOrder).toBeLessThan(dispose.mock.invocationCallOrder[0])

      lease.release()
      expect(dispose).toHaveBeenCalledTimes(1)

      await manager.admitApiKey('crsr_secret')
      const nextLease = await manager.createAgent({ model: { id: 'm' }, local: { cwd: '/a' } })
      expect(probe.opened()).toBe(2)
      nextLease.release()
    } finally {
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('keeps the store alive until the entire resumed-agent turn releases', async () => {
    const probe = storeProbe()
    const { manager, userDataPath } = harness({ openStore: probe.openStore })
    try {
      await manager.admitApiKey('crsr_secret')
      const lease = await manager.resumeAgent('agent-persisted', { model: { id: 'm' } })
      const store = probe.stores()[0]
      const dispose = fakeStoreDispose(store)

      const resetting = manager.resetLocalData()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(dispose).not.toHaveBeenCalled()
      lease.release()
      await resetting
      expect(dispose).toHaveBeenCalledTimes(1)
    } finally {
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('disposes every store exactly once across overlapping transitions', async () => {
    let currentUser = me({ userId: 7, userEmail: 'a@example.com' })
    const sdk = fakeSdk({ getUser: () => currentUser })
    const probe = storeProbe()
    const { manager, userDataPath } = harness({ sdk, openStore: probe.openStore })
    try {
      await manager.admitApiKey('crsr_secret')

      const leaseA = await manager.createAgent({ model: { id: 'm' }, local: { cwd: '/a' } })
      const storeA = probe.stores()[0]
      const disposeA = fakeStoreDispose(storeA)

      const transition1 = manager.logout()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(disposeA).not.toHaveBeenCalled()

      currentUser = me({ userId: 99, userEmail: 'b@example.com' })
      const transition2 = manager.admitApiKey('crsr_c')
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(probe.opened()).toBe(1)

      leaseA.release()
      await Promise.all([transition1, transition2])
      expect(disposeA).toHaveBeenCalledTimes(1)

      expect(manager.getAccountIdentity().fingerprint).toBe('user:99')

      await manager.admitApiKey('crsr_secret')
      const leaseC = await manager.createAgent({ model: { id: 'm' }, local: { cwd: '/a' } })
      expect(probe.opened()).toBe(2)
      expect(fakeStoreDispose(probe.stores()[1])).not.toHaveBeenCalled()
      leaseC.release()
    } finally {
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('rejects creation with a stale lease after same-account key rotation', async () => {
    const sdk = fakeSdk({ user: me({ userId: 7, userEmail: 'a@example.com' }) })
    const probe = storeProbe()
    const { manager, userDataPath } = harness({ sdk, openStore: probe.openStore })
    try {
      await manager.admitApiKey('crsr_old')

      const initialLease = await manager.createAgent({ model: { id: 'm' }, local: { cwd: '/a' } })
      initialLease.release()
      const storeA = probe.stores()[0]
      const disposeA = fakeStoreDispose(storeA)
      expect(vi.mocked(sdk.Agent.create)).toHaveBeenCalledTimes(1)

      let releaseRotationMe!: () => void
      const rotationMeGate = new Promise<void>((resolve) => {
        releaseRotationMe = resolve
      })
      const meSpy = vi.mocked(sdk.Cursor.me)
      meSpy.mockImplementation(async (options?: { apiKey?: string }) => {
        if (options?.apiKey === 'crsr_new') await rotationMeGate
        return me({ userId: 7, userEmail: 'a@example.com' })
      })

      const creating = manager.createAgent({ model: { id: 'm' }, local: { cwd: '/b' } })
      const rotating = manager.admitApiKey('crsr_new')

      await expect(creating).rejects.toThrow(CursorSubscriptionAccountChangedError)
      expect(vi.mocked(sdk.Agent.create)).toHaveBeenCalledTimes(1) // Only the initial call.

      expect(disposeA).not.toHaveBeenCalled()

      releaseRotationMe()
      await rotating

      expect(disposeA).toHaveBeenCalledTimes(1)

      const nextLease = await manager.createAgent({ model: { id: 'm' }, local: { cwd: '/c' } })
      expect(probe.opened()).toBe(2)
      const createCalls = vi.mocked(sdk.Agent.create)
      expect(createCalls).toHaveBeenCalledTimes(2)
      const options = createCalls.mock.calls[1][0] as { apiKey: string; local: { store: LocalAgentStore } }
      expect(options.apiKey).toBe('crsr_new')
      expect(options.local.store).toBe(probe.stores()[1])
      expect(fakeStoreDispose(probe.stores()[1])).not.toHaveBeenCalled()
      nextLease.release()
    } finally {
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('rejects resume with a stale lease after same-account key rotation', async () => {
    const sdk = fakeSdk({ user: me({ userId: 7, userEmail: 'a@example.com' }) })
    const probe = storeProbe()
    const { manager, userDataPath } = harness({ sdk, openStore: probe.openStore })
    try {
      await manager.admitApiKey('crsr_old')
      const initialLease = await manager.resumeAgent('agent-persisted', { model: { id: 'm' } })
      initialLease.release()
      const storeA = probe.stores()[0]
      expect(vi.mocked(sdk.Agent.resume)).toHaveBeenCalledTimes(1)

      let releaseRotationMe!: () => void
      const rotationMeGate = new Promise<void>((resolve) => {
        releaseRotationMe = resolve
      })
      const meSpy = vi.mocked(sdk.Cursor.me)
      meSpy.mockImplementation(async (options?: { apiKey?: string }) => {
        if (options?.apiKey === 'crsr_new') await rotationMeGate
        return me({ userId: 7, userEmail: 'a@example.com' })
      })

      const resuming = manager.resumeAgent('agent-persisted', { model: { id: 'm' } })
      const rotating = manager.admitApiKey('crsr_new')
      await expect(resuming).rejects.toThrow(CursorSubscriptionAccountChangedError)
      expect(vi.mocked(sdk.Agent.resume)).toHaveBeenCalledTimes(1) // Only the initial call.
      expect(fakeStoreDispose(storeA)).not.toHaveBeenCalled()

      releaseRotationMe()
      await rotating
      expect(fakeStoreDispose(storeA)).toHaveBeenCalledTimes(1)
    } finally {
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('closes and deletes an in-flight creation after same-account key rotation', async () => {
    const sdk = fakeSdk({ user: me({ userId: 7, userEmail: 'a@example.com' }) })
    const probe = storeProbe()
    const { manager, userDataPath } = harness({ sdk, openStore: probe.openStore })
    let releaseCreate: (() => void) | undefined
    try {
      await manager.admitApiKey('crsr_old')

      const createGate = new Promise<void>((resolve) => {
        releaseCreate = resolve
      })
      let enterCreate!: () => void
      const createSeen = new Promise<void>((resolve) => {
        enterCreate = resolve
      })
      let createdAgent!: SDKAgent
      const create = vi.mocked(sdk.Agent.create)
      const originalCreate = create.getMockImplementation()!
      create.mockImplementationOnce(async (agentOptions: AgentOptions): Promise<SDKAgent> => {
        enterCreate()
        await createGate
        createdAgent = await originalCreate(agentOptions)
        return createdAgent
      })

      let rotationSeen!: () => void
      const rotationStarted = new Promise<void>((resolve) => {
        rotationSeen = resolve
      })
      vi.mocked(sdk.Cursor.me).mockImplementation(async (options?: { apiKey?: string }) => {
        if (options?.apiKey === 'crsr_new') rotationSeen()
        return me({ userId: 7, userEmail: 'a@example.com' })
      })

      const creating = manager.createAgent({ model: { id: 'm' }, local: { cwd: '/repo' } })
      await createSeen
      const rotating = manager.admitApiKey('crsr_new')
      await rotationStarted
      const capturedStore = probe.stores()[0]
      expect(fakeStoreDispose(capturedStore)).not.toHaveBeenCalled()

      releaseCreate!()
      const outcome = await creating.then(
        (lease) => {
          lease.release()
          return { error: null, lease }
        },
        (error: unknown) => ({ error, lease: null })
      )
      await rotating

      expect(outcome.lease).toBeNull()
      expect(outcome.error).toBeInstanceOf(CursorSubscriptionAccountChangedError)
      expect(createdAgent.close).toHaveBeenCalledTimes(1)
      expect(fakeStoreDelete(capturedStore)).toHaveBeenCalledWith({ filter: { agentIds: ['agent-created'] } })
      expect(fakeStoreDispose(capturedStore)).toHaveBeenCalledTimes(1)
    } finally {
      releaseCreate?.()
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('closes an in-flight resume without deleting its binding after key rotation', async () => {
    const sdk = fakeSdk({ user: me({ userId: 7, userEmail: 'a@example.com' }) })
    const probe = storeProbe()
    const { manager, userDataPath } = harness({ sdk, openStore: probe.openStore })
    let releaseResume: (() => void) | undefined
    try {
      await manager.admitApiKey('crsr_old')

      const resumeGate = new Promise<void>((resolve) => {
        releaseResume = resolve
      })
      let enterResume!: () => void
      const resumeSeen = new Promise<void>((resolve) => {
        enterResume = resolve
      })
      let resumedAgent!: SDKAgent
      const resume = vi.mocked(sdk.Agent.resume)
      const originalResume = resume.getMockImplementation()!
      resume.mockImplementationOnce(async (agentId: string, options?: Partial<AgentOptions>): Promise<SDKAgent> => {
        enterResume()
        await resumeGate
        resumedAgent = await originalResume(agentId, options)
        return resumedAgent
      })

      let rotationSeen!: () => void
      const rotationStarted = new Promise<void>((resolve) => {
        rotationSeen = resolve
      })
      vi.mocked(sdk.Cursor.me).mockImplementation(async (options?: { apiKey?: string }) => {
        if (options?.apiKey === 'crsr_new') rotationSeen()
        return me({ userId: 7, userEmail: 'a@example.com' })
      })

      const resuming = manager.resumeAgent('agent-persisted', { model: { id: 'm' } })
      await resumeSeen
      const rotating = manager.admitApiKey('crsr_new')
      await rotationStarted
      const capturedStore = probe.stores()[0]
      expect(fakeStoreDispose(capturedStore)).not.toHaveBeenCalled()

      releaseResume!()
      const outcome = await resuming.then(
        (lease) => {
          lease.release()
          return { error: null, lease }
        },
        (error: unknown) => ({ error, lease: null })
      )
      await rotating

      expect(outcome.lease).toBeNull()
      expect(outcome.error).toBeInstanceOf(CursorSubscriptionAccountChangedError)
      expect(resumedAgent.close).toHaveBeenCalledTimes(1)
      expect(fakeStoreDelete(capturedStore)).not.toHaveBeenCalled()
      expect(fakeStoreDispose(capturedStore)).toHaveBeenCalledTimes(1)
    } finally {
      releaseResume?.()
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('rejects stale model catalogs after same-account key rotation', async () => {
    const sdk = fakeSdk({ user: me({ userId: 7, userEmail: 'a@example.com' }) })
    const { manager, userDataPath } = harness({ sdk })
    try {
      await manager.admitApiKey('crsr_old')

      let releaseOld!: () => void
      const oldModelsGate = new Promise<void>((resolve) => {
        releaseOld = resolve
      })
      let oldModelsSeen!: () => void
      const oldModelsStarted = new Promise<void>((resolve) => {
        oldModelsSeen = resolve
      })
      const modelsList = vi.mocked(sdk.Cursor.models.list)
      modelsList.mockImplementation(async (options?: { apiKey?: string }) => {
        if (options?.apiKey === 'crsr_old') {
          oldModelsSeen()
          await oldModelsGate
          return [{ id: 'old-model', displayName: 'Old model' }]
        }
        return [{ id: 'new-model', displayName: 'New model' }]
      })

      const staleListing = manager.listModels(true)
      await oldModelsStarted

      const rotating = manager.admitApiKey('crsr_new')
      await rotating
      releaseOld()

      await expect(staleListing).rejects.toThrow(CursorSubscriptionAccountChangedError)
      const currentModels = await manager.listModels(true)
      expect(currentModels.map((model) => model.id)).toEqual(['new-model'])
      expect(modelsList).toHaveBeenCalledWith({ apiKey: 'crsr_old' })
      expect(modelsList).toHaveBeenCalledWith({ apiKey: 'crsr_new' })
    } finally {
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('never caches stale authentication failures after same-account key rotation', async () => {
    const sdk = fakeSdk({ user: me({ userId: 7, userEmail: 'a@example.com', apiKeyName: 'old-key' }) })
    const { manager, userDataPath } = harness({ sdk })
    try {
      await manager.admitApiKey('crsr_old')

      let releaseOld!: () => void
      const oldStatusGate = new Promise<void>((resolve) => {
        releaseOld = resolve
      })
      let oldStatusSeen!: () => void
      const oldStatusStarted = new Promise<void>((resolve) => {
        oldStatusSeen = resolve
      })
      const meSpy = vi.mocked(sdk.Cursor.me)
      meSpy.mockImplementation(async (options?: { apiKey?: string }) => {
        if (options?.apiKey === 'crsr_old') {
          oldStatusSeen()
          await oldStatusGate
          throw new Error('old key rejected')
        }
        return me({ userId: 7, userEmail: 'a@example.com', apiKeyName: 'new-key' })
      })

      const staleStatus = manager.getStatus(true)
      await oldStatusStarted

      const rotating = manager.admitApiKey('crsr_new')
      await rotating
      expect(manager.getStatusSnapshot()).toMatchObject({ state: 'ready', authenticated: true, error: null })

      releaseOld()
      await expect(staleStatus).resolves.toMatchObject({ state: 'ready', authenticated: true, error: null })
      expect(manager.getStatusSnapshot()).toMatchObject({ state: 'ready', authenticated: true, error: null })
    } finally {
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('closes a late store exactly once when key rotation invalidates acquisition', async () => {
    const sdk = fakeSdk({ user: me({ userId: 7, userEmail: 'a@example.com' }) })
    let releaseOpen!: () => void
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve
    })
    const probe = storeProbe(() => openGate)
    const { manager, userDataPath } = harness({ sdk, openStore: probe.openStore })
    try {
      await manager.admitApiKey('crsr_old')

      const creating = manager.createAgent({ model: { id: 'm' }, local: { cwd: '/a' } })

      const rotating = manager.admitApiKey('crsr_new')
      await new Promise((resolve) => setTimeout(resolve, 0))
      releaseOpen()

      await expect(creating).rejects.toThrow(CursorSubscriptionAccountChangedError)
      await rotating
      expect(vi.mocked(sdk.Agent.create)).toHaveBeenCalledTimes(0)
      expect(probe.opened()).toBe(1)
      expect(fakeStoreDispose(probe.stores()[0])).toHaveBeenCalledTimes(1)

      const nextLease = await manager.createAgent({ model: { id: 'm' }, local: { cwd: '/b' } })
      expect(probe.opened()).toBe(2)
      const options = vi.mocked(sdk.Agent.create).mock.calls[0][0] as {
        apiKey: string
        local: { store: LocalAgentStore }
      }
      expect(options.apiKey).toBe('crsr_new')
      expect(options.local.store).toBe(probe.stores()[1])
      nextLease.release()
    } finally {
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})

describe('Cursor manager expiry and retirement', () => {
  it('invalidates cached status and model lists when a persisted credential expires', async () => {
    const { manager, tokenStore, userDataPath } = harness()
    try {
      await manager.admitApiKey('crsr_expiring')
      await manager.listModels()
      const oldIdentity = manager.getAccountIdentity()
      const expiry = Date.now() + 60_000
      tokenStore.set('crsr_expiring', expiry)
      vi.spyOn(Date, 'now').mockReturnValue(expiry)
      expect((await manager.getStatus()).authenticated).toBe(false)
      expect(manager.getAccountIdentity().epoch).toBeGreaterThan(oldIdentity.epoch)
      await expect(manager.listModels()).rejects.toThrow('not authenticated')
      await expect(manager.createAgent({ model: { id: 'composer-2.5' } })).rejects.toThrow('not authenticated')
    } finally {
      vi.restoreAllMocks()
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('preserves a valid key when identity validation encounters a network error', async () => {
    const { manager, tokenStore, sdk, userDataPath } = harness()
    try {
      await manager.admitApiKey('crsr_valid')
      vi.mocked(sdk.Cursor.me).mockRejectedValue(new Error('network unavailable'))
      expect((await manager.getStatus(true)).connected).toBe(false)
      expect(tokenStore.get()).toBe('crsr_valid')
      await expect(manager.admitApiKey('crsr_replacement')).rejects.toThrow('network unavailable')
      expect(tokenStore.get()).toBe('crsr_valid')
    } finally {
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('persists browser login expiry and rejects expired browser results', async () => {
    const expiry = Date.now() + 60_000
    const { manager, tokenStore, userDataPath } = harness({
      sdk: fakeSdk({ loginResult: { apiKey: 'crsr_browser', apiKeyExpiresAtMs: expiry } }),
    })
    try {
      const attempt = await manager.startLogin()
      expect((await manager.waitForLogin(attempt.loginId)).success).toBe(true)
      expect(tokenStore.get()).toBe('crsr_browser')
      vi.spyOn(Date, 'now').mockReturnValue(expiry)
      expect(tokenStore.get()).toBeNull()
      const expired = await manager.startLogin()
      expect((await manager.waitForLogin(expired.loginId)).success).toBe(false)
    } finally {
      vi.restoreAllMocks()
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('waits for turn leases before deleting agents and serializes concurrent cleanup', async () => {
    const probe = storeProbe()
    const { manager, sdk, userDataPath } = harness({ openStore: probe.openStore })
    try {
      await manager.admitApiKey('crsr_valid')
      const lease = await manager.createAgent({ model: { id: 'composer-2.5' }, local: { settingSources: ['user'] } })
      expect(vi.mocked(sdk.Agent.create).mock.calls[0]?.[0].local?.settingSources).toEqual([])
      const deletion = manager.deleteAgent(lease.agent.agentId)
      const otherDeletion = manager.deleteAgent('other-agent')
      await Promise.resolve()
      expect(fakeStoreDelete(probe.created[0]!)).not.toHaveBeenCalled()
      lease.release()
      await Promise.all([deletion, otherDeletion])
      expect(fakeStoreDelete(probe.created[0]!)).toHaveBeenCalledTimes(2)
    } finally {
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})

describe('Cursor login cancellation while validating identity', () => {
  it('settles cancellation before a hung identity request and never admits its late result', async () => {
    let resolveUser!: (user: SDKUser) => void
    const identity = new Promise<SDKUser>((resolve) => {
      resolveUser = resolve
    })
    const { manager, sdk, tokenStore, userDataPath } = harness()
    vi.mocked(sdk.Cursor.me).mockReturnValue(identity)
    try {
      const attempt = await manager.startLogin()
      await vi.waitFor(() => expect(sdk.Cursor.me).toHaveBeenCalled())
      let settled = false
      const completion = manager.waitForLogin(attempt.loginId).then((result) => {
        settled = true
        return result
      })
      manager.cancelLogin(attempt.loginId)
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 100 })
      expect((await completion).success).toBe(false)
      resolveUser(me({ userId: 42 }))
      await Promise.resolve()
      await Promise.resolve()
      expect(tokenStore.get()).toBeNull()
    } finally {
      resolveUser(me({ userId: 42 }))
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})

describe('Cursor agent-scoped retirement', () => {
  it('allows unrelated agents to run while a target agent drains', async () => {
    const probe = storeProbe()
    const { manager, userDataPath } = harness({ openStore: probe.openStore })
    const leases: Array<{ release(): Promise<void> | void }> = []
    try {
      await manager.admitApiKey('crsr_valid')
      const target = await manager.resumeAgent('target')
      leases.push(target)
      let retired = false
      const retirement = manager.deleteAgent('target').then(() => {
        retired = true
      })
      const unrelated = await manager.resumeAgent('unrelated')
      leases.push(unrelated)
      expect(retired).toBe(false)
      expect(fakeStoreDelete(probe.created[0]!)).not.toHaveBeenCalled()
      target.release()
      await retirement
      expect(fakeStoreDelete(probe.created[0]!)).toHaveBeenCalledWith({ filter: { agentIds: ['target'] } })
      expect(fakeStoreDispose(probe.created[0]!)).not.toHaveBeenCalled()
    } finally {
      for (const lease of leases) lease.release()
      await manager.dispose()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})
