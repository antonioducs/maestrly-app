import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Mic, MicOff, Square, Volume2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { VoiceSession } from './use-voice-session'

/** The composer's voice button in the assistant window: tap to talk, tap again to stop listening or reading. */
export function VoiceButton({
  session,
  submitText,
  disabled,
}: {
  session: VoiceSession
  submitText: (text: string) => boolean
  disabled?: boolean
}) {
  const { t } = useTranslation('ui')
  const submit = useRef(submitText)
  submit.current = submitText
  const { setSubmit, state, level } = session

  useEffect(() => {
    setSubmit((text) => submit.current(text))
    return () => setSubmit(null)
  }, [setSubmit])

  const label = t(`assistant.voice.${state}`)
  const listening = state === 'listening'
  // The ring grows with the voice: quiet rooms sit near 0.01, speech around 0.05–0.2.
  const ring = listening ? Math.min(1, level * 8) : 0
  return (
    <button
      type="button"
      onClick={session.tap}
      disabled={disabled && state === 'idle'}
      title={label}
      aria-label={label}
      aria-pressed={state !== 'idle' && state !== 'error'}
      data-voice-state={state}
      className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground disabled:opacity-40',
        listening && 'bg-red-500/15 text-red-400 hover:bg-red-500/20 hover:text-red-300',
        state === 'speaking' && 'bg-primary/15 text-primary hover:bg-primary/20',
        state === 'error' && 'text-destructive'
      )}
      style={listening ? { boxShadow: `0 0 0 ${2 + ring * 6}px rgb(248 113 113 / ${0.12 + ring * 0.2})` } : undefined}
    >
      {state === 'transcribing' || state === 'thinking' ? (
        <Loader2 className="size-4 animate-spin" />
      ) : state === 'speaking' ? (
        <Volume2 className="size-4" />
      ) : listening ? (
        <Square className="size-3.5 fill-current" />
      ) : state === 'error' ? (
        <MicOff className="size-4" />
      ) : (
        <Mic className="size-4" />
      )}
    </button>
  )
}
