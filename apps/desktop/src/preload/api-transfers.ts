import { ipcRenderer, webUtils } from 'electron'
import type { HostTransferUploadResult, HostTransferView } from '../shared/host-transfers'

export type {
  HostTransferDirection,
  HostTransferError,
  HostTransferKind,
  HostTransferStage,
  HostTransferState,
  HostTransferUploadResult,
  HostTransferView,
} from '../shared/host-transfers'

/** This computer's queue of files moved to and from its hosts. */
export const transfersApi = {
  transfersList: (): Promise<HostTransferView[]> => ipcRenderer.invoke('transfers:list'),
  /** Downloads a host's file to this computer's Downloads folder; returns the transfer's id. */
  transfersDownload: (hostId: string, remotePath: string): Promise<string> =>
    ipcRenderer.invoke('transfers:download', hostId, remotePath),
  /** Downloads a host's file into a temporary folder and opens it there once it is verified. */
  transfersOpen: (hostId: string, remotePath: string): Promise<string> =>
    ipcRenderer.invoke('transfers:open', hostId, remotePath),
  /** Downloads a host's folder, extracted, into this computer's Downloads folder; returns the transfer's id. */
  transfersDownloadFolder: (hostId: string, remotePath: string): Promise<string> =>
    ipcRenderer.invoke('transfers:download-folder', hostId, remotePath),
  /**
   * Files and folders dropped from Finder: their paths are read from the files themselves, never taken from the
   * page; this computer tells files from folders.
   */
  transfersUploadFiles: (hostId: string, remoteDirectory: string, files: File[]): Promise<HostTransferUploadResult> =>
    ipcRenderer.invoke(
      'transfers:upload-paths',
      hostId,
      remoteDirectory,
      files.map((file) => webUtils.getPathForFile(file)).filter(Boolean)
    ),
  /** Asks for files, or folders, with this computer's file dialog and uploads them to `remoteDirectory`. */
  transfersUploadPick: (
    hostId: string,
    remoteDirectory: string,
    mode: 'files' | 'folder' = 'files'
  ): Promise<HostTransferUploadResult> => ipcRenderer.invoke('transfers:upload-pick', hostId, remoteDirectory, mode),
  transfersPause: (id: string): Promise<void> => ipcRenderer.invoke('transfers:pause', id),
  transfersResume: (id: string): Promise<void> => ipcRenderer.invoke('transfers:resume', id),
  transfersCancel: (id: string): Promise<void> => ipcRenderer.invoke('transfers:cancel', id),
  transfersRemove: (id: string): Promise<void> => ipcRenderer.invoke('transfers:remove', id),
  transfersRetry: (id: string, options?: { overwrite?: boolean }): Promise<void> =>
    ipcRenderer.invoke('transfers:retry', id, options),
  /** Shows a finished download in this computer's file manager. */
  transfersReveal: (id: string): Promise<void> => ipcRenderer.invoke('transfers:reveal', id),
  onTransfersChanged: (callback: (transfers: HostTransferView[]) => void): (() => void) => {
    const listener = (_event: unknown, transfers: HostTransferView[]) => callback(transfers)
    ipcRenderer.on('transfers:changed', listener)
    return () => ipcRenderer.removeListener('transfers:changed', listener)
  },
}
