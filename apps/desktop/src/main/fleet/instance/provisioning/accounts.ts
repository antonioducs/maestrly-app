import type {
  FleetAccountImportItem,
  FleetBotAccounts,
  FleetImportResults,
  FleetSubscriptionKind,
} from '@maestrly/bot-fleet-protocol'
import type { ChatSubscriptionProviderKind } from '../../../../shared/chat'
import {
  addProvider,
  addSubscriptionAccount,
  getProviderKind,
  listAvailableChatProviders,
  listProviders,
  listSubscriptionAccounts,
  removeProvider,
  subscriptionProviderIdFor,
} from '../../../chat/catalog'
import { apiKeyStorageMode, clearApiKey, getApiKey, setApiKey } from '../../../chat/credentials'
import { invalidateProvider } from '../../../chat/provider'
import { invalidateModels } from '../../../chat/models'
import { removeSubscriptionAccountSlot } from '../../../chat/service'
import { getCodexSubscriptionManager } from '../../../chat/codex-subscription/manager'
import { getClaudeSubscriptionManager } from '../../../chat/claude-agent-sdk/manager'
import { getGrokSubscriptionManager } from '../../../chat/grok-subscription/manager'
import { getGitHubCopilotSubscriptionManager } from '../../../chat/github-copilot/manager'
import { getCursorSubscriptionManager } from '../../../chat/cursor-subscription/manager'
import { InstanceHttpError } from '../server'

