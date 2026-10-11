import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { BOT_WORKSPACE_SEPARATOR_WIDTH, type BotWorkspaceLayout } from '@/lib/fleet/use-bot-workspace-layout'

/**
 * A main pane beside a screen pane, as a bot's conversation beside its computer and an environment's overview beside
 * its screen. Stable pane containers keep drafts and the remote screen alive while changing the layout. Each pane draws
 * its own header; only a hairline divides them.
 */
export function SplitWorkspace({
  layout,
  primary,
  secondary,
  primaryId,
  labels,
  attributes,
}: {
  layout: BotWorkspaceLayout
  primary: ReactNode
  secondary: ReactNode
  /** The main pane's element id, which the separator controls. */
  primaryId: string
  labels: { primary: string; secondary: string; resize: string }
  /** Data attributes naming what the workspace shows, for the view around it and its tests. */
  attributes: Record<`data-${string}`, string>
}) {
  const pointer = useRef<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const split = layout.mode === 'split' && !layout.narrow
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (pointer.current !== event.pointerId) return
    pointer.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (pointer.current !== event.pointerId || !split) return
    const bounds = layout.container.current?.getBoundingClientRect()
    if (!bounds) return
    layout.setRatio(
      ((event.clientX - bounds.left - BOT_WORKSPACE_SEPARATOR_WIDTH / 2) /
        (bounds.width - BOT_WORKSPACE_SEPARATOR_WIDTH)) *
        100
    )
  }
  const resizeKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const value =
      event.key === 'Home'
        ? layout.minRatio
        : event.key === 'End'
          ? layout.maxRatio
          : event.key === 'ArrowLeft'
            ? layout.ratio - 2
            : event.key === 'ArrowRight'
              ? layout.ratio + 2
              : null
    if (value === null) return
    event.preventDefault()
    layout.setRatio(value)
  }
  const rounded = (value: number) => Math.round(value * 100) / 100
  return (
    <div {...attributes} data-workspace-mode={layout.mode} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div ref={layout.container} className={`relative flex min-h-0 min-w-0 flex-1 ${dragging ? 'select-none' : ''}`}>
        <section
          id={primaryId}
          aria-label={labels.primary}
          inert={!layout.showChat}
          className={layout.showChat ? 'flex min-h-0 min-w-0 flex-col overflow-hidden' : 'hidden'}
          style={split ? { width: layout.chatWidth, flexShrink: 0 } : { flex: 1 }}
        >
          {primary}
        </section>
        <div
          role="separator"
          aria-label={labels.resize}
          aria-orientation="vertical"
          aria-controls={primaryId}
          aria-valuemin={rounded(layout.minRatio)}
          aria-valuemax={rounded(layout.maxRatio)}
          aria-valuenow={rounded(layout.ratio)}
          tabIndex={split ? 0 : -1}
          className={
            split
              ? `relative z-10 shrink-0 cursor-col-resize touch-none transition-colors before:absolute before:inset-y-0 before:-inset-x-1.5 before:content-[''] hover:bg-foreground/40 focus-visible:bg-foreground/40 focus-visible:outline-none ${dragging ? 'bg-foreground/40' : 'bg-border'}`
              : 'hidden'
          }
          style={{ width: BOT_WORKSPACE_SEPARATOR_WIDTH }}
          onKeyDown={resizeKey}
          onPointerDown={(event) => {
            if (event.button !== 0 || !event.isPrimary) return
            event.preventDefault()
            pointer.current = event.pointerId
            event.currentTarget.setPointerCapture(event.pointerId)
            event.currentTarget.focus()
            setDragging(true)
          }}
          onPointerMove={move}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
        />
        <section
          aria-label={labels.secondary}
          inert={!layout.showComputer}
          className={layout.showComputer ? 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden' : 'hidden'}
        >
          {secondary}
        </section>
      </div>
    </div>
  )
}
