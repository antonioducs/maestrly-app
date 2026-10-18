/**
 * Dictation turns speech into text for the composer. With the phone's own speech recognition (Apple's or Google's)
 * the audio never reaches Maestrly or the bot server, only the text the person then sends. With the server engine
 * the phone records the audio and the bot server transcribes it with its own speech-to-text key.
 */
import type { DictationError } from '@maestrly/bot-fleet-protocol'
import { detectLocale, type Locale } from '../i18n/translate'

export type DictationIssue =
  | 'denied'
  | 'unavailable'
  | 'noSpeech'
  | 'network'
  | 'language'
  | 'busy'
  | 'failed'
  | 'keyRejected'
  | 'quota'
  | 'serverBusy'
  | 'notConfigured'
  | 'transcribeFailed'

export type DictationState =
  /** `retry`: the recording was kept, and `Dictation.retry` sends it again. */
  | { phase: 'idle'; issue: DictationIssue | null; retry?: true }
  | { phase: 'starting' }
  /** `level`, from 0 to 1: how loud the recording is now, for engines that record rather than recognize. */
  | { phase: 'listening'; text: string; level?: number }
  /** The server engine's recording went to the server, which answers with its text. */
  | { phase: 'transcribing' }

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
  /** Starts listening, by the time it returns or resolves; throws or rejects when it cannot. */
  start(lang: string): void | Promise<void>
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
  /** Sends a recording kept after a failed transcription again (`retry` in the idle state); otherwise nothing. */
  retry(): void
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

const tagKey = (tag: string) => tag.replace(/_/g, '-').toLowerCase()

/** A tag's language and region, without its script: `zh-Hant-TW` is `zh-tw`. */
function variant(tag: string): { language: string; region: string | undefined } {
  const [language = '', ...rest] = tagKey(tag).split('-')
  return { language, region: rest.find((part) => /^([a-z]{2}|\d{3})$/.test(part)) }
}

/**
 * The first wanted language the recognizer takes, as it names it. Apple's takes only the tags of its own list, while
 * phones name a language with the phone's region (an iPhone in English set to Brazil says `en-BR`), so a language
 * whose region has no recognizer is listened for in its main one: `en-BR` as `en-US`, `fr-BR` as `fr-FR`. A recognizer
 * that takes any tag gets the first; one that takes none of them gets it too, and then says it cannot listen.
 */
export function recognizerLanguage(wanted: readonly string[], supported: readonly string[]): string {
  const first = wanted[0] ?? 'en-US'
  if (!supported.length) return first
  const named = new Map(supported.map((tag) => [tagKey(tag), tag]))
  for (const tag of wanted) {
    const { language, region } = variant(tag)
    const match =
      named.get(tagKey(tag)) ??
      (region ? named.get(`${language}-${region}`) : undefined) ??
      named.get(`${language}-${MAIN_REGION[language] ?? language}`) ??
      supported.find((each) => variant(each).language === language)
    if (match) return match
  }
  return first
}

/** Apple's SpeechTranscriber (iOS 26 and later), which needs a language's model on the phone to listen in it. */
export interface TranscriberEngine
  extends Pick<SpeechEngine, 'available' | 'languages' | 'stop' | 'abort' | 'onResult' | 'onError' | 'onEnd'> {
  /** Whether the language's model is on the phone; when it is not, the phone starts downloading it. */
  prepare(lang: string): Promise<boolean>
  start(lang: string): Promise<void>
}

/**
 * Listens with the transcriber where it has the model for the recognizer's language, in the same variant (never
 * `pt-PT` for `pt-BR`), and with the recognizer otherwise: on older phones, in languages the transcriber lacks, while
 * the model downloads, and when the transcriber fails to start. Only the engine listening is heard.
 */
