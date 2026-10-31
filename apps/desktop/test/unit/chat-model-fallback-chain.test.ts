import { afterEach, describe, expect, it } from 'vitest'
import { activeAccountProviderId } from '../../src/shared/chat'
import {
  freezeModelChain,
  isCandidateAdmissible,
  orderByContextFit,
  recordCandidateFailure,
  requiredTokensAfterOverflow,
  selectNextCandidate,
  settleSticky,
  type ModelCandidate,
} from '../../src/main/chat/model-fallback/chain'
import { sanitizeModelFallbackConfig } from '../../src/main/chat/model-fallback/config'
import { classifyModelFailure } from '../../src/main/chat/model-fallback/error-classifier'
import {
  ModelCandidateUnsuitable,
  runHelperWithModelFallback,
  runWithModelFallback,
} from '../../src/main/chat/model-fallback/run-with-fallback'
import { resetStickyWinnersForTests, stickyWinner } from '../../src/main/chat/model-fallback/sticky'
import { modelCircuitKey, SubscriptionFailoverRouter } from '../../src/main/chat/subscription-failover/router'

const NOW = Date.UTC(2026, 9, 31, 12, 0, 0)
const CLAUDE = 'builtin_claude_subscription'
const config = sanitizeModelFallbackConfig({
  version: 1,
  enabled: true,
  fallbacks: [
    { providerId: 'openai', modelId: 'gpt-5', reasoning: 'high' },
    { providerId: 'local', modelId: 'qwen' },
  ],
})

function quota429() {
  return Object.assign(new Error('You exceeded your current quota'), { statusCode: 429 })
}

describe('model fallback config', () => {
  it('never throws and filters invalid entries', () => {
    expect(sanitizeModelFallbackConfig(null)).toEqual({ version: 1, enabled: false, fallbacks: [] })
    expect(sanitizeModelFallbackConfig({ version: 2, enabled: true, fallbacks: [] }).enabled).toBe(false)
    expect(
      sanitizeModelFallbackConfig({
        version: 1,
        enabled: true,
        fallbacks: [
          { providerId: 'a', modelId: 'm', reasoning: 'max', fastMode: true },
          { providerId: 'a', modelId: 'm' },
          { providerId: '', modelId: 'x' },
          { providerId: 'b', modelId: 'n', reasoning: '<script>' },
          'garbage',
        ],
      })
    ).toEqual({
      version: 1,
      enabled: true,
      fallbacks: [
        { providerId: 'a', modelId: 'm', reasoning: 'max', fastMode: true },
        { providerId: 'b', modelId: 'n' },
      ],
    })
  })
})

describe('freezeModelChain', () => {
  afterEach(() => resetStickyWinnersForTests())

  it('puts the primary first and drops it from the fallbacks', () => {
    const chain = freezeModelChain({ primary: { providerId: 'openai', modelId: 'gpt-5' }, config })
    expect(chain.map((c) => `${c.providerId}/${c.modelId}`)).toEqual(['openai/gpt-5', 'local/qwen'])
    expect(chain[0]).toMatchObject({ primary: true })
    expect(chain[0]).not.toHaveProperty('reasoning')
  })

  it('is strict for pinned or frozen executions and when disabled', () => {
    const primary = { providerId: CLAUDE, modelId: 'opus' }
    expect(freezeModelChain({ primary, config, strict: true })).toHaveLength(1)
    expect(freezeModelChain({ primary, config: { ...config, enabled: false } })).toHaveLength(1)
  })

  it('skips providers that cannot run', () => {
    const chain = freezeModelChain({
      primary: { providerId: CLAUDE, modelId: 'opus' },
      config,
      isProviderUsable: (id) => id !== 'local',
    })
    expect(chain.map((c) => c.providerId)).toEqual([CLAUDE, 'openai'])
  })

  it('a frozen chain does not change when the config changes later', () => {
    const chain = freezeModelChain({ primary: { providerId: CLAUDE, modelId: 'opus' }, config })
    const snapshot = JSON.stringify(chain)
    config.fallbacks.push({ providerId: 'late', modelId: 'x' })
    expect(JSON.stringify(chain)).toBe(snapshot)
    config.fallbacks.pop()
  })

  it('moves a live sticky winner in front of the primary', () => {
    const primary = { providerId: CLAUDE, modelId: 'opus' }
    const chain = freezeModelChain({ primary, config, stickyScope: 'conv:1', now: NOW })
    settleSticky({
      scope: 'conv:1',
      chain,
      served: chain[2]!,
      failed: [chain[0]!, chain[1]!],
      primaryFailureReason: 'quota',
      now: NOW,
    })
    const next = freezeModelChain({ primary, config, stickyScope: 'conv:1', now: NOW + 60_000 })
    expect(next.map((c) => c.providerId)).toEqual(['local', CLAUDE, 'openai'])
    expect(next[1]).toMatchObject({ primary: true })
  })
})

