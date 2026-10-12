import os from 'node:os'
import type { FleetEnvironmentSettingsService, FleetPluginSettingsOperation } from '@maestrly/bot-fleet-protocol'
import type { PluginOpResult } from '../../../../shared/plugins'
import {
  forgetMcpOAuthChannel,
  mcpOAuthDescriptor,
  mcpOAuthStatuses,
  patchMcpOAuthAccountChannel,
  setMcpOAuthClientChannel,
  storeMcpOAuth,
} from '../../../chat/mcp-oauth-ipc'
import { listSkillsState, setSkillEnabledGlobal } from '../../../chat/skill-state'
import * as plugins from '../../../plugins/service'

/** An operation that returns nothing on success answers `{ ok: true }`, the protocol's strict empty result. */
const empty = (result: PluginOpResult): { ok: true } | Exclude<PluginOpResult, { ok: true }> =>
  result.ok ? { ok: true } : result

/** The skills and commands of the environment's enabled plugins, as its Skills settings show them. */
async function pluginSkillsOf(home: string) {
  return (await listSkillsState(undefined, home)).skills.flatMap((skill) =>
    skill.scope === 'plugin' && skill.plugin ? [{ ...skill, plugin: skill.plugin }] : []
  )
}

/**
 * The environment's plugins and MCP sign-ins, served by its own Maestrly: the same engine as the owner's computer,
 * which fetches from Git, checks and installs here. Every input was validated against the protocol on arrival. Home
 * injection is for synthetic tests only.
 */
export const createPluginSettingsService = (
  home = os.homedir()
): Pick<FleetEnvironmentSettingsService, FleetPluginSettingsOperation> => ({
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
  pluginSkills: async () => ({
    skills: (await pluginSkillsOf(home)).map((skill) => ({
      name: skill.name,
      description: skill.description.slice(0, 4096),
      kind: skill.plugin.kind,
      plugin: { key: skill.plugin.key, displayName: skill.plugin.displayName.slice(0, 200) },
      enabled: skill.enabledGlobally,
      modelInvocable: skill.modelInvocable,
      userInvocable: skill.userInvocable,
      resources: skill.resources,
    })),
  }),
  // A plugin's skill is switched like any skill (the global disable list); other skills have their own operation.
  setPluginSkillEnabled: async ({ name, enabled }) => {
    if (!(await pluginSkillsOf(home)).some((skill) => skill.name === name))
      return { ok: false, error: 'unknown-plugin' }
    setSkillEnabledGlobal(name, enabled)
    return { ok: true }
  },
  mcpOAuthStatuses: async () => ({ servers: mcpOAuthStatuses() }),
  mcpOAuthDescriptor: async ({ id, accountId }) => ({ descriptor: mcpOAuthDescriptor(id, accountId) }),
  // An environment's accounts serve all of its conversations: no project scope.
  setMcpOAuth: async ({ id, bundle, target }) => storeMcpOAuth(id, bundle, target),
  removeMcpOAuth: async ({ id, accountId }) => ({ removed: forgetMcpOAuthChannel(id, accountId).ok }),
  patchMcpOAuthAccount: async ({ id, accountId, label }) => patchMcpOAuthAccountChannel(id, accountId, { label }),
  setMcpOAuthClient: async ({ id, client }) =>
    setMcpOAuthClientChannel(id, client).ok ? { ok: true } : { ok: false, error: 'storage' },
})
