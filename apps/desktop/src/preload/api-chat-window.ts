import { ipcRenderer } from 'electron'
import type { ChatWindowRequest } from '../shared/chat-window'

function subscribe(channel: string, cb: (key: string) => void): () => void {
  const listener = (_event: unknown, key: string) => cb(key)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

export const chatWindowApi = {
  chatWindowPrepare: (request: ChatWindowRequest): Promise<{ key: string; frameName: string }> =>
    ipcRenderer.invoke('chat-window:prepare', request),
  chatWindowClose: (key: string): Promise<void> => ipcRenderer.invoke('chat-window:close', key),
  chatWindowFocus: (key: string): Promise<void> => ipcRenderer.invoke('chat-window:focus', key),
  chatWindowShowSource: (key: string): Promise<void> => ipcRenderer.invoke('chat-window:show-source', key),
  onChatWindowCloseRequested: (cb: (key: string) => void): (() => void) => subscribe('chat-window:close-requested', cb),
  onChatWindowClosed: (cb: (key: string) => void): (() => void) => subscribe('chat-window:closed', cb),
}
