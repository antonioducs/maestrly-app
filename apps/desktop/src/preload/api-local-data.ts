import { ipcRenderer } from 'electron'
import type { IpcTransport } from './ipc-transport'
import type { ExportResult, LocalDataResetResult, LocalDataSummary } from '../shared/local-data'

export type { ExportResult, LocalDataResetResult, LocalDataSummary } from '../shared/local-data'

// The transport parameter keeps Electron's name on purpose: see ipc-transport.ts.
export function makeLocalDataApi(ipcRenderer: IpcTransport) {
  return {
    exportData: (): Promise<ExportResult> => ipcRenderer.invoke('data:export'),
    getLocalDataSummary: (): Promise<LocalDataSummary> => ipcRenderer.invoke('data:local-summary'),
    resetLocalData: (): Promise<LocalDataResetResult> => ipcRenderer.invoke('data:reset'),
  }
}
export const localDataApi = makeLocalDataApi(ipcRenderer)
