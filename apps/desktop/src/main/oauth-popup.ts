import type { BrowserWindowConstructorOptions } from 'electron'

/**
 * Pure popup-versus-tab classification and hardened OAuth window options (#560). Converting all
 * window.open calls to tabs breaks window.opener/postMessage/popup.closed flows used by provider
 * login. Preserve genuine popups as native windows while tab-like links remain browser tabs. Electron
 * imports are type-only for unit testing without native windows.
 */

/** Subset of setWindowOpenHandler details used for classification. */
export interface WindowOpenDetails {
  url: string
  /**
   * Chromium disposition, including new-window for feature popups and foreground-tab for ordinary new
   * tabs.
   */
  disposition?: string
  /** Raw window.open feature string supplied as its third argument. */
  features?: string
}

// Recognize explicit popup sizing/features as a fallback alongside disposition because provider embeds
// vary.
const POPUP_FEATURE_RE = /(?:^|,)\s*(?:width|height|popup|innerwidth|innerheight)\b/i

/**
 * Whether this is a genuine popup requiring native window.opener preservation rather than a tab-like
 * link.
 */
export function isPopupDisposition(d: WindowOpenDetails): boolean {
  if (d.disposition === 'new-window') return true
  return !!d.features && POPUP_FEATURE_RE.test(d.features)
}

/**
 * Explicit OAuth isolation: share persist:drawer-browser cookies, enable sandbox/contextIsolation,
 * disable Node integration, and omit app preload. Site features control size. Do not set parent: macOS
 * fullscreen Spaces can break compositing for parented windows. Create an independent top-level window
 * and use did-create-window visibility-on-all-workspaces/fullscreen plus center/show/focus to present
 * it above the app.
 */
export function oauthChildWindowOptions(partition: string): BrowserWindowConstructorOptions {
  return {
    backgroundColor: '#0A0A0B',
    autoHideMenuBar: true,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // No preload: provider windows must not receive the app bridge.
    },
  }
}
