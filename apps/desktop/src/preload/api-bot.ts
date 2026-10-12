import { ipcRenderer } from 'electron'
import type { IpcTransport } from './ipc-transport'

// The transport parameter keeps Electron's name on purpose: see ipc-transport.ts.
export function makeBotApi(ipcRenderer: IpcTransport) {
  return {
    botSetManagement: (conversationId: string, state: 'active' | 'paused'): Promise<void> =>
      ipcRenderer.invoke('bot:management', conversationId, state),
    botSetManualChatEnabled: (conversationId: string, enabled: boolean): Promise<void> =>
      ipcRenderer.invoke('bot:manual-chat', conversationId, enabled),
  }
}
export const botApi = makeBotApi(ipcRenderer)
