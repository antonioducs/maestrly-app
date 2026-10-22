import { EventEmitter } from 'node:events'
import type { BrowserPage, BrowserPageDebugger } from '../../../browser-control'
import type { CdpEvent, CdpPipe } from './cdp-pipe'

/** What the browser reports of one of its tabs (a target of type `page`). */
export interface ChromiumTargetInfo {
  targetId: string
  url: string
  title: string
  /** The tab whose page opened this one (`window.open`, a link with a target). */
  openerId?: string
}

/** A crash leaves the renderer gone: its renderer-side command never answers, the browser restarts it on a load. */
const CRASH_COMMAND_TIMEOUT_MS = 5_000
/** How long a load gets to fire its load event, as the navigation tools wait for one. */
const LOAD_WAIT_MS = 15_000
/** How long the renderers' CPU use is watched to find the one running a script without stopping, and each reading's wait. */
const BUSY_SAMPLE_MS = 500
const BUSY_SAMPLE_TIMEOUT_MS = 3_000
/** The share of that time a renderer must have used to count as busy. */
const BUSY_SHARE = 0.2
/** A visible tab's surface answers a capture at once; one that stays silent past this gets its view painted instead. */
const SURFACE_CAPTURE_TIMEOUT_MS = 3_000

class ChromiumPageDebugger extends EventEmitter implements BrowserPageDebugger {
  constructor(private readonly page: ChromiumPage) {
    super()
  }

  /** The browser attached the session when it created the page: nothing is left to do but to refuse a closed tab. */
  attach(): void {
    if (this.page.isDestroyed()) throw new Error('The tab of the bot’s Chromium was closed.')
  }

  sendCommand(method: string, commandParams: Record<string, unknown> = {}): Promise<any> {
    return this.page.send(method, commandParams)
  }
}

/**
 * One tab of a bot's own Chromium, driven through a flattened DevTools session on that Chromium's pipe. It has the
 * shape of an Electron WebContents for the control functions (`browser-control.ts`): the same protocol commands reach
 * it, and its navigation, crash and lifecycle come from the protocol instead of Electron.
 */
export class ChromiumPage extends EventEmitter implements BrowserPage {
  readonly debugger: ChromiumPageDebugger
  private url: string
  private title: string
  private crashed = false
  /** Set from a forced crash until the browser reports it. */
  private crashing: Promise<void> | null = null
  private destroyed = false
  private history: { currentIndex: number; entries: Array<{ id: number }> } | null = null

