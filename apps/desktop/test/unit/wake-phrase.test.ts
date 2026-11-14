import { describe, expect, it } from 'vitest'
import { defaultWakePhrase, matchesWakePhrase, normalizeSpeech, wakePrompt, wakeScore } from '../../src/shared/wake-phrase'

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
    // What Whisper small writes for the phrase said alone, by synthesized pt-BR voices.
    ['O Maestro.', true],
    ['Oi Maestra!', true],
    // Sentences it heard close to the phrase that must not open the assistant.
    ['O maestro regeu a orquestra.', false],
    ['O Maestro Região Orchestra', false],
    ['Oi mestre!', false],
    ['Olha o maestro ali!', false],
    ['Olhe ao maestro ali.', false],
    ['É o Maestro.', false],
  ])('"%s" → %s for "Oi Maestro"', (heard, expected) => {
    expect(matchesWakePhrase(heard, 'Oi Maestro')).toBe(expected)
  })

  it('matches a one-word phrase at the start, after at most one word', () => {
    expect(matchesWakePhrase('Jarvis, abre o terminal', 'Jarvis')).toBe(true)
    expect(matchesWakePhrase('Ô Jarvis', 'Jarvis')).toBe(true)
    expect(matchesWakePhrase('Eu vi o Jarvis', 'Jarvis')).toBe(false)
  })

  it('turns the phrase into a prompt ending in a period', () => {
    expect(wakePrompt('Oi Maestro')).toBe('Oi Maestro.')
    expect(wakePrompt('  Olá, Jarvis!  ')).toBe('Olá, Jarvis.')
  })

  it('scores an exact phrase as 1 and unrelated speech low', () => {
    expect(wakeScore('oi maestro', 'Oi Maestro')).toBe(1)
    expect(wakeScore('bom dia a todos', 'Oi Maestro')).toBeLessThan(0.5)
  })
})
