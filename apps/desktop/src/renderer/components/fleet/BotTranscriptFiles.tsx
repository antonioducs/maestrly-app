import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Download, FileText, FileX, Film, FolderOpen, X } from 'lucide-react'
import type { FleetFileRef } from '@maestrly/bot-fleet-protocol'
import { FLEET_DOWNLOAD_CANCELED, type FleetDownloadProgress } from '../../../shared/fleet-downloads'
import { fleetErrorMessage } from '@/lib/fleet/errors'
import { attendFleetFile, downloadStatusLabel, fileSizeLabel } from '@/lib/fleet/downloads'
import { useFleetServerId } from '@/lib/fleet/server-context'
import { isFleetVideo } from '../../../shared/fleet-media'
import { useRemovedFile } from './bot-files-context'
import { VideoPreview } from './BotTranscriptVideo'

export type FleetFileTransfer = {
  state: 'idle' | 'downloading' | 'saved' | 'missing' | 'error' | 'unsupported'
  /** The running transfer's bytes and speed; null before main reports them. */
  progress: FleetDownloadProgress | null
  receipt: string | null
  revealError: boolean
  download: () => Promise<void>
  cancel: () => void
  reveal: () => Promise<void>
}
type Outcome = { type: 'saved'; receipt: string } | { type: 'failed'; error: string } | { type: 'canceled' }

function failureState(message: string): FleetFileTransfer['state'] {
  return message.includes('FLEET_FILE_NOT_FOUND')
    ? 'missing'
    : message.includes('FLEET_FILES_UNSUPPORTED')
      ? 'unsupported'
      : 'error'
}

/** Saving a shared file to Downloads; a video's card and its player share one, so both show the same state. */
export function useFleetFileTransfer(botId: string, fileId: string): FleetFileTransfer {
  const serverId = useFleetServerId()
  const [state, setState] = useState<FleetFileTransfer['state']>('idle')
  const [progress, setProgress] = useState<FleetDownloadProgress | null>(null)
  const [receipt, setReceipt] = useState<string | null>(null)
  const [revealError, setRevealError] = useState(false)
  const revision = useRef(0)
  /** A transfer of this file is running in main, started here or before this card mounted. */
  const downloading = useRef(false)
  /** Bumped whenever a transfer ends, so a reply that arrives after its event changes nothing. */
  const attempt = useRef(0)
  const finish = useRef((_outcome: Outcome) => {})
  useEffect(() => attendFleetFile(serverId, botId, fileId), [serverId, botId, fileId])
  useEffect(() => {
    let disposed = false
    let settled = false
    const follow = (snapshot: FleetDownloadProgress) => {
      downloading.current = true
      revision.current++
      setState('downloading')
      setProgress(snapshot)
    }
    const refresh = async () => {
      if (downloading.current) return
      const current = ++revision.current
      try {
        const saved = await window.api.fleetGetDownload(serverId, botId, fileId)
        if (disposed || current !== revision.current) return
        setReceipt(saved)
        setState((previous) => (previous === 'idle' || previous === 'saved' ? (saved ? 'saved' : 'idle') : previous))
      } catch {
        // A status lookup must not prevent a new download.
      }
    }
    finish.current = (outcome) => {
      attempt.current++
      downloading.current = false
      setProgress(null)
      if (outcome.type === 'saved') {
        revision.current++
        setReceipt(outcome.receipt)
        setRevealError(false)
        setState('saved')
      } else if (outcome.type === 'failed') setState(failureState(outcome.error))
      else {
        // A copy saved before stays available.
        setState('idle')
        void refresh()
      }
    }
    // Another card, or this chat before it was left, may have started the transfer: follow it to its end.
    const off = window.api.onFleetDownload((eventServerId, event) => {
      if (eventServerId !== serverId || event.botId !== botId || event.fileId !== fileId) return
      if (event.type === 'progress') follow(event)
      else {
        settled = true
        finish.current(event)
      }
    })
    void window.api.fleetGetActiveDownload(serverId, botId, fileId).then(
      (snapshot) => {
        if (snapshot && !disposed && !settled && !downloading.current) follow(snapshot)
      },
      () => undefined
    )
    void refresh()
    window.addEventListener('focus', refresh)
    return () => {
      disposed = true
      off()
      window.removeEventListener('focus', refresh)
    }
  }, [serverId, botId, fileId])
  const download = async () => {
    if (downloading.current) return
    const mine = ++attempt.current
    downloading.current = true
    revision.current++
    setState('downloading')
    setProgress(null)
    let outcome: Outcome
    try {
      outcome = { type: 'saved', receipt: await window.api.fleetDownloadFile(serverId, botId, fileId) }
    } catch (error) {
      const message = fleetErrorMessage(error)
      outcome = message.includes(FLEET_DOWNLOAD_CANCELED) ? { type: 'canceled' } : { type: 'failed', error: message }
    }
    // The transfer's own event normally ended this attempt first; the reply covers an event that never came.
    if (attempt.current === mine) finish.current(outcome)
  }
  const cancel = () => {
    void window.api.fleetCancelDownload(serverId, botId, fileId).catch(() => undefined)
  }
  const reveal = async () => {
    if (!receipt) return
    setRevealError(false)
    try {
      await window.api.fleetRevealDownload(receipt)
    } catch (error) {
      if (fleetErrorMessage(error).includes('FLEET_LOCAL_DOWNLOAD_MISSING')) {
        setReceipt(null)
        setState('idle')
      }
      setRevealError(true)
    }
  }
  return { state, progress, receipt, revealError, download, cancel, reveal }
}

