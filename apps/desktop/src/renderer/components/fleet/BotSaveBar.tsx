import { useTranslation } from 'react-i18next'
import type { BotSettingsField } from '@/lib/fleet/bot-settings'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

const saveShortcut = () => (window.api.platformInfo.os === 'mac' ? '⌘S' : 'Ctrl+S')

/**
 * The one place the bot settings are saved: it appears once a field changes, names every changed field (each takes
 * the owner to it), and says what keeps it from saving.
 */
export function BotSaveBar({
  changed,
  blocking,
  error,
  busy,
  onSave,
  onDiscard,
  onGoTo,
}: {
  changed: BotSettingsField[]
  /** Why the draft cannot be saved, or empty. */
  blocking: string
  /** Why the last save failed, or empty. */
  error: string
  busy: boolean
  onSave: () => void
  onDiscard: () => void
  onGoTo: (field: BotSettingsField) => void
}) {
  const { t } = useTranslation('fleet')
  const message = error || blocking
  return (
    <div className="sticky bottom-4 z-10 mt-2">
      <section
        aria-label={t('botSettings.saveBar.region')}
        className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[14px] border border-border-strong bg-popover py-2.5 pl-4 pr-2.5 shadow-[0_14px_44px_rgba(0,0,0,0.5)] backdrop-blur-xl animate-in fade-in-0 slide-in-from-bottom-2 duration-200 motion-reduce:animate-none"
      >
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <strong className="text-[13px] font-semibold">
            {t('botSettings.saveBar.count', { count: changed.length })}
          </strong>
          <span className="flex flex-wrap gap-1">
            {changed.map((field) => (
              <button
                key={field}
                type="button"
                onClick={() => onGoTo(field)}
                className="rounded-full border border-border-strong px-2 py-px text-xs text-foreground/75 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t(field === 'publishArtifacts' ? 'ui:artifacts.publishingBot.label' : `botSettings.field.${field}`)}
              </button>
            ))}
          </span>
        </div>
        <div className="flex gap-1.5">
          <Button variant="ghost" disabled={busy} onClick={onDiscard}>
            {t('botSettings.saveBar.discard')}
          </Button>
          <Button disabled={busy || !!blocking} onClick={onSave}>
            {busy ? t('botSettings.saveBar.saving') : t('botSettings.save')}
            {!busy && (
              <kbd
                aria-hidden="true"
                className="rounded border border-current px-1 font-sans text-[11px] font-medium opacity-55"
              >
                {saveShortcut()}
              </kbd>
            )}
          </Button>
        </div>
        {message && (
          <p
            role="alert"
            className={cn('order-3 basis-full text-[12.5px]', error ? 'text-destructive' : 'text-amber-300')}
          >
            {message}
          </p>
        )}
      </section>
    </div>
  )
}

/** Asked before the owner leaves the settings with changes that are not saved. */
export function LeaveSettingsDialog({
  botName,
  changed,
  busy,
  blocked,
  onKeep,
  onDiscard,
  onSave,
}: {
  botName: string
  changed: BotSettingsField[]
  busy: boolean
  /** The draft cannot be saved as it is: only keeping on editing or discarding remain. */
  blocked: boolean
  onKeep: () => void
  onDiscard: () => void
  onSave: () => void
}) {
  const { t, i18n } = useTranslation('fleet')
  const fields = new Intl.ListFormat(i18n.language, { type: 'conjunction' }).format(
    changed.map((field) =>
      t(field === 'publishArtifacts' ? 'ui:artifacts.publishingBot.label' : `botSettings.field.${field}`)
    )
  )
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onKeep()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('botSettings.leave.title')}</DialogTitle>
          <DialogDescription>
            {t('botSettings.leave.message', { count: changed.length, name: botName, fields })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onKeep}>
            {t('botSettings.leave.keep')}
          </Button>
          <Button variant="outline" disabled={busy} onClick={onDiscard}>
            {t('botSettings.leave.discard')}
          </Button>
          <Button disabled={busy || blocked} onClick={onSave} autoFocus={!blocked}>
            {busy ? t('botSettings.saveBar.saving') : t('botSettings.leave.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
