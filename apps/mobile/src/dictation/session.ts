/**
 * Dictation turns speech into text for the composer with the phone's own speech recognition (Apple's or Google's):
 * the audio never reaches Maestrly or the bot server, only the text the person then sends.
 */

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
  /** Asks for the microphone and speech recognition the first time, then listens until `stop`. */
  start(lang: string): Promise<void>
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

/** The language to listen for: the phone's first language, else the app's. */
export function dictationLanguage(systemTags: readonly string[], appLocale: string): string {
  const tag = systemTags.find((value) => /^[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(value))
  return tag ?? (appLocale === 'pt-BR' ? 'pt-BR' : 'en-US')
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
    async start(lang) {
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
      try {
        engine.start(lang)
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
