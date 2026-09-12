import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const contextLimits = new Map<string, number>()
  return {
    getProvider: vi.fn(),
    isCodexSubscriptionProvider: vi.fn((id: string) => id.startsWith('builtin_codex')),
    subscriptionAccountId: vi.fn((id: string) => {
      const at = id.indexOf('@acc_')
      return at >= 0 ? id.slice(at + 1) : null
    }),
    getCodexSubscriptionManager: vi.fn(),
    contextLimits,
    getContextLimit: vi.fn((providerId: string, modelId: string) => contextLimits.get(`${providerId}::${modelId}`)),
    chatDiag: vi.fn(),
  }
})

vi.mock('../../src/main/chat/diag-log', () => ({
  chatDiag: h.chatDiag,
}))

vi.mock('../../src/main/chat/catalog', () => ({
  getProvider: h.getProvider,
  isCodexSubscriptionProvider: h.isCodexSubscriptionProvider,
  subscriptionAccountId: h.subscriptionAccountId,
}))

vi.mock('../../src/main/chat/codex-subscription/manager', () => ({
  getCodexSubscriptionManager: h.getCodexSubscriptionManager,
}))

vi.mock('../../src/main/chat/context-limits', () => ({
  getContextLimit: h.getContextLimit,
}))

import {
  DEFAULT_PROBE_TTL_MS,
  getSubscriptionFailoverRouter,
  resetSubscriptionFailoverRouterForTests,
  resetCodexRateLimitBinding,
  resolveCodexRuntimeTarget,
} from '../../src/main/chat/subscription-failover'
import { MAESTRLY_ULTRA_EFFORT } from '../../src/shared/chat'
import type { CodexSubscriptionManager } from '../../src/main/chat/codex-subscription/manager'

const PRIMARY = 'builtin_codex_subscription'
const FALLBACK = 'builtin_codex_subscription@acc_fallback'

function makeModel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'gpt-5.4',
    model: 'gpt-5.4',
    displayName: 'GPT-5.4',
    description: '',
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: '' },
      { reasoningEffort: 'medium', description: '' },
      { reasoningEffort: 'high', description: '' },
    ],
    defaultReasoningEffort: 'medium',
    inputModalities: ['text', 'image'],
    supportsPersonality: false,
    serviceTiers: [{ id: 'priority', name: 'Priority', description: '' }],
    defaultServiceTier: null,
    legacySpeedTiers: [],
    contextWindow: 200_000,
    maxContextWindow: null,
    effectiveContextWindowPercent: null,
    isDefault: true,
    ...overrides,
  }
}

function makeManager(
  overrides: {
    authenticated?: boolean
    snapshotAuth?: boolean | null
    snapshotState?: 'ready' | 'error' | 'disposed'
    snapshotAvailable?: boolean
    snapshotConnected?: boolean
    rateLimits?: Record<string, unknown> | null
    models?: ReturnType<typeof makeModel>[]
    preferredServiceTier?: string | null
  } = {}
) {
  const models = overrides.models ?? [makeModel()]
  const authenticated = overrides.authenticated ?? true
  const snapshotAuth = overrides.snapshotAuth === undefined ? authenticated : overrides.snapshotAuth
  const rateLimitListeners = new Set<(limits: Record<string, unknown>) => void>()
  return {
    getStatusSnapshot: vi.fn(() =>
      snapshotAuth === null
        ? null
        : {
            authenticated: snapshotAuth,
            state: overrides.snapshotState ?? 'ready',
            available: overrides.snapshotAvailable ?? true,
            connected: overrides.snapshotConnected ?? true,
          }
    ),
    getRateLimitsSnapshot: vi.fn(() => overrides.rateLimits ?? null),
    onRateLimitsUpdated: vi.fn((listener: (limits: Record<string, unknown>) => void) => {
      rateLimitListeners.add(listener)
      return () => rateLimitListeners.delete(listener)
    }),
    emitRateLimitsUpdated: (limits: Record<string, unknown>) => {
      for (const listener of rateLimitListeners) listener(limits)
    },
    getStatus: vi.fn(async () => ({ authenticated, state: 'ready', available: true, connected: true })),
    listModels: vi.fn(async () => models),
    preferredServiceTier: vi.fn(
      async (): Promise<string | null> =>
        overrides.preferredServiceTier === undefined ? 'priority' : overrides.preferredServiceTier
    ),
    getClient: vi.fn(async () => ({ id: 'client' })),
    getObservedModelContextWindowObservation: vi.fn(() => undefined),
  }
}

