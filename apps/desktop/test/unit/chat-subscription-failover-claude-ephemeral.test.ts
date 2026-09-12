import { beforeEach, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ resolve: vi.fn(), settle: vi.fn(), release: vi.fn(), begin: vi.fn() }))
vi.mock('../../src/main/chat/subscription-failover/claude-adapter', () => ({
  resolveClaudeRuntimeTarget: h.resolve,
  settleClaudeAttempt: h.settle,
}))
vi.mock('../../src/main/chat/subscription-failover/config', () => ({ freezeFailoverChain: () => ['a', 'b'] }))
vi.mock('../../src/main/chat/subscription-failover/claude-attempts', () => ({ beginClaudeAttempt: h.begin }))
import {
  runClaudeEphemeralWithFailover,
  ClaudeRuntimeUnavailableError,
} from '../../src/main/chat/subscription-failover/claude-ephemeral'
const usage = { input: 2, output: 3, cacheRead: 0, cacheCreate: 0, totalInput: 2 }
const target = (providerId: string) => ({
  providerId,
  accountIdentity: { fingerprint: providerId, epoch: 1 },
  manager: { assertAccountIdentity: vi.fn() },
  runtimeModelId: 'resolved',
  reasoningEffort: 'high',
  fastMode: true,
})
beforeEach(() => {
  vi.clearAllMocks()
  h.resolve.mockReset()
  h.begin.mockReturnValue({ release: h.release })
  h.resolve
    .mockResolvedValueOnce({ ok: true, target: target('a') })
    .mockResolvedValueOnce({ ok: true, target: target('b') })
})
it('counts failed and successful usage and native cost once, freezing execution axes', async () => {
  const observe = vi.fn()
  const operation = vi
    .fn()
    .mockRejectedValueOnce(
      Object.assign(new Error("You've hit your limit"), { partialUsage: usage, runtimeEstimatedCostUsd: 0.2 })
    )
    .mockResolvedValueOnce({ usage, runtimeEstimatedCostUsd: 0.3 })
  const result = await runClaudeEphemeralWithFailover<{ usage: typeof usage; runtimeEstimatedCostUsd: number }>({
    logicalProviderId: 'a',
    modelId: 'alias',
    signal: new AbortController().signal,
    operation,
    extractAttemptUsage: (v: any) => v.partialUsage ?? v.usage,
    mergeAttemptUsage: (v, failed) => ({ ...v, usage: { ...v.usage, output: v.usage.output + failed.output } }),
    onAttemptUsage: observe,
  })
  expect(result.usage.output).toBe(6)
  expect(result.runtimeEstimatedCostUsd).toBe(0.5)
  expect(observe).toHaveBeenCalledTimes(2)
  expect(h.release).toHaveBeenCalledTimes(2)
  expect(h.settle.mock.calls.map((c) => c[1])).toEqual(['quota', 'success'])
  expect(h.resolve.mock.calls[1][0]).toMatchObject({
    runtimeModelId: 'resolved',
    reasoningEffort: 'high',
    fastMode: true,
  })
})
it('does not rotate generic throttling', async () => {
  const operation = vi.fn().mockRejectedValue(Object.assign(new Error('429'), { status: 429 }))
  await expect(
    runClaudeEphemeralWithFailover({
      logicalProviderId: 'a',
      modelId: 'm',
      signal: new AbortController().signal,
      operation,
    })
  ).rejects.toThrow('429')
  expect(operation).toHaveBeenCalledTimes(1)
  expect(h.settle).toHaveBeenCalledWith(expect.anything(), 'other', undefined)
})
it('stops before B when cancelled during A', async () => {
  const controller = new AbortController()
  const operation = vi.fn(async () => {
    controller.abort(new Error('stop'))
    throw new Error("You've hit your limit")
  })
  await expect(
    runClaudeEphemeralWithFailover({ logicalProviderId: 'a', modelId: 'm', signal: controller.signal, operation })
  ).rejects.toThrow('stop')
  expect(h.resolve).toHaveBeenCalledTimes(1)
  expect(h.release).toHaveBeenCalledTimes(1)
})
it('rejects an identity changed during the operation without rotating', async () => {
  const operation = vi.fn(async (t) => {
    t.manager.assertAccountIdentity.mockImplementation(() => {
      throw new Error('changed')
    })
    throw new Error("You've hit your limit")
  })
  await expect(
    runClaudeEphemeralWithFailover({
      logicalProviderId: 'a',
      modelId: 'm',
      signal: new AbortController().signal,
      operation,
    })
  ).rejects.toThrow('changed')
  expect(h.resolve).toHaveBeenCalledTimes(1)
})
it('keeps mixed resolution failures distinct from quota exhaustion', async () => {
  h.resolve
    .mockReset()
    .mockResolvedValue({ ok: false, error: 'no-eligible-account', reason: 'unavailable', message: 'mixed' })
  await expect(
    runClaudeEphemeralWithFailover({
      logicalProviderId: 'a',
      modelId: 'm',
      signal: new AbortController().signal,
      operation: vi.fn(),
    })
  ).rejects.toBeInstanceOf(ClaudeRuntimeUnavailableError)
})

