import { ipcRenderer } from 'electron'
import type { FleetBackupApi } from '../shared/fleet-backup'
import type { FleetServerScoped } from '../shared/fleet-servers'

export type * from '../shared/fleet-backup'

/** A server's backups: each call names its server first. Google Drive tokens stay in the main process. */
export const fleetBackup: FleetServerScoped<FleetBackupApi> = {
  status: (fleetServerId) => ipcRenderer.invoke('fleet:backup:status', fleetServerId),
  probe: (fleetServerId, destination) => ipcRenderer.invoke('fleet:backup:probe', fleetServerId, destination),
  hasSavedKey: (fleetServerId, destination) =>
    ipcRenderer.invoke('fleet:backup:hasSavedKey', fleetServerId, destination),
  connect: (fleetServerId, input) => ipcRenderer.invoke('fleet:backup:connect', fleetServerId, input),
  update: (fleetServerId, patch) => ipcRenderer.invoke('fleet:backup:update', fleetServerId, patch),
  disconnect: (fleetServerId) => ipcRenderer.invoke('fleet:backup:disconnect', fleetServerId),
  recoveryKey: (fleetServerId) => ipcRenderer.invoke('fleet:backup:recoveryKey', fleetServerId),
  exportRecoveryKey: (fleetServerId) => ipcRenderer.invoke('fleet:backup:exportRecoveryKey', fleetServerId),
  runNow: (fleetServerId, environmentId) => ipcRenderer.invoke('fleet:backup:runNow', fleetServerId, environmentId),
  cancel: (fleetServerId, runId) => ipcRenderer.invoke('fleet:backup:cancel', fleetServerId, runId),
  runs: (fleetServerId, environmentId) => ipcRenderer.invoke('fleet:backup:runs', fleetServerId, environmentId),
  snapshots: (fleetServerId) => ipcRenderer.invoke('fleet:backup:snapshots', fleetServerId),
  restorePreview: (fleetServerId, snapshotId) =>
    ipcRenderer.invoke('fleet:backup:restorePreview', fleetServerId, snapshotId),
  restore: (fleetServerId, input) => ipcRenderer.invoke('fleet:backup:restore', fleetServerId, input),
  driveSignIn: (fleetServerId) => ipcRenderer.invoke('fleet:backup:driveSignIn', fleetServerId),
  cancelDriveSignIn: (fleetServerId) => ipcRenderer.invoke('fleet:backup:cancelDriveSignIn', fleetServerId),
}
