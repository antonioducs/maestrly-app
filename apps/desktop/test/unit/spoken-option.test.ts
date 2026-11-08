import { describe, expect, it } from 'vitest'
import { matchSpokenOption } from '../../src/shared/spoken-option'

const sendCard = ['Mandar', 'Liberar o resto deste pedido', 'Cancelar']
const approveCard = ['Approve', 'Cancel']

describe('matchSpokenOption', () => {
  it.each(['sim', 'manda', 'pode', 'confirma', 'confirmo', 'ok', 'beleza', 'isso', 'bora', 'yes', 'go', 'send'])(
    'takes "%s" as the confirming option',
    (word) => {
      expect(matchSpokenOption(`${word[0].toUpperCase()}${word.slice(1)}!`, sendCard, 'pt-BR')).toBe(0)
      expect(matchSpokenOption(word, approveCard, 'en')).toBe(0)
    }
  )

  it.each(['não', 'nao', 'cancela', 'deixa', 'para', 'cancel', 'stop'])(
    'takes "%s" as the cancelling option',
    (word) => {
      expect(matchSpokenOption(word, sendCard, 'pt-BR')).toBe(2)
      expect(matchSpokenOption(word, approveCard, 'en')).toBe(1)
    }
  )

  it('reads "no" as a no in English only, and "para" or "deixa" only at the start', () => {
    expect(matchSpokenOption('No.', approveCard, 'en')).toBe(1)
    expect(matchSpokenOption('no', sendCard, 'pt-BR')).toBeNull()
    expect(matchSpokenOption('Deixa pra lá', sendCard, 'pt-BR')).toBe(2)
    expect(matchSpokenOption('Pode mandar para ele', sendCard, 'pt-BR')).toBe(0)
  })

  it('ignores accents, case and punctuation', () => {
    expect(matchSpokenOption('NÃO!!!', sendCard, 'pt-BR')).toBe(2)
    expect(matchSpokenOption('  sim, por favor.  ', sendCard, 'pt-BR')).toBe(0)
  })

  it('picks the option named, even said by halves', () => {
    expect(matchSpokenOption('libera o resto', sendCard, 'pt-BR')).toBe(1)
    expect(matchSpokenOption('sim, libera o resto', sendCard, 'pt-BR')).toBe(1)
    expect(matchSpokenOption('o develop', ['main', 'develop'], 'pt-BR')).toBe(1)
    expect(matchSpokenOption('main', ['main', 'maintenance'], 'en')).toBe(0)
    expect(matchSpokenOption('a segunda branch, a develop', ['main', 'develop'], 'pt-BR')).toBe(1)
  })

  it('picks nothing when two options match as well', () => {
    expect(matchSpokenOption('rodar testes', ['Rodar testes unitários', 'Rodar testes e2e'], 'pt-BR')).toBeNull()
    expect(matchSpokenOption('main e develop', ['main', 'develop'], 'pt-BR')).toBeNull()
  })

  it('picks nothing for a yes and a no in the same answer', () => {
    expect(matchSpokenOption('sim... não, não', sendCard, 'pt-BR')).toBeNull()
    expect(matchSpokenOption('yes, no, cancel', approveCard, 'en')).toBeNull()
  })

  it('does not take a yes for the first option of a question that is not a confirmation', () => {
    expect(matchSpokenOption('sim', ['main', 'develop'], 'pt-BR')).toBeNull()
    expect(matchSpokenOption('não', ['main', 'develop'], 'pt-BR')).toBeNull()
    expect(matchSpokenOption('', sendCard, 'pt-BR')).toBeNull()
    expect(matchSpokenOption('banana', sendCard, 'pt-BR')).toBeNull()
  })

  it('works in English', () => {
    const card = ['Send', 'Allow the rest of this request', 'Cancel']
    expect(matchSpokenOption('Yeah, go ahead and send it', card, 'en')).toBe(0)
    expect(matchSpokenOption('allow the rest', card, 'en')).toBe(1)
    expect(matchSpokenOption("Stop, don't", card, 'en')).toBe(2)
  })
})
