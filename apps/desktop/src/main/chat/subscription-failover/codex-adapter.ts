import { isMaestrlyUltraEffort, resolveUltraEffort } from '../../../shared/chat'
import { getProvider, isCodexSubscriptionProvider, subscriptionAccountId } from '../catalog'
import type { CodexAppServerClient } from '../codex-subscription/client'
import {
  getCodexSubscriptionManager,
  type CodexSubscriptionManager,
  type CodexSubscriptionModel,
} from '../codex-subscription/manager'
import { resolveCodexContextWindow } from '../codex-subscription/context-window'
import { getContextLimit } from '../context-limits'
import { getProactiveRateLimitExhaustion } from '../codex-subscription/rate-limits'
import type { CodexAccountRateLimits } from '../codex-subscription/protocol'
import { failoverDiag } from './diag'
import { OPENAI_GPT6_ASTRA_MANIFEST, resolveModelHarnessProfile } from '../model-harness-profile'
import {
  getSubscriptionFailoverRouter,
  type AvailabilityLease,
  type SubscriptionFailoverRouter,
  type TryAdmitResult,
} from './router'

export interface CodexRuntimeTarget {
  providerId: string
  accountId: string | null
  manager: CodexSubscriptionManager
  client: CodexAppServerClient
  model: CodexSubscriptionModel
  runtimeModelId: string
  reasoningEffort?: string
  serviceTier: string | null
  dropImages: boolean
  /**
   * Legacy active/runtime window. New root callers must use `effectiveContextWindow` instead: the latter is
   * explicitly the conservative host ceiling for the nominal configuration requested on this physical account.
   */
  contextWindow?: number | null
  /** Nominal `model_context_window` accepted by this physical account, or null when capability is unknown. */
  requestedContextWindow?: number | null
  /** Effective host/preflight estimate for `requestedContextWindow` (or the active fallback when unknown). */
  effectiveContextWindow?: number | null
  availabilityLease?: AvailabilityLease
}

/**
 * Explicit exception for helpers whose model is selected from each account's catalog (currently imagegen).
 * Normal chat/subagent callers leave this unset and therefore require the requested model on every account.
 */
export type CodexRuntimeModelResolver = (
  manager: CodexSubscriptionManager,
  models: readonly CodexSubscriptionModel[]
) => string | Promise<string>

/** Aggregate reason for a chain with no executable target. */
export type CodexRuntimeResolutionFailureReason =
  | 'quota-exhausted'
  | 'not-authenticated'
  | 'incompatible'
  | 'unavailable'

export interface ResolveCodexTargetArgs {
  logicalProviderId: string
  modelId: string
  /** Per-candidate model selection for the explicitly opt-in imagegen helper. */
  resolveModelId?: CodexRuntimeModelResolver
  reasoningEffort?: string
  fastMode?: boolean
  /** Frozen failover chain (primary first). */
  chain: readonly string[]
  attemptedProviderIds: ReadonlySet<string>
  /** Context-only resolution must not consume a half-open probe before portable compaction. */
  admit?: boolean
  /**
   * Root chat opts in to a configurable context request. Dedicated helper/image/subagent threads deliberately
   * leave this false so their current runtime-owned context policy is unchanged.
   */
  configureContextWindow?: boolean
  astraHarnessEnabled?: boolean
  signal?: AbortSignal
  now?: number
}

export type ResolveCodexTargetResult =
  | { ok: true; target: CodexRuntimeTarget }
  | {
      ok: false
      error: 'aborted'
      message: string
      resetsAt?: number | null
    }
  | {
      ok: false
      error: 'no-eligible-account'
      reason: CodexRuntimeResolutionFailureReason
      message: string
      resetsAt?: number | null
    }

const RESOLUTION_FAILURE_MESSAGES: Record<CodexRuntimeResolutionFailureReason, string> = {
  'quota-exhausted': 'All Codex subscription accounts in the failover chain are exhausted. Try again later.',
  'not-authenticated': 'Connect your ChatGPT (Codex) account in Maestrly settings to continue.',
  incompatible: 'No Codex subscription account supports the requested model, reasoning effort, or Fast mode.',
  unavailable:
    'No eligible Codex subscription account is currently available. Check account connections and model compatibility.',
}

