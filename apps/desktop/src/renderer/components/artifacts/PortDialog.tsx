import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
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

const MIN_PORT = 1024
const MAX_PORT = 65535

/** Moves the host to another port, from the place that reported the busy one. */
export function PortDialog({
  busyPort,
  onSave,
  onCancel,
}: {
  busyPort: number
  onSave: (port: number) => Promise<void>
  onCancel: () => void
}) {
  const { t } = useTranslation('ui')
  const [value, setValue] = useState(String(Math.min(MAX_PORT, busyPort + 1)))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const port = Number(value.trim())
    if (!/^\d+$/.test(value.trim()) || port < MIN_PORT || port > MAX_PORT)
      return setError(t('artifacts.port.invalid', { min: MIN_PORT, max: MAX_PORT }))
    if (port === busyPort) return setError(t('artifacts.port.same', { port }))
    setSaving(true)
    try {
      await onSave(port)
    } catch (reason) {
      setError(t('artifacts.error', { message: reason instanceof Error ? reason.message : String(reason) }))
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onCancel()}>
      <DialogContent className="max-w-[420px] gap-0 p-5" showClose={false}>
        <form onSubmit={(event) => void submit(event)} noValidate>
          <DialogHeader>
            <DialogTitle className="text-base">{t('artifacts.port.title')}</DialogTitle>
            <DialogDescription className="text-[13px]">
              {t('artifacts.port.text', { min: MIN_PORT, max: MAX_PORT })}
            </DialogDescription>
          </DialogHeader>
          <label htmlFor="artifact-port" className="mb-1.5 mt-4 block text-xs text-foreground/75">
            {t('artifacts.port.label')}
          </label>
          <div
            className={cn(
              'flex h-[34px] items-center rounded-md border border-border-strong bg-black/[0.2] focus-within:border-ring',
              error && 'border-destructive/60'
            )}
          >
            <span className="pl-2.5 font-mono text-[12.5px] text-muted-foreground">127.0.0.1:</span>
            <input
              id="artifact-port"
              inputMode="numeric"
              autoFocus
              value={value}
              disabled={saving}
              aria-invalid={Boolean(error)}
              aria-describedby="artifact-port-help"
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => {
                setValue(event.target.value)
                setError(null)
              }}
              className="h-full min-w-0 flex-1 bg-transparent pl-px pr-2.5 font-mono text-[12.5px] text-foreground outline-none"
            />
          </div>
          <p
            id="artifact-port-help"
            role={error ? 'alert' : undefined}
            className={cn('mt-1.5 text-xs', error ? 'text-destructive' : 'text-muted-foreground')}
          >
            {error ?? t('artifacts.port.help')}
          </p>
          <DialogFooter className="mt-[18px]">
            <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="size-3.5 animate-spin" />} {t('artifacts.port.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
