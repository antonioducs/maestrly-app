import type { RuntimeAssetId, RuntimeAssetInfo } from '../../shared/runtime-assets'
import { RUNTIME_ASSET_IDS } from '../../shared/runtime-assets'
import type { IpcRegistrar } from '../ipc-registrar'
import { runtimeAssetInfo, runtimeAssetService, setRuntimeAssetChangedEmitter } from './app-service'

export interface RuntimeAssetIpcDependencies {
  readonly emitChanged: (info: RuntimeAssetInfo) => void
}

function assetId(value: unknown): RuntimeAssetId {
  if (typeof value !== 'string' || !RUNTIME_ASSET_IDS.includes(value as RuntimeAssetId)) {
    throw new Error('Unknown runtime asset id')
  }
  return value as RuntimeAssetId
}

export function registerRuntimeAssetIpc(reg: IpcRegistrar, dependencies: RuntimeAssetIpcDependencies): void {
  setRuntimeAssetChangedEmitter(dependencies.emitChanged)
  const service = runtimeAssetService()
  const emit = async (id: RuntimeAssetId) => dependencies.emitChanged(await runtimeAssetInfo(id))
  const operation = async (
    rawId: unknown,
    run: (id: RuntimeAssetId) => Promise<unknown>
  ): Promise<RuntimeAssetInfo> => {
    const id = assetId(rawId)
    try {
      await run(id)
      const info = await runtimeAssetInfo(id)
      dependencies.emitChanged(info)
      return info
    } catch (error) {
      dependencies.emitChanged(await runtimeAssetInfo(id))
      throw error
    }
  }

  reg.handle('runtime-assets:status', async (_event, id) => runtimeAssetInfo(assetId(id)))
  reg.handle('runtime-assets:list', () => Promise.all(RUNTIME_ASSET_IDS.map(runtimeAssetInfo)))
  reg.mhandle('runtime-assets:install', (_event, id) => operation(id, (valid) => service.install(valid)))
  reg.mhandle('runtime-assets:repair', (_event, id) => operation(id, (valid) => service.repair(valid)))
  reg.mhandle('runtime-assets:remove', (_event, id) => operation(id, (valid) => service.remove(valid)))
  reg.mhandle('runtime-assets:cancel', async (_event, rawId) => {
    const id = assetId(rawId)
    const cancelled = service.cancel(id)
    await emit(id)
    return cancelled
  })
}
