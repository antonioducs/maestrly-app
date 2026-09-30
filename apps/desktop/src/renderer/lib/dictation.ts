import type { DictationLanguageMode } from '../../shared/asr'

/** Microphone-menu preferences, stored per device like the existing hold-to-record switch. */
export const MIC_AUTO_SEND_KEY = 'chat.mic.autoSend'
export const MIC_LANGUAGE_KEY = 'chat.mic.language'

/** Auto-send is on unless the user switched it off. */
export function readAutoSend(storage: Pick<Storage, 'getItem'>): boolean {
  return storage.getItem(MIC_AUTO_SEND_KEY) !== '0'
}

export function readLanguageMode(storage: Pick<Storage, 'getItem'>): DictationLanguageMode {
  return storage.getItem(MIC_LANGUAGE_KEY) === 'auto' ? 'auto' : 'app'
}

/** Join a transcription to whatever is already typed, with a single space. */
export function appendDictation(draft: string, text: string): string {
  return draft.trim() ? `${draft.trimEnd()} ${text}` : text
}
