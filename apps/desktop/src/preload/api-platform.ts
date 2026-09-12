import { ipcRenderer } from 'electron'
import type { DesktopExecutorSettings, DesktopExecutionRecord, DeviceAuthorizationView, EmbeddedRunnerView, PlatformConnectionView, PlatformProjectBinding, RemotePlatformProject } from '../shared/platform'

export const platformApi = {
  onExecutorOpen:(callback:()=>void):(()=>void)=>{const listener=()=>callback();ipcRenderer.on('executor:open',listener);return()=>ipcRenderer.removeListener('executor:open',listener)},
  platformExecutorSettings:():Promise<DesktopExecutorSettings>=>ipcRenderer.invoke('platform:executor-settings'),
  platformSaveExecutorSettings:(settings:DesktopExecutorSettings):Promise<DesktopExecutorSettings>=>ipcRenderer.invoke('platform:executor-save',settings),
  platformExecutorProviders:():Promise<Array<{id:string;name:string;models:string[]}>>=>ipcRenderer.invoke('platform:executor-providers'),
  platformExecutorHistory:():Promise<DesktopExecutionRecord[]>=>ipcRenderer.invoke('platform:executor-history'),
  platformOpenExecutorConversation:(id:string):Promise<void>=>ipcRenderer.invoke('platform:executor-open',id),
  platformListConnections: (): Promise<PlatformConnectionView[]> => ipcRenderer.invoke('platform:list-connections'),
  platformAddConnection: (url: string): Promise<PlatformConnectionView> => ipcRenderer.invoke('platform:add-connection', url),
  platformBeginDeviceAuthorization: (connectionId: string, clientId: string): Promise<DeviceAuthorizationView> => ipcRenderer.invoke('platform:begin-device-auth', connectionId, clientId),
  platformPollDeviceAuthorization: (connectionId: string): Promise<PlatformConnectionView> => ipcRenderer.invoke('platform:poll-device-auth', connectionId),
  platformDisconnect: (connectionId: string): Promise<PlatformConnectionView> => ipcRenderer.invoke('platform:disconnect', connectionId),
  platformListRemoteProjects: (connectionId: string): Promise<RemotePlatformProject[]> => ipcRenderer.invoke('platform:list-remote-projects', connectionId),
  platformListProjectBindings: (): Promise<PlatformProjectBinding[]> => ipcRenderer.invoke('platform:list-project-bindings'),
  platformSetProjectBinding: (binding: PlatformProjectBinding): Promise<void> => ipcRenderer.invoke('platform:set-project-binding', binding),
  platformRemoveProjectBinding: (workspaceId: string): Promise<void> => ipcRenderer.invoke('platform:remove-project-binding', workspaceId),
  platformRunnerStatus: (): Promise<EmbeddedRunnerView> => ipcRenderer.invoke('platform:runner-status'),
  platformRunnerStart: (connectionId: string): Promise<EmbeddedRunnerView> => ipcRenderer.invoke('platform:runner-start', connectionId),
  platformRunnerStop: (): Promise<void> => ipcRenderer.invoke('platform:runner-stop'),
}

export type PlatformApi = typeof platformApi
