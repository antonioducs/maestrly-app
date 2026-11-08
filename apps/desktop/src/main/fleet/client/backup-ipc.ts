import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import type { IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import {
  FLEET_BACKUPS_FEATURE,
  type FleetBackupConnectResponse,
  type FleetBackupDestination,
  type FleetBackupProbeResponse,
  type FleetBackupRestorePreview,
  type FleetBackupRun,
  type FleetBackupSnapshotsResponse,
  type FleetBackupStatus,
  fleetBackupDestinationLabel,
  fleetBackupDriveDestinationSchema,
  fleetBackupGcsDestinationSchema,
  fleetBackupS3DestinationSchema,
  fleetBackupSnapshotIdSchema,
  fleetBackupUpdateRequestSchema,
  fleetEnvironmentIdSchema,
  fleetIdSchema,
} from '@maestrly/bot-fleet-protocol'
import type {
  FleetBackupConnectResult,
  FleetBackupDestinationDraft,
  FleetBackupDriveGrant,
} from '../../../shared/fleet-backup'
import { fleetBackupDraftLabel } from '../../../shared/fleet-backup'
import { tMain } from '../../i18n'
import { FleetClientError } from './api'
import type { FleetIpcRegistrar } from './scoped-ipc'
import type { FleetClientService } from './service'
import { fleetBackupRecoveryKeyFor, saveFleetBackupRecoveryKey } from './settings'

/** How long a Google Drive sign-in stays usable to set up a destination. */
export const DRIVE_GRANT_TTL_MS = 15 * 60_000

/** What a Google Drive sign-in gave: the client it signed in with, its tokens and the account. */
export type FleetBackupDriveAuthorization = {
  client: { clientId: string; clientSecret: string }
  token: { accessToken: string; refreshToken: string; expiry: string }
  account: string | null
}
export interface FleetBackupIpcDeps {
  /** The Google Drive sign-ins this computer keeps, by grant id; the window only ever sees the id. */
  grants: Map<string, FleetBackupDriveAuthorization & { expiresAt: number }>
  /** Signs in to Google Drive in the browser; absent when this build has no Google client. */
  driveSignIn?: (signal: AbortSignal) => Promise<FleetBackupDriveAuthorization>
  /** Where to save the recovery key, asked over the window that sent the request; null when cancelled. */
  chooseKeyFile(sender: IpcMainInvokeEvent['sender'], defaultPath: string): Promise<string | null>
  writeKeyFile(path: string, text: string): Promise<void>
  savedKey(destinationLabel: string): string | null
  saveKey(destinationLabel: string, key: string): boolean
  now(): number
}

async function chooseWithDialog(sender: IpcMainInvokeEvent['sender'], defaultPath: string): Promise<string | null> {
  const { BrowserWindow, dialog } = await import('electron')
  const window = BrowserWindow.fromWebContents(sender)
  if (!window) throw new Error('No window to save from')
  const result = await dialog.showSaveDialog(window, {
    defaultPath,
    filters: [{ name: 'Text', extensions: ['txt'] }],
  })
  return result.canceled || !result.filePath ? null : result.filePath
}
export function defaultFleetBackupIpcDeps(): FleetBackupIpcDeps {
  return {
    grants: new Map(),
    chooseKeyFile: chooseWithDialog,
    writeKeyFile: (path, text) => writeFile(path, text, { encoding: 'utf8', mode: 0o600 }),
    savedKey: fleetBackupRecoveryKeyFor,
    saveKey: saveFleetBackupRecoveryKey,
    now: Date.now,
  }
}

const draftSchema = z.discriminatedUnion('provider', [
  fleetBackupS3DestinationSchema,
  fleetBackupGcsDestinationSchema,
  z
    .object({
      provider: z.literal('drive'),
      folder: fleetBackupDriveDestinationSchema.shape.folder,
      grantId: z.string().uuid(),
    })
    .strict(),
])
const connectInputSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('create'), destination: draftSchema }).strict(),
  z
    .object({ mode: z.literal('connect'), destination: draftSchema, recoveryKey: z.string().max(100).nullable() })
    .strict(),
])
const restoreInputSchema = z
  .object({ snapshotId: fleetBackupSnapshotIdSchema, keepExistingProjects: z.boolean() })
  .strict()

