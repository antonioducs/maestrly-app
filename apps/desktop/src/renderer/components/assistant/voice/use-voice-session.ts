/**
 * Runs the assistant's voice in its window: the microphone with end-of-speech, transcription with the dictation
 * engine, the message sent through the composer, and the answer read aloud as it streams.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AssistantVoiceSettings } from '../../../../shared/assistant'
import { dictationLanguage } from '../../../../shared/asr'
import type { ChatStreamEvent } from '../../../../shared/chat'
import { LOCAL_HOST_ID } from '../../../../shared/host-key'
import type { SupportedLocale } from '../../../../shared/locale'
import { MIC_DEVICE_KEY, readLanguageMode } from '@/lib/dictation'
import { createEndOfSpeechDetector } from '@/lib/end-of-speech'
import { hostApi } from '@/lib/hosts/host-context'
import { type MicRecording, startMicRecording } from '@/lib/mic-recorder'
import { createSpeaker, type Speaker } from './speaker'
import { createVoiceMachine, type VoiceEffect, type VoiceEvent, type VoiceState, voiceReducer } from './voice-machine'

const NOTICE_MS = 6000

export interface VoiceSession {
  state: VoiceState
  /** The microphone's loudness while listening (RMS, 0–1). */
  level: number
  /** A notice code for `assistant.voice.notice.*`, shown until dismissed or for a few seconds. */
  notice: string | null
  tap(): void
  /** Stops listening and reading; false when there was nothing to stop. */
  escape(): boolean
  dismissNotice(): void
  /** The composer's way to send a message; it returns false when the message could not be sent. */
  setSubmit(submit: ((text: string) => boolean) | null): void
}

/** Which streamed answer the voice reads: the first that starts after the person's spoken message. */
interface Following {
  awaiting: boolean
  messageId: string | null
  partId: string | null
}

