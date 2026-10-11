import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow, clipboard, nativeImage, type WebContents, type WebContentsView } from 'electron'
import { dispatchPresentedKey, dispatchPresentedMouse, setPresentedFocusEmulation } from '../../../browser-control'
import { getBrowserState, presentedBrowserViews } from '../../../drawer-manager'
import { getFloatWin } from '../../../floating-manager'
import { setPresentedBrowserSize } from '../../../conversation-screen'
import type { ScreenArea } from '../../../conversation-screen'
import { tMain } from '../../../i18n'
import { ENVIRONMENT_WINDOW_FRAME, presentedBrowserBounds } from '../window-bounds'
import type { BrowserPresenterDeps, PresenterGeometry, PresenterIcon } from './browser-presenter'
import type { HitView, HitWindow, Rect } from './hit-test'

/** The icon of the presented browser window, from the dock's own browser icon. */
const BROWSER_ICON_SVG = '/opt/maestrly/desktop/icons/browser.svg'
const ICON_SIZE = 48

let icon: Promise<PresenterIcon | null> | null = null

/** Renders the browser icon once for every bot; null when it cannot, and the window simply has no icon. */
export function loadPresenterIcon(cacheFolder: string): Promise<PresenterIcon | null> {
  icon ??= (async () => {
    const png = path.join(cacheFolder, 'browser-icon.png')
    await mkdir(cacheFolder, { recursive: true, mode: 0o700 })
    await new Promise<void>((resolve, reject) =>
      execFile(
        'rsvg-convert',
        ['-w', String(ICON_SIZE), '-h', String(ICON_SIZE), '-o', png, BROWSER_ICON_SVG],
        { timeout: 10_000 },
        (error) => (error ? reject(error) : resolve())
      )
    )
    const image = nativeImage.createFromPath(png)
    if (image.isEmpty()) return null
    const { width, height } = image.getSize()
    // Electron gives BGRA bytes: read as little-endian 32-bit words, they are exactly the 0xAARRGGBB pixels X wants.
    return { width, height, argb: image.toBitmap() }
  })().catch(() => null)
  return icon
}

function visibleRect(rect: Rect): boolean {
  return rect.width > 0 && rect.height > 0 && rect.x > -10_000 && rect.y > -10_000
}

function viewOf(view: WebContentsView | null, content: Rect): HitView<WebContents> | null {
  if (!view || view.webContents.isDestroyed()) return null
  const bounds = view.getBounds()
  const rect = { x: content.x + bounds.x, y: content.y + bounds.y, width: bounds.width, height: bounds.height }
  return visibleRect(rect) ? { target: view.webContents, bounds: rect } : null
}

const isGeometry = (value: unknown): value is PresenterGeometry =>
  !!value &&
  typeof value === 'object' &&
  ['x', 'y', 'width', 'height'].every((key) => Number.isFinite((value as Record<string, unknown>)[key]))

/**
 * The Electron half of a bot's browser presenter: the bot's browser window, views and popups on the environment
 * display, and DevTools input into them. `area` is the bot's tile of the environment display.
 */
