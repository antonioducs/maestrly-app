/**
 * Renders an inline HTML block offscreen, as a chat shows it, for the model that wrote it: a screenshot, the height the
 * block takes, and the problems the frame found. The block runs in the same sandboxed frame page and policy as in a
 * chat. A host page frames it from an in-memory session of its own, which grants no permission, opens no window,
 * downloads nothing, and is wiped after every preview.
 */
import { BrowserWindow, type NativeImage, session, type WebContents } from 'electron'
import {
  GENUI_WIDGET_FRAME_URL,
  GENUI_WIDGET_MAX_HEIGHT,
  GENUI_WIDGET_SCHEME,
  type GenUiWidgetIssueKind,
  parseGenUiWidgetMessage,
} from '../shared/genui-widget'
import { genUiWidgetFrameResponse } from '../shared/genui-widget-frame'

/** In memory only: no `persist:` prefix. */
export const GENUI_PREVIEW_PARTITION = 'genui-previews'
const HOST_URL = `${GENUI_WIDGET_SCHEME}://preview/`
/** About the width of the chat column. */
export const GENUI_PREVIEW_WIDTH = 700
export const GENUI_PREVIEW_MIN_WIDTH = 320
export const GENUI_PREVIEW_MAX_WIDTH = 1000
/** The app window's background, under the transparent frame. */
const BACKGROUND = '#0a0a0b'
/** A tall preview is cut into parts of at most this height, so a model that downsizes large images can still read it. */
const TILE_HEIGHT = 1200
const LOAD_TIMEOUT_MS = 10_000
/** Time a block gets to load its images, scripts and fonts; after it the screenshot shows the block as it is. */
const RENDER_TIMEOUT_MS = 15_000
/** After the block loaded and its checks ran: time for first animations and late layout. */
const SETTLE_MS = 600
const PAINT_TIMEOUT_MS = 3_000
const INITIAL_HEIGHT = 160

export interface GenUiPreview {
  /** PNG screenshots, top to bottom. */
  images: Buffer[]
  width: number
  height: number
  /** The block reached the frame's maximum height, or grows with the frame; its height was capped. */
  capped: boolean
  /** The block had not finished loading when the time ran out. */
  timedOut: boolean
  issues: Array<{ kind: GenUiWidgetIssueKind; detail: string }>
}

export class GenUiPreviewError extends Error {
  constructor(readonly code: 'load_timeout' | 'no_image' | 'aborted') {
    super(`Interface preview failed: ${code}`)
    this.name = 'GenUiPreviewError'
  }
}

const HOST_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><style>' +
  `html,body{margin:0;background:${BACKGROUND}}` +
  'iframe{display:block;width:100%;border:0;color-scheme:dark;background:transparent}' +
  '</style></head><body></body></html>'

