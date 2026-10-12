import { ipcRenderer } from 'electron'
import type { FleetEnvironmentSettingsApi } from '@maestrly/bot-fleet-protocol'
import type { McpOAuthConnectResult } from '../shared/chat'
import type { InstalledPluginDto, PluginOpResult } from '../shared/plugins'

export const fleetEnvironmentSettings: FleetEnvironmentSettingsApi = {
  accounts: (environmentId, input) => ipcRenderer.invoke('fleet:settings:accounts', environmentId, input),
  patchAccount: (environmentId, input) => ipcRenderer.invoke('fleet:settings:patchAccount', environmentId, input),
  renameSubscription: (environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:renameSubscription', environmentId, input),
  removeAccount: (environmentId, input) => ipcRenderer.invoke('fleet:settings:removeAccount', environmentId, input),
  removeSubscription: (environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:removeSubscription', environmentId, input),
  models: (environmentId, input) => ipcRenderer.invoke('fleet:settings:models', environmentId, input),
  setModelFilter: (environmentId, input) => ipcRenderer.invoke('fleet:settings:setModelFilter', environmentId, input),
  skills: (environmentId, input) => ipcRenderer.invoke('fleet:settings:skills', environmentId, input),
  skill: (environmentId, input) => ipcRenderer.invoke('fleet:settings:skill', environmentId, input),
  createSkill: (environmentId, input) => ipcRenderer.invoke('fleet:settings:createSkill', environmentId, input),
  writeSkill: (environmentId, input) => ipcRenderer.invoke('fleet:settings:writeSkill', environmentId, input),
  setSkillEnabled: (environmentId, input) => ipcRenderer.invoke('fleet:settings:setSkillEnabled', environmentId, input),
  removeSkill: (environmentId, input) => ipcRenderer.invoke('fleet:settings:removeSkill', environmentId, input),
  searchSkills: (environmentId, input) => ipcRenderer.invoke('fleet:settings:searchSkills', environmentId, input),
  installSkill: (environmentId, input) => ipcRenderer.invoke('fleet:settings:installSkill', environmentId, input),
  skillGroups: (environmentId, input) => ipcRenderer.invoke('fleet:settings:skillGroups', environmentId, input),
  createSkillGroup: (environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:createSkillGroup', environmentId, input),
  updateSkillGroup: (environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:updateSkillGroup', environmentId, input),
  removeSkillGroup: (environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:removeSkillGroup', environmentId, input),
  mcpServers: (environmentId, input) => ipcRenderer.invoke('fleet:settings:mcpServers', environmentId, input),
  mcpServer: (environmentId, input) => ipcRenderer.invoke('fleet:settings:mcpServer', environmentId, input),
  createMcpServer: (environmentId, input) => ipcRenderer.invoke('fleet:settings:createMcpServer', environmentId, input),
  patchMcpServer: (environmentId, input) => ipcRenderer.invoke('fleet:settings:patchMcpServer', environmentId, input),
  removeMcpServer: (environmentId, input) => ipcRenderer.invoke('fleet:settings:removeMcpServer', environmentId, input),
  testMcpServer: (environmentId, input) => ipcRenderer.invoke('fleet:settings:testMcpServer', environmentId, input),
  runtimes: (environmentId, input) => ipcRenderer.invoke('fleet:settings:runtimes', environmentId, input),
  runtimeAction: (environmentId, input) => ipcRenderer.invoke('fleet:settings:runtimeAction', environmentId, input),
  setRuntimeAutomatic: (environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:setRuntimeAutomatic', environmentId, input),
  preferences: (environmentId, input) => ipcRenderer.invoke('fleet:settings:preferences', environmentId, input),
  setPreferences: (environmentId, input) => ipcRenderer.invoke('fleet:settings:setPreferences', environmentId, input),
  plugins: (environmentId, input) => ipcRenderer.invoke('fleet:settings:plugins', environmentId, input),
  pluginCatalog: (environmentId, input) => ipcRenderer.invoke('fleet:settings:pluginCatalog', environmentId, input),
  pluginInspect: (environmentId, input) => ipcRenderer.invoke('fleet:settings:pluginInspect', environmentId, input),
  pluginLogo: (environmentId, input) => ipcRenderer.invoke('fleet:settings:pluginLogo', environmentId, input),
  addPluginSource: (environmentId, input) => ipcRenderer.invoke('fleet:settings:addPluginSource', environmentId, input),
  refreshPluginSource: (environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:refreshPluginSource', environmentId, input),
  removePluginSource: (environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:removePluginSource', environmentId, input),
  installPlugin: (environmentId, input) => ipcRenderer.invoke('fleet:settings:installPlugin', environmentId, input),
  updatePlugin: (environmentId, input) => ipcRenderer.invoke('fleet:settings:updatePlugin', environmentId, input),
  patchPlugin: (environmentId, input) => ipcRenderer.invoke('fleet:settings:patchPlugin', environmentId, input),
  uninstallPlugin: (environmentId, input) => ipcRenderer.invoke('fleet:settings:uninstallPlugin', environmentId, input),
  mcpOAuthStatuses: (environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:mcpOAuthStatuses', environmentId, input),
  mcpOAuthDescriptor: (environmentId, input) =>
    ipcRenderer.invoke('fleet:settings:mcpOAuthDescriptor', environmentId, input),
  removeMcpOAuth: (environmentId, input) => ipcRenderer.invoke('fleet:settings:removeMcpOAuth', environmentId, input),
}

/**
 * Plugin actions on an environment that this computer's main process carries out: bringing one of this computer's
 * plugins (with the values entered here) and signing in to an MCP server of the environment in this computer's browser.
 */
export const fleetEnvironmentPlugins = {
  bring: (environmentId: string, key: string): Promise<PluginOpResult<InstalledPluginDto>> =>
    ipcRenderer.invoke('fleet:plugins:bring', environmentId, key),
  mcpOAuthConnect: (environmentId: string, serverId: string): Promise<McpOAuthConnectResult> =>
    ipcRenderer.invoke('fleet:mcp-oauth:connect', environmentId, serverId),
  mcpOAuthCancel: (environmentId: string, serverId: string): Promise<void> =>
    ipcRenderer.invoke('fleet:mcp-oauth:cancel', environmentId, serverId),
}
