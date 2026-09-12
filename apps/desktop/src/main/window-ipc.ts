import type { BrowserWindow, WebContents, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { recordIpcSend, registerPerformanceWebContents, unregisterPerformanceWebContents } from './performance/metrics'
import type { MemoryEvictionReadyPayload } from '../shared/memory-eviction'
import { PREPARE_EVICTION_TIMEOUT_MS } from './performance/policy'

/**
 * Safely send to webContents during shutdown. Windows may be destroyed before PTYs/watchers stop
 * emitting; check both window and webContents and catch the race between validation and send to avoid
 * an unhandled destroyed-object error dialog.
 */
export function safeWindowSend(win: BrowserWindow | null | undefined, channel: string, payload?: unknown): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  try {
    win.webContents.send(channel, payload)
    recordIpcSend()
  } catch {
    /* window was destroyed between check and send */
  }
}

// ---------------- global/directed delivery (mainWindow + panel-views) ----------------

/**
 * Multi-window delivery includes mainWindow and registered panel WebContents, whether docked or
 * floating. Consumers filter conversation/agent/channel IDs. Use targeted helpers for scoped streams
 * and broadcast for global events.
 */
let broadcastMainWindow: BrowserWindow | null = null

export interface PanelTargetMetadata {
  convId?: string
  panel?: string
  resourceId?: string
  global?: boolean
}

const panelTargets = new Map<WebContents, PanelTargetMetadata>()

// Low-frequency application-wide settings/catalog events still need to reach the independent panel
// renderers (their i18n/model pickers subscribe directly). High-frequency conversation streams
// stay explicitly directed and never use this exception.
const PANEL_GLOBAL_CHANNELS = new Set([
  'settings:locale-changed',
  'models:catalog-changed',
])

/** Set mainWindow as the broadcast target during window creation. */
export function setBroadcastMainWindow(win: BrowserWindow | null): void {
  broadcastMainWindow = win
}

/**
 * Main-window WebContents, or null when absent/destroyed, for server-side Chat streams outside IPC,
 * such as approved-plan implementation.
 */
export function getMainWebContents(): WebContents | null {
  const win = broadcastMainWindow
  return win && !win.isDestroyed() ? win.webContents : null
}

/** Refocus a live main window, for example after external-browser OAuth completion. */
export function focusMainWindow(): void {
  const win = broadcastMainWindow
  if (!win || win.isDestroyed()) return
  try {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  } catch {
    /* window was destroyed between check and focus */
  }
}

/** Register trusted WebContents. Metadata narrows targeted pushes without changing the allowlist. */
export function registerPanelTarget(wc: WebContents, metadata: PanelTargetMetadata = { global: true }): void {
  if (panelTargets.has(wc)) {
    panelTargets.set(wc, metadata)
    return
  }
  panelTargets.set(wc, metadata)
  registerPerformanceWebContents(wc, {
    kind: metadata.panel ?? 'panel',
    convId: metadata.convId,
    resourceId: metadata.resourceId,
  })
  wc.once('destroyed', () => {
    panelTargets.delete(wc)
    unregisterPerformanceWebContents(wc)
  })
}

/** Remove panel WebContents from broadcast targets when its view is disposed. */
export function unregisterPanelTarget(wc: WebContents): void {
  panelTargets.delete(wc)
  unregisterPerformanceWebContents(wc)
}

function sendToTarget(wc: WebContents, channel: string, payload?: unknown): void {
  if (wc.isDestroyed()) {
    panelTargets.delete(wc)
    unregisterPerformanceWebContents(wc)
    return
  }
  try {
    wc.send(channel, payload)
    recordIpcSend()
  } catch {
    panelTargets.delete(wc)
    unregisterPerformanceWebContents(wc)
  }
}

/** Evento realmente global: mainWindow + targets explicitamente globais. */
export function broadcastGlobal(channel: string, payload?: unknown): void {
  safeWindowSend(broadcastMainWindow, channel, payload)
  for (const [wc, metadata] of [...panelTargets]) {
    if (metadata.global || PANEL_GLOBAL_CHANNELS.has(channel)) sendToTarget(wc, channel, payload)
  }
}

/** Compatibility for events that are already global. */
export const broadcast = broadcastGlobal

/** Deliver to a conversation and, by default, the main App window. */
export function sendToConversation(
  convId: string,
  channel: string,
  payload?: unknown,
  options: { includeMain?: boolean; panel?: string } = {}
): void {
  if (options.includeMain !== false) {
    safeWindowSend(broadcastMainWindow, channel, payload)
  }
  for (const [wc, metadata] of [...panelTargets]) {
    if (metadata.convId === convId && (!options.panel || metadata.panel === options.panel)) {
      sendToTarget(wc, channel, payload)
    }
  }
}

