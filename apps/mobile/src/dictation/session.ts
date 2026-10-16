/**
 * Dictation turns speech into text for the composer with the phone's own speech recognition (Apple's or Google's):
 * the audio never reaches Maestrly or the bot server, only the text the person then sends.
 */
import { detectLocale, type Locale } from '../i18n/translate'

export type DictationIssue = 'denied' | 'unavailable' | 'noSpeech' | 'network' | 'language' | 'busy' | 'failed'

export type DictationState =
  | { phase: 'idle'; issue: DictationIssue | null }
  | { phase: 'starting' }
  | { phase: 'listening'; text: string }

export type SpeechResult = { final: boolean; transcript: string }
export type SpeechError =
  | 'aborted'
  | 'audio-capture'
  | 'interrupted'
  | 'bad-grammar'
  | 'language-not-supported'
  | 'network'
  | 'no-speech'
  | 'not-allowed'
  | 'service-not-allowed'
  | 'busy'
  | 'client'
  | 'speech-timeout'
  | 'unknown'

/** The platform's recognizer, behind what the session needs of it. */
export interface SpeechEngine {
  available(): boolean
  requestPermission(): Promise<boolean>
  /** The language tags the recognizer takes, exactly as it names them; empty when it takes any tag. */
  languages(): Promise<readonly string[]>
  start(lang: string): void
  stop(): void
  abort(): void
  onResult(listener: (result: SpeechResult) => void): () => void
  onError(listener: (error: SpeechError) => void): () => void
  onEnd(listener: () => void): () => void
}

export interface Dictation {
  state(): DictationState
  subscribe(listener: (state: DictationState) => void): () => void
  available(): boolean
  /**
   * Asks for the microphone and speech recognition the first time, then listens until `stop`, in the first of the
   * wanted languages the recognizer takes (see `recognizerLanguage`).
   */
  start(...wanted: string[]): Promise<void>
  /** Ends listening; the text heard so far goes to `onText` once the recognizer finishes. */
  stop(): void
  /** Ends listening and drops what was heard. */
  cancel(): void
  dispose(): void
}

/** How long a stopped recognizer may take to hand over its last words before the session ends without them. */
export const DICTATION_STOP_GRACE_MS = 4000

const ISSUES: Partial<Record<SpeechError, DictationIssue>> = {
  'not-allowed': 'denied',
  'service-not-allowed': 'unavailable',
  'audio-capture': 'unavailable',
  'language-not-supported': 'language',
  network: 'network',
  'no-speech': 'noSpeech',
  'speech-timeout': 'noSpeech',
  busy: 'busy',
}

/** Joins dictated text to what is already in the field, with one space between them. */
export function appendDictation(draft: string, dictated: string): string {
  const text = dictated.trim()
  if (!text) return draft
  if (!draft.trim()) return text
  return /\s$/.test(draft) ? `${draft}${text}` : `${draft} ${text}`
}

/** The tag an app language is listened for in when the phone names no variant of it. */
const APP_LANGUAGE: Record<Locale, string> = { en: 'en-US', 'pt-BR': 'pt-BR' }

/**
 * The languages to listen for, best first. A language chosen in the app's settings comes first, in the phone's variant
 * of it when the phone has one (`en-GB` for English on a British phone), then the phone's languages. With the app
 * following the system, the phone's languages come in their order, then the app's.
 */
