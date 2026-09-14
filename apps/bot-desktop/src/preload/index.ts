import { contextBridge, ipcRenderer } from 'electron'
import type { BotApi } from '../shared/types'
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
  syncAccounts: () => ipcRenderer.invoke('bot:syncAccounts'),
  localHost: () => ipcRenderer.invoke('bot:localHost'),
  installLocalHost: () => ipcRenderer.invoke('bot:installLocalHost'),
  openExternal: (url) => ipcRenderer.invoke('bot:openExternal', url),
  draft: () => ipcRenderer.invoke('bot:draft'),
  saveDraft: (draft) => ipcRenderer.invoke('bot:saveDraft', draft),
  preferences: () => ipcRenderer.invoke('bot:preferences'),
  savePreferences: (preferences) => ipcRenderer.invoke('bot:savePreferences', preferences),
  saveFile: (input) => ipcRenderer.invoke('bot:saveFile', input),
  pickFile: () => ipcRenderer.invoke('bot:pickFile'),
}
contextBridge.exposeInMainWorld('bot', api)
