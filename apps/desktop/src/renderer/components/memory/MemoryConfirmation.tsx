import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog'

export function MemoryConfirmation({
  kind,
  busy = false,
  error,
  onCancel,
  onConfirm,
}: {
  kind: 'discard' | 'forget'
  busy?: boolean
  error?: string
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation('ui')
  const opener = useRef(document.activeElement as HTMLElement | null)
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (opener.current?.isConnected) opener.current.focus()
        }}
        showClose={false}
        className="max-w-[min(400px,calc(100vw-24px))] rounded-xl"
      >
        <DialogTitle className="text-sm">{t(`personalMemory.${kind}Title`)}</DialogTitle>
        <DialogDescription className="text-xs leading-relaxed">
          {t(kind === 'forget' ? 'projectMemory.forgetConfirm' : 'personalMemory.discardHint')}
        </DialogDescription>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button autoFocus size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="outline" className="text-destructive" disabled={busy} onClick={onConfirm}>
            {t(kind === 'forget' ? 'projectMemory.forget' : 'personalMemory.discard')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
