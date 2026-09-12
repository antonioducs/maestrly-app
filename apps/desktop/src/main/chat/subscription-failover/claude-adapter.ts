import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk'
import { isMaestrlyUltraEffort, resolveUltraEffort, subscriptionAccountId } from '../../../shared/chat'
import { getProvider, isClaudeSubscriptionProvider } from '../catalog'
import {
  getClaudeSubscriptionManager,
  type ClaudeSubscriptionAccountIdentity,
  type ClaudeSubscriptionManager,
} from '../claude-agent-sdk/manager'
import {
  getSubscriptionFailoverRouter,
  type AvailabilityLease,
  type MarkExhaustedInfo,
  type SubscriptionFailoverRouter,
} from './router'

export interface ClaudeRuntimeTarget {
  providerId: string
  accountId: string | null
  manager: ClaudeSubscriptionManager
  accountIdentity: ClaudeSubscriptionAccountIdentity
  model: ModelInfo
  runtimeModelId: string
  reasoningEffort?: string
  fastMode: boolean
  maestrlyUltra: boolean
  contextWindow: number | null
  availabilityLease?: AvailabilityLease
}

export interface ResolveClaudeTargetArgs {
  logicalProviderId: string
  modelId: string
  runtimeModelId?: string
  reasoningEffort?: string
  fastMode?: boolean
  chain: readonly string[]
  attemptedProviderIds: ReadonlySet<string>
  admit?: boolean
  signal: AbortSignal
  now?: number
}

type FailureReason = 'quota-exhausted' | 'not-authenticated' | 'incompatible' | 'unavailable'
export type ResolveClaudeTargetResult =
  | { ok: true; target: ClaudeRuntimeTarget }
  | { ok: false; error: 'aborted'; message: string }
  | { ok: false; error: 'no-eligible-account'; reason: FailureReason; message: string; resetsAt?: number | null }

const identities = new WeakMap<
  SubscriptionFailoverRouter,
  Map<string, { manager: ClaudeSubscriptionManager; identity: ClaudeSubscriptionAccountIdentity }>
>()

function syncIdentity(
  router: SubscriptionFailoverRouter,
  providerId: string,
  manager: ClaudeSubscriptionManager,
  identity: ClaudeSubscriptionAccountIdentity
): void {
  let entries = identities.get(router)
  if (!entries) {
    entries = new Map()
    identities.set(router, entries)
  }
  const previous = entries.get(providerId)
  if (
    previous &&
    (previous.identity.fingerprint !== identity.fingerprint || previous.identity.epoch !== identity.epoch)
  )
    router.resetProvider(providerId)
  entries.set(providerId, { manager, identity })
}

function assertIdentity(manager: ClaudeSubscriptionManager, identity: ClaudeSubscriptionAccountIdentity): void {
  manager.assertAccountIdentity(identity)
  const current = manager.getStatusSnapshot()
  if (
    !current?.authenticated ||
    current.accountFingerprint !== identity.fingerprint ||
    current.accountEpoch !== identity.epoch
  )
    throw new Error('Claude account changed')
}

/** Settlement is bound to the admitted physical identity, including callbacks after account replacement. */
export function settleClaudeAttempt(
  target: ClaudeRuntimeTarget,
  outcome: 'success' | 'quota' | 'other',
  info?: MarkExhaustedInfo
): void {
  try {
    if (getClaudeSubscriptionManager(target.accountId) !== target.manager) return
    assertIdentity(target.manager, target.accountIdentity)
  } catch {
    return
  }
  const router = getSubscriptionFailoverRouter()
  if (outcome === 'success') router.confirmAttemptSuccess(target.providerId, target.availabilityLease)
  else if (outcome === 'quota')
    router.confirmAttemptQuota(
      target.providerId,
      target.availabilityLease,
      info ?? { reason: 'Claude subscription usage limit reached', source: 'structured-error' }
    )
  else router.confirmAttemptOther(target.providerId, target.availabilityLease)
}