/** Resolves the concrete transport tier for one child model on one physical Codex account. */
export async function resolveCodexSubagentServiceTier(
  manager: Pick<CodexSubscriptionManager, 'preferredServiceTier'>,
  modelId: string,
  fastMode: boolean
): Promise<string> {
  if (!fastMode) return 'default'
  let preferred: string | null
  try {
    preferred = await manager.preferredServiceTier(modelId)
  } catch (error) {
    const detail = error instanceof Error && error.message ? `: ${error.message}` : ''
    throw new Error(`Fast tier for Codex child model “${modelId}” could not be resolved${detail}`)
  }
  if (preferred && /^(?:priority|fast)$/i.test(preferred)) return preferred
  throw new Error(`Fast tier is unavailable for Codex child model “${modelId}” on this account.`)
}

function aggregateResolutionFailure(
  reasons: ReadonlySet<CodexRuntimeResolutionFailureReason>
): CodexRuntimeResolutionFailureReason {
  if (reasons.size === 1) return [...reasons][0]
  // A mixed chain must not claim that every account is out of quota. It remains unavailable until the
  // caller can present a more specific account-level action (connect, fix model, or retry later).
  return 'unavailable'
}

function matchModel(models: readonly CodexSubscriptionModel[], modelId: string): CodexSubscriptionModel | undefined {
  return models.find((entry) => entry.id === modelId || entry.model === modelId)
}

function contextWindowForTarget(
  manager: CodexSubscriptionManager,
  model: CodexSubscriptionModel,
  logicalProviderId: string,
  logicalModelId: string,
  enabled: boolean
): { requestedContextWindow: number | null; effectiveContextWindow: number | null } {
  if (!enabled) {
    return { requestedContextWindow: null, effectiveContextWindow: model.contextWindow }
  }

  const userLimit = getContextLimit(logicalProviderId, logicalModelId)
  const initial = resolveCodexContextWindow({ model, userLimit })
  const observation =
    initial.requestedNominal != null
      ? manager.getObservedModelContextWindowObservation?.(model.id, initial.requestedNominal)
      : undefined
  const resolved = resolveCodexContextWindow({ model, userLimit, sameRequestObservation: observation })
  return {
    requestedContextWindow: resolved.requestedNominal,
    effectiveContextWindow: resolved.effectiveEstimate,
  }
}

function resolveReasoningEffort(
  requested: string | undefined,
  model: CodexSubscriptionModel,
  astraHarnessEnabled = true
): { ok: true; effort?: string } | { ok: false } {
  if (!requested || requested === 'off') return { ok: true, effort: undefined }

  const advertised = model.supportedReasoningEfforts.map((option) => option.reasoningEffort)
  const astra =
    resolveModelHarnessProfile({
      providerKind: 'codex-subscription',
      modelId: model.model,
      astraHarnessEnabled,
    }).id === 'openai-gpt-6-astra-v1'
  const supported = astra
    ? advertised.filter((effort) => OPENAI_GPT6_ASTRA_MANIFEST.validReasoningEfforts.includes(effort))
    : advertised

  if (isMaestrlyUltraEffort(requested, supported)) {
    if (supported.length === 0) {
      return { ok: true, effort: model.defaultReasoningEffort || undefined }
    }
    return { ok: true, effort: resolveUltraEffort([...supported]) }
  }

  // Specific effort not advertised → skip account (do not silently degrade).
  if (supported.length > 0 && !supported.includes(requested)) {
    return { ok: false }
  }

  return { ok: true, effort: requested }
}

type CodexAuthenticationProbeResult = 'authenticated' | 'not-authenticated' | 'unavailable'

interface RateLimitAwareManager {
  getRateLimitsSnapshot?: () => CodexAccountRateLimits | null
  onRateLimitsUpdated?: (listener: (limits: CodexAccountRateLimits) => void) => () => void
}

interface RateLimitBinding {
  router: SubscriptionFailoverRouter
  signalKey: string | null
  unsubscribe: () => void
  active: boolean
}

/**
 * The manager is already scoped to one account, but key by physical provider too so tests/adapters that share
 * a manager object cannot accidentally route account A's notification to account B. Weak keys keep discarded
 * account managers from being retained by the failover adapter.
 */
