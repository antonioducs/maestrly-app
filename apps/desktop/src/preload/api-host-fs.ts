import { ipcRenderer } from 'electron'
import type { HostFsListing, HostFsListOptions, HostFsPreview, HostFsRoot, HostFsUsage } from '../shared/host-fs'
import type { IpcTransport } from './ipc-transport'

export type {
  HostFsEntry,
  HostFsListing,
  HostFsListOptions,
  HostFsPreview,
  HostFsRoot,
  HostFsUsage,
} from '../shared/host-fs'

// The transport parameter keeps Electron's name on purpose: see ipc-transport.ts.
export function makeHostFsApi(ipcRenderer: IpcTransport) {
  return {
    /** The folders of the host a workspace may be added from. */
    hostFsRoots: (): Promise<HostFsRoot[]> => ipcRenderer.invoke('host-fs:roots'),
    hostFsList: (path: string, options?: HostFsListOptions): Promise<HostFsListing> =>
      ipcRenderer.invoke('host-fs:list', path, options),
    /** Creates a folder and returns its path. */
    hostFsMkdir: (parent: string, name: string): Promise<string> => ipcRenderer.invoke('host-fs:mkdir', parent, name),
    /** The folder of a conversation of the host, when it lies inside the folders it allows. */
    hostFsConversationFolder: (conversationId: string): Promise<string | null> =>
      ipcRenderer.invoke('host-fs:conversation-folder', conversationId),
    /** The first 64 KiB of a file, as text unless it is binary. */
    hostFsPreview: (path: string): Promise<HostFsPreview> => ipcRenderer.invoke('host-fs:preview', path),
    hostFsUsage: (path: string): Promise<HostFsUsage> => ipcRenderer.invoke('host-fs:usage', path),
    /** Renames an entry in its folder and returns its new path. */
    hostFsRename: (path: string, name: string): Promise<string> => ipcRenderer.invoke('host-fs:rename', path, name),
    /** Deletes a file, a link, or a folder with everything in it. */
    hostFsDelete: (path: string): Promise<void> => ipcRenderer.invoke('host-fs:delete', path),
  }
}
export const hostFsApi = makeHostFsApi(ipcRenderer)
