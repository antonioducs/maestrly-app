import type { WebContents } from 'electron'

type BrowserRenderer = Pick<WebContents, 'isDestroyed' | 'getBackgroundThrottling' | 'setBackgroundThrottling'>

/**
 * Linux Electron 44 can leave a newly navigated, unthrottled view unpainted and unable to receive pointer input.
 * Reapply its rendering mode when the document is ready, without resizing, reloading, or changing the final policy.
 */
export function refreshUnthrottledBrowserRendering(
  wc: BrowserRenderer,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform !== 'linux') return
  try {
    if (wc.isDestroyed() || wc.getBackgroundThrottling()) return
    try {
      wc.setBackgroundThrottling(true)
    } finally {
      if (!wc.isDestroyed()) wc.setBackgroundThrottling(false)
    }
  } catch {
    // A renderer can disappear while navigation or app teardown is completing.
  }
}
