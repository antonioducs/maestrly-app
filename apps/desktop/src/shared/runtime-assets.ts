export const RUNTIME_ASSET_IDS = [
  'codex-runtime',
  'github-copilot-runtime',
  'tunnel-client',
  'local-ml-runtime',
] as const

export type RuntimeAssetId = (typeof RUNTIME_ASSET_IDS)[number]

export const RUNTIME_ASSET_STATES = [
  'not-installed',
  'downloading',
  'verifying',
  'installing',
  'ready',
  'failed',
  'corrupt',
  'removing',
] as const

export type RuntimeAssetState = (typeof RUNTIME_ASSET_STATES)[number]

export interface RuntimeAssetStatus {
  readonly id: RuntimeAssetId
  readonly state: RuntimeAssetState
  readonly version?: string
  readonly target?: string
  readonly path?: string
  readonly bytesDownloaded?: number
  readonly totalBytes?: number
  readonly error?: string
}

/** Renderer-safe status. Installation paths and registry download details never cross IPC. */
export interface RuntimeAssetPublicStatus {
  readonly id: RuntimeAssetId
  readonly state: RuntimeAssetState
  readonly version?: string
  readonly bytesDownloaded?: number
  readonly totalBytes?: number
  readonly diskUsageBytes: number
  readonly error?: string
}

/** Runtime assets whose releases can be discovered and installed independently of Maestrly releases. */
export const UPDATABLE_RUNTIME_ASSET_IDS = ['codex-runtime'] as const satisfies readonly RuntimeAssetId[]

export type UpdatableRuntimeAssetId = (typeof UPDATABLE_RUNTIME_ASSET_IDS)[number]

export function isUpdatableRuntimeAssetId(id: RuntimeAssetId): id is UpdatableRuntimeAssetId {
  return (UPDATABLE_RUNTIME_ASSET_IDS as readonly RuntimeAssetId[]).includes(id)
}

export const RUNTIME_ASSET_UPDATE_STATES = [
  'idle',
  'checking',
  'up-to-date',
  'available',
  'downloading',
  'verifying',
  'installing',
  'validating',
  'rolling-back',
  'failed',
] as const

export type RuntimeAssetUpdateState = (typeof RUNTIME_ASSET_UPDATE_STATES)[number]

/** Renderer-safe failure categories; raw diagnostics stay in the main-process log. */
export const RUNTIME_ASSET_UPDATE_ERRORS = [
  'check-failed',
  'download-failed',
  'integrity',
  'disk-space',
  'incompatible',
  'in-use',
  'cancelled',
  'rollback-unavailable',
  'not-installed',
  'failed',
] as const

export type RuntimeAssetUpdateError = (typeof RUNTIME_ASSET_UPDATE_ERRORS)[number]

/**
 * Independent release channel of one runtime asset. It never describes the health of the active installation,
 * which remains in `RuntimeAssetInfo.status`.
 */
export interface RuntimeAssetUpdateInfo {
  readonly state: RuntimeAssetUpdateState
  /** Newer verified stable release than the active installation, when one is known. */
  readonly availableVersion?: string
  readonly lastCheckedAt?: string
  readonly automatic: boolean
  readonly bytesDownloaded?: number
  readonly totalBytes?: number
  readonly error?: RuntimeAssetUpdateError
  /** Installed previous version that can be reactivated without downloading. */
  readonly rollbackVersion?: string
  /** Version excluded from automatic installation after a failure or rollback. */
  readonly rejectedVersion?: string
  /** Connections opened before the last activation still run an older version until Maestrly restarts. */
  readonly restartRequired: boolean
}

export interface RuntimeAssetInfo {
  readonly id: RuntimeAssetId
  readonly displayName: string
  readonly requiredBy: string
  readonly availableVersion: string
  readonly downloadBytes: number
  readonly unpackedBytes: number
  readonly status: RuntimeAssetPublicStatus
  /** Present only for assets in `UPDATABLE_RUNTIME_ASSET_IDS`. */
  readonly update?: RuntimeAssetUpdateInfo
}

export interface RuntimeAssetLease {
  readonly id: RuntimeAssetId
  readonly path: string
  release(): void
}
