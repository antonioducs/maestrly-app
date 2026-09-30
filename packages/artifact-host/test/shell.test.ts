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
    for (const name of [
      'viewer.js',
      'i18n.js',
      'listbox.js',
      'contract.js',
      'gate.js',
      'gate-model.js',
      'comments.js',
      'comments-model.js',
      'api.js',
      'dom.js',
      'viewer.css',
    ])
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

  it('takes a selection as a hint, capped to what a comment may quote', () => {
    const selection = (extra: Record<string, unknown>) =>
      parseBridgeMessage({ source: 'maestrly-bridge', type: 'selection', ...extra })
    expect(
      selection({
        quote: { exact: 'x'.repeat(900), prefix: 'p'.repeat(100), suffix: 's'.repeat(100) },
        rect: { x: 1, y: 2.5, width: 30, height: 12, extra: 'ignored' },
      })
    ).toEqual({
      type: 'selection',
      quote: { exact: 'x'.repeat(500), prefix: 'p'.repeat(64), suffix: 's'.repeat(64) },
      rect: { x: 1, y: 2.5, width: 30, height: 12 },
    })
    expect(selection({ quote: null, rect: null })).toEqual({ type: 'selection', quote: null, rect: null })
    expect(selection({})).toEqual({ type: 'selection', quote: null, rect: null })
    // A quote without text, or a rectangle that is not numbers, is no selection at all.
    expect(
      selection({ quote: { exact: '', prefix: '', suffix: '' }, rect: { x: 0, y: 0, width: 1, height: 1 } })
    ).toEqual({ type: 'selection', quote: null, rect: null })
    expect(selection({ quote: { exact: 42 }, rect: { x: 0, y: 0, width: 1, height: 1 } })).toEqual({
      type: 'selection',
      quote: null,
      rect: null,
    })
    for (const rect of [
      { x: '1', y: 2, width: 3, height: 4 },
      { x: 1, y: 2, width: Number.NaN, height: 4 },
      'nope',
      null,
    ])
      expect(selection({ quote: { exact: 'text', prefix: '', suffix: '' }, rect })).toBeNull()
    expect(selection({ quote: { exact: 'text' }, rect: { x: 0, y: 0, width: 1, height: 1 } })).toEqual({
      type: 'selection',
      quote: { exact: 'text', prefix: '', suffix: '' },
      rect: { x: 0, y: 0, width: 1, height: 1 },
    })
  })

  it('takes found and missing anchors only as lists of comment IDs', () => {
    const a = 'A'.repeat(22)
    const b = 'B'.repeat(22)
    const anchors = (found: unknown, missing: unknown) =>
      parseBridgeMessage({ source: 'maestrly-bridge', type: 'anchors', found, missing })
    expect(anchors([a], [b])).toEqual({ type: 'anchors', found: [a], missing: [b] })
    expect(anchors([], [])).toEqual({ type: 'anchors', found: [], missing: [] })
    expect(anchors([a, '<script>', 42, 'short'], [b])).toBeNull()
    expect(anchors('nope', [])).toBeNull()
    expect(anchors([a], undefined)).toBeNull()
    expect(
      anchors(
        Array.from({ length: 201 }, () => a),
        []
      )
    ).toBeNull()
    expect(
      anchors(
        Array.from({ length: 200 }, () => a),
        []
      )?.type
    ).toBe('anchors')
  })

  it('caps error messages', () => {
    const message = parseBridgeMessage({ source: 'maestrly-bridge', type: 'error', message: 'x'.repeat(1000) })
    expect(message).toEqual({ type: 'error', message: 'x'.repeat(MAX_BRIDGE_MESSAGE_CHARS) })
    expect(MAX_BRIDGE_MESSAGE_CHARS).toBe(300)
  })
})
