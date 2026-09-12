import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'

/**
 * Domain IPC registration contract. Each domain exports registerXxxIpc(reg) with injected registrars,
 * avoiding ipcMain/guard imports and main-entry cycles. handle/on are read channels; mhandle/mon wrap
 * sensitive mutations in trusted-sender guards. Domains choose based on channel semantics and remain
 * testable in Node.
 */
export interface IpcRegistrar {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handle: (channel: string, fn: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mhandle: (channel: string, fn: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on: (channel: string, fn: (event: IpcMainEvent, ...args: any[]) => void) => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mon: (channel: string, fn: (event: IpcMainEvent, ...args: any[]) => void) => void
}
