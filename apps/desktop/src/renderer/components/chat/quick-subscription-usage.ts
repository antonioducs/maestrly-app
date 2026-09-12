import type { ChatConfig, ChatSubscriptionProviderKind } from '../../../shared/chat'

export type QuickUsageProviderKind = Extract<ChatSubscriptionProviderKind, 'codex-subscription' | 'claude-subscription'>

export interface QuickUsageTarget {
  providerId: string
  providerKind: QuickUsageProviderKind
  accountId: string | null
  label: string
  accountLabel?: string
}

export function connectedQuickUsageTargets(config: Pick<ChatConfig, 'providers'>): QuickUsageTarget[] {
  return config.providers.flatMap((provider) => {
    if (
      provider.connected !== true ||
      (provider.kind !== 'codex-subscription' && provider.kind !== 'claude-subscription')
    ) {
      return []
    }
    return [
      {
        providerId: provider.id,
        providerKind: provider.kind,
        accountId: provider.accountId ?? null,
        label: provider.name,
        ...(provider.accountLabel ? { accountLabel: provider.accountLabel } : {}),
      },
    ]
  })
}
