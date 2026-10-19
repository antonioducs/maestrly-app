/** Dictation engine choice shared by main, preload and renderer. Pure: no Node, Electron or React. */

/** Where this computer turns speech into text: local Whisper, or a speech-to-text API with the person's key. */
export type DictationEngine = 'local' | 'openai' | 'groq'
export type DictationApiProvider = Exclude<DictationEngine, 'local'>

export const DICTATION_ENGINES: readonly DictationEngine[] = ['local', 'openai', 'groq']
export const DICTATION_API_PROVIDERS: readonly DictationApiProvider[] = ['openai', 'groq']

export const isDictationEngine = (value: unknown): value is DictationEngine =>
  DICTATION_ENGINES.includes(value as DictationEngine)
export const isDictationApiProvider = (value: unknown): value is DictationApiProvider =>
  DICTATION_API_PROVIDERS.includes(value as DictationApiProvider)

/** What the renderer learns: the engine, and whether each key is set (never the keys). */
export interface DictationConfig {
  engine: DictationEngine
  keys: Record<DictationApiProvider, boolean>
}

/** An API engine stops recording at this length; providers take files up to 25 MB, ten minutes of WAV is 19.2 MB. */
export const DICTATION_API_MAX_MS = 10 * 60_000
