import { execFile } from 'node:child_process'

/**
 * The terminal windows of one bot's desktop. A bot's shells live in the main process; a viewer is an `xterm` on the
 * bot's display whose only job is to run `maestrly-pty-attach`, which relays the shell through the desktop socket.
 * Closing the window ends the viewer and leaves the shell running. Each shell has at most one window: asking again
 * brings that window forward, and a closed window is opened again.
 */

/** A program started through the viewers' dependencies. */
export interface TerminalViewerProcess {
  /** `undefined` when the program could not be started. */
  pid: number | undefined
  /** Resolves with the exit code, or `null` when a signal ended the program. */
  exited: Promise<number | null>
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void
}

export interface TerminalViewersDeps {
  /** The bot's environment: `DISPLAY`, `DBUS_SESSION_BUS_ADDRESS` and `MAESTRLY_DESKTOP_SOCKET`. */
  env: Readonly<Record<string, string>>
  /** Runs a program found on `PATH`; `env` holds the variables set over the process environment. */
  spawn(command: string, args: string[], options: { env: Record<string, string> }): TerminalViewerProcess
  /** Brings the window of the program with this pid forward; false when it found none or could not. */
  activate(pid: number): Promise<boolean>
  /** Raises that window without giving it the keyboard; false when it found none or could not. */
  raise(pid: number): Promise<boolean>
  log(message: string): void
  /** The most viewers at once. */
  max?: number
}

/** Raised when a bot already has the most terminal windows it may have. */
export class TerminalViewerLimitError extends Error {
  constructor(readonly max: number) {
    super(`A bot can have at most ${max} terminal windows`)
    this.name = 'TerminalViewerLimitError'
  }
}

export const TERMINAL_VIEWERS_MAX = 8
const ATTACH_PROGRAM = '/usr/local/bin/maestrly-pty-attach'
const TITLE_MAX = 80
const DEFAULT_TITLE = 'Terminal'
const XDOTOOL_TIMEOUT_MS = 5_000
/**
 * The instance name of a terminal window opened for the bot's own work. Openbox gives a new window of this name no
 * keyboard focus (openbox-rc.xml), so what the owner is typing never lands in the bot's shell.
 */
export const QUIET_TERMINAL_NAME = 'maestrly-quiet'

interface Viewer {
  readonly process: TerminalViewerProcess
  readonly pid: number
}

function windowTitle(title: string): string {
  const clean = title.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim()
  const shortened = Array.from(clean).slice(0, TITLE_MAX).join('').trim()
  return shortened === '' ? DEFAULT_TITLE : shortened
}

export class TerminalViewers {
  private readonly viewers = new Map<string, Viewer>()
  private readonly max: number
  private disposed = false

  constructor(private readonly deps: TerminalViewersDeps) {
    this.max = deps.max ?? TERMINAL_VIEWERS_MAX
  }

  /**
   * Brings the window of the shell forward, or opens one. With `activate: false`, for the bot's own work, the window
   * comes forward without taking the keyboard. Rejects at the limit, or when `xterm` cannot start.
   */
  async show(ptyId: string, title: string, options: { activate?: boolean } = {}): Promise<void> {
    if (this.disposed) throw new Error('The terminal viewers were disposed')
    const activate = options.activate !== false
    const existing = this.viewers.get(ptyId)
    if (existing) {
      let shown = false
      try {
        shown = await (activate ? this.deps.activate(existing.pid) : this.deps.raise(existing.pid))
      } catch (error) {
        this.deps.log(`Bringing the terminal window of ${ptyId} forward failed: ${(error as Error).message}`)
        return
      }
      // The window may still be opening, so the viewer stays; asking again later finds it.
      if (!shown) this.deps.log(`The terminal window of ${ptyId} is not on screen yet`)
      return
    }
    if (this.viewers.size >= this.max) throw new TerminalViewerLimitError(this.max)

    let child: TerminalViewerProcess
    try {
      child = this.deps.spawn(
        'xterm',
        [
          '-class',
          'Maestrly-Terminal',
          ...(activate ? [] : ['-name', QUIET_TERMINAL_NAME]),
          '-T',
          windowTitle(title),
          '-fa',
          'DejaVu Sans Mono',
          '-fs',
          '11',
          '-bg',
          '#0b0b0d',
          '-fg',
          '#d8d5cc',
          '-geometry',
          '104x30',
          '-xrm',
          'XTerm*allowTitleOps: false',
          '-e',
          ATTACH_PROGRAM,
        ],
        { env: { ...this.deps.env, MAESTRLY_PTY_ID: ptyId } }
      )
    } catch (error) {
      this.deps.log(`Starting xterm for ${ptyId} failed: ${(error as Error).message}`)
      throw error
    }
    if (child.pid === undefined) {
      try {
        child.kill('SIGKILL')
      } catch {
        // It never ran.
      }
      this.deps.log(`xterm for ${ptyId} did not start`)
      throw new Error('xterm did not start')
    }
    const viewer: Viewer = { process: child, pid: child.pid }
    this.viewers.set(ptyId, viewer)
    const forget = (): void => {
      // A replacement for the same shell may already be registered.
      if (this.viewers.get(ptyId) === viewer) this.viewers.delete(ptyId)
    }
    child.exited.then(forget, forget)
  }

  /** Closes the window of the shell, if there is one. The shell keeps running. */
  close(ptyId: string): void {
    const viewer = this.viewers.get(ptyId)
    if (!viewer) return
    this.viewers.delete(ptyId)
    this.stop(viewer)
  }

  dispose(): void {
    this.disposed = true
    const viewers = [...this.viewers.values()]
    this.viewers.clear()
    for (const viewer of viewers) this.stop(viewer)
  }

  private stop(viewer: Viewer): void {
    try {
      viewer.process.kill('SIGTERM')
    } catch (error) {
      this.deps.log(`Stopping a terminal window failed: ${(error as Error).message}`)
    }
  }
}

/**
 * Brings forward the window that belongs to a pid on the bot's display (`xdotool search --pid`). Resolves false
 * when xdotool is missing, finds no window or does not answer within `timeoutMs`; it never rejects.
 */
export function xdotoolActivate(
  env: Readonly<Record<string, string>>,
  timeoutMs = XDOTOOL_TIMEOUT_MS
): (pid: number) => Promise<boolean> {
  return xdotoolOnPid(env, ['windowactivate', '--sync'], timeoutMs)
}

/** Raises the window that belongs to a pid on the bot's display without giving it the keyboard; as `xdotoolActivate`. */
export function xdotoolRaise(
  env: Readonly<Record<string, string>>,
  timeoutMs = XDOTOOL_TIMEOUT_MS
): (pid: number) => Promise<boolean> {
  return xdotoolOnPid(env, ['windowraise'], timeoutMs)
}

function xdotoolOnPid(
  env: Readonly<Record<string, string>>,
  action: readonly string[],
  timeoutMs: number
): (pid: number) => Promise<boolean> {
  return (pid) =>
    new Promise((resolve) => {
      if (!Number.isInteger(pid) || pid <= 0) {
        resolve(false)
        return
      }
      execFile(
        'xdotool',
        ['search', '--pid', String(pid), '--limit', '1', ...action],
        { env: { ...process.env, ...env }, timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true },
        (error) => resolve(error === null)
      )
    })
}
