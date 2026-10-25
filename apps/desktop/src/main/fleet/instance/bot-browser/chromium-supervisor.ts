import type { Readable, Writable } from 'node:stream'
import { CdpPipe } from './cdp-pipe'

/** A running Chromium with its DevTools pipe. */
export interface ChromiumProcess {
  pid?: number
  /** Its fd 3: the commands it reads. */
  commands: Writable
  /** Its fd 4: the answers and events it writes. */
  messages: Readable
  /** Resolves with the exit code, or `null` when a signal ended it. */
  exited: Promise<number | null>
  /** Signals its whole process group, so its renderers and helpers go with it. */
  kill(signal: 'SIGTERM' | 'SIGKILL'): void
  /** The end of what it wrote to stderr, for the log of a start that failed. */
  stderrTail(): string
}

export interface ChromiumSupervisorDeps {
  /** Starts `maestrly-bot-browser` with these arguments; `env` holds the variables set over this process's own. */
  spawn(args: string[], env: Record<string, string>): ChromiumProcess
  now(): number
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
  log(message: string): void
}

export interface ChromiumSupervisorOptions {
  botId: string
  /** The variables of the bot's programs (its display, bus and profile), read at each start; null without a display. */
  env(): Record<string, string> | null
  /** Runs before each start: prepares the profile; a failure is logged and the browser starts anyway. */
  beforeStart?(): Promise<void>
  /** Prepares a browser that just answered (targets, downloads, tabs to restore); a failure fails the start. */
  onStarted(pipe: CdpPipe): Promise<void>
  /** The browser exited; `restarting` when it crashed and comes back on its own. */
  onExited(info: { code: number | null; restarting: boolean }): void
  /** How long a started browser has to answer before the start fails; `CHROMIUM_START_TIMEOUT_MS` by default. */
  startTimeoutMs?: number
}

/**
 * The flags of the bots' Chromium, after the profile flags of `maestrly-bot-browser`: the DevTools pipe instead of a
 * port, CPU rendering as the rest of the desktop, nothing working in the background that a bot did not ask for (about
 * 10% less memory), pages that keep running behind other windows, and one window filling the bot's 1280×800 display.
 */
export const BOT_CHROMIUM_ARGS: readonly string[] = [
  '--remote-debugging-pipe',
  // The pipe marks pages as automated (`navigator.webdriver`), and Google then refuses to sign in.
  '--disable-blink-features=AutomationControlled',
  '--disable-gpu',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--disable-default-apps',
  '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication',
  '--disable-renderer-backgrounding',
  // Keeps the session cookies (those without an expiry) of the last run, as Chrome's "Continue where you left off"
  // does: otherwise Chromium deletes them at each start, and the browser closes after its idle time, signing the bot out
  // of the sites that keep their login in one. The bot restores its tabs itself: the profile has no tabs of Chromium's
  // own to reopen (`BotChromium` removes its record before each start).
  '--restore-last-session',
  '--hide-crash-restore-bubble',
  '--window-position=0,0',
  '--window-size=1280,800',
  '--start-maximized',
  'about:blank',
]

export const CHROMIUM_START_TIMEOUT_MS = 20_000
/** How long a browser asked to close has to write its profile and exit before its process group is signalled. */
export const CHROMIUM_CLOSE_WAIT_MS = 10_000
export const CHROMIUM_EXIT_WAIT_MS = 5_000
export const CHROMIUM_RESTART_DELAY_MS = 1_000
export const CHROMIUM_RESTART_BUDGET = 5
export const CHROMIUM_RESTART_WINDOW_MS = 60_000

interface Running {
  process: ChromiumProcess
  pipe: CdpPipe
  /** Set once a stop asked it to exit: its exit is expected, never restarted. */
  stopping: boolean
  /** Set once it answered and `onStarted` prepared it: before that, its tabs are still being restored. */
  ready: boolean
}

/**
 * Starts, supervises and stops one bot's Chromium. It starts on demand; a crash restarts it after a moment, at most
 * five times a minute; an exit with code 0 (the person closed its last window) leaves it stopped until it is needed
 * again. Stopping asks it to close, and signals its process group only when it has not exited ten seconds later.
 */
export class ChromiumSupervisor {
  private running: Running | null = null
  private starting: Promise<CdpPipe> | null = null
  private stopping: Promise<void> | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private readonly restarts: number[] = []
  private disposed = false

  constructor(
    private readonly deps: ChromiumSupervisorDeps,
    private readonly options: ChromiumSupervisorOptions
  ) {}

  /** Whether the browser runs and answered, so that something shown in it can be brought forward. */
  get isRunning(): boolean {
    return !!this.running && this.running.ready && !this.running.stopping && !this.running.pipe.closed
  }

  /** The connection to the running browser, starting it first when it is not running. */
  async ensure(): Promise<CdpPipe> {
    for (;;) {
      if (this.disposed) throw new Error('The bot’s Chromium was stopped for good.')
      if (this.stopping) {
        await this.stopping
        continue
      }
      if (this.starting) return this.starting
      if (this.isRunning) return this.running!.pipe
      this.starting ??= this.start().finally(() => {
        this.starting = null
      })
      return this.starting
    }
  }

