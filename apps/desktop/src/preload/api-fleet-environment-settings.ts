import { ipcRenderer } from 'electron'
import type { FleetEnvironmentSettingsApi } from '@maestrly/bot-fleet-protocol'
import type { FleetServerId, FleetServerScoped } from '../shared/fleet-servers'
import type { McpOAuthConnectResult } from '../shared/chat'
import type { InstalledPluginDto, PluginOpResult } from '../shared/plugins'

/** An environment's settings: each call names its server, then the environment. */
export const fleetEnvironmentSettings: FleetServerScoped<FleetEnvironmentSettingsApi> = {
  accounts: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:accounts', fleetServerId, environmentId, input),
  patchAccount: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:patchAccount', fleetServerId, environmentId, input),
  renameSubscription: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:renameSubscription', fleetServerId, environmentId, input),
  removeAccount: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:removeAccount', fleetServerId, environmentId, input),
  removeSubscription: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:removeSubscription', fleetServerId, environmentId, input),
  models: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:models', fleetServerId, environmentId, input),
  setModelFilter: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:setModelFilter', fleetServerId, environmentId, input),
  skills: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:skills', fleetServerId, environmentId, input),
  skill: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:skill', fleetServerId, environmentId, input),
  createSkill: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:createSkill', fleetServerId, environmentId, input),
  writeSkill: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:writeSkill', fleetServerId, environmentId, input),
  setSkillEnabled: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:setSkillEnabled', fleetServerId, environmentId, input),
  removeSkill: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:removeSkill', fleetServerId, environmentId, input),
  searchSkills: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:searchSkills', fleetServerId, environmentId, input),
  installSkill: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:installSkill', fleetServerId, environmentId, input),
  skillGroups: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:skillGroups', fleetServerId, environmentId, input),
  createSkillGroup: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:createSkillGroup', fleetServerId, environmentId, input),
  updateSkillGroup: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:updateSkillGroup', fleetServerId, environmentId, input),
  removeSkillGroup: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:removeSkillGroup', fleetServerId, environmentId, input),
  mcpServers: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:mcpServers', fleetServerId, environmentId, input),
  mcpServer: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:mcpServer', fleetServerId, environmentId, input),
  createMcpServer: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:createMcpServer', fleetServerId, environmentId, input),
  patchMcpServer: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:patchMcpServer', fleetServerId, environmentId, input),
  removeMcpServer: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:removeMcpServer', fleetServerId, environmentId, input),
  testMcpServer: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:testMcpServer', fleetServerId, environmentId, input),
  runtimes: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:runtimes', fleetServerId, environmentId, input),
  runtimeAction: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:runtimeAction', fleetServerId, environmentId, input),
  setRuntimeAutomatic: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:setRuntimeAutomatic', fleetServerId, environmentId, input),
  preferences: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:preferences', fleetServerId, environmentId, input),
  setPreferences: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:setPreferences', fleetServerId, environmentId, input),
  plugins: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:plugins', fleetServerId, environmentId, input),
  pluginCatalog: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:pluginCatalog', fleetServerId, environmentId, input),
  pluginInspect: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:pluginInspect', fleetServerId, environmentId, input),
  pluginLogo: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:pluginLogo', fleetServerId, environmentId, input),
  addPluginSource: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:addPluginSource', fleetServerId, environmentId, input),
  refreshPluginSource: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:refreshPluginSource', fleetServerId, environmentId, input),
  removePluginSource: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:removePluginSource', fleetServerId, environmentId, input),
  installPlugin: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:installPlugin', fleetServerId, environmentId, input),
  updatePlugin: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:updatePlugin', fleetServerId, environmentId, input),
  patchPlugin: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:patchPlugin', fleetServerId, environmentId, input),
  uninstallPlugin: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:uninstallPlugin', fleetServerId, environmentId, input),
  pluginSkills: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:pluginSkills', fleetServerId, environmentId, input),
  setPluginSkillEnabled: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:setPluginSkillEnabled', fleetServerId, environmentId, input),
  mcpOAuthStatuses: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:mcpOAuthStatuses', fleetServerId, environmentId, input),
  removeMcpOAuth: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:removeMcpOAuth', fleetServerId, environmentId, input),
  patchMcpOAuthAccount: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:patchMcpOAuthAccount', fleetServerId, environmentId, input),
  setMcpOAuthClient: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:setMcpOAuthClient', fleetServerId, environmentId, input),
  failover: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:failover', fleetServerId, environmentId, input),
  setFailoverRoute: (fleetServerId, environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:setFailoverRoute', fleetServerId, environmentId, input),
}

/**
 * Plugin actions on an environment that this computer's main process carries out: bringing one of this computer's
 * plugins (with the values entered here) and signing in to an MCP server of the environment in this computer's browser.
 */
export const fleetEnvironmentPlugins = {
  bring: (
    fleetServerId: FleetServerId,
    environmentId: string,
    key: string
  ): Promise<PluginOpResult<InstalledPluginDto>> =>
    ipcRenderer.invoke('fleet:plugins:bring', fleetServerId, environmentId, key),
  mcpOAuthConnect: (
    fleetServerId: FleetServerId,
    environmentId: string,
    serverId: string,
    options?: { accountId?: string; label?: string }
  ): Promise<McpOAuthConnectResult> =>
    ipcRenderer.invoke('fleet:mcp-oauth:connect', fleetServerId, environmentId, serverId, options),
  mcpOAuthCancel: (fleetServerId: FleetServerId, environmentId: string, serverId: string): Promise<void> =>
    ipcRenderer.invoke('fleet:mcp-oauth:cancel', fleetServerId, environmentId, serverId),
}