export const SUBSCRIPTION_PROVIDER_KIND: Record<FleetSubscriptionKind, ChatSubscriptionProviderKind> = {
  codex: 'codex-subscription',
  claude: 'claude-subscription',
  grok: 'grok-subscription',
  'github-copilot': 'github-copilot-subscription',
  cursor: 'cursor-subscription',
}
function cachedAccount(kind: FleetSubscriptionKind, id: string | null): { email: string | null; plan: string | null } {
  switch (kind) {
    case 'codex': {
      const account = getCodexSubscriptionManager(id).peekStatus()?.account
      return {
        email: account?.type === 'chatgpt' ? account.email : null,
        plan: account?.type === 'chatgpt' ? account.planType : null,
      }
    }
    case 'claude': {
      const account = getClaudeSubscriptionManager(id).peekStatus()?.account
      return { email: account?.email ?? null, plan: account?.subscriptionType ?? null }
    }
    case 'grok': {
      const account = getGrokSubscriptionManager(id).getStatusSnapshot()?.account
      return { email: account?.email ?? null, plan: account?.planType ?? null }
    }
    case 'github-copilot':
      getGitHubCopilotSubscriptionManager(id).peekStatus()
      return { email: null, plan: null }
    case 'cursor':
      return { email: getCursorSubscriptionManager(id).peekStatus()?.account?.email ?? null, plan: null }
  }
}
export function listBotAccounts(input: {
  connectedProviderIds: ReadonlySet<string>
  signingIn: ReadonlyArray<{ kind: FleetSubscriptionKind; accountId: string | null }>
}): FleetBotAccounts {
  const apiKeys: FleetBotAccounts['apiKeys'] = []
  for (const provider of listProviders()) {
    const key = getApiKey(provider.id)
    const kind = getProviderKind(provider)
    if (key && (kind === 'anthropic' || kind === 'openai' || kind === 'openai-responses'))
      apiKeys.push({
        providerId: provider.id,
        name: provider.name,
        kind,
        baseURL: provider.baseURL ?? null,
        keyHint: key.slice(-4),
      })
  }
  const subscriptions: FleetBotAccounts['subscriptions'] = []
  const providers = listAvailableChatProviders()
  for (const kind of Object.keys(SUBSCRIPTION_PROVIDER_KIND) as FleetSubscriptionKind[]) {
    const providerKind = SUBSCRIPTION_PROVIDER_KIND[kind]
    const slots = [
      null,
      ...listSubscriptionAccounts()
        .filter((slot) => slot.kind === providerKind)
        .map((slot) => slot.id),
    ]
    for (const accountId of slots) {
      const providerId = subscriptionProviderIdFor(providerKind, accountId)
      const connected = input.connectedProviderIds.has(providerId)
      const signingIn = input.signingIn.some((slot) => slot.kind === kind && slot.accountId === accountId)
      if (!accountId && !connected && !signingIn) continue
      subscriptions.push({
        kind,
        accountId,
        label: providers.find((provider) => provider.id === providerId)?.name ?? kind,
        ...cachedAccount(kind, accountId),
        state: signingIn ? 'signing-in' : connected ? 'connected' : 'signed-out',
      })
    }
  }
  return { apiKeys, subscriptions }
}
const normalizedUrl = (url: string): string => new URL(url).toString().replace(/\/+$/, '')
const secureError = 'Secure credential storage is unavailable.'
export async function cleanupBotSubscriptionSlot(id: string): Promise<void> {
  const result = await removeSubscriptionAccountSlot(id)
  if (!result.ok) throw new InstanceHttpError(409, 'CONFLICT', 'The account could not be removed.')
}
async function importAccount(
  item: FleetAccountImportItem
): Promise<{ target: string; outcome: 'added' | 'updated' | 'unchanged' }> {
  if (apiKeyStorageMode() !== 'secure') throw new Error(secureError)
  if (item.type === 'api-key') {
    const baseURL = normalizedUrl(
      item.baseURL ?? (item.kind === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1')
    )
    const candidates = listProviders().filter(
      (provider) =>
        getProviderKind(provider) === item.kind && provider.baseURL && normalizedUrl(provider.baseURL) === baseURL
    )
    const same = candidates.find((provider) => getApiKey(provider.id) === item.key)
    if (same) return { target: same.id, outcome: 'unchanged' }
    const existing = candidates.find((provider) => provider.name === item.name)
    const provider = existing ?? addProvider({ name: item.name, kind: item.kind, baseURL })
    const previous = existing ? getApiKey(existing.id) : null
    try {
      if (setApiKey(provider.id, item.key) !== 'secure') throw new Error(secureError)
    } catch (error) {
      if (existing && previous) setApiKey(provider.id, previous)
      else {
        clearApiKey(provider.id)
        if (!existing) removeProvider(provider.id)
      }
      throw error
    }
    invalidateProvider(provider.id)
    invalidateModels(provider.id)
    return { target: provider.id, outcome: existing ? 'updated' : 'added' }
  }
  const kind = SUBSCRIPTION_PROVIDER_KIND[item.type]
  const slots = [
    null,
    ...listSubscriptionAccounts()
      .filter((slot) => slot.kind === kind)
      .map((slot) => slot.id),
  ]
  const expiresAtMs = item.type === 'cursor' && item.expiresAt ? Date.parse(item.expiresAt) : null
  const credential = (id: string | null) =>
    item.type === 'github-copilot'
      ? getGitHubCopilotSubscriptionManager(id).exportToken()
      : getCursorSubscriptionManager(id).exportCredential()
  for (const id of slots) {
    const stored = credential(id)
    if (
      item.type === 'github-copilot'
        ? stored === item.token
        : typeof stored === 'object' &&
          stored !== null &&
          stored.apiKey === item.apiKey &&
          stored.expiresAtMs === expiresAtMs
    )
      return { target: item.type + ':' + (id ?? 'default'), outcome: 'unchanged' }
  }
  const accountId = credential(null) === null ? null : addSubscriptionAccount(kind, item.label).id
  try {
    if (item.type === 'github-copilot')
      await getGitHubCopilotSubscriptionManager(accountId).admitToken(item.token, { requireSecure: true })
    else await getCursorSubscriptionManager(accountId).admitApiKey(item.apiKey, { expiresAtMs, requireSecure: true })
  } catch (error) {
    if (accountId) await cleanupBotSubscriptionSlot(accountId)
    throw error
  }
  return { target: item.type + ':' + (accountId ?? 'default'), outcome: 'added' }
}
export async function importBotAccounts(items: readonly FleetAccountImportItem[]): Promise<FleetImportResults> {
  const results: FleetImportResults['results'] = []
  for (const [index, item] of items.entries()) {
    try {
      results.push({ index, ...(await importAccount(item)), error: null })
    } catch (error) {
      const secret = item.type === 'api-key' ? item.key : item.type === 'cursor' ? item.apiKey : item.token
      const message = error instanceof Error ? error.message : 'The account could not be imported.'
      results.push({
        index,
        target: null,
        outcome: 'failed',
        error: message.split(secret).join('[redacted]').slice(0, 300),
      })
    }
  }
  return { results }
}
export async function removeBotSubscription(kind: FleetSubscriptionKind, slot: string): Promise<void> {
  const providerKind = SUBSCRIPTION_PROVIDER_KIND[kind]
  if (slot !== 'default') {
    if (!listSubscriptionAccounts().some((account) => account.id === slot && account.kind === providerKind))
      throw new InstanceHttpError(404, 'NOT_FOUND', 'Account does not exist.')
    await cleanupBotSubscriptionSlot(slot)
  } else {
    switch (kind) {
      case 'codex':
        await getCodexSubscriptionManager(null).logout()
        break
      case 'claude':
        await getClaudeSubscriptionManager(null).logout()
        break
      case 'grok':
        await getGrokSubscriptionManager(null).logout()
        break
      case 'github-copilot':
        await getGitHubCopilotSubscriptionManager(null).logout()
        break
      case 'cursor':
        await getCursorSubscriptionManager(null).logout()
        break
    }
  }
  const providerId = subscriptionProviderIdFor(providerKind, slot === 'default' ? null : slot)
  invalidateProvider(providerId)
  invalidateModels(providerId)
}
