import type { FleetEnvironmentSettingsService, FleetPluginSettingsOperation } from '@maestrly/bot-fleet-protocol'
import type { PluginOpResult } from '../../../../shared/plugins'
import { forgetMcpOAuthChannel, mcpOAuthDescriptor, mcpOAuthStatuses, storeMcpOAuth } from '../../../chat/mcp-oauth-ipc'
import * as plugins from '../../../plugins/service'

/** An operation that returns nothing on success answers `{ ok: true }`, the protocol's strict empty result. */
const empty = (result: PluginOpResult): { ok: true } | Exclude<PluginOpResult, { ok: true }> =>
  result.ok ? { ok: true } : result

/**
 * The environment's plugins and MCP sign-ins, served by its own Maestrly: the same engine as the owner's computer,
 * which fetches from Git, checks and installs here. Every input was validated against the protocol on arrival.
 */
export const pluginSettingsService: Pick<FleetEnvironmentSettingsService, FleetPluginSettingsOperation> = {
  plugins: () => plugins.pluginsState(),
  pluginCatalog: ({ marketplaceId }) => plugins.catalog(marketplaceId),
  pluginInspect: (input) => plugins.inspect(input),
  pluginLogo: async (input) => ({ dataUrl: await plugins.logo(input) }),
  addPluginSource: (input) => plugins.addMarketplace(input),
  refreshPluginSource: ({ marketplaceId }) => plugins.refreshMarketplace(marketplaceId),
  removePluginSource: async ({ marketplaceId, uninstall }) =>
    empty(await plugins.removeMarketplace({ id: marketplaceId, uninstall })),
  installPlugin: (input) => plugins.install(input),
  bringPlugin: (input) => plugins.installPinned(input),
  updatePlugin: (input) => plugins.update(input),
  patchPlugin: async ({ key, enabled, scope, server, inputs }) =>
    empty(
      await (enabled !== undefined
        ? plugins.setEnabled({ key, enabled })
        : scope
          ? plugins.setScope({ key, scope })
          : server
            ? plugins.setServer({ key, ...server })
            : plugins.setInputs({ key, values: inputs ?? {} }))
    ),
  uninstallPlugin: async (input) => empty(await plugins.uninstall(input)),
  mcpOAuthStatuses: async () => ({ servers: mcpOAuthStatuses() }),
  mcpOAuthDescriptor: async ({ id }) => ({ descriptor: mcpOAuthDescriptor(id) }),
  setMcpOAuth: async ({ id, bundle }) => storeMcpOAuth(id, bundle),
  removeMcpOAuth: async ({ id }) => ({ removed: forgetMcpOAuthChannel(id).ok }),
}