const HOST_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; frame-src ${GENUI_WIDGET_SCHEME}:`,
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
}

let hardened = false

function previewSession(): Electron.Session {
  const ses = session.fromPartition(GENUI_PREVIEW_PARTITION, { cache: false })
  if (!hardened) {
    hardened = true
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    ses.setPermissionCheckHandler(() => false)
    ses.on('will-download', (event) => event.preventDefault())
    // The frame page as the chats get it, and the host page only this session knows.
    ses.protocol.handle(GENUI_WIDGET_SCHEME, (request) => {
      if (request.method === 'GET' && request.url === HOST_URL)
        return new Response(HOST_HTML, { status: 200, headers: HOST_HEADERS })
      const response = genUiWidgetFrameResponse(request)
      return new Response(response.body, { status: response.status, headers: response.headers })
    })
  }
  return ses
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
    () => new GenUiPreviewError('no_image')
  )
}

/**
 * Runs in the host page: frames the block, answers its frame like a chat does (the block, then each height it asks
 * for), and resolves with what the frame said once it loaded and settled. Only plain, bounded fields leave the page.
 */
export function previewScript(html: string): string {
  return `new Promise(function (resolve) {
  var html = ${JSON.stringify(html)};
  var frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.style.height = '${INITIAL_HEIGHT}px';
  var messages = [];
  var loaded = false;
  var settle = 0;
  var limit = setTimeout(function () { done(true); }, ${RENDER_TIMEOUT_MS});
  function done(timedOut) {
    clearTimeout(limit);
    clearTimeout(settle);
    resolve({ messages: messages, timedOut: timedOut });
  }
  window.addEventListener('message', function (event) {
    if (event.source !== frame.contentWindow) return;
    var data = event.data;
    if (!data || typeof data !== 'object' || data.source !== 'maestrly-widget') return;
    if (messages.length < 100) {
      messages.push({
        source: 'maestrly-widget',
        type: String(data.type).slice(0, 20),
        height: typeof data.height === 'number' ? data.height : null,
        kind: typeof data.kind === 'string' ? data.kind.slice(0, 20) : null,
        detail: typeof data.detail === 'string' ? data.detail.slice(0, 300) : null
      });
    }
    if (data.type === 'ready') {
      frame.contentWindow.postMessage({ source: 'maestrly-host', type: 'render', html: html, theme: {} }, '*');
    } else if (data.type === 'size' && typeof data.height === 'number' && isFinite(data.height)) {
      frame.style.height = Math.max(24, Math.min(Math.ceil(data.height), ${GENUI_WIDGET_MAX_HEIGHT})) + 'px';
    }
    if (data.type === 'loaded') loaded = true;
    if (loaded) {
      clearTimeout(settle);
      settle = setTimeout(function () { done(false); }, ${SETTLE_MS});
    }
  });
  frame.src = ${JSON.stringify(GENUI_WIDGET_FRAME_URL)};
  document.body.appendChild(frame);
})`
}

/** What the frame said, checked like the chat checks it: the last height it asked for, and each issue once. */
export function readPreviewMessages(messages: unknown): Pick<GenUiPreview, 'height' | 'capped' | 'issues'> {
  let height = INITIAL_HEIGHT
  let capped = false
  const issues: GenUiPreview['issues'] = []
  for (const raw of Array.isArray(messages) ? messages.slice(0, 100) : []) {
    const message = parseGenUiWidgetMessage(raw)
    if (message?.type === 'size') {
      height = Math.max(24, message.height)
      capped = message.height >= GENUI_WIDGET_MAX_HEIGHT
    } else if (message?.type === 'issue') {
      if (message.kind === 'viewport') capped = true
      if (!issues.some((issue) => issue.kind === message.kind && issue.detail === message.detail))
        issues.push({ kind: message.kind, detail: message.detail })
    }
  }
  return { height, capped, issues: issues.slice(0, 20) }
}

/** Cuts the painted window to the block, at one CSS pixel per pixel, in parts of at most TILE_HEIGHT. */
export function previewImages(frame: NativeImage, width: number, height: number): Buffer[] {
  const size = frame.getSize()
  const scale = size.width / width
  if (!(scale > 0)) throw new GenUiPreviewError('no_image')
  const images: Buffer[] = []
  for (let top = 0; top < height; top += TILE_HEIGHT) {
    const y = Math.round(top * scale)
    const tile = Math.min(Math.round(Math.min(TILE_HEIGHT, height - top) * scale), size.height - y)
    if (tile < 1) break
    let image = frame.crop({ x: 0, y, width: size.width, height: tile })
    if (scale !== 1) image = image.resize({ width, quality: 'good' })
    images.push(image.toPNG())
  }
  if (!images.length) throw new GenUiPreviewError('no_image')
  return images
}

async function capture(html: string, width: number, signal: AbortSignal): Promise<GenUiPreview> {
  if (signal.aborted) throw new GenUiPreviewError('aborted')
  const ses = previewSession()
  const window = new BrowserWindow({
    show: false,
    width,
    height: GENUI_WIDGET_MAX_HEIGHT,
    useContentSize: true,
    skipTaskbar: true,
    focusable: false,
    backgroundColor: BACKGROUND,
    webPreferences: {
      partition: GENUI_PREVIEW_PARTITION,
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
  const abort = () => {
    if (!window.isDestroyed()) window.destroy()
  }
  signal.addEventListener('abort', abort, { once: true })
  wc.setAudioMuted(true)
  wc.setFrameRate(15)
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('will-navigate', (event) => event.preventDefault())
  wc.on('will-redirect', (event) => event.preventDefault())
  // The host page frames the frame page; nothing navigates anywhere else.
  wc.on('will-frame-navigate', (event) => {
    if (event.url !== (event.isMainFrame ? HOST_URL : GENUI_WIDGET_FRAME_URL)) event.preventDefault()
  })
  try {
    await within(wc.loadURL(HOST_URL), LOAD_TIMEOUT_MS, () => new GenUiPreviewError('load_timeout'))
    const result = (await wc.executeJavaScript(previewScript(html))) as { messages?: unknown; timedOut?: unknown }
    const read = readPreviewMessages(result?.messages)
    if (signal.aborted) throw new GenUiPreviewError('aborted')
    return {
      images: previewImages(await nextPaint(wc), width, read.height),
      width,
      ...read,
      timedOut: result?.timedOut === true,
    }
  } catch (error) {
    throw signal.aborted ? new GenUiPreviewError('aborted') : error
  } finally {
    signal.removeEventListener('abort', abort)
    abort()
    await ses.clearStorageData().catch(() => undefined)
  }
}

let queue: Promise<unknown> = Promise.resolve()

/** Renders one block at a time: each preview gets the whole offscreen renderer. */
export function renderGenUiPreview(input: {
  html: string
  width?: number
  signal: AbortSignal
}): Promise<GenUiPreview> {
  const width = Math.round(
    Math.min(Math.max(input.width ?? GENUI_PREVIEW_WIDTH, GENUI_PREVIEW_MIN_WIDTH), GENUI_PREVIEW_MAX_WIDTH)
  )
  const run = queue.then(() => capture(input.html, width, input.signal))
  queue = run.catch(() => undefined)
  return run
}
