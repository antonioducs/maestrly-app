import { nativeImage } from 'electron'
import type { BrowserBackend, BrowserBackendLease } from '../../../mcp/tools/browser-backend'
import type { BotChromium } from './bot-chromium'
import type { ChromiumPage } from './chromium-page'

const backends = new WeakMap<BotChromium, BrowserBackend>()

/**
 * The `browser_*` tools of a bot's conversations on the bot's own Chromium. Each conversation (and each of its
 * delegated workers) drives and lists only its own tabs; a screenshot is the page as the browser composited it.
 */
export function botChromiumBackend(chromium: BotChromium): BrowserBackend {
  let backend = backends.get(chromium)
  if (backend) return backend
  const lease = (page: ChromiumPage): BrowserBackendLease => ({
    page,
    captureFrame: async (signal) => {
      signal.throwIfAborted()
      return nativeImage.createFromBuffer(await page.captureScreenshot())
    },
    release: () => chromium.touch(),
  })
  backend = {
    kind: 'bot-chromium',
    acquireActive: async (convId) => lease(await chromium.page(convId)),
    acquireTab: async (convId, tabId) => lease(await chromium.page(convId, tabId)),
    state: (convId) => chromium.state(convId),
    stateForScope: (convId, scopeId) => chromium.state(convId, scopeId),
    createTab: (convId, url, options) => chromium.createTab(convId, url, options),
    closeTab: (convId, tabId) => chromium.closeTab(convId, tabId),
    switchTab: (convId, tabId) => chromium.switchTab(convId, tabId),
    tabOwnerScopeId: (convId, tabId) => chromium.ownerScopeOf(convId, tabId),
    tabIdsOwnedByScope: (convId, scopeId) => chromium.tabIdsOwnedByScope(convId, scopeId),
    // A worker's popups are tabs of its own, closed with its tabs.
    closeScopeWindows: () => {},
    touch: () => chromium.touch(),
  }
  backends.set(chromium, backend)
  return backend
}
