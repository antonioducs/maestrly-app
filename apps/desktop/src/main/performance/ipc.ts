import type { IpcRegistrar } from '../ipc-registrar'
import { getPerformanceDiagnostics, resetPerformanceCounters } from './metrics'
import {
  isMemoryAutoReclaimEnabled,
  runMemoryReclaim,
  setMemoryAutoReclaimEnabled,
} from './memory-reclaimer'

/** On-demand local diagnostics. No timer/polling is installed by this surface. */
export function registerPerformanceIpc(reg: IpcRegistrar): void {
  reg.mhandle('performance:diagnostics', () => getPerformanceDiagnostics())
  reg.mhandle('performance:counters-reset', () => {
    resetPerformanceCounters()
  })
  reg.handle('performance:auto-reclaim-get', () => isMemoryAutoReclaimEnabled())
  reg.on('performance:auto-reclaim-set', (_e, enabled: boolean) => {
    setMemoryAutoReclaimEnabled(enabled === true)
  })
  reg.mhandle('performance:reclaim-now', () => runMemoryReclaim('manual'))
}
