import type { IpcMainInvokeEvent } from 'electron'
import {
  getConversationMaestroConfig,
  getGlobalMaestroConfig,
  setConversationMaestroConfig,
  setGlobalMaestroConfig,
} from './maestro-config'
import type { MaestroOrchestratorProfileV1, MaestroStrategyProfileInput } from '../../shared/maestro'
import {
  createMaestroStrategyProfile,
  deleteMaestroStrategyProfile,
  listMaestroStrategyProfiles,
  updateMaestroStrategyProfile,
} from './maestro-strategy-profiles'

interface MaestroIpcDeps {
  mhandle: (channel: string, fn: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) => void
}

export function registerMaestroIpc(
  deps: MaestroIpcDeps,
  runtime: { getGlobalOrchestratorProfile: () => MaestroOrchestratorProfileV1 | null }
): void {
  deps.mhandle('chat:maestro:get-global', () => getGlobalMaestroConfig())
  deps.mhandle('chat:maestro:set-global', (_event, value: unknown) => setGlobalMaestroConfig(value))
  deps.mhandle('chat:maestro:get-conversation', (_event, conversationId: string) =>
    typeof conversationId === 'string' ? getConversationMaestroConfig(conversationId) : getGlobalMaestroConfig()
  )
  deps.mhandle('chat:maestro:set-conversation', (_event, conversationId: string, value: unknown | null) =>
    typeof conversationId === 'string'
      ? setConversationMaestroConfig(conversationId, value)
      : {
          ok: false,
          errors: [{ code: 'invalid-structure', message: 'Invalid conversation.', severity: 'error' }],
        }
  )
  deps.mhandle('chat:maestro:strategy-profiles:list', () =>
    listMaestroStrategyProfiles(runtime.getGlobalOrchestratorProfile())
  )
  deps.mhandle('chat:maestro:strategy-profiles:create', (_event, value: MaestroStrategyProfileInput) =>
    createMaestroStrategyProfile(value, runtime.getGlobalOrchestratorProfile())
  )
  deps.mhandle(
    'chat:maestro:strategy-profiles:update',
    (_event, id: string, value: MaestroStrategyProfileInput) =>
      updateMaestroStrategyProfile(id, value, runtime.getGlobalOrchestratorProfile())
  )
  deps.mhandle('chat:maestro:strategy-profiles:delete', (_event, id: string) => ({
    ok: deleteMaestroStrategyProfile(id),
    catalog: listMaestroStrategyProfiles(runtime.getGlobalOrchestratorProfile()),
  }))
}
