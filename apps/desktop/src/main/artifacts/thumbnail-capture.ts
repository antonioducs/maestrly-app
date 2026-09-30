/**
 * Renders an artifact version offscreen and returns a JPEG preview of its content frame. The page is untrusted: it
 * loads through the owner view in its sandboxed frame, in an in-memory partition that grants no permission, opens no
 * window, downloads nothing, and is wiped after every capture.
 */
import { ARTIFACT_HEADER, MAX_THUMBNAIL_BYTES } from '@maestrly/artifact-host'
import { BrowserWindow, type NativeImage, session, webFrameMain, type WebContents } from 'electron'

/** In memory only: no `persist:` prefix, and never the drawer browser's partition. */
export const THUMBNAIL_PARTITION = 'artifact-thumbnails'
export const THUMBNAIL_WIDTH = 640
/** Previews keep a 16:10 frame; taller pages show their top. */
const THUMBNAIL_RATIO = 10 / 16
const VIEWPORT = { width: 1280, height: 880 }
const LOAD_TIMEOUT_MS = 20_000
/** Time for scripts, fonts and first animations after the content frame loads. */
const SETTLE_MS = 1_500
const PAINT_TIMEOUT_MS = 3_000
const LEAVE_TIMEOUT_MS = 2_000
const JPEG_QUALITIES = [80, 65, 50]

export class ThumbnailCaptureError extends Error {
  constructor(readonly code: 'load_timeout' | 'no_frame' | 'no_image' | 'too_large') {
    super(`Thumbnail capture failed: ${code}`)
    this.name = 'ThumbnailCaptureError'
  }
}

interface FrameRect {
  x: number
  y: number
  width: number
  height: number
  viewport: number
}

let hardened = false

function thumbnailSession(): Electron.Session {
  const ses = session.fromPartition(THUMBNAIL_PARTITION, { cache: false })
  if (!hardened) {
    hardened = true
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    ses.setPermissionCheckHandler(() => false)
    ses.on('will-download', (event) => event.preventDefault())
  }
  return ses
}

const sameOrigin = (url: string, origin: string): boolean => {
  try {
    return new URL(url).origin === origin
  } catch {
    return false
  }
}

function within<T>(promise: Promise<T>, ms: number, error: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(error()), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Resolves once the sandboxed content frame of the owner view has loaded; nothing runs inside that frame. */
function contentFrameLoaded(wc: WebContents, origin: string): Promise<void> {
  return new Promise((resolve) => {
    wc.on('did-frame-finish-load', (_event, isMainFrame, processId, routingId) => {
      if (isMainFrame) return
      const frame = webFrameMain.fromId(processId, routingId)
      if (frame?.url.startsWith(`${origin}/c/`)) resolve()
    })
  })
}

/** The next full frame the offscreen renderer paints after an invalidation. */
function nextPaint(wc: WebContents): Promise<NativeImage> {
  return within(
    new Promise<NativeImage>((resolve) => {
      const onPaint = (_event: Electron.Event, _dirty: Electron.Rectangle, image: NativeImage) => {
        if (image.isEmpty()) return
        wc.removeListener('paint', onPaint)
        resolve(image)
      }
      wc.on('paint', onPaint)
      wc.invalidate()
    }),
    PAINT_TIMEOUT_MS,
    () => new ThumbnailCaptureError('no_image')
  )
}

/** Crops the content frame to a 16:10 preview and encodes it within the host's thumbnail limit. */
export function encodeThumbnail(frame: NativeImage, rect: FrameRect): Uint8Array {
  const size = frame.getSize()
  const scale = size.width / rect.viewport
  const x = Math.max(0, Math.round(rect.x * scale))
  const y = Math.max(0, Math.round(rect.y * scale))
  const width = Math.min(Math.round(rect.width * scale), size.width - x)
  const height = Math.min(Math.round(rect.height * scale), size.height - y, Math.round(width * THUMBNAIL_RATIO))
  if (width < 16 || height < 16) throw new ThumbnailCaptureError('no_image')
  const preview = frame.crop({ x, y, width, height }).resize({
    width: THUMBNAIL_WIDTH,
    height: Math.round((THUMBNAIL_WIDTH * height) / width),
    quality: 'good',
  })
  for (const quality of JPEG_QUALITIES) {
    const jpeg = preview.toJPEG(quality)
    if (jpeg.byteLength <= MAX_THUMBNAIL_BYTES) return new Uint8Array(jpeg)
  }
  throw new ThumbnailCaptureError('too_large')
}

/** Captures the owner view at `url` (a fresh single-use owner link) and returns the JPEG preview. */
export async function captureArtifactThumbnail(url: string): Promise<Uint8Array> {
  const origin = new URL(url).origin
  const ses = thumbnailSession()
  // Only the owner view's own origin may load as a page; subresources follow the content's CSP.
  ses.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: details.resourceType === 'mainFrame' && !sameOrigin(details.url, origin) })
  )
  const window = new BrowserWindow({
    show: false,
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    useContentSize: true,
    skipTaskbar: true,
    focusable: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      partition: THUMBNAIL_PARTITION,
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
      spellcheck: false,
      devTools: false,
    },
  })
  const wc = window.webContents
  wc.setAudioMuted(true)
  wc.setFrameRate(15)
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  const guard = (event: Electron.Event, target: string) => {
    if (!sameOrigin(target, origin)) event.preventDefault()
  }
  wc.on('will-navigate', guard)
  wc.on('will-redirect', guard)
  try {
    const loaded = contentFrameLoaded(wc, origin)
    // The URL carries a ticket in its fragment: failures are reported without it.
    await within(
      Promise.all([wc.loadURL(url).catch(() => undefined), loaded]),
      LOAD_TIMEOUT_MS,
      () => new ThumbnailCaptureError('load_timeout')
    )
    await delay(SETTLE_MS)
    const rect = (await wc.executeJavaScript(
      `(() => {
        const frame = document.querySelector('iframe.content')
        if (!frame) return null
        const r = frame.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height, viewport: window.innerWidth }
      })()`
    )) as FrameRect | null
    if (!rect || rect.viewport <= 0) throw new ThumbnailCaptureError('no_frame')
    return encodeThumbnail(await nextPaint(wc), rect)
  } finally {
    // Ends the owner session the capture opened, from the viewer itself, then forgets its cookie.
    await within(
      wc.isDestroyed()
        ? Promise.resolve()
        : wc.executeJavaScript(
            `fetch(location.pathname + '/api/session', { method: 'DELETE', credentials: 'same-origin', headers: { '${ARTIFACT_HEADER}': '1' } }).then((r) => r.status, () => 0)`
          ),
      LEAVE_TIMEOUT_MS,
      () => new Error('leave timeout')
    ).catch(() => undefined)
    if (!window.isDestroyed()) window.destroy()
    await ses.clearStorageData().catch(() => undefined)
  }
}
