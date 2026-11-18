import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  Check,
  Hand,
  Loader2,
  ShieldAlert,
  SkipForward,
  Sparkles,
  Square,
  TerminalSquare,
  User,
  Zap,
} from 'lucide-react'
import type { ChatPermMode } from '../../../shared/chat'
import type { RoutineModel, RoutineRunStatus, RoutineSavedPermission, RoutineWaitingKind } from '../../../shared/routines'
import { cn } from '@/lib/utils'
import { outcomeTone, type RoutineTone } from '@/lib/routines/timeline'
import { modelDisplayName } from '@/components/chat/model-search'

export function outcomeIcon(status: RoutineRunStatus, className = 'size-[11px] shrink-0') {
  switch (status) {
    case 'running':
      return <Loader2 aria-hidden="true" className={cn(className, 'animate-spin')} />
    case 'notable':
      return <Sparkles aria-hidden="true" className={className} />
    case 'nothing_new':
    case 'done':
      return <Check aria-hidden="true" className={className} />
    case 'failed':
      return <AlertCircle aria-hidden="true" className={className} />
    case 'waiting':
      return <User aria-hidden="true" className={className} />
    case 'stopped':
      return <Square aria-hidden="true" className={className} />
    default:
      return <SkipForward aria-hidden="true" className={className} />
  }
}

export function toneClass(tone: RoutineTone): string {
  return `routine-tone-${tone}`
}

export function RoutineDot({
  tone,
  title,
  className,
}: {
  tone: RoutineTone
  title?: string
  className?: string
}) {
  return <span aria-hidden="true" title={title} className={cn('routine-dot', toneClass(tone), className)} />
}

export function RoutineOutcomePill({
  status,
  waitingKind,
  short = false,
  className,
}: {
  status: RoutineRunStatus
  waitingKind?: RoutineWaitingKind | null
  short?: boolean
  className?: string
}) {
  const { t } = useTranslation('routines')
  const tone = outcomeTone(status)
  const key = status === 'waiting' && waitingKind === 'question' ? 'waitingQuestion' : status
  const label = t(`outcome.${key}.${short ? 'short' : 'label'}` as never)
  return (
    <span className={cn('routine-pill', toneClass(tone), className)}>
      {outcomeIcon(status)}
      <span>{label}</span>
    </span>
  )
}

export function RoutinePermBadge({ mode, className }: { mode: ChatPermMode; className?: string }) {
  const { t } = useTranslation('chat')
  const icon =
    mode === 'ask' ? (
      <Hand aria-hidden="true" className="size-[13px] shrink-0" />
    ) : mode === 'full' ? (
      <ShieldAlert aria-hidden="true" className="size-[13px] shrink-0" />
    ) : (
      <TerminalSquare aria-hidden="true" className="size-[13px] shrink-0" />
    )
  const label =
    mode === 'ask' ? t('perm.askLabel') : mode === 'full' ? t('perm.fullLabel') : t('perm.autoLabel')

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-[6px] px-2 py-0.5 pl-1.5 text-[12px] font-medium',
        mode === 'full'
          ? 'bg-[rgba(242,180,92,0.1)] text-[var(--artifact-warn)]'
          : 'bg-white/[0.06] text-foreground',
        className
      )}
    >
      {icon}
      <span>{label}</span>
    </span>
  )
}

export function RoutineModelLine({
  model,
  modelName,
  providerName,
}: {
  model: RoutineModel
  modelName?: string
  providerName?: string
}) {
  const { t } = useTranslation('chat')
  const effortLabel =
    model.reasoning === 'off'
      ? t('reasoning.default')
      : model.reasoning === 'maestrly-ultra'
        ? t('reasoning.ultra')
        : model.reasoning
  const displayName = modelName || modelDisplayName(model.modelId)
  const displayProvider = providerName || model.providerId

  return (
    <>
      <span>{displayName}</span>
      <span className="text-[rgba(154,149,140,0.58)]">{displayProvider}</span>
      <span className="text-[rgba(154,149,140,0.58)]">·</span>
      <span>
        {t('reasoning.heading')} {effortLabel}
      </span>
      {model.fastMode && (
        <span className="inline-flex items-center gap-0.5 text-[11.5px] text-[var(--artifact-warn)]">
          <Zap aria-hidden="true" className="size-[11px]" />
          {t('fastMode.label')}
        </span>
      )}
    </>
  )
}

export function RoutineSavedPermissionLabel({ perm }: { perm: Pick<RoutineSavedPermission, 'action' | 'resource'> }) {
  const { t } = useTranslation('routines')
  return (
    <>
      {perm.action === 'dir' && <span className="text-[rgba(154,149,140,0.58)]">{t('editor.folderPrefix')}</span>}
      <code className="rounded-[5px] bg-white/[0.06] px-[0.35em] py-[0.05em] font-mono text-[0.92em]">
        {perm.resource}
      </code>
    </>
  )
}
