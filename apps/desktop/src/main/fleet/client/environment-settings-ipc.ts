import {
  FLEET_ACCOUNT_FAILOVER_FEATURE,
  FLEET_ENVIRONMENT_PLUGINS_FEATURE,
  FLEET_MCP_TEST_DETAIL_FEATURE,
  FLEET_SETTINGS_OPERATIONS,
  FLEET_ENVIRONMENT_SETTINGS_FEATURE,
  fleetEnvironmentIdSchema,
  fleetMcpOAuthTargetSchema,
  fleetMcpServerIdSchema,
  fleetPluginKeySchema,
  fleetSettingsRouteKey,
  type FleetPluginSettingsOperation,
  type FleetSettingsMainOnlyOperation,
} from '@maestrly/bot-fleet-protocol'
import type { McpOAuthConnectResult } from '../../../shared/chat'
import type { InstalledPluginDto, PluginOpResult } from '../../../shared/plugins'
import type { McpOAuthBundle, McpOAuthDescriptor } from '../../chat/mcp-oauth'
import { cancelMcpOAuth, connectMcpOAuth, type McpOAuthStoreResult } from '../../chat/mcp-oauth-ipc'
import type { IpcRegistrar } from '../../ipc-registrar'
import type { FleetApiClient } from './api'
import { pluginBringPayload } from './environment-plugins'

interface SettingsClient {
  hasFeature(feature: string): boolean
  getSnapshot(): { environments: Array<{ id: string; capabilities: string[] }> }
  call(key: Parameters<FleetApiClient['call']>[0], options?: Parameters<FleetApiClient['call']>[1]): Promise<unknown>
}
import { FleetClientError } from './api'

