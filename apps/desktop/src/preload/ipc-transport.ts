/**
 * What a preload API needs from Electron's `ipcRenderer`. This computer's APIs use `ipcRenderer` itself; a remote
 * host's APIs use a transport that relays through this computer's main process.
 *
 * A host API factory names its transport parameter `ipcRenderer`, shadowing the Electron import: the preload contract
 * test inventories channels by reading the source for calls on that name with a literal channel.
 */
export interface IpcTransport {
  invoke(channel: string, ...args: unknown[]): Promise<any>
  send(channel: string, ...args: unknown[]): void
  // `any` for the event: listeners declare it as `unknown` or as Electron's event type.
  on(channel: string, listener: (event: any, ...args: any[]) => void): unknown
  removeListener(channel: string, listener: (event: any, ...args: any[]) => void): unknown
}