const rateLimitBindings = new WeakMap<object, Map<string, RateLimitBinding>>()

function rateLimitSignalKey(
  limits: CodexAccountRateLimits,
  reason: string,
  resetsAt: number | null | undefined
): string {
  return [limits.rateLimitReachedType ?? null, limits.limitReached ?? null, reason, resetsAt ?? null]
    .map(String)
    .join('|')
}

function applyExplicitRateLimitSnapshot(
  binding: RateLimitBinding,
  providerId: string,
  limits: CodexAccountRateLimits,
  now: number
): void {
  if (!binding.active) return
  const exhaustion = getProactiveRateLimitExhaustion(limits, now)
  if (!exhaustion.exhausted) {
    // A healthy snapshot is informational only. Resets/half-open probes own recovery of an open circuit.
    binding.signalKey = null
    return
  }

  const signalKey = rateLimitSignalKey(limits, exhaustion.reason ?? 'explicit rate limit reached', exhaustion.resetsAt)
  if (binding.signalKey === signalKey) return
  binding.signalKey = signalKey
  binding.router.markExhausted(providerId, {
    reason: exhaustion.reason ?? 'explicit rate limit reached',
    source: 'rate-limits',
    resetsAt: exhaustion.resetsAt,
    now,
  })
}

/** Remove the binding for one physical account before its identity is reset. */
export function resetCodexRateLimitBinding(manager: CodexSubscriptionManager, providerId: string): void {
  const bindingsForManager = rateLimitBindings.get(manager)
  const binding = bindingsForManager?.get(providerId)
  if (!binding) return

  binding.active = false
  binding.signalKey = null
  try {
    binding.unsubscribe()
  } catch {
    // A stale observer must not make an identity transition fail.
  }
  binding.unsubscribe = () => {}
  bindingsForManager?.delete(providerId)
  if (bindingsForManager?.size === 0) rateLimitBindings.delete(manager)
}

/** Lazily bind one physical Codex account and consume an already cached snapshot before admitting work. */
function wireRateLimitsToRouter(
  providerId: string,
  manager: CodexSubscriptionManager,
  router: SubscriptionFailoverRouter,
  now: number
): void {
  const source = manager as unknown as RateLimitAwareManager
  let bindingsForManager = rateLimitBindings.get(manager)
  if (!bindingsForManager) {
    bindingsForManager = new Map<string, RateLimitBinding>()
    rateLimitBindings.set(manager, bindingsForManager)
  }

  const previous = bindingsForManager.get(providerId)
  if (previous && previous.router !== router) {
    resetCodexRateLimitBinding(manager, providerId)
    bindingsForManager = rateLimitBindings.get(manager)
  }

  if (!bindingsForManager) {
    bindingsForManager = new Map<string, RateLimitBinding>()
    rateLimitBindings.set(manager, bindingsForManager)
  }

  let binding = bindingsForManager.get(providerId)
  if (!binding) {
    binding = { router, signalKey: null, unsubscribe: () => {}, active: true }
    bindingsForManager.set(providerId, binding)
    if (typeof source.onRateLimitsUpdated === 'function') {
      try {
        const unsubscribe = source.onRateLimitsUpdated((limits) => {
          applyExplicitRateLimitSnapshot(binding!, providerId, limits, Date.now())
        })
        if (typeof unsubscribe === 'function') binding.unsubscribe = unsubscribe
      } catch {
        // Rate-limit notifications are an optimization; resolver/status failures remain fail-open.
      }
    }
  }

  if (typeof source.getRateLimitsSnapshot !== 'function') return
  try {
    const snapshot = source.getRateLimitsSnapshot()
    if (snapshot) applyExplicitRateLimitSnapshot(binding, providerId, snapshot, now)
  } catch {
    // A snapshot is advisory; the normal auth/model probes remain authoritative for eligibility.
  }
}

