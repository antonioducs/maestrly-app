import { BrowserWindow, session, type Session } from 'electron'
import * as browserControl from '../../browser-control'
import type {
  BrowserSurface,
  BrowserSurfaceInfo,
  BrowserSurfaceScreenshot,
  BrowserSurfaceState,
} from '../browser-surface'
import { normalizeLoopbackPreviewUrl } from './preview-runtime'

const DEFAULT_VISUAL_STARTUP_TIMEOUT_MS = 10_000
const MAX_VISUAL_STARTUP_TIMEOUT_MS = 30_000
const DEFAULT_VISUAL_TEARDOWN_TIMEOUT_MS = 2_000
const MAX_VISUAL_TEARDOWN_TIMEOUT_MS = 10_000

export type VisualBrowserState = BrowserSurfaceState
export type VisualBrowserInfo = BrowserSurfaceInfo

export interface VisualBrowserOptions {
  loopId: string
  url: string
  signal?: AbortSignal
  onStateChange?: (info: VisualBrowserInfo) => void
  createWindow?: (options: Electron.BrowserWindowConstructorOptions) => BrowserWindow
  fromPartition?: (partition: string) => Session
  /** Internal bounded startup deadline; injectable for deterministic tests. */
  startupTimeoutMs?: number
  /** Internal best-effort shutdown deadline per Electron operation; injectable for deterministic tests. */
  teardownTimeoutMs?: number
}

export type VisualScreenshot = BrowserSurfaceScreenshot
export type VisualBrowser = BrowserSurface

function safeLoopId(loopId: string): string {
  if (!/^rl_[a-zA-Z0-9_-]{1,96}$/.test(loopId)) throw new Error('Invalid visual review loop id.')
  return loopId
}

function allowedUrl(raw: string, origin: string): string | null {
  const normalized = normalizeLoopbackPreviewUrl(raw)
  if (!normalized) return null
  try {
    return new URL(normalized).origin === origin ? normalized : null
  } catch {
    return null
  }
}

function boundedTimeout(value: number | undefined, fallback: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(1, Math.floor(value)))
    : fallback
}

function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    timer.unref?.()
    promise.then(finish, finish)
  })
}

function settleOperation(operation: () => unknown, timeoutMs: number): Promise<void> {
  try {
    return settleWithin(Promise.resolve(operation()), timeoutMs)
  } catch {
    return Promise.resolve()
  }
}

function startupStep<T>(
  promise: Promise<T>,
  deadline: number,
  signal: AbortSignal | undefined,
  stage: 'network setup' | 'CDP initialization' | 'page load'
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (operation: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      operation()
    }
    const onAbort = () => finish(() => reject(new Error('Visual review startup aborted.')))
    const remaining = Math.max(1, deadline - Date.now())
    const timer = setTimeout(
      () => finish(() => reject(new Error(`Visual review browser startup timed out during ${stage}.`))),
      remaining
    )
    timer.unref?.()
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    )
  })
}

/**
 * Creates one hidden, non-persistent Electron surface owned by a single frontend review loop.
 * CDP automation remains entirely in browser-control.ts; this module only owns isolation and policy.
 */