function FileCard({
  file,
  transfer,
  icon: Icon = FileText,
  preview,
}: {
  file: FleetFileRef
  transfer: FleetFileTransfer
  icon?: ComponentType<{ className?: string; 'aria-hidden'?: 'true' }>
  /** Shown above the file's name, inside the same card. */
  preview?: ReactNode
}) {
  const { t, i18n } = useTranslation('fleet')
  const { state, progress, receipt, revealError, download, cancel, reveal } = transfer
  const totalBytes = progress?.totalBytes || file.byteSize
  const receivedBytes = Math.min(progress?.receivedBytes ?? 0, totalBytes)
  const percent = totalBytes > 0 ? Math.round((receivedBytes / totalBytes) * 100) : 0
  const status =
    state === 'downloading'
      ? downloadStatusLabel(
          { receivedBytes, totalBytes, bytesPerSecond: progress?.bytesPerSecond ?? null },
          i18n.language,
          t
        )
      : null
  return (
    <div
      data-file-id={file.id}
      className={
        preview
          ? 'w-[360px] min-w-0 max-w-full overflow-hidden rounded-lg border border-border bg-surface-elevated text-sm'
          : 'min-w-0 max-w-full rounded-lg border border-border bg-surface-elevated px-3 py-2 text-sm'
      }
    >
      {preview}
      <div className={preview ? 'px-3 py-2' : undefined}>
        <div className="flex min-w-0 items-center gap-3">
          <Icon aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-foreground" title={file.name}>
              {file.name}
            </p>
            <p className="text-xs text-muted-foreground">{fileSizeLabel(file.byteSize, i18n.language)}</p>
          </div>
          {state === 'downloading' ? (
            <button
              type="button"
              aria-label={t('files.cancelName', { name: file.name })}
              onClick={cancel}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-white/[0.06] hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
            >
              <X aria-hidden="true" className="size-4" />
              {t('files.cancel')}
            </button>
          ) : (
            <button
              type="button"
              aria-label={t('files.downloadName', { name: file.name })}
              onClick={() => void download()}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-primary hover:bg-white/[0.06] focus-visible:outline-2 focus-visible:outline-primary"
            >
              {state === 'saved' ? (
                <Check aria-hidden="true" className="size-4" />
              ) : (
                <Download aria-hidden="true" className="size-4" />
              )}
              {t('files.download')}
            </button>
          )}
        </div>
        {status !== null && (
          <div className="mt-2 flex flex-col gap-1">
            <div
              className="h-1 overflow-hidden rounded-full bg-white/[0.08]"
              role="progressbar"
              aria-label={t('files.progressName', { name: file.name })}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-valuetext={status}
            >
              <i
                className="block h-full rounded-full bg-primary transition-[width] duration-200 motion-reduce:transition-none"
                style={{ width: `${Math.max(1.5, percent)}%` }}
              />
            </div>
            <p className="truncate text-xs tabular-nums text-muted-foreground" title={status}>
              {status}
            </p>
          </div>
        )}
        {receipt && state !== 'downloading' && (
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <p role="status" className="text-muted-foreground">
              {t('files.saved')}
            </p>
            <button
              type="button"
              onClick={() => void reveal()}
              className="inline-flex items-center gap-1.5 rounded px-1 py-1 text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary"
            >
              <FolderOpen aria-hidden="true" className="size-3.5" />
              {t('files.showInFolder')}
            </button>
          </div>
        )}
        {revealError && (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {t('files.revealFailed')}
          </p>
        )}
        {(state === 'missing' || state === 'error') && (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {t(state === 'missing' ? 'files.unavailable' : 'files.failed')}
          </p>
        )}
        {state === 'unsupported' && (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {t('files.updateRequired')}
          </p>
        )}
      </div>
    </div>
  )
}