/** A key the owner typed, kept as the gateway shows keys: upper case, in groups of four. */
function formatKey(key: string): string {
  const value = key.toUpperCase().replace(/[\s-]+/g, '')
  return /^[A-Z2-7]{32}$/.test(value) ? (value.match(/.{4}/g) ?? []).join('-') : key.trim()
}

/**
 * Serves a server's backups to Settings → Bot server. Destinations reach the gateway whole: a Drive draft becomes the
 * sign-in this process kept for it, whose tokens never reach the window. This computer keeps each destination's
 * recovery key, and never removes it on its own: it restores the backups on a new server.
 */
export function registerFleetBackupIpc(scoped: FleetIpcRegistrar, deps: FleetBackupIpcDeps): void {
  const requireBackups = (fleet: FleetClientService) => {
    if (!fleet.hasFeature(FLEET_BACKUPS_FEATURE))
      throw new FleetClientError('PROTOCOL_INCOMPATIBLE', 426, 'Update the bot server to back up its environments')
  }
  const resolve = (draft: FleetBackupDestinationDraft): FleetBackupDestination => {
    if (draft.provider !== 'drive') return draft
    const grant = deps.grants.get(draft.grantId)
    if (!grant || grant.expiresAt <= deps.now()) {
      deps.grants.delete(draft.grantId)
      throw new FleetClientError('INVALID_REQUEST', 400, 'Sign in to Google Drive again')
    }
    return {
      provider: 'drive',
      folder: draft.folder,
      account: grant.account,
      clientId: grant.client.clientId,
      clientSecret: grant.client.clientSecret,
      token: grant.token,
    }
  }
  const recoveryKey = async (fleet: FleetClientService): Promise<string> => {
    requireBackups(fleet)
    const status = (await fleet.call('backupStatus')) as FleetBackupStatus
    const label = status.destination?.label ?? null
    const saved = label ? deps.savedKey(label) : null
    if (saved) return saved
    const { recoveryKey: key } = (await fleet.call('backupRecoveryKey')) as { recoveryKey: string }
    if (label) deps.saveKey(label, key)
    return key
  }

  scoped.handle('fleet:backup:status', async (fleet) =>
    fleet.hasFeature(FLEET_BACKUPS_FEATURE) ? ((await fleet.call('backupStatus')) as FleetBackupStatus) : null
  )
  scoped.mhandle('fleet:backup:probe', async (fleet, _event, raw: unknown) => {
    requireBackups(fleet)
    const destination = resolve(draftSchema.parse(raw))
    return (await fleet.call('backupProbe', { body: { destination } })) as FleetBackupProbeResponse
  })
  scoped.handle('fleet:backup:hasSavedKey', (_fleet, _event, raw: unknown) => {
    return deps.savedKey(fleetBackupDraftLabel(draftSchema.parse(raw))) !== null
  })
  scoped.mhandle('fleet:backup:connect', async (fleet, _event, raw: unknown): Promise<FleetBackupConnectResult> => {
    requireBackups(fleet)
    const input = connectInputSchema.parse(raw)
    const destination = resolve(input.destination)
    const label = fleetBackupDestinationLabel(destination)
    const typed = input.mode === 'connect' ? (input.recoveryKey ?? deps.savedKey(label)) : null
    if (input.mode === 'connect' && !typed) return { ok: false, error: { code: 'wrong-key', message: '' } }
    const idempotencyKey = randomUUID()
    const response = (await fleet.call('backupConnect', {
      body:
        input.mode === 'create'
          ? { mode: 'create', destination, idempotencyKey }
          : { mode: 'connect', destination, recoveryKey: typed, idempotencyKey },
    })) as FleetBackupConnectResponse
    if (!response.ok) return response
    const key = response.recoveryKey ?? (typed ? formatKey(typed) : null)
    return {
      ok: true,
      status: response.status,
      recoveryKey: response.recoveryKey,
      savedOnThisComputer: key ? deps.saveKey(label, key) : false,
    }
  })
  scoped.mhandle('fleet:backup:update', async (fleet, _event, raw: unknown) => {
    requireBackups(fleet)
    return (await fleet.call('backupUpdate', { body: fleetBackupUpdateRequestSchema.parse(raw) })) as FleetBackupStatus
  })
  scoped.mhandle('fleet:backup:disconnect', async (fleet) => {
    requireBackups(fleet)
    return (await fleet.call('backupDisconnect')) as FleetBackupStatus
  })
  scoped.mhandle('fleet:backup:recoveryKey', (fleet) => recoveryKey(fleet))
  scoped.mhandle('fleet:backup:exportRecoveryKey', async (fleet, event): Promise<'saved' | 'cancelled'> => {
    const key = await recoveryKey(fleet)
    const status = (await fleet.call('backupStatus')) as FleetBackupStatus
    const path = await deps.chooseKeyFile(event.sender, 'maestrly-recovery-key.txt')
    if (!path) return 'cancelled'
    const connection = fleet.getConnection()
    const text = tMain('main')('fleetBackup.keyFile', {
      server: connection.hostname ?? connection.url ?? '',
      destination: status.destination?.label ?? '',
      key,
    })
    await deps.writeKeyFile(path, text.endsWith('\n') ? text : text + '\n')
    return 'saved'
  })
  scoped.mhandle('fleet:backup:runNow', async (fleet, _event, environmentId: unknown) => {
    const body = { environmentId: fleetEnvironmentIdSchema.parse(environmentId), idempotencyKey: randomUUID() }
    requireBackups(fleet)
    return (await fleet.call('backupRunsCreate', { body })) as FleetBackupRun
  })
  scoped.mhandle('fleet:backup:cancel', async (fleet, _event, runId: unknown) => {
    const id = fleetIdSchema.parse(runId)
    requireBackups(fleet)
    return (await fleet.call('backupRunCancel', { params: { id } })) as FleetBackupRun
  })
  scoped.handle('fleet:backup:runs', async (fleet, _event, environmentId: unknown) => {
    const query = environmentId === undefined ? {} : { environmentId: fleetEnvironmentIdSchema.parse(environmentId) }
    requireBackups(fleet)
    return ((await fleet.call('backupRunsList', { query })) as { runs: FleetBackupRun[] }).runs
  })
  scoped.handle('fleet:backup:snapshots', async (fleet) => {
    requireBackups(fleet)
    return (await fleet.call('backupSnapshots')) as FleetBackupSnapshotsResponse
  })
  scoped.mhandle('fleet:backup:restorePreview', async (fleet, _event, snapshotId: unknown) => {
    const body = { snapshotId: fleetBackupSnapshotIdSchema.parse(snapshotId) }
    requireBackups(fleet)
    return (await fleet.call('backupRestorePreview', { body })) as FleetBackupRestorePreview
  })
  scoped.mhandle('fleet:backup:restore', async (fleet, _event, raw: unknown) => {
    const body = { ...restoreInputSchema.parse(raw), idempotencyKey: randomUUID() }
    requireBackups(fleet)
    return (await fleet.call('backupRestore', { body })) as FleetBackupRun
  })

  // One sign-in at a time: a new one ends the one before.
  let signingIn: AbortController | null = null
  scoped.mhandle('fleet:backup:driveSignIn', async (): Promise<FleetBackupDriveGrant> => {
    if (!deps.driveSignIn) throw new FleetClientError('CONFLICT', 409, 'Google Drive is not available in this build')
    signingIn?.abort()
    const controller = new AbortController()
    signingIn = controller
    try {
      const authorization = await deps.driveSignIn(controller.signal)
      const now = deps.now()
      for (const [id, grant] of deps.grants) if (grant.expiresAt <= now) deps.grants.delete(id)
      const grantId = randomUUID()
      deps.grants.set(grantId, { ...authorization, expiresAt: now + DRIVE_GRANT_TTL_MS })
      return { grantId, account: authorization.account }
    } finally {
      if (signingIn === controller) signingIn = null
    }
  })
  scoped.mhandle('fleet:backup:cancelDriveSignIn', () => {
    signingIn?.abort()
    signingIn = null
  })
}
