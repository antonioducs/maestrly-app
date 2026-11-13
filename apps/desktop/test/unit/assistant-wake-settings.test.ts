import { describe, expect, it } from 'vitest'
import { assistantSettingsSchema, mergeAssistantSettings } from '../../src/shared/assistant'

const base = () => assistantSettingsSchema.parse({})

describe('wake word settings', () => {
  it('is off by default, with the language default phrase', () => {
    expect(base().voice).toMatchObject({ wakeWord: false, wakePhrase: null })
  })

  it('merges field by field and trims the phrase', () => {
    const next = mergeAssistantSettings(base(), { voice: { wakeWord: true, wakePhrase: '  Olá Maestro ' } })
    expect(next.voice).toMatchObject({ wakeWord: true, wakePhrase: 'Olá Maestro', mode: 'agent' })
  })

  it('rejects a phrase too short or too long', () => {
    expect(() => mergeAssistantSettings(base(), { voice: { wakePhrase: 'a' } })).toThrow()
    expect(() => mergeAssistantSettings(base(), { voice: { wakePhrase: 'x'.repeat(41) } })).toThrow()
  })

  it('reads stored settings without the new fields', () => {
    expect(assistantSettingsSchema.parse({ voice: { mode: 'realtime' } }).voice.wakeWord).toBe(false)
  })
})