export function preferTranscriber(transcriber: TranscriberEngine, recognizer: SpeechEngine): SpeechEngine {
  let active: SpeechEngine | TranscriberEngine | null = null
  let known: Promise<readonly string[]> | undefined
  const transcriberLanguages = () => {
    known ??= transcriber.languages().then(
      (tags) => {
        if (!tags.length) known = undefined
        return tags
      },
      () => {
        known = undefined
        return []
      }
    )
    return known
  }
  const sameVariant = (a: string, b: string) => {
    const one = variant(a)
    const other = variant(b)
    return one.language === other.language && one.region === other.region
  }
  const readyTag = async (lang: string) => {
    if (!transcriber.available()) return undefined
    const tag = (await transcriberLanguages()).find((each) => sameVariant(each, lang))
    if (!tag) return undefined
    return (await transcriber.prepare(tag).catch(() => false)) ? tag : undefined
  }
  const forward =
    <T extends unknown[]>(from: SpeechEngine | TranscriberEngine, listener: (...args: T) => void) =>
    (...args: T) => {
      if (active === from) listener(...args)
    }
  const both = (one: () => void, other: () => void) => () => {
    one()
    other()
  }

  return {
    available: () => transcriber.available() || recognizer.available(),
    requestPermission: () => recognizer.requestPermission(),
    languages: () => recognizer.languages(),
    async start(lang) {
      active = null
      const tag = await readyTag(lang)
      if (tag) {
        try {
          await transcriber.start(tag)
          active = transcriber
          return
        } catch {
          // The recognizer listens instead.
        }
      }
      active = recognizer
      await recognizer.start(lang)
    },
    stop: () => active?.stop(),
    abort: () => active?.abort(),
    onResult: (listener) =>
      both(transcriber.onResult(forward(transcriber, listener)), recognizer.onResult(forward(recognizer, listener))),
    onError: (listener) =>
      both(transcriber.onError(forward(transcriber, listener)), recognizer.onError(forward(recognizer, listener))),
    onEnd: (listener) =>
      both(transcriber.onEnd(forward(transcriber, listener)), recognizer.onEnd(forward(recognizer, listener))),
  }
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
  // Read through a call: the state changes while `start` awaits, which narrowing would not see.
  const phase = () => current.phase
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
        await engine.start(recognizerLanguage(wanted, supported))
      } catch {
        if (mine !== session) return
        session += 1
        return set({ phase: 'idle', issue: 'unavailable' })
      }
      if (mine === session) {
        if (phase() === 'starting') set({ phase: 'listening', text: '' })
        return
      }
      // Stopped, cancelled or gone while the recognizer was starting. A newer dictation already listening keeps it.
      if (phase() !== 'listening') engine.abort()
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
    // Recognizers keep no recording to send again.
    retry() {},
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

/** A recording on the phone, ready to send: its file and its loudest moment, in dBFS. */
export interface Recording {
  uri: string
  peakDb: number
}

export type RecordedTranscription = { text: string } | { error: DictationError }

/** An engine that records and then has the recording transcribed elsewhere: the bot server's. */
export interface RecordingEngine {
  available(): boolean
  requestPermission(): Promise<boolean>
  /** Starts recording; `onLevel` hears how loud it is now, from 0 to 1. */
  start(onLevel: (level: number) => void): Promise<void>
  /** Ends recording; null when there is nothing to send. */
  stop(): Promise<Recording | null>
  abort(): void
  transcribe(recording: Recording, language: string | null): Promise<RecordedTranscription>
  /** Deletes a recording no longer needed. */
  discard(recording: Recording): void
}

/** The server's speech-to-text APIs take files of a few minutes; recording stops by itself at this length. */
export const DICTATION_RECORDING_MAX_MS = 10 * 60_000
/** A recording whose loudest moment stays under this is silence or room noise, which Whisper turns into words. */
export const SILENCE_PEAK_DB = -45

/** The two-letter language the server transcribes in, from the wanted tags (`pt-BR` → `pt`); null lets it detect. */
export function transcriptionLanguage(wanted: readonly string[]): string | null {
  const language = wanted[0]?.split(/[-_]/)[0]?.toLowerCase()
  return language && /^[a-z]{2}$/.test(language) ? language : null
}

