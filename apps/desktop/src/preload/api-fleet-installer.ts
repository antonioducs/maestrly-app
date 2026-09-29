import { ipcRenderer } from 'electron'
import type {
  FleetInstallLocalInput,
  FleetInstallRemoteInput,
  FleetInstallerStatus,
  FleetUpdateBotsResult,
  LocalDockerCheck,
} from '../shared/fleet-installer'

export type * from '../shared/fleet-installer'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

/** The bot server installer: jobs resolve with the status when they end and stream it while they run. */
export const fleetInstallerApi = {
  fleetInstallerStatus: (): Promise<FleetInstallerStatus> => ipcRenderer.invoke('fleet:installer:status'),
  fleetInstallerCheckLocal: (): Promise<LocalDockerCheck> => ipcRenderer.invoke('fleet:installer:checkLocal'),
  fleetInstallerInstallLocal: (input: FleetInstallLocalInput): Promise<FleetInstallerStatus> =>
    ipcRenderer.invoke('fleet:installer:installLocal', input),
  fleetInstallerInstallRemote: (input: FleetInstallRemoteInput): Promise<FleetInstallerStatus> =>
    ipcRenderer.invoke('fleet:installer:installRemote', input),
  fleetInstallerUpdate: (): Promise<FleetInstallerStatus> => ipcRenderer.invoke('fleet:installer:update'),
  /** Updates the server when this app can, then schedules every environment on an older image to follow. */
  fleetUpdateBots: (): Promise<FleetUpdateBotsResult> => ipcRenderer.invoke('fleet:installer:updateBots'),
  fleetInstallerSetPrivateNetwork: (allow: boolean): Promise<FleetInstallerStatus> =>
    ipcRenderer.invoke('fleet:installer:setPrivateNetwork', allow),
  fleetInstallerDisconnect: (): Promise<FleetInstallerStatus> => ipcRenderer.invoke('fleet:installer:disconnect'),
  /** Deletes the server and everything on it; the renderer passes the owner's typed confirmation. */
  fleetInstallerRemove: (confirmation: { confirm: 'remove' }): Promise<FleetInstallerStatus> =>
    ipcRenderer.invoke('fleet:installer:remove', confirmation),
  fleetInstallerCancel: (): Promise<void> => ipcRenderer.invoke('fleet:installer:cancel'),
  onFleetInstallerStatus: (cb: (status: FleetInstallerStatus) => void): (() => void) =>
    subscribe('fleet:installer:status', cb),
}
