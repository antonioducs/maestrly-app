import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { BotApi, DesktopViewEvent } from '../shared/types'
const api: BotApi = {
  hosts: () => ipcRenderer.invoke('bot:hosts'),
  connect: (targetId) => ipcRenderer.invoke('bot:connect', targetId),
  addSshTarget: (alias) => ipcRenderer.invoke('bot:addSshTarget', alias),
  removeTarget: (targetId) => ipcRenderer.invoke('bot:removeTarget', targetId),
  disconnect: () => ipcRenderer.invoke('bot:disconnect'),
  status: () => ipcRenderer.invoke('bot:status'),
  retry: (key) => ipcRenderer.invoke('bot:retry', key),
  call: (call) => ipcRenderer.invoke('bot:call', call),
  bot: (call) => ipcRenderer.invoke('bot:bot', call),
  team: (call) => ipcRenderer.invoke('bot:team', call),
  routine: (call) => ipcRenderer.invoke('bot:routine', call),
  // Audio never becomes a path, a URL or a handle in the renderer: it is handed over once and
  // read back by clip identity.
  voice: {
    call: (call) => ipcRenderer.invoke('bot:voice', call),
    upload: (input) => ipcRenderer.invoke('bot:voiceUpload', input),
    read: (input) => ipcRenderer.invoke('bot:voiceRead', input),
    requestMicrophone: () => ipcRenderer.invoke('bot:voiceMicrophone'),
    arm: (armed) => ipcRenderer.invoke('bot:voiceArm', armed),
  },
  syncAccounts: () => ipcRenderer.invoke('bot:syncAccounts'),
  localHost: () => ipcRenderer.invoke('bot:localHost'),
  installLocalHost: () => ipcRenderer.invoke('bot:installLocalHost'),
  openExternal: (url) => ipcRenderer.invoke('bot:openExternal', url),
  draft: () => ipcRenderer.invoke('bot:draft'),
  saveDraft: (draft) => ipcRenderer.invoke('bot:saveDraft', draft),
  preferences: () => ipcRenderer.invoke('bot:preferences'),
  modelMeta: () => ipcRenderer.invoke('bot:modelMeta'),
  savePreferences: (preferences) => ipcRenderer.invoke('bot:savePreferences', preferences),
  saveFile: (input) => ipcRenderer.invoke('bot:saveFile', input),
  pickFile: () => ipcRenderer.invoke('bot:pickFile'),
  // Opaque handles only: the main process keeps tickets and control capabilities.
  desktop: {
    inspect: (botId) => ipcRenderer.invoke('bot:desktopInspect', botId),
    open: (botId) => ipcRenderer.invoke('bot:desktopOpen', botId),
    close: (handle) => ipcRenderer.invoke('bot:desktopClose', handle),
    acquire: (handle) => ipcRenderer.invoke('bot:desktopAcquire', handle),
    input: (handle, events) => ipcRenderer.invoke('bot:desktopInput', { handle, events }),
    returnControl: (input) => ipcRenderer.invoke('bot:desktopReturn', input),
    onEvent: (listener) => {
      const handler = (_event: IpcRendererEvent, value: DesktopViewEvent) => listener(value)
      ipcRenderer.on('bot:desktop-event', handler)
      return () => {
        ipcRenderer.removeListener('bot:desktop-event', handler)
      }
    },
  },
}
contextBridge.exposeInMainWorld('bot', api)
