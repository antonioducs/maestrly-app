import { requireOptionalNativeModule } from 'expo'
import { Platform } from 'react-native'
import type { SpeechEngine, SpeechError, SpeechResult } from './session'

type Listeners = {
  result: Set<(value: SpeechResult) => void>
  error: Set<(value: SpeechError) => void>
  end: Set<() => void>
}
const listeners: Listeners = { result: new Set(), error: new Set(), end: new Set() }
let subscribed = false

type SpeechModule = typeof import('expo-speech-recognition').ExpoSpeechRecognitionModule
let loaded: SpeechModule | null | undefined
/**
 * The recognizer module, or null where the app was built without it, such as Expo Go: the package looks its native
 * module up as it loads and throws when it is missing, so it is loaded only once that module is known to exist.
 */
function speech(): SpeechModule | null {
  if (loaded === undefined)
    loaded =
      Platform.OS === 'web' || requireOptionalNativeModule('ExpoSpeechRecognition')
        ? (require('expo-speech-recognition') as typeof import('expo-speech-recognition')).ExpoSpeechRecognitionModule
        : null
  return loaded
}

/**
 * One subscription per event for the whole app, shared by every composer: on the web, removing one listener of the
 * module drops all the others of that event.
 */
function subscribe<K extends keyof Listeners>(kind: K, listener: Listeners[K] extends Set<infer L> ? L : never) {
  const module = speech()
  if (module && !subscribed) {
    subscribed = true
    module.addListener('result', (event) => {
      const value = { final: event.isFinal, transcript: event.results[0]?.transcript ?? '' }
      for (const each of listeners.result) each(value)
    })
    module.addListener('error', (event) => {
      for (const each of listeners.error) each(event.error as SpeechError)
    })
    module.addListener('end', () => {
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
      return speech()?.isRecognitionAvailable() ?? false
    } catch {
      return false
    }
  },
  async requestPermission() {
    // Browsers ask for the microphone themselves when listening starts.
    if (Platform.OS === 'web') return true
    const response = await speech()?.requestPermissionsAsync()
    return response?.granted === true
  },
  start(lang) {
    const module = speech()
    if (!module) throw new Error('Speech recognition is not in this build')
    module.start({
      lang,
      interimResults: true,
      continuous: true,
      addsPunctuation: true,
      iosTaskHint: 'dictation',
    })
  },
  stop: () => speech()?.stop(),
  abort: () => speech()?.abort(),
  onResult: (listener) => subscribe('result', listener),
  onError: (listener) => subscribe('error', listener),
  onEnd: (listener) => subscribe('end', listener),
}
