import { getMainWebContents } from '../../window-ipc'
import { classifyCodexQuotaFailureWithRateLimits } from '../codex-subscription/quota-error'
import { subscriptionAccountId } from '../catalog'
import { getCodexSubscriptionManager } from '../codex-subscription/manager'
import type { NormalizedAiUsage } from '../runner'
import { failoverDiag } from './diag'
import { freezeFailoverChain } from './config'
import {
  resolveCodexRuntimeTarget,
  type CodexRuntimeTarget,
  type CodexRuntimeModelResolver,
  type CodexRuntimeResolutionFailureReason,
} from './codex-adapter'
import { getSubscriptionFailoverRouter } from './router'
import type { SubscriptionFailoverScope } from './types'
import { app } from 'electron'
import { ensureRuntimeAsset } from '../../runtime-assets/app-service'

export class CodexAccountsExhaustedError extends Error {
  readonly code = 'codex-accounts-exhausted' as const
  readonly resetsAt?: number | null

  constructor(message: string, resetsAt?: number | null) {
    super(message)
    this.name = 'CodexAccountsExhaustedError'
    if (resetsAt !== undefined) this.resetsAt = resetsAt
  }
}

/** Resolution failure that does not prove quota/circuit exhaustion. */
export class CodexRuntimeUnavailableError extends Error {
  readonly code = 'codex-runtime-unavailable' as const
  readonly reason: Exclude<CodexRuntimeResolutionFailureReason, 'quota-exhausted'>

  constructor(reason: Exclude<CodexRuntimeResolutionFailureReason, 'quota-exhausted'>, message: string) {
    super(message)
    this.name = 'CodexRuntimeUnavailableError'
    this.reason = reason
  }
}

export interface CodexEphemeralFailoverTransition {
  scope: SubscriptionFailoverScope
  fromProviderId: string
  toProviderId: string
  reason: string
  resetsAt?: number | null
}

export interface CodexEphemeralAttemptUsage {
  target: CodexRuntimeTarget
  attempt: number
  usage: NormalizedAiUsage
  outcome: 'success' | 'failed'
}

export interface RunCodexEphemeralWithFailoverArgs<T> {
  logicalProviderId: string
  modelId: string
  /** Explicitly used by imagegen to select an available orchestrator model per account. */
  resolveModelId?: CodexRuntimeModelResolver
  reasoningEffort?: string
  signal?: AbortSignal
  operation: (target: CodexRuntimeTarget, signal: AbortSignal) => Promise<T>
  /** Called between attempts to cleanup partial thread/artifact */
  cleanupAttempt?: (target: CodexRuntimeTarget, error: unknown) => Promise<void>
  /** Optional extraction hook; the generic failover wrapper never assumes that T carries usage. */
  extractAttemptUsage?: (value: unknown) => NormalizedAiUsage | undefined
  /** Observes usage from each physical attempt, including failed attempts. */
  onAttemptUsage?: (info: CodexEphemeralAttemptUsage) => void
  /** Merges usage from failed attempts into the successful result, without re-counting the winner. */
  mergeAttemptUsage?: (result: T, failedAttemptUsage: NormalizedAiUsage) => T
  scope?: 'helper'
  /** When set, emits `chat:subscription-failover:${conversationId}` on account switch. */
  conversationId?: string
  onFailoverTransition?: (info: CodexEphemeralFailoverTransition) => void
}

/** A physical helper that is still alive is never safe to ignore during account teardown. */
export class CodexEphemeralAttemptTimeoutError extends Error {
  readonly code = 'codex-ephemeral-attempt-timeout' as const

  constructor(readonly scope: string) {
    super(`Timed out waiting for Codex ephemeral attempts during teardown (${scope})`)
    this.name = 'CodexEphemeralAttemptTimeoutError'
  }
}

/**
 * Ownership of a physical Codex account while one ephemeral helper attempt is in flight.
 * The registry is intentionally independent from `ActiveRun`: image interpretation and preflight
 * compaction can start before a conversation has been admitted as an ActiveRun, and ownership transfer
 * summarizers can run without one altogether.
 */
export interface CodexEphemeralAttempt {
  conversationId?: string
  providerId: string
  signal: AbortSignal
  abort: (reason?: unknown) => void
  done: Promise<void>
}

export type CodexEphemeralAttemptOwner = (attempt: Omit<CodexEphemeralAttempt, 'done'>) => (() => void) | void

let ephemeralAttemptOwner: CodexEphemeralAttemptOwner | null = null
const activeEphemeralAttempts = new Map<symbol, CodexEphemeralAttempt>()

/** Installs the service-side owner bridge without making this failover module depend on the service. */
export function setCodexEphemeralAttemptOwner(owner: CodexEphemeralAttemptOwner | null): void {
  ephemeralAttemptOwner = owner
}

/** Snapshot used by account reset/logout to wait for helpers that have no ActiveRun. */
export function listCodexEphemeralAttempts(): readonly CodexEphemeralAttempt[] {
  return [...activeEphemeralAttempts.values()]
}

