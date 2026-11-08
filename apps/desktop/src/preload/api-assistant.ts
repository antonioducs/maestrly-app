import { ipcRenderer } from 'electron'
import type {
  AssistantHoldReason,
  AssistantInfo,
  AssistantSettingsPatch,
  AssistantSettingsState,
} from '../shared/assistant'

export const assistantApi = {
  assistantInfo: (): Promise<AssistantInfo> => ipcRenderer.invoke('assistant:info'),
  assistantSettings: (): Promise<AssistantSettingsState> => ipcRenderer.invoke('assistant:settings-get'),
  setAssistantSettings: (patch: AssistantSettingsPatch): Promise<AssistantSettingsState> =>
    ipcRenderer.invoke('assistant:settings-set', patch),
  assistantNewSession: (): Promise<AssistantInfo> => ipcRenderer.invoke('assistant:new-session'),
  assistantOpenInApp: (): Promise<void> => ipcRenderer.invoke('assistant:open-in-app'),
  assistantOpenSettings: (section?: string): Promise<void> =>
    ipcRenderer.invoke('assistant:open-settings', section ?? null),
  assistantShow: (listen?: boolean): Promise<void> => ipcRenderer.invoke('assistant:show', listen === true),
  assistantHide: (): void => ipcRenderer.send('assistant:hide'),
  assistantHold: (reason: AssistantHoldReason, held: boolean): void => ipcRenderer.send('assistant:hold', reason, held),
  onAssistantShown: (cb: (payload: { listen: boolean }) => void): (() => void) => {
    const listener = (_event: unknown, payload: { listen: boolean }) => cb(payload)
    ipcRenderer.on('assistant:shown', listener)
    return () => ipcRenderer.removeListener('assistant:shown', listener)
  },
  onAssistantConversationChanged: (cb: (info: AssistantInfo) => void): (() => void) => {
    const listener = (_event: unknown, info: AssistantInfo) => cb(info)
    ipcRenderer.on('assistant:conversation-changed', listener)
    return () => ipcRenderer.removeListener('assistant:conversation-changed', listener)
  },
  /** Main window: the assistant asked to open Settings here. */
  onAssistantOpenSettings: (cb: (section: string | null) => void): (() => void) => {
    const listener = (_event: unknown, section: string | null) => cb(section)
    ipcRenderer.on('assistant:open-settings', listener)
    return () => ipcRenderer.removeListener('assistant:open-settings', listener)
  },
}
