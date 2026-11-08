import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { fleetErrorMessage } from '@/lib/fleet/errors'

/**
 * A recovery key, to copy or save as a file. With `onConfirm`, the owner confirms they kept it before going on, as when
 * a new backup is created.
 */
export function RecoveryKeyStep({
  recoveryKey,
  savedOnThisComputer,
  onSave,
  confirmed,
  onConfirm,
}: {
  recoveryKey: string
  savedOnThisComputer: boolean
  onSave: () => Promise<'saved' | 'cancelled'>
  confirmed?: boolean
  onConfirm?: (confirmed: boolean) => void
}) {
  const { t } = useTranslation('fleet')
  const [copied, setCopied] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="space-y-3">
      <h4 className="text-sm font-semibold">{t('botServer.backups.key.title')}</h4>
      <p className="text-xs text-muted-foreground">{t('botServer.backups.key.body')}</p>
      <p
        className="select-all break-all rounded-md border border-border bg-surface-elevated p-3 text-center font-mono text-base tracking-wider"
        aria-label={t('botServer.backups.key.title')}
      >
        {recoveryKey}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void navigator.clipboard
              .writeText(recoveryKey)
              .then(() => setCopied(true))
              .catch((cause) => setError(fleetErrorMessage(cause)))
          }
        >
          {copied ? t('botServer.backups.key.copied') : t('botServer.backups.key.copy')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void onSave()
              .then((result) => setSaved(result === 'saved'))
              .catch((cause) => setError(fleetErrorMessage(cause)))
          }
        >
          {saved ? t('botServer.backups.key.saved') : t('botServer.backups.key.save')}
        </Button>
      </div>
      {!savedOnThisComputer && (
        <p role="alert" className="rounded-md border border-amber-500/40 p-3 text-xs text-amber-500">
          {t('botServer.backups.key.notStored')}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {onConfirm && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={!!confirmed} onChange={(event) => onConfirm(event.target.checked)} />
          {t('botServer.backups.key.confirm')}
        </label>
      )}
    </div>
  )
}
