/** A transfer of one file between this computer and a host, as the window shows it. */
export type HostTransferDirection = 'download' | 'upload'
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
  name: string
  remotePath: string
  /** The source of an upload; the published file of a finished download. */
  localPath: string | null
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

/** Uploads queued from a pick or a drop, and the names left out (folders, unreadable entries). */
export interface HostTransferUploadResult {
  queued: string[]
  skipped: string[]
}
