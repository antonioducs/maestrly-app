import { ipcRenderer } from 'electron'
import type {
  InstalledPluginDto,
  PluginCatalogEntryDto,
  PluginConsentInput,
  PluginInspectionDto,
  PluginMarketplaceDto,
  PluginOpResult,
  PluginScope,
  PluginsStateDto,
} from '../shared/plugins'
import type { IpcTransport } from './ipc-transport'

// The transport parameter keeps Electron's name on purpose: see ipc-transport.ts.
export function makePluginsApi(ipcRenderer: IpcTransport) {
  return {
    pluginsState: (): Promise<PluginsStateDto> => ipcRenderer.invoke('chat:plugins:state'),
    pluginsCatalog: (marketplaceId: string): Promise<PluginOpResult<PluginCatalogEntryDto[]>> =>
      ipcRenderer.invoke('chat:plugins:catalog', marketplaceId),
    pluginsInspect: (input: { marketplaceId: string; name: string }): Promise<PluginOpResult<PluginInspectionDto>> =>
      ipcRenderer.invoke('chat:plugins:inspect', input),
    pluginsLogo: (input: { marketplaceId: string; name: string }): Promise<string | null> =>
      ipcRenderer.invoke('chat:plugins:logo', input),
    pluginsMarketplaceAdd: (input: {
      url: string
      ref?: string | null
      sparsePaths?: string[]
    }): Promise<PluginOpResult<PluginMarketplaceDto>> => ipcRenderer.invoke('chat:plugins:marketplace-add', input),
    pluginsMarketplaceRefresh: (id: string): Promise<PluginOpResult<PluginMarketplaceDto>> =>
      ipcRenderer.invoke('chat:plugins:marketplace-refresh', id),
    pluginsMarketplaceRemove: (input: { id: string; uninstall: boolean }): Promise<PluginOpResult> =>
      ipcRenderer.invoke('chat:plugins:marketplace-remove', input),
    pluginsInstall: (input: {
      marketplaceId: string
      name: string
      consent: PluginConsentInput
      scope: PluginScope
      inputs?: Record<string, string>
    }): Promise<PluginOpResult<InstalledPluginDto>> => ipcRenderer.invoke('chat:plugins:install', input),
    pluginsUpdate: (input: {
      key: string
      consent?: PluginConsentInput
    }): Promise<PluginOpResult<InstalledPluginDto>> => ipcRenderer.invoke('chat:plugins:update', input),
    pluginsSetEnabled: (input: { key: string; enabled: boolean }): Promise<PluginOpResult> =>
      ipcRenderer.invoke('chat:plugins:set-enabled', input),
    pluginsSetScope: (input: { key: string; scope: PluginScope }): Promise<PluginOpResult> =>
      ipcRenderer.invoke('chat:plugins:set-scope', input),
    pluginsSetServer: (input: {
      key: string
      serverKey: string
      enabled: boolean
      consent?: boolean
    }): Promise<PluginOpResult> => ipcRenderer.invoke('chat:plugins:set-server', input),
    pluginsSetInputs: (input: { key: string; values: Record<string, string | null> }): Promise<PluginOpResult> =>
      ipcRenderer.invoke('chat:plugins:set-inputs', input),
    pluginsUninstall: (input: { key: string; deleteData: boolean }): Promise<PluginOpResult> =>
      ipcRenderer.invoke('chat:plugins:uninstall', input),
  }
}

export const pluginsApi = makePluginsApi(ipcRenderer)
