import { Mic, Square } from 'lucide-react'
import { Button } from '../../ui'
import { useT } from '../../i18n'

const clock = (ms: number) => {
  const total = Math.floor(ms / 1000)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/**
 * One button in the composer, and nothing else.
 *
 * Recording is the whole feature here: there is no menu of qualities, no choice of model and no
 * device picker. Those belong to a studio, not to a note somebody dictates on the way to a
 * meeting — and every extra control would be one more thing to get wrong before speaking.
 */
export function VoiceRecorder({
  recording,
  elapsedMs,
  disabled,
  unavailable,
  onStart,
  onStop,
}: {
  recording: boolean
  elapsedMs: number
  disabled: boolean
  /** This Host cannot transcribe; the button is absent rather than broken. */
  unavailable: boolean
  onStart: () => void
  onStop: () => void
}) {
  const t = useT()
  if (unavailable) return null
  if (recording)
    return (
      <Button className="voice-button recording" type="button" aria-label={t('voiceStop')} title={t('voiceStop')} onClick={onStop}>
        <Square size={14} aria-hidden="true" />
        <span aria-live="polite">{clock(elapsedMs)}</span>
      </Button>
    )
  return (
    <Button className="voice-button" type="button" aria-label={t('voiceRecord')} title={t('voiceRecord')} disabled={disabled} onClick={onStart}>
      <Mic size={18} aria-hidden="true" />
    </Button>
  )
}
