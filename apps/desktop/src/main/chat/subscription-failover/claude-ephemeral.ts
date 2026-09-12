import type { ChatSubscriptionFailoverEvent } from '../../../shared/chat'
import type { NormalizedAiUsage } from '../runner'
import { classifyClaudeQuotaFailure, type ClaudeQuotaClassification } from '../claude-agent-sdk/quota-error'
import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk'
import { freezeFailoverChain } from './config'
import { resolveClaudeRuntimeTarget, settleClaudeAttempt, type ClaudeRuntimeTarget } from './claude-adapter'
import { beginClaudeAttempt } from './claude-attempts'
import { redactClaudeCredentials } from '../claude-agent-sdk/errors'

export class ClaudeAccountsExhaustedError extends Error {
  readonly code = 'claude-accounts-exhausted'
  constructor(
    message: string,
    readonly resetsAt?: number | null
  ) {
    super(message)
    this.name = 'ClaudeAccountsExhaustedError'
  }
}
export class ClaudeRuntimeUnavailableError extends Error {
  readonly code = 'claude-runtime-unavailable'
  constructor(
    readonly reason: 'not-authenticated' | 'incompatible' | 'unavailable',
    message: string
  ) {
    super(message)
    this.name = 'ClaudeRuntimeUnavailableError'
  }
}
export interface RunClaudeEphemeralWithFailoverArgs<T> {
  logicalProviderId: string
  modelId: string
  runtimeModelId?: string
  reasoningEffort?: string
  fastMode?: boolean
  chain?: readonly string[]
  signal: AbortSignal
  conversationId?: string
  operation: (target: ClaudeRuntimeTarget, signal: AbortSignal) => Promise<T>
  extractAttemptUsage?: (value: unknown) => NormalizedAiUsage | undefined
  mergeAttemptUsage?: (result: T, failedUsage: NormalizedAiUsage) => T
  /** Cost is independent of token availability; merges only failed physical attempts. */
  mergeAttemptCost?: (result: T, failedCostUsd: number) => T
  onAttemptUsage?: (info: {
    target: ClaudeRuntimeTarget
    attempt: number
    usage: NormalizedAiUsage
    outcome: 'success' | 'failed'
    runtimeEstimatedCostUsd?: number
  }) => void
  onFailoverTransition?: (event: ChatSubscriptionFailoverEvent) => void
}

const zeroUsage = (): NormalizedAiUsage => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0, totalInput: 0 })
function cost(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined
  const measured = value as { runtimeEstimatedCostUsd?: unknown; partialRuntimeEstimatedCostUsd?: unknown }
  const amount = measured.runtimeEstimatedCostUsd ?? measured.partialRuntimeEstimatedCostUsd
  return typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 ? amount : undefined
}

