import type { FleetEnvironmentSettingsService, FleetSubscriptionKind } from '@maestrly/bot-fleet-protocol'
import {
  getProvider,
  getProviderKind,
  subscriptionProviderIdFor,
  listProviders,
  listSubscriptionAccounts,
  renameDefaultSubscriptionAccount,
  renameSubscriptionAccount,
  updateProvider,
} from '../../../chat/catalog'
import { apiKeyStorageMode, clearApiKey, getApiKey, setApiKey } from '../../../chat/credentials'
import { invalidateModels } from '../../../chat/models'
import { invalidateProvider } from '../../../chat/provider'
import { listBotAccounts, refreshBotAccountStatus, SUBSCRIPTION_PROVIDER_KIND } from '../provisioning/accounts'
import { provisioningAccountBaseURL } from '../../../../shared/fleet-provisioning'
import { transaction } from '../../../store/db'
import { InstanceHttpError } from '../server'
import { observeSettingsRevision, withSettingsRevision } from './revisions'
import type { SettingsBotUsage } from './models'

export interface AccountsSettingsHost {
  bots(): SettingsBotUsage[]
  signingIn(): Array<{ kind: FleetSubscriptionKind; accountId: string | null }>
  accountsChanged(): void
  removeAccount(providerId: string): Promise<void>
  removeSubscription(kind: FleetSubscriptionKind, slot: string): Promise<void>
}
export function createAccountsSettingsService(
  host: AccountsSettingsHost
): Pick<
  FleetEnvironmentSettingsService,
  'accounts' | 'patchAccount' | 'renameSubscription' | 'removeAccount' | 'removeSubscription'
> {
  const observeRevision = () =>
    observeSettingsRevision('accounts', {
      providers: listProviders(),
      subscriptions: listBotAccounts({ signingIn: host.signingIn() }).subscriptions,
    })
  const accounts: FleetEnvironmentSettingsService['accounts'] = async () => {
    await refreshBotAccountStatus()
    const current = listBotAccounts({ signingIn: host.signingIn() })
    const usage = (providerId: string) =>
      host
        .bots()
        .filter((bot) => bot.selection?.providerId === providerId || bot.compaction?.providerId === providerId)
        .map(({ id, name }) => ({ id, name }))
    return {
      revision: observeRevision(),
      apiKeys: listProviders().map((provider) => ({
        providerId: provider.id,
        name: provider.name,
        kind: getProviderKind(provider),
        baseURL: provisioningAccountBaseURL(provider.baseURL),
        keyHint: current.apiKeys.find((account) => account.providerId === provider.id)?.keyHint ?? null,
        bots: usage(provider.id),
      })),
      subscriptions: current.subscriptions.map((account) => ({
        ...account,
        bots: usage(subscriptionProviderId(account.kind, account.accountId)),
      })),
    }
  }
  return {
    accounts,
    patchAccount: async (input) => {
      observeRevision()
      await withSettingsRevision('accounts', input.expectedRevision, () => {
        const previous = listProviders().find((provider) => provider.id === input.providerId)
        if (!previous) throw new InstanceHttpError(404, 'NOT_FOUND', 'Account does not exist.')
        if (apiKeyStorageMode() !== 'secure')
          throw new InstanceHttpError(409, 'CONFLICT', 'Secure credential storage is unavailable.')
        if (input.apiKey !== undefined && !input.apiKey.trim())
          throw new InstanceHttpError(400, 'INVALID_REQUEST', 'The API key is empty.')
        const baseURL =
          input.baseURL === null
            ? getProviderKind(previous) === 'anthropic'
              ? 'https://api.anthropic.com/v1'
              : 'https://api.openai.com/v1'
            : input.baseURL
        if (baseURL !== undefined && !/^https?:\/\//i.test(baseURL))
          throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Invalid provider configuration.')
        const previousKey = getApiKey(previous.id)
        let keyAttempted = false
        try {
          transaction(() => {
            if (input.apiKey !== undefined) {
              keyAttempted = true
              if (setApiKey(previous.id, input.apiKey) !== 'secure') throw new Error('Credential write failed')
            }
            updateProvider(previous.id, {
              ...(input.name !== undefined ? { name: input.name } : {}),
              ...(baseURL !== undefined ? { baseURL } : {}),
            })
          })
        } catch {
          if (keyAttempted) {
            try {
              if (previousKey !== null) setApiKey(previous.id, previousKey)
              else clearApiKey(previous.id)
            } catch {
              /* Report only a fixed error; credentials never leave this service. */
            }
          }
          throw new InstanceHttpError(409, 'CONFLICT', 'The account could not be saved.')
        }
        invalidateProvider(previous.id)
        invalidateModels(previous.id)
      })
      host.accountsChanged()
      return accounts({})
    },
    renameSubscription: async (input) => {
      observeRevision()
      await withSettingsRevision('accounts', input.expectedRevision, () => {
        const kind = SUBSCRIPTION_PROVIDER_KIND[input.kind]
        if (input.slot === null) renameDefaultSubscriptionAccount(kind, input.label)
        else {
          if (
            !listSubscriptionAccounts().some((account) => account.id === input.slot && account.kind === kind) ||
            !renameSubscriptionAccount(input.slot, input.label)
          )
            throw new InstanceHttpError(404, 'NOT_FOUND', 'Account does not exist.')
        }
      })
      host.accountsChanged()
      return accounts({})
    },
    removeAccount: async (input) => {
      observeRevision()
      return withSettingsRevision('accounts', input.expectedRevision, async () => {
        await host.removeAccount(input.providerId)
        return { removed: true }
      })
    },
    removeSubscription: async (input) => {
      observeRevision()
      return withSettingsRevision('accounts', input.expectedRevision, async () => {
        if (!getProvider(subscriptionProviderId(input.kind, input.slot)))
          throw new InstanceHttpError(404, 'NOT_FOUND', 'Account does not exist.')
        await host.removeSubscription(input.kind, input.slot ?? 'default')
        return { removed: true }
      })
    },
  }
}
function subscriptionProviderId(kind: FleetSubscriptionKind, slot: string | null): string {
  return subscriptionProviderIdFor(SUBSCRIPTION_PROVIDER_KIND[kind], slot)
}
