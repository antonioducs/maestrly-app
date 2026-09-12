import type { WebContents } from 'electron'
import * as browserControl from '../../browser-control'
import { BROWSER_PARTITION, acquireBrowserTabForControl, type AcquiredBrowserTab } from '../../drawer/browser'
import type { BrowserSurface, BrowserSurfaceInfo, BrowserSurfaceState } from '../browser-surface'
import { normalizeLoopbackPreviewUrl } from './preview-runtime'

export interface DrawerBrowserSurfaceOptions {
  convId: string
  tabId: string
  url: string
  signal?: AbortSignal
  onStateChange?: (info: BrowserSurfaceInfo) => void
  /** Internal seam for focused tests; production callers use the exact-tab drawer acquisition API. */
  acquireTab?: (convId: string, tabId: string) => AcquiredBrowserTab
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

/**
 * Attaches automation to a user-owned embedded drawer tab. The tab, its persistent session, and its
 * cookies remain owned by the drawer; this adapter only owns listeners and an activity lease.
 */
export async function createDrawerBrowserSurface(options: DrawerBrowserSurfaceOptions): Promise<BrowserSurface> {
  const initialUrl = normalizeLoopbackPreviewUrl(options.url)
  if (!initialUrl) throw new Error('Drawer browser review requires an HTTP loopback URL.')
  if (options.signal?.aborted) throw new Error('Drawer browser review startup aborted.')
  const origin = new URL(initialUrl).origin
  const acquired = (options.acquireTab ?? acquireBrowserTabForControl)(options.convId, options.tabId)
  const wc = acquired.webContents
  let state: BrowserSurfaceState = 'starting'
  let disposed = false
  let disposal: Promise<void> | null = null

  const currentUrl = (): string | undefined => {
    if (disposed || !acquired.isCurrent()) return undefined
    return allowedUrl(wc.getURL(), origin) ?? undefined
  }
  const emitState = () => options.onStateChange?.({ state, ...(currentUrl() ? { url: currentUrl() } : {}) })
  const mark = (next: BrowserSurfaceState) => {
    state = next
    emitState()
  }
  const assertAlive = () => {
    if (disposed || wc.isDestroyed() || !acquired.isCurrent()) {
      throw new Error('Drawer browser tab was closed, destroyed, or replaced.')
    }
    if (options.signal?.aborted) throw new Error('Drawer browser operation aborted.')
  }
  const assertOrigin = (): string => {
    assertAlive()
    const current = allowedUrl(wc.getURL(), origin)
    if (!current) {
      wc.stop()
      mark('error')
      throw new Error('Drawer browser navigation escaped the approved origin and was blocked.')
    }
    return current
  }
  const rejectCrossOrigin = (event: Electron.Event, url: string) => {
    if (allowedUrl(url, origin)) return
    event.preventDefault()
    wc.stop()
    mark('error')
  }
  const detectCrossOrigin = (_event: Electron.Event, url: string) => {
    if (allowedUrl(url, origin)) return
    wc.stop()
    mark('error')
  }
  const onDestroyed = () => mark('error')
  const onAbort = () => void dispose()

  wc.on('will-navigate', rejectCrossOrigin)
  wc.on('will-redirect', rejectCrossOrigin)
  wc.on('did-navigate', detectCrossOrigin)
  wc.once('destroyed', onDestroyed)
  options.signal?.addEventListener('abort', onAbort, { once: true })

  function dispose(): Promise<void> {
    if (disposal) return disposal
    disposed = true
    options.signal?.removeEventListener('abort', onAbort)
    wc.removeListener('will-navigate', rejectCrossOrigin)
    wc.removeListener('will-redirect', rejectCrossOrigin)
    wc.removeListener('did-navigate', detectCrossOrigin)
    wc.removeListener('destroyed', onDestroyed)
    // The WebContents and persistent session are user-owned. In particular, do not stop/close the tab
    // or clear storage/cache/auth data here.
    acquired.release()
    disposal = Promise.resolve()
    return disposal
  }

  try {
    assertAlive()
    browserControl.attachToView(wc)
    await browserControl.setBrowserCdpActivity(wc, true)
    assertAlive()
    assertOrigin()
    mark('ready')
  } catch (error) {
    mark('error')
    await dispose()
    throw error
  }

  const inspect = async <T>(operation: (webContents: WebContents) => Promise<T>): Promise<T> => {
    assertAlive()
    assertOrigin()
    mark('inspecting')
    try {
      const result = await operation(wc)
      assertOrigin()
      mark('ready')
      return result
    } catch (error) {
      if (!disposed) mark('error')
      throw error
    }
  }

  return {
    partition: BROWSER_PARTITION,
    origin,
    info: () => ({ state, ...(currentUrl() ? { url: currentUrl() } : {}) }),
    show: () => !disposed && acquired.isCurrent() && acquired.show(),
    navigate: (url) => {
      const target = allowedUrl(url, origin)
      if (!target) return Promise.reject(new Error('Navigation is limited to the approved local origin.'))
      return inspect((webContents) => browserControl.navigate(webContents, target))
    },
    reload: () => inspect((webContents) => browserControl.navHistory(webContents, 'reload')),
    waitFor: (input) => inspect((webContents) => browserControl.waitFor(webContents, input)),
    snapshot: () => inspect((webContents) => browserControl.snapshot(webContents)),
    screenshot: () =>
      inspect(async (webContents) => {
        const data = await browserControl.screenshot(webContents, {
          signal: options.signal,
            captureFrame: acquired.captureFrame,
        })
        let scroll: browserControl.ScrollPosition | null = null
        try {
          scroll = await browserControl.scrollPosition(webContents, {
            signal: options.signal,
            timeoutMs: 1_000,
          })
        } catch (error) {
          if (options.signal?.aborted) throw error
        }
        const bounds = acquired.getBounds()
        return {
          data,
          metadata: {
            url: assertOrigin(),
            viewport: { width: bounds.width, height: bounds.height },
            scroll,
          },
        }
      }),
    readText: () => inspect((webContents) => browserControl.readText(webContents)),
    scroll: (input) => inspect((webContents) => browserControl.scroll(webContents, input)),
    consoleLogs: (level, limit) =>
      inspect((webContents) => browserControl.getConsoleLogs(webContents, { level, limit })),
    networkLogs: (onlyErrors, limit) =>
      inspect((webContents) => browserControl.getNetworkLogs(webContents, { onlyErrors, limit })),
    click: (ref) => inspect((webContents) => browserControl.clickRef(webContents, ref)),
    doubleClick: (ref) => inspect((webContents) => browserControl.doubleClickRef(webContents, ref)),
    type: (ref, text, clear) => inspect((webContents) => browserControl.typeRef(webContents, ref, text, clear)),
    pressKey: (key, modifiers) => inspect((webContents) => browserControl.pressKey(webContents, key, modifiers)),
    drag: (fromRef, toRef) => inspect((webContents) => browserControl.dragRef(webContents, fromRef, toRef)),
    dispose,
  }
}

/** Used by policy tests and integrations that need to preflight a URL before acquiring a user tab. */
export const drawerBrowserUrlAllowedForOrigin = allowedUrl
