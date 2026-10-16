/** A bot file this computer is saving to Downloads. Main runs at most one transfer per bot and file. */
export interface FleetDownloadProgress {
  botId: string
  fileId: string
  /** Bytes already on disk. */
  receivedBytes: number
  /** The size the gateway announced; 0 until it answers. */
  totalBytes: number
  /** Average over the last few seconds; null until there is enough of the transfer to measure, 0 while it stalls. */
  bytesPerSecond: number | null
}

/** Why a bot file could not be saved, as the main process reports it across IPC. */
export type FleetDownloadError = 'FLEET_FILE_NOT_FOUND' | 'FLEET_FILES_UNSUPPORTED' | 'FLEET_DOWNLOAD_FAILED'

/** Raised to every caller waiting on a transfer the owner canceled. */
export const FLEET_DOWNLOAD_CANCELED = 'FLEET_DOWNLOAD_CANCELED'

/** Sent to every window on `fleet:download`, so any view of the file follows a transfer it did not start. */
export type FleetDownloadEvent =
  | ({ type: 'progress' } & FleetDownloadProgress)
  | { type: 'saved'; botId: string; fileId: string; receipt: string }
  | { type: 'failed'; botId: string; fileId: string; error: FleetDownloadError }
  | { type: 'canceled'; botId: string; fileId: string }

/** A file a window shows; while that window has focus, its downloads finish without a system notification. */
export interface FleetDownloadFileKey {
  botId: string
  fileId: string
}

/** The most files one window reports as shown; a longer chat reports its first ones. */
export const FLEET_ATTENDED_FILES_MAX = 1_000
