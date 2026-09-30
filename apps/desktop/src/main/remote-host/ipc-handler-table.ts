/**
 * Every IPC handler the registrar installed, by channel. A host runs these same handlers for the frames another
 * computer sends over the bridge (see server/remote-ui-hub), so a remote renderer and a window of this app reach one
 * implementation. `invoke` handlers answer (`ipcMain.handle`); `send` handlers do not (`ipcMain.on`).
 */
export type RecordedHandler = {
  kind: 'invoke' | 'send'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn: (event: any, ...args: any[]) => unknown
}

export class IpcHandlerTable {
  private readonly handlers = new Map<string, RecordedHandler>()

  record(channel: string, kind: RecordedHandler['kind'], fn: RecordedHandler['fn']): void {
    this.handlers.set(channel, { kind, fn })
  }

  get(channel: string): RecordedHandler | null {
    return this.handlers.get(channel) ?? null
  }
}

export const ipcHandlerTable = new IpcHandlerTable()
