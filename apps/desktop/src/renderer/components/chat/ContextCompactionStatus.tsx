import { useTranslation } from 'react-i18next'
import { Check, CircleAlert, LoaderCircle, X } from 'lucide-react'
import type { ChatCompactionProgress } from '../../../shared/chat'
import { compactionStatusText } from './context-observation'

export function ContextCompactionStatus({ progress }: { progress?: ChatCompactionProgress }) {
  const { t } = useTranslation('chat')
  const active = progress?.status === 'running' || progress?.status === 'retrying'
  const { label, reduction } = compactionStatusText(progress, t)
  const Icon = active
    ? LoaderCircle
    : progress?.status === 'completed'
      ? Check
      : progress?.status === 'failed'
        ? CircleAlert
        : X

  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
      {progress && <Icon aria-hidden="true" className={`h-3 w-3 shrink-0 ${active ? 'animate-spin' : ''}`} />}
      <span role="status" aria-live="polite" aria-atomic="true">
        {label}
      </span>
      {reduction && <span>{reduction}</span>}
    </span>
  )
}
