import { ipcRenderer } from 'electron'
import type {
  LocalMemory,
  LocalMemoryMutationResult,
  PersonalMemorySettings,
  LocalMemoryCreateInput,
  LocalMemoryFilters,
  LocalMemoryUpdateInput,
  MemoryChangeEvent,
  MemoryIndexStatus,
  MemoryPromotionInput,
  MemoryPromotionPreviewInput,
} from '../shared/memory'

export type PersonalMemoryCreateInput = Pick<
  LocalMemoryCreateInput,
  'title' | 'content' | 'type' | 'scope' | 'tags' | 'pinned' | 'importance'
>
export type PersonalMemoryUpdateInput = Partial<PersonalMemoryCreateInput> & Pick<LocalMemoryUpdateInput, 'status'>

export type PersonalMemoryFilters = Pick<LocalMemoryFilters, 'limit' | 'offset' | 'query' | 'pinned'> & {
  type?: LocalMemory['type']
  status?: LocalMemory['status']
}

export const memoryApi = {
  searchPersonalMemories: (query: string, filters?: Omit<PersonalMemoryFilters, 'query'>): Promise<LocalMemory[]> =>
    ipcRenderer.invoke('personal-memory:search', query, filters),
  getPersonalMemoryIndexStatus: (): Promise<MemoryIndexStatus> =>
    ipcRenderer.invoke('personal-memory:index-status-get'),
  rebuildPersonalMemoryIndex: (): Promise<void> => ipcRenderer.invoke('personal-memory:index-rebuild'),
  onPersonalMemorySettingsChanged: (callback: (settings: PersonalMemorySettings) => void): (() => void) => {
    const listener = (_event: unknown, settings: PersonalMemorySettings) => callback(settings)
    ipcRenderer.on('personal-memory:settings-changed', listener)
    return () => ipcRenderer.removeListener('personal-memory:settings-changed', listener)
  },
  listPersonalMemories: (filters?: PersonalMemoryFilters): Promise<LocalMemory[]> =>
    ipcRenderer.invoke('personal-memory:list', filters),
  getPersonalMemory: (id: string): Promise<LocalMemory | undefined> => ipcRenderer.invoke('personal-memory:get', id),
  createPersonalMemory: (input: PersonalMemoryCreateInput): Promise<LocalMemoryMutationResult> =>
    ipcRenderer.invoke('personal-memory:create', input),
  updatePersonalMemory: (id: string, patch: PersonalMemoryUpdateInput): Promise<LocalMemoryMutationResult> =>
    ipcRenderer.invoke('personal-memory:update', id, patch),
  archivePersonalMemory: (id: string): Promise<unknown> => ipcRenderer.invoke('personal-memory:archive', id),
  restorePersonalMemory: (id: string): Promise<unknown> => ipcRenderer.invoke('personal-memory:restore', id),
  forgetPersonalMemory: (id: string, confirmed: boolean): Promise<unknown> =>
    ipcRenderer.invoke('personal-memory:forget', id, confirmed),
  exportPersonalMemories: (): Promise<{ json: string; markdown: string }> =>
    ipcRenderer.invoke('personal-memory:export'),
  getPersonalMemorySettings: (): Promise<PersonalMemorySettings> => ipcRenderer.invoke('personal-memory:settings-get'),
  setPersonalMemorySettings: (settings: PersonalMemorySettings): Promise<void> =>
    ipcRenderer.invoke('personal-memory:settings-set', settings),

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
