import { randomBytes } from 'node:crypto'
import { ClipboardItem, clipboard, type BrowserWindow, type WebContents } from 'electron'
import {
  BROWSER_STREAM_LIMITS,
  browserStreamCursor,
  isBrowserStreamId,
  parseBrowserStreamInput,
  type BrowserSelectRequest,
  type BrowserStreamCursor,
  type BrowserStreamEndReason,
  type BrowserStreamEnded,
  type BrowserStreamFrame,
  type BrowserStreamInput,
  type BrowserStreamNotice,
  type BrowserStreamSource,
  type BrowserStreamStarted,
} from '../../shared/browser-stream'
import {
  dispatchPresentedKey,
  dispatchPresentedMouse,
  ensureBrowserDebugger,
  insertPresentedText,
  setPresentedFocusEmulation,
} from '../browser-control'
import { isRemoteUiTarget } from '../remote-ui-targets'
import { isServerMode } from '../remote-host/server/config'
import { getConversation } from '../store'
import { ensureBrowser, onBrowserPopupsChange, onBrowserStateChange, presentedBrowserViews } from './browser'
import { chooseSelectOption, interceptSelects, readPageSelection, type PageSelectRequest } from './browser-stream-page'
import { onStreamWindowClosed, presentBrowserForStream, releaseBrowserStream } from './stream-window'

/**
 * The browser of a conversation on a workspaces host, streamed to the window of the computer that watches it (see
 * shared/browser-stream). The page paints in its stream window (drawer/stream-window); its DevTools session sends
 * JPEG frames, which go to the one renderer that started the stream. Pacing is end to end: the page's next frame is
 * acknowledged to Chromium only once the window acknowledged a frame, so at most two frames are on their way and a
 * slow link lowers the frame rate instead of filling the bridge. Input from the window goes to the page's DevTools
 * session; nothing touches the host's display.
 */

/** What the stream needs of a renderer of another computer (a remote-host VirtualSender). */
export interface StreamViewer {
  readonly id: number
  send(channel: string, ...args: unknown[]): void
  isDestroyed(): boolean
  once(event: 'destroyed', listener: () => void): unknown
  removeListener(event: 'destroyed', listener: () => void): unknown
}

/** After the last viewer leaves, the page stays in its stream window for this long, in case one comes back. */
export const STREAM_RELEASE_GRACE_MS = 15_000
const QUALITY = { normal: 70, reduced: 50 } as const
/** Width and height of a frame while the link is slow. */
const REDUCED_FRAME_SIDE = 960
const RTT_SAMPLES = 12
const RTT_MIN_SAMPLES = 8
const SLOW_RTT_MS = 300
const FAST_RTT_MS = 120
const QUALITY_HOLD_MS = 5_000
/** A frame unacknowledged this long is counted as lost, so one missing acknowledgement cannot stall the stream. */
const FRAME_ACK_TIMEOUT_MS = 10_000
const COPY_SETTLE_MS = 500
const COPY_POLL_MS = 25
/** The page reads the clipboard after `paste()` returns; the next clipboard user waits this long. */
const PASTE_HOLD_MS = 150

interface Source {
  id: number
  kind: 'tab' | 'popup'
  wc: WebContents
  popup: BrowserWindow | null
  /** Increases each time the screencast (re)starts; acknowledgements of an earlier one are not passed to Chromium. */
  epoch: number
  cursor: string | null
  detach: () => void
}

interface InFlight {
  sentAt: number
  source: number
  epoch: number
  sessionId: number
}

interface Stream {
  convId: string
  streamId: string
  viewer: StreamViewer
  onViewerGone: () => void
  size: { width: number; height: number }
  sourceSeq: number
  source: Source | null
  nextSeq: number
  inFlight: Map<number, InFlight>
  /** The newest frame Chromium sent while two were on their way, not yet acknowledged to it. */
  held: { source: number; epoch: number; params: ScreencastFrameParams } | null
  quality: keyof typeof QUALITY
  qualityChangedAt: number
  rtts: number[]
  focused: boolean
  input: Promise<void>
}

interface ScreencastFrameParams {
  data: string
  sessionId: number
  metadata: { deviceWidth?: number; deviceHeight?: number }
}

const streams = new Map<string, Stream>()
const releaseTimers = new Map<string, ReturnType<typeof setTimeout>>()
let clipboardTail: Promise<unknown> = Promise.resolve()
let listening = false

