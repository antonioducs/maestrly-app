import { useChatDocument, useChatOwnerWindow } from '@/lib/chat-window-context'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  busy,
  destructive,
  error,
  onCancel,
  onConfirm,
}: {
  title: string
  message: string
  confirmLabel: string
  busy?: boolean
  destructive?: boolean
  /** Why the last confirmation failed; the dialog stays open so it can be tried again. */
  error?: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const ownerDocument = useChatDocument()
  const ownerWindow = useChatOwnerWindow()
  const { t } = useTranslation('ui')
  const confirmRef = useRef<HTMLButtonElement>(null)
  // Escape cancels, the decision starts focused, and whatever opened it gets the focus back.
  useEffect(() => {
    const opener = ownerDocument.activeElement as HTMLElement | null
    confirmRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onCancel()
    }
    ownerWindow.addEventListener('keydown', onKeyDown, true)
    return () => {
      ownerWindow.removeEventListener('keydown', onKeyDown, true)
      if (opener?.isConnected) opener.focus()
    }
  }, [ownerDocument, ownerWindow, onCancel])
  return (
    <>
      <div className="fixed inset-0 z-[60] bg-black/50" onClick={onCancel} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="fixed left-1/2 top-1/2 z-[61] w-[400px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-[#1E1E21] p-5 shadow-2xl"
      >
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{message}</p>
        {error && (
          <p role="alert" className="mt-2 text-xs leading-relaxed text-destructive">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            ref={confirmRef}
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
