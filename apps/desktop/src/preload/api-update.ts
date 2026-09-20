import { ipcRenderer } from 'electron'
import type { UpdateState } from '../shared/update'

export type { UpdateState, UpdatePhase, UpdateMode } from '../shared/update'

/**
 * Update contract exposed to the renderer. The main process owns the state; the renderer reads the
 * current snapshot once and then mirrors the `update:status` broadcast.
 */
export const updateApi = {
  getUpdateState: (): Promise<UpdateState> => ipcRenderer.invoke('update:state'),

  checkForUpdates: (options?: { ignoreSkip?: boolean }): Promise<UpdateState> =>
    ipcRenderer.invoke('update:check', options ?? {}),

  downloadUpdate: (): Promise<UpdateState> => ipcRenderer.invoke('update:download'),

  installUpdate: (): Promise<void> => ipcRenderer.invoke('update:install'),

  skipUpdateVersion: (): Promise<UpdateState> => ipcRenderer.invoke('update:skip'),

  openUpdateRelease: (): Promise<void> => ipcRenderer.invoke('update:open-release'),

  onUpdateStatus: (cb: (state: UpdateState) => void): (() => void) => {
    const listener = (_event: unknown, state: UpdateState) => cb(state)
    ipcRenderer.on('update:status', listener)
    return () => ipcRenderer.removeListener('update:status', listener)
  },
}