function RemovedFileCard({ file, transfer }: { file: FleetFileRef; transfer: FleetFileTransfer }) {
  const { t, i18n } = useTranslation('fleet')
  return (
    <div
      data-file-id={file.id}
      className="min-w-0 max-w-full rounded-lg border border-dashed border-border-strong px-3 py-2 text-sm"
    >
      <div className="flex min-w-0 items-center gap-3">
        <FileX aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-muted-foreground" title={file.name}>
            {file.name}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('files.removed', { size: fileSizeLabel(file.byteSize, i18n.language) })}
          </p>
        </div>
      </div>
      {transfer.receipt && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <p role="status" className="text-muted-foreground">
            {t('files.saved')}
          </p>
          <button
            type="button"
            onClick={() => void transfer.reveal()}
            className="inline-flex items-center gap-1.5 rounded px-1 py-1 text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary"
          >
            <FolderOpen aria-hidden="true" className="size-3.5" />
            {t('files.showInFolder')}
          </button>
        </div>
      )}
      {transfer.revealError && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {t('files.revealFailed')}
        </p>
      )}
    </div>
  )
}

function SharedFile({ botId, file }: { botId: string; file: FleetFileRef }) {
  const transfer = useFleetFileTransfer(botId, file.id)
  const removedAt = useRemovedFile(file.id)
  if (removedAt) return <RemovedFileCard file={file} transfer={transfer} />
  return <FileCard file={file} transfer={transfer} />
}

/** A video plays in place: a preview above the usual card, which still saves the file to Downloads. */
function SharedVideo({ botId, file }: { botId: string; file: FleetFileRef }) {
  const transfer = useFleetFileTransfer(botId, file.id)
  const removedAt = useRemovedFile(file.id)
  if (removedAt) return <RemovedFileCard file={file} transfer={transfer} />
  return (
    <FileCard
      file={file}
      transfer={transfer}
      icon={Film}
      preview={<VideoPreview botId={botId} file={file} transfer={transfer} />}
    />
  )
}

export function BotTranscriptFiles({ botId, files }: { botId: string; files?: FleetFileRef[] }) {
  if (!files?.length) return null
  return (
    <div className="mt-2 flex min-w-0 flex-col gap-2">
      {files.map((file) =>
        isFleetVideo(file) ? (
          <SharedVideo key={`${botId}:${file.id}`} botId={botId} file={file} />
        ) : (
          <SharedFile key={`${botId}:${file.id}`} botId={botId} file={file} />
        )
      )}
    </div>
  )
}