export async function resolveClaudeRuntimeTarget(args: ResolveClaudeTargetArgs): Promise<ResolveClaudeTargetResult> {
  const router = getSubscriptionFailoverRouter()
  const reasons = new Set<FailureReason>()
  let resetsAt: number | undefined
  const aborted = (): ResolveClaudeTargetResult => ({
    ok: false,
    error: 'aborted',
    message: 'Claude failover resolution was aborted',
  })
  const exhausted = (providerId: string): void => {
    reasons.add('quota-exhausted')
    const reset = router.getHealth(providerId).exhaustion?.resetsAt
    if (typeof reset === 'number' && Number.isFinite(reset)) resetsAt = Math.min(resetsAt ?? reset, reset)
  }
  for (const providerId of new Set(args.chain)) {
    if (args.signal.aborted) return aborted()
    if (
      !isClaudeSubscriptionProvider(args.logicalProviderId) ||
      !isClaudeSubscriptionProvider(providerId) ||
      !getProvider(providerId)
    ) {
      reasons.add('unavailable')
      continue
    }
    const accountId = subscriptionAccountId(providerId)
    try {
      const manager = getClaudeSubscriptionManager(accountId)
      const status = await manager.status()
      if (args.signal.aborted) return aborted()
      const accountIdentity = { fingerprint: status.accountFingerprint, epoch: status.accountEpoch }
      manager.assertAccountIdentity(accountIdentity)
      const snapshot = manager.getStatusSnapshot()
      if (
        snapshot?.accountFingerprint !== accountIdentity.fingerprint ||
        snapshot.accountEpoch !== accountIdentity.epoch ||
        snapshot.authenticated !== status.authenticated
      )
        throw new Error('Claude account changed during status discovery')
      if (getClaudeSubscriptionManager(accountId) !== manager) throw new Error('Claude account manager changed')
      syncIdentity(router, providerId, manager, accountIdentity)
      if (!status.available) {
        reasons.add('unavailable')
        continue
      }
      if (!status.authenticated || !accountIdentity.fingerprint) {
        reasons.add('not-authenticated')
        continue
      }
      assertIdentity(manager, accountIdentity)
      if (args.attemptedProviderIds.has(providerId)) {
        const health = router.getHealth(providerId)
        if (health.state === 'exhausted' || health.state === 'half-open') exhausted(providerId)
        else reasons.add('unavailable')
        continue
      }
      if (!router.isAdmissible(providerId, args.now ?? Date.now())) {
        exhausted(providerId)
        continue
      }
      const models = await manager.listModels(args.signal)
      if (args.signal.aborted) return aborted()
      assertIdentity(manager, accountIdentity)
      if (getClaudeSubscriptionManager(accountId) !== manager) throw new Error('Claude account manager changed')
      const requested = args.runtimeModelId ?? args.modelId
      const model = models.find((entry) =>
        args.runtimeModelId
          ? (entry.resolvedModel ?? entry.value) === requested
          : entry.value === requested || entry.resolvedModel === requested
      )
      if (!model) {
        reasons.add('incompatible')
        continue
      }
      const levels = model.supportedEffortLevels ?? []
      const maestrlyUltra = isMaestrlyUltraEffort(args.reasoningEffort, levels)
      const wantsEffort = !!args.reasoningEffort && args.reasoningEffort !== 'off'
      if (
        wantsEffort &&
        (!model.supportsEffort ||
          !levels.length ||
          (!maestrlyUltra && !levels.some((level) => level === args.reasoningEffort)))
      ) {
        reasons.add('incompatible')
        continue
      }
      if (args.fastMode && model.supportsFastMode !== true) {
        reasons.add('incompatible')
        continue
      }
      const runtimeModelId = model.resolvedModel ?? model.value
      const reasoningEffort = wantsEffort
        ? maestrlyUltra
          ? resolveUltraEffort([...levels])
          : args.reasoningEffort
        : undefined
      const observedWindow =
        manager.getObservedModelContextWindow(runtimeModelId) ?? manager.getObservedModelContextWindow(model.value)
      assertIdentity(manager, accountIdentity)
      const admission =
        args.admit === false ? { ok: true as const } : router.tryAdmit(providerId, args.now ?? Date.now())
      if (!admission.ok) {
        exhausted(providerId)
        continue
      }
      return {
        ok: true,
        target: {
          providerId,
          accountId,
          manager,
          accountIdentity,
          model,
          runtimeModelId,
          reasoningEffort,
          fastMode: args.fastMode === true,
          maestrlyUltra,
          contextWindow:
            observedWindow && Number.isFinite(observedWindow) && observedWindow > 0 ? observedWindow : null,
          ...('lease' in admission && admission.lease ? { availabilityLease: admission.lease } : {}),
        },
      }
    } catch {
      if (args.signal.aborted) return aborted()
      reasons.add('unavailable')
    }
  }
  const reason = reasons.size === 1 ? [...reasons][0]! : 'unavailable'
  const messages: Record<FailureReason, string> = {
    'quota-exhausted': 'All Claude subscription accounts in the failover chain are exhausted. Try again later.',
    'not-authenticated': 'Connect your Claude account in Maestrly settings to continue.',
    incompatible: 'No Claude subscription account supports the requested model, reasoning effort, or Fast mode.',
    unavailable:
      'No eligible Claude subscription account is currently available. Check account connections and model compatibility.',
  }
  return {
    ok: false,
    error: 'no-eligible-account',
    reason,
    message: messages[reason],
    ...(resetsAt === undefined ? {} : { resetsAt }),
  }
}
