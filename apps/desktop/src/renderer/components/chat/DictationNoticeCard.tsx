import { useChatDocument } from '@/lib/chat-window-context'
import { useEffect, useRef, type RefObject } from 'react'

const primaryCls =
  'rounded-md bg-indigo-500 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-indigo-400 disabled:opacity-50'
const secondaryCls =
  'rounded-md border border-white/[0.12] px-2.5 py-1 text-[12px] text-foreground hover:bg-white/[0.05] disabled:opacity-50'

export interface DictationNoticeAction {
  label: string
  onClick: () => void
  primary?: boolean
}

/**
 * A short card above the microphone: a missing API key, or a transcription that failed with its recording kept so
 * it can be sent again. Esc closes it; clicks outside the microphone control close it too unless it holds a
 * recording, which a stray click in the editor must not throw away.
 */
export function DictationNoticeCard({
  title,
  body,
  actions,
  onClose,
  dismissOnOutsideClick = true,
  boundary,
}: {
  title: string
  body: string
  actions: DictationNoticeAction[]
  onClose: () => void
  dismissOnOutsideClick?: boolean
  boundary?: RefObject<HTMLElement | null>
}) {
  const ownerDocument = useChatDocument()
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onDoc = (e: MouseEvent) => {
      const inside = (boundary?.current ?? cardRef.current)?.contains(e.target as Node)
      if (!inside) onClose()
    }
    ownerDocument.addEventListener('keydown', onKey)
    if (dismissOnOutsideClick) ownerDocument.addEventListener('mousedown', onDoc)
    return () => {
      ownerDocument.removeEventListener('keydown', onKey)
      ownerDocument.removeEventListener('mousedown', onDoc)
    }
  }, [ownerDocument, boundary, onClose, dismissOnOutsideClick])

  return (
    <div
      ref={cardRef}
      role="alertdialog"
      aria-label={title}
      className="absolute bottom-full right-0 z-50 mb-1 w-80 overflow-hidden rounded-lg border border-white/[0.1] bg-[#161618] p-3 shadow-2xl"
    >
      <p className="text-[13px] font-medium text-foreground">{title}</p>
      <p className="mt-1 text-[12px] leading-snug text-muted-foreground">{body}</p>
      {actions.length > 0 && (
        <div className="mt-2.5 flex justify-end gap-2">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={action.onClick}
              className={action.primary ? primaryCls : secondaryCls}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
