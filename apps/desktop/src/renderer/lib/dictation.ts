import type { DictationLanguageMode } from '../../shared/asr'

/** Microphone-menu preference, stored per device like the hold-to-record switch. */
export const MIC_LANGUAGE_KEY = 'chat.mic.language'

export function readLanguageMode(storage: Pick<Storage, 'getItem'>): DictationLanguageMode {
  return storage.getItem(MIC_LANGUAGE_KEY) === 'auto' ? 'auto' : 'app'
}

/** Join a transcription to whatever is already typed, with a single space. */
export function appendDictation(draft: string, text: string): string {
  return draft.trim() ? `${draft.trimEnd()} ${text}` : text
}
