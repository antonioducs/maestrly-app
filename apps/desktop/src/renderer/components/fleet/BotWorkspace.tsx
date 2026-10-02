import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { Maximize2, Minimize2, Monitor, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { BOT_WORKSPACE_SEPARATOR_WIDTH, type BotWorkspaceLayout } from '@/lib/fleet/use-bot-workspace-layout'

/** Stable pane containers keep drafts and the remote screen alive while changing the layout. */
export function BotWorkspace({
  botId,
  name,
  layout,
  visible,
  conversation,
  computer,
  onOpenComputer,
  onCloseComputer,
}: {
  botId: string
  name: string
  layout: BotWorkspaceLayout
  visible: boolean
  conversation: ReactNode
  computer: ReactNode
  onOpenComputer: () => void
  onCloseComputer: () => void
}) {
  const { t } = useTranslation('fleet')
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
    <div
      data-bot-workspace={botId}
      data-workspace-mode={layout.mode}
      inert={!visible}
      className={visible ? 'flex min-h-0 min-w-0 flex-1 flex-col' : 'hidden'}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-1 border-b border-border px-3 py-1">
        {layout.mode === 'split' && layout.narrow && (
          <div className="mr-auto flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={layout.lastVisiblePane === 'chat'}
              onClick={() => layout.showPane('chat')}
            >
              {t('workspace.showChat')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={layout.lastVisiblePane === 'computer'}
              onClick={() => layout.showPane('computer')}
            >
              {t('workspace.showComputer')}
            </Button>
          </div>
        )}
        {layout.mode === 'chat' ? (
          <Button size="sm" variant="ghost" onClick={onOpenComputer}>
            <Monitor className="size-3.5" />
            {t('workspace.open')}
          </Button>
        ) : (
          <>
            <Button size="sm" variant="ghost" onClick={layout.mode === 'computer' ? layout.restore : layout.maximize}>
              {layout.mode === 'computer' ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
              {t(layout.mode === 'computer' ? 'workspace.restore' : 'workspace.maximize')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onCloseComputer}
              aria-label={t('workspace.close')}
              title={t('workspace.close')}
            >
              <X className="size-3.5" />
            </Button>
          </>
        )}
      </div>
      <div ref={layout.container} className={`relative flex min-h-0 min-w-0 flex-1 ${dragging ? 'select-none' : ''}`}>
        <section
          id="fleet-workspace-conversation"
          aria-label={t('workspace.chatRegion', { name })}
          inert={!layout.showChat}
          className={layout.showChat ? 'flex min-h-0 min-w-0 flex-col overflow-hidden' : 'hidden'}
          style={split ? { width: layout.chatWidth, flexShrink: 0 } : { flex: 1 }}
        >
          {conversation}
        </section>
        <div
          role="separator"
          aria-label={t('workspace.resize')}
          aria-orientation="vertical"
          aria-controls="fleet-workspace-conversation"
          aria-valuemin={rounded(layout.minRatio)}
          aria-valuemax={rounded(layout.maxRatio)}
          aria-valuenow={rounded(layout.ratio)}
          tabIndex={split ? 0 : -1}
          className={
            split
              ? 'z-10 shrink-0 cursor-col-resize touch-none bg-border/60 hover:bg-primary/60 focus-visible:bg-primary focus-visible:outline-none'
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
          aria-label={t('workspace.computerRegion', { name })}
          inert={!layout.showComputer}
          className={layout.showComputer ? 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden' : 'hidden'}
        >
          {computer}
        </section>
      </div>
    </div>
  )
}
