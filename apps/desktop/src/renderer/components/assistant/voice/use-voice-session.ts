/**
 * Runs the assistant's voice in its window: the microphone with end-of-speech, transcription with the dictation
 * engine, the message sent through the composer, and the answer read aloud as it streams.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AssistantVoiceSettings } from '../../../../shared/assistant'
import { dictationLanguage } from '../../../../shared/asr'
import type { ChatStreamEvent, PendingChatQuestion } from '../../../../shared/chat'
import { LOCAL_HOST_ID } from '../../../../shared/host-key'
import type { SupportedLocale } from '../../../../shared/locale'
import { MIC_DEVICE_KEY, readLanguageMode } from '@/lib/dictation'
import { createEndOfSpeechDetector } from '@/lib/end-of-speech'
import { hostApi } from '@/lib/hosts/host-context'
import { type MicRecording, startMicRecording } from '@/lib/mic-recorder'
import {
  type RealtimeClient,
  type RealtimeCloseReason,
  type RealtimeLevels,
  RealtimeStartError,
  type RealtimeState,
  type RealtimeTranscript,
  startRealtimeClient,
} from './realtime-client'
import { createSpeaker, type Speaker } from './speaker'
import {
  EMPTY_VOICE_ACTIVITY,
  endVoiceCall,
  newVoiceTurn,
  questionsSettled,
  startVoiceCall,
  type VoiceActivity,
  voiceActivityFromCall,
  voiceActivityFromChat,
} from './voice-activity'
import type { VoiceCaption } from './voice-caption'
import {
  createVoiceMachine,
  questionPrompt,
  type Translate,
  type VoiceEffect,
  type VoiceEvent,
  type VoiceState,
  voiceReducer,
} from './voice-machine'

const NOTICE_MS = 6000

/** The voice's state as the window shows it; `muted` only happens during a Realtime call. */
export type VoiceSessionState = VoiceState | 'muted'

/** How the last Realtime call ended, or the code of the error that kept it from starting. */
export interface VoiceCallEnd {
  reason: RealtimeCloseReason | 'mic' | 'key-missing' | 'key-rejected' | 'bad-offer'
  /** Null when it never connected. */
  startedAt: number | null
  endedAt: number
}

