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
import { downloadStatusLabel } from '@/lib/fleet/downloads'
import {
  fleetFileKind,
  sharedAtLabel,
  sharedIn,
  spaceLabel,
  type FilesConversation,
  type FleetFileKind,
} from '@/lib/fleet/files'
import { cn } from '@/lib/utils'
import { useFleetFileTransfer } from './BotTranscriptFiles'

const KIND_ICON: Record<FleetFileKind, typeof FileText> = {
  video: Film,
  image: ImageIcon,
  document: FileText,
  archive: FileArchive,
}

const action =
  'grid size-7 place-items-center rounded-[7px] text-muted-foreground hover:bg-white/[0.07] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

/** One file the bot shared: what it is, its size and when, and what the owner can do with it. */
export function BotFileRow({
  botId,
  file,
  conversation,
  showOrigin,
  selected,
  now,
  onToggleSelect,
  onReveal,
  onOpenLane,
  onDelete,
}: {
  botId: string
  file: FleetPublishedFile
  conversation: FilesConversation | null
  showOrigin: boolean
  selected: boolean
  now: number
  onToggleSelect: () => void
  onReveal: (file: FleetPublishedFile) => void
  onOpenLane: (origin: Extract<FleetFileOrigin, { kind: 'routine' | 'thread' }>) => void
  onDelete: () => void
}) {
  const { t, i18n } = useTranslation('fleet')
  const locale = i18n.language
  const transfer = useFleetFileTransfer(botId, file.id)
  const downloading = transfer.state === 'downloading'
  const Icon = KIND_ICON[fleetFileKind(file)]
  const totalBytes = transfer.progress?.totalBytes || file.byteSize
  const receivedBytes = Math.min(transfer.progress?.receivedBytes ?? 0, totalBytes)
  const percent = totalBytes > 0 ? Math.round((receivedBytes / totalBytes) * 100) : 0
  const status = downloading
    ? downloadStatusLabel(
        { receivedBytes, totalBytes, bytesPerSecond: transfer.progress?.bytesPerSecond ?? null },
        locale,
        t
      )
    : null

  const origin = file.origin
  const inShownConversation = conversation ? sharedIn(file, conversation) : false
  // A file of the shown conversation, or of the bot's own one, is shown where it was shared; one of another run or
  // thread opens that conversation, while it still exists.
  const canReveal = inShownConversation || origin.kind === 'primary'
  const lane = (origin.kind === 'routine' || origin.kind === 'thread') && !file.originGone ? origin : null
  const originText =
    origin.kind === 'routine'
      ? t('files.drawer.origin.routine', { title: origin.title })
      : origin.kind === 'thread'
        ? t('files.drawer.origin.thread', { title: origin.title })
        : origin.kind === 'unknown'
          ? t('files.drawer.origin.unknown')
          : null

  return (
    <div
      role="listitem"
      data-file-row={file.id}
      className={cn(
        'group relative grid grid-cols-[16px_34px_minmax(0,1fr)] items-center gap-2.5 rounded-lg py-[7px] pl-2.5 pr-2.5 text-xs',
        '[--row-bg:#161618] hover:[--row-bg:#202023] focus-within:[--row-bg:#202023]',
        selected && '[--row-bg:#2a1e22] hover:[--row-bg:#31232a] focus-within:[--row-bg:#31232a]',
        'bg-[var(--row-bg)]'
      )}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggleSelect}
        aria-label={t('files.drawer.select', { name: file.name })}
      />
      <span
        aria-hidden="true"
        className="grid h-[26px] w-[34px] place-items-center rounded-[5px] bg-white/[0.05] text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]"
      >
        <Icon className="size-[13px]" />
      </span>
      <div className="min-w-0">
        <p className="truncate font-medium text-[13px] text-foreground" title={file.name}>
          {file.name}
        </p>
        {status !== null ? (
          <div className="mt-1 flex items-center gap-1.5 pr-[70px]">
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
            <span className="min-w-[30px] text-right font-mono text-[11px] text-muted-foreground">{percent}%</span>
          </div>
        ) : (
          <div className="mt-px flex min-w-0 items-center gap-[5px] overflow-hidden whitespace-nowrap text-[11.5px] text-muted-foreground">
            <span className="font-mono text-[11px] text-foreground/75">{spaceLabel(file.byteSize, locale)}</span>
            <span aria-hidden="true" className="text-muted-foreground/50">
              ·
            </span>
            <span>{sharedAtLabel(file.sharedAt, now, locale, t)}</span>
            {originText && (showOrigin || file.originGone) && (
              <>
                <span aria-hidden="true" className="text-muted-foreground/50">
                  ·
                </span>
                {origin.kind === 'routine' && <Repeat aria-hidden="true" className="size-[11px] shrink-0" />}
                {origin.kind === 'thread' && <ArrowRightLeft aria-hidden="true" className="size-[11px] shrink-0" />}
                <span className="min-w-0 truncate">{originText}</span>
              </>
            )}
            {file.originGone && (
              <span className="shrink-0 rounded bg-white/[0.07] px-[5px] text-[10.5px] text-foreground/75">
                {t('files.drawer.origin.gone')}
              </span>
            )}
            {transfer.receipt && (
              <span className="ml-0.5 inline-flex shrink-0 items-center gap-[3px] text-status-ready">
                <Check aria-hidden="true" className="size-[11px]" />
                {t('files.drawer.downloaded')}
              </span>
            )}
          </div>
        )}
      </div>
      <div
        className={cn(
          'absolute right-1 top-1/2 flex -translate-y-1/2 gap-px bg-[linear-gradient(90deg,transparent,var(--row-bg)_24px)] pl-7 transition-opacity motion-reduce:transition-none',
          downloading
            ? 'opacity-100'
            : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100'
        )}
      >
        {downloading ? (
          <button
            type="button"
            onClick={transfer.cancel}
            aria-label={t('files.cancelName', { name: file.name })}
            title={t('files.cancel')}
            className={action}
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void transfer.download()}
            aria-label={t('files.drawer.action.download', { name: file.name })}
            title={t('files.drawer.action.download', { name: file.name })}
            className={action}
          >
            <Download aria-hidden="true" className="size-3.5" />
          </button>
        )}
        {canReveal ? (
          <button
            type="button"
            onClick={() => onReveal(file)}
            aria-label={t('files.drawer.action.reveal', { name: file.name })}
            title={t('files.drawer.action.reveal', { name: file.name })}
            className={action}
          >
            <MessageSquare aria-hidden="true" className="size-3.5" />
          </button>
        ) : (
          lane && (
            <button
              type="button"
              onClick={() => onOpenLane(lane)}
              aria-label={t(
                lane.kind === 'routine' ? 'files.drawer.action.openRun' : 'files.drawer.action.openThread',
                {
                  name: file.name,
                }
              )}
              title={t(lane.kind === 'routine' ? 'files.drawer.action.openRun' : 'files.drawer.action.openThread', {
                name: file.name,
              })}
              className={action}
            >
              {lane.kind === 'routine' ? (
                <Repeat aria-hidden="true" className="size-3.5" />
              ) : (
                <ArrowRightLeft aria-hidden="true" className="size-3.5" />
              )}
            </button>
          )
        )}
        <button
          type="button"
          onClick={onDelete}
          aria-label={t('files.drawer.action.delete', { name: file.name })}
          title={t('files.drawer.action.delete', { name: file.name })}
          className={cn(action, 'hover:bg-destructive/10 hover:text-destructive')}
        >
          <Trash2 aria-hidden="true" className="size-3.5" />
        </button>
      </div>
    </div>
  )
}