  constructor(
    private readonly pipe: CdpPipe,
    readonly targetId: string,
    readonly sessionId: string,
    info: ChromiumTargetInfo
  ) {
    super()
    this.debugger = new ChromiumPageDebugger(this)
    this.url = info.url
    this.title = info.title
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<any> {
    if (this.destroyed) return Promise.reject(new Error('The tab of the bot’s Chromium was closed.'))
    return this.pipe.send(method, params, this.sessionId, timeoutMs)
  }

  /** An event of this page's session, as the browser routes it. */
  handleEvent(event: CdpEvent): void {
    if (event.method === 'Inspector.targetCrashed') this.crashed = true
    else if (event.method === 'Inspector.targetReloadedAfterCrash') this.crashed = false
    else if (event.method === 'Page.frameNavigated') {
      const frame = event.params.frame as { parentId?: string; url?: string } | undefined
      if (frame && !frame.parentId) {
        this.crashed = false
        this.history = null
      }
    }
    this.debugger.emit('message', {}, event.method, event.params, this.sessionId)
  }

  updateInfo(info: Pick<ChromiumTargetInfo, 'url' | 'title'>): void {
    this.url = info.url
    this.title = info.title
  }

  /** The tab closed, the browser exited or the session ended: the page is gone for good. */
  markDestroyed(reason = 'target closed'): void {
    if (this.destroyed) return
    this.destroyed = true
    this.debugger.emit('detach', {}, reason)
    this.emit('destroyed')
    this.debugger.removeAllListeners()
  }

  getURL(): string {
    return this.url
  }

  getTitle(): string {
    return this.title
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  isCrashed(): boolean {
    return this.crashed
  }

  canGoBack(): boolean {
    return !!this.history && this.history.currentIndex > 0
  }

  canGoForward(): boolean {
    return !!this.history && this.history.currentIndex < this.history.entries.length - 1
  }

  async navigationState(): Promise<{ canGoBack: boolean; canGoForward: boolean }> {
    const history = (await this.send('Page.getNavigationHistory')) as {
      currentIndex: number
      entries: Array<{ id: number }>
    }
    this.history = { currentIndex: history.currentIndex, entries: history.entries }
    return { canGoBack: this.canGoBack(), canGoForward: this.canGoForward() }
  }

  goBack(): void {
    void this.step(-1)
  }

  goForward(): void {
    void this.step(1)
  }

  reload(): void {
    void this.send('Page.reload').catch(() => {
      /* The load wait reports a reload that never happened. */
    })
  }

  /**
   * Loads a page and returns once it has loaded, as Electron's does. Commands sent before the new renderer is up go to
   * the one that crashed, which never answers them.
   */
  async loadURL(url: string): Promise<void> {
    await this.crashing
    const loaded = this.loadEvent()
    try {
      const result = (await this.send('Page.navigate', { url })) as { errorText?: string }
      if (result.errorText) throw new Error(`${result.errorText} loading ${url}`)
    } catch (error) {
      loaded.cancel()
      throw error
    }
    await loaded.promise
  }

  /** Resolves when the page fires its load event, or after the wait a load is given; `cancel` stops listening. */
  private loadEvent(): { promise: Promise<void>; cancel: () => void } {
    let cancel = (): void => {}
    const promise = new Promise<void>((resolve) => {
      const onMessage = (_event: unknown, method: string): void => {
        if (method === 'Page.loadEventFired') done()
      }
      const done = (): void => {
        clearTimeout(timer)
        this.debugger.off('message', onMessage)
        this.removeListener('destroyed', done)
        resolve()
      }
      const timer = setTimeout(done, LOAD_WAIT_MS)
      this.debugger.on('message', onMessage)
      this.once('destroyed', done)
      cancel = done
    })
    return { promise, cancel }
  }

  /**
   * Ends the page's renderer even while it is stuck in a script. Unlike Electron's, the crash happens a moment later; a
   * load waits for it, since one sent before would go to the dying renderer and leave the tab without any. The browser
   * ends the renderer itself when one process is busy running a script. Otherwise it asks the page to crash, which the
   * page may only do after a long while: `Page.crash` is a command of the renderer, and a stuck one can answer it late.
   */
  forcefullyCrashRenderer(): void {
    this.crashed = true
    this.crashing ??= new Promise<void>((resolve) => {
      const onCrashed = (_event: unknown, method: string): void => {
        if (method === 'Inspector.targetCrashed') done()
      }
      const done = (): void => {
        clearTimeout(timer)
        this.debugger.off('message', onCrashed)
        this.removeListener('destroyed', done)
        resolve()
      }
      const timer = setTimeout(done, CRASH_COMMAND_TIMEOUT_MS)
      this.debugger.on('message', onCrashed)
      this.once('destroyed', done)
    }).finally(() => {
      this.crashing = null
    })
    void this.endRenderer()
  }

  private async endRenderer(): Promise<void> {
    const busy = await this.busyRendererPid().catch(() => null)
    if (busy !== null) {
      try {
        process.kill(busy, 'SIGKILL')
        return
      } catch {
        /* Already gone, or not ours to end: ask the page instead. */
      }
    }
    await this.send('Page.crash', {}, CRASH_COMMAND_TIMEOUT_MS).catch(() => {
      /* A crashed renderer never answers. */
    })
  }

  /**
   * The renderer process that runs a script without stopping, found by its CPU use: the protocol names the renderers
   * but not the tabs they host. None when no process stands out, such as a page blocked while it uses no CPU.
   */
  private async busyRendererPid(): Promise<number | null> {
    const sample = async (): Promise<Map<number, number>> => {
      const { processInfo } = (await this.pipe.send(
        'SystemInfo.getProcessInfo',
        {},
        undefined,
        BUSY_SAMPLE_TIMEOUT_MS
      )) as {
        processInfo: Array<{ type: string; id: number; cpuTime: number }>
      }
      return new Map(processInfo.filter((item) => item.type === 'renderer').map((item) => [item.id, item.cpuTime]))
    }
    const before = await sample()
    const started = Date.now()
    await new Promise((resolve) => setTimeout(resolve, BUSY_SAMPLE_MS))
    const after = await sample()
    const seconds = (Date.now() - started) / 1000
    const used = [...after]
      .flatMap(([pid, cpu]) => (before.has(pid) ? [{ pid, used: cpu - (before.get(pid) as number) }] : []))
      .sort((a, b) => b.used - a.used)
    const [top, next] = used
    // A script loop keeps a thread busy all the while, less when the machine is shared; other pages use far less.
    if (!top || top.used < seconds * BUSY_SHARE || (next && next.used > top.used / 2)) return null
    return top.pid
  }

  /**
   * The page as a PNG. A tab behind another one in its window composites no frame, so its surface never answers: its
   * view paints one instead (`fromSurface: false`), as it does for a visible tab whose surface stays silent.
   */
  async captureScreenshot(): Promise<Buffer> {
    const capture = async (params: Record<string, unknown>, timeoutMs?: number) =>
      Buffer.from(
        ((await this.send('Page.captureScreenshot', { format: 'png', ...params }, timeoutMs)) as { data: string }).data,
        'base64'
      )
    const hidden = await this.send(
      'Runtime.evaluate',
      { expression: 'document.visibilityState', returnByValue: true },
      SURFACE_CAPTURE_TIMEOUT_MS
    ).then(
      (answer: { result?: { value?: unknown } }) => answer?.result?.value === 'hidden',
      () => false
    )
    if (hidden) return capture({ fromSurface: false })
    try {
      return await capture({}, SURFACE_CAPTURE_TIMEOUT_MS)
    } catch (error) {
      if (this.destroyed || !/got no answer/.test((error as Error).message)) throw error
      return capture({ fromSurface: false })
    }
  }

  private async step(offset: -1 | 1): Promise<void> {
    try {
      const history = (await this.send('Page.getNavigationHistory')) as {
        currentIndex: number
        entries: Array<{ id: number }>
      }
      const entry = history.entries[history.currentIndex + offset]
      if (entry) await this.send('Page.navigateToHistoryEntry', { entryId: entry.id })
    } catch {
      /* The load wait reports a step that never happened. */
    }
  }
}
