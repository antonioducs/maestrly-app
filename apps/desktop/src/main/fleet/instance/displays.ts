import {
  FLEET_CONVERSATION_COMPUTER_LIMITS,
  FLEET_ENVIRONMENT_LIMITS,
  FLEET_SCREEN,
  fleetBotIdSchema,
  fleetEnvironmentTile,
} from '@maestrly/bot-fleet-protocol'
import type { ScreenArea } from '../../conversation-screen'
import { ScreenEncoder, type EncoderProcess } from './screen-encoder'
import { ScreenSession } from './screen-session'

/**
 * The screens of the bots in one environment.
 *
 * Each bot has an apps display `:<slot>` of its own (Xvfb, openbox, tint2 and its own D-Bus session bus, so programs
 * that keep a single instance open on the right screen) and a browser area: tile `<slot>` of the environment display
 * `:0`, where the environment's Electron process draws that bot's browser. Each screen streams through a screen
 * encoder that starts when a viewer or controller needs it and stops a minute after the last one leaves; its viewers
 * and its controller share it.
 */

export type BotDisplayEnv = {
  DISPLAY: string
  DBUS_SESSION_BUS_ADDRESS: string
  BROWSER: string
  MAESTRLY_BOT_BROWSER_PROFILE: string
  /** Only the bot's own programs are dark: the environment's Electron must keep reporting a light color scheme. */
  GTK_THEME: string
  /** The bot's desktop socket, where its dock, links and terminal windows reach the environment's Maestrly. */
  MAESTRLY_DESKTOP_SOCKET: string
}

/** The GTK theme of the programs on a bot's apps display, so they match the dark title bars and dock. */
export const BOT_GTK_THEME = 'Adwaita:dark'

export interface BotDisplay {
  botId: string
  slot: number
  /** The bot's apps display, such as `:2`. */
  display: string
  width: 1280
  height: 800
  /** Variables for the bot's shells and programs, so they use its display, bus and browser profile. */
  env: BotDisplayEnv
  /** The bot's tile of the environment display. */
  browserArea: ScreenArea
}

/**
 * Whose desktop a display is: a bot, or a workspaces conversation's computer (its owner key). Bots use their slot as
 * their display number and keep their files under `maestrly-bots`; a conversation's computer has a display number of
 * its own, so a program it left running can never open on another conversation's computer.
 */
export type DesktopOwner = {
  /** A bot id, or a conversation's owner key; matches `fleetBotIdSchema`. */
  key: string
  /** 1 to 8: the tile of the environment display that shows its browser. */
  slot: number
  /** The X display number; the slot when left out, as for bots. From 10 to 4095 when given. */
  display?: number
  /** The folder under `~/.cache` and `~/.config` that holds its bus, desktop socket and browser profile. */
  folder?: 'maestrly-bots' | 'maestrly-desktops'
}

/** The screens the control API serves for bots and their environment. */
export type DisplaySurface =
  | { kind: 'environment' }
  | { kind: 'browser'; botId: string }
  | { kind: 'apps'; botId: string }
/**
 * Every screen the manager streams: those surfaces, and a tile of the environment display whether or not an apps
 * display goes with it (a workspaces conversation's browser).
 */
export type DisplayScreen = DisplaySurface | { kind: 'tile'; slot: number }
export interface ScreenLease {
  /** The screen's stream, which connections attach to as viewers or as its controller. */
  session: ScreenSession
  /** Gives the screen back; its encoder stops a minute after its last lease is released. Calling it again does nothing. */
  release(): void
}

/** A process started through the manager's dependencies. */
export interface DisplayProcess {
  /** The process id, when the process started. */
  pid?: number
  /** Resolves with the exit code, or `null` when a signal ended the process. */
  exited: Promise<number | null>
  /** Asks the process to exit. */
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void
}

export interface DisplayManagerDeps {
  /** Runs a program found on `PATH`; `env` holds the variables set over the manager's own environment. */
  spawn(command: string, args: string[], options: { env: Record<string, string> }): DisplayProcess
  /** The environment's home folder. */
  home: string
  /** Creates a folder and any missing parents. */
  mkdir(path: string): Promise<void>
  /**
   * Paints the bot's wallpaper on its apps display. It runs once the display answers and before the window manager and
   * taskbar start, so the taskbar can look through to it, and again whenever the display server restarts. A failure is
   * logged and the display still starts; an attempt that takes more than 15 seconds is given up.
   */
  decorate?(display: BotDisplay): Promise<void>
  /** The language of the app, such as `pt_BR`, for the taskbar's launcher names. Empty or `null` keeps the container's. */
  language?(): string | null
  /** Runs the screen encoder (`SCREEN_ENCODER_PROGRAM`) with these arguments and pipes for its stdin, stdout and stderr. */
  spawnEncoder(args: string[]): EncoderProcess
  /** The clock of the screens' pacing; `Date.now` unless a test sets one. */
  now?(): number
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
  log(message: string): void
}

