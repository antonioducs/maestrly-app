import { ipcRenderer } from 'electron'
import type { FloatTab } from '../shared/tool-tabs'
import type { PtyOutputSnapshot } from '../shared/pty'

export interface FloatingBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface FloatingState {
  convId: string
  floating: FloatTab[]

  visible?: FloatTab[]
}

export interface BrowserState {
  convId: string
  tabs: Array<{ id: string; title: string; url: string; loading: boolean }>
  activeId: string | null
  canGoBack: boolean
  canGoForward: boolean
  devtoolsOpen: boolean
}

export interface TerminalPanelActivity {
  convId: string
  fullSpeed: boolean
}

let cachedTerminalPanelActivity: TerminalPanelActivity | null = null

function parseTerminalPanelActivity(value: unknown): TerminalPanelActivity | null {
  if (!value || typeof value !== 'object') return null
  const state = value as Partial<TerminalPanelActivity>
  if (typeof state.convId !== 'string' || typeof state.fullSpeed !== 'boolean') return null
  return { convId: state.convId, fullSpeed: state.fullSpeed }
}

// This listener is installed while preload is booting, before panel.html's async React/i18n mount.
// A later onTerminalPanelActivity subscriber can therefore consume the did-finish-load state even
// if the WebContents message arrived before React rendered.
ipcRenderer.on('drawer:terminal-activity', (_event, value: unknown) => {
  cachedTerminalPanelActivity = parseTerminalPanelActivity(value)
})