export function electronPresenterDeps(options: {
  conversationId(): string | null
  area: ScreenArea
  /** The bot's own cache folder, where the presented window's geometry is kept. */
  folder: string
  icon: PresenterIcon | null
  log(message: string): void
}): BrowserPresenterDeps<WebContents> & { applyFocusEmulation(): void } {
  const geometryFile = path.join(options.folder, 'presenter.json')
  let emulating = false
  const views = () => {
    const conversationId = options.conversationId()
    return conversationId ? presentedBrowserViews(conversationId) : { chrome: null, page: null, popups: [] }
  }
  const emulate = (enabled: boolean) => {
    const { chrome, page } = views()
    for (const view of [chrome, page]) {
      if (!view || view.webContents.isDestroyed()) continue
      void setPresentedFocusEmulation(view.webContents, enabled).catch((error: unknown) =>
        options.log(`Focus emulation failed: ${error instanceof Error ? error.message : String(error)}`)
      )
    }
  }
  return {
    windows: () => {
      const conversationId = options.conversationId()
      const browser = conversationId ? getFloatWin(conversationId, 'browser') : null
      if (!conversationId || !browser || browser.isDestroyed() || !browser.isVisible()) return []
      const { chrome, page, popups } = views()
      const content = browser.getContentBounds()
      const windows: HitWindow<WebContents>[] = []
      for (const popup of popups) {
        const inner = popup.getContentBounds()
        const frame = ENVIRONMENT_WINDOW_FRAME
        windows.push({
          kind: 'popup',
          id: popup.id,
          content: inner,
          frame: {
            x: inner.x - frame.left,
            y: inner.y - frame.top,
            width: inner.width + frame.left + frame.right,
            height: inner.height + frame.top + frame.bottom,
          },
          views: [],
          windowTarget: popup.webContents,
        })
      }
      windows.push({
        kind: 'browser',
        id: browser.id,
        frame: content,
        content,
        views: [viewOf(chrome, content), viewOf(page, content)].filter(
          (view): view is HitView<WebContents> => view !== null
        ),
        windowTarget: page?.webContents ?? browser.webContents,
      })
      return windows
    },
    origin: () => ({ x: options.area.x, y: options.area.y }),
    resize: (size) => {
      const bounds = presentedBrowserBounds(options.area, size)
      const conversationId = options.conversationId()
      if (conversationId) setPresentedBrowserSize(conversationId, { width: bounds.width, height: bounds.height })
      return { width: bounds.width, height: bounds.height }
    },
    // DevTools takes CSS pixels; a zoomed page has fewer of them than the window has pixels.
    mouse: async (target, event) => {
      if (target.isDestroyed()) return
      const zoom = target.getZoomFactor() || 1
      await dispatchPresentedMouse(target, { ...event, x: event.x / zoom, y: event.y / zoom })
    },
    key: async (target, event) => {
      if (!target.isDestroyed()) await dispatchPresentedKey(target, event)
    },
    edit: (target, command) => {
      if (!target.isDestroyed()) target[command]()
    },
    readClipboard: () => clipboard.readText(),
    writeClipboard: (text) => clipboard.writeText(text),
    movePopup: (window, origin) => {
      const popup = BrowserWindow.fromId(window.id)
      if (!popup || popup.isDestroyed()) return
      const frame = ENVIRONMENT_WINDOW_FRAME
      popup.setBounds({
        x: origin.x + frame.left,
        y: origin.y + frame.top,
        width: window.content.width,
        height: window.content.height,
      })
    },
    closePopup: (window) => {
      const popup = BrowserWindow.fromId(window.id)
      if (popup && !popup.isDestroyed()) popup.close()
    },
    focusEmulation: (enabled) => {
      emulating = enabled
      emulate(enabled)
    },
    applyFocusEmulation: () => {
      if (emulating) emulate(true)
    },
    defaultTarget: () => views().page?.webContents ?? null,
    title: () => {
      const name = tMain('main')('floating.browser')
      const conversationId = options.conversationId()
      if (!conversationId) return name
      const state = getBrowserState(conversationId)
      const active = state.tabs.find((tab) => tab.id === state.activeId)
      return active?.title ? `${name} — ${active.title}` : name
    },
    icon: () => options.icon,
    loadGeometry: async () => {
      try {
        const saved: unknown = JSON.parse(await readFile(geometryFile, 'utf8'))
        return isGeometry(saved) ? saved : null
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    saveGeometry: async (geometry) => {
      await mkdir(options.folder, { recursive: true, mode: 0o700 })
      await writeFile(geometryFile, JSON.stringify(geometry) + '\n', { mode: 0o600 })
    },
    log: options.log,
  }
}