function listen(): void {
  if (listening) return
  listening = true
  onBrowserStateChange((convId) => {
    const stream = streams.get(convId)
    if (stream) syncSource(stream)
  })
  onBrowserPopupsChange((convId) => {
    const stream = streams.get(convId)
    if (stream) syncSource(stream)
  })
  onStreamWindowClosed((convId) => {
    const timer = releaseTimers.get(convId)
    if (timer) clearTimeout(timer)
    releaseTimers.delete(convId)
    const stream = streams.get(convId)
    if (stream) end(stream, 'unavailable')
  })
}

const sendCdp = (wc: WebContents, method: string, params?: Record<string, unknown>): Promise<unknown> =>
  wc.debugger.sendCommand(method, params)

/** Serializes everything that uses the host's one clipboard (copies and pastes of every stream). */
function withClipboard<T>(operation: () => Promise<T>): Promise<T> {
  const result = clipboardTail.catch(() => {}).then(operation)
  clipboardTail = result.catch(() => {})
  return result
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function notify<T extends object>(stream: Stream, channel: string, payload: T): void {
  if (streams.get(stream.convId) !== stream || stream.viewer.isDestroyed()) return
  try {
    stream.viewer.send(channel, payload)
  } catch {
    /* A viewer that went away is handled by its destroyed event. */
  }
}

/** The page the viewer sees: the newest sign-in window above the browser, else its active tab. */
function currentTarget(convId: string): { kind: 'tab' | 'popup'; wc: WebContents; popup: BrowserWindow | null } | null {
  const { page, popups } = presentedBrowserViews(convId)
  const popup = popups.find((child) => !child.isDestroyed() && !child.webContents.isDestroyed())
  if (popup) return { kind: 'popup', wc: popup.webContents, popup }
  if (page && !page.webContents.isDestroyed()) return { kind: 'tab', wc: page.webContents, popup: null }
  return null
}

function sourceEvent(stream: Stream): BrowserStreamSource {
  const source = stream.source
  const popup =
    source?.kind === 'popup' && !source.wc.isDestroyed()
      ? { url: source.wc.getURL().slice(0, 2048), title: source.wc.getTitle().slice(0, 300) }
      : null
  return {
    convId: stream.convId,
    streamId: stream.streamId,
    source: stream.sourceSeq,
    kind: source?.kind ?? 'none',
    popup,
  }
}

function screencastParams(stream: Stream): Record<string, unknown> {
  const reduced = stream.quality === 'reduced'
  return {
    format: 'jpeg',
    quality: QUALITY[stream.quality],
    // A HiDPI host would otherwise send frames at twice the size the viewer's surface shows.
    maxWidth: reduced ? Math.min(REDUCED_FRAME_SIDE, stream.size.width) : stream.size.width,
    maxHeight: reduced ? Math.min(REDUCED_FRAME_SIDE, stream.size.height) : stream.size.height,
    everyNthFrame: 1,
  }
}

async function startScreencast(stream: Stream, source: Source): Promise<void> {
  const epoch = ++source.epoch
  stream.held = null
  await sendCdp(source.wc, 'Page.stopScreencast').catch(() => {})
  if (stream.source !== source || source.epoch !== epoch) return
  await sendCdp(source.wc, 'Page.startScreencast', screencastParams(stream))
  // A page that does not change paints no new frame by itself: the viewer still needs its current picture.
  if (!source.wc.isDestroyed()) source.wc.invalidate()
}

function restartScreencast(stream: Stream): void {
  const source = stream.source
  if (source) void startScreencast(stream, source).catch(() => {})
}

/** Frames still on their way to the window; one unacknowledged for too long no longer counts. */
function framesInFlight(stream: Stream, now: number): number {
  for (const [seq, frame] of stream.inFlight) {
    if (now - frame.sentAt > FRAME_ACK_TIMEOUT_MS) stream.inFlight.delete(seq)
  }
  return stream.inFlight.size
}

function forward(stream: Stream, source: Source, epoch: number, params: ScreencastFrameParams): void {
  const seq = ++stream.nextSeq
  stream.inFlight.set(seq, { sentAt: Date.now(), source: source.id, epoch, sessionId: params.sessionId })
  const width = Math.round(params.metadata?.deviceWidth ?? stream.size.width)
  const height = Math.round(params.metadata?.deviceHeight ?? stream.size.height)
  const frame: BrowserStreamFrame = {
    convId: stream.convId,
    streamId: stream.streamId,
    source: source.id,
    seq,
    width,
    height,
    data: params.data,
  }
  notify(stream, 'drawer:browser-frame', frame)
}

function onScreencastFrame(stream: Stream, source: Source, params: ScreencastFrameParams): void {
  if (typeof params?.data !== 'string' || typeof params.sessionId !== 'number') return
  if (streams.get(stream.convId) !== stream || stream.source !== source) {
    void sendCdp(source.wc, 'Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {})
    return
  }
  if (framesInFlight(stream, Date.now()) >= BROWSER_STREAM_LIMITS.maxFramesInFlight) {
    // Chromium keeps at most a few frames unacknowledged, so this is the last one it sends until the window catches
    // up. A frame it replaces is acknowledged, or Chromium would count it forever.
    const replaced = stream.held
    stream.held = { source: source.id, epoch: source.epoch, params }
    if (replaced)
      void sendCdp(source.wc, 'Page.screencastFrameAck', { sessionId: replaced.params.sessionId }).catch(() => {})
    return
  }
  forward(stream, source, source.epoch, params)
}

function adaptQuality(stream: Stream, now: number): void {
  if (stream.rtts.length < RTT_MIN_SAMPLES || now - stream.qualityChangedAt < QUALITY_HOLD_MS) return
  const sorted = [...stream.rtts].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const next =
    stream.quality === 'normal' && median > SLOW_RTT_MS
      ? 'reduced'
      : stream.quality === 'reduced' && median < FAST_RTT_MS
        ? 'normal'
        : null
  if (!next) return
  stream.quality = next
  stream.qualityChangedAt = now
  stream.rtts = []
  restartScreencast(stream)
}

function detachSource(stream: Stream): void {
  const source = stream.source
  if (!source) return
  stream.source = null
  stream.held = null
  source.detach()
}

/** Follows the page the viewer should see: a sign-in window that opened or closed, another active tab. */
function syncSource(stream: Stream): void {
  if (streams.get(stream.convId) !== stream) return
  const target = currentTarget(stream.convId)
  if (target && stream.source?.wc === target.wc) return
  detachSource(stream)
  stream.sourceSeq++
  if (!target) {
    notify(stream, 'drawer:browser-stream-source', sourceEvent(stream))
    return
  }
  attachSource(stream, target)
}

function attachSource(
  stream: Stream,
  target: { kind: 'tab' | 'popup'; wc: WebContents; popup: BrowserWindow | null }
): void {
  const { wc } = target
  const cleanups: Array<() => void> = []
  const source: Source = {
    id: stream.sourceSeq,
    kind: target.kind,
    wc,
    popup: target.popup,
    epoch: 0,
    cursor: null,
    detach: () => {
      for (const cleanup of cleanups.splice(0)) {
        try {
          cleanup()
        } catch {
          /* The page may be gone already. */
        }
      }
      if (wc.isDestroyed()) return
      void sendCdp(wc, 'Page.stopScreencast').catch(() => {})
      void sendCdp(wc, 'Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {})
      if (stream.focused) void setPresentedFocusEmulation(wc, false).catch(() => {})
    },
  }
  stream.source = source
  const current = (): boolean => streams.get(stream.convId) === stream && stream.source === source

  const onMessage = (_event: unknown, method: string, params: unknown): void => {
    if (method === 'Page.screencastFrame') onScreencastFrame(stream, source, params as ScreencastFrameParams)
    else if (method === 'Page.fileChooserOpened' && current()) {
      const notice: BrowserStreamNotice = { convId: stream.convId, streamId: stream.streamId, notice: 'file-chooser' }
      notify(stream, 'drawer:browser-stream-notice', notice)
    }
  }
  const onCursor = (_event: unknown, type: unknown): void => {
    if (!current()) return
    const cursor = browserStreamCursor(type)
    if (cursor === source.cursor) return
    source.cursor = cursor
    const payload: BrowserStreamCursor = { convId: stream.convId, streamId: stream.streamId, cursor }
    notify(stream, 'drawer:browser-cursor', payload)
  }
  const onDestroyed = (): void => {
    if (current()) syncSource(stream)
  }
  // A sign-in window's banner shows its address and title as they change.
  const onPopupChanged = (): void => {
    if (current() && source.kind === 'popup') notify(stream, 'drawer:browser-stream-source', sourceEvent(stream))
  }
  wc.debugger.on('message', onMessage)
  wc.on('cursor-changed', onCursor)
  wc.once('destroyed', onDestroyed)
  cleanups.push(
    () => wc.debugger.removeListener('message', onMessage),
    () => wc.removeListener('cursor-changed', onCursor),
    () => wc.removeListener('destroyed', onDestroyed)
  )
  if (source.kind === 'popup') {
    wc.on('page-title-updated', onPopupChanged)
    wc.on('did-navigate', onPopupChanged)
    cleanups.push(
      () => wc.removeListener('page-title-updated', onPopupChanged),
      () => wc.removeListener('did-navigate', onPopupChanged)
    )
  }
  const onSelect = (request: PageSelectRequest): void => {
    if (!current()) return
    const zoom = wc.isDestroyed() ? 1 : wc.getZoomFactor() || 1
    const event: BrowserSelectRequest = {
      convId: stream.convId,
      streamId: stream.streamId,
      source: source.id,
      requestId: request.requestId,
      options: request.options,
      selectedIndex: request.selectedIndex,
      rect: {
        x: request.rect.x * zoom,
        y: request.rect.y * zoom,
        width: request.rect.width * zoom,
        height: request.rect.height * zoom,
      },
    }
    notify(stream, 'drawer:browser-select', event)
  }

  notify(stream, 'drawer:browser-stream-source', sourceEvent(stream))
  void (async () => {
    await ensureBrowserDebugger(wc)
    if (!current()) return
    cleanups.push(interceptSelects(wc, onSelect))
    // A file chooser would open a dialog nobody sees on the host: the page's request is reported instead.
    await sendCdp(wc, 'Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => {})
    if (!current()) return
    if (stream.focused) await setPresentedFocusEmulation(wc, true).catch(() => {})
    if (!current()) return
    await startScreencast(stream, source)
  })().catch(() => {
    // The page could not be streamed (it closed, or another debugger holds it): the viewer sees no page.
    if (!current()) return
    detachSource(stream)
    stream.sourceSeq++
    notify(stream, 'drawer:browser-stream-source', sourceEvent(stream))
  })
}

function scheduleRelease(convId: string): void {
  const previous = releaseTimers.get(convId)
  if (previous) clearTimeout(previous)
  const timer = setTimeout(() => {
    releaseTimers.delete(convId)
    if (!streams.has(convId)) releaseBrowserStream(convId)
  }, STREAM_RELEASE_GRACE_MS)
  timer.unref?.()
  releaseTimers.set(convId, timer)
}

/** Ends a stream; `notifyReason` tells its viewer why, when it is still there to hear it. */
function end(stream: Stream, notifyReason: BrowserStreamEndReason | null): void {
  if (streams.get(stream.convId) !== stream) return
  if (notifyReason) {
    const ended: BrowserStreamEnded = { convId: stream.convId, streamId: stream.streamId, reason: notifyReason }
    notify(stream, 'drawer:browser-stream-ended', ended)
  }
  detachSource(stream)
  streams.delete(stream.convId)
  stream.viewer.removeListener('destroyed', stream.onViewerGone)
}

class BrowserStreamError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message)
  }
}

function checkViewer(sender: unknown): StreamViewer {
  // A window of this host shows its browser natively; only another computer's renderer watches it here.
  if (!isServerMode() || !isRemoteUiTarget(sender))
    throw new BrowserStreamError('The browser stream is for remote viewers only.', 'remote-viewer-only')
  return sender as StreamViewer
}

/** The stream `streamId` of this viewer for this conversation; null for anything stale or foreign. */
function viewerStream(sender: unknown, convId: unknown, streamId: unknown): Stream | null {
  if (typeof convId !== 'string' || !isBrowserStreamId(streamId)) return null
  const stream = streams.get(convId)
  return stream && stream.streamId === streamId && stream.viewer === sender ? stream : null
}

/**
 * Starts streaming the conversation's browser to `sender`, a renderer of another computer, at the size of its
 * surface. A viewer that was watching the same browser is told it was taken over.
 */
export function startBrowserStream(
  sender: unknown,
  convId: unknown,
  width: unknown,
  height: unknown
): BrowserStreamStarted {
  const viewer = checkViewer(sender)
  if (typeof convId !== 'string' || !convId || convId.length > 200 || !getConversation(convId))
    throw new BrowserStreamError('Unknown conversation.', 'unknown-conversation')
  listen()
  const previous = streams.get(convId)
  if (previous) end(previous, previous.viewer === viewer ? 'stopped' : 'taken-over')
  const timer = releaseTimers.get(convId)
  if (timer) clearTimeout(timer)
  releaseTimers.delete(convId)

  ensureBrowser(convId)
  const size = presentBrowserForStream(convId, { width: Number(width), height: Number(height) })
  const stream: Stream = {
    convId,
    streamId: randomBytes(18).toString('base64url'),
    viewer,
    onViewerGone: () => {
      if (streams.get(convId) !== stream) return
      end(stream, null)
      scheduleRelease(convId)
    },
    size,
    sourceSeq: 0,
    source: null,
    nextSeq: 0,
    inFlight: new Map(),
    held: null,
    quality: 'normal',
    qualityChangedAt: 0,
    rtts: [],
    focused: false,
    input: Promise.resolve(),
  }
  streams.set(convId, stream)
  viewer.once('destroyed', stream.onViewerGone)
  // The answer reaches the window before the stream's first event: both go over the same bridge, and the answer is
  // written as soon as this returns.
  setImmediate(() => syncSource(stream))
  return { streamId: stream.streamId }
}

export function resizeBrowserStream(
  sender: unknown,
  convId: unknown,
  streamId: unknown,
  width: unknown,
  height: unknown
): void {
  const stream = viewerStream(sender, convId, streamId)
  if (!stream) return
  const size = presentBrowserForStream(stream.convId, { width: Number(width), height: Number(height) })
  if (size.width === stream.size.width && size.height === stream.size.height) return
  stream.size = size
  restartScreencast(stream)
}

/** The window drew (or dropped) frame `seq`: Chromium may send the next one. */
export function acknowledgeBrowserFrame(sender: unknown, convId: unknown, streamId: unknown, seq: unknown): void {
  const stream = viewerStream(sender, convId, streamId)
  if (!stream || !Number.isSafeInteger(seq)) return
  const frame = stream.inFlight.get(seq as number)
  if (!frame) return
  stream.inFlight.delete(seq as number)
  const now = Date.now()
  stream.rtts.push(now - frame.sentAt)
  if (stream.rtts.length > RTT_SAMPLES) stream.rtts.shift()
  const source = stream.source
  if (source && frame.source === source.id && frame.epoch === source.epoch) {
    void sendCdp(source.wc, 'Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
  }
  const held = stream.held
  if (source && held && held.source === source.id && held.epoch === source.epoch) {
    if (framesInFlight(stream, now) < BROWSER_STREAM_LIMITS.maxFramesInFlight) {
      stream.held = null
      forward(stream, source, held.epoch, held.params)
    }
  }
  adaptQuality(stream, now)
}

export function stopBrowserStream(sender: unknown, convId: unknown, streamId: unknown): void {
  const stream = viewerStream(sender, convId, streamId)
  if (!stream) return
  end(stream, null)
  scheduleRelease(stream.convId)
}

function enqueueInput(stream: Stream, operation: (source: Source) => Promise<unknown> | unknown): Promise<void> {
  const source = stream.source
  const run = stream.input
    .catch(() => {})
    .then(async () => {
      // Input goes only to the page it was aimed at.
      if (!source || stream.source !== source || streams.get(stream.convId) !== stream || source.wc.isDestroyed())
        return
      await operation(source)
    })
  stream.input = run.catch(() => {})
  return run
}

const MOUSE_TYPES = { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased' } as const

async function dispatch(source: Source, input: BrowserStreamInput): Promise<void> {
  const wc = source.wc
  // Input arrives in the frame's pixels; DevTools takes CSS pixels, fewer of them on a zoomed page.
  const zoom = wc.getZoomFactor() || 1
  switch (input.type) {
    case 'mouse':
      return dispatchPresentedMouse(wc, {
        type: MOUSE_TYPES[input.action],
        x: input.x / zoom,
        y: input.y / zoom,
        button: input.button,
        buttons: input.buttons,
        clickCount: input.clickCount,
        modifiers: input.modifiers,
      })
    case 'wheel':
      return dispatchPresentedMouse(wc, {
        type: 'mouseWheel',
        x: input.x / zoom,
        y: input.y / zoom,
        button: 'none',
        buttons: 0,
        clickCount: 0,
        modifiers: input.modifiers,
        deltaX: input.deltaX,
        deltaY: input.deltaY,
      })
    case 'key':
      return dispatchPresentedKey(wc, {
        type: input.action === 'up' ? 'keyUp' : input.text ? 'keyDown' : 'rawKeyDown',
        key: input.key,
        code: input.code,
        windowsVirtualKeyCode: input.keyCode,
        nativeVirtualKeyCode: input.keyCode,
        modifiers: input.modifiers,
        ...(input.location ? { location: input.location } : {}),
        ...(input.autoRepeat ? { autoRepeat: true } : {}),
        ...(input.text && input.action === 'down' ? { text: input.text, unmodifiedText: input.text } : {}),
        ...(input.commands && input.action === 'down' ? { commands: input.commands } : {}),
      })
    case 'text':
      return insertPresentedText(wc, input.text)
    case 'edit':
      wc[input.command]()
      return
    case 'focus':
      return setPresentedFocusEmulation(wc, input.focused)
  }
}

export function inputBrowserStream(sender: unknown, convId: unknown, streamId: unknown, raw: unknown): void {
  const stream = viewerStream(sender, convId, streamId)
  const input = stream && parseBrowserStreamInput(raw)
  if (!stream || !input) return
  if (input.type === 'focus') stream.focused = input.focused
  void enqueueInput(stream, (source) => dispatch(source, input)).catch(() => {})
}

const capText = (text: string): string => text.slice(0, BROWSER_STREAM_LIMITS.maxClipboardChars)

/**
 * Copies (or cuts) the page's selection through the page's own copy command, so a page that handles copying (an
 * editor that puts its own text there) is copied as it would be locally. A sentinel on the host's clipboard tells a
 * real copy from none; when nothing changed it in time, the selection is read from the page instead.
 */
export async function copyBrowserStream(
  sender: unknown,
  convId: unknown,
  streamId: unknown,
  cut: unknown
): Promise<string | null> {
  const stream = viewerStream(sender, convId, streamId)
  if (!stream) return null
  let copied: string | null = null
  await enqueueInput(stream, (source) =>
    withClipboard(async () => {
      const sentinel = `⁣maestrly-copy-${randomBytes(12).toString('hex')}`
      await clipboard.writeText(sentinel)
      if (cut === true) source.wc.cut()
      else source.wc.copy()
      const deadline = Date.now() + COPY_SETTLE_MS
      while (Date.now() < deadline) {
        await sleep(COPY_POLL_MS)
        const text = await clipboard.readText()
        if (text !== sentinel) {
          copied = capText(text)
          return
        }
      }
      const selected = await readPageSelection(source.wc)
      copied = selected ? capText(selected) : null
    })
  )
  return copied
}

/** Pastes what the viewer's clipboard held through the page's own paste command, after earlier input. */
export function pasteBrowserStream(sender: unknown, convId: unknown, streamId: unknown, data: unknown): void {
  const stream = viewerStream(sender, convId, streamId)
  if (!stream || !data || typeof data !== 'object') return
  const { text, html } = data as { text?: unknown; html?: unknown }
  if (typeof text !== 'string' || text.length > BROWSER_STREAM_LIMITS.maxClipboardChars) return
  if (html !== undefined && (typeof html !== 'string' || html.length > BROWSER_STREAM_LIMITS.maxPasteHtmlChars)) return
  void enqueueInput(stream, (source) =>
    withClipboard(async () => {
      if (typeof html === 'string' && html) {
        await clipboard.write([new ClipboardItem({ 'text/plain': text, 'text/html': html })])
      } else {
        await clipboard.writeText(text)
      }
      if (source.wc.isDestroyed()) return
      source.wc.paste()
      await sleep(PASTE_HOLD_MS)
    })
  ).catch(() => {})
}

/** The option the viewer picked for a `<select>` request of the current page, or null when it dismissed the list. */
export function chooseBrowserStreamOption(
  sender: unknown,
  convId: unknown,
  streamId: unknown,
  requestId: unknown,
  index: unknown
): void {
  const stream = viewerStream(sender, convId, streamId)
  if (!stream || typeof requestId !== 'string' || requestId.length > 32) return
  if (index !== null && !(Number.isInteger(index) && (index as number) >= 0)) return
  void enqueueInput(stream, (source) => chooseSelectOption(source.wc, requestId, index as number | null)).catch(
    () => {}
  )
}

/** Closes the sign-in window the viewer sees, as its close button would. */
export function closeBrowserStreamPopup(sender: unknown, convId: unknown, streamId: unknown): void {
  const stream = viewerStream(sender, convId, streamId)
  const popup = stream?.source?.kind === 'popup' ? stream.source.popup : null
  if (popup && !popup.isDestroyed()) popup.close()
}

/** Test seam: forget every stream and timer. */
export function resetBrowserStreamsForTest(): void {
  for (const stream of [...streams.values()]) end(stream, null)
  for (const timer of releaseTimers.values()) clearTimeout(timer)
  releaseTimers.clear()
  clipboardTail = Promise.resolve()
}
