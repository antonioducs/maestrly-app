import { basename } from 'node:path'
import {
  FLEET_DOWNLOAD_CANCELED,
  type FleetDownloadError,
  type FleetDownloadEvent,
  type FleetDownloadProgress,
} from '../../../shared/fleet-downloads'
import { FleetClientError } from './api'

/** At most four progress events a second per transfer, and one a second while it stalls so its speed drops to 0. */
const PROGRESS_INTERVAL_MS = 250
const STALLED_INTERVAL_MS = 1_000
/** Speed is the average over this window: steady enough to read, recent enough to show a stall. */
const RATE_WINDOW_MS = 3_000
const RATE_MIN_SPAN_MS = 500

export type FleetTransferProgress = { name: string; receivedBytes: number; totalBytes: number }
export type FleetTransfer = (transfer: {
  signal: AbortSignal
  onProgress: (progress: FleetTransferProgress) => void
}) => Promise<{ path: string; receipt: string }>

export type FleetSettledDownload =
  | { outcome: 'saved'; botId: string; fileId: string; name: string; path: string; receipt: string }
  | { outcome: 'failed'; botId: string; fileId: string; name: string | null; error: FleetDownloadError }

type Transfer = {
  botId: string
  fileId: string
  controller: AbortController
  signal: AbortSignal
  name: string | null
  receivedBytes: number
  totalBytes: number
  startedAt: number | null
  samples: { at: number; bytes: number }[]
  emittedBytes: number
  emittedAt: number
  timer: ReturnType<typeof setInterval>
}

export function fleetDownloadError(error: unknown): FleetDownloadError {
  if (error instanceof FleetClientError && (error.status === 404 || error.code === 'NOT_FOUND'))
    return 'FLEET_FILE_NOT_FOUND'
  if (error instanceof Error && error.message === 'FLEET_FILES_UNSUPPORTED') return 'FLEET_FILES_UNSUPPORTED'
  return 'FLEET_DOWNLOAD_FAILED'
}

/**
 * Bot files being saved, one transfer per bot and file: asking again while it runs joins it, so leaving the chat and
 * coming back never starts a second copy. Every window hears its progress and its end.
 */
export class FleetActiveDownloads {
  /** `promise` is null only while the transfer starts, before anything can ask for it again. */
  private readonly active = new Map<string, { transfer: Transfer; promise: Promise<string> | null }>()
  private readonly now: () => number

  constructor(
    private readonly options: {
      emit: (event: FleetDownloadEvent) => void
      /** Every transfer that ends without the owner canceling it or the connection closing. */
      settled?: (download: FleetSettledDownload) => void
      now?: () => number
    }
  ) {
    this.now = options.now ?? (() => performance.now())
  }

  /** Resolves with the receipt of the saved file; `connection` aborting ends the transfer without a notice. */
  run(botId: string, fileId: string, connection: AbortSignal, start: FleetTransfer): Promise<string> {
    const key = botId + '\n' + fileId
    const existing = this.active.get(key)
    if (existing?.promise && !existing.transfer.signal.aborted) return existing.promise
    const controller = new AbortController()
    const transfer: Transfer = {
      botId,
      fileId,
      controller,
      signal: AbortSignal.any([connection, controller.signal]),
      name: null,
      receivedBytes: 0,
      totalBytes: 0,
      startedAt: null,
      samples: [],
      emittedBytes: 0,
      emittedAt: this.now(),
      timer: setInterval(() => this.tick(transfer), PROGRESS_INTERVAL_MS),
    }
    // Registered before it starts: even a failure thrown at once must find its entry to remove.
    const entry: { transfer: Transfer; promise: Promise<string> | null } = { transfer, promise: null }
    this.active.set(key, entry)
    this.emit(transfer)
    entry.promise = this.settle(key, transfer, connection, start)
    return entry.promise
  }

  get(botId: string, fileId: string): FleetDownloadProgress | null {
    const transfer = this.active.get(botId + '\n' + fileId)?.transfer
    return transfer && !transfer.signal.aborted ? this.progress(transfer) : null
  }

