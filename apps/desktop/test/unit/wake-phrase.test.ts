import { describe, expect, it } from 'vitest'
import { defaultWakePhrase, matchesWakePhrase, normalizeSpeech, wakeScore } from '../../src/shared/wake-phrase'

describe('wake phrase', () => {
  it('normalizes case, accents and punctuation into words', () => {
    expect(normalizeSpeech('  Olá, MAESTRO!  ')).toEqual(['ola', 'maestro'])
  })

  it('defaults to the app language', () => {
    expect(defaultWakePhrase('pt-BR')).toBe('Oi Maestro')
    expect(defaultWakePhrase('en')).toBe('Hey Maestro')
    expect(defaultWakePhrase('fr')).toBe('Hey Maestro')
  })

  it.each([
    ['Oi, Maestro.', true],
    ['oi maestro como estão meus bots', true],
    ['Oi maestra', true], // a recognition error close enough
    ['Oimaestro', true], // words merged by the recognizer
    ['É, oi Maestro', true], // one filler word before it
    ['Eu falei com o maestro ontem', false], // mid-sentence
    ['Maestro', false],
    ['Oi mãe', false],
    ['Hey Maestro', false],
    ['', false],
  ])('"%s" → %s for "Oi Maestro"', (heard, expected) => {
    expect(matchesWakePhrase(heard, 'Oi Maestro')).toBe(expected)
  })

  it('scores an exact phrase as 1 and unrelated speech low', () => {
    expect(wakeScore('oi maestro', 'Oi Maestro')).toBe(1)
    expect(wakeScore('bom dia a todos', 'Oi Maestro')).toBeLessThan(0.5)
  })
})
