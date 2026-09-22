import { ipcRenderer } from 'electron'
import type { BotPermissionCeiling, BotServerInput, BotSettingsView, BotSetupInput } from '../shared/bot'

export const botApi = {
  botSettings: (): Promise<BotSettingsView> => ipcRenderer.invoke('bot:settings'),
  botConnect: (input: BotSetupInput): Promise<BotSettingsView> => ipcRenderer.invoke('bot:connect', input),
  botRevoke: (id: string): Promise<BotSettingsView> => ipcRenderer.invoke('bot:revoke', id),
  botUpdateWorkspaces: (id: string, workspaceIds: string[]): Promise<BotSettingsView> =>
    ipcRenderer.invoke('bot:workspaces', id, workspaceIds),
  botSetPermissionCeiling: (id: string, ceiling: BotPermissionCeiling): Promise<BotSettingsView> =>
    ipcRenderer.invoke('bot:permission-ceiling', id, ceiling),
  botSetManagement: (conversationId: string, state: 'active' | 'paused'): Promise<void> =>
    ipcRenderer.invoke('bot:management', conversationId, state),
  botSetManualChatEnabled: (conversationId: string, enabled: boolean): Promise<void> =>
    ipcRenderer.invoke('bot:manual-chat', conversationId, enabled),
  botRefresh: (): Promise<BotSettingsView> => ipcRenderer.invoke('bot:refresh'),
  botConfigureServer: (input: BotServerInput): Promise<BotSettingsView> => ipcRenderer.invoke('bot:server', input),
  botAuthorize: (id: string, approved: boolean, connectionId: string): Promise<BotSettingsView> =>
    ipcRenderer.invoke('bot:authorize', id, approved, connectionId),
}
