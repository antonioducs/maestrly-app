import { ipcRenderer } from 'electron'
import type {
  LocalMemoryCreateInput,
  LocalMemoryFilters,
  LocalMemoryUpdateInput,
  MemoryChangeEvent,
  MemoryIndexStatus,
  MemoryPromotionInput,
  MemoryPromotionPreviewInput,
} from '../shared/memory'

export const memoryApi = {
  listMemories: (workspaceId: string, filters?: LocalMemoryFilters) =>
    ipcRenderer.invoke('memory:list', workspaceId, filters),
  getMemory: (workspaceId: string, id: string) => ipcRenderer.invoke('memory:get', workspaceId, id),
  searchMemories: (workspaceId: string, query: string, repositoryRoot?: string) =>
    ipcRenderer.invoke('memory:search', workspaceId, query, repositoryRoot),
  createMemory: (input: LocalMemoryCreateInput) => ipcRenderer.invoke('memory:create', input),
  updateMemory: (workspaceId: string, id: string, patch: LocalMemoryUpdateInput) =>
    ipcRenderer.invoke('memory:update', workspaceId, id, patch),
  archiveMemory: (workspaceId: string, id: string) => ipcRenderer.invoke('memory:archive', workspaceId, id),
  restoreMemory: (workspaceId: string, id: string) => ipcRenderer.invoke('memory:restore', workspaceId, id),
  forgetMemory: (workspaceId: string, id: string, confirmed: boolean) =>
    ipcRenderer.invoke('memory:forget', workspaceId, id, confirmed),
  listSharedMemories: (workspaceId: string, repositoryRoot?: string) =>
    ipcRenderer.invoke('memory:shared-list', workspaceId, repositoryRoot),
  openSharedMemory: (workspaceId: string, relativePath: string) =>
    ipcRenderer.invoke('memory:shared-open', workspaceId, relativePath),
  previewMemoryPromotion: (input: MemoryPromotionPreviewInput) => ipcRenderer.invoke('memory:promotion-preview', input),
  promoteMemory: (input: MemoryPromotionInput) => ipcRenderer.invoke('memory:promote', input),
  getMemoryIndexStatus: (workspaceId: string): Promise<MemoryIndexStatus> =>
    ipcRenderer.invoke('memory:index-status-get', workspaceId),
  rebuildMemoryIndex: (workspaceId: string) => ipcRenderer.invoke('memory:index-rebuild', workspaceId),
  exportMemories: (workspaceId: string) => ipcRenderer.invoke('memory:export', workspaceId),
  listLegacyMemoryBackups: (workspaceId: string) => ipcRenderer.invoke('memory:legacy-backups', workspaceId),
  removeLegacyMemoryBackup: (workspaceId: string, backupPath: string, confirmed: boolean) =>
    ipcRenderer.invoke('memory:legacy-backup-remove', workspaceId, backupPath, confirmed),
  getMemoryEnabled: (workspaceId: string): Promise<boolean> => ipcRenderer.invoke('memory:enabled-get', workspaceId),
  setMemoryEnabled: (workspaceId: string, enabled: boolean) =>
    ipcRenderer.send('memory:enabled-set', workspaceId, enabled),
  onMemoryChanged: (callback: (event: MemoryChangeEvent) => void): (() => void) => {
    const listener = (_event: unknown, value: MemoryChangeEvent) => callback(value)
    ipcRenderer.on('memory:changed', listener)
    return () => ipcRenderer.removeListener('memory:changed', listener)
  },
  onMemoryIndexStatus: (callback: (status: MemoryIndexStatus) => void): (() => void) => {
    const listener = (_event: unknown, value: MemoryIndexStatus) => callback(value)
    ipcRenderer.on('memory:index-status', listener)
    return () => ipcRenderer.removeListener('memory:index-status', listener)
  },

  // Deprecated aliases kept for one release.
  readMemory: (workspaceId: string): Promise<string> => ipcRenderer.invoke('memory:read', workspaceId),
  writeMemory: (workspaceId: string, content: string) => ipcRenderer.send('memory:write', workspaceId, content),
}
