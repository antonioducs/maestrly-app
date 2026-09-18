import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Pause, Play } from 'lucide-react'
import type { VoiceMessageMeta } from '@maestrly/host-protocol'
import { Button } from '../../ui'
import { useT } from '../../i18n'
import { fromBase64 } from './pcm'

const clock = (ms: number) => {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/**
 * A sent voice note inside the conversation: playable, with its transcript one click away.
 *
 * The audio is fetched by clip identity when the person presses play, wrapped in a temporary
 * object URL and revoked as soon as this bubble goes away — there is no lasting handle to the
 * recording anywhere in the renderer. When the audio has expired or was removed, the message
 * says so plainly instead of offering a button that would fail.
 */
export function VoiceMessage({
  meta,
  read,
}: {
  meta: VoiceMessageMeta
  read: (clipId: string) => Promise<{ dataBase64: string }>
}) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const audio = useRef<HTMLAudioElement | undefined>(undefined)
  const url = useRef<string | undefined>(undefined)

  useEffect(
    () => () => {
      audio.current?.pause()
      if (url.current) URL.revokeObjectURL(url.current)
      url.current = undefined
      audio.current = undefined
    },
    []
  )

  const toggle = async () => {
    if (playing) {
      audio.current?.pause()
      setPlaying(false)
      return
    }
    try {
      if (!audio.current) {
        const { dataBase64 } = await read(meta.clipId)
        const bytes = fromBase64(dataBase64)
        url.current = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: 'audio/wav' }))
        audio.current = new Audio(url.current)
        audio.current.onended = () => setPlaying(false)
      }
      await audio.current.play()
      setPlaying(true)
    } catch {
      setError(t('voicePlaybackFailed'))
    }
  }

  return (
    <div className="voice-message">
      <div className="voice-row">
        {meta.audioAvailable ? (
          <Button type="button" aria-label={playing ? t('voicePause') : t('voicePlay')} onClick={() => void toggle()}>
            {playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
          </Button>
        ) : (
          <span className="voice-gone">{t('voiceAudioGone')}</span>
        )}
        <span className="voice-duration">{clock(meta.durationMs)}</span>
        <Button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
          {t('voiceTranscript')}
        </Button>
      </div>
      {expanded && (
        <div className="voice-transcript">
          <p>{meta.transcript}</p>
          {/* The person changed the machine's text before sending; both are kept. */}
          {meta.edited && <small>{t('voiceEdited')}</small>}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