export function useVoiceSession(opts: {
  conversationId: string | null
  voice: AssistantVoiceSettings | null
  locale: SupportedLocale
}): VoiceSession {
  const { conversationId, voice, locale } = opts
  const [state, setState] = useState<VoiceState>('idle')
  const [level, setLevel] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const machine = useRef(createVoiceMachine({ locale, autoSpeak: voice?.autoSpeak ?? true }))
  const settings = useRef({ voice, locale })
  settings.current = { voice, locale }
  const submitRef = useRef<((text: string) => boolean) | null>(null)
  const recording = useRef<Promise<MicRecording> | null>(null)
  const micGeneration = useRef(0)
  const transcription = useRef(0)
  const speaker = useRef<{ key: string; speaker: Speaker } | null>(null)
  const following = useRef<Following>({ awaiting: false, messageId: null, partId: null })
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dispatchRef = useRef<(event: VoiceEvent) => void>(() => {})

  const showNotice = useCallback((code: string | null) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = code ? setTimeout(() => setNotice(null), NOTICE_MS) : null
    setNotice(code)
  }, [])

  /** The speaker for the current settings; a new one when the engine, voice or speed changed. */
  const currentSpeaker = useCallback((): Speaker => {
    const v = settings.current.voice
    const engine = v?.engine ?? 'system'
    const key = JSON.stringify([engine, v?.systemVoice ?? null, v?.speed ?? 1, settings.current.locale])
    if (speaker.current?.key === key) return speaker.current.speaker
    speaker.current?.speaker.dispose()
    const next = createSpeaker({
      engine,
      locale: settings.current.locale,
      systemVoice: v?.systemVoice ?? null,
      speed: v?.speed ?? 1,
      onIdle: () => dispatchRef.current({ type: 'speech-queue-empty' }),
      onError: (error) => dispatchRef.current({ type: 'speech-failed', error }),
    })
    speaker.current = { key, speaker: next }
    return next
  }, [])

  const transcribe = useCallback(async (pending: Promise<MicRecording>) => {
    const id = ++transcription.current
    const dispatch = (event: VoiceEvent) => {
      if (id === transcription.current) dispatchRef.current(event)
    }
    try {
      const pcm = await (await pending).stop()
      if (!pcm.length) return dispatch({ type: 'transcribe-failed', error: 'silent' })
      const language = dictationLanguage(readLanguageMode(localStorage), settings.current.locale)
      const result = await window.api.chatTranscribe(pcm, { language })
      if (result.text?.trim()) dispatch({ type: 'transcribed', text: result.text })
      else dispatch({ type: 'transcribe-failed', error: result.error ?? 'silent' })
    } catch {
      dispatch({ type: 'transcribe-failed', error: 'unavailable' })
    }
  }, [])

  const run = useCallback(
    (effect: VoiceEffect) => {
      if (effect === 'start-mic') {
        const generation = ++micGeneration.current
        const detector = createEndOfSpeechDetector()
        void window.api
          .chatDictationConfig()
          .then((config) => {
            if (config.engine === 'local') void window.api.chatAsrWarm().catch(() => false)
          })
          .catch(() => {})
        const pending = startMicRecording({
          deviceId: localStorage.getItem(MIC_DEVICE_KEY),
          onLevel: (rms, atMs) => {
            if (generation !== micGeneration.current) return
            setLevel(rms)
            const verdict = detector.feed(rms, atMs)
            if (verdict === 'end' || verdict === 'max') dispatchRef.current({ type: 'speech-end' })
            else if (verdict === 'no-speech') dispatchRef.current({ type: 'no-speech' })
          },
        })
        recording.current = pending
        pending.catch(() => {
          if (generation === micGeneration.current) dispatchRef.current({ type: 'mic-failed' })
        })
        return
      }
      if (effect === 'stop-mic' || effect === 'cancel-mic') {
        micGeneration.current++
        setLevel(0)
        const pending = recording.current
        recording.current = null
        if (effect === 'cancel-mic') transcription.current++
        if (!pending) return
        if (effect === 'stop-mic') void transcribe(pending)
        else void pending.then((rec) => rec.cancel()).catch(() => {})
        return
      }
      if (effect === 'stop-speaking') {
        following.current = { awaiting: false, messageId: null, partId: null }
        speaker.current?.speaker.stop()
        return
      }
      if ('submit' in effect) {
        following.current = { awaiting: true, messageId: null, partId: null }
        if (!submitRef.current?.(effect.submit)) dispatchRef.current({ type: 'turn-ended' })
        return
      }
      if ('speak' in effect) {
        currentSpeaker().speak(effect.speak)
        return
      }
      showNotice(effect.notice)
    },
    [currentSpeaker, showNotice, transcribe]
  )

  const dispatch = useCallback(
    (event: VoiceEvent) => {
      const before = { ...machine.current, ...settingsFor(settings.current) }
      const { next, effects } = voiceReducer(before, event)
      machine.current = next
      setState(next.state)
      if (event.type === 'tap' && before.state === 'idle') showNotice(null)
      for (const effect of effects) run(effect)
    },
    [run, showNotice]
  )
  dispatchRef.current = dispatch

  // The answer to the spoken message, as it streams.
  useEffect(() => {
    if (!conversationId) return
    return hostApi(LOCAL_HOST_ID).onChatStream(conversationId, (raw) => {
      const event = raw as ChatStreamEvent
      const follow = following.current
      if (event.kind === 'message-start') {
        if (follow.awaiting) following.current = { awaiting: false, messageId: event.messageId, partId: null }
        return
      }
      if (!follow.messageId) return
      if (event.kind === 'text-delta' && event.messageId === follow.messageId) {
        const gap = follow.partId && follow.partId !== event.partId ? '\n\n' : ''
        follow.partId = event.partId
        dispatchRef.current({ type: 'reply-delta', text: gap + event.delta })
      } else if (
        (event.kind === 'finish' || event.kind === 'aborted' || event.kind === 'error') &&
        (!event.messageId || event.messageId === follow.messageId)
      ) {
        following.current = { awaiting: false, messageId: null, partId: null }
        dispatchRef.current({ type: 'turn-ended' })
      }
    })
  }, [conversationId])

  // A new session (or leaving the window) stops the voice.
  useEffect(() => () => dispatchRef.current({ type: 'escape' }), [conversationId])

  useEffect(
    () => () => {
      speaker.current?.speaker.dispose()
      speaker.current = null
      if (noticeTimer.current) clearTimeout(noticeTimer.current)
    },
    []
  )

  // The window stays up while it listens or reads, even when it loses focus.
  useEffect(() => {
    window.api.assistantHold('listening', state === 'listening' || state === 'transcribing')
    window.api.assistantHold('speaking', state === 'speaking')
  }, [state])

  return {
    state,
    level,
    notice,
    tap: useCallback(() => dispatchRef.current({ type: 'tap' }), []),
    escape: useCallback(() => {
      if (machine.current.state === 'idle') return false
      dispatchRef.current({ type: 'escape' })
      return true
    }, []),
    dismissNotice: useCallback(() => showNotice(null), [showNotice]),
    setSubmit: useCallback((submit) => {
      submitRef.current = submit
    }, []),
  }
}

function settingsFor(current: { voice: AssistantVoiceSettings | null; locale: SupportedLocale }) {
  return { locale: current.locale, autoSpeak: current.voice?.autoSpeak ?? true }
}
