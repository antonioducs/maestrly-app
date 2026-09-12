import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  app: { isPackaged: false },
  ensureRuntimeAsset: vi.fn(),
  freezeFailoverChain: vi.fn(),
  resolveCodexRuntimeTarget: vi.fn(),
  classifyCodexQuotaFailure: vi.fn(),
  classifyCodexQuotaFailureWithRateLimits: vi.fn(),
  getSubscriptionFailoverRouter: vi.fn(),
  getMainWebContents: vi.fn(() => null),
  chatDiag: vi.fn(),
  getCodexSubscriptionManager: vi.fn(),
  subscriptionAccountId: vi.fn((id: string) => {
    const at = id.indexOf('@')
    return at >= 0 ? id.slice(at + 1) : null
  }),
}))

vi.mock('electron', () => ({ app: h.app }))
vi.mock('../../src/main/runtime-assets/app-service', () => ({
  ensureRuntimeAsset: h.ensureRuntimeAsset,
}))
vi.mock('../../src/main/chat/diag-log', () => ({ chatDiag: h.chatDiag }))
vi.mock('../../src/main/window-ipc', () => ({ getMainWebContents: h.getMainWebContents }))
vi.mock('../../src/main/chat/subscription-failover/config', () => ({
  freezeFailoverChain: h.freezeFailoverChain,
}))
vi.mock('../../src/main/chat/subscription-failover/codex-adapter', () => ({
  resolveCodexRuntimeTarget: h.resolveCodexRuntimeTarget,
}))
vi.mock('../../src/main/chat/subscription-failover/router', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/chat/subscription-failover/router')>()
  return {
    ...original,
    getSubscriptionFailoverRouter: h.getSubscriptionFailoverRouter,
  }
})
vi.mock('../../src/main/chat/codex-subscription/quota-error', () => ({
  classifyCodexQuotaFailure: h.classifyCodexQuotaFailure,
  classifyCodexQuotaFailureWithRateLimits: h.classifyCodexQuotaFailureWithRateLimits,
}))
vi.mock('../../src/main/chat/catalog', () => ({
  subscriptionAccountId: h.subscriptionAccountId,
  isCodexSubscriptionProvider: (id: string) => id.startsWith('builtin_codex'),
  getProvider: (id: string) => ({ id }),
}))
vi.mock('../../src/main/chat/codex-subscription/manager', () => ({
  getCodexSubscriptionManager: h.getCodexSubscriptionManager,
}))

import {
  CodexAccountsExhaustedError,
  CodexRuntimeUnavailableError,
  listCodexEphemeralAttempts,
  resetSubscriptionFailoverRouterForTests,
  runCodexEphemeralWithFailover,
  setCodexEphemeralAttemptOwner,
} from '../../src/main/chat/subscription-failover'

const PRIMARY = 'builtin_codex_subscription'
const FALLBACK = 'builtin_codex_subscription@acc_b'

function target(
  providerId: string,
  accountId: string | null,
  availabilityLease?: { leaseId: string; generation: number }
) {
  return {
    providerId,
    accountId,
    manager: {
      getRateLimits: vi.fn(async () => null),
    },
    client: { id: `client_${providerId}` },
    model: { id: 'gpt-5.6-mini' },
    runtimeModelId: 'gpt-5.6-mini',
    serviceTier: null,
    dropImages: false,
    ...(availabilityLease ? { availabilityLease } : {}),
  }
}

