import { describe, expect, it } from 'vitest'
import {
  GENUI_WIDGET_CSP,
  GENUI_WIDGET_MAX_HEIGHT,
  GENUI_WIDGET_META_CSP,
  interfaceBridgeScript,
  parseGenUiWidgetMessage,
  safeWebUrl,
} from '../src/index.js'

describe('interface frames', () => {
  it('reaches its host through the parent window on a computer and through the web view on a phone', () => {
    const parent = interfaceBridgeScript('parent')
    const native = interfaceBridgeScript('react-native')
    expect(parent).toContain('var host = window.parent;')
    expect(parent).toContain("host.postMessage(message, '*')")
    expect(native).toContain('var host = window.ReactNativeWebView;')
    expect(native).toContain('host.postMessage(JSON.stringify(message))')
    // A web view's page has no parent to trust: the phone's bridge never names one.
    expect(native).not.toContain('window.parent')
    expect(native).not.toContain("postMessage(message, '*')")
    // Everything else is the same script.
    expect(
      native
        .replace('var host = window.ReactNativeWebView;', 'var host = window.parent;')
        .replace('host.postMessage(JSON.stringify(message))', "host.postMessage(message, '*')")
    ).toBe(parent)
    expect(parent).toContain(`height > ${GENUI_WIDGET_MAX_HEIGHT}`)
    // Written into a script element by both hosts, so it can never end one.
    for (const script of [parent, native]) expect(script).not.toMatch(/<\/script/i)
  })

  it('gives a page written into a web view the frame’s policy, without what only a header can carry', () => {
    expect(GENUI_WIDGET_CSP.startsWith('sandbox allow-scripts; ')).toBe(true)
    expect(GENUI_WIDGET_META_CSP).toBe(GENUI_WIDGET_CSP.replace('sandbox allow-scripts; ', ''))
    expect(GENUI_WIDGET_META_CSP).toContain("connect-src 'none'")
    expect(GENUI_WIDGET_META_CSP).toContain("frame-src 'none'")
    expect(GENUI_WIDGET_META_CSP).not.toContain('sandbox')
  })

  it('takes only what a frame may ask, checked field by field', () => {
    expect(parseGenUiWidgetMessage({ type: 'send', text: 'Tell me about Team' })).toBeNull()
    expect(parseGenUiWidgetMessage({ source: 'maestrly-widget', type: 'send', text: ' Tell me about Team ' })).toEqual({
      type: 'send',
      text: 'Tell me about Team',
    })
    expect(parseGenUiWidgetMessage({ source: 'maestrly-widget', type: 'open', url: 'javascript:alert(1)' })).toBeNull()
    expect(parseGenUiWidgetMessage({ source: 'maestrly-widget', type: 'size', height: 1e9 })).toEqual({
      type: 'size',
      height: GENUI_WIDGET_MAX_HEIGHT,
    })
    expect(parseGenUiWidgetMessage('{"source":"maestrly-widget","type":"ready"}')).toBeNull()
    expect(safeWebUrl('https://user:pass@example.com/')).toBeNull()
    expect(safeWebUrl('https://example.com/pricing')).toBe('https://example.com/pricing')
  })
})
