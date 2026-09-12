import { ipcRenderer } from 'electron'
import type {
  EmptyRemoteDecision,
  ProjectSetupProgress,
  ProjectSetupRequest,
  ProjectSetupResult,
} from '../shared/project-setup'
import type { Workspace } from './api-workspace'

export const projectSetupApi = {
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
}
