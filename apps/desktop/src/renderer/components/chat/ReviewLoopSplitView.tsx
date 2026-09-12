import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ReviewLoopInfo } from '../../../shared/chat'

interface Props {
  loop: ReviewLoopInfo
  ratio: number
  onRatioChange(ratio: number): void
  onFocus(conversationId: string): void
  onDismiss(): void
}

export function ReviewLoopSplitView({ loop, ratio, onRatioChange, onFocus, onDismiss }: Props) {
  const { t } = useTranslation('chat')
  const rootRef = useRef<HTMLDivElement>(null)
  const reviewer = loop.participants.reviewer
  if (!reviewer) return null

  const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const root = rootRef.current
    if (!root) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const move = (next: PointerEvent) => {
      const bounds = root.getBoundingClientRect()
      const value = ((next.clientX - bounds.left) / Math.max(1, bounds.width)) * 100
      onRatioChange(Math.min(75, Math.max(25, value)))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up, { once: true })
  }

  const label = (role: 'executor' | 'reviewer') => {
    const participant = role === 'executor' ? loop.participants.executor : reviewer
    return (
      <button
        type="button"
        className="pointer-events-auto flex min-w-0 flex-1 items-center gap-2 px-3 text-left hover:bg-white/[0.03]"
        onClick={() => onFocus(participant.conversationId)}
      >
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-violet-300">
          {t(`reviewLoop.role${role === 'executor' ? 'Executor' : 'Reviewer'}`)}
        </span>
        <span className="truncate text-xs font-medium text-foreground/90">{participant.name}</span>
        <span className="truncate text-[11px] text-muted-foreground">{participant.modelId}</span>
      </button>
    )
  }

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0 z-20" data-review-loop-split={loop.loopId}>
      <div className="absolute inset-x-0 top-0 flex h-7 border-b border-white/[0.07] bg-[#121217]">
        <div className="flex min-w-0" style={{ width: `${ratio}%` }}>
          {label('executor')}
        </div>
        <div className="flex min-w-0 flex-1 border-l border-white/[0.08]">
          {label('reviewer')}
          <button
            type="button"
            onClick={onDismiss}
            title={t('reviewLoop.splitClose')}
            className="pointer-events-auto mr-1 rounded p-1 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={drag}
        className="pointer-events-auto absolute bottom-0 top-7 z-30 w-1 -translate-x-1/2 cursor-col-resize bg-border/40 hover:bg-violet-400/70"
        style={{ left: `${ratio}%` }}
      />
    </div>
  )
}
