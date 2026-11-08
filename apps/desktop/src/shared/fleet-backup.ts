import {
  fleetBackupDestinationLabel,
  type FleetBackupDestination,
  type FleetBackupErrorCode,
  type FleetBackupProbeResponse,
  type FleetBackupRestorePreview,
  type FleetBackupRun,
  type FleetBackupSnapshotsResponse,
  type FleetBackupStatus,
  type FleetBackupUpdateRequest,
} from '@maestrly/bot-fleet-protocol'

/** A destination as the window may hold it: Drive tokens stay in the main process behind `grantId`. */
export type FleetBackupDestinationDraft =
  | Extract<FleetBackupDestination, { provider: 's3' | 'gcs' }>
  | { provider: 'drive'; folder: string; grantId: string }
export type FleetBackupConnectInput =
  | { mode: 'create'; destination: FleetBackupDestinationDraft }
  /** `recoveryKey` null: the key this computer saved for that destination. */
  | { mode: 'connect'; destination: FleetBackupDestinationDraft; recoveryKey: string | null }
export type FleetBackupConnectResult =
  | { ok: true; status: FleetBackupStatus; recoveryKey: string | null; savedOnThisComputer: boolean }
  | { ok: false; error: { code: FleetBackupErrorCode; message: string } }
/** A Google Drive sign-in the main process keeps; the window names it by `grantId` only. */
export type FleetBackupDriveGrant = { grantId: string; account: string | null }

/** A server's backups, as Settings → Bot server reaches them. */
export interface FleetBackupApi {
  /** null: the server does not back up its environments. */
  status(): Promise<FleetBackupStatus | null>
  probe(destination: FleetBackupDestinationDraft): Promise<FleetBackupProbeResponse>
  /** Whether this computer kept the recovery key of that destination. */
  hasSavedKey(destination: FleetBackupDestinationDraft): Promise<boolean>
  connect(input: FleetBackupConnectInput): Promise<FleetBackupConnectResult>
  update(patch: FleetBackupUpdateRequest): Promise<FleetBackupStatus>
  disconnect(): Promise<FleetBackupStatus>
  recoveryKey(): Promise<string>
  exportRecoveryKey(): Promise<'saved' | 'cancelled'>
  runNow(environmentId: string): Promise<FleetBackupRun>
  cancel(runId: string): Promise<FleetBackupRun>
  runs(environmentId?: string): Promise<FleetBackupRun[]>
  snapshots(): Promise<FleetBackupSnapshotsResponse>
  restorePreview(snapshotId: string): Promise<FleetBackupRestorePreview>
  restore(input: { snapshotId: string; keepExistingProjects: boolean }): Promise<FleetBackupRun>
  driveSignIn(): Promise<FleetBackupDriveGrant>
  cancelDriveSignIn(): Promise<void>
}

/**
 * How this computer names a destination it kept a key for: the gateway's label (`fleetBackupDestinationLabel`) of the
 * destination the draft becomes.
 */
export function fleetBackupDraftLabel(draft: FleetBackupDestinationDraft): string {
  if (draft.provider !== 'drive') return fleetBackupDestinationLabel(draft)
  // As `fleetBackupDestinationLabel` names a Drive destination: by its folder only.
  return `drive://${draft.folder}`
}
