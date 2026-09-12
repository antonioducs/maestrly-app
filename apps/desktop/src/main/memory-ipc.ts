import type { LocalMemoryCreateInput, LocalMemoryFilters, LocalMemoryUpdateInput } from '../shared/memory'
import type { IpcRegistrar } from './ipc-registrar'
import { readMemory, watchMemory, writeMemory } from './memory-service'
import { setWorkspaceMemoryEnabled } from './memory/access'
import {
  exportLocalMemoryData,
  listSharedMemories,
  memoryCenterLocal,
  openSharedMemorySource,
  previewLocalMemoryPromotion,
  promoteLocalMemory,
  removeLegacyMemoryBackup,
  searchMemoryCenter,
} from './memory/memory-center-service'
import { getMemoryIndexStatus, rebuildMemoryIndex } from './memory/index'
import { getMemoryEnabled } from './store'

export function registerMemoryIpc(reg: IpcRegistrar): void {
  // Legacy aliases retained for one release; the new renderer does not use them.
  reg.handle('memory:read', (_event, workspaceId: string) => {
    watchMemory(workspaceId)
    return readMemory(workspaceId)
  })
  reg.mon('memory:write', (_event, workspaceId: string, content: string) => {
    writeMemory(workspaceId, content, false).catch((error) => console.error('[memory] legacy write failed:', error))
  })

  reg.handle('memory:list', (_event, workspaceId: string, filters?: LocalMemoryFilters) =>
    memoryCenterLocal.list(workspaceId, filters)
  )
  reg.handle('memory:get', (_event, workspaceId: string, id: string) => memoryCenterLocal.get(workspaceId, id))
  reg.handle('memory:search', (_event, workspaceId: string, query: string, repositoryRoot?: string) =>
    searchMemoryCenter(workspaceId, query, repositoryRoot)
  )
  reg.mhandle('memory:create', (_event, input: LocalMemoryCreateInput) => memoryCenterLocal.create(input))
  reg.mhandle('memory:update', (_event, workspaceId: string, id: string, patch: LocalMemoryUpdateInput) =>
    memoryCenterLocal.update(workspaceId, id, patch)
  )
  reg.mhandle('memory:archive', (_event, workspaceId: string, id: string) => memoryCenterLocal.archive(workspaceId, id))
  reg.mhandle('memory:restore', (_event, workspaceId: string, id: string) => memoryCenterLocal.restore(workspaceId, id))
  reg.mhandle('memory:forget', (_event, workspaceId: string, id: string, confirmed: boolean) => {
    if (confirmed !== true) throw new Error('confirmation-required')
    return memoryCenterLocal.forget(workspaceId, id)
  })
  reg.handle('memory:shared-list', (_event, workspaceId: string, repositoryRoot?: string) =>
    listSharedMemories(workspaceId, repositoryRoot)
  )
  reg.mhandle('memory:shared-open', (_event, workspaceId: string, relativePath: string) =>
    openSharedMemorySource(workspaceId, relativePath)
  )
  reg.handle('memory:promotion-preview', (_event, input: Parameters<typeof previewLocalMemoryPromotion>[0]) =>
    previewLocalMemoryPromotion(input)
  )
  reg.mhandle('memory:promote', (_event, input: Parameters<typeof promoteLocalMemory>[0]) => promoteLocalMemory(input))
  reg.handle('memory:index-status-get', (_event, workspaceId: string) => getMemoryIndexStatus(workspaceId))
  reg.mhandle('memory:index-rebuild', (_event, workspaceId: string) => rebuildMemoryIndex(workspaceId))
  reg.handle('memory:export', (_event, workspaceId: string) => exportLocalMemoryData(workspaceId))
  reg.handle('memory:legacy-backups', (_event, workspaceId: string) => memoryCenterLocal.backups(workspaceId))
  reg.mhandle('memory:legacy-backup-remove', (_event, workspaceId: string, backupPath: string, confirmed: boolean) => {
    if (confirmed !== true) throw new Error('confirmation-required')
    return removeLegacyMemoryBackup(workspaceId, backupPath)
  })
  reg.handle('memory:enabled-get', (_event, workspaceId: string) => getMemoryEnabled(workspaceId))
  reg.mon('memory:enabled-set', (_event, workspaceId: string, enabled: boolean) =>
    setWorkspaceMemoryEnabled(workspaceId, enabled)
  )
}
