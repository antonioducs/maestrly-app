import type { RuntimeAssetId, RuntimeAssetInfo, UpdatableRuntimeAssetId } from '../../shared/runtime-assets'
import { isUpdatableRuntimeAssetId } from '../../shared/runtime-assets'
import type { IpcRegistrar } from '../ipc-registrar'
import { runtimeAssetInfo, runtimeAssetService, runtimeUpdates, setRuntimeAssetChangedEmitter } from './app-service'
import type { RuntimeUpdateController } from './runtime-updates'
import { isListedRuntimeAssetId, listedRuntimeAssetIds } from './visibility'

export interface RuntimeAssetIpcDependencies {
  readonly emitChanged: (info: RuntimeAssetInfo) => void
}

/** Bot-only runtimes are unknown outside bots, exactly like an id that does not exist. */
function assetId(value: unknown): RuntimeAssetId {
  if (!isListedRuntimeAssetId(value)) throw new Error('Unknown runtime asset id')
  return value
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

  const updateOperation = (rawId: unknown, run: (controller: RuntimeUpdateController) => Promise<unknown>) =>
    operation(rawId, () => run(runtimeUpdates(updatableAssetId(rawId))), updatableAssetId)

  reg.handle('runtime-assets:status', async (_event, id) => runtimeAssetInfo(assetId(id)))
  reg.handle('runtime-assets:list', () => Promise.all(listedRuntimeAssetIds().map(runtimeAssetInfo)))
  reg.mhandle('runtime-assets:install', (_event, id) =>
    operation(id, (valid) =>
      // Updatable runtimes first install the latest validated stable release, falling back to the embedded pin.
      isUpdatableRuntimeAssetId(valid) ? runtimeUpdates(valid).installInitial() : service.install(valid)
    )
  )
  reg.mhandle('runtime-assets:repair', (_event, id) => operation(id, (valid) => service.repair(valid)))
  reg.mhandle('runtime-assets:remove', (_event, id) =>
    operation(id, async (valid) => {
      await service.remove(valid)
      if (isUpdatableRuntimeAssetId(valid)) await runtimeUpdates(valid).prune()
    })
  )
  reg.mhandle('runtime-assets:cancel', async (_event, rawId) => {
    const id = assetId(rawId)
    const installCancelled = service.cancel(id)
    const updateCancelled = isUpdatableRuntimeAssetId(id) ? runtimeUpdates(id).cancel() : false
    await emit(id)
    return installCancelled || updateCancelled
  })
  reg.mhandle('runtime-assets:check-update', (_event, id) => updateOperation(id, (updates) => updates.check(true)))
  reg.mhandle('runtime-assets:update', (_event, id) => updateOperation(id, (updates) => updates.update()))
  reg.mhandle('runtime-assets:rollback', (_event, id) => updateOperation(id, (updates) => updates.rollback()))
  reg.mhandle('runtime-assets:set-auto-update', (_event, rawId, enabled) => {
    updatableAssetId(rawId)
    const automatic = booleanArgument(enabled)
    return updateOperation(rawId, (updates) => updates.setAutomatic(automatic))
  })
}