/** Deliver only to a conversation panel, suitable for high-frequency streams. */
export function sendToPanel(convId: string, panel: string, channel: string, payload?: unknown): void {
  for (const [wc, metadata] of [...panelTargets]) {
    if (metadata.convId === convId && metadata.panel === panel) sendToTarget(wc, channel, payload)
  }
}

/** Low-frequency event for one panel type without waking unrelated renderers. */
export function sendToPanelTargets(panel: string, channel: string, payload?: unknown): void {
  for (const [wc, metadata] of [...panelTargets]) {
    if (metadata.panel === panel) sendToTarget(wc, channel, payload)
  }
}

export function getPanelTargetCount(): number {
  return panelTargets.size
}

const evictionAcks = new Map<string, (payload: MemoryEvictionReadyPayload) => void>()
let evictionSeq = 0

export function receiveMemoryEvictionReady(wc: WebContents, payload: MemoryEvictionReadyPayload): void {
  if (!payload || typeof payload.requestId !== 'string') return
  const resolve = evictionAcks.get(payload.requestId)
  if (!resolve) return
  if (!panelTargets.has(wc)) return
  resolve(payload)
}

export function preparePanelMemoryEviction(
  convId: string,
  tab: string,
  timeoutMs = PREPARE_EVICTION_TIMEOUT_MS
): Promise<{ ok: boolean; reason?: string }> {
  const targets = [...panelTargets.entries()].filter(
    ([wc, metadata]) => metadata.convId === convId && metadata.panel === tab && !wc.isDestroyed()
  )
  if (targets.length === 0) return Promise.resolve({ ok: true })
  return Promise.race(
    targets.map(
      ([wc]) =>
        new Promise<{ ok: boolean; reason?: string }>((resolve) => {
          const requestId = `evict:${++evictionSeq}`
          const timer = setTimeout(() => {
            evictionAcks.delete(requestId)
            resolve({ ok: false, reason: 'timeout' })
          }, timeoutMs)
          evictionAcks.set(requestId, (payload) => {
            if (payload.requestId !== requestId) return
            clearTimeout(timer)
            evictionAcks.delete(requestId)
            resolve(payload.safe ? { ok: true } : { ok: false, reason: payload.reason || 'unsafe' })
          })
          sendToTarget(wc, 'panel:prepare-memory-eviction', { requestId, convId, tab })
        })
    )
  )
}

// ---------------- allowlist de sender IPC (#264) ----------------

/**
 * Trust IPC only from mainWindow or registered panels/browser chrome with legitimate preload. Embedded
 * browser/VS Code pages have no app preload and are excluded. This shared allowlist protects sensitive
 * mutations but does not replace payload validation in handlers.
 */
export function isTrustedSender(wc: WebContents): boolean {
  return wc === broadcastMainWindow?.webContents || panelTargets.has(wc)
}

/**
 * Require a trusted sender and its main frame, excluding nested iframes. If frame metadata is already
 * unavailable, rely on the validated WebContents.
 */
function eventFromTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  if (!isTrustedSender(event.sender)) return false
  try {
    const frame = event.senderFrame
    if (frame && frame !== event.sender.mainFrame) return false // sub-iframe → bloqueia
  } catch {
    /* Frame metadata is unavailable; rely on the validated WebContents. */
  }
  return true
}

/**
 * Wrap ipcMain.handle to reject untrusted senders on sensitive/mutating channels while preserving
 * handler argument types.
 */
export function guardHandle<A extends unknown[], R>(
  fn: (event: IpcMainInvokeEvent, ...args: A) => R
): (event: IpcMainInvokeEvent, ...args: A) => R {
  return (event, ...args) => {
    if (!eventFromTrustedSender(event)) throw new Error('IPC blocked: untrusted sender')
    return fn(event, ...args)
  }
}

/** Wrap ipcMain.on to discard untrusted sends and log a warning. */
export function guardOn<A extends unknown[]>(
  fn: (event: IpcMainEvent, ...args: A) => void
): (event: IpcMainEvent, ...args: A) => void {
  return (event, ...args) => {
    if (!eventFromTrustedSender(event)) {
      console.warn('[ipc] untrusted sender blocked (sensitive channel)')
      return
    }
    fn(event, ...args)
  }
}
