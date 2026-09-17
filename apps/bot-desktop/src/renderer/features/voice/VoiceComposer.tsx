import { useEffect, useState } from 'react'
import type { TargetRef } from '@maestrly/host-protocol'
import { VoiceDraftCard } from './VoiceDraft'
import { VoiceRecorder } from './VoiceRecorder'
import { useVoiceDraft } from './useVoiceDraft'
import { MicrophonePicker } from './MicrophonePicker'

/**
 * The voice half of the composer: one button, and one card while a note is in flight.
 *
 * Sending is always a separate, explicit press. A transcription that finished while the person
 * was reading something else does not type itself into the composer and does not go anywhere on
 * its own — which is the difference between a helpful feature and one that speaks for you.
 */
export function VoiceComposer({
  target,
  targetName,
  hostId,
  connected,
  supported,
  disabled,
  busy,
  onSent,
}: {
  target: TargetRef
  targetName: string
  hostId: string
  connected: boolean
  /** This Host cannot transcribe; the microphone is absent rather than broken. */
  supported: boolean
  disabled: boolean
  busy: boolean
  onSent: () => void | Promise<void>
}) {
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [deviceId, setDeviceId] = useState<string | undefined>()
  useEffect(() => {
    let alive = true
    window.bot
      .preferences()
      .then((preferences) => alive && setDeviceId(preferences.microphoneDeviceId))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  const chooseDevice = (next: string | undefined) => {
    setDeviceId(next)
    void window.bot.savePreferences({ microphoneDeviceId: next ?? null } as never).catch(() => {})
  }
  const voice = useVoiceDraft({
    target,
    hostId,
    api: { voice: window.bot.voice as never },
    newId: () => crypto.randomUUID(),
    deviceId,
    onDeviceLost: () => chooseDevice(undefined),
  })
  const draft = voice.draft
  const send = async () => {
    if (!draft?.clip || !draft.job || !draft.text.trim()) return
    setSending(true)
    setError('')
    try {
      await window.bot.voice.call({
        method: 'voice.send',
        params: {
          clipId: draft.clip.id,
          transcriptRevision: draft.job.transcriptRevision,
          editedText: draft.text.trim(),
          clientMessageId: crypto.randomUUID(),
        },
      })
      voice.discard()
      await onSent()
    } catch (failure) {
      // The draft survives a refusal: the person keeps the recording and decides what to do.
      setError(String(failure))
    } finally {
      setSending(false)
    }
  }
  return (
    <>
      {draft && (
        <VoiceDraftCard
          draft={draft}
          targetName={targetName}
          busy={sending || busy || !connected}
          onEdit={voice.edit}
          onSend={() => void send()}
          onDiscard={() => void voice.cancel()}
          onRetry={() => void voice.start()}
        />
      )}
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      <VoiceRecorder
        recording={draft?.stage === 'recording'}
        elapsedMs={draft?.elapsedMs ?? 0}
        disabled={disabled || busy || !connected || (!!draft && draft.stage !== 'idle' && draft.stage !== 'failed')}
        unavailable={!supported}
        onStart={() => void voice.start()}
        onStop={() => void voice.stop()}
      />
      {supported && <MicrophonePicker value={deviceId} onChange={chooseDevice} disabled={disabled || draft?.stage === 'recording'} />}
    </>
  )
}
