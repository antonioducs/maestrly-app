import { useTranslation } from 'react-i18next'
import { Info } from 'lucide-react'
import type { IgnoredMigrationEntry } from '../../../preload'

interface Props {
  entries: IgnoredMigrationEntry[]
  selected: string[]
  confirmed: string[]
  disabled: boolean
  onToggle: (path: string, selected: boolean, sensitive: boolean) => void
  onConfirm: (path: string, confirmed: boolean) => void
}

/** The ignored files a conversation may take along, each opted into, and the sensitive ones confirmed again. */
export function IgnoredEntriesChecklist({ entries, selected, confirmed, disabled, onToggle, onConfirm }: Props) {
  const { t } = useTranslation('ui')
  if (entries.length === 0)
    return (
      <p className="rounded-md border border-border p-3 text-xs text-muted-foreground">
        {t('conversationMigration.noIgnored')}
      </p>
    )
  return (
    <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
      {entries.map((entry) => {
        const isSelected = selected.includes(entry.path)
        const isConfirmed = confirmed.includes(entry.path)
        const details = (
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="break-all font-mono">{entry.path}</span>
              <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {formatBytes(entry.size)}
              </span>
              {entry.sensitive && (
                <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] text-amber-200">
                  {t('conversationMigration.sensitive')}
                </span>
              )}
            </span>
            {!entry.selectable && (
              <span className="mt-1 block text-muted-foreground">
                {t(`conversationMigration.ignoredReason.${entry.reasonCode ?? 'unsafe'}`)}
              </span>
            )}
          </span>
        )

        if (!entry.selectable) {
          return (
            <div key={entry.path} className="rounded-md border border-border p-3 opacity-80">
              <div className="flex items-start gap-2 text-xs">
                <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                {details}
              </div>
            </div>
          )
        }
        return (
          <div key={entry.path} className="rounded-md border border-border p-3">
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={isSelected}
                disabled={disabled}
                onChange={(event) => onToggle(entry.path, event.target.checked, entry.sensitive)}
              />
              {details}
            </label>
            {entry.sensitive && isSelected && (
              <label className="mt-2 flex items-start gap-2 rounded border border-amber-400/30 bg-amber-400/10 p-2 text-xs text-amber-100">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={isConfirmed}
                  disabled={disabled}
                  onChange={(event) => onConfirm(entry.path, event.target.checked)}
                />
                <span>{t('conversationMigration.confirmSensitive', { path: entry.path })}</span>
              </label>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