beforeEach(() => {
  h.app.isPackaged = false
  h.ensureRuntimeAsset.mockReset()
  h.ensureRuntimeAsset.mockResolvedValue({ state: 'ready', path: '/runtime' })
  setCodexEphemeralAttemptOwner(null)
  resetSubscriptionFailoverRouterForTests()
  const router = {
    markExhausted: vi.fn(),
    confirmAttemptQuota: vi.fn(),
    confirmAttemptSuccess: vi.fn(),
    confirmAttemptOther: vi.fn(),
    isAdmissible: vi.fn(() => true),
    getHealth: vi.fn(() => ({ providerId: PRIMARY, state: 'unknown' })),
  }
  h.getSubscriptionFailoverRouter.mockReturnValue(router)
  h.freezeFailoverChain.mockReturnValue([PRIMARY, FALLBACK])
  h.classifyCodexQuotaFailure.mockReset()
  h.classifyCodexQuotaFailureWithRateLimits.mockReset()
  h.classifyCodexQuotaFailureWithRateLimits.mockImplementation(async (error: unknown) =>
    h.classifyCodexQuotaFailure(error)
  )
  h.resolveCodexRuntimeTarget.mockReset()
})

afterEach(() => {
  setCodexEphemeralAttemptOwner(null)
  resetSubscriptionFailoverRouterForTests()
})