beforeEach(() => {
  resetSubscriptionFailoverRouterForTests()
  h.contextLimits.clear()
  h.getContextLimit.mockClear()
  h.chatDiag.mockClear()
  h.getProvider.mockImplementation((id: string) =>
    id.startsWith('builtin_codex') ? { id, name: 'Codex', baseURL: 'codex://x' } : undefined
  )
  h.isCodexSubscriptionProvider.mockImplementation((id: string) => id.startsWith('builtin_codex'))
  h.getCodexSubscriptionManager.mockReset()
})

afterEach(() => {
  resetSubscriptionFailoverRouterForTests()
})

describe('SubscriptionFailoverRouter', () => {
  it('defaults to unknown health', () => {
    const router = getSubscriptionFailoverRouter()
    expect(router.getHealth(PRIMARY)).toEqual({ providerId: PRIMARY, state: 'unknown' })
  })

  it('markExhausted opens the circuit immediately and skips until nextProbeAt', () => {
    const router = getSubscriptionFailoverRouter()
    const now = 1_000_000
    const resetsAt = now + 60_000
    router.markExhausted(PRIMARY, {
      reason: 'quota',
      source: 'structured-error',
      resetsAt,
      now,
    })

    const health = router.getHealth(PRIMARY)
    expect(health.state).toBe('exhausted')
    expect(health.exhaustion?.nextProbeAt).toBe(resetsAt)
    expect(health.exhaustion?.generation).toBe(1)
    expect(router.isAdmissible(PRIMARY, now)).toBe(false)
    expect(router.tryAdmit(PRIMARY, now)).toEqual({ ok: false, reason: 'exhausted-backoff' })
  })

  it('uses DEFAULT_PROBE_TTL when resetsAt is absent (never forever)', () => {
    const router = getSubscriptionFailoverRouter()
    const now = 5_000_000
    router.markExhausted(PRIMARY, { reason: 'limit', source: 'usage-limit-marker', now })
    expect(router.getHealth(PRIMARY).exhaustion?.nextProbeAt).toBe(now + DEFAULT_PROBE_TTL_MS)
    expect(router.isAdmissible(PRIMARY, now + DEFAULT_PROBE_TTL_MS - 1)).toBe(false)
    expect(router.isAdmissible(PRIMARY, now + DEFAULT_PROBE_TTL_MS)).toBe(true)
  })

  it('uses DEFAULT_PROBE_TTL when a quota observation has a stale resetsAt', () => {
    const router = getSubscriptionFailoverRouter()
    const now = 6_000_000
    const resetsAt = now - 1

    router.markExhausted(PRIMARY, {
      reason: 'quota',
      source: 'structured-error',
      resetsAt,
      now,
    })

    const health = router.getHealth(PRIMARY)
    expect(health.exhaustion?.resetsAt).toBe(resetsAt)
    expect(health.exhaustion?.nextProbeAt).toBe(now + DEFAULT_PROBE_TTL_MS)
    expect(router.isAdmissible(PRIMARY, now + DEFAULT_PROBE_TTL_MS - 1)).toBe(false)
  })

  it('half-open is singleflight — only one probe lease', () => {
    const router = getSubscriptionFailoverRouter()
    const now = 10_000
    router.markExhausted(PRIMARY, {
      reason: 'quota',
      source: 'rate-limits',
      resetsAt: now,
      now: now - 1,
    })

    const first = router.tryAdmit(PRIMARY, now)
    const second = router.tryAdmit(PRIMARY, now)
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error('expected admit')
    expect(first.lease?.leaseId).toBeTruthy()
    expect(second).toEqual({ ok: false, reason: 'half-open-probe-in-flight' })
    expect(router.getHealth(PRIMARY).state).toBe('half-open')
    expect(router.isAdmissible(PRIMARY, now)).toBe(false)
  })

  it('stale success with old generation does not clear newer exhaustion', () => {
    const router = getSubscriptionFailoverRouter()
    const now = 20_000
    router.markExhausted(PRIMARY, { reason: 'q1', source: 'structured-error', resetsAt: now + 1000, now })
    const gen1 = router.getHealth(PRIMARY).exhaustion!.generation

    router.markExhausted(PRIMARY, { reason: 'q2', source: 'structured-error', resetsAt: now + 2000, now })
    const gen2 = router.getHealth(PRIMARY).exhaustion!.generation
    expect(gen2).toBe(gen1 + 1)

    router.confirmAttemptSuccess(PRIMARY, { leaseId: 'stale', generation: gen1 })
    expect(router.getHealth(PRIMARY).state).toBe('exhausted')
    expect(router.getHealth(PRIMARY).exhaustion?.generation).toBe(gen2)

    router.markAvailable(PRIMARY, { generation: gen1 })
    expect(router.getHealth(PRIMARY).state).toBe('exhausted')
  })

  it('half-open success closes the circuit; quota reopens', () => {
    const router = getSubscriptionFailoverRouter()
    const now = 30_000
    router.markExhausted(PRIMARY, {
      reason: 'quota',
      source: 'structured-error',
      resetsAt: now,
      now: now - 1,
    })
    const admit = router.tryAdmit(PRIMARY, now)
    expect(admit.ok).toBe(true)
    if (!admit.ok || !admit.lease) throw new Error('expected lease')

    router.confirmAttemptSuccess(PRIMARY, admit.lease)
    expect(router.getHealth(PRIMARY).state).toBe('available')

    router.markExhausted(PRIMARY, {
      reason: 'again',
      source: 'structured-error',
      resetsAt: now + 5,
      now,
    })
    const admit2 = router.tryAdmit(PRIMARY, now + 5)
    expect(admit2.ok && admit2.lease).toBeTruthy()
    if (!admit2.ok || !admit2.lease) throw new Error('expected lease')
    router.confirmAttemptQuota(PRIMARY, admit2.lease, {
      reason: 'still-quota',
      source: 'probe',
      resetsAt: now + 60_000,
      now: now + 5,
    })
    expect(router.getHealth(PRIMARY).state).toBe('exhausted')
    expect(router.getHealth(PRIMARY).exhaustion?.reason).toBe('still-quota')
  })

  it('half-open quota with a stale resetsAt reopens with backoff', () => {
    const router = getSubscriptionFailoverRouter()
    const resetAt = 31_000
    const probeNow = resetAt + 1
    router.markExhausted(PRIMARY, {
      reason: 'quota',
      source: 'structured-error',
      resetsAt: resetAt,
      now: resetAt - 1,
    })

    const admit = router.tryAdmit(PRIMARY, probeNow)
    if (!admit.ok || !admit.lease) throw new Error('expected half-open lease')
    const previousGeneration = router.getHealth(PRIMARY).exhaustion!.generation

    router.confirmAttemptQuota(PRIMARY, admit.lease, {
      reason: 'still-quota',
      source: 'probe',
      resetsAt: resetAt,
      now: probeNow,
    })

    const health = router.getHealth(PRIMARY)
    expect(health.state).toBe('exhausted')
    expect(health.exhaustion?.resetsAt).toBe(resetAt)
    expect(health.exhaustion?.generation).toBe(previousGeneration + 1)
    expect(health.exhaustion?.nextProbeAt).toBe(probeNow + DEFAULT_PROBE_TTL_MS)
    expect(router.tryAdmit(PRIMARY, probeNow)).toEqual({ ok: false, reason: 'exhausted-backoff' })
  })

  it('half-open other result releases the lease and restores the exhausted snapshot', () => {
    const router = getSubscriptionFailoverRouter()
    const now = 35_000
    router.markExhausted(PRIMARY, {
      reason: 'quota',
      source: 'structured-error',
      resetsAt: now,
      now: now - 1,
    })
    const snapshot = router.getHealth(PRIMARY).exhaustion
    const admit = router.tryAdmit(PRIMARY, now)
    if (!admit.ok || !admit.lease) throw new Error('expected half-open lease')

    router.confirmAttemptOther(PRIMARY, admit.lease)

    const health = router.getHealth(PRIMARY)
    expect(health.state).toBe('exhausted')
    expect(health.exhaustion).toBe(snapshot)
    expect(health.exhaustion?.generation).toBe(1)
    expect(health.exhaustion?.nextProbeAt).toBe(now)

    const readmission = router.tryAdmit(PRIMARY, now)
    expect(readmission.ok).toBe(true)
    if (!readmission.ok || !readmission.lease) throw new Error('expected immediate readmission')
    router.confirmAttemptOther(PRIMARY, readmission.lease)
  })

  it('selectNextProviderId walks the chain skipping attempted and non-admissible', async () => {
    const router = getSubscriptionFailoverRouter()
    const now = 40_000
    router.markExhausted(PRIMARY, {
      reason: 'quota',
      source: 'structured-error',
      resetsAt: now + 10_000,
      now,
    })

    const selected = await router.selectNextProviderId(
      [PRIMARY, FALLBACK, 'builtin_codex_subscription@acc_third'],
      new Set([FALLBACK]),
      (id) => id.startsWith('builtin_codex'),
      now
    )
    expect(selected).toBe('builtin_codex_subscription@acc_third')
  })

  it('resetProvider forgets only the selected provider health', () => {
    const router = getSubscriptionFailoverRouter()
    const now = 45_000
    router.markExhausted(PRIMARY, {
      reason: 'default quota',
      source: 'structured-error',
      resetsAt: now + 60_000,
      now,
    })
    router.markExhausted(FALLBACK, {
      reason: 'slot quota',
      source: 'structured-error',
      resetsAt: now + 60_000,
      now,
    })

    router.resetProvider(PRIMARY)

    expect(router.getHealth(PRIMARY)).toEqual({ providerId: PRIMARY, state: 'unknown' })
    expect(router.isAdmissible(PRIMARY, now)).toBe(true)
    expect(router.getHealth(FALLBACK).state).toBe('exhausted')
  })

  it('resetSubscriptionFailoverRouterForTests clears singleton state', () => {
    const router = getSubscriptionFailoverRouter()
    router.markExhausted(PRIMARY, { reason: 'x', source: 'probe', now: 1 })
    resetSubscriptionFailoverRouterForTests()
    expect(getSubscriptionFailoverRouter().getHealth(PRIMARY).state).toBe('unknown')
  })
})