function beginCodexEphemeralAttempt(
  args: Pick<RunCodexEphemeralWithFailoverArgs<unknown>, 'conversationId' | 'signal'>,
  providerId: string,
  signal: AbortSignal,
  abort: (reason?: unknown) => void
): { done: Promise<void>; release: () => void } {
  let settleDone!: () => void
  const done = new Promise<void>((resolve) => {
    settleDone = resolve
  })
  let released = false
  const attempt: CodexEphemeralAttempt = {
    ...(args.conversationId ? { conversationId: args.conversationId } : {}),
    providerId,
    signal,
    abort: (reason) => {
      if (released) return
      abort(reason)
    },
    done,
  }
  const token = Symbol('codex-ephemeral-attempt')
  activeEphemeralAttempts.set(token, attempt)

  let ownerRelease: (() => void) | undefined
  try {
    const release = ephemeralAttemptOwner?.({
      ...(args.conversationId ? { conversationId: args.conversationId } : {}),
      providerId,
      signal,
      abort: attempt.abort,
    })
    if (typeof release === 'function') ownerRelease = release
  } catch {
    // Lifecycle bookkeeping must never change the helper's provider behavior.
  }

  return {
    done,
    release: () => {
      if (released) return
      released = true
      try {
        ownerRelease?.()
      } catch {
        // Best-effort owner cleanup; the registry itself still must settle.
      } finally {
        activeEphemeralAttempts.delete(token)
        settleDone()
      }
    },
  }
}

const DEFAULT_EXHAUSTED_MESSAGE =
  'All Codex subscription accounts in the failover chain are exhausted. Try again later.'
const DEFAULT_UNAVAILABLE_MESSAGE = 'No eligible Codex subscription account is currently available.'

function abortError(signal: AbortSignal, fallback = 'Codex ephemeral helper was aborted'): Error {
  const reason = signal.reason
  return reason instanceof Error ? reason : new Error(fallback)
}

function exhaustionSource(
  confidence: 'structured' | 'strong-marker' | 'rate-limits-confirmed'
): 'structured-error' | 'rate-limits' | 'usage-limit-marker' {
  if (confidence === 'structured') return 'structured-error'
  if (confidence === 'rate-limits-confirmed') return 'rate-limits'
  return 'usage-limit-marker'
}

export function emitSubscriptionFailoverEvent(conversationId: string, info: CodexEphemeralFailoverTransition): void {
  failoverDiag('transition', { conversationId, ...info })
  const wc = getMainWebContents()
  if (!wc || wc.isDestroyed()) return
  try {
    wc.send(`chat:subscription-failover:${conversationId}`, info)
  } catch {
    /* renderer may have gone away */
  }
}

/**
 * Cheap gate: any account on the frozen failover chain has a confirmed-auth snapshot.
 * Never spawns the app-server — real execution revalidates via resolveCodexRuntimeTarget.
 */
export function anyCodexFailoverAccountConnected(logicalProviderId: string, now = Date.now()): boolean {
  const chain = freezeFailoverChain(logicalProviderId)
  if (chain.length === 0) return false
  const router = getSubscriptionFailoverRouter()
  for (const providerId of chain) {
    if (!router.isAdmissible(providerId, now)) continue
    const accountId = subscriptionAccountId(providerId)
    try {
      if (getCodexSubscriptionManager(accountId).getStatusSnapshot()?.authenticated === true) return true
    } catch {
      /* ignore manager bootstrap failures on the cheap gate */
    }
  }
  return false
}

/**
 * Run a one-shot Codex helper (image gen, compact, interpreter, …) walking the frozen failover chain.
 * Retries only on confirmed quota; marks exhaustion before the next attempt.
 */