describe('runCodexEphemeralWithFailover', () => {
  it('installs missing runtime on explicit first use before account resolution', async () => {
    h.app.isPackaged = true
    const events: string[] = []
    let runtimeReady = false
    h.ensureRuntimeAsset.mockImplementation(async () => {
      events.push('ensure-runtime')
      expect(runtimeReady).toBe(false)
      runtimeReady = true
      return { state: 'ready', path: '/runtime' }
    })
    const primary = target(PRIMARY, null)
    h.resolveCodexRuntimeTarget.mockImplementation(async () => {
      events.push('resolve-target')
      expect(runtimeReady).toBe(true)
      return { ok: true, target: primary }
    })

    await expect(
      runCodexEphemeralWithFailover({
        logicalProviderId: PRIMARY,
        modelId: 'gpt-5.6-mini',
        operation: async () => 'generated',
      })
    ).resolves.toBe('generated')

    expect(events).toEqual(['ensure-runtime', 'resolve-target'])
    expect(h.ensureRuntimeAsset).toHaveBeenCalledWith('codex-runtime', expect.any(AbortSignal))
  })

  it('revalidates ready runtimes before execution', async () => {
    h.app.isPackaged = true
    const primary = target(PRIMARY, null)
    h.resolveCodexRuntimeTarget.mockResolvedValue({ ok: true, target: primary })

    await expect(
      runCodexEphemeralWithFailover({
        logicalProviderId: PRIMARY,
        modelId: 'gpt-5.6-mini',
        operation: async () => 'runtime-ready',
      })
    ).resolves.toBe('runtime-ready')

    expect(h.ensureRuntimeAsset).toHaveBeenCalledOnce()
    expect(h.ensureRuntimeAsset).toHaveBeenCalledWith('codex-runtime', expect.any(AbortSignal))
  })

  it('preserves authentication errors after runtime preparation', async () => {
    h.app.isPackaged = true
    h.resolveCodexRuntimeTarget.mockResolvedValue({
      ok: false,
      error: 'no-eligible-account',
      reason: 'not-authenticated',
      message: 'Connect your ChatGPT (Codex) account in Maestrly settings to continue.',
    })
    const operation = vi.fn()

    const error = await runCodexEphemeralWithFailover({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.6-mini',
      operation,
    }).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(CodexRuntimeUnavailableError)
    expect(error).toMatchObject({ reason: 'not-authenticated' })
    expect(operation).not.toHaveBeenCalled()
    expect(h.ensureRuntimeAsset).toHaveBeenCalledWith('codex-runtime', expect.any(AbortSignal))
  })

  it('retries on confirmed quota and confirms success on the fallback', async () => {
    const primary = target(PRIMARY, null)
    const fallback = target(FALLBACK, 'acc_b')
    h.resolveCodexRuntimeTarget
      .mockResolvedValueOnce({ ok: true, target: primary })
      .mockResolvedValueOnce({ ok: true, target: fallback })
    h.classifyCodexQuotaFailure.mockReturnValue({
      kind: 'quota',
      confidence: 'strong-marker',
      message: 'UsageLimitExceeded',
    })

    const operation = vi.fn().mockRejectedValueOnce(new Error('UsageLimitExceeded')).mockResolvedValueOnce('ok-from-b')
    const onFailoverTransition = vi.fn()

    await expect(
      runCodexEphemeralWithFailover({
        logicalProviderId: PRIMARY,
        modelId: 'gpt-5.6-mini',
        operation,
        onFailoverTransition,
      })
    ).resolves.toBe('ok-from-b')

    expect(operation).toHaveBeenCalledTimes(2)
    expect(h.getSubscriptionFailoverRouter().confirmAttemptQuota).toHaveBeenCalledWith(
      PRIMARY,
      undefined,
      expect.objectContaining({ reason: 'UsageLimitExceeded' })
    )
    expect(onFailoverTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'helper',
        fromProviderId: PRIMARY,
        toProviderId: FALLBACK,
      })
    )
    expect(h.getSubscriptionFailoverRouter().confirmAttemptSuccess).toHaveBeenCalledWith(FALLBACK, undefined)
  })

  it('carries failed-attempt usage into the winner exactly once through optional hooks', async () => {
    const primary = target(PRIMARY, null)
    const fallback = target(FALLBACK, 'acc_b')
    h.resolveCodexRuntimeTarget
      .mockResolvedValueOnce({ ok: true, target: primary })
      .mockResolvedValueOnce({ ok: true, target: fallback })
    h.classifyCodexQuotaFailure.mockReturnValue({
      kind: 'quota',
      confidence: 'strong-marker',
      message: 'UsageLimitExceeded',
    })

    const failedUsage = { input: 60, output: 7, cacheRead: 40, cacheCreate: 0, totalInput: 100 }
    const winningUsage = { input: 90, output: 11, cacheRead: 50, cacheCreate: 0, totalInput: 140 }
    const observed: Array<{ providerId: string; attempt: number; outcome: string; usage: typeof failedUsage }> = []
    const operation = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('UsageLimitExceeded'), { partialUsage: failedUsage }))
      .mockResolvedValueOnce({ text: 'ok-from-b', usage: winningUsage })

    const result = await runCodexEphemeralWithFailover<{
      text: string
      usage: typeof winningUsage
    }>({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.6-mini',
      operation,
      extractAttemptUsage: (value) => {
        if (value instanceof Error) return (value as Error & { partialUsage?: typeof failedUsage }).partialUsage
        return (value as { usage?: typeof winningUsage }).usage
      },
      onAttemptUsage: ({ target: resolvedTarget, attempt, outcome, usage }) =>
        observed.push({ providerId: resolvedTarget.providerId, attempt, outcome, usage }),
      mergeAttemptUsage: (winner, partial) => ({
        ...winner,
        usage: {
          input: winner.usage.input + partial.input,
          output: winner.usage.output + partial.output,
          cacheRead: winner.usage.cacheRead + partial.cacheRead,
          cacheCreate: winner.usage.cacheCreate + partial.cacheCreate,
          totalInput: winner.usage.totalInput + partial.totalInput,
        },
      }),
    })

    expect(result).toEqual({
      text: 'ok-from-b',
      usage: { input: 150, output: 18, cacheRead: 90, cacheCreate: 0, totalInput: 240 },
    })
    expect(observed).toEqual([
      { providerId: PRIMARY, attempt: 1, outcome: 'failed', usage: failedUsage },
      { providerId: FALLBACK, attempt: 2, outcome: 'success', usage: winningUsage },
    ])
  })

  it('does not rotate on non-quota errors', async () => {
    const primary = target(PRIMARY, null)
    h.resolveCodexRuntimeTarget.mockResolvedValue({ ok: true, target: primary })
    h.classifyCodexQuotaFailure.mockReturnValue({
      kind: 'not-quota',
      reason: 'network',
      message: 'socket hang up',
    })
    const operation = vi.fn().mockRejectedValue(new Error('socket hang up'))

    await expect(
      runCodexEphemeralWithFailover({
        logicalProviderId: PRIMARY,
        modelId: 'gpt-5.6-mini',
        operation,
      })
    ).rejects.toThrow(/socket hang up/)

    expect(operation).toHaveBeenCalledOnce()
    expect(h.getSubscriptionFailoverRouter().markExhausted).not.toHaveBeenCalled()
  })

  it('settles a half-open lease on a non-quota error', async () => {
    const lease = { leaseId: 'probe-1', generation: 2 }
    const primary = target(PRIMARY, null, lease)
    h.resolveCodexRuntimeTarget.mockResolvedValue({ ok: true, target: primary })
    h.classifyCodexQuotaFailure.mockReturnValue({
      kind: 'not-quota',
      reason: 'network',
      message: 'socket hang up',
    })

    await expect(
      runCodexEphemeralWithFailover({
        logicalProviderId: PRIMARY,
        modelId: 'gpt-5.6-mini',
        operation: async () => {
          throw new Error('socket hang up')
        },
      })
    ).rejects.toThrow(/socket hang up/)

    expect(h.getSubscriptionFailoverRouter().confirmAttemptOther).toHaveBeenCalledOnce()
    expect(h.getSubscriptionFailoverRouter().confirmAttemptOther).toHaveBeenCalledWith(PRIMARY, lease)
  })

  it('forwards the explicit per-candidate model resolver to the target adapter', async () => {
    const primary = target(PRIMARY, null)
    h.resolveCodexRuntimeTarget.mockResolvedValue({ ok: true, target: primary })
    const resolveModelId = vi.fn(async () => 'gpt-5.6-default')

    await expect(
      runCodexEphemeralWithFailover({
        logicalProviderId: PRIMARY,
        modelId: 'gpt-5.6-mini',
        resolveModelId,
        operation: async (resolvedTarget) => resolvedTarget.runtimeModelId,
      })
    ).resolves.toBe('gpt-5.6-mini')

    expect(h.resolveCodexRuntimeTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'gpt-5.6-mini',
        resolveModelId,
      })
    )
  })

  it('throws CodexAccountsExhaustedError when the chain is spent', async () => {
    h.resolveCodexRuntimeTarget.mockResolvedValue({
      ok: false,
      error: 'no-eligible-account',
      reason: 'quota-exhausted',
      message: 'All Codex subscription accounts in the failover chain are exhausted. Try again later.',
    })

    await expect(
      runCodexEphemeralWithFailover({
        logicalProviderId: PRIMARY,
        modelId: 'gpt-5.6-mini',
        operation: async () => 'never',
      })
    ).rejects.toBeInstanceOf(CodexAccountsExhaustedError)
  })

  it('preserves a disconnected resolution as a non-quota helper error', async () => {
    h.resolveCodexRuntimeTarget.mockResolvedValue({
      ok: false,
      error: 'no-eligible-account',
      reason: 'not-authenticated',
      message: 'Connect your ChatGPT (Codex) account in Maestrly settings to continue.',
    })

    const error = await runCodexEphemeralWithFailover({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.6-mini',
      operation: async () => 'never',
    }).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(CodexRuntimeUnavailableError)
    expect(error).toMatchObject({ reason: 'not-authenticated' })
    expect(error).not.toBeInstanceOf(CodexAccountsExhaustedError)
  })

  it('preserves an unavailable resolution without an exhausted error', async () => {
    h.resolveCodexRuntimeTarget.mockResolvedValue({
      ok: false,
      error: 'no-eligible-account',
      reason: 'unavailable',
      message: 'No eligible Codex subscription account is currently available.',
    })

    const error = await runCodexEphemeralWithFailover({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.6-mini',
      operation: async () => 'never',
    }).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(CodexRuntimeUnavailableError)
    expect(error).toMatchObject({ reason: 'unavailable' })
    expect(error).not.toBeInstanceOf(CodexAccountsExhaustedError)
  })

  it('owns and releases each physical helper attempt exactly once, including quota cleanup', async () => {
    const primary = target(PRIMARY, null)
    const fallback = target(FALLBACK, 'acc_b')
    h.resolveCodexRuntimeTarget
      .mockResolvedValueOnce({ ok: true, target: primary })
      .mockResolvedValueOnce({ ok: true, target: fallback })
    h.classifyCodexQuotaFailure.mockReturnValue({
      kind: 'quota',
      confidence: 'strong-marker',
      message: 'UsageLimitExceeded',
    })

    const releases: string[] = []
    setCodexEphemeralAttemptOwner((attempt) => {
      releases.push(`acquire:${attempt.providerId}`)
      return () => releases.push(`release:${attempt.providerId}`)
    })
    const cleanupAttempt = vi.fn(async () => {})

    await runCodexEphemeralWithFailover({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.6-mini',
      conversationId: 'conv-helper',
      cleanupAttempt,
      operation: vi.fn().mockRejectedValueOnce(new Error('UsageLimitExceeded')).mockResolvedValueOnce('ok-from-b'),
    })

    expect(releases).toEqual([`acquire:${PRIMARY}`, `release:${PRIMARY}`, `acquire:${FALLBACK}`, `release:${FALLBACK}`])
    expect(cleanupAttempt).toHaveBeenCalledOnce()
    expect(listCodexEphemeralAttempts()).toHaveLength(0)
  })

  it('keeps an attempt in the registry until its helper operation finishes', async () => {
    const primary = target(PRIMARY, null)
    h.resolveCodexRuntimeTarget.mockResolvedValue({ ok: true, target: primary })
    let releaseOperation!: () => void
    const running = runCodexEphemeralWithFailover({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.6-mini',
      conversationId: 'conv-running-helper',
      operation: () =>
        new Promise<string>((resolve) => {
          releaseOperation = () => resolve('done')
        }),
    })

    await vi.waitFor(() => {
      expect(listCodexEphemeralAttempts()).toEqual([
        expect.objectContaining({ conversationId: 'conv-running-helper', providerId: PRIMARY }),
      ])
    })
    releaseOperation()
    await expect(running).resolves.toBe('done')
    expect(listCodexEphemeralAttempts()).toHaveLength(0)
  })

  it('combines the caller signal and lets teardown abort one physical attempt exactly once', async () => {
    const primary = target(PRIMARY, null)
    h.resolveCodexRuntimeTarget.mockResolvedValue({ ok: true, target: primary })
    const callerController = new AbortController()
    let registeredAttempt: ReturnType<typeof listCodexEphemeralAttempts>[number] | undefined
    let releaseCount = 0
    setCodexEphemeralAttemptOwner((attempt) => {
      registeredAttempt = attempt as ReturnType<typeof listCodexEphemeralAttempts>[number]
      return () => {
        releaseCount += 1
      }
    })

    const running = runCodexEphemeralWithFailover({
      logicalProviderId: PRIMARY,
      modelId: 'gpt-5.6-mini',
      signal: callerController.signal,
      operation: (_target, signal) =>
        new Promise<string>((_resolve, reject) => {
          const onAbort = () => reject(signal.reason ?? new Error('attempt aborted'))
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        }),
    })

    await vi.waitFor(() => expect(registeredAttempt).toBeDefined())
    expect(registeredAttempt?.signal).not.toBe(callerController.signal)
    expect(registeredAttempt?.signal.aborted).toBe(false)

    registeredAttempt?.abort(new Error('physical account reset'))
    await expect(running).rejects.toThrow('physical account reset')
    expect(releaseCount).toBe(1)
    expect(listCodexEphemeralAttempts()).toHaveLength(0)
  })
})
