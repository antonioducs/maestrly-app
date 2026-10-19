import {
  subscriptionAccountId,
  type ChatSubscriptionProviderKind,
  type ChatSubscriptionUsageWindow,
} from '../../../shared/chat'
import { isClaudeSubscriptionProvider, isCodexSubscriptionProvider } from '../../chat/catalog'
import { getClaudeSubscriptionManager } from '../../chat/claude-agent-sdk/manager'
import { getCodexSubscriptionManager } from '../../chat/codex-subscription/manager'
import {
  normalizeClaudeSubscriptionUsage,
  normalizeCodexSubscriptionUsage,
  readSubscriptionUsage,
} from '../../chat/subscription-usage'

/** How often an account whose usage is unknown is read again in the background. */
const WARM_EVERY_MS = 60_000
const warmedAt = new Map<string, number>()

/**
 * Share of an account's usage still free, 0..1: its tightest five-hour or weekly window. A window whose reset time has
 * passed counts as unused. Null without windows.
 */
export function headroomOf(windows: readonly ChatSubscriptionUsageWindow[], now: number): number | null {
  const used = windows
    .filter((window) => window.kind === 'five-hour' || window.kind === 'weekly')
    .map((window) => (window.resetsAt !== null && window.resetsAt <= now ? 0 : window.usedPercent))
  if (!used.length) return null
  return Math.min(1, Math.max(0, 1 - Math.max(...used) / 100))
}

function usageKind(providerId: string): ChatSubscriptionProviderKind | null {
  if (isClaudeSubscriptionProvider(providerId)) return 'claude-subscription'
  if (isCodexSubscriptionProvider(providerId)) return 'codex-subscription'
  return null
}

/** The usage an account's manager last read, without reading it again; null when unknown or not a subscription. */
export function accountHeadroom(providerId: string, now = Date.now()): number | null {
  const kind = usageKind(providerId)
  if (!kind) return null
  const accountId = subscriptionAccountId(providerId)
  try {
    if (kind === 'claude-subscription') {
      const snapshot = getClaudeSubscriptionManager(accountId).getUsageSnapshot()
      return snapshot ? headroomOf(normalizeClaudeSubscriptionUsage(snapshot), now) : null
    }
    const snapshot = getCodexSubscriptionManager(accountId).getRateLimitsSnapshot()
    return snapshot ? headroomOf(normalizeCodexSubscriptionUsage(snapshot), now) : null
  } catch {
    return null
  }
}

/** Starts a background read of the accounts whose usage is unknown, so the next task can compare them. */
export function warmAccountHeadroom(providerIds: readonly string[], now = Date.now()): void {
  for (const providerId of new Set(providerIds)) {
    const kind = usageKind(providerId)
    if (!kind || accountHeadroom(providerId, now) !== null) continue
    if (now - (warmedAt.get(providerId) ?? Number.NEGATIVE_INFINITY) < WARM_EVERY_MS) continue
    warmedAt.set(providerId, now)
    // Not forced: the managers keep their own cache, and a read only fills what the next task sees.
    void readSubscriptionUsage({ providerKind: kind, accountId: subscriptionAccountId(providerId) }).catch(
      () => undefined
    )
  }
}
