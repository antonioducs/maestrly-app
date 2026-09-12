import { ipcRenderer } from 'electron'

export type PlatformOs = 'mac' | 'win' | 'linux'

export interface PlatformInfo {
  os: PlatformOs

  ttOffset: number

  openLabels: { terminal: string; files: string }

  isE2E: boolean
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
}

export const appApi = {
  platformInfo,

  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),

  getOpenTargets: (): Promise<{ terminal: boolean; finder: boolean; vscode: boolean }> =>
    ipcRenderer.invoke('open:targets'),
  openExternal: (
    scope: 'conv' | 'workspace',
    id: string,
    target: 'terminal' | 'finder' | 'vscode'
  ): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('open:external', scope, id, target),

  openExternalUrl: (url: string): Promise<void> => ipcRenderer.invoke('open:url', url),

  onStatus: (cb: (payload: { agentId: string; status: string }) => void): (() => void) => {
    const listener = (_event: unknown, payload: { agentId: string; status: string }) => cb(payload)
    ipcRenderer.on('agent:status', listener)
    return () => ipcRenderer.removeListener('agent:status', listener)
  },
  onWindowFullscreen: (cb: (full: boolean) => void): (() => void) => {
    const listener = (_event: unknown, full: boolean) => cb(full)
    ipcRenderer.on('window:fullscreen', listener)
    return () => ipcRenderer.removeListener('window:fullscreen', listener)
  },
}
