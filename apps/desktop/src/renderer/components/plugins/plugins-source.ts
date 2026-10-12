import type { HostApi } from '../../../preload'

export const PLUGINS_CHANGED_EVENT = 'maestrly:plugins-changed'
export const SKILLS_CHANGED_EVENT = 'maestrly:skills-changed'

type PluginMethods =
  | 'pluginsState'
  | 'pluginsCatalog'
  | 'pluginsInspect'
  | 'pluginsLogo'
  | 'pluginsMarketplaceAdd'
  | 'pluginsMarketplaceRefresh'
  | 'pluginsMarketplaceRemove'
  | 'pluginsInstall'
  | 'pluginsUpdate'
  | 'pluginsSetEnabled'
  | 'pluginsSetScope'
  | 'pluginsSetServer'
  | 'pluginsSetInputs'
  | 'pluginsUninstall'

/**
 * Where the plugin center reads and writes: a host's own profile (this computer or a remote workspaces host), or a bot
 * environment through its settings operations. `remote` is true only for bot environments.
 */
export type PluginsSource = Pick<HostApi, PluginMethods> & {
  remote: boolean
  listProjects(): Promise<{ id: string; name: string }[]>
  subscribe(listener: () => void): () => void
  /** Plugins also change the skills and MCP tools that menus and settings show. */
  notifyChanged(): void
}

const hostSources = new WeakMap<HostApi, PluginsSource>()

/** The plugins of a host's own profile, through that host's API: one source per host, the same on every call. */
export function hostPluginsSource(api: HostApi): PluginsSource {
  let source = hostSources.get(api)
  if (!source) {
    source = {
      remote: false,
      pluginsState: (...args) => api.pluginsState(...args),
      pluginsCatalog: (...args) => api.pluginsCatalog(...args),
      pluginsInspect: (...args) => api.pluginsInspect(...args),
      pluginsLogo: (...args) => api.pluginsLogo(...args),
      pluginsMarketplaceAdd: (...args) => api.pluginsMarketplaceAdd(...args),
      pluginsMarketplaceRefresh: (...args) => api.pluginsMarketplaceRefresh(...args),
      pluginsMarketplaceRemove: (...args) => api.pluginsMarketplaceRemove(...args),
      pluginsInstall: (...args) => api.pluginsInstall(...args),
      pluginsUpdate: (...args) => api.pluginsUpdate(...args),
      pluginsSetEnabled: (...args) => api.pluginsSetEnabled(...args),
      pluginsSetScope: (...args) => api.pluginsSetScope(...args),
      pluginsSetServer: (...args) => api.pluginsSetServer(...args),
      pluginsSetInputs: (...args) => api.pluginsSetInputs(...args),
      pluginsUninstall: (...args) => api.pluginsUninstall(...args),
      listProjects: async () =>
        (await api.listWorkspaces()).map((workspace) => ({ id: workspace.id, name: workspace.name })),
      subscribe: (listener) => {
        window.addEventListener(PLUGINS_CHANGED_EVENT, listener)
        return () => window.removeEventListener(PLUGINS_CHANGED_EVENT, listener)
      },
      notifyChanged: () => {
        window.dispatchEvent(new Event(PLUGINS_CHANGED_EVENT))
        window.dispatchEvent(new Event(SKILLS_CHANGED_EVENT))
      },
    }
    hostSources.set(api, source)
  }
  return source
}
