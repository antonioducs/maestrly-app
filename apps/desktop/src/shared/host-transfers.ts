/** A transfer of one file or folder between this computer and a host, as the window shows it. */
export type HostTransferDirection = 'download' | 'upload'
/** A folder moves as one archive: packed on the side it leaves, extracted on the side it reaches. */
export type HostTransferKind = 'file' | 'folder'
export type HostTransferStage = 'packing' | 'transferring' | 'extracting'
export type HostTransferState =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'paused'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'canceled'
export const HOST_TRANSFER_FINAL_STATES: ReadonlySet<HostTransferState> = new Set(['done', 'failed', 'canceled'])
export type HostTransferError =
  | 'changed'
  | 'exists'
  | 'not-found'
  | 'outside-roots'
  | 'not-a-file'
  | 'not-a-directory'
  | 'invalid-name'
  | 'unsafe-archive'
  | 'archive-expired'
  | 'host-full'
  | 'verification-failed'
  | 'gateway-update-required'
  | 'host-update-required'
  | 'unknown-host'
  | 'local-missing'
  | 'disk-full'
  | 'unauthorized'
  | 'unknown'

export interface HostTransferView {
  id: string
  hostId: string
  direction: HostTransferDirection
  /** `open` downloads into a temporary folder and opens the file there once it is verified. */
  purpose: 'save' | 'open'
  kind: HostTransferKind
  /** Where a folder's transfer stands; null for a file. */
  stage: HostTransferStage | null
  /** How far packing or extracting a folder went, from 0 to 1, when that is known. */
  stageProgress: number | null
  name: string
  /** The host's file or folder; where an upload landed once it is done. */
  remotePath: string
  /** The source of an upload; the published file or folder of a finished download. */
  localPath: string | null
  /** Bytes moved: a folder's are its archive's, known once it is packed. */
  size: number
  doneBytes: number
  state: HostTransferState
  error: HostTransferError | null
  errorMessage: string | null
  bytesPerSecond: number | null
  remainingMs: number | null
  sha256: string | null
  createdAt: number
  finishedAt: number | null
}

/**
 * Uploads queued from a pick or a drop, and the names left out: unreadable entries, ones that are neither files nor
 * folders, and folders for a host that cannot take them.
 */
export interface HostTransferUploadResult {
  queued: string[]
  skipped: string[]
}
