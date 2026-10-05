import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ImageOff, RotateCw } from 'lucide-react'
import type { FleetImageRef } from '@maestrly/bot-fleet-protocol'
import { ChatImageLightbox } from '@/components/chat/ChatImageLightbox'
import { holdFleetImage, type FleetImageCache } from '@/lib/fleet/image-cache'
import { isImageNotFound } from '@/lib/fleet/errors'

/** `tile`: a small square that opens the image. `large`: the image itself, for what the bot shared with the owner. */
type ImageSize = 'tile' | 'large'

function ImageTile({
  botId,
  image,
  cache,
  size,
}: {
  botId: string
  image: FleetImageRef
  cache: FleetImageCache
  size: ImageSize
}) {
  const { t } = useTranslation('fleet')
  const [url, setUrl] = useState<string | null>(null)
  // 'missing': the bot no longer has it (404). 'error': the load failed (bot restarting, network) and can be retried.
  const [failure, setFailure] = useState<'missing' | 'error' | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    setUrl(null)
    setFailure(null)
    return holdFleetImage(cache, botId, image.id, setUrl, (cause) =>
      setFailure(isImageNotFound(cause) ? 'missing' : 'error')
    )
  }, [botId, image.id, cache, attempt])
  if (failure)
    return (
      // Wider than a thumbnail so the explanation fits on two short lines.
      <div
        role="status"
        className="flex h-24 w-44 flex-col items-center justify-center gap-1.5 rounded-md border border-border bg-surface-elevated px-3 text-center text-[11px] leading-snug text-muted-foreground"
      >
        <ImageOff aria-hidden="true" className="size-4 shrink-0" />
        {failure === 'missing' ? t('transcript.imageUnavailable') : t('transcript.imageLoadFailed')}
        {failure === 'error' && (
          <button
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
            className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-foreground hover:bg-white/[0.06] focus-visible:outline-2 focus-visible:outline-primary"
          >
            <RotateCw aria-hidden="true" className="size-3" />
            {t('transcript.imageRetry')}
          </button>
        )}
      </div>
    )
  if (!url)
    return (
      <div
        className={
          size === 'large'
            ? 'h-48 w-72 max-w-full animate-pulse rounded-md bg-surface-elevated'
            : 'size-24 animate-pulse rounded-md bg-surface-elevated'
        }
      />
    )
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
          className={
            size === 'large'
              ? 'max-h-[420px] max-w-full rounded-md border border-border object-contain'
              : 'size-24 rounded-md border border-border object-cover'
          }
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
  size = 'tile',
}: {
  botId: string
  images: FleetImageRef[]
  cache: FleetImageCache
  size?: ImageSize
}) {
  if (!images.length) return null
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {images.map((image) => (
        <ImageTile key={image.id} botId={botId} image={image} cache={cache} size={size} />
      ))}
    </div>
  )
}
