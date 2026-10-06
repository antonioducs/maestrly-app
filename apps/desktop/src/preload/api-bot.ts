import { ipcRenderer } from 'electron'

export const botApi = {
  botSetManagement: (conversationId: string, state: 'active' | 'paused'): Promise<void> =>
    ipcRenderer.invoke('bot:management', conversationId, state),
  botSetManualChatEnabled: (conversationId: string, enabled: boolean): Promise<void> =>
    ipcRenderer.invoke('bot:manual-chat', conversationId, enabled),
}
