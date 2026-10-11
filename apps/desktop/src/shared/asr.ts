/** Voice-dictation contract shared by main, preload and renderer. Pure: no Node, Electron or React. */

/** Whisper language passed to the engine; `auto` lets it detect the language. */
export type AsrLanguage = 'pt' | 'en' | 'auto'
/** User choice in the microphone menu: follow the app language, or detect automatically. */
export type DictationLanguageMode = 'app' | 'auto'
export type AsrSupport = { supported: true } | { supported: false; reason: 'platform' | 'os-version' }
export type TranscribeError = 'silent' | 'model-missing' | 'unavailable'

const LANGUAGES: readonly AsrLanguage[] = ['pt', 'en', 'auto']

/** Validate an untrusted language value; anything unknown falls back to automatic detection. */
export function asrLanguage(value: unknown): AsrLanguage {
  return LANGUAGES.includes(value as AsrLanguage) ? (value as AsrLanguage) : 'auto'
}

export function dictationLanguage(mode: DictationLanguageMode, uiLocale: string): AsrLanguage {
  if (mode === 'auto') return 'auto'
  return uiLocale.toLowerCase().startsWith('pt') ? 'pt' : 'en'
}

/** Darwin 24 is macOS 15, the minimum deployment target of the whisper.cpp addon. */
const MIN_DARWIN_MAJOR = 24

export function asrSupport(input: { hasRuntimeTarget: boolean; platform: string; osRelease: string }): AsrSupport {
  if (!input.hasRuntimeTarget) return { supported: false, reason: 'platform' }
  if (input.platform === 'darwin' && Number.parseInt(input.osRelease, 10) < MIN_DARWIN_MAJOR) {
    return { supported: false, reason: 'os-version' }
  }
  return { supported: true }
}
