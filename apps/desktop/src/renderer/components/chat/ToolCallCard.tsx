import { memo, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Wrench, Check, X, Loader2, ShieldQuestion, Ban, ImageIcon, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toolOutputImages, toolOutputText, type ChatToolImage, type MessagePart } from '../../../shared/chat'
import { stripMaestroLiveEnvelope } from '../../../shared/maestro-live'
import { IMAGE_OBJECT_URL_IDLE_MS } from '../../../shared/memory-policy'
import { imageResultToObjectUrl, withImageFetchSlot } from '../../lib/binary-image'

type ToolPart = Extract<MessagePart, { type: 'tool' }>

export function StatusBadge({ state }: { state: ToolPart['state'] }) {
  const { t } = useTranslation('chat')
  const map: Record<ToolPart['state']['status'], { icon: React.ReactNode; label: string; cls: string }> = {
    pending: {
      icon: <Loader2 className="h-3 w-3 animate-spin" />,
      label: t('tool.preparing'),
      cls: 'text-muted-foreground',
    },
    'awaiting-permission': {
      icon: <ShieldQuestion className="h-3 w-3" />,
      label: t('tool.awaitingPermission'),
      cls: 'text-amber-400',
    },
    running: { icon: <Loader2 className="h-3 w-3 animate-spin" />, label: t('tool.running'), cls: 'text-sky-400' },
    completed: { icon: <Check className="h-3 w-3" />, label: t('tool.completed'), cls: 'text-emerald-400' },
    error: { icon: <X className="h-3 w-3" />, label: t('tool.error'), cls: 'text-red-400' },
    denied: { icon: <Ban className="h-3 w-3" />, label: t('tool.denied'), cls: 'text-red-400' },
  }
  const m = map[state.status]
  return (
    <span className={cn('inline-flex items-center gap-1 text-[11px]', m.cls)}>
      {m.icon}
      {m.label}
    </span>
  )
}

function pretty(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const ToolImagePreview = memo(function ToolImagePreview({
  image,
  conversationId,
  messageId,
  toolPartId,
}: {
  image: ChatToolImage
  conversationId: string
  messageId: string
  toolPartId: string
}) {
  const { t } = useTranslation('chat')
  const containerRef = useRef<HTMLDivElement>(null)
  const awayTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [nearViewport, setNearViewport] = useState(false)
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ready'; src: string } | { status: 'error' }>({
    status: 'loading',
  })
  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          if (awayTimer.current) clearTimeout(awayTimer.current)
          awayTimer.current = null
          setNearViewport(true)
        } else {
          awayTimer.current = setTimeout(() => setNearViewport(false), IMAGE_OBJECT_URL_IDLE_MS)
        }
      },
      { rootMargin: '600px 0px' }
    )
    observer.observe(element)
    return () => {
      observer.disconnect()
      if (awayTimer.current) clearTimeout(awayTimer.current)
    }
  }, [])
  useEffect(() => {
    if (!nearViewport) {
      setState({ status: 'loading' })
      return
    }
    let active = true
    let objectUrl: string | null = null
    const controller = new AbortController()
    setState({ status: 'loading' })
    void withImageFetchSlot(
      () => window.api.chatToolImage(conversationId, messageId, toolPartId, image.id),
      controller.signal
    )
      .then((result) => {
        if (!active) return
        if (!result.ok) {
          setState({ status: 'error' })
          return
        }
        objectUrl = imageResultToObjectUrl(result)
        setState({ status: 'ready', src: objectUrl })
      })
      .catch(() => {
        if (active) setState({ status: 'error' })
      })
    return () => {
      active = false
      controller.abort(new Error('Tool image preview left the viewport.'))
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [conversationId, image.id, messageId, nearViewport, toolPartId])

  return (
    <div ref={containerRef} className="flex min-w-0 flex-col gap-1.5 rounded bg-black/30 p-2">
      {state.status === 'loading' && (
        <div className="flex items-center gap-1.5 py-4 text-[12px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('tool.imageLoading')}
        </div>
      )}
      {state.status === 'error' && (
        <div className="flex items-center gap-1.5 py-2 text-[12px] text-amber-200/90">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
          {t('tool.imageUnavailable')}
        </div>
      )}
      {state.status === 'ready' && (
        <img
          src={state.src}
          alt={image.name ?? t('tool.imageOutput')}
          className="max-h-[420px] w-full rounded object-contain"
        />
      )}
    </div>
  )
})

export const ToolCallCard = memo(function ToolCallCard({
  part,
  conversationId,
  messageId,
}: {
  part: ToolPart
  conversationId: string
  messageId: string
}) {
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(false)
  const out =
    part.state.status === 'completed'
      ? part.state.output
      : part.state.status === 'running'
        ? (part.state.output ?? '')
        : part.state.status === 'error'
          ? part.state.error
          : part.state.status === 'denied'
            ? (part.state.reason ?? t('tool.deniedByUser'))
            : ''
  const outputText =
    typeof out === 'string'
      ? stripMaestroLiveEnvelope(out)
      : `${stripMaestroLiveEnvelope(toolOutputText(out))}${toolOutputImages(out).length ? `\n[${toolOutputImages(out).length} image output(s)]` : ''}`
  const images = toolOutputImages(out)
  return (
    <div className="min-w-0 max-w-full rounded-lg border border-border bg-white/[0.02] text-[13px]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <ChevronRight
          className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
        />
        <Wrench className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-mono text-foreground" title={part.toolName}>
          {part.toolName}
        </span>
        <span className="ml-auto">
          <StatusBadge state={part.state} />
        </span>
      </button>
      {open && (
        <div className="border-t border-border px-3 py-2">
          {part.input != null && (
            <>
              <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                {t('tool.arguments')}
              </div>
              <pre className="mb-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-2 font-mono text-[12px] text-foreground/90">
                {pretty(part.input)}
              </pre>
            </>
          )}
          {outputText && (
            <>
              <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">{t('tool.result')}</div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-2 font-mono text-[12px] text-foreground/90">
                {outputText}
              </pre>
            </>
          )}
          {images.length > 0 && (
            <div className="mt-2 flex flex-col gap-2">
              <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                <ImageIcon className="h-3.5 w-3.5" />
                {t('tool.imageOutput')}
              </div>
              {images.map((image) => (
                <ToolImagePreview
                  key={image.id}
                  image={image}
                  conversationId={conversationId}
                  messageId={messageId}
                  toolPartId={part.id}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
})
