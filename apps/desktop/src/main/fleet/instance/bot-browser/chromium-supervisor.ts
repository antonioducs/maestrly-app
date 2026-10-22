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
  /** Runs before each start: stops a browser left holding the profile. */
  beforeStart?(): Promise<void>
  /** Prepares a browser that just answered (targets, downloads, tabs to restore); a failure fails the start. */
  onStarted(pipe: CdpPipe): Promise<void>
  /** The browser exited; `restarting` when it crashed and comes back on its own. */
  onExited(info: { code: number | null; restarting: boolean }): void
}

/**
 * The flags of the bots' Chromium, after the profile flags of `maestrly-bot-browser`: the DevTools pipe instead of a
 * port, CPU rendering as the rest of the desktop, nothing working in the background that a bot did not ask for (about
 * 10% less memory), pages that keep running behind other windows, and one window filling the bot's 1280×800 display.
 */
export const BOT_CHROMIUM_ARGS: readonly string[] = [
  '--remote-debugging-pipe',
  '--disable-gpu',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--disable-default-apps',
  '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication',
  '--disable-renderer-backgrounding',
  '--hide-crash-restore-bubble',
  '--window-position=0,0',
  '--window-size=1280,800',
  '--start-maximized',
  'about:blank',
]

export const CHROMIUM_START_TIMEOUT_MS = 20_000
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
 * again. Stopping signals its process group and waits for it, killing what is left after five seconds.
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
      if (running) await this.terminate(running)
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
        this.deps.log(`Could not stop a Chromium left by bot ${this.options.botId}: ${(error as Error).message}`)
      )
    if (this.disposed) throw new Error('The bot’s Chromium was stopped for good.')
    const child = this.deps.spawn([...BOT_CHROMIUM_ARGS], env)
    const pipe = new CdpPipe(child.commands, child.messages)
    const running: Running = { process: child, pipe, stopping: false, ready: false }
    this.running = running
    void child.exited.then((code) => this.exited(running, code))
    try {
      await pipe.send('Browser.getVersion', {}, undefined, CHROMIUM_START_TIMEOUT_MS)
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
      await this.terminate(running)
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

  /** Signals the process group and waits for the exit, killing what is left once the wait runs out. */
  private async terminate(running: Running): Promise<void> {
    running.stopping = true
    running.pipe.close('it was stopped')
    let exited = false
    const exit = running.process.exited.then(() => {
      exited = true
    })
    running.process.kill('SIGTERM')
    await Promise.race([exit, this.sleep(CHROMIUM_EXIT_WAIT_MS)])
    if (!exited) {
      running.process.kill('SIGKILL')
      await Promise.race([exit, this.sleep(CHROMIUM_EXIT_WAIT_MS)])
    }
    if (this.running === running) this.running = null
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.deps.setTimeout(resolve, ms))
  }
}