type Timer = ReturnType<typeof setTimeout>
/** Shows the bot's Maestrly browser, which lives on the environment display, as a window of the bot's desktop. */
const PRESENTER = 'maestrly-browser-presenter'
type Program = 'dbus-daemon' | 'Xvfb' | 'openbox' | 'tint2' | typeof PRESENTER
type SurfaceKind = DisplaySurface['kind']

const PROGRAMS: readonly Program[] = ['dbus-daemon', 'Xvfb', 'openbox', 'tint2']
const DESKTOP: readonly Program[] = ['openbox', 'tint2', PRESENTER]
/**
 * Exit codes of a presenter that can never run here, so restarting it is pointless: not installed (127, as the spawner
 * reports a missing program) or the displays lack the X extensions it needs (2).
 */
const PRESENTER_CANNOT_RUN: ReadonlySet<number> = new Set([127, 2])
const ENVIRONMENT_DISPLAY = ':0'
/** Opens links in the bot's Maestrly browser, which shares the environment's site logins, through its desktop socket. */
export const BOT_URL_OPENER = '/usr/local/bin/maestrly-open-url'
const OPENBOX_CONFIG = '/opt/maestrly/openbox-rc.xml'
const RESTART_DELAY_MS = 1_000
const RESTART_BUDGET = 5
const RESTART_WINDOW_MS = 60_000
const SCREEN_IDLE_MS = 60_000
/** How long a screen encoder may take to say it captures. */
const ENCODER_READY_MS = 5_000
const READY_POLL_MS = 100
const READY_ATTEMPTS = 50
const DECORATE_LIMIT_MS = 15_000
const EXIT_WAIT_MS = 5_000
/** Linux keeps 108 bytes for a socket path, including the terminating NUL. */
const SOCKET_PATH_MAX = 107
/** The home folder goes into a D-Bus address, which takes these characters without escaping. */
const HOME_PATTERN = /^\/[A-Za-z0-9_./-]*$/

interface Child {
  handle: DisplayProcess
  exited: Promise<number | null>
}

interface BotStack {
  readonly display: BotDisplay
  /** The X display number: `display` without its colon. */
  readonly number: number
  /** The folder of its bus and desktop socket. */
  readonly cache: string
  /**
   * Whether stopping it also stops the encoder of its tile. A bot's tile is its own; a conversation's tile is also
   * watched by its Browser tab, which leases it on its own.
   */
  readonly ownsTile: boolean
  state: 'starting' | 'running' | 'stopping' | 'failed'
  started: Promise<BotDisplay>
  teardown: Promise<void> | null
  readonly children: Map<Program, Child>
  readonly probes: Set<DisplayProcess>
  readonly sleepers: Set<() => void>
  readonly timers: Set<Timer>
  readonly restarts: Map<Program, Timer>
  /** The last painting of the wallpaper, so that paintings never overlap. It never rejects. */
  decoration: Promise<void>
  recentRestarts: number
  /** Restarts of the presenter within the last minute: it has a budget of its own and never fails the display. */
  presenterRestarts: number
  serverReady: boolean
  serverStarting: boolean
}

interface ScreenTarget {
  /** `environment`, or `browser:<slot>` and `apps:<slot>`: one encoder per key. */
  key: string
  kind: SurfaceKind
  /** The bot's slot, or 0 for the environment screen. */
  slot: number
  display: string
  region: ScreenArea
}

interface ScreenServer {
  readonly key: string
  readonly kind: SurfaceKind
  readonly slot: number
  readonly child: Child
  readonly encoder: ScreenEncoder
  /** Created once the encoder says it captures. */
  session: ScreenSession | null
  running: boolean
  refs: number
  ready: Promise<void>
  idle: Timer | null
  closing: Promise<void> | null
}

