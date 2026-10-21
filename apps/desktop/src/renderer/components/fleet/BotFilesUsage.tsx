import { useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import {
  fleetFileQuotaBytes,
  type FleetBot,
  type FleetFileSettings,
  type FleetFilesUsage,
  type FleetPublishedFile,
} from '@maestrly/bot-fleet-protocol'
import { fleetErrorText } from '@/lib/fleet/errors'
import {
  filesCountLevel,
  filesLevel,
  filesSpaceLevel,
  spaceLabel,
  usageSegments,
  type FileSort,
  type FilesLevel,
  type FleetFileKind,
} from '@/lib/fleet/files'
import { cn } from '@/lib/utils'
import { SettingsSwitch } from './SettingsSwitch'

const QUOTA_OPTIONS_GB = [1, 2, 5, 10, 20] as const

/** Quiet tones of the app's palette: the bar reads as one space, split by kind, not as a chart. */
const KIND_COLOR: Record<FleetFileKind, string> = {
  video: 'bg-[#e3dccd]',
  image: 'bg-[#7d9fae]',
  document: 'bg-[#8a857c]',
  archive: 'bg-[#b39a72]',
}

/** The track, with a tick every tenth of the space. */
const TRACK: CSSProperties = {
  background:
    'repeating-linear-gradient(90deg, transparent 0 calc(10% - 1px), rgba(255, 255, 255, 0.07) calc(10% - 1px) 10%), rgba(255, 255, 255, 0.035)',
  boxShadow: 'inset 0 0 0 1px var(--border)',
}
/** A file selected for deletion: what deleting it frees. */
const SELECTED: CSSProperties = {
  background: 'repeating-linear-gradient(135deg, var(--destructive) 0 3px, rgba(255, 122, 133, 0.38) 3px 6px)',
}

const levelText = (level: FilesLevel) =>
  level === 'full' ? 'text-destructive' : level === 'near' ? 'text-artifact-warn' : 'text-muted-foreground'

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
  const selectedBytes = files.reduce((sum, file) => (selectedIds.has(file.id) ? sum + file.byteSize : sum), 0)
  const usedLabel = spaceLabel(usage.usedBytes, locale)
  const quotaLabel = spaceLabel(usage.quotaBytes, locale)
  const alert =
    countLevel === 'full'
      ? { text: t('files.drawer.alert.countFull', { max: usage.countMax }), sort: 'oldest' as const }
      : spaceLevel === 'full'
        ? { text: t('files.drawer.alert.spaceFull', { name: bot.name }), sort: 'size' as const }
        : countLevel === 'near'
          ? {
              text: t('files.drawer.alert.countNear', { count: usage.countMax - usage.count, max: usage.countMax }),
              sort: 'oldest' as const,
            }
          : spaceLevel === 'near'
            ? {
                text: t('files.drawer.alert.spaceNear', {
                  percent: Math.floor((usage.usedBytes / usage.quotaBytes) * 100),
                }),
                sort: 'size' as const,
              }
            : null

  return (
    <div
      className={cn(
        'rounded-[10px] border bg-white/[0.03] px-3 py-2.5 text-xs',
        level === 'full' ? 'border-destructive/35' : level === 'near' ? 'border-artifact-warn/30' : 'border-border'
      )}
    >
      <div className="mb-[7px] flex items-baseline justify-between gap-2 text-muted-foreground">
        <span className="min-w-0 truncate">
          <b className="text-[17px] font-semibold tracking-tight text-foreground tabular-nums">{usedLabel}</b>{' '}
          {t('files.drawer.of', { quota: quotaLabel })}
        </span>
        {selectedBytes > 0 ? (
          <span className="shrink-0">
            <b className="font-semibold text-destructive">
              {t('files.drawer.freed', { size: spaceLabel(selectedBytes, locale) })}
            </b>
          </span>
        ) : (
          <span className={cn('shrink-0 font-medium', levelText(spaceLevel))}>
            {t('files.drawer.free', { size: spaceLabel(Math.max(0, usage.quotaBytes - usage.usedBytes), locale) })}
          </span>
        )}
      </div>
      <div
        role="img"
        aria-label={t('files.drawer.bar', { used: usedLabel, quota: quotaLabel })}
        className="flex h-3.5 overflow-hidden rounded"
        style={TRACK}
      >
        {segments.map((segment) => (
          <button
            key={segment.id}
            type="button"
            tabIndex={-1}
            data-file-segment={segment.id}
            onClick={() => onSelectSegment(segment.id)}
            title={`${segment.name} · ${spaceLabel(segment.byteSize, locale)}`}
            style={{
              width: `${segment.percent}%`,
              ...(selectedIds.has(segment.id) ? SELECTED : {}),
              ...(segment.percent > 0.6 ? { boxShadow: 'inset -1px 0 0 rgba(13, 13, 16, 0.6)' } : {}),
            }}
            className={cn(
              'h-full shrink-0 cursor-pointer transition-[opacity,filter] hover:brightness-110 motion-reduce:transition-none',
              !selectedIds.has(segment.id) && KIND_COLOR[segment.kind],
              filtering && !visibleIds.has(segment.id) && !selectedIds.has(segment.id) && 'opacity-20'
            )}
          />
        ))}
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 text-[11.5px] text-muted-foreground">
        <span className="truncate">{t('files.drawer.spaceOf', { name: bot.name })}</span>
        <span className={cn('shrink-0 tabular-nums', countLevel !== 'ok' && levelText(countLevel))}>
          {t('files.drawer.count', { count: usage.count, max: usage.countMax })}
        </span>
      </div>
      {alert && (
        <div role="status" className="mt-2 flex items-start gap-1.5 border-t border-border pt-2 text-foreground">
          <AlertTriangle aria-hidden="true" className={cn('mt-px size-3.5 shrink-0', levelText(level))} />
          <p className="min-w-0 flex-1">
            {alert.text}{' '}
            <button
              type="button"
              onClick={() => onApplySort(alert.sort, alert.sort === 'oldest')}
              className="whitespace-nowrap rounded-sm text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t(alert.sort === 'oldest' ? 'files.drawer.alert.oldest' : 'files.drawer.alert.largest')}
            </button>
          </p>
        </div>
      )}
    </div>
  )
}

