import { describe, expect, it } from 'vitest'
import { MIC_LANGUAGE_KEY, appendDictation, readLanguageMode } from '../../src/renderer/lib/dictation'

const storage = (values: Record<string, string>) => ({ getItem: (key: string) => values[key] ?? null })

describe('dictation preferences and draft joining', () => {
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
