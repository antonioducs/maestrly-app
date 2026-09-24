import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { MessagePart } from '../../../shared/chat'

const CHIP = 'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] text-foreground'

/**
 * PDF attachment in a sent message. Once the message is persisted (the part carries its artifact), clicking opens
 * the document in the operating system's viewer; the optimistic bubble shown while sending is not clickable yet.
 */
export function PdfAttachmentChip({
  part,
  conversationId,
  messageId,
}: {
  part: Extract<MessagePart, { type: 'file' }>
  conversationId: string
  messageId: string
}) {
  const { t } = useTranslation('chat')
  const [opening, setOpening] = useState(false)
  const [failed, setFailed] = useState(false)
  const content = (
    <>
      <FileText className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="text-[10px] font-medium uppercase text-muted-foreground">PDF</span>
      <span className="max-w-[160px] truncate">{part.name}</span>
      {part.pageCount != null && (
        <span className="text-[11px] text-muted-foreground">{t('messages.pdfPages', { count: part.pageCount })}</span>
      )}
    </>
  )
  if (!part.artifactId) {
    return (
      <span className={cn(CHIP, 'border-white/[0.08] bg-white/[0.04]')} title={part.name}>
        {content}
      </span>
    )
  }
  const open = async () => {
    setOpening(true)
    try {
      const result = await window.api.chatOpenAttachmentPdf(conversationId, messageId, part.id)
      setFailed(!result.ok)
    } catch {
      setFailed(true)
    } finally {
      setOpening(false)
    }
  }
  return (
    <button
      type="button"
      onClick={() => void open()}
      disabled={opening}
      title={failed ? t('messages.pdfOpenFailed') : t('messages.openPdf', { name: part.name })}
      className={cn(
        CHIP,
        'cursor-pointer transition-colors disabled:cursor-progress',
        failed
          ? 'border-destructive/50 bg-destructive/10'
          : 'border-white/[0.08] bg-white/[0.04] hover:border-white/[0.16] hover:bg-white/[0.07]'
      )}
    >
      {content}
    </button>
  )
}
