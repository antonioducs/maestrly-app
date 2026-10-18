import Constants, { ExecutionEnvironment } from 'expo-constants'
import { getLocales } from 'expo-localization'
import { useCallback, useEffect, useRef, useState } from 'react'
import { DEMO_SERVER } from '../demo/demo-source'
import { useI18n } from '../i18n'
import { useServers } from '../servers/ServersProvider'
import { dictationEngine } from './engine'
import { effectiveDictationChoice } from './preference'
import { deleteRecording, readRecording, useDictationRecorder } from './recorder'
import { serverRecordingEngine } from './server-engine'
import {
  createDictation,
  createRecordedDictation,
  dictationLanguages,
  type Dictation,
  type DictationState,
} from './session'

const IDLE: DictationState = { phase: 'idle', issue: null }
/** Expo Go lacks the speech recognition module: there, the microphone says dictation needs the app's own build. */
const inExpoGo = () => Constants.executionEnvironment === ExecutionEnvironment.StoreClient
/** The server answers once its provider has; the provider itself gives up after 60 s. */
const TRANSCRIBE_TIMEOUT_MS = 75_000

/**
 * Dictation for one composer; `onText` receives what was heard once listening ends. It listens with the phone's
 * recognizer, or records for the bot server when the server can transcribe and this phone chose it to (see
 * `effectiveDictationChoice`).
 */
export function useDictation(onText: (text: string) => void) {
  const { preference } = useI18n()
  const { active, controller, dictation: serverDictation } = useServers()
  const latest = useRef(onText)
  latest.current = onText
  const dictation = useRef<Dictation | null>(null)
  const [state, setState] = useState<DictationState>(IDLE)
  const [phoneAvailable] = useState(() => dictationEngine.available())
  const recorder = useDictationRecorder()
  const choice = active
    ? effectiveDictationChoice(serverDictation.choice, {
        features: active.features,
        configured: serverDictation.status ? serverDictation.status.configured : null,
        demo: active.id === DEMO_SERVER.id,
      })
    : 'phone'
  const server = choice === 'server' && controller ? controller : null
  const available = server ? true : phoneAvailable
  const needsBuild = !available && inExpoGo()

  useEffect(() => {
    const created = server
      ? createRecordedDictation(
          serverRecordingEngine({
            recorder,
            transcribe: (body) => server.source.call('dictationTranscribe', { body, timeoutMs: TRANSCRIBE_TIMEOUT_MS }),
            readBase64: readRecording,
            deleteFile: deleteRecording,
          }),
          (text) => latest.current(text)
        )
      : createDictation(dictationEngine, (text) => latest.current(text))
    dictation.current = created
    setState(created.state())
    const unsubscribe = created.subscribe(setState)
    return () => {
      unsubscribe()
      created.dispose()
      if (dictation.current === created) dictation.current = null
    }
  }, [server, recorder])

  const start = useCallback(() => {
    const languages = getLocales().map((value) => value.languageTag)
    void dictation.current?.start(...dictationLanguages(languages, preference))
  }, [preference])
  const stop = useCallback(() => dictation.current?.stop(), [])
  const cancel = useCallback(() => dictation.current?.cancel(), [])
  const retry = useCallback(() => dictation.current?.retry(), [])
  const dismiss = useCallback(() => setState((current) => (current.phase === 'idle' ? IDLE : current)), [])

  return {
    state,
    available,
    needsBuild,
    engine: server ? ('server' as const) : ('phone' as const),
    start,
    stop,
    cancel,
    retry,
    dismiss,
  }
}
