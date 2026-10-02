import type { FleetEnvironmentSettingsService } from '@maestrly/bot-fleet-protocol'
import { getProvider, listAvailableChatProviders } from '../../../chat/catalog'
import { effectiveModelMeta, listChatProviderModels } from '../../../chat/service'
import { getHiddenChatModelsFor, setHiddenChatModels } from '../../../store/settings'
import { InstanceHttpError } from '../server'
import { settingsRevision, withSettingsRevision } from './revisions'

export interface SettingsBotUsage {
  id: string
  name: string
  selection?: { providerId: string; modelId: string } | null
  compaction?: { providerId: string; modelId: string } | null
}
export interface ModelsSettingsHost {
  bots(): SettingsBotUsage[]
  accountsChanged(): void
}
export function createModelsSettingsService(
  host: ModelsSettingsHost
): Pick<FleetEnvironmentSettingsService, 'models' | 'setModelFilter'> {
  const models: FleetEnvironmentSettingsService['models'] = async () => ({
    providers: await Promise.all(
      listAvailableChatProviders().map(async (provider) => {
        const ids = await listChatProviderModels(provider.id, { includeHidden: true }).catch(() => [] as string[])
        return {
          providerId: provider.id,
          name: provider.name,
          revision: settingsRevision('models:' + provider.id),
          hiddenModelIds: getHiddenChatModelsFor(provider.id),
          models: await Promise.all(
            ids.map(async (id) => {
              const { meta } = await effectiveModelMeta(id, provider.id).catch(() => ({ meta: null }))
              return {
                id,
                name: id,
                contextWindow: meta?.contextWindow ?? null,
                bots: host
                  .bots()
                  .filter((bot) =>
                    [bot.selection, bot.compaction].some(
                      (selection) => selection?.providerId === provider.id && selection.modelId === id
                    )
                  )
                  .map(({ id, name }) => ({ id, name })),
              }
            })
          ),
        }
      })
    ),
  })
  return {
    models,
    setModelFilter: async (input) => {
      await withSettingsRevision('models:' + input.providerId, input.expectedRevision, () => {
        if (!getProvider(input.providerId)) throw new InstanceHttpError(404, 'NOT_FOUND', 'Account does not exist.')
        setHiddenChatModels(input.providerId, input.hiddenModelIds)
      })
      host.accountsChanged()
      return models({})
    },
  }
}
