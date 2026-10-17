import { ipcRenderer } from 'electron'
import type { EnvironmentBotAccessInput, FleetDesktopAccessView } from '../shared/fleet-desktop-access'
import type { IpcTransport } from './ipc-transport'

// The transport parameter keeps Electron's name on purpose: see ipc-transport.ts.
export function makeBotApi(ipcRenderer: IpcTransport) {
  return {
    botSetManagement: (conversationId: string, state: 'active' | 'paused'): Promise<void> =>
      ipcRenderer.invoke('bot:management', conversationId, state),
    botSetManualChatEnabled: (conversationId: string, enabled: boolean): Promise<void> =>
      ipcRenderer.invoke('bot:manual-chat', conversationId, enabled),
    /** What a workspaces host gives a bot of its server; only a workspaces host answers. */
    environmentBotAccess: (botId: string): Promise<FleetDesktopAccessView> =>
      ipcRenderer.invoke('environment-bot-access:get', botId),
    /** Gives a bot access to projects of a workspaces host, or changes it. */
    environmentBotAccessSave: (botId: string, input: EnvironmentBotAccessInput): Promise<FleetDesktopAccessView> =>
      ipcRenderer.invoke('environment-bot-access:save', botId, input),
    /** Takes a workspaces host's access back; the bot's conversations stay on the host. */
    environmentBotAccessDisable: (botId: string): Promise<FleetDesktopAccessView> =>
      ipcRenderer.invoke('environment-bot-access:disable', botId),
    onEnvironmentBotAccess: (cb: (payload: { botId: string }) => void): (() => void) => {
      const listener = (_event: unknown, payload: { botId: string }) => cb(payload)
      ipcRenderer.on('environment-bot-access:changed', listener)
      return () => ipcRenderer.removeListener('environment-bot-access:changed', listener)
    },
  }
}
export const botApi = makeBotApi(ipcRenderer)
