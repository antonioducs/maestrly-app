import type { IpcRegistrar } from './ipc-registrar'
import { killPty, ptyExists, resizePty, signalPty, subscribePtyData, unsubscribePtyData, writePty } from './pty-manager'

type PtyPayload = { id: string }

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('term:') && value.length <= 256
}

/** Minimal shell-terminal IPC. terminal-manager owns creation and cwd authorization. */
export function registerPtyIpc(reg: IpcRegistrar): void {
  reg.mon('pty:write', (_event, payload: PtyPayload & { data: string }) => {
    if (!validId(payload?.id) || typeof payload.data !== 'string' || !ptyExists(payload.id)) return
    writePty(payload.id, payload.data)
  })
  reg.mon('pty:resize', (_event, payload: PtyPayload & { cols: number; rows: number }) => {
    if (!validId(payload?.id) || !ptyExists(payload.id)) return
    resizePty(payload.id, payload.cols, payload.rows)
  })
  reg.mon('pty:signal', (_event, payload: PtyPayload & { signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL' }) => {
    if (!validId(payload?.id) || !ptyExists(payload.id)) return
    signalPty(payload.id, payload.signal)
  })
  reg.mon('pty:close', (_event, payload: PtyPayload) => {
    if (validId(payload?.id)) killPty(payload.id)
  })
  reg.mon('pty:subscribe', (event, id: string) => {
    if (validId(id)) subscribePtyData(event.sender, id)
  })
  reg.mon('pty:unsubscribe', (event, id: string) => {
    if (validId(id)) unsubscribePtyData(event.sender, id)
  })
}
