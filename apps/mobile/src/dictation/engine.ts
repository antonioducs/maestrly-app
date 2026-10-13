import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition'
import { Platform } from 'react-native'
import type { SpeechEngine, SpeechError, SpeechResult } from './session'

type Listeners = {
  result: Set<(value: SpeechResult) => void>
  error: Set<(value: SpeechError) => void>
  end: Set<() => void>
}
const listeners: Listeners = { result: new Set(), error: new Set(), end: new Set() }
let subscribed = false

/**
 * One subscription per event for the whole app, shared by every composer: on the web, removing one listener of the
 * module drops all the others of that event.
 */
function subscribe<K extends keyof Listeners>(kind: K, listener: Listeners[K] extends Set<infer L> ? L : never) {
  if (!subscribed) {
    subscribed = true
    ExpoSpeechRecognitionModule.addListener('result', (event) => {
      const value = { final: event.isFinal, transcript: event.results[0]?.transcript ?? '' }
      for (const each of listeners.result) each(value)
    })
    ExpoSpeechRecognitionModule.addListener('error', (event) => {
      for (const each of listeners.error) each(event.error as SpeechError)
    })
    ExpoSpeechRecognitionModule.addListener('end', () => {
      for (const each of listeners.end) each()
    })
  }
  const set = listeners[kind] as Set<typeof listener>
  set.add(listener)
  return () => {
    set.delete(listener)
  }
}

/** The phone's recognizer (and the browser's on the web preview), through expo-speech-recognition. */
export const speechEngine: SpeechEngine = {
  available() {
    try {
      return ExpoSpeechRecognitionModule.isRecognitionAvailable()
    } catch {
      return false
    }
  },
  async requestPermission() {
    // Browsers ask for the microphone themselves when listening starts.
    if (Platform.OS === 'web') return true
    const response = await ExpoSpeechRecognitionModule.requestPermissionsAsync()
    return response.granted
  },
  start(lang) {
    ExpoSpeechRecognitionModule.start({
      lang,
      interimResults: true,
      continuous: true,
      addsPunctuation: true,
      iosTaskHint: 'dictation',
    })
  },
  stop: () => ExpoSpeechRecognitionModule.stop(),
  abort: () => ExpoSpeechRecognitionModule.abort(),
  onResult: (listener) => subscribe('result', listener),
  onError: (listener) => subscribe('error', listener),
  onEnd: (listener) => subscribe('end', listener),
}
