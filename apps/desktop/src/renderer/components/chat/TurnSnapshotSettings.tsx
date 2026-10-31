import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useHostApi } from '@/lib/hosts/host-context'
import { cn } from '@/lib/utils'
import type { TurnSnapshotUsage } from '../../../shared/turn-snapshots'

function formatSize(bytes: number, language: string): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1
  return `${value.toLocaleString(language, { maximumFractionDigits: digits })} ${units[unit]}`
}

/** Settings → Chat: snapshots for undoing a turn's file changes, the space they take, and clearing them. */
export function TurnSnapshotSettings() {
  const { t, i18n } = useTranslation('chat')
  const api = useHostApi()
  const [usage, setUsage] = useState<TurnSnapshotUsage | null>(null)
  const [clearing, setClearing] = useState(false)
  const refresh = useCallback(() => {
    api
      .turnSnapshotsUsage()
      .then(setUsage)
      .catch(() => setUsage(null))
  }, [api])
  useEffect(refresh, [refresh])
  // A host without snapshots (an older version) shows nothing.
  if (!usage) return null
  const heading = t('turnChanges.settings.heading')
  return (
    <div data-testid="turn-snapshot-settings" className="mt-1 border-t border-border pt-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="text-[12px] font-medium text-foreground">{heading}</span>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{t('turnChanges.settings.description')}</p>
        </div>
        <button
          type="button"
          onClick={() =>
            api
              .turnSnapshotsSetEnabled(!usage.enabled)
              .then(refresh)
              .catch(() => undefined)
          }
          className={cn(
            'mt-0.5 h-4 w-7 shrink-0 rounded-full p-0.5 transition-colors',
            usage.enabled ? 'bg-emerald-500/70' : 'bg-white/10'
          )}
          title={usage.enabled ? t('settings.toggleOn') : t('settings.toggleOff')}
          aria-label={heading}
          aria-pressed={usage.enabled}
        >
          <span
            className={cn('block h-3 w-3 rounded-full bg-white transition-transform', usage.enabled && 'translate-x-3')}
          />
        </button>
      </div>
      {!usage.gitAvailable && (
        <p className="mt-1.5 text-[11px] text-amber-300">{t('turnChanges.settings.gitMissing')}</p>
      )}
      <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
        <span className="tabular-nums">
          {t('turnChanges.settings.usage', {
            count: usage.records,
            size: formatSize(usage.bytes, i18n.resolvedLanguage || i18n.language),
          })}
        </span>
        <button
          type="button"
          data-testid="turn-snapshots-clear"
          disabled={clearing || (usage.bytes === 0 && usage.records === 0)}
          onClick={() => {
            setClearing(true)
            api
              .turnSnapshotsClear()
              .catch(() => undefined)
              .finally(() => {
                setClearing(false)
                refresh()
              })
          }}
          className="rounded-md border border-border px-2 py-0.5 text-foreground hover:bg-white/[0.06] disabled:opacity-50"
        >
          {clearing ? t('turnChanges.settings.clearing') : t('turnChanges.settings.clear')}
        </button>
      </div>
    </div>
  )
}
