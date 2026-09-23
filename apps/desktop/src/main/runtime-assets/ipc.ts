import type { RuntimeAssetId, RuntimeAssetInfo, UpdatableRuntimeAssetId } from '../../shared/runtime-assets'
import { RUNTIME_ASSET_IDS, isUpdatableRuntimeAssetId } from '../../shared/runtime-assets'
import type { IpcRegistrar } from '../ipc-registrar'
import {
  codexRuntimeUpdates,
  runtimeAssetInfo,
  runtimeAssetService,
  setRuntimeAssetChangedEmitter,
} from './app-service'

export interface RuntimeAssetIpcDependencies {
  readonly emitChanged: (info: RuntimeAssetInfo) => void
}

function assetId(value: unknown): RuntimeAssetId {
  if (typeof value !== 'string' || !RUNTIME_ASSET_IDS.includes(value as RuntimeAssetId)) {
    throw new Error('Unknown runtime asset id')
  }
  return value as RuntimeAssetId
}

/** Release operations accept only an asset id; URLs, hashes, and paths are always chosen by the main process. */
function updatableAssetId(value: unknown): UpdatableRuntimeAssetId {
  const id = assetId(value)
  if (!isUpdatableRuntimeAssetId(id)) throw new Error(`Runtime asset updates are not supported for ${id}`)
  return id
}

function booleanArgument(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Expected a boolean')
  return value
}

export function registerRuntimeAssetIpc(reg: IpcRegistrar, dependencies: RuntimeAssetIpcDependencies): void {
  setRuntimeAssetChangedEmitter(dependencies.emitChanged)
  const service = runtimeAssetService()
  const emit = async (id: RuntimeAssetId) => dependencies.emitChanged(await runtimeAssetInfo(id))
  const operation = async (
    rawId: unknown,
    run: (id: RuntimeAssetId) => Promise<unknown>,
    validateId: (value: unknown) => RuntimeAssetId = assetId
  ): Promise<RuntimeAssetInfo> => {
    const id = validateId(rawId)
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
  reg.mhandle('runtime-assets:install', (_event, id) =>
    operation(id, (valid) =>
      // Codex first installs prefer the latest validated stable release, falling back to the embedded pin.
      isUpdatableRuntimeAssetId(valid) ? codexRuntimeUpdates().installInitial() : service.install(valid)
    )
  )
  reg.mhandle('runtime-assets:repair', (_event, id) => operation(id, (valid) => service.repair(valid)))
  reg.mhandle('runtime-assets:remove', (_event, id) =>
    operation(id, async (valid) => {
      await service.remove(valid)
      if (isUpdatableRuntimeAssetId(valid)) await codexRuntimeUpdates().prune()
    })
  )
  reg.mhandle('runtime-assets:cancel', async (_event, rawId) => {
    const id = assetId(rawId)
    const installCancelled = service.cancel(id)
    const updateCancelled = isUpdatableRuntimeAssetId(id) ? codexRuntimeUpdates().cancel() : false
    await emit(id)
    return installCancelled || updateCancelled
  })
  reg.mhandle('runtime-assets:check-update', (_event, id) =>
    operation(id, () => codexRuntimeUpdates().check(true), updatableAssetId)
  )
  reg.mhandle('runtime-assets:update', (_event, id) =>
    operation(id, () => codexRuntimeUpdates().update(), updatableAssetId)
  )
  reg.mhandle('runtime-assets:rollback', (_event, id) =>
    operation(id, () => codexRuntimeUpdates().rollback(), updatableAssetId)
  )
  reg.mhandle('runtime-assets:set-auto-update', (_event, rawId, enabled) => {
    const id = updatableAssetId(rawId)
    const automatic = booleanArgument(enabled)
    return operation(id, () => codexRuntimeUpdates().setAutomatic(automatic), updatableAssetId)
  })
}