describe('resolveCodexRuntimeTarget', () => {
  it('requests the physical Codex maximum by default and uses its effective host estimate', async () => {
    const manager = makeManager({
      models: [
        makeModel({
          contextWindow: 258_400,
          maxContextWindow: 1_000_000,
          effectiveContextWindowPercent: 95,
        }),
      ],
    })
    h.getCodexSubscriptionManager.mockReturnValue(manager)

    const result = await resolveCodexRuntimeTarget({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.4',
      configureContextWindow: true,
      chain: [PRIMARY],
      attemptedProviderIds: new Set(),
    })

    expect(result).toMatchObject({
      ok: true,
      target: {
        requestedContextWindow: 1_000_000,
        effectiveContextWindow: 950_000,
        // The active catalog value remains distinct from the requested root configuration.
        contextWindow: 258_400,
      },
    })
    expect(h.getContextLimit).toHaveBeenCalledWith(PRIMARY, 'gpt-5.4')
  })

  it('carries the logical manual preference through failover and clamps it to the physical maximum', async () => {
    h.contextLimits.set(`${PRIMARY}::gpt-5.4`, 500_000)
    const primaryManager = makeManager({
      models: [
        makeModel({
          contextWindow: 258_400,
          maxContextWindow: 1_000_000,
          effectiveContextWindowPercent: 95,
        }),
      ],
    })
    const fallbackManager = makeManager({
      models: [
        makeModel({
          contextWindow: 180_000,
          maxContextWindow: 300_000,
          effectiveContextWindowPercent: 95,
        }),
      ],
    })
    h.getCodexSubscriptionManager.mockImplementation((accountId: string | null) =>
      accountId ? fallbackManager : primaryManager
    )

    const result = await resolveCodexRuntimeTarget({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.4',
      configureContextWindow: true,
      chain: [PRIMARY, FALLBACK],
      attemptedProviderIds: new Set([PRIMARY]),
    })

    expect(result).toMatchObject({
      ok: true,
      target: {
        providerId: FALLBACK,
        requestedContextWindow: 300_000,
        effectiveContextWindow: 285_000,
      },
    })
    expect(h.getContextLimit).toHaveBeenCalledWith(PRIMARY, 'gpt-5.4')
  })

  it('omits the override when the physical catalog does not publish a nominal maximum', async () => {
    const manager = makeManager({ models: [makeModel({ contextWindow: 258_400, maxContextWindow: null })] })
    h.getCodexSubscriptionManager.mockReturnValue(manager)

    const result = await resolveCodexRuntimeTarget({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.4',
      configureContextWindow: true,
      chain: [PRIMARY],
      attemptedProviderIds: new Set(),
    })

    expect(result).toMatchObject({ ok: true, target: { effectiveContextWindow: 258_400 } })
    if (!result.ok) throw new Error('expected target')
    expect(result.target).not.toHaveProperty('requestedContextWindow')
  })

  it('wires explicit rate-limit updates per account and skips the exhausted account on the next resolution', async () => {
    const primaryManager = makeManager()
    const fallbackManager = makeManager()
    h.getCodexSubscriptionManager.mockImplementation((accountId: string | null) =>
      accountId ? fallbackManager : primaryManager
    )

    const first = await resolveCodexRuntimeTarget({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.4',
      chain: [PRIMARY, FALLBACK],
      attemptedProviderIds: new Set(),
      now: 50_000,
    })
    expect(first).toMatchObject({ ok: true, target: { providerId: PRIMARY } })

    primaryManager.getStatus.mockClear()
    primaryManager.listModels.mockClear()
    primaryManager.getClient.mockClear()
    fallbackManager.getStatus.mockClear()
    fallbackManager.listModels.mockClear()
    fallbackManager.getClient.mockClear()

    primaryManager.emitRateLimitsUpdated({
      rateLimitReachedType: 'primary',
      primary: { resetsAt: Date.now() + 60_000 },
    })

    const second = await resolveCodexRuntimeTarget({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.4',
      chain: [PRIMARY, FALLBACK],
      attemptedProviderIds: new Set(),
    })

    expect(second).toMatchObject({ ok: true, target: { providerId: FALLBACK } })
    expect(getSubscriptionFailoverRouter().getHealth(PRIMARY)).toMatchObject({
      state: 'exhausted',
      exhaustion: { source: 'rate-limits' },
    })
    expect(getSubscriptionFailoverRouter().getHealth(FALLBACK).state).toBe('unknown')
    expect(primaryManager.getStatus).not.toHaveBeenCalled()
    expect(primaryManager.listModels).not.toHaveBeenCalled()
    expect(primaryManager.getClient).not.toHaveBeenCalled()
    expect(fallbackManager.getClient).toHaveBeenCalledOnce()
  })

  it('applies an explicit cached snapshot before listener bootstrap and does not let account A affect B', async () => {
    const primaryManager = makeManager({
      rateLimits: {
        rateLimitReachedType: 'secondary',
        secondary: { resetsAt: 2_000_000 },
      },
    })
    const fallbackManager = makeManager()
    // Simulate a notification subscription that has not been installed yet: the cached snapshot remains the
    // only source available to this resolution.
    primaryManager.onRateLimitsUpdated.mockImplementation(() => () => false)
    h.getCodexSubscriptionManager.mockImplementation((accountId: string | null) =>
      accountId ? fallbackManager : primaryManager
    )

    const result = await resolveCodexRuntimeTarget({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.4',
      chain: [PRIMARY, FALLBACK],
      attemptedProviderIds: new Set(),
      now: 1_000_000,
    })

    expect(result).toMatchObject({ ok: true, target: { providerId: FALLBACK } })
    expect(getSubscriptionFailoverRouter().getHealth(PRIMARY)).toMatchObject({
      state: 'exhausted',
      exhaustion: { source: 'rate-limits' },
    })
    expect(getSubscriptionFailoverRouter().getHealth(FALLBACK).state).toBe('unknown')
    expect(primaryManager.getStatus).not.toHaveBeenCalled()
    expect(primaryManager.listModels).not.toHaveBeenCalled()
    expect(primaryManager.getClient).not.toHaveBeenCalled()
    expect(fallbackManager.getClient).toHaveBeenCalledOnce()
  })

  it('ignores an expired explicit snapshot after a rebind but blocks a future reset', async () => {
    const now = 1_000_000
    const manager = makeManager()
    h.getCodexSubscriptionManager.mockReturnValue(manager)

    await resolveCodexRuntimeTarget({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.4',
      chain: [PRIMARY],
      attemptedProviderIds: new Set(),
      now,
    })

    manager.getRateLimitsSnapshot.mockReturnValue({
      rateLimitReachedType: 'primary',
      primary: { resetsAt: now - 1 },
    })
    resetSubscriptionFailoverRouterForTests()

    const recoveredRouter = getSubscriptionFailoverRouter()
    const recovered = await resolveCodexRuntimeTarget({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.4',
      chain: [PRIMARY],
      attemptedProviderIds: new Set(),
      now,
    })

    expect(recovered).toMatchObject({ ok: true, target: { providerId: PRIMARY } })
    expect(recoveredRouter.getHealth(PRIMARY).state).toBe('unknown')
    expect(recoveredRouter.tryAdmit(PRIMARY, now)).toEqual({ ok: true })

    manager.getRateLimitsSnapshot.mockReturnValue({
      rateLimitReachedType: 'primary',
      primary: { resetsAt: now + 60_000 },
    })
    resetSubscriptionFailoverRouterForTests()

    const blockedRouter = getSubscriptionFailoverRouter()
    const blocked = await resolveCodexRuntimeTarget({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.4',
      chain: [PRIMARY],
      attemptedProviderIds: new Set(),
      now,
    })

    expect(blocked).toMatchObject({ ok: false, error: 'no-eligible-account', reason: 'quota-exhausted' })
    expect(blockedRouter.getHealth(PRIMARY)).toMatchObject({
      state: 'exhausted',
      exhaustion: { source: 'rate-limits', resetsAt: now + 60_000 },
    })
    expect(blockedRouter.tryAdmit(PRIMARY, now)).toEqual({ ok: false, reason: 'exhausted-backoff' })
  })

  it('does not open a circuit from a percentage-only cached snapshot', async () => {
    const manager = makeManager({
      rateLimits: { primary: { usedPercent: 100, resetsAt: Date.now() + 60_000 } },
      snapshotAuth: null,
    })
    h.getCodexSubscriptionManager.mockReturnValue(manager)

    const result = await resolveCodexRuntimeTarget({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.4',
      chain: [PRIMARY],
      attemptedProviderIds: new Set(),
    })

    expect(result).toMatchObject({ ok: true, target: { providerId: PRIMARY } })
    expect(getSubscriptionFailoverRouter().getHealth(PRIMARY).state).toBe('unknown')
    expect(manager.getStatus).toHaveBeenCalledOnce()
    expect(manager.listModels).toHaveBeenCalledOnce()
    expect(manager.getClient).toHaveBeenCalledOnce()
  })

  it('cleans up the old notification binding when the router is recreated', async () => {
    const manager = makeManager()
    h.getCodexSubscriptionManager.mockReturnValue(manager)

    await resolveCodexRuntimeTarget({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.4',
      chain: [PRIMARY],
      attemptedProviderIds: new Set(),
    })
    const oldRouter = getSubscriptionFailoverRouter()

    resetSubscriptionFailoverRouterForTests()
    const newRouter = getSubscriptionFailoverRouter()
    await resolveCodexRuntimeTarget({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.4',
      chain: [PRIMARY],
      attemptedProviderIds: new Set(),
    })

    expect(manager.onRateLimitsUpdated).toHaveBeenCalledTimes(2)
    oldRouter.reset()
    manager.emitRateLimitsUpdated({ rateLimitReachedType: 'primary' })
    expect(oldRouter.getHealth(PRIMARY).state).toBe('unknown')
    expect(newRouter.getHealth(PRIMARY).state).toBe('exhausted')
  })

  it('unbinds rate-limit notifications across an identity reset and keeps other slots intact', async () => {
    const primaryManager = makeManager()
    const fallbackManager = makeManager()
    h.getCodexSubscriptionManager.mockImplementation((accountId: string | null) =>
      accountId ? fallbackManager : primaryManager
    )

    await resolveCodexRuntimeTarget({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.4',
      chain: [PRIMARY],
      attemptedProviderIds: new Set(),
    })
    await resolveCodexRuntimeTarget({
      logicalProviderId: FALLBACK,
      modelId: 'gpt-5.4',
      chain: [FALLBACK],
      attemptedProviderIds: new Set(),
    })

    const reached = {
      rateLimitReachedType: 'primary',
      primary: { resetsAt: Date.now() + 60_000 },
    }
    primaryManager.emitRateLimitsUpdated(reached)
    fallbackManager.emitRateLimitsUpdated({
      rateLimitReachedType: 'secondary',
      secondary: { resetsAt: Date.now() + 60_000 },
    })

    const router = getSubscriptionFailoverRouter()
    expect(router.getHealth(PRIMARY).state).toBe('exhausted')
    expect(router.getHealth(FALLBACK).state).toBe('exhausted')

    resetCodexRateLimitBinding(primaryManager as unknown as CodexSubscriptionManager, PRIMARY)
    router.resetProvider(PRIMARY)
    expect(router.getHealth(PRIMARY).state).toBe('unknown')
    expect(router.getHealth(FALLBACK).state).toBe('exhausted')

    // The old callback must not route the old identity's signal after unbind.
    primaryManager.emitRateLimitsUpdated(reached)
    expect(router.getHealth(PRIMARY).state).toBe('unknown')
    expect(router.getHealth(FALLBACK).state).toBe('exhausted')

    // A new binding starts with an empty signal key, so the same reached signature opens the new circuit.
    await resolveCodexRuntimeTarget({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.4',
      chain: [PRIMARY],
      attemptedProviderIds: new Set(),
    })
    primaryManager.emitRateLimitsUpdated(reached)
    expect(router.getHealth(PRIMARY).state).toBe('exhausted')
    expect(router.getHealth(FALLBACK).state).toBe('exhausted')
  })

  it('lets imagegen select the only available default per account', async () => {
    const defaultModel = makeModel({
      id: 'gpt-5.6-default',
      model: 'gpt-5.6-default',
      displayName: 'GPT-5.6 default',
      isDefault: true,
    })
    const manager = makeManager({ models: [defaultModel] })
    h.getCodexSubscriptionManager.mockReturnValue(manager)
    const resolveModelId = vi.fn(async (_manager, models) => models[0].id)

    const result = await resolveCodexRuntimeTarget({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.6-mini',
      resolveModelId,
      chain: [PRIMARY],
      attemptedProviderIds: new Set(),
    })

    expect(result).toMatchObject({ ok: true, target: { runtimeModelId: 'gpt-5.6-default' } })
    expect(resolveModelId).toHaveBeenCalledWith(manager, [defaultModel])
  })

  it('skips exhausted primary and resolves fallback', async () => {
    const router = getSubscriptionFailoverRouter()
    const now = 50_000
    router.markExhausted(PRIMARY, {
      reason: 'quota',
      source: 'structured-error',
      resetsAt: now + 100_000,
      now,
    })

    const primaryManager = makeManager({ authenticated: true })
    const fallbackManager = makeManager({ authenticated: true })
    h.getCodexSubscriptionManager.mockImplementation((accountId: string | null) =>
      accountId ? fallbackManager : primaryManager
    )

    const result = await resolveCodexRuntimeTarget({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.4',
      chain: [PRIMARY, FALLBACK],
      attemptedProviderIds: new Set(),
      now,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.target.providerId).toBe(FALLBACK)
    expect(result.target.serviceTier).toBe('default')
    expect(fallbackManager.getClient).toHaveBeenCalled()
  })

  it('skips account when specific reasoning effort is unsupported (no degrade)', async () => {
    h.getCodexSubscriptionManager.mockReturnValue(
      makeManager({
        models: [makeModel({ supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }] })],
      })
    )

    const result = await resolveCodexRuntimeTarget({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.4',
      reasoningEffort: 'xhigh',
      chain: [PRIMARY],
      attemptedProviderIds: new Set(),
    })

    expect(result).toMatchObject({ ok: false, error: 'no-eligible-account', reason: 'incompatible' })
    expect(result).not.toMatchObject({ message: expect.stringMatching(/exhausted/i) })
  })

  it('classifies a failed status probe as unavailable', async () => {
    const manager = makeManager({ snapshotAuth: null })
    manager.getStatus.mockRejectedValue(new Error('Codex transport unavailable'))
    h.getCodexSubscriptionManager.mockReturnValue(manager)

    const result = await resolveCodexRuntimeTarget({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.4',
      chain: [PRIMARY],
      attemptedProviderIds: new Set(),
    })

    expect(result).toMatchObject({ ok: false, error: 'no-eligible-account', reason: 'unavailable' })
    expect(result).not.toMatchObject({ message: expect.stringMatching(/Connect your ChatGPT/i) })
    expect(manager.listModels).not.toHaveBeenCalled()
  })

  it('classifies a confirmed unauthenticated status as not-authenticated', async () => {
    const manager = makeManager({ snapshotAuth: null, authenticated: false })
    h.getCodexSubscriptionManager.mockReturnValue(manager)

    const result = await resolveCodexRuntimeTarget({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.4',
      chain: [PRIMARY],
      attemptedProviderIds: new Set(),
    })

    expect(result).toMatchObject({ ok: false, error: 'no-eligible-account', reason: 'not-authenticated' })
    expect(result).toMatchObject({ message: expect.stringMatching(/Connect your ChatGPT/i) })
    expect(manager.getStatus).toHaveBeenCalledOnce()
  })

  it('classifies a ready connected unauthenticated snapshot as not-authenticated', async () => {
    const manager = makeManager({ snapshotAuth: false, authenticated: false })
    h.getCodexSubscriptionManager.mockReturnValue(manager)

    const result = await resolveCodexRuntimeTarget({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.4',
      chain: [PRIMARY],
      attemptedProviderIds: new Set(),
    })

    expect(result).toMatchObject({ ok: false, error: 'no-eligible-account', reason: 'not-authenticated' })
    expect(result).toMatchObject({ message: expect.stringMatching(/Connect your ChatGPT/i) })
    expect(manager.getStatus).not.toHaveBeenCalled()
  })

  it('classifies an errored unauthenticated snapshot as unavailable', async () => {
    const manager = makeManager({ snapshotAuth: false, snapshotState: 'error', authenticated: false })
    h.getCodexSubscriptionManager.mockReturnValue(manager)

    const result = await resolveCodexRuntimeTarget({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.4',
      chain: [PRIMARY],
      attemptedProviderIds: new Set(),
    })

    expect(result).toMatchObject({ ok: false, error: 'no-eligible-account', reason: 'unavailable' })
    expect(result).not.toMatchObject({ message: expect.stringMatching(/Connect your ChatGPT/i) })
    expect(manager.getStatus).not.toHaveBeenCalled()
  })

  it('fails open to an authenticated fallback after an unavailable auth probe', async () => {
    const primaryManager = makeManager({ snapshotAuth: null })
    primaryManager.getStatus.mockRejectedValue(new Error('Codex transport unavailable'))
    const fallbackManager = makeManager({ authenticated: true })
    h.getCodexSubscriptionManager.mockImplementation((accountId: string | null) =>
      accountId ? fallbackManager : primaryManager
    )

    const result = await resolveCodexRuntimeTarget({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.4',
      chain: [PRIMARY, FALLBACK],
      attemptedProviderIds: new Set(),
    })

    expect(result).toMatchObject({ ok: true, target: { providerId: FALLBACK } })
    expect(primaryManager.listModels).not.toHaveBeenCalled()
    expect(fallbackManager.getClient).toHaveBeenCalled()
  })

  it('aggregates two disconnected accounts as not-authenticated', async () => {
    const manager = makeManager({ authenticated: false })
    h.getCodexSubscriptionManager.mockReturnValue(manager)

    const result = await resolveCodexRuntimeTarget({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.4',
      chain: [PRIMARY, FALLBACK],
      attemptedProviderIds: new Set(),
    })

    expect(result).toMatchObject({ ok: false, error: 'no-eligible-account', reason: 'not-authenticated' })
    expect(result).toMatchObject({ message: expect.stringMatching(/Connect your ChatGPT/i) })
    expect(result).not.toMatchObject({ message: expect.stringMatching(/exhausted/i) })
  })

  it('reports quota only when every candidate is blocked by a quota circuit', async () => {
    const router = getSubscriptionFailoverRouter()
    const now = 60_000
    for (const providerId of [PRIMARY, FALLBACK]) {
      router.markExhausted(providerId, {
        reason: 'quota',
        source: 'structured-error',
        resetsAt: now + 100_000,
        now,
      })
    }

    const result = await resolveCodexRuntimeTarget({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.4',
      chain: [PRIMARY, FALLBACK],
      attemptedProviderIds: new Set(),
      now,
    })

    expect(result).toMatchObject({ ok: false, error: 'no-eligible-account', reason: 'quota-exhausted' })
    expect(result).toMatchObject({ message: expect.stringMatching(/all.*exhausted/i) })
  })

  it('does not report all exhausted when quota is mixed with a disconnected account', async () => {
    const router = getSubscriptionFailoverRouter()
    const now = 70_000
    router.markExhausted(PRIMARY, {
      reason: 'quota',
      source: 'structured-error',
      resetsAt: now + 100_000,
      now,
    })
    h.getCodexSubscriptionManager.mockReturnValue(makeManager({ authenticated: false }))

    const result = await resolveCodexRuntimeTarget({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.4',
      chain: [PRIMARY, FALLBACK],
      attemptedProviderIds: new Set(),
      now,
    })

    expect(result).toMatchObject({ ok: false, error: 'no-eligible-account', reason: 'unavailable' })
    expect(result).not.toMatchObject({ message: expect.stringMatching(/exhausted/i) })
  })

  it('resolves MAESTRLY_ULTRA_EFFORT to the highest supported effort', async () => {
    h.getCodexSubscriptionManager.mockReturnValue(makeManager())

    const result = await resolveCodexRuntimeTarget({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.4',
      reasoningEffort: MAESTRLY_ULTRA_EFFORT,
      fastMode: true,
      chain: [PRIMARY],
      attemptedProviderIds: new Set(),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.target.reasoningEffort).toBe('high')
    expect(result.target.serviceTier).toBe('priority')
  })

  it('preserves Fast and recalculates tiers for every physical account', async () => {
    const primaryManager = makeManager()
    primaryManager.preferredServiceTier.mockResolvedValue(null)
    const fallbackManager = makeManager()
    fallbackManager.preferredServiceTier.mockResolvedValue('fast')
    h.getCodexSubscriptionManager.mockImplementation((accountId: string | null) =>
      accountId ? fallbackManager : primaryManager
    )

    const result = await resolveCodexRuntimeTarget({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.4',
      fastMode: true,
      chain: [PRIMARY, FALLBACK],
      attemptedProviderIds: new Set(),
    })

    expect(result).toMatchObject({ ok: true, target: { providerId: FALLBACK, serviceTier: 'fast' } })
    expect(primaryManager.getClient).not.toHaveBeenCalled()
    expect(primaryManager.preferredServiceTier).toHaveBeenCalledWith('gpt-5.4')
    expect(fallbackManager.preferredServiceTier).toHaveBeenCalledWith('gpt-5.4')

    fallbackManager.preferredServiceTier.mockResolvedValue(null)
    const unavailable = await resolveCodexRuntimeTarget({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.4',
      fastMode: true,
      chain: [PRIMARY, FALLBACK],
      attemptedProviderIds: new Set(),
    })
    expect(unavailable).toMatchObject({ ok: false, error: 'no-eligible-account', reason: 'incompatible' })
  })

  it('resolves legacy ultra to the highest supported effort when native ultra is absent', async () => {
    h.getCodexSubscriptionManager.mockReturnValue(makeManager())

    const result = await resolveCodexRuntimeTarget({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.4',
      reasoningEffort: 'ultra',
      chain: [PRIMARY],
      attemptedProviderIds: new Set(),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.target.reasoningEffort).toBe('high')
  })

  it('preserves native ultra when the catalog advertises it', async () => {
    h.getCodexSubscriptionManager.mockReturnValue(
      makeManager({
        models: [
          makeModel({
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: '' },
              { reasoningEffort: 'high', description: '' },
              { reasoningEffort: 'ultra', description: '' },
            ],
          }),
        ],
      })
    )

    const result = await resolveCodexRuntimeTarget({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.4',
      reasoningEffort: 'ultra',
      chain: [PRIMARY],
      attemptedProviderIds: new Set(),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.target.reasoningEffort).toBe('ultra')
  })
})
