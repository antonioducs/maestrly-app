import { ipcRenderer } from 'electron'
import type { ExportResult, LocalDataResetResult, LocalDataSummary } from '../shared/local-data'

export type { ExportResult, LocalDataResetResult, LocalDataSummary } from '../shared/local-data'

export const localDataApi = {
  exportData: (): Promise<ExportResult> => ipcRenderer.invoke('data:export'),
  getLocalDataSummary: (): Promise<LocalDataSummary> => ipcRenderer.invoke('data:local-summary'),
  resetLocalData: (): Promise<LocalDataResetResult> => ipcRenderer.invoke('data:reset'),
}
