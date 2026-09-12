import { ipcRenderer } from 'electron'
import type {
  MemoryAutoReclaimChangedEvent,
  MemoryPressureEvent,
  MemoryReclaimResult,
  PerformanceDiagnostics,
} from '../shared/performance'

export const performanceApi = {
  /** Collects a local, on-demand snapshot; it does not start polling. */
  getPerformanceDiagnostics: (): Promise<PerformanceDiagnostics> => ipcRenderer.invoke('performance:diagnostics'),
  resetPerformanceCounters: (): Promise<void> => ipcRenderer.invoke('performance:counters-reset'),
  getMemoryAutoReclaim: (): Promise<boolean> => ipcRenderer.invoke('performance:auto-reclaim-get'),
  setMemoryAutoReclaim: (enabled: boolean): void => {
    ipcRenderer.send('performance:auto-reclaim-set', enabled)
  },
  onMemoryAutoReclaimChanged: (cb: (event: MemoryAutoReclaimChangedEvent) => void): (() => void) => {
    const listener = (_e: unknown, event: MemoryAutoReclaimChangedEvent) => cb(event)
    ipcRenderer.on('performance:auto-reclaim-changed', listener)
    return () => ipcRenderer.removeListener('performance:auto-reclaim-changed', listener)
  },
  reclaimSafeMemoryNow: (): Promise<MemoryReclaimResult> => ipcRenderer.invoke('performance:reclaim-now'),
  onMemoryPressure: (cb: (event: MemoryPressureEvent) => void): (() => void) => {
    const listener = (_e: unknown, event: MemoryPressureEvent) => cb(event)
    ipcRenderer.on('performance:memory-pressure', listener)
    return () => ipcRenderer.removeListener('performance:memory-pressure', listener)
  },
}
