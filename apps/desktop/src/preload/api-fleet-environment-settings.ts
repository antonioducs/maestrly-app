import { ipcRenderer } from 'electron'
import type { FleetEnvironmentSettingsApi } from '@maestrly/bot-fleet-protocol'

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
}
