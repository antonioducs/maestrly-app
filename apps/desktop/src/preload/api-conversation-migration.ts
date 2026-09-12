import { ipcRenderer } from 'electron'
import type {
  MigrationCancelInput,
  MigrationChangedEvent,
  MigrationExecuteInput,
  MigrationPrepareInput,
  MigrationPreview,
  MigrationRecovery,
  MigrationResolveInput,
  MigrationResult,
} from '../shared/conversation-migration'

export const conversationMigrationApi = {
  prepareConversationMigration: (input: MigrationPrepareInput): Promise<MigrationPreview> =>
    ipcRenderer.invoke('conversation:migration-prepare', input),
  executeConversationMigration: (input: MigrationExecuteInput): Promise<MigrationResult> =>
    ipcRenderer.invoke('conversation:migration-execute', input),
  cancelConversationMigration: (input: MigrationCancelInput): Promise<void> =>
    ipcRenderer.invoke('conversation:migration-cancel', input),
  listConversationMigrationRecoveries: (): Promise<MigrationRecovery[]> =>
    ipcRenderer.invoke('conversation:migration-list-recoveries'),
  resolveConversationMigration: (input: MigrationResolveInput): Promise<MigrationResult> =>
    ipcRenderer.invoke('conversation:migration-resolve', input),
  onConversationMigrationChanged: (callback: (event: MigrationChangedEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: MigrationChangedEvent): void => {
      callback(payload)
    }
    ipcRenderer.on('conversation:migration-changed', listener)
    return () => ipcRenderer.removeListener('conversation:migration-changed', listener)
  },
}