async function ensureAuthenticated(manager: CodexSubscriptionManager): Promise<CodexAuthenticationProbeResult> {
  const snapshot = manager.getStatusSnapshot()
  if (snapshot?.authenticated === true) return 'authenticated'
  if (snapshot?.state === 'ready' && snapshot.available && snapshot.connected && snapshot.authenticated === false) {
    return 'not-authenticated'
  }
  if (snapshot) return 'unavailable'
  // Only a missing snapshot needs one status probe; a failed probe is unavailable, not logout.
  try {
    const status = await manager.getStatus()
    if (status.authenticated === true) return 'authenticated'
    if (status.state !== 'ready' || !status.available || !status.connected) return 'unavailable'
    return 'not-authenticated'
  } catch {
    return 'unavailable'
  }
}

/**
 * Resolve a Codex subscription runtime target by walking the frozen failover chain with the
 * circuit-breaker router (tryAdmit / half-open lease).
 */
export async function resolveCodexRuntimeTarget(args: ResolveCodexTargetArgs): Promise<ResolveCodexTargetResult> {
  const router = getSubscriptionFailoverRouter()
  const now = args.now ?? Date.now()
  let earliestResetsAt: number | null | undefined
  const failureReasons = new Set<CodexRuntimeResolutionFailureReason>()

  const recordFailure = (reason: CodexRuntimeResolutionFailureReason): void => {
    failureReasons.add(reason)
  }

  const considerResetsAt = (providerId: string): void => {
    const resetsAt = router.getHealth(providerId).exhaustion?.resetsAt
    if (resetsAt == null) return
    if (earliestResetsAt == null || resetsAt < earliestResetsAt) earliestResetsAt = resetsAt
  }

  for (const providerId of args.chain) {
    if (args.signal?.aborted) {
      return { ok: false, error: 'aborted', message: 'Codex failover resolution was aborted' }
    }

    if (args.attemptedProviderIds.has(providerId)) {
      // A caller only resolves a next target after an attempt. Count it as quota only when the router
      // still records the physical account as exhausted/half-open; otherwise preserve a non-quota result.
      const health = router.getHealth(providerId)
      recordFailure(health.state === 'exhausted' || health.state === 'half-open' ? 'quota-exhausted' : 'unavailable')
      continue
    }

    // Preserve the cheap hard-block path: a provider already in backoff must not even bootstrap its manager.
    // Due exhausted circuits remain eligible for the manager snapshot sync below, which may refresh the signal
    // before the half-open lease is taken.
    if (!router.isAdmissible(providerId, now)) {
      const health = router.getHealth(providerId)
      considerResetsAt(providerId)
      recordFailure('quota-exhausted')
      failoverDiag('codex-skip-admit', {
        providerId,
        reason: health.state === 'half-open' ? 'half-open-probe-in-flight' : 'exhausted-backoff',
      })
      continue
    }

    if (!isCodexSubscriptionProvider(providerId) || !getProvider(providerId)) {
      recordFailure('unavailable')
      failoverDiag('codex-skip-missing-provider', { providerId })
      continue
    }

    const accountId = subscriptionAccountId(providerId)
    const manager = getCodexSubscriptionManager(accountId)
    // Do this before tryAdmit: an explicit notification may have arrived before this lazy binding was installed,
    // and a cached reached snapshot must skip status/models/client probes for that physical account.
    wireRateLimitsToRouter(providerId, manager, router, now)

    // Context-only resolution is lease-free, but it must still respect a rate-limit snapshot that was wired above.
    if (args.admit === false && !router.isAdmissible(providerId, now)) {
      const health = router.getHealth(providerId)
      considerResetsAt(providerId)
      recordFailure('quota-exhausted')
      failoverDiag('codex-skip-admit', {
        providerId,
        reason: health.state === 'half-open' ? 'half-open-probe-in-flight' : 'exhausted-backoff',
      })
      continue
    }

    const admit: TryAdmitResult = args.admit === false ? { ok: true } : router.tryAdmit(providerId, now)
    if (!admit.ok) {
      considerResetsAt(providerId)
      recordFailure('quota-exhausted')
      failoverDiag('codex-skip-admit', { providerId, reason: admit.reason })
      continue
    }

    const releaseLease = (result: 'success' | 'quota' | 'other'): void => {
      if (!admit.lease) return
      router.releaseHalfOpenProbe(providerId, admit.lease.leaseId, result)
    }

    const authentication = await ensureAuthenticated(manager)
    if (args.signal?.aborted) {
      releaseLease('other')
      return { ok: false, error: 'aborted', message: 'Codex failover resolution was aborted' }
    }
    if (authentication === 'unavailable') {
      releaseLease('other')
      recordFailure('unavailable')
      failoverDiag('codex-skip-auth-status-unavailable', { providerId })
      continue
    }
    if (authentication === 'not-authenticated') {
      releaseLease('other')
      recordFailure('not-authenticated')
      failoverDiag('codex-skip-unauthenticated', { providerId })
      continue
    }

    let models: readonly CodexSubscriptionModel[]
    try {
      models = await manager.listModels()
    } catch {
      releaseLease('other')
      recordFailure('unavailable')
      failoverDiag('codex-skip-list-models-failed', { providerId })
      continue
    }

    let runtimeModelId = args.modelId
    if (args.resolveModelId) {
      try {
        runtimeModelId = await args.resolveModelId(manager, models)
      } catch {
        releaseLease('other')
        recordFailure('unavailable')
        failoverDiag('codex-skip-resolve-model-failed', { providerId, modelId: args.modelId })
        continue
      }
    }

    const model = matchModel(models, runtimeModelId)
    if (!model) {
      releaseLease('other')
      recordFailure('incompatible')
      failoverDiag('codex-skip-model-missing', { providerId, modelId: runtimeModelId })
      continue
    }

    const reasoning = resolveReasoningEffort(args.reasoningEffort, model, args.astraHarnessEnabled)
    if (!reasoning.ok) {
      releaseLease('other')
      recordFailure('incompatible')
      failoverDiag('codex-skip-effort-unsupported', {
        providerId,
        modelId: runtimeModelId,
        reasoningEffort: args.reasoningEffort,
      })
      continue
    }

    let serviceTier: string
    try {
      serviceTier = await resolveCodexSubagentServiceTier(manager, runtimeModelId, args.fastMode === true)
    } catch {
      releaseLease('other')
      recordFailure('incompatible')
      failoverDiag('codex-skip-fast-tier-unavailable', { providerId, modelId: runtimeModelId })
      continue
    }

    const dropImages = (model.inputModalities?.length ?? 0) > 0 && !model.inputModalities.includes('image')
    const context = contextWindowForTarget(
      manager,
      model,
      args.logicalProviderId,
      args.modelId,
      args.configureContextWindow === true
    )

    let client: CodexAppServerClient
    try {
      client = await manager.getClient()
    } catch {
      releaseLease('other')
      recordFailure('unavailable')
      failoverDiag('codex-skip-get-client-failed', { providerId })
      continue
    }

    if (args.signal?.aborted) {
      releaseLease('other')
      return { ok: false, error: 'aborted', message: 'Codex failover resolution was aborted' }
    }

    const target: CodexRuntimeTarget = {
      providerId,
      accountId,
      manager,
      client,
      model,
      runtimeModelId: model.id,
      ...(reasoning.effort !== undefined ? { reasoningEffort: reasoning.effort } : {}),
      serviceTier,
      dropImages,
      ...(context.requestedContextWindow != null ? { requestedContextWindow: context.requestedContextWindow } : {}),
      ...(context.effectiveContextWindow != null ? { effectiveContextWindow: context.effectiveContextWindow } : {}),
      // Keep old structural consumers working while every root path migrates to `effectiveContextWindow`.
      contextWindow: model.contextWindow,
      ...(admit.lease ? { availabilityLease: admit.lease } : {}),
    }

    failoverDiag('codex-target-resolved', {
      logicalProviderId: args.logicalProviderId,
      providerId,
      modelId: runtimeModelId,
      ...(context.requestedContextWindow != null ? { requestedContextWindow: context.requestedContextWindow } : {}),
      ...(context.effectiveContextWindow != null ? { effectiveContextWindow: context.effectiveContextWindow } : {}),
      halfOpen: Boolean(admit.lease),
    })

    return { ok: true, target }
  }

  const reason = aggregateResolutionFailure(failureReasons)
  failoverDiag('codex-no-target', {
    logicalProviderId: args.logicalProviderId,
    reason,
    candidateReasons: [...failureReasons],
  })

  return {
    ok: false,
    error: 'no-eligible-account',
    reason,
    message: RESOLUTION_FAILURE_MESSAGES[reason],
    resetsAt: earliestResetsAt,
  }
}
