import { ipcRenderer } from 'electron'
import type { RuntimeAssetId, RuntimeAssetInfo } from '../shared/runtime-assets'

export const runtimeAssetsApi = {
  runtimeAssetStatus: (id: RuntimeAssetId): Promise<RuntimeAssetInfo> =>
    ipcRenderer.invoke('runtime-assets:status', id),
  runtimeAssetList: (): Promise<readonly RuntimeAssetInfo[]> => ipcRenderer.invoke('runtime-assets:list'),
  runtimeAssetInstall: (id: RuntimeAssetId): Promise<RuntimeAssetInfo> =>
    ipcRenderer.invoke('runtime-assets:install', id),
  runtimeAssetCancel: (id: RuntimeAssetId): Promise<boolean> => ipcRenderer.invoke('runtime-assets:cancel', id),
  runtimeAssetRepair: (id: RuntimeAssetId): Promise<RuntimeAssetInfo> =>
    ipcRenderer.invoke('runtime-assets:repair', id),
  runtimeAssetRemove: (id: RuntimeAssetId): Promise<RuntimeAssetInfo> =>
    ipcRenderer.invoke('runtime-assets:remove', id),
  onRuntimeAssetChanged: (callback: (info: RuntimeAssetInfo) => void): (() => void) => {
    const listener = (_event: unknown, info: RuntimeAssetInfo) => callback(info)
    ipcRenderer.on('runtime-assets:changed', listener)
    return () => ipcRenderer.removeListener('runtime-assets:changed', listener)
  },
}
