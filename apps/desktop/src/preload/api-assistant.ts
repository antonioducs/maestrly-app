import { ipcRenderer } from 'electron'
import type {
  AssistantHoldReason,
  AssistantOpenAiVoice,
  AssistantRealtimeStart,
  AssistantVoiceOptions,
  AssistantInfo,
  AssistantSettingsPatch,
  AssistantSettingsState,
  AssistantTtsResult,
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
  /** Reads one sentence with the OpenAI voice; the audio comes back, the key never does. */
  assistantTts: (text: string): Promise<AssistantTtsResult> => ipcRenderer.invoke('assistant:tts', { text }),
  assistantTtsCancel: (): void => ipcRenderer.send('assistant:tts-cancel'),
  /** Realtime voice: trades the window's SDP offer for OpenAI's answer; the key stays in main. */
  assistantRealtimeStart: (sdp: string): Promise<AssistantRealtimeStart> =>
    ipcRenderer.invoke('assistant:realtime-start', { sdp }),
  assistantRealtimeStop: (): void => ipcRenderer.send('assistant:realtime-stop'),
  /** Runs a Realtime tool call; `heard` is what the person said since the last request, as transcribed. */
  assistantRealtimeTool: (input: { name: string; arguments: string; heard: string[] }): Promise<string> =>
    ipcRenderer.invoke('assistant:realtime-tool', input),
  assistantVoices: (): Promise<AssistantVoiceOptions> => ipcRenderer.invoke('assistant:voices'),
  /** Settings: reads `text` once with an OpenAI voice, to try it. */
  assistantTestVoice: (input: {
    text: string
    voice?: AssistantOpenAiVoice
    speed?: number
  }): Promise<AssistantTtsResult> => ipcRenderer.invoke('assistant:test-voice', input),
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
