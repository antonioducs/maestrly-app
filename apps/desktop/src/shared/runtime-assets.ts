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

export interface RuntimeAssetInfo {
  readonly id: RuntimeAssetId
  readonly displayName: string
  readonly requiredBy: string
  readonly availableVersion: string
  readonly downloadBytes: number
  readonly unpackedBytes: number
  readonly status: RuntimeAssetPublicStatus
}

export interface RuntimeAssetLease {
  readonly id: RuntimeAssetId
  readonly path: string
  release(): void
}
