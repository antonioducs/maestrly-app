import { ipcRenderer } from 'electron'
import {
  turnSnapshotsChangedChannel,
  type TurnFilePatch,
  type TurnRevertConfirmInput,
  type TurnRevertConfirmResult,
  type TurnRevertPrepareInput,
  type TurnRevertPrepareResult,
  type TurnSnapshotDetail,
  type TurnSnapshotDiffInput,
  type TurnSnapshotList,
  type TurnSnapshotUsage,
} from '../shared/turn-snapshots'
import type { IpcTransport } from './ipc-transport'

/** Snapshots of each turn's file changes, and undoing them; served by the host that runs the conversation. */
export function makeTurnSnapshotsApi(ipcRenderer: IpcTransport) {
  return {
    turnSnapshotsList: (conversationId: string): Promise<TurnSnapshotList> =>
      ipcRenderer.invoke('turnSnapshots:list', { conversationId }),
    turnSnapshotDetail: (conversationId: string, recordId: string): Promise<TurnSnapshotDetail | null> =>
      ipcRenderer.invoke('turnSnapshots:list', { conversationId, recordId }),
    turnSnapshotPatch: (input: TurnSnapshotDiffInput): Promise<TurnFilePatch | null> =>
      ipcRenderer.invoke('turnSnapshots:diff', input),
    turnRevertPrepare: (input: TurnRevertPrepareInput): Promise<TurnRevertPrepareResult> =>
      ipcRenderer.invoke('turnSnapshots:prepare', input),
    turnRevertConfirm: (input: TurnRevertConfirmInput): Promise<TurnRevertConfirmResult> =>
      ipcRenderer.invoke('turnSnapshots:confirm', input),
    turnSnapshotsUsage: (): Promise<TurnSnapshotUsage> => ipcRenderer.invoke('turnSnapshots:usage'),
    turnSnapshotsClear: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('turnSnapshots:clear'),
    turnSnapshotsSetEnabled: (enabled: boolean): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('turnSnapshots:set-enabled', { enabled }),
    onTurnSnapshotsChanged: (conversationId: string, cb: () => void): (() => void) => {
      const channel = turnSnapshotsChangedChannel(conversationId)
      const listener = () => cb()
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    },
  }
}

export const turnSnapshotsApi = makeTurnSnapshotsApi(ipcRenderer)
