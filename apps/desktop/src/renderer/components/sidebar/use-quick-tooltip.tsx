import { useState, type MouseEvent, type ReactNode } from 'react'

export function useQuickTooltip(): {
  showQuickTooltip: (e: MouseEvent<HTMLElement>, text: string) => void
  hideQuickTooltip: () => void
  quickTooltipNode: ReactNode
} {
  const [quickTooltip, setQuickTooltip] = useState<{
    text: string
    left: number
    top: number
    placement: 'top' | 'bottom'
  } | null>(null)

  const showQuickTooltip = (e: MouseEvent<HTMLElement>, text: string) => {
    const label = text.trim()
    if (!label) return
    const rect = e.currentTarget.getBoundingClientRect()
    const showAbove = rect.bottom + 40 > window.innerHeight
    setQuickTooltip({
      text: label,
      left: Math.max(8, rect.left + 12),
      top: showAbove ? rect.top - 6 : rect.bottom + 6,
      placement: showAbove ? 'top' : 'bottom',
    })
  }

  const hideQuickTooltip = () => setQuickTooltip(null)

  const quickTooltipNode = quickTooltip ? (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-[100] max-w-[28rem] rounded-md border border-border-strong bg-popover px-2 py-1 text-xs leading-snug text-popover-foreground shadow-xl break-words"
      style={{
        left: quickTooltip.left,
        top: quickTooltip.top,
        maxWidth: 'min(28rem, calc(100vw - 1rem))',
        transform: quickTooltip.placement === 'top' ? 'translateY(-100%)' : undefined,
      }}
    >
      {quickTooltip.text}
    </div>
  ) : null

  return { showQuickTooltip, hideQuickTooltip, quickTooltipNode }
}