export function dictationLanguages(systemTags: readonly string[], preference: Locale | 'system'): string[] {
  const phone = systemTags.filter((value) => /^[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(value))
  if (preference === 'system') return [...new Set([...phone, APP_LANGUAGE[detectLocale(null, phone)]])]
  const language = preference.split('-')[0]
  const variant = phone.find((tag) => tag.split('-')[0] === language) ?? APP_LANGUAGE[preference]
  return [...new Set([variant, ...phone])]
}

/** A language's main region, where it is not the language's own code (as French's is `fr-FR`). */
const MAIN_REGION: Record<string, string> = { en: 'us', pt: 'br' }

/**
 * The first wanted language the recognizer takes, as it names it. Apple's takes only the tags of its own list, while
 * phones name a language with the phone's region (an iPhone in English set to Brazil says `en-BR`), so a language
 * whose region has no recognizer is listened for in its main one: `en-BR` as `en-US`, `fr-BR` as `fr-FR`. A recognizer
 * that takes any tag gets the first; one that takes none of them gets it too, and then says it cannot listen.
 */
export function recognizerLanguage(wanted: readonly string[], supported: readonly string[]): string {
  const first = wanted[0] ?? 'en-US'
  if (!supported.length) return first
  const key = (tag: string) => tag.replace(/_/g, '-').toLowerCase()
  const named = new Map(supported.map((tag) => [key(tag), tag]))
  for (const tag of wanted) {
    const [language, ...rest] = key(tag).split('-')
    // Without its script: `zh-Hant-TW` is `zh-TW`.
    const region = rest.find((part) => /^([a-z]{2}|\d{3})$/.test(part))
    const match =
      named.get(key(tag)) ??
      (region ? named.get(`${language}-${region}`) : undefined) ??
      named.get(`${language}-${MAIN_REGION[language] ?? language}`) ??
      supported.find((each) => key(each).split('-')[0] === language)
    if (match) return match
  }
  return first
}

/**
 * One dictation at a time. Recognizers report a growing guess for the phrase being spoken and then fix it; some
 * (Android's continuous mode) fix each phrase separately, so fixed phrases add up and the latest guess follows them.
 */
export function createDictation(engine: SpeechEngine, onText: (text: string) => void): Dictation {
  let current: DictationState = { phase: 'idle', issue: null }
  let fixed = ''
  let guess = ''
  let keep = true
  let session = 0
  const listeners = new Set<(state: DictationState) => void>()
  const heard = () => [fixed, guess].filter(Boolean).join(' ')
  const set = (next: DictationState) => {
    current = next
    for (const listener of listeners) listener(next)
  }
  const finish = (issue: DictationIssue | null) => {
    const text = heard()
    const wanted = keep
    fixed = ''
    guess = ''
    session += 1
    set({ phase: 'idle', issue: text && issue === 'noSpeech' ? null : issue })
    if (wanted && text) onText(text)
  }

  const subscriptions = [
    engine.onResult((result) => {
      if (current.phase === 'idle') return
      const transcript = result.transcript.trim()
      if (result.final) {
        if (transcript) fixed = [fixed, transcript].filter(Boolean).join(' ')
        guess = ''
      } else guess = transcript
      set({ phase: 'listening', text: heard() })
    }),
    engine.onError((error) => {
      if (current.phase === 'idle') return
      // A call or Siri interrupting keeps what was heard, like stopping.
      finish(error === 'aborted' || error === 'interrupted' ? null : (ISSUES[error] ?? 'failed'))
    }),
    engine.onEnd(() => {
      if (current.phase !== 'idle') finish(null)
    }),
  ]

  return {
    state: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    available: () => engine.available(),
    async start(...wanted) {
      if (current.phase !== 'idle') return
      const mine = ++session
      keep = true
      set({ phase: 'starting' })
      let granted = false
      try {
        granted = await engine.requestPermission()
      } catch {
        granted = false
      }
      // Stopped or cancelled while the permission prompt was up.
      if (mine !== session) return
      if (!granted) return set({ phase: 'idle', issue: 'denied' })
      let supported: readonly string[] = []
      try {
        supported = await engine.languages()
      } catch {
        supported = []
      }
      if (mine !== session) return
      try {
        engine.start(recognizerLanguage(wanted, supported))
        if (mine === session) set({ phase: 'listening', text: '' })
      } catch {
        session += 1
        set({ phase: 'idle', issue: 'unavailable' })
      }
    },
    stop() {
      if (current.phase === 'starting') {
        session += 1
        return set({ phase: 'idle', issue: null })
      }
      if (current.phase !== 'listening') return
      const mine = session
      engine.stop()
      setTimeout(() => {
        if (mine === session && current.phase === 'listening') finish(null)
      }, DICTATION_STOP_GRACE_MS)
    },
    cancel() {
      if (current.phase === 'starting') {
        session += 1
        return set({ phase: 'idle', issue: null })
      }
      if (current.phase !== 'listening') return
      keep = false
      engine.abort()
      // Some recognizers say nothing after an abort.
      finish(null)
    },
    dispose() {
      if (current.phase === 'listening') {
        keep = false
        engine.abort()
      }
      session += 1
      for (const unsubscribe of subscriptions) unsubscribe()
      listeners.clear()
    },
  }
}
