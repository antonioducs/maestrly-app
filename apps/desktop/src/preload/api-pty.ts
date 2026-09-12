import { ipcRenderer } from 'electron'
import type { PtyStreamMeta } from '../shared/pty'

type PtyDataEvent = { data: string; generation: number; sequence: number }
type PtyExitEvent = { code: number; generation?: number }

export const ptyApi = {
  writePty: (id: string, data: string): void => ipcRenderer.send('pty:write', { id, data }),
  resizePty: (id: string, cols: number, rows: number): void => ipcRenderer.send('pty:resize', { id, cols, rows }),
  signalPty: (id: string, signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): void =>
    ipcRenderer.send('pty:signal', { id, signal }),
  killPty: (id: string): void => ipcRenderer.send('pty:close', { id }),
  onPtyData: (id: string, cb: (data: string, meta?: PtyStreamMeta) => void): (() => void) => {
    const channel = `pty:data:${id}`
    const listener = (_event: unknown, payload: PtyDataEvent | string) => {
      if (typeof payload === 'string') cb(payload)
      else cb(payload.data, { generation: payload.generation, sequence: payload.sequence })
    }
    ipcRenderer.on(channel, listener)
    ipcRenderer.send('pty:subscribe', id)
    return () => {
      ipcRenderer.removeListener(channel, listener)
      ipcRenderer.send('pty:unsubscribe', id)
    }
  },
  onPtyExit: (id: string, cb: (code: number, generation?: number) => void): (() => void) => {
    const channel = `pty:exit:${id}`
    const listener = (_event: unknown, payload: PtyExitEvent | number) => {
      if (typeof payload === 'number') cb(payload)
      else cb(payload.code, payload.generation)
    }
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
}
