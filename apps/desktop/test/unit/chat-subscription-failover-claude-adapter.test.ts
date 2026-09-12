import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ClaudeSubscriptionManager,
  ClaudeSubscriptionStatus,
  ClaudeSubscriptionAccountIdentity,
} from '../../src/main/chat/claude-agent-sdk/manager'

const mocks = vi.hoisted(() => ({ managers: new Map<string | null, ClaudeSubscriptionManager>() }))
vi.mock('../../src/main/chat/catalog', () => ({
  getProvider: (id: string) => ({ id }),
  isClaudeSubscriptionProvider: (id: string) => id.split('@')[0] === 'builtin_claude_subscription',
}))
vi.mock('../../src/main/chat/claude-agent-sdk/manager', () => ({
  getClaudeSubscriptionManager: (id: string | null) => mocks.managers.get(id),
}))
import {
  resolveClaudeRuntimeTarget,
  settleClaudeAttempt,
  type ResolveClaudeTargetArgs,
} from '../../src/main/chat/subscription-failover/claude-adapter'
import {
  getSubscriptionFailoverRouter,
  resetSubscriptionFailoverRouterForTests,
} from '../../src/main/chat/subscription-failover/router'

const BASE = 'builtin_claude_subscription'
const SECOND = `${BASE}@acc_second`
const model: ModelInfo = {
  value: 'fable',
  resolvedModel: 'claude-fable-5-1',
  displayName: 'Fable',
  description: '',
  supportsEffort: true,
  supportedEffortLevels: ['low', 'high', 'max'],
  supportsFastMode: true,
}
function fixture(id: string | null = null) {
  const status: ClaudeSubscriptionStatus = {
    state: 'ready',
    available: true,
    authenticated: true,
    account: null,
    accountFingerprint: `fingerprint-${id}`,
    accountEpoch: 1,
    cliVersion: '2.0.0',
    sdkVersion: '0.3.263',
    error: null,
  }
  const manager = {
    status: vi.fn(async () => ({ ...status })),
    getStatusSnapshot: vi.fn(() => ({ ...status })),
    assertAccountIdentity: vi.fn((identity: ClaudeSubscriptionAccountIdentity) => {
      if (identity.fingerprint !== status.accountFingerprint || identity.epoch !== status.accountEpoch)
        throw new Error('changed')
    }),
    listModels: vi.fn(async (): Promise<ModelInfo[]> => [{ ...model }]),
    getObservedModelContextWindow: vi.fn(() => 200_000),
  } satisfies Pick<
    ClaudeSubscriptionManager,
    'status' | 'getStatusSnapshot' | 'assertAccountIdentity' | 'listModels' | 'getObservedModelContextWindow'
  >
  mocks.managers.set(id, manager as unknown as ClaudeSubscriptionManager)
  return { manager, status }
}
function args(overrides: Partial<ResolveClaudeTargetArgs> = {}): ResolveClaudeTargetArgs {
  return {
    logicalProviderId: BASE,
    modelId: 'fable',
    chain: [BASE, SECOND],
    attemptedProviderIds: new Set(),
    signal: new AbortController().signal,
    now: 1000,
    ...overrides,
  }
}
beforeEach(() => {
  mocks.managers.clear()
  resetSubscriptionFailoverRouterForTests()
})

