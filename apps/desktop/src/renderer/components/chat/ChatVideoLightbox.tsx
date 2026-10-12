import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Check,
  Download,
  Loader2,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCw,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { useChatDocument } from '@/lib/chat-window-context'
import { formatMediaTime } from '@/lib/media-time'
import { cn } from '@/lib/utils'

export const VIDEO_PLAYBACK_RATES = [0.5, 1, 1.25, 1.5, 2] as const

export type ChatVideoDownload = {
  state: 'idle' | 'downloading' | 'saved' | 'failed'
  onDownload: () => void
}

// The next video opens with the speed and volume the owner last chose.
let preferredRate = 1
let preferredVolume = 1
let preferredMuted = false

const roundButton =
  'flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-primary aria-disabled:cursor-wait aria-disabled:opacity-60'
const barButton =
  'flex h-8 min-w-8 shrink-0 items-center justify-center rounded-md px-1.5 text-white/90 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-primary'

function MediaSlider({
  label,
  value,
  max,
  buffered,
  valueText,
  step,
  bigStep,
  disabled,
  onChange,
  className,
}: {
  label: string
  value: number
  max: number
  buffered?: number
  valueText: string
  step: number
  bigStep: number
  disabled?: boolean
  onChange: (value: number) => void
  className?: string
}) {
  const track = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0
  const bufferedRatio = max > 0 && buffered !== undefined ? Math.min(1, Math.max(0, buffered / max)) : 0
  const valueAt = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return value
    return (Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * max) as number
  }
  const set = (next: number) => onChange(Math.min(max, Math.max(0, next)))
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return
    event.preventDefault()
    event.currentTarget.focus()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragging.current = true
    set(valueAt(event.clientX))
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) set(valueAt(event.clientX))
  }
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    dragging.current = false
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || event.metaKey || event.ctrlKey || event.altKey) return
    const next =
      event.key === 'ArrowLeft' || event.key === 'ArrowDown'
        ? value - step
        : event.key === 'ArrowRight' || event.key === 'ArrowUp'
          ? value + step
          : event.key === 'PageDown'
            ? value - bigStep
            : event.key === 'PageUp'
              ? value + bigStep
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? max
                  : null
    if (next === null) return
    event.preventDefault()
    event.stopPropagation()
    set(next)
  }
  return (
    <div
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={valueText}
      aria-disabled={disabled || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      className={cn(
        'group relative flex h-4 cursor-pointer touch-none items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
        disabled && 'cursor-default opacity-50',
        className
      )}
    >
      <div ref={track} className="relative h-1 w-full rounded-full bg-white/20 transition-[height] group-hover:h-1.5">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-white/35"
          style={{ width: `${bufferedRatio * 100}%` }}
        />
        <div className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${ratio * 100}%` }} />
      </div>
      <div
        aria-hidden="true"
        className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 scale-0 rounded-full bg-white shadow transition-transform group-hover:scale-100 group-focus-visible:scale-100"
        style={{ left: `${ratio * 100}%` }}
      />
    </div>
  )
}

function SpeedMenu({
  rate,
  onRate,
  open,
  onOpenChange,
}: {
  rate: number
  onRate: (rate: number) => void
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation('chat')
  const ownerDocument = useChatDocument()
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const items = () => Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])
  const label = (value: number) => (value === 1 ? t('videoPlayer.normalSpeed') : t('videoPlayer.rate', { rate: value }))

  useEffect(() => {
    if (!open) return
    items()
      .find((item) => item.getAttribute('aria-checked') === 'true')
      ?.focus()
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target as Node
      if (!menu.current?.contains(target) && !trigger.current?.contains(target)) onOpenChange(false)
    }
    ownerDocument.addEventListener('pointerdown', onPointerDown, true)
    return () => ownerDocument.removeEventListener('pointerdown', onPointerDown, true)
  }, [open, ownerDocument, onOpenChange])

  const close = (refocus: boolean) => {
    onOpenChange(false)
    if (refocus) trigger.current?.focus()
  }
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = items()
    const index = list.indexOf(ownerDocument.activeElement as HTMLButtonElement)
    const move = (next: number) => list[(next + list.length) % list.length]?.focus()
    if (event.key === 'ArrowDown') move(index + 1)
    else if (event.key === 'ArrowUp') move(index - 1)
    else if (event.key === 'Home') move(0)
    else if (event.key === 'End') move(list.length - 1)
    else if (event.key === 'Escape') close(true)
    else if (event.key === 'Tab') {
      close(false)
      return
    } else return
    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <div className="relative">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('videoPlayer.speed')}
        title={t('videoPlayer.speed')}
        onClick={() => onOpenChange(!open)}
        className={cn(barButton, 'w-12 text-xs font-medium tabular-nums')}
      >
        {t('videoPlayer.rate', { rate })}
      </button>
      {open && (
        <div
          ref={menu}
          role="menu"
          aria-label={t('videoPlayer.speed')}
          onKeyDown={onMenuKeyDown}
          className="absolute bottom-full right-0 z-10 mb-2 min-w-[8rem] rounded-md border border-white/10 bg-neutral-900/95 p-1 text-sm text-white shadow-lg"
        >
          {[...VIDEO_PLAYBACK_RATES].reverse().map((value) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={value === rate}
              tabIndex={-1}
              onClick={() => {
                onRate(value)
                close(true)
              }}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left outline-none hover:bg-white/10 focus:bg-white/10"
            >
              <Check aria-hidden="true" className={cn('size-3.5 shrink-0', value !== rate && 'invisible')} />
              <span className="tabular-nums">{label(value)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * A video in a lightbox, like `ChatImageLightbox`, with the app's own controls: play, seek, speed, volume and full
 * screen, all reachable from the keyboard (Space/K, ←/→, J/L, M, F, </>, Esc).
 */
export function ChatVideoLightbox({
  src,
  name,
  onClose,
  download,
}: {
  src: string
  name: string
  onClose: () => void
  download?: ChatVideoDownload
}) {
  const { t } = useTranslation('chat')
  const ownerDocument = useChatDocument()
  const root = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const playButton = useRef<HTMLButtonElement>(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(Number.NaN)
  const [buffered, setBuffered] = useState(0)
  const [volume, setVolume] = useState(preferredVolume)
  const [muted, setMuted] = useState(preferredMuted)
  const [rate, setRate] = useState(preferredRate)
  const [waiting, setWaiting] = useState(false)
  const [failure, setFailure] = useState<'unsupported' | 'network' | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const seekable = Number.isFinite(duration) && duration > 0

  useEffect(() => {
    playButton.current?.focus()
  }, [])

  useEffect(() => {
    const element = video.current
    if (!element) return
    element.volume = preferredVolume
    element.muted = preferredMuted
    element.playbackRate = preferredRate
  }, [])

  // Time updates arrive four times a second; follow the frame while playing so the bar moves smoothly.
  useEffect(() => {
    if (!playing) return
    const view = ownerDocument.defaultView ?? window
    let frame = 0
    const tick = () => {
      if (video.current) setCurrent(video.current.currentTime)
      frame = view.requestAnimationFrame(tick)
    }
    frame = view.requestAnimationFrame(tick)
    return () => view.cancelAnimationFrame(frame)
  }, [playing, ownerDocument])

  useEffect(() => {
    const element = stage.current
    const onChange = () => setFullscreen(ownerDocument.fullscreenElement === element)
    ownerDocument.addEventListener('fullscreenchange', onChange)
    return () => {
      ownerDocument.removeEventListener('fullscreenchange', onChange)
      if (element && ownerDocument.fullscreenElement === element)
        void ownerDocument.exitFullscreen().catch(() => undefined)
    }
  }, [ownerDocument])

  const updateBuffered = () => {
    const element = video.current
    if (!element) return
    const ranges = element.buffered
    let end = 0
    for (let index = 0; index < ranges.length; index++) {
      if (ranges.start(index) <= element.currentTime + 0.5) end = Math.max(end, ranges.end(index))
    }
    setBuffered(end)
  }

  const toggle = useCallback(() => {
    const element = video.current
    if (!element || failure) return
    if (element.paused || element.ended) void element.play().catch(() => undefined)
    else element.pause()
  }, [failure])

  const seekTo = useCallback((time: number) => {
    const element = video.current
    if (!element || !Number.isFinite(element.duration)) return
    element.currentTime = Math.min(element.duration, Math.max(0, time))
    setCurrent(element.currentTime)
  }, [])

  const seekBy = useCallback((delta: number) => seekTo((video.current?.currentTime ?? 0) + delta), [seekTo])

  const changeRate = useCallback((next: number) => {
    preferredRate = next
    setRate(next)
    if (video.current) video.current.playbackRate = next
  }, [])

  const stepRate = (direction: 1 | -1) => {
    const next =
      direction > 0
        ? VIDEO_PLAYBACK_RATES.find((value) => value > rate)
        : [...VIDEO_PLAYBACK_RATES].reverse().find((value) => value < rate)
    if (next !== undefined) changeRate(next)
  }

  const changeVolume = (next: number) => {
    const element = video.current
    if (!element) return
    element.volume = next
    element.muted = next === 0
  }

  const toggleMute = () => {
    const element = video.current
    if (!element) return
    if (element.muted || element.volume === 0) {
      element.muted = false
      if (element.volume === 0) element.volume = 0.5
    } else element.muted = true
  }

  const toggleFullscreen = () => {
    if (ownerDocument.fullscreenElement) void ownerDocument.exitFullscreen().catch(() => undefined)
    else void stage.current?.requestFullscreen().catch(() => undefined)
  }

  const retry = () => {
    setFailure(null)
    video.current?.load()
  }

  const trapFocus = (event: globalThis.KeyboardEvent) => {
    const focusable = Array.from(
      root.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]):not([tabindex="-1"]), [role="slider"][tabindex="0"]'
      ) ?? []
    )
    if (!focusable.length) return
    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!
    const active = ownerDocument.activeElement
    if (event.shiftKey && (active === first || !root.current?.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || !root.current?.contains(active))) {
      event.preventDefault()
      first.focus()
    }
  }

  const onKeyDown = (event: globalThis.KeyboardEvent) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
    const onButton = event.target instanceof Element && event.target.closest('button')
    let handled = true
    switch (event.key) {
      case 'Tab':
        trapFocus(event)
        return
      case 'Escape':
        if (menuOpen) setMenuOpen(false)
        // The first Escape leaves full screen, as everywhere else; the next one closes the player.
        else if (ownerDocument.fullscreenElement) void ownerDocument.exitFullscreen().catch(() => undefined)
        else onClose()
        break
      case ' ':
        if (onButton) return
        toggle()
        break
      case 'k':
      case 'K':
        toggle()
        break
      case 'ArrowLeft':
        seekBy(-5)
        break
      case 'ArrowRight':
        seekBy(5)
        break
      case 'j':
      case 'J':
        seekBy(-10)
        break
      case 'l':
      case 'L':
        seekBy(10)
        break
      case 'm':
      case 'M':
        toggleMute()
        break
      case 'f':
      case 'F':
        toggleFullscreen()
        break
      case '<':
        stepRate(-1)
        break
      case '>':
        stepRate(1)
        break
      default:
        handled = false
    }
    if (handled) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  // On the document, like the image lightbox: a button that disables itself must not take the shortcuts with it.
  const keyHandler = useRef(onKeyDown)
  keyHandler.current = onKeyDown
  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) => keyHandler.current(event)
    ownerDocument.addEventListener('keydown', listener)
    return () => ownerDocument.removeEventListener('keydown', listener)
  }, [ownerDocument])

  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2
  const time = t('videoPlayer.timeOf', { current: formatMediaTime(current), duration: formatMediaTime(duration) })

  return (
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label={name}
      tabIndex={-1}
      onClick={(event) => {
        event.stopPropagation()
        onClose()
      }}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-8 outline-none"
    >
      <div className="absolute right-4 top-4 flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
        {download && (
          <button
            type="button"
            onClick={() => {
              if (download.state !== 'downloading') download.onDownload()
            }}
            // Not `disabled`: the button keeps focus, and with it the player's keyboard, while the file is saved.
            aria-disabled={download.state === 'downloading' || undefined}
            aria-label={t(
              download.state === 'downloading'
                ? 'videoPlayer.downloading'
                : download.state === 'saved'
                  ? 'videoPlayer.downloaded'
                  : 'videoPlayer.download'
            )}
            title={t(
              download.state === 'downloading'
                ? 'videoPlayer.downloading'
                : download.state === 'saved'
                  ? 'videoPlayer.downloaded'
                  : 'videoPlayer.download'
            )}
            className={roundButton}
          >
            {download.state === 'downloading' ? (
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : download.state === 'saved' ? (
              <Check aria-hidden="true" className="h-4 w-4" />
            ) : (
              <Download aria-hidden="true" className="h-4 w-4" />
            )}
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label={t('videoPlayer.close')}
          title={t('videoPlayer.close')}
          className={roundButton}
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>
      <div
        ref={stage}
        onClick={(event) => event.stopPropagation()}
        className={cn(
          'flex flex-col overflow-hidden bg-black',
          fullscreen ? 'h-full w-full' : 'max-h-full w-full max-w-5xl rounded-lg shadow-2xl'
        )}
      >
        <div className={cn('relative flex min-h-0 items-center justify-center', fullscreen && 'flex-1')}>
          {/* Keyboard users play and pause with the controls below; the picture repeats that for the mouse. */}
          <video
            ref={video}
            src={src}
            autoPlay
            playsInline
            disablePictureInPicture
            preload="auto"
            onClick={toggle}
            onDoubleClick={toggleFullscreen}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onWaiting={() => setWaiting(true)}
            onPlaying={() => setWaiting(false)}
            onCanPlay={() => setWaiting(false)}
            onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
            onDurationChange={(event) => setDuration(event.currentTarget.duration)}
            onTimeUpdate={(event) => {
              setCurrent(event.currentTarget.currentTime)
              updateBuffered()
            }}
            onProgress={updateBuffered}
            onSeeked={updateBuffered}
            onVolumeChange={(event) => {
              preferredVolume = event.currentTarget.volume
              preferredMuted = event.currentTarget.muted
              setVolume(event.currentTarget.volume)
              setMuted(event.currentTarget.muted)
            }}
            onRateChange={(event) => setRate(event.currentTarget.playbackRate)}
            onError={(event) => {
              const code = event.currentTarget.error?.code
              setWaiting(false)
              setPlaying(false)
              setFailure(code === MediaError.MEDIA_ERR_NETWORK ? 'network' : 'unsupported')
            }}
            className={cn(
              'w-full cursor-pointer bg-black object-contain',
              fullscreen ? 'h-full' : 'max-h-[calc(100vh-10rem)] min-h-[12rem]'
            )}
          />
          {waiting && !failure && (
            <Loader2
              aria-hidden="true"
              className="pointer-events-none absolute size-8 animate-spin text-white/80 motion-reduce:animate-none"
            />
          )}
          {failure && (
            <div
              role="alert"
              className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 px-8 text-center text-sm text-white"
            >
              <p>{t(failure === 'network' ? 'videoPlayer.loadFailed' : 'videoPlayer.unsupported')}</p>
              <div className="flex gap-2">
                {failure === 'network' && (
                  <button
                    type="button"
                    onClick={retry}
                    className="inline-flex items-center gap-1.5 rounded-md bg-white/10 px-3 py-1.5 hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-primary"
                  >
                    <RotateCw aria-hidden="true" className="size-3.5" />
                    {t('videoPlayer.retry')}
                  </button>
                )}
                {download && failure === 'unsupported' && (
                  <button
                    type="button"
                    onClick={() => {
                      if (download.state !== 'downloading') download.onDownload()
                    }}
                    aria-disabled={download.state === 'downloading' || undefined}
                    className="inline-flex items-center gap-1.5 rounded-md bg-white/10 px-3 py-1.5 hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-primary aria-disabled:cursor-wait aria-disabled:opacity-60"
                  >
                    <Download aria-hidden="true" className="size-3.5" />
                    {t(download.state === 'saved' ? 'videoPlayer.downloaded' : 'videoPlayer.download')}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col gap-1 bg-neutral-950 px-3 pb-2 pt-2 text-white">
          <MediaSlider
            label={t('videoPlayer.seek')}
            value={seekable ? current : 0}
            max={seekable ? duration : 0}
            buffered={buffered}
            valueText={time}
            step={5}
            bigStep={10}
            disabled={!seekable || failure !== null}
            onChange={seekTo}
          />
          <div className="flex items-center gap-1">
            <button
              ref={playButton}
              type="button"
              onClick={toggle}
              disabled={failure !== null}
              aria-label={t(playing ? 'videoPlayer.pause' : 'videoPlayer.play')}
              title={t(playing ? 'videoPlayer.pauseHint' : 'videoPlayer.playHint')}
              className={cn(barButton, 'disabled:opacity-50')}
            >
              {playing ? (
                <Pause aria-hidden="true" className="size-4 fill-current" />
              ) : (
                <Play aria-hidden="true" className="size-4 fill-current" />
              )}
            </button>
            <button
              type="button"
              onClick={toggleMute}
              aria-label={t(muted || volume === 0 ? 'videoPlayer.unmute' : 'videoPlayer.mute')}
              title={t(muted || volume === 0 ? 'videoPlayer.unmuteHint' : 'videoPlayer.muteHint')}
              className={barButton}
            >
              <VolumeIcon aria-hidden="true" className="size-4" />
            </button>
            <MediaSlider
              label={t('videoPlayer.volume')}
              value={muted ? 0 : Math.round(volume * 100)}
              max={100}
              valueText={`${muted ? 0 : Math.round(volume * 100)}%`}
              step={5}
              bigStep={20}
              onChange={(next) => changeVolume(next / 100)}
              className="w-20"
            />
            <span className="ml-2 select-none text-xs tabular-nums text-white/80" aria-hidden="true">
              {formatMediaTime(current)} / {formatMediaTime(duration)}
            </span>
            <div className="flex-1" />
            <SpeedMenu rate={rate} onRate={changeRate} open={menuOpen} onOpenChange={setMenuOpen} />
            <button
              type="button"
              onClick={toggleFullscreen}
              aria-label={t(fullscreen ? 'videoPlayer.exitFullscreen' : 'videoPlayer.fullscreen')}
              title={t(fullscreen ? 'videoPlayer.exitFullscreenHint' : 'videoPlayer.fullscreenHint')}
              className={barButton}
            >
              {fullscreen ? (
                <Minimize aria-hidden="true" className="size-4" />
              ) : (
                <Maximize aria-hidden="true" className="size-4" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
