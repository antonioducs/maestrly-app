import { useEffect, useId, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { t } from '../i18n/index.js'
export function Modal({
  title,
  onClose,
  children,
  wide = false,
  closeLabel,
}: {
  title: string
  onClose(): void
  children: ReactNode
  wide?: boolean
  closeLabel?: string
}) {
  const ref = useRef<HTMLDialogElement>(null),
    id = useId()
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null,
      dialog = ref.current!
    dialog.showModal()
    return () => {
      dialog.close()
      previous?.focus()
    }
  }, [])
  return (
    <dialog
      ref={ref}
      className={'form-dialog dialog-enter ' + (wide ? 'detail-dialog' : '')}
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault()
        close.current()
      }}
    >
      <header>
        <h2 id={id}>{title}</h2>
        <button type="button" className="icon-button" onClick={() => close.current()} aria-label={closeLabel??t('Close card')}>
          <X size={18} />
        </button>
      </header>
      {children}
    </dialog>
  )
}
