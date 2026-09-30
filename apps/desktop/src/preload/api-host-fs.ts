import { ipcRenderer } from 'electron'
import type { HostFsListing, HostFsListOptions, HostFsRoot } from '../shared/host-fs'
import type { IpcTransport } from './ipc-transport'

export type { HostFsEntry, HostFsListing, HostFsListOptions, HostFsRoot } from '../shared/host-fs'

// The transport parameter keeps Electron's name on purpose: see ipc-transport.ts.
export function makeHostFsApi(ipcRenderer: IpcTransport) {
  return {
    /** The folders of the host a workspace may be added from. */
    hostFsRoots: (): Promise<HostFsRoot[]> => ipcRenderer.invoke('host-fs:roots'),
    hostFsList: (path: string, options?: HostFsListOptions): Promise<HostFsListing> =>
      ipcRenderer.invoke('host-fs:list', path, options),
    /** Creates a folder and returns its path. */
    hostFsMkdir: (parent: string, name: string): Promise<string> => ipcRenderer.invoke('host-fs:mkdir', parent, name),
  }
}
export const hostFsApi = makeHostFsApi(ipcRenderer)
