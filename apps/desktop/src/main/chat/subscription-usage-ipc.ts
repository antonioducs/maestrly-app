import {
  isChatSubscriptionProviderKind,
  type ChatSubscriptionProviderKind,
  type ChatSubscriptionUsage,
} from '../../shared/chat'
import { getSubscriptionAccount } from './catalog'
import { readSubscriptionUsage, type ReadSubscriptionUsageInput } from './subscription-usage'

type SubscriptionUsageHandler = (_event: any, ...args: any[]) => unknown

export interface SubscriptionUsageIpcDependencies {
  mhandle: (channel: string, handler: SubscriptionUsageHandler) => void
  readUsage?: (input: ReadSubscriptionUsageInput) => Promise<ChatSubscriptionUsage>
  accountKind?: (accountId: string) => ChatSubscriptionProviderKind | null
}

function normalizeAccountId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function accountKind(accountId: string): ChatSubscriptionProviderKind | null {
  return getSubscriptionAccount(accountId)?.kind ?? null
}

/** Registers only the official-quota IPC boundary so it is testable without starting the entire chat service. */
export function registerSubscriptionUsageIpc(dependencies: SubscriptionUsageIpcDependencies): void {
  const readUsage = dependencies.readUsage ?? readSubscriptionUsage
  const resolveAccountKind = dependencies.accountKind ?? accountKind

  dependencies.mhandle('chat:subscription-usage', async (_event, payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('invalid-subscription-usage-payload')
    }
    const record = payload as Record<string, unknown>
    const rawProviderKind = record.providerKind
    if (typeof rawProviderKind !== 'string' || !isChatSubscriptionProviderKind(rawProviderKind)) {
      throw new Error('invalid-subscription-provider')
    }
    const providerKind = rawProviderKind
    const accountId = normalizeAccountId(record.accountId)
    if (accountId && resolveAccountKind(accountId) !== providerKind) {
      return {
        state: 'error',
        providerKind,
        accountId,
        error: 'unknown-account',
      }
    }
    return readUsage({ providerKind, accountId, force: record.force === true })
  })
}
