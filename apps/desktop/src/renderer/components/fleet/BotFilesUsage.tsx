import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import {
  fleetFileQuotaBytes,
  type FleetBot,
  type FleetFileSettings,
  type FleetFilesUsage,
  type FleetPublishedFile,
} from '@maestrly/bot-fleet-protocol'
import { fileSizeLabel } from '@/lib/fleet/downloads'
import { fleetErrorText } from '@/lib/fleet/errors'
import {
  filesCountLevel,
  filesLevel,
  filesSpaceLevel,
  usageSegments,
  type FileSort,
  type FleetFileKind,
} from '@/lib/fleet/files'
import { cn } from '@/lib/utils'

const QUOTA_OPTIONS_GB = [1, 2, 5, 10, 20] as const

const KIND_COLOR: Record<FleetFileKind, string> = {
  video: 'bg-sky-400/80',
  image: 'bg-emerald-400/80',
  document: 'bg-amber-300/80',
  archive: 'bg-violet-400/80',
}

export function BotFilesUsageCard({
  bot,
  usage,
  files,
  selectedIds,
  visibleIds,
  filtering,
  onSelectSegment,
  onApplySort,
}: {
  bot: FleetBot
  usage: FleetFilesUsage
  files: FleetPublishedFile[]
  selectedIds: ReadonlySet<string>
  visibleIds: ReadonlySet<string>
  filtering: boolean
  onSelectSegment: (fileId: string) => void
  onApplySort: (sort: FileSort, wholeBot?: boolean) => void
}) {
  const { t, i18n } = useTranslation('fleet')
  const locale = i18n.language
  const spaceLevel = filesSpaceLevel(usage)
  const countLevel = filesCountLevel(usage)
  const level = filesLevel(usage)
  const segments = usageSegments(files, usage.quotaBytes)
  const selectedBytes = files.reduce(
    (sum, file) => (selectedIds.has(file.id) ? sum + file.byteSize : sum),
    0
  )
  const usedLabel = fileSizeLabel(usage.usedBytes, locale)
  const quotaLabel = fileSizeLabel(usage.quotaBytes, locale)
  const freeLabel = fileSizeLabel(Math.max(0, usage.quotaBytes - usage.usedBytes), locale)

  return (
    <div
      className={cn(
        'rounded-lg border p-2.5 text-xs',
        level === 'full'
          ? 'border-red-400/35 bg-red-400/[0.06]'
          : level === 'near'
            ? 'border-amber-400/35 bg-amber-400/[0.05]'
            : 'border-border bg-white/[0.025]'
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-foreground">
          {t('files.drawer.used', { used: usedLabel, quota: quotaLabel })}
        </span>
        {selectedBytes > 0 ? (
          <span className="text-sky-300">
            {t('files.drawer.freed', { size: fileSizeLabel(selectedBytes, locale) })}
          </span>
        ) : (
          <span
            className={cn(
              spaceLevel === 'full'
                ? 'text-red-300'
                : spaceLevel === 'near'
                  ? 'text-amber-300'
                  : 'text-muted-foreground'
            )}
          >
            {t('files.drawer.free', { size: freeLabel })}
          </span>
        )}
      </div>
      <div
        role="img"
        aria-label={t('files.drawer.bar', { used: usedLabel, quota: quotaLabel })}
        className="mt-2 flex h-2 overflow-hidden rounded-full bg-white/[0.07]"
      >
        {segments.map((seg) => (
          <button
            key={seg.id}
            type="button"
            onClick={() => onSelectSegment(seg.id)}
            title={`${seg.name} · ${fileSizeLabel(seg.byteSize, locale)}`}
            style={{ width: `${Math.max(0.4, seg.percent)}%` }}
            className={cn(
              'h-full shrink-0 transition-opacity focus-visible:outline-none',
              KIND_COLOR[seg.kind],
              selectedIds.has(seg.id) && 'ring-1 ring-white',
              filtering && !visibleIds.has(seg.id) && 'opacity-30',
              seg.percent > 0.6 && 'border-r border-black/40'
            )}
          />
        ))}
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 text-[11.5px] text-muted-foreground">
        <span className="truncate">{t('files.drawer.spaceOf', { name: bot.name })}</span>
        <span
          className={cn(
            'shrink-0 tabular-nums',
            countLevel === 'full' && 'text-red-300',
            countLevel === 'near' && 'text-amber-300'
          )}
        >
          {t('files.drawer.count', { count: usage.count, max: usage.countMax })}
        </span>
      </div>
      {level !== 'ok' && (
        <div
          role="status"
          className={cn(
            'mt-2 flex items-start gap-1.5 border-t border-white/[0.07] pt-2 text-[11.5px]',
            level === 'full' ? 'text-red-200' : 'text-amber-200'
          )}
        >
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <div className="min-w-0 flex-1">
            {countLevel === 'full' ? (
              <>
                <span>{t('files.drawer.alert.countFull', { max: usage.countMax })} </span>
                <button
                  type="button"
                  onClick={() => onApplySort('oldest', true)}
                  className="underline hover:text-foreground"
                >
                  {t('files.drawer.alert.oldest')}
                </button>
              </>
            ) : spaceLevel === 'full' ? (
              <>
                <span>{t('files.drawer.alert.spaceFull', { name: bot.name })} </span>
                <button
                  type="button"
                  onClick={() => onApplySort('size')}
                  className="underline hover:text-foreground"
                >
                  {t('files.drawer.alert.largest')}
                </button>
              </>
            ) : countLevel === 'near' ? (
              <>
                <span>
                  {t('files.drawer.alert.countNear', {
                    count: usage.countMax - usage.count,
                    max: usage.countMax,
                  })}{' '}
                </span>
                <button
                  type="button"
                  onClick={() => onApplySort('oldest', true)}
                  className="underline hover:text-foreground"
                >
                  {t('files.drawer.alert.oldest')}
                </button>
              </>
            ) : (
              <>
                <span>
                  {t('files.drawer.alert.spaceNear', {
                    percent: Math.floor((usage.usedBytes / usage.quotaBytes) * 100),
                  })}{' '}
                </span>
                <button
                  type="button"
                  onClick={() => onApplySort('size')}
                  className="underline hover:text-foreground"
                >
                  {t('files.drawer.alert.largest')}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export function BotFilesLimitsPanel({
  bot,
  usage,
  diskFreeBytes,
  onSave,
}: {
  bot: FleetBot
  usage: FleetFilesUsage
  diskFreeBytes: number | null
  onSave: (settings: FleetFileSettings) => Promise<void>
}) {
  const { t, i18n } = useTranslation('fleet')
  const locale = i18n.language
  const currentQuotaGb = Math.max(1, Math.round(usage.quotaBytes / 1024 ** 3))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const update = async (next: FleetFileSettings) => {
    setBusy(true)
    setError(null)
    try {
      await onSave(next)
    } catch (cause) {
      setError(fleetErrorText(cause, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      id={`bot-files-limits-${bot.id}`}
      className="border-b border-border bg-white/[0.02] px-3.5 py-3 text-xs"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-foreground">{t('files.drawer.limits.quota')}</span>
        <div
          role="radiogroup"
          aria-label={t('files.drawer.spaceOf', { name: bot.name })}
          className="inline-flex rounded-lg border border-border bg-white/[0.03] p-0.5"
        >
          {QUOTA_OPTIONS_GB.map((gb) => {
            const bytes = fleetFileQuotaBytes(gb)
            const tooSmall = bytes < usage.usedBytes
            const tooLarge = diskFreeBytes !== null && bytes - usage.usedBytes > diskFreeBytes
            const disabled = busy || tooSmall || tooLarge
            const checked = currentQuotaGb === gb
            return (
              <button
                key={gb}
                type="button"
                role="radio"
                aria-checked={checked}
                disabled={disabled}
                title={
                  tooSmall
                    ? t('files.drawer.limits.tooSmall')
                    : tooLarge
                      ? t('files.drawer.limits.tooLarge')
                      : undefined
                }
                onClick={() =>
                  void update({
                    quotaGb: gb,
                    deleteWithConversations: usage.deleteWithConversations,
                  })
                }
                className={cn(
                  'rounded-md px-2 py-1 text-[11.5px] tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                  checked
                    ? 'bg-white/[0.1] font-medium text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {gb} GB
              </button>
            )
          })}
        </div>
      </div>
      <p className="mt-1.5 text-[11.5px] text-muted-foreground">
        {diskFreeBytes !== null && (
          <>{t('files.drawer.limits.disk', { size: fileSizeLabel(diskFreeBytes, locale) })} </>
        )}
        {t('files.drawer.limits.quotaHint', { max: usage.countMax })}
      </p>
      <div className="mt-2.5 flex items-center justify-between gap-3 border-t border-border pt-2.5">
        <span id={`bot-files-cleanup-${bot.id}`} className="text-[11.5px] text-foreground/90">
          {t('files.drawer.limits.cleanup')}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={usage.deleteWithConversations}
          aria-labelledby={`bot-files-cleanup-${bot.id}`}
          disabled={busy}
          onClick={() =>
            void update({
              quotaGb: currentQuotaGb,
              deleteWithConversations: !usage.deleteWithConversations,
            })
          }
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50',
            usage.deleteWithConversations
              ? 'border-primary/40 bg-primary/80'
              : 'border-border-strong bg-white/[0.08]'
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'inline-block size-3.5 rounded-full bg-background transition-transform',
              usage.deleteWithConversations ? 'translate-x-4' : 'translate-x-0.5'
            )}
          />
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-[11.5px] text-destructive">
          {t('files.drawer.limits.failed', { message: error })}
        </p>
      )}
    </div>
  )
}