function assertSlot(slot: number): void {
  if (!Number.isInteger(slot) || slot < 1 || slot > FLEET_ENVIRONMENT_LIMITS.botsMax)
    throw new RangeError(`Invalid display slot ${slot}: slots go from 1 to ${FLEET_ENVIRONMENT_LIMITS.botsMax}.`)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Starts, supervises and stops the apps displays of an environment's bots, and its screen encoders. */
export class DisplayManager {
  private readonly deps: DisplayManagerDeps
  private readonly home: string
  private readonly stacks = new Map<string, BotStack>()
  private readonly servers = new Map<string, ScreenServer>()
  private disposing: Promise<void> | null = null

  constructor(deps: DisplayManagerDeps) {
    if (!HOME_PATTERN.test(deps.home) || deps.home.split('/').includes('..'))
      throw new TypeError('The display home must be an absolute path of letters, digits, ".", "_", "-" and "/".')
    this.deps = deps
    this.home = deps.home.replace(/\/+$/, '')
  }

  /** The environment screen's tile of the environment display. */
  environmentArea(): ScreenArea {
    return fleetEnvironmentTile(0)
  }

  /** Starts the bot's apps display, or returns the one already running for it. */
  startBot(botId: string, slot: number): Promise<BotDisplay> {
    return this.startDesktop({ key: botId, slot })
  }

  /** Starts the owner's apps display, or returns the one already running for it. */
  async startDesktop(owner: DesktopOwner): Promise<BotDisplay> {
    const { key: botId, slot } = owner
    for (;;) {
      this.assertOpen()
      const described = this.describe(owner)
      const { display } = described
      const existing = this.stacks.get(botId)
      if (existing) {
        if (existing.display.slot !== slot)
          throw new Error(`Bot ${botId} already uses display slot ${existing.display.slot}.`)
        if (existing.display.display !== display.display)
          throw new Error(`Bot ${botId} already uses display ${existing.display.display}.`)
        if (existing.state === 'starting' || existing.state === 'running') return existing.started
        // A stack that is stopping, or that gave up after crashing: wait for it to finish, then start again.
        await existing.teardown
        if (existing.state === 'failed') this.forget(existing)
        continue
      }
      const holder = [...this.stacks.values()].find(
        (stack) => stack.display.slot === slot || stack.number === described.number
      )
      if (holder) {
        if (holder.state !== 'stopping')
          throw new Error(
            holder.display.slot === slot
              ? `Display slot ${slot} is already used by bot ${holder.display.botId}.`
              : `Display ${display.display} is already used by ${holder.display.botId}.`
          )
        await holder.teardown
        continue
      }
      const stack: BotStack = {
        ...described,
        state: 'starting',
        started: Promise.resolve(display),
        teardown: null,
        children: new Map(),
        probes: new Set(),
        sleepers: new Set(),
        timers: new Set(),
        restarts: new Map(),
        decoration: Promise.resolve(),
        recentRestarts: 0,
        presenterRestarts: 0,
        serverReady: false,
        serverStarting: false,
      }
      this.stacks.set(botId, stack)
      stack.started = this.start(stack)
      stack.started.catch(() => undefined)
      return stack.started
    }
  }

  /** The bot's display while it is started (also after its programs kept crashing), otherwise `null`. */
  bot(botId: string): BotDisplay | null {
    const stack = this.stacks.get(botId)
    return stack && stack.state !== 'stopping' ? stack.display : null
  }

  /**
   * Paints the bot's wallpaper again, after its name or color changed. It does nothing unless the bot's display is
   * running, since a display that is starting or restarting paints itself once its server answers. A failure is
   * logged, never raised.
   */
  async redecorate(botId: string): Promise<void> {
    if (this.disposing) return
    const stack = this.stacks.get(botId)
    if (stack?.state !== 'running' || !stack.serverReady) return
    await this.decorating(stack)
  }

  /** Stops the bot's programs and screen encoders for good; they are not restarted. */
  async stopBot(botId: string): Promise<void> {
    const stack = this.stacks.get(botId)
    if (!stack) return
    if (stack.state === 'starting' || stack.state === 'running') {
      stack.state = 'stopping'
      stack.teardown = this.teardown(stack).then(() => this.forget(stack))
    } else if (stack.state === 'failed') {
      const failed = stack.teardown
      stack.state = 'stopping'
      stack.teardown = (async () => {
        await failed
        if (stack.ownsTile) await this.closeServers(stack.display.slot, ['browser'])
        this.forget(stack)
      })()
    }
    await stack.teardown
  }

  /**
   * The surface's screen, whose encoder starts on demand. The viewers and the controller of a surface share it; its
   * encoder stops a minute after the last lease is released.
   */
  async acquireScreen(surface: DisplayScreen): Promise<ScreenLease> {
    for (;;) {
      this.assertOpen()
      if (surface.kind === 'apps') {
        const stack = this.stacks.get(surface.botId)
        if (stack?.state === 'failed') {
          await stack.teardown
          this.assertOpen()
          if (this.stacks.get(surface.botId) !== stack || this.stacks.get(surface.botId)?.state === 'stopping')
            throw new Error(`The apps display of bot ${surface.botId} was stopped.`)
          if (stack.state === 'failed') {
            stack.state = 'starting'
            stack.teardown = null
            stack.recentRestarts = 0
            stack.started = this.start(stack)
            stack.started.catch(() => undefined)
          }
        }
        if (stack?.state === 'starting') await stack.started
        this.assertOpen()
      }
      // From here to the spawn nothing awaits, so a bot cannot stop in between.
      const target = this.screenTarget(surface)
      const current = this.servers.get(target.key)
      if (current?.closing) {
        await current.closing
        continue
      }
      const server = current ?? this.startScreen(target)
      server.refs++
      if (server.idle) {
        this.deps.clearTimeout(server.idle)
        server.idle = null
      }
      await server.ready
      if (this.servers.get(server.key) !== server || server.closing || !server.session)
        throw new Error(`The screen encoder of ${server.key} stopped while it was starting.`)
      return this.lease(server, server.session)
    }
  }

  /** The ids of the owner's display programs that are running: the windows they open are its desktop's own. */
  ownProcessIds(key: string): number[] {
    const stack = this.stacks.get(key)
    if (!stack) return []
    return [...stack.children.values()].flatMap((child) =>
      typeof child.handle.pid === 'number' ? [child.handle.pid] : []
    )
  }

  /** Stops every display and screen encoder; the manager accepts nothing afterwards. */
  dispose(): Promise<void> {
    this.disposing ??= (async () => {
      await Promise.all([...this.stacks.keys()].map((botId) => this.stopBot(botId)))
      await Promise.all([...this.servers.values()].map((server) => this.closeScreen(server)))
    })()
    return this.disposing
  }

  private assertOpen(): void {
    if (this.disposing) throw new Error('The display manager has been disposed.')
  }

  private assertActive(stack: BotStack): void {
    if (stack.state !== 'starting' && stack.state !== 'running')
      throw new Error(`The apps display of bot ${stack.display.botId} was stopped.`)
  }

  private describe(owner: DesktopOwner): {
    display: BotDisplay
    number: number
    cache: string
    ownsTile: boolean
  } {
    const { key: botId, slot } = owner
    if (!fleetBotIdSchema.safeParse(botId).success) throw new TypeError(`Invalid bot id ${JSON.stringify(botId)}.`)
    assertSlot(slot)
    const number = owner.display ?? slot
    const { firstDisplay, lastDisplay } = FLEET_CONVERSATION_COMPUTER_LIMITS
    if (owner.display !== undefined && (!Number.isInteger(number) || number < firstDisplay || number > lastDisplay))
      throw new RangeError(`Invalid display number ${number}: they go from ${firstDisplay} to ${lastDisplay}.`)
    const folder = owner.folder ?? 'maestrly-bots'
    const cache = `${this.home}/.cache/${folder}/${botId}`
    const bus = `${cache}/bus`
    if (bus.length > SOCKET_PATH_MAX) throw new RangeError(`The bus socket path of bot ${botId} is too long: ${bus}`)
    const desktop = `${cache}/desktop.sock`
    if (desktop.length > SOCKET_PATH_MAX)
      throw new RangeError(`The desktop socket path of bot ${botId} is too long: ${desktop}`)
    const env: BotDisplayEnv = Object.freeze({
      DISPLAY: `:${number}`,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${bus}`,
      BROWSER: BOT_URL_OPENER,
      MAESTRLY_BOT_BROWSER_PROFILE: `${this.home}/.config/${folder}/${botId}/chromium`,
      GTK_THEME: BOT_GTK_THEME,
      MAESTRLY_DESKTOP_SOCKET: desktop,
    })
    const display: BotDisplay = Object.freeze({
      botId,
      slot,
      display: `:${number}`,
      width: FLEET_SCREEN.width,
      height: FLEET_SCREEN.height,
      env,
      browserArea: Object.freeze(fleetEnvironmentTile(slot)),
    })
    return { display, number, cache, ownsTile: folder === 'maestrly-bots' }
  }

  private async start(stack: BotStack): Promise<BotDisplay> {
    const { botId, display, env } = stack.display
    try {
      await this.deps.mkdir(stack.cache)
      await this.deps.mkdir(env.MAESTRLY_BOT_BROWSER_PROFILE)
      this.assertActive(stack)
      this.launch(stack, 'dbus-daemon')
      await this.startServer(stack)
      await this.decorating(stack)
      this.assertActive(stack)
      for (const program of DESKTOP) this.launch(stack, program)
      stack.state = 'running'
      // A program that exited while the display was starting is restarted like any crash.
      for (const program of PROGRAMS) if (!stack.children.has(program)) this.scheduleRestart(stack, program)
      return stack.display
    } catch (error) {
      if (stack.state === 'starting') {
        stack.state = 'failed'
        this.deps.log(`Could not start the apps display ${display} of bot ${botId}: ${describeError(error)}`)
        // Its Browser lives on :0 and remains usable. Keep the slot until uninstall or an explicit Apps retry.
        stack.teardown = this.teardown(stack)
        await stack.teardown
      }
      throw error
    }
  }

  /** Starts Xvfb and waits until the display answers, so the programs that need it can connect. */
  private async startServer(stack: BotStack): Promise<void> {
    const { display } = stack.display
    const { number } = stack
    stack.serverStarting = true
    try {
      // Removes the lock and socket an Xvfb left behind when the container stopped.
      const prepared = await this.probe(stack.probes, 'prepare-xvfb-display', [
        display,
        `/tmp/.X${number}-lock`,
        `/tmp/.X11-unix/X${number}`,
      ])
      this.assertActive(stack)
      if (prepared !== 0) throw new Error(`Display ${display} is already in use.`)
      const server = this.launch(stack, 'Xvfb')
      for (let attempt = 1; ; attempt++) {
        const answered = (await this.probe(stack.probes, 'xdpyinfo', ['-display', display])) === 0
        this.assertActive(stack)
        if (stack.children.get('Xvfb') !== server) throw new Error(`Display ${display} exited before it answered.`)
        if (answered) {
          stack.serverReady = true
          return
        }
        if (attempt >= READY_ATTEMPTS) {
          await this.stopChild(stack, 'Xvfb')
          throw new Error(`Display ${display} did not start.`)
        }
        await this.sleep(READY_POLL_MS, stack.sleepers)
        this.assertActive(stack)
      }
    } finally {
      stack.serverStarting = false
    }
  }

  /** Queues a painting of the wallpaper behind the one in progress, if any. */
  private decorating(stack: BotStack): Promise<void> {
    const painting = stack.decoration.then(() => this.decorate(stack))
    stack.decoration = painting
    return painting
  }

  /**
   * Paints the wallpaper. A decoration that fails, or that does not finish in time, is logged and the display carries
   * on without it: the screen is more useful plain than not at all, and nothing here may restart anything.
   */
  private async decorate(stack: BotStack): Promise<void> {
    const decorate = this.deps.decorate
    if (!decorate || (stack.state !== 'starting' && stack.state !== 'running')) return
    const { botId, display } = stack.display
    let giveUp: () => void = () => undefined
    const gaveUp = new Promise<void>((resolve) => {
      giveUp = resolve
    })
    let expired = false
    const timer = this.timer(DECORATE_LIMIT_MS, () => {
      expired = true
      giveUp()
    })
    // A stop wakes the wait, like any other sleeper of the bot.
    stack.sleepers.add(giveUp)
    try {
      const painting = Promise.resolve().then(() => decorate(stack.display))
      // Whatever happens to a painting nobody waits for any more must not surface as an unhandled rejection.
      painting.catch(() => undefined)
      await Promise.race([painting, gaveUp])
      if (expired)
        this.deps.log(
          `Decorating the apps display ${display} of bot ${botId} did not finish within ${DECORATE_LIMIT_MS / 1_000} s.`
        )
    } catch (error) {
      this.deps.log(`Could not decorate the apps display ${display} of bot ${botId}: ${describeError(error)}`)
    } finally {
      this.deps.clearTimeout(timer)
      stack.sleepers.delete(giveUp)
    }
  }

  private launch(stack: BotStack, program: Program): Child {
    const { env, display } = stack.display
    const args =
      program === 'dbus-daemon'
        ? ['--session', '--nofork', '--nopidfile', `--address=${env.DBUS_SESSION_BUS_ADDRESS}`]
        : program === 'Xvfb'
          ? [display, '-screen', '0', `${FLEET_SCREEN.width}x${FLEET_SCREEN.height}x24`, '-nolisten', 'tcp', '-noreset']
          : program === 'openbox'
            ? ['--config-file', OPENBOX_CONFIG]
            : program === PRESENTER
              ? ['--source', ENVIRONMENT_DISPLAY, '--socket', env.MAESTRLY_DESKTOP_SOCKET]
              : ['-c', `${this.home}/.config/tint2/tint2rc`]
    const language = program === 'tint2' ? this.language() : null
    const child = this.spawnChild(
      program,
      args,
      program === 'Xvfb' ? {} : language ? { ...env, LANGUAGE: language } : { ...env }
    )
    stack.children.set(program, child)
    void child.exited.then((code) => this.exited(stack, program, child, code))
    return child
  }

  /** The app's language for the taskbar, or `null` when there is none or it cannot be read. */
  private language(): string | null {
    try {
      return this.deps.language?.() || null
    } catch (error) {
      this.deps.log(`Could not read the language of the app: ${describeError(error)}`)
      return null
    }
  }

  private exited(stack: BotStack, program: Program, child: Child, code: number | null): void {
    if (stack.children.get(program) !== child) return
    stack.children.delete(program)
    if (program === 'Xvfb') stack.serverReady = false
    if (program === PRESENTER) {
      this.presenterExited(stack, code)
      return
    }
    if (stack.state !== 'running') return
    const { botId, display } = stack.display
    this.deps.log(`${program} of bot ${botId} (display ${display}) exited with code ${code}; restarting it in 1 s.`)
    this.scheduleRestart(stack, program)
  }

  /**
   * The presenter comes back a second after it exits, on a budget of its own: without it the bot's desktop only lacks
   * its browser window, so it never fails the display. One that cannot run here is not retried; a clean exit (the
   * desktop service closed its connection) does not count against the budget.
   */
  private presenterExited(stack: BotStack, code: number | null): void {
    if (stack.state !== 'running' && stack.state !== 'starting') return
    const { botId, display } = stack.display
    if (code !== null && PRESENTER_CANNOT_RUN.has(code)) {
      this.deps.log(
        `${PRESENTER} of bot ${botId} (display ${display}) cannot run here (exit code ${code}); its browser is not shown on its desktop.`
      )
      return
    }
    if (code !== 0) {
      if (stack.presenterRestarts >= RESTART_BUDGET) {
        this.deps.log(
          `${PRESENTER} of bot ${botId} (display ${display}) restarted ${RESTART_BUDGET} times within a minute; giving up on it until its display server restarts.`
        )
        return
      }
      stack.presenterRestarts++
      this.stackTimer(stack, RESTART_WINDOW_MS, () => {
        stack.presenterRestarts--
      })
    }
    this.stackTimer(stack, RESTART_DELAY_MS, () => {
      if (stack.state === 'running' && stack.serverReady && !stack.children.has(PRESENTER))
        this.relaunchProgram(stack, PRESENTER)
    })
  }

  private scheduleRestart(stack: BotStack, program: Program): void {
    if (stack.state !== 'running' || stack.restarts.has(program)) return
    const timer = this.stackTimer(stack, RESTART_DELAY_MS, () => {
      stack.restarts.delete(program)
      this.relaunch(stack, program)
    })
    stack.restarts.set(program, timer)
  }

  private relaunch(stack: BotStack, program: Program): void {
    if (stack.state !== 'running' || stack.children.has(program)) return
    if (program === 'Xvfb' && stack.serverStarting) return
    // The window manager and taskbar come back with the display server.
    if (DESKTOP.includes(program) && !stack.serverReady) return
    const { botId, display } = stack.display
    if (stack.recentRestarts >= RESTART_BUDGET) {
      stack.state = 'failed'
      this.deps.log(
        `The apps display ${display} of bot ${botId} restarted ${RESTART_BUDGET} times within a minute; giving up until it is started again.`
      )
      stack.teardown = this.teardown(stack)
      void stack.teardown.catch((error: unknown) => this.deps.log(describeError(error)))
      return
    }
    stack.recentRestarts++
    this.stackTimer(stack, RESTART_WINDOW_MS, () => {
      stack.recentRestarts--
    })
    if (program !== 'Xvfb') {
      this.relaunchProgram(stack, program)
      return
    }
    void this.startServer(stack)
      .then(() => this.decorating(stack))
      .then(
        () => {
          if (stack.state !== 'running') return
          for (const desktop of DESKTOP) if (!stack.children.has(desktop)) this.relaunchProgram(stack, desktop)
        },
        (error: unknown) => {
          if (stack.state !== 'running') return
          this.deps.log(`Could not restart display ${display} of bot ${botId}: ${describeError(error)}`)
          this.scheduleRestart(stack, 'Xvfb')
        }
      )
  }

  private relaunchProgram(stack: BotStack, program: Program): void {
    try {
      this.launch(stack, program)
    } catch (error) {
      this.deps.log(`Could not restart ${program} of bot ${stack.display.botId}: ${describeError(error)}`)
      this.scheduleRestart(stack, program)
    }
  }

  /**
   * Stops the bot's programs, timers and apps screen, and its browser screen unless it failed or its tile is not its
   * own.
   */
  private async teardown(stack: BotStack): Promise<void> {
    const kinds: SurfaceKind[] = stack.state === 'failed' || !stack.ownsTile ? ['apps'] : ['apps', 'browser']
    stack.serverReady = false
    for (const timer of stack.timers) this.deps.clearTimeout(timer)
    stack.timers.clear()
    stack.restarts.clear()
    for (const wake of [...stack.sleepers]) wake()
    for (const probe of stack.probes) this.kill(probe, `a probe of bot ${stack.display.botId}`)
    const children = [...stack.children.entries()].reverse()
    stack.children.clear()
    await Promise.all([
      ...children.map(([program, child]) => this.terminate(child, `${program} of bot ${stack.display.botId}`)),
      this.closeServers(stack.display.slot, kinds),
    ])
  }

  private forget(stack: BotStack): void {
    if (this.stacks.get(stack.display.botId) === stack) this.stacks.delete(stack.display.botId)
  }

  private async stopChild(stack: BotStack, program: Program): Promise<void> {
    const child = stack.children.get(program)
    if (!child) return
    stack.children.delete(program)
    await this.terminate(child, `${program} of bot ${stack.display.botId}`)
  }

  private screenTarget(surface: DisplayScreen): ScreenTarget {
    if (surface.kind === 'environment')
      return {
        key: 'environment',
        kind: 'environment',
        slot: 0,
        display: ENVIRONMENT_DISPLAY,
        region: this.environmentArea(),
      }
    if (surface.kind === 'tile') {
      assertSlot(surface.slot)
      const { slot } = surface
      // The same encoder as the browser area of the bot in that slot: one tile, one encoder.
      return {
        key: `browser:${slot}`,
        kind: 'browser',
        slot,
        display: ENVIRONMENT_DISPLAY,
        region: fleetEnvironmentTile(slot),
      }
    }
    const stack = this.stacks.get(surface.botId)
    if (!stack || stack.state === 'stopping') throw new Error(`Bot ${surface.botId} has no display.`)
    const { slot, display, browserArea } = stack.display
    if (surface.kind === 'browser')
      return { key: `browser:${slot}`, kind: 'browser', slot, display: ENVIRONMENT_DISPLAY, region: browserArea }
    if (stack.state !== 'running') throw new Error(`The apps display of bot ${surface.botId} is not running.`)
    return {
      key: `apps:${slot}`,
      kind: 'apps',
      slot,
      display,
      region: { x: 0, y: 0, width: FLEET_SCREEN.width, height: FLEET_SCREEN.height },
    }
  }

  /** Starts the surface's encoder; its session exists once the encoder says it captures. */
  private startScreen(target: ScreenTarget): ScreenServer {
    const { key, region } = target
    const handle = this.deps.spawnEncoder([
      '--display',
      target.display,
      '--region',
      `${region.x},${region.y},${region.width},${region.height}`,
    ])
    const child: Child = {
      handle,
      exited: handle.exited.then(
        (code) => code,
        () => null
      ),
    }
    let started: () => void = () => undefined
    let failed: (error: Error) => void = () => undefined
    const ready = new Promise<void>((resolve, reject) => {
      started = resolve
      failed = reject
    })
    ready.catch(() => undefined)
    let readyTimer: Timer | null = null
    const server: ScreenServer = {
      key,
      kind: target.kind,
      slot: target.slot,
      child,
      encoder: new ScreenEncoder(
        handle,
        (event) => {
          if (event.type !== 'ready') {
            server.session?.handle(event)
            return
          }
          if (server.session || server.closing || !server.running) return
          if (readyTimer) this.deps.clearTimeout(readyTimer)
          readyTimer = null
          server.session = new ScreenSession(
            server.encoder,
            { width: event.width, height: event.height },
            {
              now: this.deps.now ?? Date.now,
              setTimeout: (callback, ms) => this.deps.setTimeout(callback, ms),
              clearTimeout: (timer) => this.deps.clearTimeout(timer),
              log: (message) => this.deps.log(message),
            }
          )
          this.deps.log(
            `The screen encoder of ${key} captures through ${event.capture || 'an unknown path'} and encodes with ${event.encoder || 'its default encoder'}.`
          )
          started()
        },
        (message) => this.deps.log(message)
      ),
      session: null,
      running: true,
      refs: 0,
      ready,
      idle: null,
      closing: null,
    }
    readyTimer = this.timer(ENCODER_READY_MS, () => {
      readyTimer = null
      failed(new Error(`The screen encoder of ${key} did not start.`))
      void this.closeScreen(server)
    })
    this.servers.set(key, server)
    void child.exited.then((code) => {
      server.running = false
      if (readyTimer) this.deps.clearTimeout(readyTimer)
      readyTimer = null
      server.session?.close()
      failed(new Error(`The screen encoder of ${key} exited before it started.`))
      if (this.servers.get(key) !== server || server.closing) return
      this.servers.delete(key)
      if (server.idle) this.deps.clearTimeout(server.idle)
      server.idle = null
      this.deps.log(`The screen encoder of ${key} exited with code ${code}.`)
    })
    return server
  }

  private lease(server: ScreenServer, session: ScreenSession): ScreenLease {
    let released = false
    return {
      session,
      release: () => {
        if (released) return
        released = true
        if (this.servers.get(server.key) !== server || server.closing) return
        server.refs = Math.max(0, server.refs - 1)
        if (server.refs > 0 || server.idle) return
        server.idle = this.timer(SCREEN_IDLE_MS, () => {
          server.idle = null
          void this.closeScreen(server)
        })
      },
    }
  }

  /** Ends the screen's clients and stops its encoder: closing stdin, then the usual signals. */
  private closeScreen(server: ScreenServer): Promise<void> {
    if (!server.closing) {
      if (server.idle) this.deps.clearTimeout(server.idle)
      server.idle = null
      server.session?.close()
      server.encoder.stop()
      server.closing = this.terminate(server.child, `The screen encoder of ${server.key}`).then(() => {
        if (this.servers.get(server.key) === server) this.servers.delete(server.key)
      })
      void server.closing.catch((error: unknown) => this.deps.log(describeError(error)))
    }
    return server.closing
  }

  private async closeServers(slot: number, kinds: readonly SurfaceKind[]): Promise<void> {
    const servers = [...this.servers.values()].filter((server) => server.slot === slot && kinds.includes(server.kind))
    await Promise.all(servers.map((server) => this.closeScreen(server)))
  }

  private spawnChild(command: string, args: string[], env: Record<string, string>): Child {
    const handle = this.deps.spawn(command, args, { env })
    return {
      handle,
      exited: handle.exited.then(
        (code) => code,
        () => null
      ),
    }
  }

  /** Runs a short-lived command and resolves with its exit code (`null` when it could not run). */
  private async probe(owner: Set<DisplayProcess>, command: string, args: string[]): Promise<number | null> {
    let child: Child
    try {
      child = this.spawnChild(command, args, {})
    } catch (error) {
      this.deps.log(`Could not run ${command}: ${describeError(error)}`)
      return null
    }
    owner.add(child.handle)
    try {
      return await child.exited
    } finally {
      owner.delete(child.handle)
    }
  }

  /** Waits, unless a stop wakes the sleeper first. */
  private sleep(ms: number, sleepers: Set<() => void>): Promise<void> {
    return new Promise((resolve) => {
      const wake = (): void => {
        sleepers.delete(wake)
        this.deps.clearTimeout(timer)
        resolve()
      }
      const timer = this.timer(ms, wake)
      sleepers.add(wake)
    })
  }

  /** Timers never keep the process alive. */
  private timer(ms: number, callback: () => void): Timer {
    const timer = this.deps.setTimeout(callback, ms)
    timer.unref()
    return timer
  }

  private stackTimer(stack: BotStack, ms: number, callback: () => void): Timer {
    const timer = this.timer(ms, () => {
      stack.timers.delete(timer)
      callback()
    })
    stack.timers.add(timer)
    return timer
  }

  /** A slot or screen cannot be reused while its previous process still owns it. */
  private async terminate(child: Child, label: string): Promise<void> {
    this.kill(child.handle, label)
    if (await this.waitForExit(child)) return
    this.deps.log(`${label} did not exit within ${EXIT_WAIT_MS / 1_000} s; sending SIGKILL.`)
    this.kill(child.handle, label, 'SIGKILL')
    if (!(await this.waitForExit(child))) throw new Error(`${label} did not exit after SIGKILL.`)
  }

  private async waitForExit(child: Child): Promise<boolean> {
    let expire = (): void => undefined
    const expired = new Promise<boolean>((resolve) => {
      expire = () => resolve(true)
    })
    const timer = this.timer(EXIT_WAIT_MS, () => expire())
    const timedOut = await Promise.race([child.exited.then(() => false), expired])
    this.deps.clearTimeout(timer)
    return !timedOut
  }

  private kill(handle: DisplayProcess, label: string, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): void {
    try {
      handle.kill(signal)
    } catch (error) {
      this.deps.log(`Could not stop ${label}: ${describeError(error)}`)
    }
  }
}