  /** Stops the browser; a later `ensure` starts it again. */
  stop(): Promise<void> {
    this.cancelRestart()
    if (this.stopping) return this.stopping
    const stopping = (async () => {
      await this.starting?.catch(() => undefined)
      const running = this.running
      if (running) await this.terminate(running, true)
    })().finally(() => {
      if (this.stopping === stopping) this.stopping = null
    })
    this.stopping = stopping
    return stopping
  }

  /** Stops the browser and accepts nothing afterwards. */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.stop()
  }

  private async start(): Promise<CdpPipe> {
    const env = this.options.env()
    if (!env) throw new Error('The bot has no display for its Chromium.')
    await this.options
      .beforeStart?.()
      .catch((error: unknown) =>
        this.deps.log(
          `Could not prepare the Chromium profile of bot ${this.options.botId}: ${(error as Error).message}`
        )
      )
    if (this.disposed) throw new Error('The bot’s Chromium was stopped for good.')
    const child = this.deps.spawn([...BOT_CHROMIUM_ARGS], env)
    const pipe = new CdpPipe(child.commands, child.messages)
    const running: Running = { process: child, pipe, stopping: false, ready: false }
    this.running = running
    void child.exited.then((code) => this.exited(running, code))
    let answered = false
    try {
      await pipe.send('Browser.getVersion', {}, undefined, this.options.startTimeoutMs ?? CHROMIUM_START_TIMEOUT_MS)
      answered = true
      if (this.disposed) throw new Error('The bot’s Chromium was stopped for good.')
      await this.options.onStarted(pipe)
      if (pipe.closed) throw new Error('it exited while it was being prepared')
      running.ready = true
    } catch (error) {
      const tail = child.stderrTail().trim()
      this.deps.log(
        `The Chromium of bot ${this.options.botId} did not start: ${(error as Error).message}` +
          (tail ? ` (${tail.slice(-400)})` : '')
      )
      await this.terminate(running, answered)
      throw error
    }
    this.deps.log(`Started the Chromium of bot ${this.options.botId} (pid ${child.pid ?? 'unknown'}).`)
    return pipe
  }

  private exited(running: Running, code: number | null): void {
    running.pipe.close(code === null ? 'it was ended by a signal' : `it exited with code ${code}`)
    if (this.running === running) this.running = null
    const expected = running.stopping || this.disposed
    const restarting = !expected && code !== 0 && this.mayRestart()
    if (!expected) {
      this.deps.log(
        `The Chromium of bot ${this.options.botId} ${code === 0 ? 'was closed' : `exited (${code ?? 'signal'})`}` +
          (restarting ? '; starting it again.' : '.')
      )
    }
    this.options.onExited({ code, restarting })
    if (restarting) this.scheduleRestart()
  }

  private mayRestart(): boolean {
    const now = this.deps.now()
    while (this.restarts.length > 0 && now - this.restarts[0] >= CHROMIUM_RESTART_WINDOW_MS) this.restarts.shift()
    if (this.restarts.length >= CHROMIUM_RESTART_BUDGET) return false
    this.restarts.push(now)
    return true
  }

  private scheduleRestart(): void {
    this.cancelRestart()
    this.restartTimer = this.deps.setTimeout(() => {
      this.restartTimer = null
      if (this.disposed || this.running || this.starting || this.stopping) return
      void this.ensure().catch(() => {
        /* The start logged why; the next use tries again. */
      })
    }, CHROMIUM_RESTART_DELAY_MS)
  }

  private cancelRestart(): void {
    if (!this.restartTimer) return
    this.deps.clearTimeout(this.restartTimer)
    this.restartTimer = null
  }

  /**
   * Asks a browser that answers to close and waits for it; only one that has not exited by then gets SIGTERM, then
   * SIGKILL, on its process group. A browser closing by itself writes its profile first, while a SIGTERM, even to the
   * browser alone, ends it at once: the cookies changed in the last half minute are lost, among them the session
   * tokens sites like Google rotate, and the stale ones left on disk sign the bot out at the next start.
   */
  private async terminate(running: Running, graceful: boolean): Promise<void> {
    running.stopping = true
    let exited = false
    const exit = running.process.exited.then(() => {
      exited = true
    })
    const asked = graceful && !running.pipe.closed
    // What the browser sends while it closes its tabs is never read: those are not tabs the bot or a person closed.
    if (asked) running.pipe.closeWith('Browser.close', 'it was stopped')
    else running.pipe.close('it was stopped')
    if (asked) await this.waitFor(exit, CHROMIUM_CLOSE_WAIT_MS)
    if (!exited) {
      if (asked) this.deps.log(`The Chromium of bot ${this.options.botId} did not close when asked; ending it.`)
      running.process.kill('SIGTERM')
      await this.waitFor(exit, CHROMIUM_EXIT_WAIT_MS)
    }
    if (!exited) {
      running.process.kill('SIGKILL')
      await this.waitFor(exit, CHROMIUM_EXIT_WAIT_MS)
    }
    if (this.running === running) this.running = null
  }

  /** Waits for `done`, or `ms` at most, leaving no timer behind. */
  private async waitFor(done: Promise<void>, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([done, new Promise<void>((resolve) => (timer = this.deps.setTimeout(resolve, ms)))])
    } finally {
      if (timer) this.deps.clearTimeout(timer)
    }
  }
}
