import { createHash } from 'node:crypto'
import {
  type FleetBackupDestination,
  type FleetBackupRun,
  type FleetBot,
  type FleetOwnerMemoryEntry,
  type FleetRoutine,
  FLEET_PEER_THREAD_SETTINGS_DEFAULT,
  FLEET_ROUTINE_RUN_SETTINGS_DEFAULT,
} from '@maestrly/bot-fleet-protocol'
import type { StoredBackupRun, StoredBackupSettings, StoredEnvironment } from '../src/store.js'

export const at = (day: number, hour = 10) =>
  `2026-11-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

export function botRecord(id: string, overrides: Partial<FleetBot> = {}): FleetBot {
  return {
    id,
    name: 'Bot ' + id,
    role: '',
    instructions: 'Synthetic instructions',
    tint: '#4978c6',
    ceiling: 'ask',
    selection: null,
    compaction: null,
    compactionSource: null,
    compactionState: null,
    talksTo: [],
    publishArtifacts: false,
    paused: false,
    lifecycle: 'running',
    setup: { step: 'ready', error: null, errorMessage: null },
    status: 'offline',
    activity: null,
    pendingCount: 0,
    accounts: { connected: false, providers: [] },
    takeover: { state: 'none', deviceId: null, deviceName: null, since: null },
    resources: {
      memoryBytes: null,
      memoryLimitBytes: null,
      cpuPercent: null,
      startedAt: null,
      swapBytes: null,
      oomKills: null,
      limitOoms: null,
    },
    screen: { width: 1280, height: 800, display: ':0' },
    appVersion: null,
    capabilities: [],
    usage: null,
    environmentId: null,
    move: null,
    runSettings: FLEET_ROUTINE_RUN_SETTINGS_DEFAULT,
    runningRun: null,
    turns: null,
    peerSettings: FLEET_PEER_THREAD_SETTINGS_DEFAULT,
    delegation: null,
    sharedFiles: null,
    storage: null,
    createdAt: at(1),
    updatedAt: at(1),
    ...overrides,
  }
}
export function environmentRecord(id: string, overrides: Partial<StoredEnvironment> = {}): StoredEnvironment {
  return {
    id,
    name: 'Environment ' + id,
    kind: 'bots',
    lifecycle: 'running',
    setup: { step: 'ready', error: null, errorMessage: null },
    containerName: 'maestrly-env-' + id,
    volumeName: 'maestrly-env-' + id + '-home',
    memoryLimitBytes: null,
    cpuLimit: null,
    idleStopMinutes: null,
    tint: null,
    hostFolder: null,
    compaction: null,
    updateRequestedAt: null,
    createdAt: at(1),
    updatedAt: at(1),
    archivedAt: null,
    ...overrides,
  }
}
export const environmentSecrets = (id: string) => ({
  controlToken: 'synthetic-control-' + id,
  keyringPassword: 'synthetic-keyring-password-' + id,
})
export const gatewaySecrets = (id: string) => ({
  gatewayToken: 'synthetic-gateway-' + id,
  gatewayTokenSha256: sha256('synthetic-gateway-' + id),
})
export const s3Destination: Extract<FleetBackupDestination, { provider: 's3' }> = {
  provider: 's3',
  endpoint: null,
  region: 'us-east-1',
  bucket: 'my-bucket',
  prefix: 'maestrly-backups',
  accessKeyId: 'AKIAEXAMPLE1234',
  secretAccessKey: 'secret-example-value',
}
export const RECOVERY_KEY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export function backupSettings(overrides: Partial<StoredBackupSettings> = {}): StoredBackupSettings {
  return {
    destination: s3Destination,
    recoveryKey: RECOVERY_KEY,
    enabled: true,
    schedule: { kind: 'weekly', days: [], time: '03:00', timezone: 'UTC' },
    retention: { daily: 7, weekly: 4, monthly: 6 },
    selection: { mode: 'all' },
    lastPruneAt: null,
    repositoryBytes: null,
    updatedAt: at(1),
    updatedBy: 'Synthetic computer',
    ...overrides,
  }
}
export function routineRecord(id: string, botId: string, overrides: Partial<FleetRoutine> = {}): FleetRoutine {
  return {
    id,
    botId,
    title: 'Synthetic routine ' + id,
    prompt: 'Check the synthetic prices',
    schedule: { kind: 'weekly', days: [], time: '09:00', timezone: 'UTC' },
    enabled: true,
    nextRunAt: at(1, 9),
    lastRunAt: null,
    lastOutcome: null,
    createdBy: 'owner',
    createdAt: at(1),
    updatedAt: at(1),
    ...overrides,
  }
}
export function memoryRecord(id: string, environmentId: string | null): FleetOwnerMemoryEntry {
  return {
    id,
    content: 'Synthetic memory ' + id,
    status: 'active',
    author: { kind: 'owner' },
    origin: null,
    replacesId: null,
    replacedById: null,
    environmentId,
    createdAt: at(1),
    updatedAt: at(1),
  }
}
export function backupRun(id: string, overrides: Partial<StoredBackupRun> = {}): StoredBackupRun {
  const run: FleetBackupRun = {
    id,
    kind: 'backup',
    environmentId: 'work',
    environmentName: 'Work',
    trigger: 'manual',
    state: 'succeeded',
    phase: 'finish',
    progress: 1,
    snapshotId: 'a'.repeat(64),
    bytesAdded: 10,
    bytesTotal: 100,
    error: null,
    startedAt: at(1),
    finishedAt: at(1, 11),
  }
  return { ...run, volumeName: null, ...overrides }
}