export async function runCodexEphemeralWithFailover<T>(args: RunCodexEphemeralWithFailoverArgs<T>): Promise<T> {
  const scope: SubscriptionFailoverScope = args.scope ?? 'helper'
  const chain = freezeFailoverChain(args.logicalProviderId)
  if (chain.length === 0) {
    throw new CodexRuntimeUnavailableError('unavailable', DEFAULT_UNAVAILABLE_MESSAGE)
  }

  const router = getSubscriptionFailoverRouter()
  const attemptController = new AbortController()
  const signal = args.signal ? AbortSignal.any([args.signal, attemptController.signal]) : attemptController.signal
  // A helper invocation is an explicit execution boundary: it may install the managed runtime on demand.
  // Passive probes stay read-only, while cancellation also releases this install waiter.
  if (app.isPackaged) await ensureRuntimeAsset('codex-runtime', signal)
  const attemptedProviderIds = new Set<string>()
  let previousProviderId: string | null = null
  let lastQuotaReason: string | undefined
  let lastResetsAt: number | null | undefined
  let attemptNumber = 0
  let failedAttemptUsage: NormalizedAiUsage | undefined

  const addUsage = (next: NormalizedAiUsage | undefined): void => {
    if (!next) return
    failedAttemptUsage = {
      input: (failedAttemptUsage?.input ?? 0) + next.input,
      output: (failedAttemptUsage?.output ?? 0) + next.output,
      cacheRead: (failedAttemptUsage?.cacheRead ?? 0) + next.cacheRead,
      cacheCreate: (failedAttemptUsage?.cacheCreate ?? 0) + next.cacheCreate,
      totalInput: (failedAttemptUsage?.totalInput ?? 0) + next.totalInput,
    }
  }

  while (true) {
    if (signal.aborted) throw abortError(signal)

    const resolved = await resolveCodexRuntimeTarget({
      logicalProviderId: args.logicalProviderId,
      modelId: args.modelId,
      ...(args.resolveModelId ? { resolveModelId: args.resolveModelId } : {}),
      reasoningEffort: args.reasoningEffort,
      chain,
      attemptedProviderIds,
      signal,
    })

    if (signal.aborted) throw abortError(signal)

    if (!resolved.ok) {
      if (resolved.error === 'aborted') {
        throw abortError(signal, resolved.message)
      }
      if (resolved.reason === 'quota-exhausted') {
        throw new CodexAccountsExhaustedError(
          lastQuotaReason?.trim() || resolved.message || DEFAULT_EXHAUSTED_MESSAGE,
          lastResetsAt ?? resolved.resetsAt
        )
      }
      throw new CodexRuntimeUnavailableError(resolved.reason, resolved.message || DEFAULT_UNAVAILABLE_MESSAGE)
    }

    const target = resolved.target
    attemptedProviderIds.add(target.providerId)
    attemptNumber += 1
    const currentAttempt = attemptNumber
    const attempt = beginCodexEphemeralAttempt(args, target.providerId, signal, (reason) =>
      attemptController.abort(reason)
    )

    let settled = false
    const settle = (
      result: 'success' | 'quota' | 'other',
      exhaustionInfo?: Parameters<typeof router.confirmAttemptQuota>[2]
    ) => {
      if (settled) return
      settled = true
      if (result === 'success') {
        router.confirmAttemptSuccess(target.providerId, target.availabilityLease)
      } else if (result === 'quota') {
        router.confirmAttemptQuota(target.providerId, target.availabilityLease, exhaustionInfo!)
      } else if (target.availabilityLease) {
        router.confirmAttemptOther(target.providerId, target.availabilityLease)
      }
    }

    try {
      if (signal.aborted) {
        settle('other')
        throw abortError(signal)
      }

      if (previousProviderId && previousProviderId !== target.providerId) {
        const transition: CodexEphemeralFailoverTransition = {
          scope,
          fromProviderId: previousProviderId,
          toProviderId: target.providerId,
          reason: lastQuotaReason ?? 'usage limit',
          ...(lastResetsAt !== undefined ? { resetsAt: lastResetsAt } : {}),
        }
        args.onFailoverTransition?.(transition)
        if (args.conversationId) emitSubscriptionFailoverEvent(args.conversationId, transition)
      }

      const result = await args.operation(target, signal)
      const usage = args.extractAttemptUsage?.(result)
      if (usage) {
        args.onAttemptUsage?.({ target, attempt: currentAttempt, usage, outcome: 'success' })
      }
      if (signal.aborted) {
        settle('other')
        throw abortError(signal)
      }
      settle('success')
      return args.mergeAttemptUsage && failedAttemptUsage
        ? args.mergeAttemptUsage(result, failedAttemptUsage)
        : result
    } catch (error) {
      const partialUsage = args.extractAttemptUsage?.(error)
      if (partialUsage) {
        args.onAttemptUsage?.({ target, attempt: currentAttempt, usage: partialUsage, outcome: 'failed' })
      }
      if (signal.aborted) {
        settle('other')
        throw abortError(signal)
      }
      const classification = await classifyCodexQuotaFailureWithRateLimits(error, () =>
        target.manager.getRateLimits(true)
      )

      if (signal.aborted) {
        settle('other')
        throw abortError(signal)
      }

      if (classification.kind !== 'quota') {
        settle('other')
        throw error
      }

      const exhaustionInfo = {
        reason: classification.message,
        source: exhaustionSource(classification.confidence),
        resetsAt: classification.resetsAt ?? null,
      }
      addUsage(partialUsage)
      settle('quota', exhaustionInfo)
      lastQuotaReason = classification.message
      lastResetsAt = classification.resetsAt ?? null
      previousProviderId = target.providerId

      if (args.cleanupAttempt) {
        try {
          await args.cleanupAttempt(target, error)
        } catch {
          /* best-effort */
        }
      }

      failoverDiag('ephemeral-quota-rotate', {
        fromProviderId: target.providerId,
        logicalProviderId: args.logicalProviderId,
        scope,
        reason: classification.message,
      })
    } finally {
      // One release per resolved target, after quota cleanup has finished and before the next attempt.
      attempt.release()
    }
  }
}
