import {executorSettings,recoverDesktopExecutions} from './platform/executor-settings'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Tray,
  nativeImage,
  nativeTheme,
  session,
  type MenuItemConstructorOptions,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron'
import { resolvePreload } from './resolve-preload'
import { killAllPtys } from './pty-manager'
import {
  initTerminalManager,
  disposeShellTerminals,
  setTerminalFloatFocuser,
  setTerminalPopupFocuser,
} from './terminal-manager'
import { safeWindowSend, setBroadcastMainWindow, broadcast, guardHandle, guardOn, focusMainWindow } from './window-ipc'
import { registerPerformanceWebContents } from './performance/metrics'
import { disposeMemoryReclaimer } from './performance/memory-reclaimer'
import { disposeOwnedProcesses } from './performance/owned-processes'
import { setMainLocale, tMain } from './i18n'
import * as floatingManager from './floating-manager'
import * as popupManager from './popup-manager'
import { setHotkeyHandler, attachHotkeyCapture } from './hotkeys'
import { AgentRegistry } from './agent-registry'

import { initMemoryService, disposeMemory, migrateAllLegacyMemories } from './memory-service'
import { disposeMemoryIndexService, initMemoryIndexService } from './memory/index'
import {
  runMlWorkerNativeSmoke,
  stopEmbeddingWorker as stopMlWorker,
  flushPendingEmbeddingWrites as flushPendingMemoryWrites,
  hasPendingEmbeddingWrites as hasPendingMemoryWrites,
} from './local-ml/embedding-service'
import { stopAsrWorker } from './asr-service'
import { fixPathForGuiApp } from './fix-path'
import { applyChannelIdentity, getChannelInfo, getInstanceId } from './channel'
import { captureProcessExit } from './crash-reporter'

import { registerPtyIpc } from './pty-ipc'
import { conversationMigrationService } from './conversation-migration/service'
import { isE2E } from './test-mode'

import { initAppImageIntegration } from './appimage-integration'
import { releaseInstanceLock, writeInstanceLock } from './instance-lock'
import {
  initPowerManager,
  onAgentStatus,
  isPreventSleepEnabled,
  setPreventSleepEnabled,
  releasePowerBlocker,
} from './power-manager'
import { initSelectionBridge, watchConversation, stopSelectionBridge } from './selection-bridge'
import { unwatchNotes, disposeNotes } from './notes/notes-service'
import { registerNotesIpc } from './notes/notes-ipc'
import { initPlanBroker, clearPlan } from './plan-broker'
import {
  initDrawer,
  flushPendingBrowserPersists,
  hardenBrowserSession,
  loadVSCode,
  navigateFocusedBrowser,
  navigateFocusedVSCode,
  reloadAllVSCode,
  showVSCodeLoading,
  showVSCodeLoadingAll,
  showVSCodeError,
  isVSCodeShowing,
  isVSCodePending,
  disposeDrawer,
  disposeConversation,
  setFloatFocuser,
  ensureViewFor,
} from './drawer-manager'
import {
  startVSCodeServer,
  restartVSCodeServer,
  getVSCodeUrl,
  getMergedSettingsJson,
  probeVSCode,
  waitForEditorReady,
  stopVSCodeServer,
  isVSCodeServerRunning,
} from './vscode/vscode-server'
import { isVSCodeCliReady, hasStagedCliUpdate } from './vscode/vscode-cli-download'
import {
  initStore,
  listAllConversations,
  updateConversationStatus,
  getConversation,
  getSoundSettings,
  getShortcutOpenMode,
  getLocale,
  initLocaleOnFirstRun,
  initOnboardingFlag,
  type ConversationStatus,
  type FloatTab,
} from './store'
import {
  resolvePlanReview as resolveChatGptWebPlanReview,
  restoreCompanionWindow as restoreChatGptWebCompanionWindow,
  status as getChatGptWebStatus,
} from './chat/chatgpt-web/manager'
import {
  disposeChat,
  getGlobalMaestroOrchestratorProfile,
  primeChatTurnSelection,
  registerChatIpc,
  resolveReviewLoopSelection,
  stopChat,
} from './chat/service'
import { setConversationMaestroConfig } from './chat/maestro-config'
import { resolveMaestroStrategyProfile, setLastUsedMaestroStrategyProfile } from './chat/maestro-strategy-profiles'
import { isChatGptWebEnabled } from './chat/catalog'
import { registerUsageIpc } from './usage/usage-service'
import type { IpcRegistrar } from './ipc-registrar'