describe('candidate admission and ordering', () => {
  const router = new SubscriptionFailoverRouter()
  afterEach(() => router.reset())
  const accountChainOf = (id: string) => (id === CLAUDE ? [CLAUDE, `${CLAUDE}@acc_2`] : [])

  it('admits a subscription candidate while any of its accounts can run', () => {
    const candidate: ModelCandidate = { providerId: CLAUDE, modelId: 'opus', primary: true }
    router.markExhausted(CLAUDE, { reason: 'quota', source: 'structured-error', now: NOW })
    expect(isCandidateAdmissible(candidate, { router, accountChainOf, now: NOW })).toBe(true)
    router.markExhausted(`${CLAUDE}@acc_2`, { reason: 'quota', source: 'structured-error', now: NOW })
    expect(isCandidateAdmissible(candidate, { router, accountChainOf, now: NOW })).toBe(false)
  })

  it('blocks a BYOK candidate on its model or its account circuit', () => {
    const candidate: ModelCandidate = { providerId: 'openai', modelId: 'gpt-5' }
    recordCandidateFailure(
      router,
      candidate,
      classifyModelFailure(Object.assign(new Error('x'), { statusCode: 529 })),
      undefined,
      NOW
    )
    expect(router.isAdmissible(modelCircuitKey('openai', 'gpt-5'), NOW)).toBe(false)
    expect(router.isAdmissible('openai', NOW)).toBe(true)
    expect(
      isCandidateAdmissible({ providerId: 'openai', modelId: 'gpt-4' }, { router, accountChainOf, now: NOW })
    ).toBe(true)
    recordCandidateFailure(
      router,
      { providerId: 'openai', modelId: 'gpt-4' },
      classifyModelFailure(Object.assign(new Error('Payment required'), { statusCode: 402 })),
      undefined,
      NOW
    )
    expect(
      isCandidateAdmissible({ providerId: 'openai', modelId: 'gpt-4' }, { router, accountChainOf, now: NOW })
    ).toBe(false)
  })

  it('leaves Claude and Codex accounts to their own account layer', () => {
    recordCandidateFailure(
      router,
      { providerId: CLAUDE, modelId: 'opus' },
      classifyModelFailure({ code: 'claude-accounts-exhausted', message: 'x' }),
      undefined,
      NOW
    )
    expect(router.getHealth(CLAUDE).state).toBe('unknown')
  })

  it('admits the active-account selection by its pool and never cools down its virtual id', () => {
    const active = activeAccountProviderId('claude-subscription')
    const pool = (id: string) => (id === active ? [`${CLAUDE}@acc_2`, CLAUDE] : [])
    const candidate: ModelCandidate = { providerId: active, modelId: 'opus', primary: true }
    recordCandidateFailure(
      router,
      candidate,
      classifyModelFailure(Object.assign(new Error('You exceeded your current quota'), { statusCode: 429 })),
      undefined,
      NOW
    )
    expect(router.getHealth(active).state).toBe('unknown')
    router.markExhausted(`${CLAUDE}@acc_2`, { reason: 'quota', source: 'structured-error', now: NOW })
    expect(isCandidateAdmissible(candidate, { router, accountChainOf: pool, now: NOW })).toBe(true)
    router.markExhausted(CLAUDE, { reason: 'quota', source: 'structured-error', now: NOW })
    expect(isCandidateAdmissible(candidate, { router, accountChainOf: pool, now: NOW })).toBe(false)
  })

  it('orders by context fit after an overflow', async () => {
    const candidates: ModelCandidate[] = [
      { providerId: 'a', modelId: 'small' },
      { providerId: 'b', modelId: 'unknown' },
      { providerId: 'c', modelId: 'large' },
    ]
    const windows: Record<string, number> = { small: 32_000, large: 1_000_000 }
    const ordered = await orderByContextFit(candidates, 200_001, async (c) => windows[c.modelId])
    expect(ordered.map((c) => c.modelId)).toEqual(['large', 'unknown', 'small'])
    const overflow = classifyModelFailure(
      Object.assign(new Error('prompt is too long: 210000 tokens > 200000 maximum'), { statusCode: 400 })
    )
    expect(requiredTokensAfterOverflow(overflow)).toBe(210_000)
    expect(requiredTokensAfterOverflow({}, 128_000)).toBe(128_001)
    const next = await selectNextCandidate({
      router,
      accountChainOf,
      chain: candidates,
      attempted: new Set([modelCircuitKey('a', 'small')]),
      requiredTokens: 210_000,
      windowOf: async (c) => windows[c.modelId],
      now: NOW,
    })
    expect(next?.modelId).toBe('large')
  })
})

