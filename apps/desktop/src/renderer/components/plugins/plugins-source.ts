import type { FleetEnvironmentSettingsClient } from '@maestrly/bot-fleet-protocol'
import type { HostApi } from '../../../preload'
import type { InstalledPluginDto, PluginConsentInput, PluginOpResult } from '../../../shared/plugins'
import type { McpAccountActions } from '../chat/mcp-account-actions'

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
  | 'pluginsSetHooks'
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
  /** Sign-in accounts of the source's MCP servers; absent for a host, whose own account actions apply. */
  mcpAccounts?: McpAccountActions
  /** Installs one of this computer's plugins here, at its exact version (bot environments only). */
  bring?(key: string): Promise<PluginOpResult<InstalledPluginDto>>
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
      pluginsSetHooks: (...args) => api.pluginsSetHooks(...args),
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

/** This computer's main-process actions on a bot environment's plugins (`window.api.fleetEnvironmentPlugins`). */
export interface EnvironmentPluginActions {
  bring(environmentId: string, key: string): Promise<PluginOpResult<InstalledPluginDto>>
  mcpOAuthConnect: (
    environmentId: string,
    serverId: string,
    options?: { accountId?: string; label?: string }
  ) => ReturnType<McpAccountActions['connect']>
  mcpOAuthCancel(environmentId: string, serverId: string): Promise<void>
}

const withHooks = (consent: PluginConsentInput) => ({ ...consent, hooks: consent.hooks ?? false })

/** An operation that returns nothing answers `{ ok: true }` over the protocol; the plugin center expects a value. */
const emptyResult = (result: { ok: true } | { ok: false; error: string; detail?: string }): PluginOpResult =>
  result.ok ? { ok: true, value: undefined } : (result as PluginOpResult)

/**
 * The plugins of a bot environment, through its settings operations: the environment fetches from Git and installs on
 * its own. Its plugins apply to all of its conversations; it has no projects of this computer to choose from.
 */
export function createEnvironmentPluginsSource(
  environmentId: string,
  settings: FleetEnvironmentSettingsClient,
  actions: EnvironmentPluginActions
): PluginsSource {
  const event = `maestrly:environment-plugins-changed:${environmentId}`
  return {
    remote: true,
    pluginsState: () => settings.plugins({}),
    pluginsCatalog: (marketplaceId) => settings.pluginCatalog({ marketplaceId }),
    pluginsInspect: (input) => settings.pluginInspect(input),
    pluginsLogo: async (input) => (await settings.pluginLogo(input)).dataUrl,
    pluginsMarketplaceAdd: (input) => settings.addPluginSource(input),
    pluginsMarketplaceRefresh: (marketplaceId) => settings.refreshPluginSource({ marketplaceId }),
    pluginsMarketplaceRemove: async ({ id, uninstall }) =>
      emptyResult(await settings.removePluginSource({ marketplaceId: id, uninstall })),
    // The environment needs an explicit answer about hooks: none means they stay off.
    pluginsInstall: (input) => settings.installPlugin({ ...input, consent: withHooks(input.consent) }),
    pluginsUpdate: ({ key, consent }) =>
      settings.updatePlugin({ key, ...(consent ? { consent: withHooks(consent) } : {}) }),
    pluginsSetEnabled: async ({ key, enabled }) => emptyResult(await settings.patchPlugin({ key, enabled })),
    pluginsSetScope: async ({ key, scope }) => emptyResult(await settings.patchPlugin({ key, scope })),
    pluginsSetServer: async ({ key, ...server }) => emptyResult(await settings.patchPlugin({ key, server })),
    pluginsSetInputs: async ({ key, values }) => emptyResult(await settings.patchPlugin({ key, inputs: values })),
    // The window showed the hooks and asked for consent before switching them on.
    pluginsSetHooks: async ({ key, enabled }) => emptyResult(await settings.patchPlugin({ key, hooks: enabled })),
    pluginsUninstall: async (input) => emptyResult(await settings.uninstallPlugin(input)),
    listProjects: async () => [],
    subscribe: (listener) => {
      window.addEventListener(event, listener)
      return () => window.removeEventListener(event, listener)
    },
    notifyChanged: () => window.dispatchEvent(new Event(event)),
    // An environment's accounts serve all of its conversations: no projects to scope them to.
    mcpAccounts: environmentMcpAccounts(environmentId, settings, actions),
    bring: (key) => actions.bring(environmentId, key),
  }
}

/** Sign-in accounts of a bot environment's MCP servers: the browser part on this computer, the accounts in it. */
export function environmentMcpAccounts(
  environmentId: string,
  settings: Pick<FleetEnvironmentSettingsClient, 'removeMcpOAuth' | 'patchMcpOAuthAccount' | 'setMcpOAuthClient'>,
  actions: Pick<EnvironmentPluginActions, 'mcpOAuthConnect' | 'mcpOAuthCancel'>
): McpAccountActions {
  return {
    connect: (serverId, options) =>
      actions.mcpOAuthConnect(environmentId, serverId, {
        ...(options?.accountId ? { accountId: options.accountId } : {}),
        ...(options?.label ? { label: options.label } : {}),
      }),
    cancel: (serverId) => actions.mcpOAuthCancel(environmentId, serverId),
    forget: (serverId, accountId) => settings.removeMcpOAuth({ id: serverId, ...(accountId ? { accountId } : {}) }),
    patchAccount: async (serverId, accountId, patch) =>
      patch.label === undefined
        ? { ok: false, error: 'invalid-input' }
        : settings.patchMcpOAuthAccount({ id: serverId, accountId, label: patch.label }),
    setClient: (serverId, client) => settings.setMcpOAuthClient({ id: serverId, client }),
  }
}
