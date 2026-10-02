import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Download, FileText, FolderOpen, Loader2 } from 'lucide-react'
import type { FleetFileRef } from '@maestrly/bot-fleet-protocol'
import { fleetErrorMessage } from '@/lib/fleet/errors'

function sizeLabel(bytes: number, locale: string): string {
  const unit = bytes >= 1024 * 1024 ? 'megabyte' : bytes >= 1024 ? 'kilobyte' : 'byte'
  const divisor = unit === 'megabyte' ? 1024 * 1024 : unit === 'kilobyte' ? 1024 : 1
  return new Intl.NumberFormat(locale, { style: 'unit', unit, maximumFractionDigits: 1 }).format(bytes / divisor)
}

function FileCard({ botId, file }: { botId: string; file: FleetFileRef }) {
  const { t, i18n } = useTranslation('fleet')
  const [state, setState] = useState<'idle' | 'downloading' | 'saved' | 'missing' | 'error' | 'unsupported'>('idle')
  const [receipt, setReceipt] = useState<string | null>(null)
  const [revealError, setRevealError] = useState(false)
  const revision = useRef(0)
  const downloading = useRef(false)
  useEffect(() => {
    let disposed = false
    const refresh = async () => {
      if (downloading.current) return
      const current = ++revision.current
      try {
        const saved = await window.api.fleetGetDownload(botId, file.id)
        if (disposed || current !== revision.current) return
        setReceipt(saved)
        setState((previous) => (previous === 'idle' || previous === 'saved' ? (saved ? 'saved' : 'idle') : previous))
      } catch {
        // A status lookup must not prevent a new download.
      }
    }
    void refresh()
    window.addEventListener('focus', refresh)
    return () => {
      disposed = true
      window.removeEventListener('focus', refresh)
    }
  }, [botId, file.id])
  const download = async () => {
    if (downloading.current) return
    downloading.current = true
    revision.current++
    setState('downloading')
    try {
      setReceipt(await window.api.fleetDownloadFile(botId, file.id))
      setRevealError(false)
      setState('saved')
    } catch (error) {
      const message = fleetErrorMessage(error)
      setState(
        message.includes('FLEET_FILE_NOT_FOUND')
          ? 'missing'
          : message.includes('FLEET_FILES_UNSUPPORTED')
            ? 'unsupported'
            : 'error'
      )
    } finally {
      downloading.current = false
    }
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
  return (
    <div className="min-w-0 max-w-full rounded-lg border border-border bg-surface-elevated px-3 py-2 text-sm">
      <div className="flex min-w-0 items-center gap-3">
        <FileText aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-foreground" title={file.name}>
            {file.name}
          </p>
          <p className="text-xs text-muted-foreground">{sizeLabel(file.byteSize, i18n.language)}</p>
        </div>
        <button
          type="button"
          disabled={state === 'downloading'}
          aria-label={t('files.downloadName', { name: file.name })}
          onClick={() => void download()}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-primary hover:bg-white/[0.06] focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-wait disabled:opacity-60"
        >
          {state === 'downloading' ? (
            <Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
          ) : state === 'saved' ? (
            <Check aria-hidden="true" className="size-4" />
          ) : (
            <Download aria-hidden="true" className="size-4" />
          )}
          {t(state === 'downloading' ? 'files.downloading' : 'files.download')}
        </button>
      </div>
      {receipt && (
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
  )
}

export function BotTranscriptFiles({ botId, files }: { botId: string; files?: FleetFileRef[] }) {
  if (!files?.length) return null
  return (
    <div className="mt-2 flex min-w-0 flex-col gap-2">
      {files.map((file) => (
        <FileCard key={`${botId}:${file.id}`} botId={botId} file={file} />
      ))}
    </div>
  )
}