it('does not publish a partial native estimate as the cost of all attempts', async () => {
  const operation = vi
    .fn()
    .mockRejectedValueOnce(Object.assign(new Error("You've hit your limit"), { partialUsage: usage }))
    .mockResolvedValueOnce({ usage, runtimeEstimatedCostUsd: 0.3 })
  const result = await runClaudeEphemeralWithFailover<{ usage: typeof usage; runtimeEstimatedCostUsd?: number }>({
    logicalProviderId: 'a',
    modelId: 'm',
    signal: new AbortController().signal,
    operation,
    extractAttemptUsage: (v: any) => v.partialUsage ?? v.usage,
    mergeAttemptUsage: (v, failed) => ({ ...v, usage: { ...v.usage, output: v.usage.output + failed.output } }),
  })
  expect(result.usage.output).toBe(6)
  expect(result).not.toHaveProperty('runtimeEstimatedCostUsd')
})
it('preserves all observed usage when a later attempt fails without quota', async () => {
  const lastFailure = Object.assign(new Error('network failure'), { partialUsage: usage, runtimeEstimatedCostUsd: 0.3 })
  const operation = vi
    .fn()
    .mockRejectedValueOnce(
      Object.assign(new Error("You've hit your limit"), { partialUsage: usage, runtimeEstimatedCostUsd: 0.2 })
    )
    .mockRejectedValueOnce(lastFailure)
  await expect(
    runClaudeEphemeralWithFailover({
      logicalProviderId: 'a',
      modelId: 'm',
      signal: new AbortController().signal,
      operation,
      extractAttemptUsage: (v: any) => v.partialUsage ?? v.usage,
    })
  ).rejects.toMatchObject({
    message: 'network failure',
    partialUsage: { input: 4, output: 6 },
    runtimeEstimatedCostUsd: 0.5,
  })
  expect(lastFailure.partialUsage).toEqual(usage)
  expect(lastFailure.runtimeEstimatedCostUsd).toBe(0.3)
})
it('preserves attempt usage in the all-accounts-exhausted error', async () => {
  h.resolve
    .mockReset()
    .mockResolvedValueOnce({ ok: true, target: target('a') })
    .mockResolvedValueOnce({
      ok: false,
      error: 'no-eligible-account',
      reason: 'quota-exhausted',
      message: 'all exhausted',
    })
  await expect(
    runClaudeEphemeralWithFailover({
      logicalProviderId: 'a',
      modelId: 'm',
      signal: new AbortController().signal,
      extractAttemptUsage: (v: any) => v.partialUsage,
      operation: vi.fn().mockRejectedValue(Object.assign(new Error("You've hit your limit"), { partialUsage: usage })),
    })
  ).rejects.toMatchObject({ code: 'claude-accounts-exhausted', partialUsage: usage })
})
it('bounds a resolver that repeats an already attempted account', async () => {
  h.resolve.mockReset().mockResolvedValue({ ok: true, target: target('a') })
  const operation = vi.fn().mockRejectedValue(new Error("You've hit your limit"))
  await expect(
    runClaudeEphemeralWithFailover({
      logicalProviderId: 'a',
      modelId: 'm',
      signal: new AbortController().signal,
      operation,
    })
  ).rejects.toBeInstanceOf(ClaudeRuntimeUnavailableError)
  expect(operation).toHaveBeenCalledOnce()
})
