import { requireOptionalNativeModule } from 'expo'
import type { SpeechError, TranscriberEngine } from './session'

type Subscription = { remove(): void }
type NativeTranscriber = {
  isAvailable(): boolean
  supportedLocales(): Promise<string[]>
  prepare(locale: string): Promise<boolean>
  start(locale: string): Promise<void>
  stop(): void
  abort(): void
  addListener(event: 'result', listener: (event: { transcript: string; isFinal: boolean }) => void): Subscription
  addListener(event: 'error', listener: (event: { error: SpeechError }) => void): Subscription
  addListener(event: 'end', listener: () => void): Subscription
}

/** The app's own module (modules/maestrly-speech), in iOS builds only. */
const native = requireOptionalNativeModule<NativeTranscriber>('MaestrlySpeech')

/** Apple's SpeechTranscriber, or null where the build has no such module (Android, the web, Expo Go). */
export const transcriberEngine: TranscriberEngine | null = native && {
  available() {
    try {
      return native.isAvailable()
    } catch {
      return false
    }
  },
  languages: () => native.supportedLocales(),
  prepare: (lang) => native.prepare(lang),
  start: (lang) => native.start(lang),
  stop: () => native.stop(),
  abort: () => native.abort(),
  onResult(listener) {
    const subscription = native.addListener('result', (event) =>
      listener({ final: event.isFinal, transcript: event.transcript })
    )
    return () => subscription.remove()
  },
  onError(listener) {
    const subscription = native.addListener('error', (event) => listener(event.error))
    return () => subscription.remove()
  },
  onEnd(listener) {
    const subscription = native.addListener('end', () => listener())
    return () => subscription.remove()
  },
}