  /** Stops the transfer, whose partial file is removed; false when nothing was running. */
  cancel(botId: string, fileId: string): boolean {
    const transfer = this.active.get(botId + '\n' + fileId)?.transfer
    if (!transfer || transfer.signal.aborted) return false
    transfer.controller.abort(new Error(FLEET_DOWNLOAD_CANCELED))
    return true
  }

  private async settle(
    key: string,
    transfer: Transfer,
    connection: AbortSignal,
    start: FleetTransfer
  ): Promise<string> {
    const { botId, fileId } = transfer
    try {
      const saved = await start({ signal: transfer.signal, onProgress: (progress) => this.record(transfer, progress) })
      this.finish(key, transfer)
      this.options.emit({ type: 'saved', botId, fileId, receipt: saved.receipt })
      this.notify({ outcome: 'saved', botId, fileId, name: transfer.name ?? basename(saved.path), ...saved })
      return saved.receipt
    } catch (cause) {
      this.finish(key, transfer)
      if (transfer.controller.signal.aborted) {
        this.options.emit({ type: 'canceled', botId, fileId })
        throw new Error(FLEET_DOWNLOAD_CANCELED)
      }
      const error = fleetDownloadError(cause)
      this.options.emit({ type: 'failed', botId, fileId, error })
      // A closed connection (disconnecting, quitting, a revoked pairing) is not news to announce.
      if (!connection.aborted) this.notify({ outcome: 'failed', botId, fileId, name: transfer.name, error })
      throw error === 'FLEET_DOWNLOAD_FAILED' ? cause : new Error(error)
    }
  }

  private notify(download: FleetSettledDownload): void {
    try {
      this.options.settled?.(download)
    } catch {
      // A notice that cannot be shown never changes the transfer's result.
    }
  }

  private finish(key: string, transfer: Transfer): void {
    clearInterval(transfer.timer)
    if (this.active.get(key)?.transfer === transfer) this.active.delete(key)
  }

  private record(transfer: Transfer, progress: FleetTransferProgress): void {
    const at = this.now()
    transfer.name = progress.name
    transfer.totalBytes = progress.totalBytes
    transfer.receivedBytes = progress.receivedBytes
    transfer.startedAt ??= at
    transfer.samples.push({ at, bytes: progress.receivedBytes })
    this.trim(transfer, at)
    // The gateway's first answer shows the size at once; later bytes wait for the next tick.
    if (transfer.samples.length === 1) this.emit(transfer)
  }

  private tick(transfer: Transfer): void {
    if (transfer.signal.aborted) return
    if (transfer.receivedBytes !== transfer.emittedBytes || this.now() - transfer.emittedAt >= STALLED_INTERVAL_MS)
      this.emit(transfer)
  }

  private emit(transfer: Transfer): void {
    transfer.emittedBytes = transfer.receivedBytes
    transfer.emittedAt = this.now()
    this.options.emit({ type: 'progress', ...this.progress(transfer) })
  }

  /** Keeps the newest sample at or before the window's start, so the average spans the whole window. */
  private trim(transfer: Transfer, at: number): void {
    while (transfer.samples.length > 1 && at - transfer.samples[1].at >= RATE_WINDOW_MS) transfer.samples.shift()
  }

  private progress(transfer: Transfer): FleetDownloadProgress {
    const at = this.now()
    this.trim(transfer, at)
    const first = transfer.samples[0]
    const last = transfer.samples.at(-1)
    let bytesPerSecond: number | null = null
    if (first && last && transfer.startedAt !== null && at - transfer.startedAt >= RATE_MIN_SPAN_MS)
      bytesPerSecond = at - last.at >= RATE_WINDOW_MS ? 0 : ((last.bytes - first.bytes) * 1000) / (at - first.at)
    return {
      botId: transfer.botId,
      fileId: transfer.fileId,
      receivedBytes: transfer.receivedBytes,
      totalBytes: transfer.totalBytes,
      bytesPerSecond,
    }
  }
}
