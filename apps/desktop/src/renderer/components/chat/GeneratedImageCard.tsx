import { memo, useEffect, useRef, useState } from 'react'
import { IMAGE_OBJECT_URL_IDLE_MS } from '../../../shared/memory-policy'
import { useTranslation } from 'react-i18next'
import { Download, ImageIcon, Loader2, TriangleAlert } from 'lucide-react'
import type { MessagePart } from '../../../shared/chat'
import { imageResultToObjectUrl, withImageFetchSlot } from '../../lib/binary-image'

type GeneratedImagePart = Extract<MessagePart, { type: 'generated-image' }>

type GeneratedImageView = { ok: true; src: string } | { ok: false; error: 'not-found' | 'unreadable' | 'invalid' }

export const GeneratedImageCard = memo(function GeneratedImageCard({
  part,
  conversationId,
  messageId,
  onOpenImage,
}: {
  part: GeneratedImagePart
  conversationId: string
  messageId: string
  onOpenImage?: (src: string, name: string) => void
}) {
  const { t } = useTranslation('chat')
  const containerRef = useRef<HTMLDivElement>(null)
  const [nearViewport, setNearViewport] = useState(false)
  const [result, setResult] = useState<GeneratedImageView | null>(null)
  const awayTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((entry) => entry.isIntersecting)
        if (visible) {
          if (awayTimer.current) clearTimeout(awayTimer.current)
          awayTimer.current = null
          setNearViewport(true)
        } else {
          awayTimer.current = setTimeout(() => setNearViewport(false), IMAGE_OBJECT_URL_IDLE_MS)
        }
      },
      { rootMargin: '600px 0px' }
    )
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (awayTimer.current) clearTimeout(awayTimer.current)
    }
  }, [])

  useEffect(() => {
    if (!nearViewport) return
    let active = true
    let objectUrl: string | null = null
    const controller = new AbortController()
    setResult(null)
    void withImageFetchSlot(() => window.api.chatGeneratedImage(conversationId, messageId, part.id), controller.signal)
      .then((next) => {
        if (!active) return
        if (!next.ok) {
          setResult(next)
          return
        }
        objectUrl = imageResultToObjectUrl(next)
        setResult({ ok: true, src: objectUrl })
      })
      .catch(() => {
        if (active) setResult({ ok: false, error: 'unreadable' })
      })
    return () => {
      active = false
      controller.abort(new Error('Generated image card was unmounted.'))
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [nearViewport, conversationId, messageId, part.id, part.artifactId])

  const revised = part.revisedPrompt?.trim()

  return (
    <div
      ref={containerRef}
      className="flex min-w-0 max-w-full flex-col gap-2 rounded-lg border border-border bg-white/[0.02] p-3 text-[13px]"
    >
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <ImageIcon className="h-3.5 w-3.5 shrink-0" />
        <span>{t('generatedImage.title')}</span>
        <span className="min-w-0 truncate text-muted-foreground/70">{part.name}</span>
      </div>

      {result === null && (
        <div className="flex items-center gap-2 py-4 text-[12px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('generatedImage.loading')}
        </div>
      )}

      {result?.ok === false && (
        <div className="flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/[0.08] px-2.5 py-1.5 text-[12px] text-amber-200/90">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
          {t(`generatedImage.${result.error === 'not-found' ? 'notFound' : result.error}`)}
        </div>
      )}

      {result?.ok === true && (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => {
              onOpenImage?.(result.src, part.name)
            }}
            title={t('messages.enlarge', { name: part.name })}
            className="overflow-hidden rounded-lg border border-white/[0.08] transition-opacity hover:opacity-90"
          >
            <img src={result.src} alt={part.name} className="max-h-[420px] w-full object-contain" />
          </button>
          <a
            href={result.src}
            download={part.name}
            title={t('generatedImage.download')}
            className="inline-flex w-fit items-center gap-1.5 rounded-md border border-white/10 px-2 py-1 text-[11px] text-muted-foreground hover:bg-white/5 hover:text-foreground"
          >
            <Download className="h-3 w-3" />
            {t('generatedImage.download')}
          </a>
        </div>
      )}

      {revised && (
        <details className="text-[12px] text-muted-foreground">
          <summary className="cursor-pointer select-none hover:text-foreground">
            {t('generatedImage.revisedPrompt')}
          </summary>
          <p className="mt-1 whitespace-pre-wrap">{revised}</p>
        </details>
      )}
    </div>
  )
})