export async function createVisualBrowser(options: VisualBrowserOptions): Promise<VisualBrowser> {
  const initialUrl = normalizeLoopbackPreviewUrl(options.url)
  if (!initialUrl) throw new Error('Visual review requires an HTTP loopback URL.')
  if (options.signal?.aborted) throw new Error('Visual review startup aborted.')
  const origin = new URL(initialUrl).origin
  const startupTimeoutMs = boundedTimeout(
    options.startupTimeoutMs,
    DEFAULT_VISUAL_STARTUP_TIMEOUT_MS,
    MAX_VISUAL_STARTUP_TIMEOUT_MS
  )
  const teardownTimeoutMs = boundedTimeout(
    options.teardownTimeoutMs,
    DEFAULT_VISUAL_TEARDOWN_TIMEOUT_MS,
    MAX_VISUAL_TEARDOWN_TIMEOUT_MS
  )
  const startupDeadline = Date.now() + startupTimeoutMs
  const partition = `chatgpt-visual-review:${safeLoopId(options.loopId)}`
  if (partition.startsWith('persist:') || partition === 'persist:drawer-browser') {
    throw new Error('Visual review partition must be ephemeral.')
  }

  const visualSession = (options.fromPartition ?? ((value) => session.fromPartition(value, { cache: false })))(partition)
  visualSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  visualSession.setPermissionCheckHandler(() => false)

  const createWindow = options.createWindow ?? ((windowOptions) => new BrowserWindow(windowOptions))
  const window = createWindow({
    title: 'Maestrly · Visual Review',
    show: false,
    width: 1280,
    height: 900,
    backgroundColor: '#111111',
    webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })
  const wc = window.webContents
  let disposed = false
  let disposal: Promise<void> | null = null
  let state: VisualBrowserState = 'starting'
  const emitState = () => {
    let url: string | undefined
    if (!disposed && !wc.isDestroyed()) {
      try {
        url = allowedUrl(wc.getURL(), origin) ?? initialUrl
      } catch {
        url = initialUrl
      }
    }
    options.onStateChange?.({ state, ...(url ? { url } : {}) })
  }
  const mark = (next: VisualBrowserState, _error?: string) => {
    state = next
    emitState()
  }
  const assertAlive = () => {
    if (disposed || wc.isDestroyed()) throw new Error('Visual review browser is no longer available.')
    if (options.signal?.aborted) throw new Error('Visual review browser operation aborted.')
  }
  const assertOrigin = (): string => {
    assertAlive()
    const current = allowedUrl(wc.getURL(), origin)
    if (!current) {
      wc.stop()
      mark('error', 'Cross-origin navigation blocked.')
      throw new Error('Visual review navigation escaped the approved origin and was blocked.')
    }
    return current
  }
  const guardNavigation = (event: Electron.Event, url: string) => {
    if (allowedUrl(url, origin)) return
    event.preventDefault()
    wc.stop()
    mark('error', 'Cross-origin navigation blocked.')
  }
  const onWindowClose = (event: Electron.Event) => {
    if (disposed) return
    event.preventDefault()
    window.hide()
  }
  window.on('close', onWindowClose)
  wc.on('will-navigate', guardNavigation)
  wc.on('will-redirect', guardNavigation)
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  visualSession.webRequest.onBeforeRequest((details, callback) => {
    const topLevel = details.resourceType === 'mainFrame'
    callback({ cancel: topLevel && !allowedUrl(details.url, origin) })
  })
  const onAbort = () => void dispose()
  options.signal?.addEventListener('abort', onAbort, { once: true })

  function dispose(): Promise<void> {
    if (disposal) return disposal
    disposed = true
    options.signal?.removeEventListener('abort', onAbort)
    window.removeListener('close', onWindowClose)
    disposal = (async () => {
      if (!wc.isDestroyed()) wc.stop()
      try {
        if (!wc.isDestroyed()) {
          await settleOperation(() => browserControl.setBrowserCdpActivity(wc, false), teardownTimeoutMs)
        }
      } catch {
        // best effort while the WebContents is being destroyed
      }
      try {
        if (!window.isDestroyed()) window.destroy()
      } finally {
        await Promise.all([
          settleOperation(() => visualSession.clearStorageData(), teardownTimeoutMs),
          settleOperation(() => visualSession.clearCache(), teardownTimeoutMs),
          settleOperation(() => visualSession.clearAuthCache(), teardownTimeoutMs),
        ])
      }
    })()
    return disposal
  }

  try {
    // The Node readiness probe connects directly to loopback. Keep Chromium on the same network path;
    // inherited PAC/system proxies can otherwise make the probe succeed while loadURL returns ERR_FAILED.
    // This remains inside the teardown boundary so a proxy setup failure also clears the isolated surface.
    await startupStep(
      visualSession.setProxy({ mode: 'direct' }),
      startupDeadline,
      options.signal,
      'network setup'
    )
    browserControl.attachToView(wc)
    // A fresh Electron WebContents may not finish Page.enable until its initial target/document starts.
    // Begin navigation first, matching the embedded browser path, while still attaching CDP early enough
    // to observe the initial load. Keep a rejection handler attached while CDP owns the startup await.
    const initialLoad = Promise.resolve(window.loadURL(initialUrl)).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error })
    )
    const [, loadOutcome] = await Promise.all([
      startupStep(
        Promise.resolve(browserControl.setBrowserCdpActivity(wc, true)),
        startupDeadline,
        options.signal,
        'CDP initialization'
      ),
      startupStep(initialLoad, startupDeadline, options.signal, 'page load'),
    ])
    if (loadOutcome.ok) {
      assertOrigin()
      mark('ready')
    } else {
      // A frontend with a redirect loop or another main-document failure is still a valid review
      // target. CDP is live and the isolated error surface can be inspected or navigated to another
      // same-origin route; only a hung load remains a bootstrap failure.
      assertAlive()
      mark('error', loadOutcome.error instanceof Error ? loadOutcome.error.message : String(loadOutcome.error))
    }
  } catch (error) {
    mark('error', error instanceof Error ? error.message : String(error))
    await dispose()
    throw error
  }

  const inspect = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertAlive()
    mark('inspecting')
    try {
      const result = await operation()
      assertOrigin()
      mark('ready')
      return result
    } catch (error) {
      if (!disposed) mark('error', error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  return {
    partition,
    origin,
    info: () => ({
      state,
      ...(!disposed && allowedUrl(wc.getURL(), origin) ? { url: allowedUrl(wc.getURL(), origin) as string } : {}),
    }),
    show: () => {
      if (disposed || window.isDestroyed()) return false
      window.show()
      window.focus()
      return true
    },
    navigate: (url) => {
      const target = allowedUrl(url, origin)
      if (!target) return Promise.reject(new Error('Navigation is limited to the approved local origin.'))
      return inspect(() => browserControl.navigate(wc, target))
    },
    reload: () => inspect(() => browserControl.navHistory(wc, 'reload')),
    waitFor: (input) => inspect(() => browserControl.waitFor(wc, input)),
    snapshot: () => inspect(() => browserControl.snapshot(wc)),
    screenshot: () =>
      inspect(async () => {
        const data = await browserControl.screenshot(wc, { signal: options.signal })
        let scroll: browserControl.ScrollPosition | null = null
        try {
          scroll = await browserControl.scrollPosition(wc, { signal: options.signal, timeoutMs: 1_000 })
        } catch (error) {
          if (options.signal?.aborted) throw error
        }
        const bounds = window.getContentBounds()
        return {
          data,
          metadata: {
            url: assertOrigin(),
            viewport: { width: bounds.width, height: bounds.height },
            scroll,
          },
        }
      }),
    readText: () => inspect(() => browserControl.readText(wc)),
    scroll: (input) => inspect(() => browserControl.scroll(wc, input)),
    consoleLogs: (level, limit) => inspect(() => browserControl.getConsoleLogs(wc, { level, limit })),
    networkLogs: (onlyErrors, limit) => inspect(() => browserControl.getNetworkLogs(wc, { onlyErrors, limit })),
    click: (ref) => inspect(() => browserControl.clickRef(wc, ref)),
    doubleClick: (ref) => inspect(() => browserControl.doubleClickRef(wc, ref)),
    type: (ref, text, submit) => inspect(() => browserControl.typeRef(wc, ref, text, submit)),
    pressKey: (key, modifiers) => inspect(() => browserControl.pressKey(wc, key, modifiers)),
    drag: (fromRef, toRef) => inspect(() => browserControl.dragRef(wc, fromRef, toRef)),
    dispose,
  }
}

/** Used by security-focused tests without exposing a generic navigation primitive. */
export const visualBrowserUrlAllowedForOrigin = allowedUrl