export interface VoiceSession {
  state: VoiceSessionState
  /** The mode in Settings: tap to talk with the assistant's agent, or a Realtime call. */
  mode: 'agent' | 'realtime'
  /** The Realtime call's own state while one is open, connecting included; null without one. */
  call: RealtimeState | null
  /** The microphone of the call is off. */
  muted: boolean
  /** The server hears the person during a call. */
  personSpeaking: boolean
  /** The microphone's loudness while listening (RMS, 0–1). */
  level: number
  /** Both loudnesses now, read on each frame by the voice screen without rendering. */
  levels(): RealtimeLevels
  /** When the open Realtime call started; null without one. */
  realtimeStartedAt: number | null
  /** What the person said last, or what the assistant is saying. */
  caption: VoiceCaption | null
  /** The tools that run for the person's request. */
  activity: VoiceActivity
  /** The first card in the conversation waiting for the person. */
  question: PendingChatQuestion | null
  /** How the last call ended, until another starts. */
  callEnd: VoiceCallEnd | null
  /** When the call closes for silence, during its last seconds; null otherwise. */
  idleClosesAt: number | null
  /** Answers are read aloud (agent mode). */
  reads: boolean
  /** A notice code for `assistant.voice.notice.*`, shown until dismissed or for a few seconds. */
  notice: string | null
  /** Starts or stops the voice; during a Realtime call, mutes or unmutes it, or interrupts it while it talks. */
  tap(): void
  setMuted(muted: boolean): void
  /** Stops the voice while it talks; the turn goes on. */
  interrupt(): void
  /** Keeps the call open: the silence starts over. */
  keepCall(): void
  /** Ends the Realtime call. */
  hangUp(): void
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
  const { t } = useTranslation('ui')
  const translate = useRef<Translate>(t)
  translate.current = t
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
  /** The cards waiting in the conversation, as last published. */
  const questions = useRef(new Set<string>())
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dispatchRef = useRef<(event: VoiceEvent) => void>(() => {})
  const [caption, setCaption] = useState<VoiceCaption | null>(null)
  const [activity, setActivity] = useState<VoiceActivity>(EMPTY_VOICE_ACTIVITY)
  const [question, setQuestion] = useState<PendingChatQuestion | null>(null)
  const micLevel = useRef(0)

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
      onSentence: (text, durationMs) =>
        setCaption({ who: 'voice', text, streaming: false, startedAt: Date.now(), durationMs, charIndex: null }),
      onBoundary: (charIndex) =>
        setCaption((current) => (current?.who === 'voice' ? { ...current, charIndex } : current)),
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
      const text = result.text?.trim()
      if (text && id === transcription.current)
        setCaption({ who: 'you', text, streaming: false, startedAt: Date.now(), durationMs: null, charIndex: null })
      if (text) dispatch({ type: 'transcribed', text })
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
        // A new turn of the person: the screen waits for their words.
        setCaption(null)
        const pending = startMicRecording({
          deviceId: localStorage.getItem(MIC_DEVICE_KEY),
          onLevel: (rms, atMs) => {
            if (generation !== micGeneration.current) return
            micLevel.current = rms
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
        micLevel.current = 0
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
        setActivity(newVoiceTurn)
        if (!submitRef.current?.(effect.submit)) dispatchRef.current({ type: 'turn-ended' })
        return
      }
      if ('speak' in effect) {
        currentSpeaker().speak(effect.speak)
        return
      }
      if ('answer' in effect) {
        hostApi(LOCAL_HOST_ID).chatQuestionRespond(effect.answer.toolCallId, [[effect.answer.label]])
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
      setActivity((current) => voiceActivityFromChat(current, event, Date.now()))
      if (event.kind === 'questions-pending') {
        setQuestion(event.questions[0] ?? null)
        if (!event.questions.length) setActivity((current) => questionsSettled(current, Date.now()))
        const known = questions.current
        const now = new Set(event.questions.map((pending) => pending.toolCallId))
        for (const id of known) if (!now.has(id)) dispatchRef.current({ type: 'question-gone', toolCallId: id })
        const fresh = event.questions.find((pending) => !known.has(pending.toolCallId))
        questions.current = now
        if (fresh) {
          const prompt = questionPrompt(fresh, translate.current, settings.current.locale)
          dispatchRef.current({
            type: 'question',
            toolCallId: fresh.toolCallId,
            retry: translate.current('assistant.voice.notUnderstood'),
            ...prompt,
          })
        }
        return
      }
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

  // A new session (or leaving the window) stops the voice and starts the screen over.
  useEffect(
    () => () => {
      dispatchRef.current({ type: 'escape' })
      questions.current = new Set()
      setCaption(null)
      setActivity(EMPTY_VOICE_ACTIVITY)
      setQuestion(null)
    },
    [conversationId]
  )

  // Realtime mode: a voice call with OpenAI, which hands requests to the assistant conversation.
  const realtime = useRef<RealtimeClient | null>(null)
  const connecting = useRef(false)
  const [realtimeState, setRealtimeState] = useState<RealtimeState | null>(null)
  const [realtimeStartedAt, setRealtimeStartedAt] = useState<number | null>(null)
  const callStartedAt = useRef<number | null>(null)
  const [muted, setMutedState] = useState(false)
  const [personSpeaking, setPersonSpeaking] = useState(false)
  const [callEnd, setCallEnd] = useState<VoiceCallEnd | null>(null)
  const [idleClosesAt, setIdleClosesAt] = useState<number | null>(null)
  const closeRealtime = useCallback(() => {
    realtime.current?.close()
    realtime.current = null
  }, [])
  /** The voice's answer on screen: its item, and when its first words came. */
  const voiceTurn = useRef<{ id: string; startedAt: number } | null>(null)
  /** The call's transcripts: the voice's words as it says them, and the person's once their turn is transcribed. */
  const onTranscript = useCallback((said: RealtimeTranscript) => {
    const now = Date.now()
    if (said.who === 'voice') {
      if (voiceTurn.current?.id !== said.id) voiceTurn.current = { id: said.id, startedAt: now }
      const startedAt = voiceTurn.current.startedAt
      setCaption({
        who: 'voice',
        text: said.text,
        streaming: !said.final,
        startedAt,
        durationMs: null,
        charIndex: null,
      })
      return
    }
    if (said.final) setActivity(newVoiceTurn)
    setCaption((current) =>
      // The voice already answers this turn: its words stay on screen, the person's are in the conversation.
      current?.who === 'voice' && current.startedAt > (said.turnEndedAt ?? 0)
        ? current
        : { who: 'you', text: said.text, streaming: !said.final, startedAt: now, durationMs: null, charIndex: null }
    )
  }, [])
  const tapRealtime = useCallback(() => {
    const client = realtime.current
    if (!client) {
      if (connecting.current) return
      connecting.current = true
      showNotice(null)
      setCallEnd(null)
      setCaption(null)
      setActivity(startVoiceCall)
      void startRealtimeClient({
        deviceId: localStorage.getItem(MIC_DEVICE_KEY),
        onState: setRealtimeState,
        onError: (code) => showNotice(`realtime-${code === 'network' ? 'network' : 'error'}`),
        onClosed: (reason) => {
          realtime.current = null
          setRealtimeState(null)
          setRealtimeStartedAt(null)
          setMutedState(false)
          setPersonSpeaking(false)
          setIdleClosesAt(null)
          setActivity((current) => endVoiceCall(current, Date.now()))
          setCallEnd({ reason, startedAt: callStartedAt.current, endedAt: Date.now() })
          callStartedAt.current = null
        },
        onTranscript,
        onTool: (event) => setActivity((current) => voiceActivityFromCall(current, event, Date.now())),
        onPersonSpeaking: setPersonSpeaking,
        onIdleWarning: setIdleClosesAt,
      })
        .then((started) => {
          realtime.current = started
          callStartedAt.current = started.startedAt
          setRealtimeStartedAt(started.startedAt)
        })
        .catch((error: unknown) => {
          const code = error instanceof RealtimeStartError ? error.code : 'network'
          setRealtimeState(null)
          setCallEnd({ reason: code as VoiceCallEnd['reason'], startedAt: null, endedAt: Date.now() })
          showNotice(`realtime-${code}`)
        })
        .finally(() => {
          connecting.current = false
        })
      return
    }
    if (realtimeState === 'speaking') client.interrupt()
    else {
      client.setMuted(!client.muted)
      setMutedState(client.muted)
    }
  }, [realtimeState, showNotice, onTranscript])
  useEffect(() => closeRealtime, [closeRealtime, conversationId])
  // Leaving Realtime mode in Settings ends the call.
  useEffect(() => {
    if (voice?.mode !== 'realtime') closeRealtime()
  }, [voice?.mode, closeRealtime])
  const realtimeMode = voice?.mode === 'realtime'
  const inCall = realtimeMode && realtimeState !== null
  const shownState: VoiceSessionState =
    inCall && realtimeState ? (realtimeState === 'connecting' ? 'thinking' : realtimeState) : state

  useEffect(
    () => () => {
      speaker.current?.speaker.dispose()
      speaker.current = null
      if (noticeTimer.current) clearTimeout(noticeTimer.current)
    },
    []
  )

  // The window stays up while it listens or reads, even when it loses focus; a call keeps it up until it ends.
  useEffect(() => {
    window.api.assistantHold('listening', inCall || shownState === 'listening' || shownState === 'transcribing')
    window.api.assistantHold('speaking', shownState === 'speaking')
  }, [inCall, shownState])

  const tapRef = useRef(tapRealtime)
  tapRef.current = tapRealtime
  const realtimeModeRef = useRef(realtimeMode)
  realtimeModeRef.current = realtimeMode
  return {
    state: shownState,
    mode: realtimeMode ? 'realtime' : 'agent',
    call: inCall ? realtimeState : null,
    muted: inCall && muted,
    personSpeaking: inCall && personSpeaking,
    level,
    levels: useCallback(() => {
      if (realtime.current) return realtime.current.levels()
      return { input: micLevel.current, output: speaker.current?.speaker.level() ?? 0 }
    }, []),
    notice,
    realtimeStartedAt,
    caption,
    activity,
    question,
    callEnd,
    idleClosesAt: inCall ? idleClosesAt : null,
    reads: voice?.autoSpeak ?? true,
    tap: useCallback(() => {
      if (realtimeModeRef.current) tapRef.current()
      else dispatchRef.current({ type: 'tap' })
    }, []),
    setMuted: useCallback((next: boolean) => {
      const client = realtime.current
      if (!client) return
      client.setMuted(next)
      setMutedState(client.muted)
    }, []),
    interrupt: useCallback(() => {
      if (realtime.current) realtime.current.interrupt()
      else if (machine.current.state === 'speaking') dispatchRef.current({ type: 'tap' })
    }, []),
    keepCall: useCallback(() => realtime.current?.keepAlive(), []),
    hangUp: closeRealtime,
    escape: useCallback(() => {
      if (realtime.current) {
        closeRealtime()
        return true
      }
      if (machine.current.state === 'idle') return false
      dispatchRef.current({ type: 'escape' })
      return true
    }, [closeRealtime]),
    dismissNotice: useCallback(() => showNotice(null), [showNotice]),
    setSubmit: useCallback((submit) => {
      submitRef.current = submit
    }, []),
  }
}

function settingsFor(current: { voice: AssistantVoiceSettings | null; locale: SupportedLocale }) {
  return { locale: current.locale, autoSpeak: current.voice?.autoSpeak ?? true }
}
