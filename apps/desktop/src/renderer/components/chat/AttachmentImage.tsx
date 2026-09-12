import { useEffect, useRef, useState } from 'react'
import type { MessagePart } from '../../../shared/chat'
import { IMAGE_OBJECT_URL_IDLE_MS } from '../../../shared/memory-policy'
import { bytesToObjectUrl, withImageFetchSlot } from '../../lib/binary-image'

export function AttachmentImage({
  part,
  conversationId,
  messageId,
  onOpenImage,
}: {
  part: Extract<MessagePart, { type: 'file' }>
  conversationId: string
  messageId: string
  onOpenImage?: (src: string, name: string) => void
}) {
  const [src, setSrc] = useState<string | null>(part.data?.startsWith('data:') ? part.data : (part.previewUrl ?? null))
  const [nearViewport, setNearViewport] = useState(false)
  const [failed, setFailed] = useState(false)
  const containerRef = useRef<HTMLSpanElement>(null)
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
    setFailed(false)
    if (part.data?.startsWith('data:')) {
      setSrc(part.data)
      return
    }

    if (part.previewUrl) {
      setSrc(part.previewUrl)
      return () => {
        if (part.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(part.previewUrl)
      }
    }
    if (!part.artifactId) {
      setSrc(null)
      return
    }
    if (!nearViewport) return

    setSrc(null)
    let active = true
    let objectUrl: string | null = null
    const controller = new AbortController()
    void withImageFetchSlot(() => window.api.chatAttachmentImage(conversationId, messageId, part.id), controller.signal)
      .then((result) => {
        if (!active) return
        if (!result.ok) {
          setFailed(true)
          return
        }
        objectUrl = bytesToObjectUrl(result.bytes, result.mediaType)
        setSrc(objectUrl)
      })
      .catch(() => {
        if (active) setFailed(true)
      })
    return () => {
      active = false
      controller.abort(new Error('Attachment image was unmounted.'))
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [conversationId, messageId, part.artifactId, part.data, part.id, part.previewUrl, nearViewport])

  if (!part.data?.startsWith('data:') && !part.previewUrl && !part.artifactId) return null
  if (failed) return null
  return (
    <span ref={containerRef} className="inline-flex">
      <button
        type="button"
        onClick={() => {
          if (src) onOpenImage?.(src, part.name)
        }}
        className="overflow-hidden rounded-lg border border-white/[0.08]"
      >
        {src ? (
          <img src={src} alt={part.name} className="h-20 w-20 object-cover" />
        ) : (
          <span className="block h-20 w-20" />
        )}
      </button>
    </span>
  )
}
