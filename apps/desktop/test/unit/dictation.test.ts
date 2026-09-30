import { describe, expect, it } from 'vitest'
import {
  MIC_AUTO_SEND_KEY,
  MIC_LANGUAGE_KEY,
  appendDictation,
  readAutoSend,
  readLanguageMode,
} from '../../src/renderer/lib/dictation'

const storage = (values: Record<string, string>) => ({ getItem: (key: string) => values[key] ?? null })

describe('dictation preferences and draft joining', () => {
  it('sends automatically unless the user turned it off', () => {
    expect(readAutoSend(storage({}))).toBe(true)
    expect(readAutoSend(storage({ [MIC_AUTO_SEND_KEY]: '0' }))).toBe(false)
    expect(readAutoSend(storage({ [MIC_AUTO_SEND_KEY]: '1' }))).toBe(true)
  })

  it('follows the app language unless automatic detection was chosen', () => {
    expect(readLanguageMode(storage({ [MIC_LANGUAGE_KEY]: 'auto' }))).toBe('auto')
    expect(readLanguageMode(storage({}))).toBe('app')
    expect(readLanguageMode(storage({ [MIC_LANGUAGE_KEY]: 'x' }))).toBe('app')
  })

  it('appends the transcription to the draft with one space', () => {
    expect(appendDictation('', 'oi')).toBe('oi')
    expect(appendDictation('   ', 'oi')).toBe('oi')
    expect(appendDictation('abre o PR  ', 'agora')).toBe('abre o PR agora')
    expect(appendDictation('abre o PR', 'agora')).toBe('abre o PR agora')
  })
})
