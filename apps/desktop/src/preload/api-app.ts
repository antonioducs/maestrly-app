import { ipcRenderer } from 'electron'
import type { NotificationTarget } from '../shared/notifications'
import type { IpcTransport } from './ipc-transport'

export type PlatformOs = 'mac' | 'win' | 'linux'

export interface PlatformInfo {
  os: PlatformOs

  ttOffset: number

  openLabels: { terminal: string; files: string }

  isE2E: boolean
  /** This app is a bot's own Maestrly (`MAESTRLY_BOT_MODE`): its window only offers the settings a bot needs. */
  botMode: boolean
  /** This app hosts workspaces on a server (`MAESTRLY_SERVER_MODE`): its window only shows a status page. */
  serverMode: boolean
}

export interface AppInfo {
  channel: 'prod' | 'beta' | 'dev'

  instanceId: string | null
  productName: string
  version: string
  isPackaged: boolean

  hideChannelBadge: boolean
}

const PLATFORM_OS: PlatformOs = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'

const platformInfo: PlatformInfo = {
  os: PLATFORM_OS,
  ttOffset: PLATFORM_OS === 'mac' ? 78 : 0,
  openLabels: {
    terminal: 'Terminal',
    files: PLATFORM_OS === 'win' ? 'Explorer' : PLATFORM_OS === 'mac' ? 'Finder' : 'Files',
  },
  isE2E: process.env.AGENTS_E2E === '1',
  // Same variable as FLEET_BOT_ENV.mode, read by main's isBotMode(); a literal keeps the protocol out of the preload.
  botMode: process.env.MAESTRLY_BOT_MODE === '1',
  // Same variable as FLEET_BOT_ENV.serverMode, read by main's isServerMode().
  serverMode: process.env.MAESTRLY_SERVER_MODE === '1',
}

/** This computer's app and window. */
export const appApi = {
  platformInfo,

  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),

  openExternalUrl: (url: string): Promise<void> => ipcRenderer.invoke('open:url', url),

  onWindowFullscreen: (cb: (full: boolean) => void): (() => void) => {
    const listener = (_event: unknown, full: boolean) => cb(full)
    ipcRenderer.on('window:fullscreen', listener)
    return () => ipcRenderer.removeListener('window:fullscreen', listener)
  },

  /** How many things need the owner, which the app icon shows: conversations, bots' requests, and bots' news. */
  setAppBadgeCount: (count: number): void => ipcRenderer.send('app:badge-count', count),

  /** The owner clicked a system notification: the window shows what it is about. */
  onNotificationOpen: (cb: (target: NotificationTarget) => void): (() => void) => {
    const listener = (_event: unknown, target: NotificationTarget) => cb(target)
    ipcRenderer.on('notification:open', listener)
    return () => ipcRenderer.removeListener('notification:open', listener)
  },
}

// The transport parameter keeps Electron's name on purpose: see ipc-transport.ts.
export function makeAppHostApi(ipcRenderer: IpcTransport) {
  return {
    getOpenTargets: (): Promise<{ terminal: boolean; finder: boolean; vscode: boolean }> =>
      ipcRenderer.invoke('open:targets'),
    openExternal: (
      scope: 'conv' | 'workspace',
      id: string,
      target: 'terminal' | 'finder' | 'vscode'
    ): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('open:external', scope, id, target),

    onStatus: (cb: (payload: { agentId: string; status: string }) => void): (() => void) => {
      const listener = (_event: unknown, payload: { agentId: string; status: string }) => cb(payload)
      ipcRenderer.on('agent:status', listener)
      return () => ipcRenderer.removeListener('agent:status', listener)
    },
  }
}
export const appHostApi = makeAppHostApi(ipcRenderer)
