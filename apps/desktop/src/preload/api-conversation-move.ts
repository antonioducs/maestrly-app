import { ipcRenderer } from 'electron'
import type {
  MoveChangedEvent,
  MoveExecuteInput,
  MovePrepareInput,
  MovePreview,
  MoveRecovery,
  MoveResult,
} from '../shared/conversation-move'
import type { IpcTransport } from './ipc-transport'

/**
 * Moving a conversation between this computer and its hosts. This computer coordinates every move, so the slice is
 * local: a conversation's host is named in each call instead.
 */
// The transport parameter keeps Electron's name on purpose: see ipc-transport.ts.
export function makeConversationMoveApi(ipcRenderer: IpcTransport) {
  return {
    prepareConversationMove: (input: MovePrepareInput): Promise<MovePreview> =>
      ipcRenderer.invoke('conversation-move:prepare', input),
    executeConversationMove: (input: MoveExecuteInput): Promise<MoveResult> =>
      ipcRenderer.invoke('conversation-move:execute', input),
    cancelConversationMove: (operationId: string): Promise<void> =>
      ipcRenderer.invoke('conversation-move:cancel', { operationId }),
    resolveConversationMove: (operationId: string, action: 'continue' | 'rollback'): Promise<MoveResult> =>
      ipcRenderer.invoke('conversation-move:resolve', { operationId, action }),
    listConversationMoveRecoveries: (): Promise<MoveRecovery[]> => ipcRenderer.invoke('conversation-move:recoveries'),
    onConversationMoveChanged: (callback: (event: MoveChangedEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: MoveChangedEvent): void => {
        callback(payload)
      }
      ipcRenderer.on('conversation-move:changed', listener)
      return () => ipcRenderer.removeListener('conversation-move:changed', listener)
    },
  }
}
export const conversationMoveApi = makeConversationMoveApi(ipcRenderer)