import { registerSettingsIpc, reloadShortcuts } from './settings-ipc'
import { registerWorkspaceIpc } from './workspace-ipc'
import { registerProjectSetupIpc } from './project-setup/ipc'

import { registerPlanIpc } from './plan-ipc'
import { registerDrawerIpc } from './drawer-ipc'
import { registerConversationIpc } from './conversation-ipc'
import { createSiblingConversation, deleteConversation } from './workspace-service'
import { lookupReviewLoopByConversation } from './chat/review-loop/registry'
import { registerLocalConversationIpc } from './local-conversation/ipc'
import { registerConversationMigrationIpc } from './conversation-migration/ipc'
import { registerMemoryIpc } from './memory-ipc'
import { registerReviewIpc } from './review-ipc'
import { registerAppIpc } from './app-ipc'
import { registerLocalDataIpc } from './local-data/local-data-ipc'
import { maestroConfiguratorService } from './chat/maestro-configurator'
import { registerPerformanceIpc } from './performance/ipc'
import { registerSoundIpc } from './sound/ipc'
import { soundService } from './sound/service'
import { attachWindowNavigation } from './mouse-navigation'
import { cleanupOrphanRuntimeAssetTemps } from './runtime-assets/app-service'
import { registerRuntimeAssetIpc } from './runtime-assets/ipc'
import { registerPlatformIpc } from './platform/platform-ipc'
import { embeddedRunnerHost } from './platform/runner-host'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = !!process.env.ELECTRON_RENDERER_URL

// Isolate the application profile before acquiring locks or opening persistent stores.
applyChannelIdentity()

// Disable hardware acceleration for the Linux configurations affected by Chromium GPU startup loops.
const isWaylandSession = !!process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland'
if (process.platform === 'linux' && (getChannelInfo().channel === 'dev' || isWaylandSession)) {
  app.disableHardwareAcceleration()
}

if (process.platform === 'linux') {
  const desktopToken = getChannelInfo().userDataDirName
  const linuxApp = app as typeof app & { setDesktopName?: (name: string) => void }
  linuxApp.setDesktopName?.(`${desktopToken}.desktop`)
  app.commandLine.appendSwitch('class', desktopToken)
}

const registry = new AgentRegistry()

let mainWindow: BrowserWindow | null = null
let cancelProjectSetupsAndWait: (() => Promise<void>) | null = null
let disposeConversationMigrationIpc: (() => void) | null = null

const sendToWindow = (channel: string, payload?: unknown): void => safeWindowSend(mainWindow, channel, payload)

/** Stop live resources before a local reset without deleting repositories or conversation data. */
async function stopConversationLive(convId: string): Promise<void> {
  clearPlan(convId)
  const stoppingChat = stopChat(convId)
  disposeShellTerminals(convId)
  floatingManager.disposeConversation(convId)
  popupManager.disposeConversation(convId)
  disposeConversation(convId)
  await Promise.all([stoppingChat, unwatchNotes(convId)])
}

async function stopAllLiveWork(): Promise<void> {
  await cancelProjectSetupsAndWait?.()
  await Promise.all([
    ...listAllConversations().map((conversation) => stopConversationLive(conversation.id)),
    maestroConfiguratorService.stop(),
  ])
}

function hasActiveChatGptWebSession(convId: string): boolean {
  return getChatGptWebStatus().sessions.some(
    (session) => session.conversationId === convId && session.state !== 'ended'
  )
}

function openChatGptWebFallback(convId: string): void {
  focusMainWindow()
  safeWindowSend(mainWindow, 'chat:chatgpt-web:open', convId)
}

/** A cold load can fail after the user moves the restoring view between popup and floating placements. */
function cleanupFailedChatGptShortcutRestore(convId: string): void {
  popupManager.closePopup(convId, 'chatgpt')
  floatingManager.reattach(convId, 'chatgpt')
}

