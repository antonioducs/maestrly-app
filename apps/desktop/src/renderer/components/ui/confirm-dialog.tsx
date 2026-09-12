import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  busy,
  destructive,
  onCancel,
  onConfirm,
}: {
  title: string
  message: string
  confirmLabel: string
  busy?: boolean
  destructive?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation('ui')
  return (
    <>
      <div className="fixed inset-0 z-[60] bg-black/50" onClick={onCancel} />
      <div className="fixed left-1/2 top-1/2 z-[61] w-[400px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-[#1E1E21] p-5 shadow-2xl">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{message}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors hover:brightness-110 disabled:opacity-50',
              destructive ? 'bg-destructive text-white' : 'bg-primary text-primary-foreground'
            )}
          >
            {busy && <Loader2 className="size-3.5 animate-spin" />} {confirmLabel}
          </button>
        </div>
      </div>
    </>
  )
}
