import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Mic, MicOff, PhoneOff, Square, Volume2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { VoiceSession } from './use-voice-session'

/**
 * The composer's voice button in the assistant window: tap to talk, tap again to stop listening or reading. During a
 * Realtime call the microphone stays open: a tap mutes or unmutes it, or interrupts the voice, and a button ends it.
 */
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

  const elapsed = useElapsed(session.realtimeStartedAt)
  const inCall = elapsed !== null
  const label = t(inCall ? `assistant.voice.call.${state}` : `assistant.voice.${state}`)
  const listening = state === 'listening'
  // The ring grows with the voice: quiet rooms sit near 0.01, speech around 0.05–0.2.
  const ring = listening ? Math.min(1, level * 8) : 0
  const button = (
    <button
      type="button"
      onClick={session.tap}
      disabled={disabled && state === 'idle'}
      title={label}
      aria-label={label}
      aria-pressed={state !== 'idle' && state !== 'error' && state !== 'muted'}
      data-voice-state={state}
      className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground disabled:opacity-40',
        listening && 'bg-red-500/15 text-red-400 hover:bg-red-500/20 hover:text-red-300',
        state === 'speaking' && 'bg-primary/15 text-primary hover:bg-primary/20',
        state === 'muted' && 'bg-white/[0.06]',
        state === 'error' && 'text-destructive'
      )}
      style={listening ? { boxShadow: `0 0 0 ${2 + ring * 6}px rgb(248 113 113 / ${0.12 + ring * 0.2})` } : undefined}
    >
      {state === 'transcribing' || state === 'thinking' ? (
        <Loader2 className="size-4 animate-spin" />
      ) : state === 'speaking' ? (
        <Volume2 className="size-4" />
      ) : listening && !inCall ? (
        <Square className="size-3.5 fill-current" />
      ) : state === 'error' || state === 'muted' ? (
        <MicOff className="size-4" />
      ) : (
        <Mic className="size-4" />
      )}
    </button>
  )
  if (!inCall) return button
  return (
    <div className="flex items-center gap-1.5">
      <span
        className="font-mono text-[11px] tabular-nums text-muted-foreground"
        title={t('assistant.voice.realtimeTimer')}
        aria-label={t('assistant.voice.realtimeTimer')}
      >
        {elapsed}
      </span>
      <button
        type="button"
        onClick={session.hangUp}
        title={t('assistant.voice.hangUp')}
        aria-label={t('assistant.voice.hangUp')}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-red-500/15 hover:text-red-400"
      >
        <PhoneOff className="size-4" />
      </button>
      {button}
    </div>
  )
}

/** Minutes and seconds since `startedAt`, ticking each second; null without a call. */
function useElapsed(startedAt: number | null): string | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt === null) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [startedAt])
  if (startedAt === null) return null
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
