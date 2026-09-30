import { ipcRenderer } from 'electron'
import type { ArtifactDetailView, ArtifactHostStatus, ArtifactListItem, ArtifactSettings } from '../shared/artifacts'

export const artifactsApi = {
  artifacts: {
    list: (): Promise<ArtifactListItem[]> => ipcRenderer.invoke('artifacts:list'),
    detail: (id: string): Promise<ArtifactDetailView | null> => ipcRenderer.invoke('artifacts:detail', id),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke('artifacts:delete', id),
    openExternal: (id: string, version?: number): Promise<void> =>
      ipcRenderer.invoke('artifacts:open-external', id, version),
    openInConversation: (conversationId: string, id: string, version?: number): Promise<void> =>
      ipcRenderer.invoke('artifacts:open-in-conversation', conversationId, id, version),
    status: (): Promise<ArtifactHostStatus> => ipcRenderer.invoke('artifacts:status'),
    start: (): Promise<ArtifactHostStatus> => ipcRenderer.invoke('artifacts:start'),
    getSettings: (): Promise<ArtifactSettings> => ipcRenderer.invoke('artifacts:settings-get'),
    setSettings: (settings: ArtifactSettings): Promise<ArtifactSettings> =>
      ipcRenderer.invoke('artifacts:settings-set', settings),
    onChanged: (cb: () => void): (() => void) => {
      const listener = () => cb()
      ipcRenderer.on('artifacts:changed', listener)
      return () => ipcRenderer.removeListener('artifacts:changed', listener)
    },
    onStatus: (cb: (status: ArtifactHostStatus) => void): (() => void) => {
      const listener = (_e: unknown, status: ArtifactHostStatus) => cb(status)
      ipcRenderer.on('artifacts:status', listener)
      return () => ipcRenderer.removeListener('artifacts:status', listener)
    },
  },
}
