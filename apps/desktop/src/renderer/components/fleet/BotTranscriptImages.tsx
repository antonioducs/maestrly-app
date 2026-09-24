import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FleetImageRef } from '@maestrly/bot-fleet-protocol'
import { ChatImageLightbox } from '@/components/chat/ChatImageLightbox'
import type { FleetImageCache } from '@/lib/fleet/image-cache'

function ImageTile({ botId, image, cache }: { botId: string; image: FleetImageRef; cache: FleetImageCache }) {
  const { t } = useTranslation('fleet')
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let active = true
    setUrl(null)
    setFailed(false)
    void cache
      .get(botId, image.id)
      .then((loaded) => {
        if (active) {
          cache.retain(botId, image.id)
          setUrl(loaded)
        }
      })
      .catch(() => {
        if (active) setFailed(true)
      })
    return () => {
      active = false
      cache.release(botId, image.id)
    }
  }, [botId, image.id, cache])
  if (failed)
    return (
      <div
        role="status"
        className="flex size-24 items-center justify-center rounded-md border border-border bg-surface-elevated p-2 text-center text-xs text-muted-foreground"
      >
        {t('transcript.imageUnavailable')}
      </div>
    )
  if (!url) return <div className="size-24 animate-pulse rounded-md bg-surface-elevated" />
  return (
    <>
      <button
        type="button"
        aria-label={t('transcript.openImage', { name: image.name ?? image.id })}
        onClick={() => setOpen(true)}
        className="rounded-md focus-visible:outline-2 focus-visible:outline-primary"
      >
        <img
          src={url}
          alt={image.name ?? t('transcript.image')}
          className="size-24 rounded-md border border-border object-cover"
        />
      </button>
      {open && <ChatImageLightbox src={url} name={image.name ?? image.id} onClose={() => setOpen(false)} />}
    </>
  )
}

export function BotTranscriptImages({
  botId,
  images,
  cache,
}: {
  botId: string
  images: FleetImageRef[]
  cache: FleetImageCache
}) {
  if (!images.length) return null
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {images.map((image) => (
        <ImageTile key={image.id} botId={botId} image={image} cache={cache} />
      ))}
    </div>
  )
}