const API_ISSUES: Record<DictationError, DictationIssue> = {
  'key-rejected': 'keyRejected',
  quota: 'quota',
  'too-long': 'transcribeFailed',
  unavailable: 'transcribeFailed',
  busy: 'serverBusy',
  'not-configured': 'notConfigured',
}

/**
 * Dictation through a recording: listening shows how loud the recording is, stopping sends it, and its text comes
 * back at once, with no guess while speaking. A failed transcription keeps the recording until the next dictation,
 * so the person can send it again without speaking again; one the server cannot take (no key) is dropped.
 */
export function createRecordedDictation(engine: RecordingEngine, onText: (text: string) => void): Dictation {
  let current: DictationState = { phase: 'idle', issue: null }
  let session = 0
  let language: string | null = null
  let kept: { recording: Recording; language: string | null } | null = null
  let limit: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<(state: DictationState) => void>()
  // Read through a call: the state changes while the methods await, which narrowing would not see.
  const phase = () => current.phase
  const set = (next: DictationState) => {
    current = next
    for (const listener of listeners) listener(next)
  }
  const drop = () => {
    if (kept) engine.discard(kept.recording)
    kept = null
  }
  const clearLimit = () => {
    if (limit !== undefined) clearTimeout(limit)
    limit = undefined
  }

  const transcribe = async (mine: number) => {
    if (!kept) return
    const { recording, language: lang } = kept
    set({ phase: 'transcribing' })
    const outcome = await engine
      .transcribe(recording, lang)
      .catch((): RecordedTranscription => ({ error: 'unavailable' }))
    if (mine !== session) return
    if ('text' in outcome) {
      drop()
      const text = outcome.text.trim()
      set({ phase: 'idle', issue: text ? null : 'noSpeech' })
      if (text) onText(text)
      return
    }
    if (outcome.error === 'not-configured') drop()
    const issue = API_ISSUES[outcome.error]
    set(kept ? { phase: 'idle', issue, retry: true } : { phase: 'idle', issue })
  }

  const stop = async () => {
    if (current.phase === 'starting') {
      session += 1
      return set({ phase: 'idle', issue: null })
    }
    if (current.phase !== 'listening') return
    clearLimit()
    const mine = session
    set({ phase: 'transcribing' })
    const recording = await engine.stop().catch(() => null)
    if (mine !== session) {
      if (recording) engine.discard(recording)
      return
    }
    if (!recording || recording.peakDb < SILENCE_PEAK_DB) {
      if (recording) engine.discard(recording)
      return set({ phase: 'idle', issue: 'noSpeech' })
    }
    kept = { recording, language }
    await transcribe(mine)
  }

  const cancel = () => {
    if (current.phase === 'idle') return
    const recording = current.phase === 'listening'
    clearLimit()
    session += 1
    if (recording) engine.abort()
    drop()
    set({ phase: 'idle', issue: null })
  }

  return {
    state: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    available: () => engine.available(),
    async start(...wanted) {
      if (current.phase !== 'idle') return
      drop()
      const mine = ++session
      set({ phase: 'starting' })
      const granted = await engine.requestPermission().catch(() => false)
      if (mine !== session) return
      if (!granted) return set({ phase: 'idle', issue: 'denied' })
      try {
        await engine.start((level) => {
          if (mine === session && phase() === 'listening') set({ phase: 'listening', text: '', level })
        })
      } catch {
        if (mine !== session) return
        session += 1
        return set({ phase: 'idle', issue: 'unavailable' })
      }
      // Stopped, cancelled or gone while the recorder was starting.
      if (mine !== session) return engine.abort()
      language = transcriptionLanguage(wanted)
      set({ phase: 'listening', text: '', level: 0 })
      limit = setTimeout(() => {
        if (mine === session) void stop()
      }, DICTATION_RECORDING_MAX_MS)
    },
    stop: () => void stop(),
    cancel,
    retry() {
      if (current.phase !== 'idle' || !kept) return
      void transcribe(++session)
    },
    dispose() {
      clearLimit()
      if (current.phase === 'listening') engine.abort()
      session += 1
      drop()
      listeners.clear()
    },
  }
}
