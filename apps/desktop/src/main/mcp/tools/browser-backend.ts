import {
  acquireBrowserForControl,
  acquireBrowserTabForControl,
  browserControlReady,
  closeBrowserTab,
  closeBrowserWindowsOwnedByScope,
  createBrowserTab,
  getBrowserState,
  getBrowserStateForScope,
  getBrowserTabOwnerScopeId,
  listBrowserTabIdsOwnedByScope,
  switchBrowserTab,
  touchActiveBrowserActivity,
} from '../../drawer-manager'
import type { BrowserPage, ScreenshotOptions } from '../../browser-control'

/** A page leased for one tool call: released when the call ends. */
export interface BrowserBackendLease {
  page: BrowserPage
  captureFrame?: ScreenshotOptions['captureFrame']
  release(): void
}

export interface BrowserBackendTab {
  id: string
  title: string
  url: string
}

export interface BrowserBackendState {
  tabs: BrowserBackendTab[]
  activeId: string | null
}

export interface CreateBrowserBackendTabOptions {
  /** The delegated worker the tab belongs to; such tabs never become the conversation's active tab. */
  ownerScopeId?: string
  activate?: boolean
}

/**
 * The browser a conversation's `browser_*` tools drive: the drawer's (Electron views, the default), or a bot's own
 * Chromium in bot mode. Tab ids are the backend's own; a delegated worker's tabs are owned by its scope.
 */
export interface BrowserBackend {
  readonly kind: 'drawer' | 'bot-chromium'
  /** The conversation's active tab, created when it has none, ready to be driven. */
  acquireActive(convId: string): Promise<BrowserBackendLease>
  acquireTab(convId: string, tabId: string): Promise<BrowserBackendLease>
  state(convId: string): Promise<BrowserBackendState>
  stateForScope(convId: string, scopeId: string): Promise<BrowserBackendState>
  createTab(convId: string, url: string | undefined, options?: CreateBrowserBackendTabOptions): Promise<string>
  closeTab(convId: string, tabId: string): Promise<void>
  switchTab(convId: string, tabId: string): Promise<void>
  tabOwnerScopeId(convId: string, tabId: string): string | undefined
  tabIdsOwnedByScope(convId: string, scopeId: string): string[]
  /** Closes the popup windows a worker's pages opened; a backend whose popups are tabs closes nothing. */
  closeScopeWindows(convId: string, scopeId: string): void
  /** Renews the activity of the conversation's browser after a tab change. */
  touch(convId: string): void
}

async function readyLease(lease: ReturnType<typeof acquireBrowserForControl>): Promise<BrowserBackendLease> {
  try {
    await browserControlReady(lease.webContents)
  } catch (error) {
    lease.release()
    throw error
  }
  return { page: lease.webContents, captureFrame: lease.captureFrame, release: () => lease.release() }
}

/** The drawer's browser: Electron views per conversation, in the environment-wide `persist:drawer-browser` session. */
export const drawerBrowserBackend: BrowserBackend = {
  kind: 'drawer',
  // The view may have been created by this very call: see browserControlReady.
  acquireActive: (convId) => readyLease(acquireBrowserForControl(convId)),
  acquireTab: (convId, tabId) => readyLease(acquireBrowserTabForControl(convId, tabId)),
  state: async (convId) => {
    const state = getBrowserState(convId)
    return { tabs: state.tabs, activeId: state.activeId }
  },
  stateForScope: async (convId, scopeId) => {
    const state = getBrowserStateForScope(convId, scopeId)
    return { tabs: state.tabs, activeId: state.activeId }
  },
  createTab: async (convId, url, options) =>
    options ? createBrowserTab(convId, url, options) : createBrowserTab(convId, url),
  closeTab: async (convId, tabId) => closeBrowserTab(convId, tabId),
  switchTab: async (convId, tabId) => switchBrowserTab(convId, tabId),
  tabOwnerScopeId: (convId, tabId) => getBrowserTabOwnerScopeId(convId, tabId),
  tabIdsOwnedByScope: (convId, scopeId) => listBrowserTabIdsOwnedByScope(convId, scopeId),
  closeScopeWindows: (convId, scopeId) => closeBrowserWindowsOwnedByScope(convId, scopeId),
  touch: (convId) => touchActiveBrowserActivity(convId),
}

let resolveBackend: ((convId: string) => BrowserBackend | null) | null = null

/** Bot mode routes its bots' conversations to their own Chromium; every other conversation keeps the drawer's. */
export function setBrowserBackendResolver(resolver: ((convId: string) => BrowserBackend | null) | null): void {
  resolveBackend = resolver
}

export function browserBackendFor(convId: string): BrowserBackend {
  return resolveBackend?.(convId) ?? drawerBrowserBackend
}