describe('Claude physical account resolution', () => {
  it('resolves aliases and preserves effort and Fast mode', async () => {
    fixture()
    const result = await resolveClaudeRuntimeTarget(args({ reasoningEffort: 'high', fastMode: true }))
    expect(result).toMatchObject({
      ok: true,
      target: {
        providerId: BASE,
        runtimeModelId: 'claude-fable-5-1',
        reasoningEffort: 'high',
        fastMode: true,
        contextWindow: 200_000,
      },
    })
  })
  it('requires the same canonical model and supported effort/Fast on fallback', async () => {
    const first = fixture()
    const second = fixture('acc_second')
    first.manager.listModels.mockResolvedValue([{ ...model, resolvedModel: 'claude-fable-5' }])
    expect(await resolveClaudeRuntimeTarget(args({ runtimeModelId: 'claude-fable-5-1' }))).toMatchObject({
      ok: true,
      target: { providerId: SECOND },
    })
    second.manager.listModels.mockResolvedValue([{ ...model, supportsFastMode: false }])
    expect(
      await resolveClaudeRuntimeTarget(args({ runtimeModelId: 'claude-fable-5-1', fastMode: true }))
    ).toMatchObject({ ok: false, reason: 'incompatible' })
    expect(await resolveClaudeRuntimeTarget(args({ reasoningEffort: 'xhigh' }))).toMatchObject({
      ok: false,
      reason: 'incompatible',
    })
  })
  it('keeps mixed failures unavailable', async () => {
    fixture()
    const second = fixture('acc_second')
    second.status.authenticated = false
    getSubscriptionFailoverRouter().markExhausted(BASE, { reason: 'quota', source: 'probe', now: 0, resetsAt: 2000 })
    expect(await resolveClaudeRuntimeTarget(args())).toMatchObject({ ok: false, reason: 'unavailable', resetsAt: 2000 })
  })
  it('skips cooling accounts, consumes one due probe, and restores other outcomes', async () => {
    const first = fixture()
    fixture('acc_second')
    const router = getSubscriptionFailoverRouter()
    router.markExhausted(BASE, { reason: 'quota', source: 'probe', now: 0, resetsAt: 2000 })
    expect(await resolveClaudeRuntimeTarget(args())).toMatchObject({ ok: true, target: { providerId: SECOND } })
    expect(first.manager.listModels).not.toHaveBeenCalled()
    const context = await resolveClaudeRuntimeTarget(args({ now: 2000, admit: false }))
    expect(context).toMatchObject({ ok: true, target: { providerId: BASE } })
    expect(router.getHealth(BASE).state).toBe('exhausted')
    const probe = await resolveClaudeRuntimeTarget(args({ now: 2000 }))
    expect(probe).toMatchObject({ ok: true, target: { availabilityLease: { generation: 1 } } })
    expect(await resolveClaudeRuntimeTarget(args({ now: 2000 }))).toMatchObject({
      ok: true,
      target: { providerId: SECOND },
    })
    if (!probe.ok) throw new Error('expected probe')
    settleClaudeAttempt(probe.target, 'other')
    expect(router.getHealth(BASE)).toMatchObject({ state: 'exhausted', exhaustion: { nextProbeAt: 2000 } })
  })
  it('closes a successful due probe and preserves newer exhaustion against stale probe success', async () => {
    fixture()
    const router = getSubscriptionFailoverRouter()
    router.markExhausted(BASE, { reason: 'quota', source: 'probe', now: 0, resetsAt: 1000 })
    const probe = await resolveClaudeRuntimeTarget(args())
    if (!probe.ok) throw new Error('expected probe')
    settleClaudeAttempt(probe.target, 'success')
    expect(router.getHealth(BASE).state).toBe('available')
    router.markExhausted(BASE, { reason: 'new quota', source: 'probe', now: 1000, resetsAt: 2000 })
    const next = await resolveClaudeRuntimeTarget(args({ now: 2000 }))
    if (!next.ok) throw new Error('expected probe')
    router.markExhausted(BASE, { reason: 'concurrent quota', source: 'probe', now: 2000, resetsAt: 3000 })
    settleClaudeAttempt(next.target, 'success')
    expect(router.getHealth(BASE)).toMatchObject({ state: 'exhausted', exhaustion: { reason: 'concurrent quota' } })
  })
  it('rejects a stale status snapshot before it can reset current health', async () => {
    const first = fixture()
    const admitted = await resolveClaudeRuntimeTarget(args())
    if (!admitted.ok) throw new Error('expected target')
    const router = getSubscriptionFailoverRouter()
    router.markExhausted(BASE, { reason: 'quota', source: 'probe', now: 0, resetsAt: 2000 })
    first.manager.status.mockImplementation(async () => ({ ...first.status, accountEpoch: 0 }))
    expect(await resolveClaudeRuntimeTarget(args({ chain: [BASE] }))).toMatchObject({
      ok: false,
      reason: 'unavailable',
    })
    expect(router.getHealth(BASE).state).toBe('exhausted')
  })
  it('does not clear newer quota on stale success', async () => {
    fixture()
    const result = await resolveClaudeRuntimeTarget(args())
    if (!result.ok) throw new Error('expected target')
    settleClaudeAttempt(result.target, 'quota', { reason: 'quota', source: 'structured-error', now: 0 })
    settleClaudeAttempt(result.target, 'success')
    expect(getSubscriptionFailoverRouter().getHealth(BASE).state).toBe('exhausted')
  })
  it('resets health for a changed identity and ignores old callbacks', async () => {
    const first = fixture()
    const result = await resolveClaudeRuntimeTarget(args())
    if (!result.ok) throw new Error('expected target')
    settleClaudeAttempt(result.target, 'quota', { reason: 'old', source: 'probe', now: 0 })
    first.status.accountEpoch++
    expect(await resolveClaudeRuntimeTarget(args())).toMatchObject({
      ok: true,
      target: { providerId: BASE, accountIdentity: { epoch: 2 } },
    })
    settleClaudeAttempt(result.target, 'quota', { reason: 'stale', source: 'probe', now: 0 })
    expect(getSubscriptionFailoverRouter().getHealth(BASE).state).toBe('unknown')
  })
  it('retains exhaustion when a manager is recreated for the same physical identity', async () => {
    fixture()
    await resolveClaudeRuntimeTarget(args({ chain: [BASE], admit: false }))
    getSubscriptionFailoverRouter().markExhausted(BASE, { reason: 'quota', source: 'probe', now: 0, resetsAt: 2000 })
    fixture()
    expect(await resolveClaudeRuntimeTarget(args({ chain: [BASE] }))).toMatchObject({
      ok: false,
      reason: 'quota-exhausted',
    })
  })
  it('rejects identity changes during discovery without taking a lease', async () => {
    const first = fixture()
    first.manager.listModels.mockImplementation(async () => {
      first.status.accountEpoch++
      return [model]
    })
    expect(await resolveClaudeRuntimeTarget(args({ chain: [BASE] }))).toMatchObject({
      ok: false,
      reason: 'unavailable',
    })
    expect(getSubscriptionFailoverRouter().getHealth(BASE).state).toBe('unknown')
  })
  it('honors abort after discovery and attempted accounts', async () => {
    const first = fixture()
    fixture('acc_second')
    expect(await resolveClaudeRuntimeTarget(args({ attemptedProviderIds: new Set([BASE]) }))).toMatchObject({
      ok: true,
      target: { providerId: SECOND },
    })
    const controller = new AbortController()
    first.manager.listModels.mockImplementation(async () => {
      controller.abort()
      return [model]
    })
    expect(await resolveClaudeRuntimeTarget(args({ signal: controller.signal }))).toMatchObject({
      ok: false,
      error: 'aborted',
    })
  })
})