export const drawerApi = {
  onToggleDrawerShortcut: (cb: (convId: string) => void): (() => void) => {
    const listener = (_e: unknown, convId: string) => cb(convId)
    ipcRenderer.on('drawer:toggle-shortcut', listener)
    return () => ipcRenderer.removeListener('drawer:toggle-shortcut', listener)
  },

  suppressDrawerViews: (suppress: boolean) => ipcRenderer.send('drawer:suppress-views', suppress),

  onDebugEnsureVscode: (cb: (convId: string) => void): (() => void) => {
    const listener = (_e: unknown, convId: string) => cb(convId)
    ipcRenderer.on('debug:ensure-vscode', listener)
    return () => ipcRenderer.removeListener('debug:ensure-vscode', listener)
  },

  drawerLayout: (payload: {
    convId: string | null

    visibleKind: FloatTab | null
    bounds?: { x: number; y: number; width: number; height: number }
  }) => ipcRenderer.send('drawer:layout', payload),
  drawerEnsureBrowser: (convId: string) => ipcRenderer.send('drawer:ensure-browser', convId),
  drawerNewTab: (convId: string, url?: string) => ipcRenderer.send('drawer:tab-new', convId, url),
  drawerCloseTab: (convId: string, id: string) => ipcRenderer.send('drawer:tab-close', convId, id),
  drawerSwitchTab: (convId: string, id: string) => ipcRenderer.send('drawer:tab-switch', convId, id),
  drawerReorderTab: (convId: string, from: number, to: number) =>
    ipcRenderer.send('drawer:tab-reorder', convId, from, to),
  drawerNavigate: (convId: string, url: string) => ipcRenderer.send('drawer:navigate', convId, url),
  drawerBack: (convId: string) => ipcRenderer.send('drawer:back', convId),
  drawerForward: (convId: string) => ipcRenderer.send('drawer:forward', convId),
  drawerReload: (convId: string) => ipcRenderer.send('drawer:reload', convId),

  drawerClearCache: (convId: string): Promise<void> => ipcRenderer.invoke('drawer:clear-cache', convId),
  drawerDevTools: (convId: string) => ipcRenderer.send('drawer:devtools', convId),
  drawerLoadVSCode: (convId: string, folder: string): Promise<void> =>
    ipcRenderer.invoke('drawer:load-vscode', convId, folder),

  drawerRestartVSCode: (): Promise<void> => ipcRenderer.invoke('drawer:restart-vscode'),
  drawerDisposeConversation: (convId: string) => ipcRenderer.send('drawer:dispose-conversation', convId),

  drawerEnsurePanel: (convId: string, tab: 'terminal' | 'plan' | 'review' | 'notes') =>
    ipcRenderer.send('drawer:ensure-panel', convId, tab),

  drawerDetach: (convId: string, tab: FloatTab) => ipcRenderer.send('drawer:detach', convId, tab),
  drawerReattach: (convId: string, tab: FloatTab) => ipcRenderer.send('drawer:reattach', convId, tab),
  drawerSetFloatBounds: (convId: string, tab: FloatTab, bounds: FloatingBounds) =>
    ipcRenderer.send('drawer:set-float-bounds', convId, tab, bounds),

  floatSetPinned: (convId: string, tab: FloatTab, pinned: boolean) =>
    ipcRenderer.send('float:set-pinned', convId, tab, pinned),

  floatGoToConversation: (convId: string) => ipcRenderer.send('float:go-to-conversation', convId),

  setVisibleConversation: (convId: string | null) => ipcRenderer.send('drawer:visible-conversation', convId),

  onFloatingState: (cb: (s: FloatingState) => void): (() => void) => {
    const listener = (_e: unknown, s: FloatingState) => cb(s)
    ipcRenderer.on('drawer:floating-state', listener)
    return () => ipcRenderer.removeListener('drawer:floating-state', listener)
  },
  getFloatingState: (convId: string): Promise<FloatingState> => ipcRenderer.invoke('drawer:floating-state-get', convId),

  isChatGptVisible: (convId: string): Promise<boolean> => ipcRenderer.invoke('drawer:chatgpt-visible', convId),

  drawerCreateTerminal: (convId: string, cwd?: string) => ipcRenderer.send('drawer:create-terminal', convId, cwd),
  drawerCloseTerminal: (convId: string, id: string) => ipcRenderer.send('drawer:close-terminal', convId, id),
  drawerSetActiveTerminal: (convId: string, id: string | null) =>
    ipcRenderer.send('drawer:set-active-terminal', convId, id),
  drawerReorderTerminal: (convId: string, from: number, to: number) =>
    ipcRenderer.send('drawer:terminal-reorder', convId, from, to),
  drawerFocusTerminal: (convId: string, id: string) => ipcRenderer.send('drawer:focus-terminal', convId, id),

  readTerminal: (id: string): Promise<PtyOutputSnapshot> => ipcRenderer.invoke('drawer:read-terminal', id),
  onTerminalFocus: (cb: (id: string) => void): (() => void) => {
    const listener = (_event: unknown, id: string) => cb(id)
    ipcRenderer.on('terminal:focus', listener)
    return () => ipcRenderer.removeListener('terminal:focus', listener)
  },

  getTerminalState: (
    convId: string
  ): Promise<{ terminals: Array<{ id: string; cwd: string; label?: string }>; activeId: string | null }> =>
    ipcRenderer.invoke('drawer:terminal-state-get', convId),

  onTerminalState: (
    cb: (s: {
      convId: string
      terminals: Array<{ id: string; cwd: string; label?: string }>
      activeId: string | null
    }) => void
  ): (() => void) => {
    const listener = (_e: unknown, s: any) => cb(s)
    ipcRenderer.on('drawer:terminal-state', listener)
    return () => ipcRenderer.removeListener('drawer:terminal-state', listener)
  },
  onTerminalPanelActivity: (cb: (state: TerminalPanelActivity) => void): (() => void) => {
    const listener = (_event: unknown, value: unknown) => {
      const state = parseTerminalPanelActivity(value)
      if (!state) return
      cachedTerminalPanelActivity = state
      cb(state)
    }
    ipcRenderer.on('drawer:terminal-activity', listener)
    if (cachedTerminalPanelActivity) cb(cachedTerminalPanelActivity)
    return () => ipcRenderer.removeListener('drawer:terminal-activity', listener)
  },

  onDrawerTerminalFocus: (cb: (payload: { convId: string; id: string }) => void): (() => void) => {
    const listener = (_e: unknown, payload: { convId: string; id: string }) => cb(payload)
    ipcRenderer.on('drawer:terminal-focus', listener)
    return () => ipcRenderer.removeListener('drawer:terminal-focus', listener)
  },
  onBrowserState: (cb: (s: BrowserState) => void): (() => void) => {
    const listener = (_e: unknown, s: any) => cb(s)
    ipcRenderer.on('drawer:browser-state', listener)
    return () => ipcRenderer.removeListener('drawer:browser-state', listener)
  },

  getBrowserState: (convId: string): Promise<BrowserState> => ipcRenderer.invoke('drawer:browser-state-get', convId),
  onPrepareMemoryEviction: (
    cb: (payload: { requestId: string; convId: string; tab: string }) => void
  ): (() => void) => {
    const listener = (_e: unknown, payload: { requestId: string; convId: string; tab: string }) => cb(payload)
    ipcRenderer.on('panel:prepare-memory-eviction', listener)
    return () => ipcRenderer.removeListener('panel:prepare-memory-eviction', listener)
  },
  memoryEvictionReady: (payload: { requestId: string; safe: boolean; reason?: string }): void => {
    ipcRenderer.send('panel:memory-eviction-ready', payload)
  },
  savePlanDraft: (convId: string, draft: unknown): void => {
    ipcRenderer.send('panel:plan-draft-save', convId, draft)
  },
  getPlanDraft: (convId: string): Promise<unknown> => ipcRenderer.invoke('panel:plan-draft-get', convId),
}
