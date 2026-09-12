import { describe, expect, it, vi } from 'vitest'
import { en, ptBR } from '../src/i18n/catalogs.js'
import { detectLocale, translate, setLocale, number, dateTime, duration, errorText } from '../src/i18n/index.js'

describe('web languages', () => {
  it('keeps catalog keys and interpolation parameters in sync', () => {
    expect(Object.keys(ptBR).sort()).toEqual(Object.keys(en).sort())
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(ptBR[key].trim()).not.toBe('')
      expect(ptBR[key].match(/\{\w+\}/g) ?? []).toEqual(en[key].match(/\{\w+\}/g) ?? [])
    }
  })
  it('prefers saved choice, detects supported languages and falls back to English', () => {
    expect(detectLocale('en', ['pt-BR'])).toBe('en')
    expect(detectLocale(null, ['pt-BR'])).toBe('pt-BR')
    expect(detectLocale(null, ['fr', 'en-US'])).toBe('en')
    expect(detectLocale('invalid', ['de'])).toBe('en')
    expect(detectLocale(null, ['pt-PT'])).toBe('pt-BR')
  })
  it('formats numbers, dates, duration and diagnostics in the chosen language', () => {
    vi.stubGlobal('document', {documentElement: {lang: ''}})
    try {
      setLocale('pt-BR')
      expect(number(1234.5)).toBe('1.234,5')
      expect(dateTime('2026-09-07T12:00:00Z')).toContain('07/09/2026')
      expect(duration(120)).toContain('2')
      expect(errorText('Invalid email or password')).toBe('E-mail ou senha inválidos')
      expect(errorText('Request failed (503)')).toBe('Falha na solicitação (503)')
      expect(errorText('upstream diagnostic')).toContain('upstream diagnostic')
      setLocale('en')
      expect(number(1234.5)).toBe('1,234.5')
    } finally { setLocale('en'); vi.unstubAllGlobals() }
  })
  it('interpolates user content without translating it and retains unknown details', () => {
    expect(translate('Move {title}', 'pt-BR', {title:'Board'})).toBe('Mover Board')
    expect(translate('unrecognized diagnostic', 'pt-BR')).toBe('unrecognized diagnostic')
  })
})
