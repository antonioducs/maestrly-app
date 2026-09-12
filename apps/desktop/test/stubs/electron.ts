import os from 'node:os'
import path from 'node:path'

/**
 * Electron test stub, mapped through `resolve.alias` in vitest.config. Vitest runs in plain Node,
 * without the Electron runtime, so provide defaults for symbols used during module imports
 * (for example, `app` in store.ts). Tests such as preload-contract use `vi.spyOn` on this same
 * `ipcRenderer`/`contextBridge` object: the alias shares one module instance with production code.
 */

const TMP = path.join(os.tmpdir(), 'agents-test-electron')

export const app = {
  getPath: (_name: string): string => TMP,
  getName: (): string => 'agents-test',
  getVersion: (): string => '0.0.0-test',
  getLocale: (): string => 'en-US',
  setName: (_name: string): void => {},
  setPath: (_name: string, _p: string): void => {},
  getAppPath: (): string => TMP,
  isPackaged: false,
  whenReady: (): Promise<void> => Promise.resolve(),
  on: (): unknown => app,
  once: (): unknown => app,
  removeListener: (): unknown => app,
  quit: (): void => {},
  requestSingleInstanceLock: (): boolean => true,
  dock: { setIcon: (): void => {} },
}

export const ipcMain = {
  handle: (_channel: string, _fn: unknown): void => {},
  on: (_channel: string, _fn: unknown): void => {},
  removeHandler: (_channel: string): void => {},
}

export const ipcRenderer = {
  invoke: (_channel: string, ..._args: unknown[]): Promise<unknown> => Promise.resolve(undefined),
  send: (_channel: string, ..._args: unknown[]): void => {},
  on: (_channel: string, _fn: unknown): void => {},
  removeListener: (_channel: string, _fn: unknown): void => {},
}

export const contextBridge = {
  exposeInMainWorld: (_key: string, _api: unknown): void => {},
}

export const clipboard = {
  writeText: (_text: string): void => {},
}

export class BrowserWindow {
  static fromWebContents(): BrowserWindow | null {
    return new BrowserWindow()
  }
  webContents = { send: (): void => {}, isDestroyed: (): boolean => false }
  isDestroyed(): boolean {
    return false
  }
  on(): this {
    return this
  }
}

export const dialog = {
  showErrorBox: (): void => {},
  // #614: delegation confirmation defaults to denial (response 0). Tests spy on
  // dialog.showMessageBox; the alias shares this module instance with the code under test.
  showMessageBox: (): Promise<{ response: number; checkboxChecked: boolean }> =>
    Promise.resolve({ response: 0, checkboxChecked: false }),
  showOpenDialog: (): Promise<{ canceled: boolean; filePaths: string[] }> =>
    Promise.resolve({ canceled: true, filePaths: [] }),
}

export const nativeImage = {
  createFromPath: (): { isEmpty: () => boolean } => ({ isEmpty: () => true }),
  // browser-control.screenshot resizes through nativeImage. Provide an inert Node default;
  // tests spy on nativeImage.createFromBuffer and inject a fake image.
  createFromBuffer: (): {
    isEmpty: () => boolean
    getSize: () => { width: number; height: number }
    resize: () => unknown
    toPNG: () => Buffer
  } => ({
    isEmpty: () => true,
    getSize: () => ({ width: 0, height: 0 }),
    resize: () => ({}),
    toPNG: () => Buffer.alloc(0),
  }),
}

export const nativeTheme = { themeSource: 'dark' as string }
export const shell = { openExternal: (): Promise<void> => Promise.resolve() }

// `safeStorage` (encrypted session storage, #110) uses fake encryption for deterministic round trips;
// secure-store already adds the prefix and base64 encoding. `__setEncryptionAvailable` simulates
// an unavailable keyring (Linux without libsecret) to exercise the memory-only fallback.
let _encAvailable = true
export const safeStorage = {
  isEncryptionAvailable: (): boolean => _encAvailable,
  encryptString: (s: string): Buffer => Buffer.from(`enc::${s}`, 'utf8'),
  decryptString: (b: Buffer): string => {
    const s = b.toString('utf8')
    if (!s.startsWith('enc::')) throw new Error('invalid blob')
    return s.slice('enc::'.length)
  },
  /** TEST ONLY: toggle encryption availability. */
  __setEncryptionAvailable: (v: boolean): void => {
    _encAvailable = v
  },
}
// Session: `defaultSession` (CSP/media) and `fromPartition` (embedded browser, `persist:drawer-browser`).
// The no-op `setPermissionRequestHandler` lets `hardenBrowserSession` (#560) and
// `browserClearCache` load in plain Node under Vitest.
const fakeSession = {
  webRequest: { onHeadersReceived: (): void => {} },
  setPermissionRequestHandler: (_fn: unknown): void => {},
  clearCache: (): Promise<void> => Promise.resolve(),
  clearStorageData: (): Promise<void> => Promise.resolve(),
}
export const session = {
  defaultSession: fakeSession,
  fromPartition: (_partition: string): typeof fakeSession => fakeSession,
}
export const utilityProcess = { fork: (): unknown => ({ on: () => {}, postMessage: () => {} }) }
// `net.fetch` allows HTTP client modules to load in plain Node under Vitest.
// Reject by default to prevent network calls; tests must mock requests explicitly.
export const net = {
  fetch: (): Promise<unknown> => Promise.reject(new Error('net.fetch is unavailable in the test stub')),
}

export default {
  app,
  ipcMain,
  ipcRenderer,
  contextBridge,
  clipboard,
  BrowserWindow,
  dialog,
  nativeImage,
  nativeTheme,
  shell,
  safeStorage,
  session,
  utilityProcess,
  net,
}
