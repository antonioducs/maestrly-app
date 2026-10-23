import { ipcRenderer } from 'electron'
import type { IpcTransport } from './ipc-transport'
import type {
  EmptyRemoteDecision,
  ProjectSetupProgress,
  ProjectSetupRequest,
  ProjectSetupResult,
} from '../shared/project-setup'
import type { Workspace } from './api-workspace'

// The transport parameter keeps Electron's name on purpose: see ipc-transport.ts.
export function makeProjectSetupApi(ipcRenderer: IpcTransport) {
  return {
    pickProjectDirectory: (purpose: 'open' | 'parent'): Promise<string | null> =>
      ipcRenderer.invoke('project-setup:pick-directory', purpose),
    startProjectSetup: (request: ProjectSetupRequest): Promise<ProjectSetupResult<Workspace>> =>
      ipcRenderer.invoke('project-setup:start', request),
    cancelProjectSetup: (operationId: string): Promise<boolean> =>
      ipcRenderer.invoke('project-setup:cancel', operationId),
    resolveEmptyRemoteProjectSetup: (operationId: string, decision: EmptyRemoteDecision): Promise<boolean> =>
      ipcRenderer.invoke('project-setup:resolve-empty-remote', { operationId, decision }),
    onProjectSetupProgress: (callback: (progress: ProjectSetupProgress) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: ProjectSetupProgress): void => {
        callback(progress)
      }
      ipcRenderer.on('project-setup:progress', listener)
      return () => ipcRenderer.removeListener('project-setup:progress', listener)
    },
    /** Folder where chats create and clone projects; also the default parent in the project dialog. */
    getProjectsDirectory: (): Promise<string | null> => ipcRenderer.invoke('project-setup:projects-directory-get'),
    /** Opens the folder picker and saves the choice; `ok` is false when the person cancels or the folder is invalid. */
    pickProjectsDirectory: (): Promise<{ ok: boolean; path: string | null; error?: string }> =>
      ipcRenderer.invoke('project-setup:projects-directory-pick'),
    /** Saves a folder of the host chosen in this window, for hosts without a native picker. */
    setProjectsDirectory: (path: string): Promise<{ ok: boolean; path: string | null; error?: string }> =>
      ipcRenderer.invoke('project-setup:projects-directory-set', path),
    clearProjectsDirectory: (): Promise<null> => ipcRenderer.invoke('project-setup:projects-directory-clear'),
    onProjectsDirectoryChanged: (callback: (path: string | null) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, path: string | null): void => callback(path)
      ipcRenderer.on('project-setup:projects-directory-changed', listener)
      return () => ipcRenderer.removeListener('project-setup:projects-directory-changed', listener)
    },
  }
}
export const projectSetupApi = makeProjectSetupApi(ipcRenderer)
