import Constants, { ExecutionEnvironment } from 'expo-constants'
import { getLocales } from 'expo-localization'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { speechEngine } from './engine'
import { createDictation, dictationLanguages, type Dictation, type DictationState } from './session'

const IDLE: DictationState = { phase: 'idle', issue: null }
/** Expo Go lacks the speech recognition module: there, the microphone says dictation needs the app's own build. */
const inExpoGo = () => Constants.executionEnvironment === ExecutionEnvironment.StoreClient

/** Dictation for one composer; `onText` receives what was heard once listening ends. */
export function useDictation(onText: (text: string) => void) {
  const { preference } = useI18n()
  const latest = useRef(onText)
  latest.current = onText
  const dictation = useRef<Dictation | null>(null)
  const [state, setState] = useState<DictationState>(IDLE)
  const [available] = useState(() => speechEngine.available())
  const [needsBuild] = useState(() => !available && inExpoGo())

  useEffect(() => {
    const created = createDictation(speechEngine, (text) => latest.current(text))
    dictation.current = created
    const unsubscribe = created.subscribe(setState)
    return () => {
      unsubscribe()
      created.dispose()
      dictation.current = null
    }
  }, [])

  const start = useCallback(() => {
    const languages = getLocales().map((value) => value.languageTag)
    void dictation.current?.start(...dictationLanguages(languages, preference))
  }, [preference])
  const stop = useCallback(() => dictation.current?.stop(), [])
  const cancel = useCallback(() => dictation.current?.cancel(), [])
  const dismiss = useCallback(() => setState((current) => (current.phase === 'idle' ? IDLE : current)), [])

  return { state, available, needsBuild, start, stop, cancel, dismiss }
}
