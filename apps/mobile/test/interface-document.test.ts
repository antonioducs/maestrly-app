import { GENUI_WIDGET_META_CSP } from '@maestrly/bot-fleet-protocol'
import { describe, expect, it } from 'vitest'
import { interfaceDocument, interfaceTheme } from '../src/ui/conversation/interface-document'
import { palettes } from '../src/theme/tokens'

const theme = interfaceTheme(palettes.dark)

describe('interactive answers on the phone', () => {
  it('writes the block under the frame’s policy, with no network, in a page of its own', () => {
    const page = interfaceDocument('<p>Starter</p>', theme, 'react-native', 'dark')
    expect(page.startsWith('<!doctype html><html><head>')).toBe(true)
    expect(page).toContain(`<meta http-equiv="Content-Security-Policy" content="${GENUI_WIDGET_META_CSP}">`)
    expect(page).toContain("connect-src 'none'")
    expect(page).not.toContain('sandbox')
    expect(page).toContain('<meta name="referrer" content="no-referrer">')
    expect(page).toContain('window.ReactNativeWebView')
    expect(page).not.toContain('window.parent')
    // The policy and the bridge come before the block, which is written last.
    expect(page.indexOf('Content-Security-Policy')).toBeLessThan(page.indexOf('<p>Starter</p>'))
    expect(page.indexOf('ReactNativeWebView')).toBeLessThan(page.indexOf('<p>Starter</p>'))
    expect(page.endsWith('<body><p>Starter</p></body></html>')).toBe(true)
  })

  it('gives the block the app’s colors, and drops a value that could leave its declaration', () => {
    const page = interfaceDocument('', { ...theme, accent: 'red;} body{display:none' }, 'parent', 'light')
    expect(page).toContain(`--ui-text:${palettes.dark.ink};`)
    expect(page).toContain(`--ui-danger:${palettes.dark.brick};`)
    expect(page).not.toContain('--ui-accent:red')
    expect(page).toContain(':root{color-scheme:light}')
    expect(interfaceDocument('', theme, 'react-native', 'dark')).toContain(':root{color-scheme:dark}')
  })
})
