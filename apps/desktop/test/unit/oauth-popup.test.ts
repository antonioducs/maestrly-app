/** Classify window.open as a popup or tab and verify hardened OAuth child-window options without launching Electron. Real provider window.opener/postMessage flows still require the manual HTML harness. */
import { describe, it, expect } from 'vitest'
import { isPopupDisposition, oauthChildWindowOptions, type WindowOpenDetails } from '../../src/main/oauth-popup'

describe('isPopupDisposition — real popup window versus tab link', () => {
  const popups: Array<[string, WindowOpenDetails]> = [
    ["disposition 'new-window' (typical OAuth popup)", { url: 'https://accounts.google.com', disposition: 'new-window' }],
    ['features width/height (GIS / Continue with Google)', { url: 'https://accounts.google.com', features: 'width=420,height=560' }],
    ['features with width only', { url: 'https://x', features: 'width=500' }],
    ['features with height only', { url: 'https://x', features: 'height=600' }],
    ['features popup=yes', { url: 'https://x', features: 'popup=yes' }],
    ['features innerWidth/innerHeight', { url: 'https://x', features: 'innerwidth=420,innerheight=560' }],
    ['features with whitespace and mixed case', { url: 'https://x', features: 'menubar=no, Width=420, Height=560' }],
    ['new-window takes precedence even without features', { url: 'https://x', disposition: 'new-window', features: '' }],
  ]
  it.each(popups)('POPUP → true: %s', (_label, details) => {
    expect(isPopupDisposition(details)).toBe(true)
  })

  const tabs: Array<[string, WindowOpenDetails]> = [
    ["foreground-tab (_blank / middle-click) without features", { url: 'https://x', disposition: 'foreground-tab' }],
    ['background-tab (cmd/ctrl+click)', { url: 'https://x', disposition: 'background-tab' }],
    ['no disposition or features', { url: 'https://x' }],
    ['features without dimensions (noopener/noreferrer)', { url: 'https://x', features: 'noopener,noreferrer' }],
    ['empty features', { url: 'https://x', features: '' }],
    ["widths does not match a complete width token", { url: 'https://x', features: 'widths=10' }],
  ]
  it.each(tabs)('TAB → false: %s', (_label, details) => {
    expect(isPopupDisposition(details)).toBe(false)
  })
})

describe('oauthChildWindowOptions explicitly hardens the window without inherited defaults', () => {
  it('sets a shared partition, sandbox, no preload, and no nodeIntegration', () => {
    const opts = oauthChildWindowOptions('persist:drawer-browser')
    const wp = opts.webPreferences!
    expect(wp.partition).toBe('persist:drawer-browser') // Share the tab's login cookies.
    expect(wp.sandbox).toBe(true)
    expect(wp.nodeIntegration).toBe(false)
    expect(wp.contextIsolation).toBe(true)
    expect('preload' in wp).toBe(false) // The provider window never receives the application bridge.
  })

  // Black-screen regression (#560): OAuth windows must not set parent on macOS.
  // Attaching to mainWindow's native fullscreen Space can freeze the compositor; use an independent window.
  // did-create-window sets visibility above the app and fullscreen using setVisibleOnAllWorkspaces.
  it('omits parent to avoid macOS fullscreen freezes in a top-level window', () => {
    const opts = oauthChildWindowOptions('persist:drawer-browser')
    expect('parent' in opts).toBe(false)
    expect(opts.parent).toBeUndefined()
  })
})
