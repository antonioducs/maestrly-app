import { useTranslation } from 'react-i18next'
import { useEffect, useRef, useState } from 'react'
import { ZoomIn, ZoomOut, RotateCcw, X, Maximize2 } from 'lucide-react'
import { renderMermaid, mermaidError } from '@/lib/mermaid'

export function MermaidBlock({ code }: { code: string }) {
  const { t } = useTranslation('ui')
  const [html, setHtml] = useState('')
  const [zoom, setZoom] = useState(false)
  useEffect(() => {
    let alive = true
    renderMermaid(code)
      .then((h) => alive && setHtml(h))
      .catch((e) => alive && setHtml(mermaidError(e)))
    return () => {
      alive = false
    }
  }, [code])
  if (!html)
    return <div className="mermaid-preview text-xs text-muted-foreground">{t('notesEditor.renderingDiagram')}</div>
  return (
    <>
      <div
        className="group/mermaid relative min-w-0 max-w-full cursor-zoom-in"
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setZoom(true)
          }
        }}
        title={t('mermaid.expand')}
        onClick={() => setZoom(true)}
      >
        <div dangerouslySetInnerHTML={{ __html: html }} />
        <span className="pointer-events-none absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-md bg-black/40 text-white opacity-0 transition-opacity group-hover/mermaid:opacity-100">
          <Maximize2 className="h-3.5 w-3.5" />
        </span>
      </div>
      {zoom && <MermaidZoom code={code} onClose={() => setZoom(false)} />}
    </>
  )
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

function MermaidZoom({ code, onClose }: { code: string; onClose: () => void }) {
  const { t } = useTranslation('ui')
  const [html, setHtml] = useState('')
  const [scale, setScale] = useState(1)
  const [off, setOff] = useState({ x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number } | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    renderMermaid(code)
      .then((h) => alive && setHtml(h))
      .catch((e) => alive && setHtml(mermaidError(e)))
    return () => {
      alive = false
    }
  }, [code])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setScale((s) => clamp(s * (e.deltaY < 0 ? 1.12 : 0.89), 0.3, 8))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const reset = () => {
    setScale(1)
    setOff({ x: 0, y: 0 })
  }

  return (
    <div
      className="no-drag fixed inset-0 z-[100] flex items-center justify-center bg-black/80"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t('notesEditor.diagramMermaid')}
    >
      <div className="absolute right-4 top-14 z-[120] flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={() => setScale((s) => clamp(s * 0.83, 0.3, 8))}
          title={t('mermaid.zoomOut')}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
        >
          <ZoomOut className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => setScale((s) => clamp(s * 1.2, 0.3, 8))}
          title={t('mermaid.zoomIn')}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
        >
          <ZoomIn className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={reset}
          title={t('mermaid.reset')}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
        >
          <RotateCcw className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onClose}
          title={t('mermaid.close')}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div
        ref={stageRef}
        className="absolute inset-0 flex items-center justify-center overflow-hidden"
        style={{ cursor: drag.current ? 'grabbing' : 'grab' }}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => {
          drag.current = { x: e.clientX - off.x, y: e.clientY - off.y }
          ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (drag.current) setOff({ x: e.clientX - drag.current.x, y: e.clientY - drag.current.y })
        }}
        onPointerUp={() => (drag.current = null)}
      >
        {html ? (
          // The fixed-size zoom stage lets the SVG scale to fit its viewBox.

          <div
            className="mermaid-zoom-stage origin-center"
            style={{ transform: `translate(${off.x}px, ${off.y}px) scale(${scale})` }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <div className="text-sm text-white/60">{t('notesEditor.renderingDiagram')}</div>
        )}
      </div>
    </div>
  )
}
