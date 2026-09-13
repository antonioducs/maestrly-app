import { contextBridge, ipcRenderer } from 'electron'
import type { BotApi } from '../shared/types'
const api: BotApi = {
  hosts: () => ipcRenderer.invoke('bot:hosts'),
  connect: (alias) => ipcRenderer.invoke('bot:connect', alias),
  disconnect: () => ipcRenderer.invoke('bot:disconnect'),
  status: () => ipcRenderer.invoke('bot:status'),
  retry: (key) => ipcRenderer.invoke('bot:retry', key),
  call: (call) => ipcRenderer.invoke('bot:call', call),
}
contextBridge.exposeInMainWorld('bot', api)
