import {
  supportsSubscriptionUsage,
  type ChatConfig,
  type ChatSubscriptionUsageProviderKind,
} from '../../../shared/chat'

export type QuickUsageProviderKind = ChatSubscriptionUsageProviderKind

export interface QuickUsageTarget {
  providerId: string
  providerKind: QuickUsageProviderKind
  accountId: string | null
  label: string
  accountLabel?: string
}

export function connectedQuickUsageTargets(config: Pick<ChatConfig, 'providers'>): QuickUsageTarget[] {
  return config.providers.flatMap((provider) => {
    if (provider.connected !== true || !supportsSubscriptionUsage(provider.kind)) {
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
