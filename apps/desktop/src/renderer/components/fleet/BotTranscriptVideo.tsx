import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Film, Play, RotateCw, VideoOff } from 'lucide-react'
import type { FleetFileRef } from '@maestrly/bot-fleet-protocol'
import { ChatVideoLightbox } from '@/components/chat/ChatVideoLightbox'
import { fleetErrorMessage } from '@/lib/fleet/errors'
import { formatMediaTime } from '@/lib/media-time'
import type { FleetFileTransfer } from './BotTranscriptFiles'

type Phase =
  | { kind: 'waiting' }
  | { kind: 'loading'; progress: number | null }
  | { kind: 'ready'; url: string }
  /** `missing`: the bot no longer has it. `unsupported`: the server cannot send files. `undecodable`: no codec. */
  | { kind: 'failed'; reason: 'missing' | 'error' | 'unsupported' | 'undecodable' }

const frame = 'relative flex aspect-video w-full items-center justify-center bg-black/40'

/**
 * The first frame of a shared video, copied to this computer once it scrolls into view so the preview and the player
 * read it locally; clicking it opens the player.
 */
export function VideoPreview({
  botId,
  file,
  transfer,
}: {
  botId: string
  file: FleetFileRef
  transfer: FleetFileTransfer
}) {
  const { t } = useTranslation('fleet')
  const container = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const [visible, setVisible] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [phase, setPhase] = useState<Phase>({ kind: 'waiting' })
  const [duration, setDuration] = useState<number | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const element = container.current
    if (!element || visible) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisible(true)
      },
      { rootMargin: '400px 0px' }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [visible])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    setPhase({ kind: 'loading', progress: null })
    setDuration(null)
    const stop = window.api.onFleetMediaProgress((progress) => {
      if (cancelled || progress.botId !== botId || progress.fileId !== file.id || !progress.total) return
      setPhase((previous) =>
        previous.kind === 'loading' ? { kind: 'loading', progress: progress.received / progress.total } : previous
      )
    })
    window.api.fleetPrepareMedia(botId, file.id).then(
      (url) => {
        if (!cancelled) setPhase({ kind: 'ready', url })
      },
      (error: unknown) => {
        if (cancelled) return
        const message = fleetErrorMessage(error)
        setPhase({
          kind: 'failed',
          reason: message.includes('FLEET_FILE_NOT_FOUND')
            ? 'missing'
            : message.includes('FLEET_FILES_UNSUPPORTED')
              ? 'unsupported'
              : message.includes('FLEET_MEDIA_UNSUPPORTED')
                ? 'undecodable'
                : 'error',
        })
      }
    )
    return () => {
      cancelled = true
      stop()
    }
  }, [visible, botId, file.id, attempt])

  const close = () => {
    setOpen(false)
    opener.current?.focus()
  }

  if (phase.kind === 'failed')
    return (
      <div
        ref={container}
        role="status"
        className={`${frame} flex-col gap-1.5 px-6 text-center text-xs text-muted-foreground`}
      >
        <VideoOff aria-hidden="true" className="size-5 shrink-0" />
        {t(
          phase.reason === 'missing'
            ? 'transcript.videoUnavailable'
            : phase.reason === 'unsupported'
              ? 'files.updateRequired'
              : phase.reason === 'undecodable'
                ? 'transcript.videoUnsupported'
                : 'transcript.videoLoadFailed'
        )}
        {phase.reason === 'error' && (
          <button
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
            className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-foreground hover:bg-white/[0.06] focus-visible:outline-2 focus-visible:outline-primary"
          >
            <RotateCw aria-hidden="true" className="size-3" />
            {t('transcript.videoRetry')}
          </button>
        )}
      </div>
    )

  if (phase.kind !== 'ready') {
    const percent = phase.kind === 'loading' && phase.progress !== null ? Math.round(phase.progress * 100) : null
    return (
      <div ref={container} className={`${frame} flex-col gap-2 text-xs text-muted-foreground`}>
        <div
          aria-hidden="true"
          className="absolute inset-0 animate-pulse bg-surface-elevated motion-reduce:animate-none"
        />
        <Film aria-hidden="true" className="relative size-6" />
        {phase.kind === 'loading' && (
          <span className="relative">
            {percent === null ? t('transcript.videoPreparing') : t('transcript.videoPreparingProgress', { percent })}
          </span>
        )}
        {percent !== null && (
          <div
            role="progressbar"
            aria-label={t('transcript.videoPreparing')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="absolute inset-x-0 bottom-0 h-1 bg-white/10"
          >
            <div className="h-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
          </div>
        )}
      </div>
    )
  }

  return (
    <div ref={container} className={`${frame} bg-black`}>
      <video
        // The fragment shows the first frame instead of a black one; the URL itself never changes.
        src={`${phase.url}#t=0.1`}
        preload="metadata"
        muted
        playsInline
        disablePictureInPicture
        tabIndex={-1}
        aria-hidden="true"
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onError={() => setPhase({ kind: 'failed', reason: 'undecodable' })}
        className="size-full object-contain"
      />
      <button
        ref={opener}
        type="button"
        aria-label={t('transcript.playVideo', { name: file.name })}
        onClick={() => setOpen(true)}
        className="group absolute inset-0 flex items-center justify-center focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
      >
        <span className="flex size-12 items-center justify-center rounded-full bg-black/60 text-white shadow-lg transition-colors group-hover:bg-black/80">
          <Play aria-hidden="true" className="ml-0.5 size-5 fill-current" />
        </span>
      </button>
      {duration !== null && Number.isFinite(duration) && (
        <span className="pointer-events-none absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[11px] tabular-nums text-white">
          {formatMediaTime(duration)}
        </span>
      )}
      {open && (
        <ChatVideoLightbox
          src={phase.url}
          name={file.name}
          onClose={close}
          download={{
            state:
              transfer.state === 'downloading'
                ? 'downloading'
                : transfer.state === 'saved'
                  ? 'saved'
                  : transfer.state === 'idle'
                    ? 'idle'
                    : 'failed',
            onDownload: () => void transfer.download(),
          }}
        />
      )}
    </div>
  )
}