describe('runWithModelFallback', () => {
  const router = new SubscriptionFailoverRouter()
  afterEach(() => {
    router.reset()
    resetStickyWinnersForTests()
  })
  const deps = {
    config: () => config,
    router: () => router,
    accountChainOf: () => [],
    isProviderUsable: () => true,
    now: () => NOW,
  }

  it('moves to the next model on quota and records the switch', async () => {
    const calls: string[] = []
    const switches: string[] = []
    const result = await runWithModelFallback({
      primary: { providerId: 'anthropic', modelId: 'opus' },
      scope: 'helper:test',
      deps,
      run: async (candidate) => {
        calls.push(candidate.modelId)
        if (candidate.primary) throw quota429()
        return `ok:${candidate.modelId}:${candidate.reasoning ?? ''}`
      },
      onSwitch: ({ from, to, classification }) =>
        switches.push(`${from.modelId}->${to.modelId}:${classification.reason}`),
    })
    expect(result).toBe('ok:gpt-5:high')
    expect(calls).toEqual(['opus', 'gpt-5'])
    expect(switches).toEqual(['opus->gpt-5:quota'])
    expect(stickyWinner('helper:test', { providerId: 'anthropic', modelId: 'opus' }, NOW)).toEqual({
      providerId: 'openai',
      modelId: 'gpt-5',
    })
  })

  it('does not fall back on a rejected request or after a veto', async () => {
    const rejected = Object.assign(new Error('content_policy_violation'), { statusCode: 400 })
    await expect(
      runWithModelFallback({
        primary: { providerId: 'anthropic', modelId: 'opus' },
        scope: 'helper:test',
        deps,
        run: async () => {
          throw rejected
        },
      })
    ).rejects.toBe(rejected)
    const calls: string[] = []
    await expect(
      runWithModelFallback({
        primary: { providerId: 'anthropic', modelId: 'opus' },
        scope: 'helper:test',
        deps,
        canFallback: () => false,
        run: async (candidate) => {
          calls.push(candidate.modelId)
          throw quota429()
        },
      })
    ).rejects.toThrow('quota')
    expect(calls).toEqual(['opus'])
  })

  it('starts on the first admissible candidate when the primary is cooling down', async () => {
    router.recordFailure('anthropic', { kind: 'billing', reason: 'credits', now: NOW })
    const calls: string[] = []
    await runWithModelFallback({
      primary: { providerId: 'anthropic', modelId: 'opus' },
      scope: 'helper:test',
      deps,
      run: async (candidate) => {
        calls.push(candidate.modelId)
        return 'ok'
      },
    })
    expect(calls).toEqual(['gpt-5'])
  })

  it('throws the last error when every candidate fails', async () => {
    const calls: string[] = []
    await expect(
      runWithModelFallback({
        primary: { providerId: 'anthropic', modelId: 'opus' },
        scope: 'helper:test',
        deps,
        run: async (candidate) => {
          calls.push(candidate.modelId)
          throw Object.assign(new Error(`overloaded ${candidate.modelId}`), { statusCode: 529 })
        },
      })
    ).rejects.toThrow('overloaded qwen')
    expect(calls).toEqual(['opus', 'gpt-5', 'qwen'])
  })

  it('skips an unsuitable candidate without blaming it, and names the model that really failed', async () => {
    const calls: string[] = []
    const notices: string[] = []
    const result = await runWithModelFallback({
      primary: { providerId: 'anthropic', modelId: 'opus' },
      scope: 'helper:test',
      deps,
      run: async (candidate) => {
        calls.push(candidate.modelId)
        if (candidate.primary) throw quota429()
        if (candidate.modelId === 'gpt-5') throw new ModelCandidateUnsuitable()
        return candidate.modelId
      },
      onSwitch: ({ from, to }) => notices.push(`${from.modelId}->${to.modelId}`),
    })
    expect(result).toBe('qwen')
    expect(calls).toEqual(['opus', 'gpt-5', 'qwen'])
    expect(notices).toEqual(['opus->gpt-5', 'opus->qwen'])
    expect(router.isAdmissible(modelCircuitKey('openai', 'gpt-5'), NOW)).toBe(true)
  })

  it('runs a helper fallback with the effort configured for it', async () => {
    const seen: unknown[] = []
    await runHelperWithModelFallback({
      selection: { providerId: 'anthropic', modelId: 'opus', effort: 'max' },
      agent: 'memory-extraction',
      deps,
      run: async (selection) => {
        seen.push(selection)
        if (selection.providerId === 'anthropic') throw quota429()
        return 'ok'
      },
    })
    expect(seen).toEqual([
      { providerId: 'anthropic', modelId: 'opus', effort: 'max' },
      { providerId: 'openai', modelId: 'gpt-5', effort: 'high' },
    ])
  })

  it('runs only the primary when strict', async () => {
    const calls: string[] = []
    await expect(
      runWithModelFallback({
        primary: { providerId: 'anthropic', modelId: 'opus' },
        scope: 'helper:test',
        strict: true,
        deps,
        run: async (candidate) => {
          calls.push(candidate.modelId)
          throw quota429()
        },
      })
    ).rejects.toThrow()
    expect(calls).toEqual(['opus'])
  })
})
