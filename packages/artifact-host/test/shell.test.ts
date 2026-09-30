import { describe, expect, it } from 'vitest'
import { BRIDGE_SCRIPT, SHELL_FILES, SHELL_VERSION } from '../src/generated/shell-assets.js'
import { MAX_BRIDGE_MESSAGE_CHARS, parseBridgeMessage } from '../src/shell/contract.js'
import { format, pickLocale, SHELL_CATALOGS } from '../src/shell/i18n.js'

describe('embedded shell assets', () => {
  it('have a content version', () => {
    expect(SHELL_VERSION).toMatch(/^[0-9a-f]{16}$/)
  })

  it('include the viewer modules and style with matching content types', () => {
    const names = Object.keys(SHELL_FILES)
    for (const name of ['viewer.js', 'i18n.js', 'listbox.js', 'contract.js', 'viewer.css'])
      expect(names).toContain(name)
    for (const [name, file] of Object.entries(SHELL_FILES)) {
      expect(file.contentType).toBe(
        name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8'
      )
    }
  })

  it('import only sibling modules', () => {
    for (const [name, file] of Object.entries(SHELL_FILES)) {
      if (!name.endsWith('.js')) continue
      for (const match of file.body.matchAll(/(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]/g))
        expect(match[1], name).toMatch(/^\.\/[a-z0-9-]+\.js$/)
    }
  })

  it('ship the bridge as a classic script', () => {
    expect(BRIDGE_SCRIPT).not.toMatch(/^\s*(?:import|export)\b/m)
    expect(BRIDGE_SCRIPT).toContain('maestrly-bridge')
  })
})

describe('shell i18n', () => {
  it('picks Portuguese for any Portuguese language and English otherwise', () => {
    expect(pickLocale(['pt-BR'])).toBe('pt-BR')
    expect(pickLocale(['pt'])).toBe('pt-BR')
    expect(pickLocale(['fr', 'en-US'])).toBe('en')
    expect(pickLocale([])).toBe('en')
  })

  it('keeps both catalogs in sync', () => {
    expect(Object.keys(SHELL_CATALOGS['pt-BR']).sort()).toEqual(Object.keys(SHELL_CATALOGS.en).sort())
  })

  it('fills placeholders', () => {
    expect(format('en', 'version', { n: 3 })).toBe('Version 3')
    expect(format('pt-BR', 'version', { n: 3 })).toBe('Versão 3')
  })
})

describe('parseBridgeMessage', () => {
  it('accepts only known bridge messages', () => {
    expect(parseBridgeMessage({ source: 'maestrly-bridge', type: 'ready' })).toEqual({ type: 'ready' })
    expect(parseBridgeMessage({ source: 'other', type: 'ready' })).toBeNull()
    expect(parseBridgeMessage(null)).toBeNull()
    expect(parseBridgeMessage('ready')).toBeNull()
    expect(parseBridgeMessage({ source: 'maestrly-bridge', type: 'navigate' })).toBeNull()
  })

  it('caps error messages', () => {
    const message = parseBridgeMessage({ source: 'maestrly-bridge', type: 'error', message: 'x'.repeat(1000) })
    expect(message).toEqual({ type: 'error', message: 'x'.repeat(MAX_BRIDGE_MESSAGE_CHARS) })
    expect(MAX_BRIDGE_MESSAGE_CHARS).toBe(300)
  })
})
