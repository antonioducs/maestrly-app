import { describe, expect, it } from 'vitest'
import { en, ptBR } from '../src/i18n/catalogs'
import { detectLocale, pluralize, translate } from '../src/i18n/translate'

describe('mobile languages', () => {
  it('keeps catalog keys and interpolation parameters in sync', () => {
    expect(Object.keys(ptBR).sort()).toEqual(Object.keys(en).sort())
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(ptBR[key].trim()).not.toBe('')
      expect((ptBR[key].match(/\{\w+\}/g) ?? []).sort()).toEqual((en[key].match(/\{\w+\}/g) ?? []).sort())
    }
  })
  it('prefers the saved choice, detects supported languages and falls back to English', () => {
    expect(detectLocale('en', ['pt-BR'])).toBe('en')
    expect(detectLocale(null, ['pt-BR'])).toBe('pt-BR')
    expect(detectLocale(null, ['pt-PT'])).toBe('pt-BR')
    expect(detectLocale(null, ['fr', 'en-US'])).toBe('en')
    expect(detectLocale('invalid', ['de'])).toBe('en')
  })
  it('interpolates values and picks plural forms per language', () => {
    expect(translate('composer.placeholder', 'en', { name: 'Juno' })).toBe('Message Juno')
    expect(translate('composer.placeholder', 'pt-BR', { name: 'Juno' })).toBe('Mensagem para Juno')
    expect(pluralize('bots.count', 1, 'en')).toBe('1 bot')
    expect(pluralize('bots.count', 3, 'en')).toBe('3 bots')
    expect(pluralize('schedule.hours', 1, 'pt-BR')).toBe('A cada hora')
    expect(pluralize('schedule.hours', 2, 'pt-BR')).toBe('A cada 2 horas')
  })
})
