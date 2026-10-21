import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowRightLeft,
  Check,
  Download,
  FileArchive,
  FileText,
  Film,
  Image as ImageIcon,
  MessageSquare,
  Repeat,
  Trash2,
  X,
} from 'lucide-react'
import type { FleetFileOrigin, FleetPublishedFile } from '@maestrly/bot-fleet-protocol'
import { downloadStatusLabel, fileSizeLabel } from '@/lib/fleet/downloads'
import { fleetFileKind, sharedAtLabel, sharedIn, type FilesConversation, type FleetFileKind } from '@/lib/fleet/files'
import { cn } from '@/lib/utils'
import { useFleetFileTransfer } from './BotTranscriptFiles'

const KIND_ICON: Record<FleetFileKind, typeof FileText> = {
  video: Film,
  image: ImageIcon,
  document: FileText,
  archive: FileArchive,
}

export function BotFileRow({
  botId,
  file,
  conversation,
  showOrigin,
  selected,
  flashing,
  now,
  onToggleSelect,
  onReveal,
  onOpenLane,
  onDelete,
  onDownloadedChange,
}: {
  botId: string
  file: FleetPublishedFile
  conversation: FilesConversation | null
  showOrigin: boolean
  selected: boolean
  flashing: boolean
  now: number
  onToggleSelect: () => void
  onReveal: (file: FleetPublishedFile) => void
  onOpenLane: (origin: Extract<FleetFileOrigin, { kind: 'routine' | 'thread' }>) => void
  onDelete: () => void
  onDownloadedChange?: (fileId: string, downloaded: boolean) => void
}) {
  const { t, i18n } = useTranslation('fleet')
  const locale = i18n.language
  const transfer = useFleetFileTransfer(botId, file.id)
  const downloaded = Boolean(transfer.receipt)
  useEffect(() => {
    onDownloadedChange?.(file.id, downloaded)
  }, [downloaded, file.id, onDownloadedChange])

  const kind = fleetFileKind(file)
  const Icon = KIND_ICON[kind]
  const totalBytes = transfer.progress?.totalBytes || file.byteSize
  const receivedBytes = Math.min(transfer.progress?.receivedBytes ?? 0, totalBytes)
  const percent = totalBytes > 0 ? Math.round((receivedBytes / totalBytes) * 100) : 0
  const status =
    transfer.state === 'downloading'
      ? downloadStatusLabel(
          { receivedBytes, totalBytes, bytesPerSecond: transfer.progress?.bytesPerSecond ?? null },
          locale,
          t
        )
      : null

  const inCurrentConversation = conversation ? sharedIn(file, conversation) : false
  const canRevealInCurrent = inCurrentConversation || (!conversation && file.origin.kind === 'primary')
  const canOpenSideLane =
    !inCurrentConversation && !file.originGone && (file.origin.kind === 'routine' || file.origin.kind === 'thread')
  const canRevealPrimary = !inCurrentConversation && file.origin.kind === 'primary'

  const originText =
    file.origin.kind === 'primary'
      ? t('files.drawer.origin.primary')
      : file.origin.kind === 'routine'
        ? t('files.drawer.origin.routine', { title: file.origin.title })
        : file.origin.kind === 'thread'
          ? t('files.drawer.origin.thread', { title: file.origin.title })
          : t('files.drawer.origin.unknown')

  return (
    <div
      data-file-row={file.id}
      className={cn(
        'group flex items-center gap-2.5 border-b border-border/60 px-3.5 py-2 text-xs transition-colors',
        selected ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]',
        flashing && 'bot-file-flash'
      )}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggleSelect}
        aria-label={t('files.drawer.select', { name: file.name })}
        className="size-3.5 shrink-0 accent-primary"
      />
      <span
        aria-hidden="true"
        className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-white/[0.04] text-muted-foreground"
      >
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-foreground" title={file.name}>
          {file.name}
        </p>
        {status !== null ? (
          <div className="mt-1 flex items-center gap-2">
            <div
              className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.08]"
              role="progressbar"
              aria-label={t('files.progressName', { name: file.name })}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-valuetext={status}
            >
              <i
                className="block h-full rounded-full bg-primary transition-[width] duration-200 motion-reduce:transition-none"
                style={{ width: `${Math.max(2, percent)}%` }}
              />
            </div>
            <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">{percent}%</span>
          </div>
        ) : (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
            <span className="tabular-nums">{fileSizeLabel(file.byteSize, locale)}</span>
            <span aria-hidden="true">·</span>
            <span>{sharedAtLabel(file.sharedAt, now, locale, t)}</span>
            {(showOrigin || file.originGone) && (
              <>
                <span aria-hidden="true">·</span>
                <span className="inline-flex min-w-0 items-center gap-1 truncate">
                  {file.origin.kind === 'routine' && <Repeat aria-hidden="true" className="size-3 shrink-0" />}
                  {file.origin.kind === 'thread' && <ArrowRightLeft aria-hidden="true" className="size-3 shrink-0" />}
                  <span className="truncate">{originText}</span>
                </span>
              </>
            )}
            {file.originGone && (
              <span className="rounded bg-white/[0.07] px-1.5 py-px text-[10px] text-muted-foreground">
                {t('files.drawer.origin.gone')}
              </span>
            )}
            {downloaded && (
              <span className="inline-flex items-center gap-0.5 text-emerald-300">
                <Check aria-hidden="true" className="size-3" />
                {t('files.drawer.downloaded')}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {transfer.state === 'downloading' ? (
          <button
            type="button"
            onClick={transfer.cancel}
            aria-label={t('files.cancelName', { name: file.name })}
            title={t('files.cancel')}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void transfer.download()}
            aria-label={t('files.drawer.action.download', { name: file.name })}
            title={t('files.drawer.action.download', { name: file.name })}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
          >
            <Download aria-hidden="true" className="size-3.5" />
          </button>
        )}
        {(canRevealInCurrent || canRevealPrimary) && (
          <button
            type="button"
            onClick={() => onReveal(file)}
            aria-label={t('files.drawer.action.reveal', { name: file.name })}
            title={t('files.drawer.action.reveal', { name: file.name })}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
          >
            <MessageSquare aria-hidden="true" className="size-3.5" />
          </button>
        )}
        {canOpenSideLane && (file.origin.kind === 'routine' || file.origin.kind === 'thread') && (
          <button
            type="button"
            onClick={() =>
              file.origin.kind === 'routine' || file.origin.kind === 'thread' ? onOpenLane(file.origin) : undefined
            }
            aria-label={t(
              file.origin.kind === 'routine' ? 'files.drawer.action.openRun' : 'files.drawer.action.openThread',
              { name: file.name }
            )}
            title={t(
              file.origin.kind === 'routine' ? 'files.drawer.action.openRun' : 'files.drawer.action.openThread',
              { name: file.name }
            )}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
          >
            {file.origin.kind === 'routine' ? (
              <Repeat aria-hidden="true" className="size-3.5" />
            ) : (
              <ArrowRightLeft aria-hidden="true" className="size-3.5" />
            )}
          </button>
        )}
        <button
          type="button"
          onClick={onDelete}
          aria-label={t('files.drawer.action.delete', { name: file.name })}
          title={t('files.drawer.action.delete', { name: file.name })}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-red-400/10 hover:text-red-300"
        >
          <Trash2 aria-hidden="true" className="size-3.5" />
        </button>
      </div>
    </div>
  )
}