function openPopupGuarded(convId: string, tab: FloatTab): boolean {
  if (popupManager.isSuppressed()) return false
  if (tab === 'chatgpt') {
    if (!isChatGptWebEnabled()) return false
    if (!hasActiveChatGptWebSession(convId)) {
      openChatGptWebFallback(convId)
      return true
    }
    if (ensureViewFor(convId, tab) === false) {
      // `restoreCompanionWindow` materializes the WebContentsView synchronously before awaiting the remote
      // load. Show it immediately so the shortcut displays the local restoring state.

      const restoration = restoreChatGptWebCompanionWindow(convId)
      if (ensureViewFor(convId, tab) === false) return false
      popupManager.openPopup(convId, tab)
      void restoration
        .then((result) => {
          if (!result.ok) cleanupFailedChatGptShortcutRestore(convId)
        })
        .catch(() => cleanupFailedChatGptShortcutRestore(convId))
      return true
    }
  }
  popupManager.openPopup(convId, tab)
  return true
}

function openFloatingGuarded(convId: string, tab: FloatTab): boolean {
  if (popupManager.isSuppressed()) return false
  if (tab === 'chatgpt') {
    if (!isChatGptWebEnabled()) return false
    if (!hasActiveChatGptWebSession(convId)) {
      openChatGptWebFallback(convId)
      return true
    }
    if (ensureViewFor(convId, tab) === false) {
      // Same cold-restore path as popup mode, but the loading view is re-parented into the native floating
      // window. A failed load tears down that container instead of leaving a blank strip behind.
      const restoration = restoreChatGptWebCompanionWindow(convId)
      if (ensureViewFor(convId, tab) === false) return false
      floatingManager.detach(convId, tab)
      void restoration
        .then((result) => {
          if (!result.ok) cleanupFailedChatGptShortcutRestore(convId)
        })
        .catch(() => cleanupFailedChatGptShortcutRestore(convId))
      return true
    }
  }
  if (ensureViewFor(convId, tab) === false) return false
  if (tab === 'vscode') void loadVSCodeForConv(convId)
  floatingManager.detach(convId, tab)
  return true
}

function openByShortcutMode(convId: string, tab: FloatTab): boolean {
  if (floatingManager.focusFloatIfAny(convId, tab)) return true
  return getShortcutOpenMode() === 'floating' ? openFloatingGuarded(convId, tab) : openPopupGuarded(convId, tab)
}

function detachByShortcut(convId: string, tab: FloatTab): boolean {
  if (floatingManager.focusFloatIfAny(convId, tab)) return true
  popupManager.releasePopupForFloating(convId, tab)
  return openFloatingGuarded(convId, tab)
}

// Resolve the conversation directory when opening a cold editor popup.
async function loadVSCodeFolder(convId: string, folder: string): Promise<void> {
  void watchConversation(convId, folder)

  if (!isVSCodeCliReady()) showVSCodeLoading(convId, '', 'downloading')
  try {
    await startVSCodeServer()
  } catch {
    showVSCodeError(convId)
    return
  }

  const settingsJson = await getMergedSettingsJson()
  const url = getVSCodeUrl(folder)
  if (isVSCodeShowing(convId, url)) {
    loadVSCode(convId, url, settingsJson)
    return
  }
  if (isVSCodePending(convId, url)) return

  const phase = await probeVSCode(800)
  if (phase === 'ready') {
    loadVSCode(convId, url, settingsJson)
    return
  }
  showVSCodeLoading(convId, url, phase === 'downloading' ? 'downloading' : 'starting')
  void waitForEditorReady().finally(() => loadVSCode(convId, url, settingsJson))
}

async function loadVSCodeForConv(convId: string): Promise<void> {
  const conv = getConversation(convId)
  if (conv) await loadVSCodeFolder(convId, conv.cwd)
}

let applyingCliUpdate = false
async function applyVSCodeUpdateOnIdle(): Promise<void> {
  if (applyingCliUpdate || !hasStagedCliUpdate() || !isVSCodeServerRunning()) return
  applyingCliUpdate = true
  try {
    showVSCodeLoadingAll('restarting')
    await restartVSCodeServer()
    const settingsJson = await getMergedSettingsJson()
    await waitForEditorReady().catch(() => {})
    reloadAllVSCode(getVSCodeUrl, settingsJson)
  } catch {
    /* Best effort: retry on the next blur event. */
  } finally {
    applyingCliUpdate = false
  }
}

function broadcastStatus(payload: { agentId: string; status: string }): void {
  sendToWindow('agent:status', payload)

  onAgentStatus(payload.agentId, payload.status)

  try {
    updateConversationStatus(payload.agentId, payload.status as ConversationStatus)
  } catch {
    /* The conversation may no longer exist in the store. */
  }

}

function setupSessionPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(permission === 'media' || permission === 'clipboard-sanitized-write')
  )
}

function applyProdCsp(): void {
  if (isDev) return
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
        ],
      },
    })
  })
}

function setupApplicationMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    { role: 'help' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function createWindow(): Promise<void> {
  const isMac = process.platform === 'darwin'
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 940,
    minHeight: 600,

    backgroundColor: isMac ? '#00000000' : '#0A0A0B',
    ...(isMac
      ? {
          vibrancy: 'under-window' as const,
          visualEffectState: 'active' as const,
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 16, y: 14 },
        }
      : {}),
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  const wc = mainWindow.webContents
  wc.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.error(`[renderer] ${message} (${sourceId}:${line})`)
  })
  wc.on('did-fail-load', (_e, code, desc, url) => console.error(`[did-fail-load] ${code} ${desc} ${url}`))
  wc.on('preload-error', (_e, p, err) => console.error(`[preload-error] ${p}`, err))

  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('will-navigate', (e) => e.preventDefault())

  const sendFullscreen = () => wc.send('window:fullscreen', mainWindow?.isFullScreen() ?? false)
  mainWindow.on('enter-full-screen', sendFullscreen)
  mainWindow.on('leave-full-screen', sendFullscreen)
  wc.on('did-finish-load', sendFullscreen)

  mainWindow.on('blur', () => void applyVSCodeUpdateOnIdle())

  // Keep renderer zoom aligned with native view bounds, which use device-independent pixels.

  wc.on('did-finish-load', () => {
    if (wc.getZoomFactor() !== 1) wc.setZoomFactor(1)
  })
  wc.setVisualZoomLevelLimits(1, 1).catch(() => {})

  initDrawer(mainWindow)
  if (isE2E()) {
    const { installE2EAppToolsBridge } = await import('./e2e-app-tools')
    installE2EAppToolsBridge()
  }
  floatingManager.initFloatingManager(mainWindow)
  popupManager.initPopupManager(mainWindow)
  popupManager.setPopupVscodeLoader((convId) => void loadVSCodeForConv(convId)) // Open a cold VS Code view in the popup.

  setFloatFocuser(floatingManager.focusFloatIfAny)

  setTerminalFloatFocuser(floatingManager.focusFloatIfAny)

  setTerminalPopupFocuser(popupManager.bringTabToTopIfPopup)
  setBroadcastMainWindow(mainWindow)
  registerPerformanceWebContents(wc, { kind: 'app' })
  soundService.setTarget(wc)
  wc.on('did-start-loading', () => soundService.invalidateRenderer(wc))
  wc.on('render-process-gone', () => soundService.invalidateRenderer(wc))
  wc.once('destroyed', () => soundService.setTarget(null))

  reloadShortcuts()
  setHotkeyHandler({
    visibleConvId: popupManager.getVisibleConvId,
    isSuppressed: popupManager.isSuppressed,
    openPopup: openByShortcutMode,
    openFloating: detachByShortcut,
    toggleDrawer: (convId) => {
      safeWindowSend(mainWindow, 'drawer:toggle-shortcut', convId)
      return true
    },
    closeTop: (convId) => {
      const focused = BrowserWindow.getFocusedWindow()
      if (focused) {
        const f = floatingManager.findByWin(focused)
        if (f) {
          floatingManager.reattach(f.convId, f.tab)
          return true
        }
      }
      return convId ? popupManager.closeTopPopup(convId) : false
    },
  })
  attachHotkeyCapture(mainWindow.webContents)
  attachWindowNavigation(mainWindow, (direction) => {
    const convId = popupManager.getVisibleConvId()
    return !!convId && (navigateFocusedVSCode(convId, direction) || navigateFocusedBrowser(convId, direction))
  })
  initTerminalManager(mainWindow)

  mainWindow.on('close', (e) => {
    if(executorSettings().background&&!backgroundQuit){e.preventDefault();mainWindow?.hide();return}
    if (!confirmQuitOnce(() => e.preventDefault())) return

    floatingManager.flushPendingFloatPersists()
    floatingManager.disposeAll()
    popupManager.disposeAll()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    wc.openDevTools({ mode: 'detach' })
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mhandle = (channel: string, fn: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void => {
    ipcMain.handle(channel, guardHandle(fn))
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mon = (channel: string, fn: (event: IpcMainEvent, ...args: any[]) => void): void => {
    ipcMain.on(channel, guardOn(fn))
  }
  const reg: IpcRegistrar = {
    handle: (channel, fn) => ipcMain.handle(channel, fn),
    mhandle,
    on: (channel, fn) => void ipcMain.on(channel, fn),
    mon,
  }

  registerPtyIpc(reg)
  registerPlanIpc(reg, {
    sendToWindow,
    resolveChatGptWebPlanReview,
    createMaestroSibling: (sourceConversationId, options) => createSiblingConversation(sourceConversationId, options),
    deleteConversation,
    isConversationReserved: (conversationId) => !!lookupReviewLoopByConversation(conversationId),
    applyMaestroStrategyProfile: async (conversationId, profileId) => {
      const profile = resolveMaestroStrategyProfile(profileId, getGlobalMaestroOrchestratorProfile())
      if (!profile) return { ok: false, error: 'maestro-strategy-profile-not-found' }
      if (!profile.orchestrator) return { ok: false, error: 'maestro-strategy-profile-orchestrator-invalid' }
      const applied = setConversationMaestroConfig(conversationId, profile.config)
      if (!applied.ok) return { ok: false, error: 'maestro-strategy-profile-config-invalid' }
      primeChatTurnSelection(conversationId, profile.orchestrator)
      const available = await resolveReviewLoopSelection(conversationId)
      return available.ok ? { ok: true } : { ok: false, error: available.error }
    },
    markMaestroStrategyProfileUsed: setLastUsedMaestroStrategyProfile,
  })

  registerWorkspaceIpc(reg, {
    getMainWindow: () => mainWindow,
    stopChat,
  })
  cancelProjectSetupsAndWait = registerProjectSetupIpc(reg).cancelAndWait
  registerConversationIpc(reg, { stopChat })
  registerLocalConversationIpc(reg)
  disposeConversationMigrationIpc?.()
  disposeConversationMigrationIpc = registerConversationMigrationIpc(reg, {
    emitChanged: (event) => broadcast('conversation:migration-changed', event),
  })

  // Stream updates by conversation ID.
  registerChatIpc({
    mhandle,
    mon,

    emitStatus: (conversationId, status, opts) => {
      if (status === 'working') registry.markWorking(conversationId)
      else if (status === 'ready') registry.markReady(conversationId, opts?.silent)
      else if (status === 'error') registry.markError(conversationId)
      else if (status === 'asking')
        registry.markAsking(conversationId) // A pending question uses the permission alert.
      else broadcastStatus({ agentId: conversationId, status })
    },

    notifyChatGptWebTurnCompleted: (conversationId) => {
      try {
        registry.playReadySound(conversationId)
      } catch {
        /* A sound failure must not prevent the response or visual alert. */
      }
      sendToWindow('chat:chatgpt-web:turn-completed', { conversationId })
    },
  })

  registerUsageIpc({ mhandle })
  registerMemoryIpc(reg)

  registerNotesIpc(reg)

  registerDrawerIpc(reg, {
    loadVSCodeFolder,
    openPopup: openPopupGuarded,
    restoreChatGptView: async (convId) => (await restoreChatGptWebCompanionWindow(convId)).ok,
    openConversation: (convId) => {
      const conversation = getConversation(convId)
      if (!conversation) return
      focusMainWindow()
      safeWindowSend(mainWindow, 'conversation:open', { conversation, focus: true })
    },
  })

  registerReviewIpc(reg)
  registerAppIpc(reg)
  registerLocalDataIpc(reg, {
    getMainWindow: () => mainWindow,
    stopAllLiveWork,
    stopConversationLive,
  })
  registerPerformanceIpc(reg)
  registerSoundIpc(reg)
  registerRuntimeAssetIpc(reg, { emitChanged: (info) => broadcast('runtime-assets:changed', info) })
  registerPlatformIpc(reg)

  registerSettingsIpc(reg, {
    applySoundSettings: (s) => registry.setSoundSettings(s),
    isPreventSleepEnabled,
    setPreventSleepEnabled,
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
}

app.on('render-process-gone', (_e, _wc, details) => {
  if (details.reason === 'clean-exit' || details.reason === 'killed') return
  captureProcessExit('render-process-gone', { reason: details.reason, exitCode: details.exitCode })
})
app.on('child-process-gone', (_e, details) => {
  if (details.reason === 'clean-exit' || details.reason === 'killed') return
  const svc = details.serviceName || details.name
  captureProcessExit('child-process-gone', {
    reason: svc ? `${details.type}:${svc} ${details.reason}` : `${details.type} ${details.reason}`,
    exitCode: details.exitCode,
  })
})

app.whenReady().then(async () => {
  fixPathForGuiApp()
  if (process.env.MAESTRLY_PACKAGED_LOCAL_ML_SMOKE === '1') {
    try {
      const runtimePath = process.env.MAESTRLY_LOCAL_ML_RUNTIME_PATH?.trim()
      if (!runtimePath) throw new Error('MAESTRLY_LOCAL_ML_RUNTIME_PATH is required for packaged local-ML smoke')
      const result = await runMlWorkerNativeSmoke(runtimePath)
      console.log(`[packaged-local-ml-smoke] ok: onnx=${result.onnxValue} sharpBytes=${result.sharpBytes}`)
      process.exitCode = 0
    } catch (error) {
      console.error(
        '[packaged-local-ml-smoke] failed:',
        error instanceof Error ? (error.stack ?? error.message) : error
      )
      process.exitCode = 1
    } finally {
      app.quit()
    }
    return
  }
  await cleanupOrphanRuntimeAssetTemps()

  const instanceId = getInstanceId()
  if (instanceId) writeInstanceLock(instanceId)

  if (isDev && process.platform === 'darwin' && app.dock) {
    const base = getChannelInfo().iconBase
    let icon = nativeImage.createFromPath(path.join(__dirname, `../../resources/${base}.png`))
    if (icon.isEmpty()) icon = nativeImage.createFromPath(path.join(__dirname, '../../resources/icon.png'))
    if (!icon.isEmpty()) app.dock.setIcon(icon)
  }

  // Match native web views to the editor dark theme.

  nativeTheme.themeSource = 'dark'

  // Startup reads the local profile directly; it does not depend on an account or a hosted service.
  initStore()
  await migrateAllLegacyMemories()
  initMemoryIndexService()

  const { migrateLegacyConversationsToChat } = await import('./store/legacy-conversation-import')
  const { readTranscript } = await import('./transcript-reader')
  await migrateLegacyConversationsToChat(readTranscript)

  initLocaleOnFirstRun(process.env.AGENTS_LOCALE || app.getLocale())
  setMainLocale(getLocale())
  initOnboardingFlag()
  initPowerManager()

  setupSessionPermissions()
  hardenBrowserSession()
  applyProdCsp()
  registry.on('status', broadcastStatus)
  registry.setSoundSettings(getSoundSettings())

  registerIpc()
  const migrationRecoveries = await conversationMigrationService.recoverIncomplete()
  if (migrationRecoveries.length > 0) {
    console.warn(`[conversation-migration] ${migrationRecoveries.length} incomplete operation(s) recovered.`)
  }
  setupApplicationMenu()
  await createWindow()

  conversationMigrationService.replayIncomplete()
  if (mainWindow) initSelectionBridge(mainWindow)

  if (mainWindow) initPlanBroker((agentId) => registry.playPlanSound(agentId))
  if (mainWindow) initMemoryService(mainWindow)

  if (mainWindow) void initAppImageIntegration(mainWindow)

  const trayIcon=nativeImage.createFromPath(path.join(__dirname,'../../resources/icon.png')).resize({width:18,height:18})
  if(!trayIcon.isEmpty()){
    trayIcon.setTemplateImage(true)
    executorTray=new Tray(trayIcon)
    executorTray.setToolTip('Maestrly')
    const reveal=()=>{if(mainWindow&&!mainWindow.isDestroyed()){mainWindow.show();mainWindow.focus();mainWindow.webContents.send('executor:open')}else void createWindow()}
    executorTray.on('click',reveal)
    executorTray.setContextMenu(Menu.buildFromTemplate([{label:'Maestrly',click:reveal},{label:getLocale().startsWith('pt')?'Pausar executor':'Pause executor',click:()=>void embeddedRunnerHost.stop()},{type:'separator'},{label:getLocale().startsWith('pt')?'Sair':'Quit',click:()=>app.quit()}]))
  }
  recoverDesktopExecutions()
  const executor=executorSettings()
  if(executor.autoStart&&executor.connectionId)void embeddedRunnerHost.start(executor.connectionId)
  app.on('activate', () => {
    if(mainWindow&&!mainWindow.isDestroyed()){mainWindow.show();mainWindow.focus()}else void createWindow()
  })
})

app.on('window-all-closed', () => {
  flushPendingBrowserPersists()
  floatingManager.flushPendingFloatPersists()
  floatingManager.disposeAll()
  popupManager.disposeAll()
  disposeNotes()
  disposeMemory()
  disposeMemoryIndexService()
  killAllPtys()
  disposeDrawer()
  stopVSCodeServer()
  stopSelectionBridge()

  app.quit()
})

async function confirmQuit(): Promise<boolean> {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  if (!win) return true
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      title: tMain('main')('dialog.quitTitle'),
      message: tMain('main')('dialog.quitTitle'),
      detail: tMain('main')('dialog.quitConfirmDetail'),
      buttons: [tMain('main')('dialog.cancel'), tMain('main')('dialog.close')],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    return response === 1 // 1 = Close; 0 = Cancel.
  } catch {
    return true
  }
}

let projectSetupsFlushed = false
let projectSetupFlushInFlight = false
let mlFlushed = false

let chatDisposed = false
let chatDisposing = false
let platformRunnerStopped = false
let platformRunnerStopping = false

let executorTray:Tray|null=null
let backgroundQuit=false
let quitConfirmed = false
let quitDialogOpen = false

function shutdownConversationMigration(): void {
  const disposeIpc = disposeConversationMigrationIpc
  disposeConversationMigrationIpc = null
  disposeIpc?.()
}

/** Share one quit confirmation between window close and application quit; cancellation keeps all work alive. */
function confirmQuitOnce(preventDefault: () => void): boolean {
  if (quitConfirmed || isE2E()) return true
  preventDefault()
  if (quitDialogOpen) return false
  quitDialogOpen = true
  void confirmQuit()
    .then((ok) => {
      if (!ok) {backgroundQuit=false;return}
      quitConfirmed = true
      app.quit()
    })
    .finally(() => {
      quitDialogOpen = false
    })
  return false
}

// Wait for project cleanup, provider runtime teardown, and pending local memory writes before exiting.
app.on('before-quit', (e) => {
  backgroundQuit=true
  if (!confirmQuitOnce(() => e.preventDefault())) return

  if (!projectSetupsFlushed && cancelProjectSetupsAndWait) {
    e.preventDefault()
    if (!projectSetupFlushInFlight) {
      projectSetupFlushInFlight = true
      void cancelProjectSetupsAndWait().finally(() => {
        projectSetupsFlushed = true
        projectSetupFlushInFlight = false
        app.quit()
      })
    }
    return
  }

  if (!platformRunnerStopped) {
    e.preventDefault()
    if (!platformRunnerStopping) {
      platformRunnerStopping = true
      void embeddedRunnerHost.stop().finally(() => {
        platformRunnerStopped = true
        platformRunnerStopping = false
        app.quit()
      })
    }
    return
  }

  if (!chatDisposed) {
    e.preventDefault()
    if (!chatDisposing) {
      chatDisposing = true
      void disposeChat()
        .catch((error) => console.warn('[chat] Codex runtime teardown failed:', (error as Error).message))
        .finally(() => {
          chatDisposed = true
          chatDisposing = false
          app.quit()
        })
    }
    return
  }

  releaseInstanceLock()
  floatingManager.flushPendingFloatPersists()
  floatingManager.disposeAll()
  popupManager.disposeAll()
  releasePowerBlocker() // Release the keep-awake assertion on shutdown.

  shutdownConversationMigration()
  killAllPtys()
  stopVSCodeServer()
  disposeDrawer()
  disposeMemoryReclaimer()
  disposeMemoryIndexService()
  disposeOwnedProcesses()

  if (!mlFlushed && hasPendingMemoryWrites() && !isE2E()) {
    e.preventDefault()

    const flushBudgetMs = 10_000
    void flushPendingMemoryWrites(flushBudgetMs).then((flushed) => {
      if (!flushed && hasPendingMemoryWrites()) {
        console.warn('[local-ml] Shutdown indexing exceeded 10s; pending records will be reindexed on next startup')
      }
      mlFlushed = true
      stopMlWorker()
      stopAsrWorker()
      app.quit()
    })
    return
  }
  stopMlWorker()
  stopAsrWorker()
})
