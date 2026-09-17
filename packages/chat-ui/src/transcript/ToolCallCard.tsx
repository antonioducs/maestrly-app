import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, Wrench, Check, X, Loader2, ShieldQuestion, Ban, ImageIcon, TriangleAlert } from 'lucide-react'
import { cn } from '@maestrly/ui'
import { useChatUi } from '../provider'
import { TOOL_OUTPUT_DISPLAY_MAX, type ToolImageRef, type ToolPartView, type ToolViewState } from './types'

/** How long a preview stays resolved after leaving the viewport before its bytes are released. */
const IMAGE_IDLE_MS = 30_000

export function StatusBadge({ state }: { state: ToolViewState }) {
  const { labels } = useChatUi()
  const map: Record<ToolViewState, { icon: ReactNode; label: string; cls: string }> = {
    pending: { icon: <Loader2 className="h-3 w-3 animate-spin" />, label: labels.tool.pending, cls: 'text-muted-foreground' },
    'awaiting-permission': { icon: <ShieldQuestion className="h-3 w-3" />, label: labels.tool.awaitingPermission, cls: 'text-amber-400' },
    running: { icon: <Loader2 className="h-3 w-3 animate-spin" />, label: labels.tool.running, cls: 'text-sky-400' },
    done: { icon: <Check className="h-3 w-3" />, label: labels.tool.done, cls: 'text-emerald-400' },
    error: { icon: <X className="h-3 w-3" />, label: labels.tool.error, cls: 'text-red-400' },
    denied: { icon: <Ban className="h-3 w-3" />, label: labels.tool.denied, cls: 'text-red-400' },
  }
  const m = map[state]
  return (
    <span className={cn('inline-flex items-center gap-1 text-[11px]', m.cls)} data-tool-state={state}>
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

/** Display clipping only: the Host already bounds what it stores, this keeps a card from dominating the list. */
export function clipOutput(text: string, max = TOOL_OUTPUT_DISPLAY_MAX): string {
  return text.length > max ? `…${text.slice(text.length - max)}` : text
}

const ToolImagePreview = memo(function ToolImagePreview({ image }: { image: ToolImageRef }) {
  const { labels, resolveImage } = useChatUi()
  const containerRef = useRef<HTMLDivElement>(null)
  const awayTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [nearViewport, setNearViewport] = useState(false)
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ready'; src: string } | { status: 'error' }>({ status: 'loading' })
  useEffect(() => {
    const element = containerRef.current
    if (!element || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          if (awayTimer.current) clearTimeout(awayTimer.current)
          awayTimer.current = null
          setNearViewport(true)
        } else {
          awayTimer.current = setTimeout(() => setNearViewport(false), IMAGE_IDLE_MS)
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
    if (!nearViewport || !resolveImage) {
      setState(resolveImage ? { status: 'loading' } : { status: 'error' })
      return
    }
    let active = true
    let release: (() => void) | undefined
    const controller = new AbortController()
    setState({ status: 'loading' })
    resolveImage(image.ref, controller.signal)
      .then((result) => {
        if (!active) return
        if (!result) {
          setState({ status: 'error' })
          return
        }
        release = result.release
        setState({ status: 'ready', src: result.src })
      })
      .catch(() => {
        if (active) setState({ status: 'error' })
      })
    return () => {
      active = false
      controller.abort(new Error('Tool image preview left the viewport.'))
      release?.()
    }
  }, [image.ref, nearViewport, resolveImage])

  return (
    <div ref={containerRef} className="flex min-w-0 flex-col gap-1.5 rounded bg-black/30 p-2">
      {state.status === 'loading' && (
        <div className="flex items-center gap-1.5 py-4 text-[12px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {labels.tool.imageLoading}
        </div>
      )}
      {state.status === 'error' && (
        <div className="flex items-center gap-1.5 py-2 text-[12px] text-amber-200/90">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
          {labels.tool.imageUnavailable}
        </div>
      )}
      {state.status === 'ready' && <img src={state.src} alt={image.name ?? labels.tool.imageOutput} className="max-h-[420px] w-full rounded object-contain" />}
    </div>
  )
})

export const ToolCallCard = memo(function ToolCallCard({ part, defaultOpen = false }: { part: ToolPartView; defaultOpen?: boolean }) {
  const { labels } = useChatUi()
  const [open, setOpen] = useState(defaultOpen)
  const output = part.output ? clipOutput(part.output) : ''
  const images = part.images ?? []
  return (
    <div className="min-w-0 max-w-full rounded-lg border border-border bg-white/[0.02] text-[13px]" data-tool-card={part.id}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <Wrench className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-mono text-foreground" title={part.toolName}>
          {part.toolName}
        </span>
        {part.summary && part.summary !== part.toolName && <span className="min-w-0 truncate text-muted-foreground">{part.summary}</span>}
        <span className="ml-auto flex items-center gap-2">
          {part.exitCode != null && part.exitCode !== 0 && (
            <span className="font-mono text-[11px] text-red-400" data-exit-code>
              {part.exitCode}
            </span>
          )}
          <StatusBadge state={part.state} />
        </span>
      </button>
      {open && (
        <div className="border-t border-border px-3 py-2">
          {part.input != null && (
            <>
              <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">{labels.tool.command}</div>
              <pre className="mb-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-2 font-mono text-[12px] text-foreground/90">
                {pretty(part.input)}
              </pre>
            </>
          )}
          {output && (
            <>
              <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">{labels.tool.output}</div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-2 font-mono text-[12px] text-foreground/90" data-tool-output>
                {output}
              </pre>
            </>
          )}
          {!!part.changes?.length && (
            <>
              <div className="mb-1 mt-2 text-[11px] uppercase tracking-wide text-muted-foreground">{labels.tool.changes}</div>
              <ul className="font-mono text-[12px] text-foreground/90">
                {part.changes.map((change) => (
                  <li key={`${change.kind}:${change.path}`}>
                    <span className="text-muted-foreground">{change.kind}</span> {change.path}
                  </li>
                ))}
              </ul>
            </>
          )}
          {images.length > 0 && (
            <div className="mt-2 flex flex-col gap-2">
              <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                <ImageIcon className="h-3.5 w-3.5" />
                {labels.tool.imageOutput}
              </div>
              {images.map((image) => (
                <ToolImagePreview key={image.id} image={image} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
})