/** Finite, identity-owned helper attempts; only confirmed subscription quota advances the chain. */
export async function runClaudeEphemeralWithFailover<T>(args: RunClaudeEphemeralWithFailoverArgs<T>): Promise<T> {
  const chain = Object.freeze([...new Set(args.chain ?? freezeFailoverChain(args.logicalProviderId))])
  const attemptedProviderIds = new Set<string>()
  const controller = new AbortController()
  const signal = AbortSignal.any([args.signal, controller.signal])
  let frozen: ClaudeRuntimeTarget | undefined
  let previous: { providerId: string; info: Extract<ClaudeQuotaClassification, { kind: 'quota' }>['info'] } | undefined
  let failedUsage: NormalizedAiUsage | undefined
  let failedCost: number | undefined
  let totalUsage: NormalizedAiUsage | undefined
  let totalCost: number | undefined
  let costsComplete = true
  try {
    while (true) {
      signal.throwIfAborted()
      const resolved = await resolveClaudeRuntimeTarget({
        logicalProviderId: args.logicalProviderId,
        modelId: args.modelId,
        runtimeModelId: frozen?.runtimeModelId ?? args.runtimeModelId,
        reasoningEffort: frozen ? frozen.reasoningEffort : args.reasoningEffort,
        fastMode: frozen ? frozen.fastMode : args.fastMode,
        chain,
        attemptedProviderIds,
        signal,
      })
      if (!resolved.ok) {
        signal.throwIfAborted()
        if (resolved.error === 'aborted') throw new Error(resolved.message)
        if (resolved.reason === 'quota-exhausted')
          throw new ClaudeAccountsExhaustedError(resolved.message, resolved.resetsAt)
        throw new ClaudeRuntimeUnavailableError(resolved.reason, resolved.message)
      }
      const target = frozen ? { ...resolved.target, maestrlyUltra: frozen.maestrlyUltra } : resolved.target
      if (!chain.includes(target.providerId) || attemptedProviderIds.has(target.providerId)) {
        settleClaudeAttempt(target, 'other')
        throw new ClaudeRuntimeUnavailableError(
          'unavailable',
          'Claude helper returned an account outside the remaining route.'
        )
      }
      frozen ??= target
      attemptedProviderIds.add(target.providerId)
      let outcome: 'success' | 'quota' | 'other' = 'other'
      let quotaInfo: Extract<ClaudeQuotaClassification, { kind: 'quota' }>['info'] | undefined
      let ownership: ReturnType<typeof beginClaudeAttempt> | undefined
      const observe = (value: unknown, status: 'success' | 'failed') => {
        const usage = args.extractAttemptUsage?.(value)
        const amount = cost(value)
        if (usage) {
          totalUsage ??= zeroUsage()
          for (const key of ['input', 'output', 'cacheRead', 'cacheCreate', 'totalInput'] as const)
            totalUsage[key] += usage[key]
          if (amount === undefined) costsComplete = false
        }
        if (amount !== undefined) totalCost = (totalCost ?? 0) + amount
        if (usage || amount !== undefined)
          args.onAttemptUsage?.({
            target,
            attempt: attemptedProviderIds.size,
            usage: usage ?? zeroUsage(),
            outcome: status,
            ...(amount === undefined ? {} : { runtimeEstimatedCostUsd: amount }),
          })
        if (status === 'failed') {
          if (usage) {
            failedUsage ??= zeroUsage()
            for (const key of Object.keys(failedUsage) as (keyof NormalizedAiUsage)[]) failedUsage[key] += usage[key]
          }
          if (amount !== undefined) failedCost = (failedCost ?? 0) + amount
        }
      }
      try {
        ownership = beginClaudeAttempt({
          providerId: target.providerId,
          accountIdentity: target.accountIdentity,
          scope: 'helper',
          conversationId: args.conversationId,
          abort: (reason) => controller.abort(reason),
        })
        signal.throwIfAborted()
        target.manager.assertAccountIdentity(target.accountIdentity)
        if (previous) {
          const event: ChatSubscriptionFailoverEvent = {
            scope: 'helper',
            fromProviderId: previous.providerId,
            toProviderId: target.providerId,
            reason: previous.info.reason,
            resetsAt: previous.info.resetsAt,
          }
          if (args.onFailoverTransition) args.onFailoverTransition(event)
          else if (args.conversationId) {
            const { emitSubscriptionFailoverEvent } = await import('./ephemeral')
            emitSubscriptionFailoverEvent(args.conversationId, event)
          }
        }
        signal.throwIfAborted()
        let result: T
        try {
          result = await args.operation(target, signal)
        } catch (error) {
          observe(error, 'failed')
          signal.throwIfAborted()
          target.manager.assertAccountIdentity(target.accountIdentity)
          const detail = error as {
            rawFailure?: unknown
            rateLimitInfo?: SDKRateLimitInfo
            quotaClassification?: ClaudeQuotaClassification
          } | null
          const classification =
            detail?.quotaClassification ??
            classifyClaudeQuotaFailure(detail?.rawFailure ?? error, detail?.rateLimitInfo)
          if (classification.kind !== 'quota') throw error
          outcome = 'quota'
          quotaInfo = classification.info
          previous = { providerId: target.providerId, info: classification.info }
          continue
        }
        observe(result, 'success')
        signal.throwIfAborted()
        target.manager.assertAccountIdentity(target.accountIdentity)
        outcome = 'success'
        if (failedUsage && args.mergeAttemptUsage) result = args.mergeAttemptUsage(result, failedUsage)
        if (!costsComplete && result && typeof result === 'object') {
          const unpriced = { ...result } as T & { runtimeEstimatedCostUsd?: number }
          delete unpriced.runtimeEstimatedCostUsd
          result = unpriced
        } else if (failedCost !== undefined) {
          if (args.mergeAttemptCost) result = args.mergeAttemptCost(result, failedCost)
          else if (result && typeof result === 'object' && cost(result) !== undefined)
            result = { ...result, runtimeEstimatedCostUsd: cost(result)! + failedCost }
        }
        return result
      } finally {
        try {
          settleClaudeAttempt(target, outcome, quotaInfo)
        } finally {
          ownership?.release()
        }
      }
    }
  } catch (error) {
    // Never mutate AbortSignal.reason or another caller's shared error object.
    const failure = new Error(redactClaudeCredentials(error instanceof Error ? error.message : String(error)), {
      cause: error,
    })
    if (error instanceof Error) {
      Object.setPrototypeOf(failure, Object.getPrototypeOf(error))
      Object.assign(failure, error)
      failure.name = error.name
    }
    if (totalUsage) Object.assign(failure, { partialUsage: totalUsage })
    delete (failure as { partialRuntimeEstimatedCostUsd?: number }).partialRuntimeEstimatedCostUsd
    if (costsComplete && totalCost !== undefined) Object.assign(failure, { runtimeEstimatedCostUsd: totalCost })
    else delete (failure as { runtimeEstimatedCostUsd?: number }).runtimeEstimatedCostUsd
    throw failure
  }
}