export function registerFleetEnvironmentSettingsIpc(reg: IpcRegistrar, fleet: SettingsClient): void {
  function target(raw: unknown, feature: string = FLEET_ENVIRONMENT_SETTINGS_FEATURE): string {
    const id = fleetEnvironmentIdSchema.parse(raw)
    if (!fleet.hasFeature(FLEET_ENVIRONMENT_SETTINGS_FEATURE) || !fleet.hasFeature(feature))
      throw new FleetClientError('CONFLICT', 409, 'Gateway does not support environment settings.')
    const environment = fleet.getSnapshot().environments.find((value) => value.id === id)
    if (!environment) throw new FleetClientError('NOT_FOUND', 404, 'Environment not found.')
    if (
      !environment.capabilities.includes(FLEET_ENVIRONMENT_SETTINGS_FEATURE) ||
      !environment.capabilities.includes(feature)
    )
      throw new FleetClientError('CONFLICT', 409, 'Environment does not support settings. Restart it to update.')
    return id
  }
  /** Plugins need the gateway and the environment to support them; an older one asks to be updated. */
  function pluginTarget(raw: unknown): string {
    const eid = target(raw)
    if (!fleet.hasFeature(FLEET_ENVIRONMENT_PLUGINS_FEATURE))
      throw new FleetClientError('CONFLICT', 409, 'Gateway does not support plugins. Update the bot server.')
    const environment = fleet.getSnapshot().environments.find((value) => value.id === eid)
    if (!environment?.capabilities.includes(FLEET_ENVIRONMENT_PLUGINS_FEATURE))
      throw new FleetClientError('CONFLICT', 409, 'Environment does not support plugins. Update it.')
    return eid
  }
  /** Forwards one plugin operation: path identifiers come from the validated input, reads send no body. */
  const forward =
    (operation: Exclude<FleetPluginSettingsOperation, FleetSettingsMainOnlyOperation>) =>
    async (_event: unknown, rawId: unknown, rawInput: unknown) => {
      const eid = pluginTarget(rawId)
      const { method, path, input: schema, response } = FLEET_SETTINGS_OPERATIONS[operation]
      const input = schema.parse(rawInput ?? {}) as Record<string, unknown>
      const params = Object.fromEntries(
        [...path.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)].map(([, name]) => [name, String(input[name])])
      )
      return response.parse(
        await fleet.call(fleetSettingsRouteKey(operation), {
          params: { eid, ...params },
          ...(method === 'GET' ? {} : { body: input }),
        })
      )
    }
  // `bringPlugin`, `setMcpOAuth` and `mcpOAuthDescriptor` have no channel: their inputs or outputs (plugin values,
  // tokens, the own OAuth client's secret) stay in this process.
  reg.handle('fleet:settings:plugins', forward('plugins'))
  reg.handle('fleet:settings:pluginCatalog', forward('pluginCatalog'))
  reg.handle('fleet:settings:pluginInspect', forward('pluginInspect'))
  reg.handle('fleet:settings:pluginLogo', forward('pluginLogo'))
  reg.mhandle('fleet:settings:addPluginSource', forward('addPluginSource'))
  reg.mhandle('fleet:settings:refreshPluginSource', forward('refreshPluginSource'))
  reg.mhandle('fleet:settings:removePluginSource', forward('removePluginSource'))
  reg.mhandle('fleet:settings:installPlugin', forward('installPlugin'))
  reg.mhandle('fleet:settings:updatePlugin', forward('updatePlugin'))
  reg.mhandle('fleet:settings:patchPlugin', forward('patchPlugin'))
  reg.mhandle('fleet:settings:uninstallPlugin', forward('uninstallPlugin'))
  reg.handle('fleet:settings:pluginSkills', forward('pluginSkills'))
  reg.mhandle('fleet:settings:setPluginSkillEnabled', forward('setPluginSkillEnabled'))
  reg.handle('fleet:settings:mcpOAuthStatuses', forward('mcpOAuthStatuses'))
  reg.mhandle('fleet:settings:removeMcpOAuth', forward('removeMcpOAuth'))
  reg.mhandle('fleet:settings:patchMcpOAuthAccount', forward('patchMcpOAuthAccount'))
  reg.mhandle('fleet:settings:setMcpOAuthClient', forward('setMcpOAuthClient'))
  // Bringing a plugin sends the values entered on this computer: the payload is built here, never in a renderer.
  reg.mhandle(
    'fleet:plugins:bring',
    async (_event, rawId: unknown, rawKey: unknown): Promise<PluginOpResult<InstalledPluginDto>> => {
      const eid = pluginTarget(rawId)
      const payload = pluginBringPayload(fleetPluginKeySchema.parse(rawKey))
      if (!payload.ok) return payload
      return FLEET_SETTINGS_OPERATIONS.bringPlugin.response.parse(
        await fleet.call('settingsBringPlugin', { params: { eid }, body: payload.value })
      ) as PluginOpResult<InstalledPluginDto>
    }
  )
  // Signing in to an environment's MCP server: this computer's browser, the environment keeps the result.
  reg.mhandle(
    'fleet:mcp-oauth:connect',
    async (_event, rawId: unknown, rawServerId: unknown, rawOptions?: unknown): Promise<McpOAuthConnectResult> => {
      const eid = pluginTarget(rawId)
      const serverId = fleetMcpServerIdSchema.parse(rawServerId)
      // An environment's accounts serve all of its conversations: an account to sign in again, or a label.
      const options = fleetMcpOAuthTargetSchema.parse(rawOptions ?? {})
      return connectMcpOAuth(
        {
          descriptor: async (id, accountId) =>
            FLEET_SETTINGS_OPERATIONS.mcpOAuthDescriptor.response.parse(
              await fleet.call('settingsMcpOAuthDescriptor', {
                params: { eid, id },
                body: { id, ...(accountId ? { accountId } : {}) },
              })
            ).descriptor as McpOAuthDescriptor | null,
          store: async (id, bundle: McpOAuthBundle, target) =>
            FLEET_SETTINGS_OPERATIONS.setMcpOAuth.response.parse(
              await fleet.call('settingsSetMcpOAuth', {
                params: { eid, id },
                body: {
                  id,
                  bundle,
                  target: {
                    ...(target.accountId ? { accountId: target.accountId } : {}),
                    ...(target.label ? { label: target.label } : {}),
                  },
                },
              })
            ) as McpOAuthStoreResult,
        },
        `environment:${eid}`,
        serverId,
        options
      )
    }
  )
  reg.mhandle('fleet:mcp-oauth:cancel', (_event, rawId: unknown, rawServerId: unknown) => {
    const eid = fleetEnvironmentIdSchema.parse(rawId)
    cancelMcpOAuth(`environment:${eid}`, fleetMcpServerIdSchema.parse(rawServerId))
  })
  reg.handle('fleet:settings:accounts', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    FLEET_SETTINGS_OPERATIONS.accounts.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.accounts.response.parse(await fleet.call('settingsAccounts', { params: { eid } }))
  })
  reg.mhandle('fleet:settings:patchAccount', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.patchAccount.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.patchAccount.response.parse(
      await fleet.call('settingsPatchAccount', { params: { eid, providerId: input.providerId }, body: input })
    )
  })
  reg.mhandle('fleet:settings:renameSubscription', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.renameSubscription.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.renameSubscription.response.parse(
      await fleet.call('settingsRenameSubscription', {
        params: { eid, kind: input.kind, slot: input.slot ?? 'default' },
        body: input,
      })
    )
  })
  reg.mhandle('fleet:settings:removeAccount', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.removeAccount.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.removeAccount.response.parse(
      await fleet.call('settingsRemoveAccount', { params: { eid, providerId: input.providerId }, body: input })
    )
  })
  reg.mhandle('fleet:settings:removeSubscription', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.removeSubscription.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.removeSubscription.response.parse(
      await fleet.call('settingsRemoveSubscription', {
        params: { eid, kind: input.kind, slot: input.slot ?? 'default' },
        body: input,
      })
    )
  })
  reg.handle('fleet:settings:models', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    FLEET_SETTINGS_OPERATIONS.models.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.models.response.parse(await fleet.call('settingsModels', { params: { eid } }))
  })
  reg.mhandle('fleet:settings:setModelFilter', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.setModelFilter.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.setModelFilter.response.parse(
      await fleet.call('settingsSetModelFilter', { params: { eid, providerId: input.providerId }, body: input })
    )
  })
  reg.handle('fleet:settings:skills', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    FLEET_SETTINGS_OPERATIONS.skills.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.skills.response.parse(await fleet.call('settingsSkills', { params: { eid } }))
  })
  reg.handle('fleet:settings:skill', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.skill.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.skill.response.parse(
      await fleet.call('settingsSkill', { params: { eid, name: input.name } })
    )
  })
  reg.mhandle('fleet:settings:createSkill', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.createSkill.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.createSkill.response.parse(
      await fleet.call('settingsCreateSkill', { params: { eid }, body: input })
    )
  })
  reg.mhandle('fleet:settings:writeSkill', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.writeSkill.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.writeSkill.response.parse(
      await fleet.call('settingsWriteSkill', { params: { eid, name: input.name }, body: input })
    )
  })
  reg.mhandle('fleet:settings:setSkillEnabled', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.setSkillEnabled.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.setSkillEnabled.response.parse(
      await fleet.call('settingsSetSkillEnabled', { params: { eid, name: input.name }, body: input })
    )
  })
  reg.mhandle('fleet:settings:removeSkill', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.removeSkill.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.removeSkill.response.parse(
      await fleet.call('settingsRemoveSkill', { params: { eid, name: input.name }, body: input })
    )
  })
  reg.mhandle('fleet:settings:searchSkills', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.searchSkills.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.searchSkills.response.parse(
      await fleet.call('settingsSearchSkills', { params: { eid }, body: input })
    )
  })
  reg.mhandle('fleet:settings:installSkill', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.installSkill.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.installSkill.response.parse(
      await fleet.call('settingsInstallSkill', { params: { eid }, body: input })
    )
  })
  reg.handle('fleet:settings:skillGroups', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    FLEET_SETTINGS_OPERATIONS.skillGroups.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.skillGroups.response.parse(
      await fleet.call('settingsSkillGroups', { params: { eid } })
    )
  })
  reg.mhandle('fleet:settings:createSkillGroup', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.createSkillGroup.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.createSkillGroup.response.parse(
      await fleet.call('settingsCreateSkillGroup', { params: { eid }, body: input })
    )
  })
  reg.mhandle('fleet:settings:updateSkillGroup', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.updateSkillGroup.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.updateSkillGroup.response.parse(
      await fleet.call('settingsUpdateSkillGroup', { params: { eid, id: input.id }, body: input })
    )
  })
  reg.mhandle('fleet:settings:removeSkillGroup', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.removeSkillGroup.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.removeSkillGroup.response.parse(
      await fleet.call('settingsRemoveSkillGroup', { params: { eid, id: input.id }, body: input })
    )
  })
  reg.handle('fleet:settings:mcpServers', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    FLEET_SETTINGS_OPERATIONS.mcpServers.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.mcpServers.response.parse(
      await fleet.call('settingsMcpServers', { params: { eid } })
    )
  })
  reg.handle('fleet:settings:mcpServer', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.mcpServer.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.mcpServer.response.parse(
      await fleet.call('settingsMcpServer', { params: { eid, id: input.id } })
    )
  })
  reg.mhandle('fleet:settings:createMcpServer', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.createMcpServer.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.createMcpServer.response.parse(
      await fleet.call('settingsCreateMcpServer', { params: { eid }, body: input })
    )
  })
  reg.mhandle('fleet:settings:patchMcpServer', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.patchMcpServer.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.patchMcpServer.response.parse(
      await fleet.call('settingsPatchMcpServer', { params: { eid, id: input.id }, body: input })
    )
  })
  reg.mhandle('fleet:settings:removeMcpServer', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.removeMcpServer.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.removeMcpServer.response.parse(
      await fleet.call('settingsRemoveMcpServer', { params: { eid, id: input.id }, body: input })
    )
  })
  reg.mhandle('fleet:settings:testMcpServer', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const { detail: _asked, ...input } = FLEET_SETTINGS_OPERATIONS.testMcpServer.input.parse(rawInput ?? {})
    // Why a test failed, from a gateway and an image that know the field; older ones refuse it.
    const detail =
      fleet.hasFeature(FLEET_MCP_TEST_DETAIL_FEATURE) &&
      !!fleet
        .getSnapshot()
        .environments.find((value) => value.id === eid)
        ?.capabilities.includes(FLEET_MCP_TEST_DETAIL_FEATURE)
    return FLEET_SETTINGS_OPERATIONS.testMcpServer.response.parse(
      await fleet.call('settingsTestMcpServer', {
        params: { eid, id: input.id },
        body: { ...input, ...(detail ? { detail: true as const } : {}) },
      })
    )
  })
  reg.handle('fleet:settings:runtimes', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    FLEET_SETTINGS_OPERATIONS.runtimes.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.runtimes.response.parse(await fleet.call('settingsRuntimes', { params: { eid } }))
  })
  reg.mhandle('fleet:settings:runtimeAction', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.runtimeAction.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.runtimeAction.response.parse(
      await fleet.call('settingsRuntimeAction', { params: { eid, id: input.id }, body: input })
    )
  })
  reg.mhandle('fleet:settings:setRuntimeAutomatic', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.setRuntimeAutomatic.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.setRuntimeAutomatic.response.parse(
      await fleet.call('settingsSetRuntimeAutomatic', { params: { eid, id: input.id }, body: input })
    )
  })
  reg.handle('fleet:settings:preferences', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    FLEET_SETTINGS_OPERATIONS.preferences.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.preferences.response.parse(
      await fleet.call('settingsPreferences', { params: { eid } })
    )
  })
  reg.mhandle('fleet:settings:setPreferences', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId)
    const input = FLEET_SETTINGS_OPERATIONS.setPreferences.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.setPreferences.response.parse(
      await fleet.call('settingsSetPreferences', { params: { eid }, body: input })
    )
  })
  reg.handle('fleet:settings:failover', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId, FLEET_ACCOUNT_FAILOVER_FEATURE)
    FLEET_SETTINGS_OPERATIONS.failover.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.failover.response.parse(await fleet.call('settingsFailover', { params: { eid } }))
  })
  reg.mhandle('fleet:settings:setFailoverRoute', async (_event, rawId: unknown, rawInput: unknown) => {
    const eid = target(rawId, FLEET_ACCOUNT_FAILOVER_FEATURE)
    const input = FLEET_SETTINGS_OPERATIONS.setFailoverRoute.input.parse(rawInput ?? {})
    return FLEET_SETTINGS_OPERATIONS.setFailoverRoute.response.parse(
      await fleet.call('settingsSetFailoverRoute', {
        params: { eid, kind: input.kind, slot: input.slot ?? 'default' },
        body: input,
      })
    )
  })
}
