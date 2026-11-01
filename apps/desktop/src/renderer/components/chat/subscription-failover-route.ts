import type { ChatProviderInfo } from '../../../shared/chat'
import { subscriptionBaseProviderId } from '../../../shared/chat'

/** An account of the provider that could join its rotation. */
export interface FailoverRouteCandidate {
  providerId: string
  label: string
  connected: boolean
}

/** Display label for a subscription provider id given the chat config providers list. */
export function labelForSubscriptionProvider(
  providerId: string,
  providers: readonly ChatProviderInfo[],
  defaultLabel: string
): string {
  const provider = providers.find((entry) => entry.id === providerId)
  if (!provider) return providerId
  if (provider.accountId) return provider.accountLabel?.trim() || provider.accountId
  return defaultLabel
}

/** Shared by admission failures and persisted message errors. */
export function subscriptionExhaustionMessageKey(errorCode?: string) {
  if (errorCode === 'codex-accounts-exhausted') return 'messages.accountsExhaustedError' as const
  if (errorCode === 'claude-accounts-exhausted') return 'messages.claudeAccountsExhaustedError' as const
  return undefined
}

export function subscriptionDefaultLabelKey(providerId: string) {
  return subscriptionBaseProviderId(providerId) === 'builtin_claude_subscription'
    ? ('settings.claudeSubscriptionHeading' as const)
    : ('settings.codexSubscriptionHeading' as const)
}