export function BotFilesLimitsPanel({
  id,
  bot,
  usage,
  diskFreeBytes,
  onSave,
}: {
  id: string
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
    <div id={id} className="flex shrink-0 flex-col gap-2 border-b border-border bg-white/[0.03] px-4 py-3 text-xs">
      <div className="flex items-center justify-between gap-2.5">
        <span className="font-medium text-foreground">{t('files.drawer.limits.quota')}</span>
        <div
          role="radiogroup"
          aria-label={t('files.drawer.spaceOf', { name: bot.name })}
          className="inline-flex gap-0.5 rounded-lg border border-border-strong bg-black/20 p-0.5"
        >
          {QUOTA_OPTIONS_GB.map((gb) => {
            const bytes = fleetFileQuotaBytes(gb)
            const checked = currentQuotaGb === gb
            const tooSmall = !checked && bytes < usage.usedBytes
            const tooLarge = !checked && diskFreeBytes !== null && bytes - usage.usedBytes > diskFreeBytes
            return (
              <button
                key={gb}
                type="button"
                role="radio"
                aria-checked={checked}
                disabled={busy || tooSmall || tooLarge}
                title={
                  tooSmall
                    ? t('files.drawer.limits.tooSmall')
                    : tooLarge
                      ? t('files.drawer.limits.tooLarge')
                      : undefined
                }
                onClick={() =>
                  !checked && void update({ quotaGb: gb, deleteWithConversations: usage.deleteWithConversations })
                }
                className={cn(
                  'whitespace-nowrap rounded-md px-[7px] py-0.5 text-[11.5px] tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40',
                  checked
                    ? 'bg-surface-elevated text-foreground shadow-[0_0_0_1px_var(--border-strong)]'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {gb} GB
              </button>
            )
          })}
        </div>
      </div>
      <p className="-mt-0.5 text-[11.5px] text-muted-foreground">
        {diskFreeBytes !== null && <>{t('files.drawer.limits.disk', { size: spaceLabel(diskFreeBytes, locale) })} </>}
        {t('files.drawer.limits.quotaHint', { max: usage.countMax })}
      </p>
      <div className="flex items-center justify-between gap-2.5">
        <span className="text-[12.5px] text-foreground/75">{t('files.drawer.limits.cleanup')}</span>
        <SettingsSwitch
          checked={usage.deleteWithConversations}
          label={t('files.drawer.limits.cleanup')}
          disabled={busy}
          onChange={() =>
            void update({ quotaGb: currentQuotaGb, deleteWithConversations: !usage.deleteWithConversations })
          }
        />
      </div>
      {error && (
        <p role="alert" className="text-[11.5px] text-destructive">
          {t('files.drawer.limits.failed', { message: error })}
        </p>
      )}
    </div>
  )
}
