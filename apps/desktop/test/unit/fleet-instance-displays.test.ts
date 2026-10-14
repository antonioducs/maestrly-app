import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import {
  SCREEN_LIMITS,
  ScreenMessageReader,
  decodeServerMessage,
  type ScreenServerEvent,
} from '@maestrly/bot-fleet-protocol'
import { describe, expect, it, vi } from 'vitest'
import {
  type BotDisplay,
  DisplayManager,
  type DisplayManagerDeps,
  type DisplaySurface,
} from '../../src/main/fleet/instance/displays'
import { ScreenSession, type ScreenPeer } from '../../src/main/fleet/instance/screen-session'

const HOME = '/srv/maestrly-displays-test/home'
const PROBES = new Set(['prepare-xvfb-display', 'xdpyinfo'])
const ENCODER = 'maestrly-screen-encoder'

function encoderMessage(type: number, payload: Uint8Array): Buffer {
  const header = Buffer.alloc(5)
  header[0] = type
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, Buffer.from(payload)])
}
/** What an encoder says once it captures its region. */
function encoderReady(args: string[]): Buffer {
  const [, , width, height] = args[args.indexOf('--region') + 1].split(',').map(Number)
  return encoderMessage(0x01, Buffer.from(JSON.stringify({ width, height, capture: 'XShm', encoder: 'x264' })))
}
/** An encoder's key frame: frame id, reference -1, the key flag, then an access unit with an IDR slice. */
function encoderKeyFrame(id: number): Buffer {
  const payload = Buffer.alloc(13)
  payload.writeUInt32BE(id, 0)
  payload.writeInt32BE(-1, 4)
  payload[8] = 1
  payload.set([0, 0, 1, 0x65], 9)
  return encoderMessage(0x02, payload)
}

/** A screen connection that keeps what its session sends it. */
class FakePeer implements ScreenPeer {
  closed = false
  readonly events: ScreenServerEvent[] = []
  private readonly reader = new ScreenMessageReader(SCREEN_LIMITS.serverPayloadMax)
  send(bytes: Uint8Array): void {
    for (const message of this.reader.push(bytes)) this.events.push(decodeServerMessage(message))
  }
  close(): void {
    this.closed = true
  }
}

function botEnv(botId: string, slot: number): Record<string, string> {
  return {
    DISPLAY: ':' + slot,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${HOME}/.cache/maestrly-bots/${botId}/bus`,
    BROWSER: '/usr/local/bin/maestrly-open-url',
    MAESTRLY_BOT_BROWSER_PROFILE: `${HOME}/.config/maestrly-bots/${botId}/chromium`,
    GTK_THEME: 'Adwaita:dark',
    MAESTRLY_DESKTOP_SOCKET: `${HOME}/.cache/maestrly-bots/${botId}/desktop.sock`,
  }
}

interface FakeTimer {
  at: number
  order: number
  callback: () => void
  unref: ReturnType<typeof vi.fn>
}

/** Timers the test advances by hand; every timer the manager creates is kept to check that it was unreferenced. */
class FakeClock {
  now = 0
  private order = 0
  readonly pending = new Set<FakeTimer>()
  readonly created: FakeTimer[] = []
  readonly setTimeout = ((callback: () => void, ms?: number) => {
    const timer: FakeTimer = { at: this.now + (ms ?? 0), order: this.order++, callback, unref: vi.fn() }
    timer.unref.mockReturnValue(timer)
    this.pending.add(timer)
    this.created.push(timer)
    return timer
  }) as unknown as typeof setTimeout
  readonly clearTimeout = ((timer: FakeTimer | undefined) => {
    if (timer) this.pending.delete(timer)
  }) as unknown as typeof clearTimeout

  async advance(ms: number): Promise<void> {
    const end = this.now + ms
    await settle()
    for (;;) {
      const next = [...this.pending]
        .filter((timer) => timer.at <= end)
        .sort((a, b) => a.at - b.at || a.order - b.order)[0]
      if (!next) break
      this.pending.delete(next)
      this.now = next.at
      next.callback()
      await settle()
    }
    this.now = end
  }
}

async function settle(): Promise<void> {
  for (let round = 0; round < 20; round++) await new Promise<void>((resolve) => setImmediate(resolve))
}

interface FakeProcess {
  command: string
  args: string[]
  env: Record<string, string>
  running: boolean
  killed: boolean
  signals: string[]
  exit(code: number | null): void
  /** A screen encoder's pipes. */
  stdin?: PassThrough
  stdout?: PassThrough
  stdinEnded?: boolean
}

/** Probes answer at once (0 unless `respond` says otherwise); servers run until the test ends or kills them. */
class FakeSpawner {
  readonly processes: FakeProcess[] = []
  exitOnKill = true
  exitOnForceKill = true
  respond: (command: string, args: string[]) => number | 'run' = (command) => (PROBES.has(command) ? 0 : 'run')
  readonly spawn: DisplayManagerDeps['spawn'] = (command, args, options) => {
    let resolveExit: (code: number | null) => void = () => undefined
    const exited = new Promise<number | null>((resolve) => {
      resolveExit = resolve
    })
    const child: FakeProcess = {
      command,
      args: [...args],
      env: { ...options.env },
      running: true,
      killed: false,
      signals: [],
      exit: (code) => {
        if (!child.running) return
        child.running = false
        resolveExit(code)
      },
    }
    this.processes.push(child)
    const response = this.respond(command, args)
    if (response !== 'run') child.exit(response)
    return {
      exited,
      kill: (signal = 'SIGTERM') => {
        child.killed = true
        child.signals.push(signal)
        if (this.exitOnKill || (signal === 'SIGKILL' && this.exitOnForceKill)) child.exit(null)
      },
    }
  }
  /** Screen encoders say they capture as soon as they start, unless this is false. */
  encoderReady = true
  readonly spawnEncoder: DisplayManagerDeps['spawnEncoder'] = (args) => {
    const handle = this.spawn(ENCODER, args, { env: {} })
    const child = this.processes[this.processes.length - 1]
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stdin.resume()
    child.stdin.on('finish', () => {
      child.stdinEnded = true
    })
    if (this.encoderReady && child.running) child.stdout.write(encoderReady(args))
    return { ...handle, stdin: child.stdin, stdout: child.stdout, stderr: new PassThrough() }
  }
  named(command: string): FakeProcess[] {
    return this.processes.filter((child) => child.command === command)
  }
  /** The encoders started for a display and region, such as `:0` and `1280,0,1280,800`. */
  encoders(display: string, region: string): FakeProcess[] {
    return this.named(ENCODER).filter(
      (child) => child.args.join(' ') === `--display ${display} --region ${region}`
    )
  }
  running(command: string): FakeProcess[] {
    return this.named(command).filter((child) => child.running)
  }
  servers(): FakeProcess[] {
    return this.processes.filter((child) => !PROBES.has(child.command))
  }
}

/** Every decoration the manager asked for, with the programs that had started by then. */
interface Decoration {
  display: BotDisplay
  started: string[]
}

function setup(options: Partial<Pick<DisplayManagerDeps, 'decorate' | 'language'>> = {}) {
  const clock = new FakeClock()
  const spawner = new FakeSpawner()
  const logs: string[] = []
  const mkdirs: string[] = []
  const decorations: Decoration[] = []
  const deps: DisplayManagerDeps = {
    spawn: spawner.spawn,
    spawnEncoder: spawner.spawnEncoder,
    now: () => clock.now,
    home: HOME,
    mkdir: async (directory) => {
      mkdirs.push(directory)
    },
    decorate: async (display) => {
      decorations.push({ display, started: spawner.processes.map((child) => child.command) })
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    log: (message) => {
      logs.push(message)
    },
    ...options,
  }
  return { clock, spawner, logs, mkdirs, decorations, deps, manager: new DisplayManager(deps) }
}

const environment: DisplaySurface = { kind: 'environment' }

describe('DisplayManager apps displays', () => {
  it('starts the apps display of slot 2 with its own bus, window manager, taskbar and browser profile', async () => {
    const { manager, spawner, mkdirs } = setup()
    const display = await manager.startBot('alpha', 2)
    expect(display).toEqual({
      botId: 'alpha',
      slot: 2,
      display: ':2',
      width: 1280,
      height: 800,
      env: botEnv('alpha', 2),
      browserArea: { x: 2560, y: 0, width: 1280, height: 800 },
    })
    expect(manager.bot('alpha')).toEqual(display)
    expect(manager.bot('beta')).toBeNull()
    expect(manager.environmentArea()).toEqual({ x: 0, y: 0, width: 1280, height: 800 })
    expect(mkdirs).toEqual([`${HOME}/.cache/maestrly-bots/alpha`, `${HOME}/.config/maestrly-bots/alpha/chromium`])
    expect(spawner.processes.map(({ command, args, env }) => ({ command, args, env }))).toEqual([
      {
        command: 'dbus-daemon',
        args: ['--session', '--nofork', '--nopidfile', `--address=unix:path=${HOME}/.cache/maestrly-bots/alpha/bus`],
        env: botEnv('alpha', 2),
      },
      { command: 'prepare-xvfb-display', args: [':2', '/tmp/.X2-lock', '/tmp/.X11-unix/X2'], env: {} },
      { command: 'Xvfb', args: [':2', '-screen', '0', '1280x800x24', '-nolisten', 'tcp', '-noreset'], env: {} },
      { command: 'xdpyinfo', args: ['-display', ':2'], env: {} },
      { command: 'openbox', args: ['--config-file', '/opt/maestrly/openbox-rc.xml'], env: botEnv('alpha', 2) },
      { command: 'tint2', args: ['-c', `${HOME}/.config/tint2/tint2rc`], env: botEnv('alpha', 2) },
      {
        command: 'maestrly-browser-presenter',
        args: ['--source', ':0', '--socket', `${HOME}/.cache/maestrly-bots/alpha/desktop.sock`],
        env: botEnv('alpha', 2),
      },
    ])
  })

  it('opens the window manager and taskbar only once the display answers', async () => {
    const { manager, spawner, clock } = setup()
    let probes = 0
    spawner.respond = (command) => (command === 'xdpyinfo' ? (++probes < 3 ? 1 : 0) : PROBES.has(command) ? 0 : 'run')
    let started = false
    const start = manager.startBot('alpha', 2).then(() => {
      started = true
    })
    await settle()
    expect(spawner.named('xdpyinfo')).toHaveLength(1)
    expect(spawner.named('openbox')).toHaveLength(0)
    await clock.advance(99)
    expect(spawner.named('xdpyinfo')).toHaveLength(1)
    await clock.advance(1)
    expect(spawner.named('xdpyinfo')).toHaveLength(2)
    expect(spawner.named('openbox')).toHaveLength(0)
    expect(started).toBe(false)
    await clock.advance(100)
    await start
    expect(spawner.named('xdpyinfo')).toHaveLength(3)
    expect(spawner.running('openbox')).toHaveLength(1)
    expect(spawner.running('tint2')).toHaveLength(1)
  })

  it('fails the start and cleans up when the display exits or never answers', async () => {
    const { manager, spawner, clock } = setup()
    spawner.respond = (command) => (command === 'xdpyinfo' ? 1 : PROBES.has(command) ? 0 : 'run')
    const crashed = manager.startBot('alpha', 2)
    const crashedResult = crashed.catch((error: unknown) => error)
    await settle()
    spawner.running('Xvfb')[0].exit(1)
    await clock.advance(1_000)
    expect(await crashedResult).toBeInstanceOf(Error)
    await expect(crashed).rejects.toThrow(/:2/)
    expect(spawner.servers().filter((child) => child.running)).toEqual([])
    expect(spawner.named('openbox')).toHaveLength(0)
    expect(manager.bot('alpha')).toMatchObject({ botId: 'alpha', slot: 2 })
    expect(clock.pending.size).toBe(0)

    const silent = manager.startBot('alpha', 2)
    const silentResult = silent.catch((error: unknown) => error)
    await clock.advance(4_000)
    expect(spawner.running('Xvfb')).toHaveLength(1)
    await clock.advance(6_000)
    expect(await silentResult).toBeInstanceOf(Error)
    await expect(silent).rejects.toThrow(/did not start/)
    expect(spawner.servers().filter((child) => child.running)).toEqual([])
    expect(clock.pending.size).toBe(0)
  })

  it('does not start a server on a display that is already in use', async () => {
    const { manager, spawner, clock } = setup()
    spawner.respond = (command) => (command === 'prepare-xvfb-display' ? 1 : PROBES.has(command) ? 0 : 'run')
    await expect(manager.startBot('alpha', 2)).rejects.toThrow(/:2 is already in use/)
    expect(spawner.named('Xvfb')).toHaveLength(0)
    expect(spawner.servers().filter((child) => child.running)).toEqual([])
    expect(clock.pending.size).toBe(0)
  })

  it('keeps Browser available after initial Apps failure and retries Apps on demand', async () => {
    const { manager, spawner } = setup()
    spawner.respond = (command) => (command === 'prepare-xvfb-display' ? 1 : PROBES.has(command) ? 0 : 'run')
    await expect(manager.startBot('alpha', 2)).rejects.toThrow(/already in use/)
    await expect(manager.startBot('beta', 2)).rejects.toThrow(/already used by bot alpha/)
    const browser = await manager.acquireScreen({ kind: 'browser', botId: 'alpha' })
    expect(browser.session).toBeInstanceOf(ScreenSession)
    expect(spawner.encoders(':0', '2560,0,1280,800')).toHaveLength(1)
    spawner.respond = (command) => (PROBES.has(command) ? 0 : 'run')
    const apps = await Promise.all([
      manager.acquireScreen({ kind: 'apps', botId: 'alpha' }),
      manager.acquireScreen({ kind: 'apps', botId: 'alpha' }),
    ])
    expect(apps[1].session).toBe(apps[0].session)
    expect(spawner.encoders(':2', '0,0,1280,800')).toHaveLength(1)
    expect(spawner.named('Xvfb')).toHaveLength(1)
    expect(spawner.encoders(':0', '2560,0,1280,800')[0].running).toBe(true)
    await manager.stopBot('alpha')
    expect(manager.bot('alpha')).toBeNull()
    expect(spawner.servers().filter((child) => child.running)).toEqual([])
  })

  it('kills processes that ignore SIGTERM before making the slot reusable', async () => {
    const { manager, spawner, clock } = setup()
    await manager.startBot('alpha', 2)
    spawner.exitOnKill = false
    const old = spawner.servers()
    const stopped = manager.stopBot('alpha')
    const replacement = manager.startBot('beta', 2)
    await clock.advance(4_999)
    expect(spawner.named('Xvfb')).toHaveLength(1)
    expect(old.every((child) => child.running)).toBe(true)
    await clock.advance(1)
    await stopped
    await replacement
    expect(old.every((child) => !child.running)).toBe(true)
    expect(old.every((child) => child.signals.join(',') === 'SIGTERM,SIGKILL')).toBe(true)
    expect(manager.bot('beta')?.slot).toBe(2)
  })

  it('does not restart Apps after an uninstall overtakes its retry', async () => {
    const { manager, spawner } = setup()
    spawner.respond = (command) => (command === 'prepare-xvfb-display' ? 1 : PROBES.has(command) ? 0 : 'run')
    await expect(manager.startBot('alpha', 2)).rejects.toThrow(/already in use/)
    spawner.respond = (command) => (PROBES.has(command) ? 0 : 'run')
    const retry = manager.acquireScreen({ kind: 'apps', botId: 'alpha' }).catch((error: unknown) => error)
    await manager.stopBot('alpha')
    expect(await retry).toBeInstanceOf(Error)
    expect(manager.bot('alpha')).toBeNull()
    expect(spawner.named('Xvfb')).toHaveLength(0)
    await expect(manager.startBot('beta', 2)).resolves.toMatchObject({ botId: 'beta', slot: 2 })
  })

  it('does not release a slot when processes survive SIGKILL', async () => {
    const { manager, spawner, clock } = setup()
    await manager.startBot('alpha', 2)
    spawner.exitOnKill = spawner.exitOnForceKill = false
    const stopped = manager.stopBot('alpha').catch((error: unknown) => error)
    await clock.advance(10_000)
    expect(await stopped).toBeInstanceOf(Error)
    await expect(manager.startBot('beta', 2)).rejects.toThrow(/SIGKILL/)
    expect(spawner.named('Xvfb')).toHaveLength(1)
    for (const child of spawner.servers()) child.exit(null)
  })

  it('starts each bot once and refuses invalid bots, slots and slot collisions', async () => {
    const { manager, spawner, deps } = setup()
    const [first, second] = await Promise.all([manager.startBot('alpha', 2), manager.startBot('alpha', 2)])
    expect(second).toBe(first)
    expect(await manager.startBot('alpha', 2)).toBe(first)
    expect(spawner.named('Xvfb')).toHaveLength(1)
    await expect(manager.startBot('beta', 2)).rejects.toThrow(/slot 2/)
    await expect(manager.startBot('alpha', 3)).rejects.toThrow(/slot 2/)
    for (const slot of [0, 9, -1, 1.5, Number.NaN]) await expect(manager.startBot('beta', slot)).rejects.toThrow(/slot/)
    for (const botId of ['', '../alpha', 'Alpha', 'a/b', 'alpha ', 'x'.repeat(33)])
      await expect(manager.startBot(botId, 3)).rejects.toThrow(/bot id/i)
    expect(spawner.named('Xvfb')).toHaveLength(1)
    expect(() => new DisplayManager({ ...deps, home: 'relative/home' })).toThrow(/home/)
    expect(() => new DisplayManager({ ...deps, home: '/home/with space' })).toThrow(/home/)
    const deepHome = new DisplayManager({ ...deps, home: '/' + 'h'.repeat(80) })
    await expect(deepHome.startBot('x'.repeat(32), 1)).rejects.toThrow(/too long/)
    // The desktop socket sits beside the bus socket, with a longer name: it is the one that must fit.
    const almost = new DisplayManager({ ...deps, home: '/' + 'h'.repeat(49) })
    await expect(almost.startBot('x'.repeat(28), 1)).rejects.toThrow(/desktop socket path .* too long/)
    expect(spawner.named('Xvfb')).toHaveLength(1)
  })

  it('stops only the given bot, never restarts it and frees its slot', async () => {
    const { manager, spawner, clock } = setup()
    await manager.startBot('alpha', 2)
    const alpha = spawner.servers()
    await manager.startBot('beta', 3)
    const beta = spawner.servers().filter((child) => !alpha.includes(child))
    await manager.stopBot('alpha')
    expect(alpha.map((child) => [child.command, child.killed, child.running])).toEqual([
      ['dbus-daemon', true, false],
      ['Xvfb', true, false],
      ['openbox', true, false],
      ['tint2', true, false],
      ['maestrly-browser-presenter', true, false],
    ])
    expect(beta.every((child) => child.running && !child.killed)).toBe(true)
    expect(manager.bot('alpha')).toBeNull()
    const spawned = spawner.processes.length
    await clock.advance(120_000)
    expect(spawner.processes).toHaveLength(spawned)
    await expect(manager.stopBot('alpha')).resolves.toBeUndefined()
    expect((await manager.startBot('gamma', 2)).display).toBe(':2')
  })

  it('aborts a start that is stopped before the display answers', async () => {
    const { manager, spawner, clock } = setup()
    spawner.respond = (command) => (command === 'xdpyinfo' ? 1 : PROBES.has(command) ? 0 : 'run')
    const start = manager.startBot('alpha', 2)
    const result = start.catch((error: unknown) => error)
    await clock.advance(250)
    await manager.stopBot('alpha')
    expect(await result).toBeInstanceOf(Error)
    await expect(start).rejects.toThrow(/stopped/)
    await clock.advance(10_000)
    expect(spawner.named('openbox')).toHaveLength(0)
    expect(spawner.servers().filter((child) => child.running)).toEqual([])
    expect(manager.bot('alpha')).toBeNull()
    expect(clock.pending.size).toBe(0)
  })

  it('restarts a crashed program after one second and gives up after five restarts in a minute', async () => {
    const { manager, spawner, clock, logs } = setup()
    await manager.startBot('alpha', 2)
    for (let crash = 1; crash <= 5; crash++) {
      spawner.running('tint2')[0].exit(1)
      await clock.advance(999)
      expect(spawner.named('tint2')).toHaveLength(crash)
      await clock.advance(1)
      expect(spawner.named('tint2')).toHaveLength(crash + 1)
      expect(spawner.running('tint2')[0].env).toEqual(botEnv('alpha', 2))
    }
    expect(spawner.named('Xvfb')).toHaveLength(1)
    spawner.running('tint2')[0].exit(1)
    await clock.advance(10_000)
    expect(spawner.named('tint2')).toHaveLength(6)
    expect(logs.some((line) => line.includes('alpha') && /giving up/i.test(line))).toBe(true)
    expect(spawner.servers().filter((child) => child.running)).toEqual([])
    expect(clock.pending.size).toBe(0)

    const browser = await manager.acquireScreen({ kind: 'browser', botId: 'alpha' })
    expect(browser.session).toBeInstanceOf(ScreenSession)
    await manager.acquireScreen({ kind: 'apps', botId: 'alpha' })
    expect(spawner.named('Xvfb')).toHaveLength(2)
    expect(spawner.running('tint2')).toHaveLength(1)
  })

  it('renews the restart budget once a minute has passed', async () => {
    const { manager, spawner, clock } = setup()
    await manager.startBot('alpha', 2)
    for (let crash = 1; crash <= 5; crash++) {
      spawner.running('dbus-daemon')[0].exit(1)
      await clock.advance(1_000)
    }
    expect(spawner.named('dbus-daemon')).toHaveLength(6)
    await clock.advance(60_000)
    spawner.running('dbus-daemon')[0].exit(1)
    await clock.advance(1_000)
    expect(spawner.named('dbus-daemon')).toHaveLength(7)
    expect(spawner.running('dbus-daemon')).toHaveLength(1)
    expect(spawner.running('dbus-daemon')[0].args).toEqual([
      '--session',
      '--nofork',
      '--nopidfile',
      `--address=unix:path=${HOME}/.cache/maestrly-bots/alpha/bus`,
    ])
  })

  it('brings the window manager and taskbar back after the display server restarts', async () => {
    const { manager, spawner, clock } = setup()
    await manager.startBot('alpha', 2)
    const before = spawner.processes.length
    spawner.running('openbox')[0].exit(1)
    spawner.running('Xvfb')[0].exit(1)
    spawner.running('tint2')[0].exit(1)
    await clock.advance(1_000)
    expect(spawner.processes.slice(before).map((child) => child.command)).toEqual([
      'prepare-xvfb-display',
      'Xvfb',
      'xdpyinfo',
      'openbox',
      'tint2',
    ])
    await clock.advance(10_000)
    expect(spawner.processes).toHaveLength(before + 5)
    expect(['dbus-daemon', 'Xvfb', 'openbox', 'tint2'].map((command) => spawner.running(command).length)).toEqual([
      1, 1, 1, 1,
    ])
  })

  it("supervises the bot's browser presenter apart from its display, and gives up on it alone", async () => {
    const { manager, spawner, clock, logs } = setup()
    await manager.startBot('alpha', 2)
    const presenter = 'maestrly-browser-presenter'
    expect(spawner.running(presenter)).toHaveLength(1)
    // It exits when the desktop service closes its connection: it comes back a second later.
    spawner.running(presenter)[0].exit(0)
    await clock.advance(1_000)
    expect(spawner.running(presenter)).toHaveLength(1)
    // A presenter that keeps crashing is given up after five restarts in a minute; the display goes on.
    for (let crash = 1; crash <= 5; crash++) {
      spawner.running(presenter)[0].exit(1)
      await clock.advance(1_000)
    }
    expect(spawner.named(presenter)).toHaveLength(7)
    spawner.running(presenter)[0].exit(1)
    await clock.advance(10_000)
    expect(spawner.named(presenter)).toHaveLength(7)
    expect(spawner.running(presenter)).toHaveLength(0)
    expect(logs.some((line) => line.includes('presenter') && /giving up/i.test(line))).toBe(true)
    expect(['dbus-daemon', 'Xvfb', 'openbox', 'tint2'].map((command) => spawner.running(command).length)).toEqual([
      1, 1, 1, 1,
    ])
    // The display server restarting brings it back with the window manager and taskbar.
    spawner.running('Xvfb')[0].exit(1)
    await clock.advance(1_000)
    expect(spawner.running(presenter)).toHaveLength(1)
  })

  it('never retries a presenter that is not installed or cannot run on these displays', async () => {
    for (const code of [127, 2]) {
      const { manager, spawner, clock, logs } = setup()
      spawner.respond = (command) => (command === 'maestrly-browser-presenter' ? code : PROBES.has(command) ? 0 : 'run')
      await manager.startBot('alpha', 2)
      await clock.advance(60_000)
      expect(spawner.named('maestrly-browser-presenter')).toHaveLength(1)
      expect(logs.filter((line) => line.includes('maestrly-browser-presenter'))).toHaveLength(1)
      expect(spawner.running('tint2')).toHaveLength(1)
    }
  })
})

describe('DisplayManager decoration', () => {
  it('decorates the display once, after the display answers and before the window manager and taskbar', async () => {
    const { manager, spawner, decorations } = setup()
    const display = await manager.startBot('alpha', 2)
    expect(decorations).toHaveLength(1)
    expect(decorations[0].display).toBe(display)
    expect(decorations[0].started).toEqual(['dbus-daemon', 'prepare-xvfb-display', 'Xvfb', 'xdpyinfo'])
    expect(spawner.named('openbox')).toHaveLength(1)
    expect(spawner.named('tint2')).toHaveLength(1)
    // Starting the same bot again reuses its display and does not paint it again.
    await manager.startBot('alpha', 2)
    expect(decorations).toHaveLength(1)
  })

  it('holds the window manager back while the decoration runs', async () => {
    let finish: () => void = () => undefined
    const { manager, spawner, clock } = setup({
      decorate: () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    })
    const start = manager.startBot('alpha', 2)
    await clock.advance(1_000)
    expect(spawner.named('Xvfb')).toHaveLength(1)
    expect(spawner.named('openbox')).toHaveLength(0)
    finish()
    await start
    expect(spawner.running('openbox')).toHaveLength(1)
    expect(spawner.running('tint2')).toHaveLength(1)
  })

  it('logs a decoration that fails and still brings the display to running', async () => {
    for (const failure of ['rejects', 'throws'] as const) {
      const { manager, spawner, logs, clock } = setup({
        decorate: (() => {
          if (failure === 'throws') throw new Error('rsvg-convert is missing')
          return Promise.reject(new Error('rsvg-convert is missing'))
        }) as DisplayManagerDeps['decorate'],
      })
      const display = await manager.startBot('alpha', 2)
      expect(manager.bot('alpha')).toBe(display)
      expect(spawner.running('openbox')).toHaveLength(1)
      expect(spawner.running('tint2')).toHaveLength(1)
      expect(
        logs.filter((line) => /alpha/.test(line) && /decorat/i.test(line) && /rsvg-convert is missing/.test(line))
      ).toHaveLength(1)
      // A failed decoration is not a crash: nothing restarts and the display accepts a screen.
      const spawned = spawner.processes.length
      await clock.advance(120_000)
      expect(spawner.processes).toHaveLength(spawned)
      expect((await manager.acquireScreen({ kind: 'apps', botId: 'alpha' })).session).toBeInstanceOf(ScreenSession)
      await manager.dispose()
    }
  })

  it('stops waiting for a decoration that never ends', async () => {
    const { manager, spawner, logs, clock } = setup({ decorate: () => new Promise<void>(() => undefined) })
    const start = manager.startBot('alpha', 2)
    await clock.advance(14_000)
    expect(spawner.named('openbox')).toHaveLength(0)
    await clock.advance(2_000)
    await start
    expect(spawner.running('openbox')).toHaveLength(1)
    expect(spawner.running('tint2')).toHaveLength(1)
    expect(logs.some((line) => /alpha/.test(line) && /decorat/i.test(line) && /did not finish/.test(line))).toBe(true)
    await manager.stopBot('alpha')
    expect(clock.pending.size).toBe(0)
  })

  it('aborts a start that is stopped while it decorates', async () => {
    const { manager, spawner, clock } = setup({ decorate: () => new Promise<void>(() => undefined) })
    const start = manager.startBot('alpha', 2)
    const result = start.catch((error: unknown) => error)
    await clock.advance(500)
    await manager.stopBot('alpha')
    expect(await result).toBeInstanceOf(Error)
    await expect(start).rejects.toThrow(/stopped/)
    await clock.advance(60_000)
    expect(spawner.named('openbox')).toHaveLength(0)
    expect(spawner.servers().filter((child) => child.running)).toEqual([])
    expect(manager.bot('alpha')).toBeNull()
    expect(clock.pending.size).toBe(0)
  })

  it('decorates again when the display server restarts, before its window manager comes back', async () => {
    const { manager, spawner, clock, decorations } = setup()
    await manager.startBot('alpha', 2)
    const before = spawner.processes.length
    spawner.running('openbox')[0].exit(1)
    spawner.running('Xvfb')[0].exit(1)
    spawner.running('tint2')[0].exit(1)
    await clock.advance(1_000)
    expect(decorations).toHaveLength(2)
    expect(decorations[1].started.slice(before)).toEqual(['prepare-xvfb-display', 'Xvfb', 'xdpyinfo'])
    expect(spawner.processes.slice(before).map((child) => child.command)).toEqual([
      'prepare-xvfb-display',
      'Xvfb',
      'xdpyinfo',
      'openbox',
      'tint2',
    ])
    // A crash of the window manager alone leaves the painted screen as it is.
    spawner.running('openbox')[0].exit(1)
    await clock.advance(1_000)
    expect(decorations).toHaveLength(2)
  })

  it('repaints a running display on request, one painting after another', async () => {
    const calls: string[] = []
    let release: () => void = () => undefined
    let blocked = true
    const { manager, clock } = setup({
      decorate: async (display) => {
        calls.push('begin ' + display.botId)
        if (blocked) await new Promise<void>((resolve) => (release = resolve))
        calls.push('end ' + display.botId)
      },
    })
    blocked = false
    await manager.startBot('alpha', 2)
    await manager.startBot('beta', 3)
    expect(calls).toEqual(['begin alpha', 'end alpha', 'begin beta', 'end beta'])
    calls.length = 0
    blocked = true
    const first = manager.redecorate('alpha')
    const second = manager.redecorate('alpha')
    await clock.advance(10)
    expect(calls).toEqual(['begin alpha'])
    blocked = false
    release()
    await Promise.all([first, second])
    expect(calls).toEqual(['begin alpha', 'end alpha', 'begin alpha', 'end alpha'])
  })

  it('repaints nothing for a bot that is unknown, still starting, between display servers or stopped', async () => {
    const { manager, spawner, decorations, clock } = setup()
    await expect(manager.redecorate('ghost')).resolves.toBeUndefined()

    let answers = false
    spawner.respond = (command) => (command === 'xdpyinfo' ? (answers ? 0 : 1) : PROBES.has(command) ? 0 : 'run')
    const start = manager.startBot('alpha', 2)
    await clock.advance(250)
    await expect(manager.redecorate('alpha')).resolves.toBeUndefined()
    answers = true
    await clock.advance(100)
    await start
    expect(decorations).toHaveLength(1)

    // The display server crashed and has not come back yet: its own restart paints the screen again.
    answers = false
    spawner.running('Xvfb')[0].exit(1)
    await clock.advance(500)
    await expect(manager.redecorate('alpha')).resolves.toBeUndefined()
    expect(decorations).toHaveLength(1)
    answers = true
    await clock.advance(1_000)
    expect(decorations).toHaveLength(2)

    await manager.stopBot('alpha')
    await expect(manager.redecorate('alpha')).resolves.toBeUndefined()
    expect(decorations).toHaveLength(2)
  })

  it('logs a failed repainting instead of raising it, and paints again after a later success', async () => {
    let fail = false
    const painted: string[] = []
    const { manager, logs } = setup({
      decorate: async (display) => {
        if (fail) throw new Error('hsetroot exited with code 1')
        painted.push(display.botId)
      },
    })
    await manager.startBot('alpha', 2)
    fail = true
    await expect(manager.redecorate('alpha')).resolves.toBeUndefined()
    expect(logs.some((line) => /alpha/.test(line) && /hsetroot exited with code 1/.test(line))).toBe(true)
    fail = false
    await manager.redecorate('alpha')
    expect(painted).toEqual(['alpha', 'alpha'])
    expect(manager.bot('alpha')).toMatchObject({ botId: 'alpha' })
  })

  it('does nothing once the manager is disposed, and without a decoration dependency', async () => {
    const { manager, decorations, deps } = setup()
    await manager.startBot('alpha', 2)
    await manager.dispose()
    await expect(manager.redecorate('alpha')).resolves.toBeUndefined()
    expect(decorations).toHaveLength(1)

    const bare: DisplayManagerDeps = { ...deps }
    delete bare.decorate
    const plain = new DisplayManager(bare)
    await plain.startBot('beta', 3)
    await expect(plain.redecorate('beta')).resolves.toBeUndefined()
    expect(plain.bot('beta')).toMatchObject({ botId: 'beta' })
    await plain.dispose()
  })

  it('gives the bot programs a dark GTK theme, and the display server and screen encoder nothing', async () => {
    const { manager, spawner } = setup()
    const display = await manager.startBot('alpha', 2)
    expect(display.env.GTK_THEME).toBe('Adwaita:dark')
    for (const command of ['dbus-daemon', 'openbox', 'tint2'])
      expect(spawner.named(command)[0].env.GTK_THEME, command).toBe('Adwaita:dark')
    expect(spawner.named('Xvfb')[0].env).toEqual({})
    await manager.acquireScreen({ kind: 'apps', botId: 'alpha' })
    // The encoder takes only its display and region: no bot variables reach it.
    expect(spawner.named(ENCODER).map((child) => [child.args, child.env])).toEqual([
      [['--display', ':2', '--region', '0,0,1280,800'], {}],
    ])
  })

  it('gives the taskbar, and only the taskbar, the language of the app', async () => {
    let language = 'pt_BR'
    const { manager, spawner, clock } = setup({ language: () => language })
    await manager.startBot('alpha', 2)
    expect(spawner.named('tint2')[0].env).toEqual({ ...botEnv('alpha', 2), LANGUAGE: 'pt_BR' })
    expect(spawner.named('openbox')[0].env).toEqual(botEnv('alpha', 2))
    expect(spawner.named('dbus-daemon')[0].env).toEqual(botEnv('alpha', 2))
    // The language is read when the taskbar starts, so a restart follows a change of the app's language.
    language = 'en'
    spawner.running('tint2')[0].exit(1)
    await clock.advance(1_000)
    expect(spawner.running('tint2')[0].env.LANGUAGE).toBe('en')
    language = ''
    spawner.running('tint2')[0].exit(1)
    await clock.advance(1_000)
    expect(spawner.running('tint2')[0].env).toEqual(botEnv('alpha', 2))
  })
})

describe('DisplayManager screens', () => {
  it('starts one encoder per surface with its display and region, and wires it to the session', async () => {
    const { manager, spawner } = setup()
    await manager.startBot('alpha', 1)
    await manager.startBot('beta', 4)
    const leases = [
      await manager.acquireScreen(environment),
      await manager.acquireScreen({ kind: 'browser', botId: 'alpha' }),
      await manager.acquireScreen({ kind: 'browser', botId: 'beta' }),
      await manager.acquireScreen({ kind: 'apps', botId: 'alpha' }),
      await manager.acquireScreen({ kind: 'apps', botId: 'beta' }),
    ]
    expect(spawner.named(ENCODER).map((child) => child.args)).toEqual([
      ['--display', ':0', '--region', '0,0,1280,800'],
      ['--display', ':0', '--region', '1280,0,1280,800'],
      ['--display', ':0', '--region', '1280,800,1280,800'],
      ['--display', ':1', '--region', '0,0,1280,800'],
      ['--display', ':4', '--region', '0,0,1280,800'],
    ])
    expect(new Set(leases.map((lease) => lease.session)).size).toBe(5)
    // Nothing listens anywhere: no probe of a port, no server but the encoders.
    expect(spawner.named('bash')).toEqual([])

    // The session sends what its encoder captures, and asks the encoder for what a client needs.
    const encoder = spawner.encoders(':1', '0,0,1280,800')[0]
    const commands: Buffer[] = []
    encoder.stdin!.removeAllListeners('data')
    encoder.stdin!.on('data', (chunk: Buffer) => commands.push(chunk))
    const peer = new FakePeer()
    leases[3].session.attach(peer, 'view')
    await settle()
    expect(Buffer.concat(commands).includes(Buffer.from([0x81, 0, 0, 0, 0]))).toBe(true)
    encoder.stdout!.write(encoderKeyFrame(7))
    await settle()
    expect(peer.events.map((event) => event.type)).toEqual(['hello', 'frame'])
    expect(peer.events[0]).toEqual({ type: 'hello', hello: { version: 1, width: 1280, height: 800, mode: 'view' } })

    await expect(manager.acquireScreen({ kind: 'browser', botId: 'ghost' })).rejects.toThrow(/ghost/)
    await expect(manager.acquireScreen({ kind: 'apps', botId: 'ghost' })).rejects.toThrow(/ghost/)
  })

  it('waits for ready and fails after 5 s without it, stopping the encoder', async () => {
    const { manager, spawner, clock } = setup()
    spawner.encoderReady = false
    let outcome: unknown = null
    const lease = manager.acquireScreen(environment).then(
      () => 'acquired',
      (error: unknown) => error
    )
    void lease.then((value) => {
      outcome = value
    })
    await clock.advance(4_999)
    expect(outcome).toBeNull()
    await clock.advance(1)
    expect(await lease).toBeInstanceOf(Error)
    expect(String(await lease)).toMatch(/did not start/)
    const encoder = spawner.named(ENCODER)[0]
    expect(encoder.stdinEnded).toBe(true)
    expect(encoder.signals).toEqual(['SIGTERM'])
    expect(encoder.running).toBe(false)
    // The next lease starts a new encoder.
    spawner.encoderReady = true
    await expect(manager.acquireScreen(environment)).resolves.toMatchObject({ session: expect.any(ScreenSession) })
    expect(spawner.named(ENCODER)).toHaveLength(2)
  })

  it('fails a lease whose encoder exits before it captures', async () => {
    const { manager, spawner, logs } = setup()
    spawner.encoderReady = false
    const lease = manager.acquireScreen(environment).catch((error: unknown) => error)
    await settle()
    spawner.named(ENCODER)[0].exit(1)
    expect(String(await lease)).toMatch(/exited before it started/)
    expect(logs.some((line) => /encoder of environment exited with code 1/.test(line))).toBe(true)
  })

  it('shares one session per surface and stops it a minute after the last lease', async () => {
    const { manager, spawner, clock } = setup()
    const [first, second] = await Promise.all([
      manager.acquireScreen(environment),
      manager.acquireScreen(environment),
    ])
    expect(second.session).toBe(first.session)
    expect(spawner.named(ENCODER)).toHaveLength(1)
    const encoder = spawner.named(ENCODER)[0]
    first.release()
    first.release()
    await clock.advance(120_000)
    expect(encoder.killed).toBe(false)
    second.release()
    await clock.advance(59_999)
    expect(encoder.killed).toBe(false)
    await clock.advance(1)
    expect(encoder.killed).toBe(true)
    expect(encoder.stdinEnded).toBe(true)

    const third = await manager.acquireScreen(environment)
    expect(spawner.named(ENCODER)).toHaveLength(2)
    expect(third.session).not.toBe(first.session)
    third.release()
    await clock.advance(30_000)
    const fourth = await manager.acquireScreen(environment)
    expect(fourth.session).toBe(third.session)
    expect(spawner.named(ENCODER)).toHaveLength(2)
    await clock.advance(120_000)
    expect(spawner.named(ENCODER)[1].killed).toBe(false)
    fourth.release()
    await clock.advance(60_000)
    expect(spawner.named(ENCODER)[1].killed).toBe(true)
    expect(clock.created.length).toBeGreaterThan(0)
    expect(clock.created.every((timer) => timer.unref.mock.calls.length > 0)).toBe(true)
    expect(clock.pending.size).toBe(0)
  })

  it('ends the session when the encoder exits and starts a new one on the next lease', async () => {
    const { manager, spawner, logs } = setup()
    const lease = await manager.acquireScreen({ kind: 'environment' })
    const peer = new FakePeer()
    lease.session.attach(peer, 'control')
    spawner.named(ENCODER)[0].exit(1)
    await settle()
    expect(peer.closed).toBe(true)
    expect(logs.some((line) => /screen encoder of environment exited with code 1/.test(line))).toBe(true)
    const next = await manager.acquireScreen(environment)
    expect(next.session).not.toBe(lease.session)
    expect(spawner.named(ENCODER)).toHaveLength(2)
    // The first lease belongs to a stopped encoder: giving it back does not stop the new one.
    lease.release()
    next.release()
  })

  it('starts a new encoder only after the stopping one has exited, and escalates to SIGKILL', async () => {
    const { manager, spawner, clock } = setup()
    spawner.exitOnKill = false
    ;(await manager.acquireScreen(environment)).release()
    await clock.advance(60_000)
    const old = spawner.named(ENCODER)[0]
    expect(old.signals).toEqual(['SIGTERM'])
    expect(old.running).toBe(true)
    let acquired = false
    const next = manager.acquireScreen(environment).then((lease) => {
      acquired = true
      return lease
    })
    await clock.advance(4_999)
    expect(spawner.named(ENCODER)).toHaveLength(1)
    expect(acquired).toBe(false)
    await clock.advance(1)
    expect(old.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect((await next).session).toBeInstanceOf(ScreenSession)
    expect(spawner.named(ENCODER)).toHaveLength(2)
  })

  it('does not start an encoder for a surface whose previous encoder survived both signals', async () => {
    const { manager, spawner, clock } = setup()
    spawner.exitOnKill = spawner.exitOnForceKill = false
    ;(await manager.acquireScreen(environment)).release()
    await clock.advance(70_000)
    expect(spawner.named(ENCODER)[0].signals).toEqual(['SIGTERM', 'SIGKILL'])
    await expect(manager.acquireScreen(environment)).rejects.toThrow(/SIGKILL/)
    expect(spawner.named(ENCODER)).toHaveLength(1)
    spawner.named(ENCODER)[0].exit(null)
  })

  it('waits for a starting apps display before serving it', async () => {
    const { manager, spawner, clock } = setup()
    let ready = false
    spawner.respond = (command) => (command === 'xdpyinfo' ? (ready ? 0 : 1) : PROBES.has(command) ? 0 : 'run')
    const start = manager.startBot('alpha', 2)
    const lease = manager.acquireScreen({ kind: 'apps', botId: 'alpha' })
    await clock.advance(300)
    expect(spawner.named(ENCODER)).toHaveLength(0)
    ready = true
    await clock.advance(100)
    await start
    expect((await lease).session).toBeInstanceOf(ScreenSession)
    const commands = spawner.processes.map((child) => child.command)
    expect(commands.indexOf(ENCODER)).toBeGreaterThan(commands.lastIndexOf('xdpyinfo'))
  })

  it("stopBot ends that bot's browser and apps sessions only, and ignores its old leases", async () => {
    const { manager, spawner, clock } = setup()
    await manager.startBot('alpha', 2)
    const browser = await manager.acquireScreen({ kind: 'browser', botId: 'alpha' })
    const apps = await manager.acquireScreen({ kind: 'apps', botId: 'alpha' })
    const shared = await manager.acquireScreen(environment)
    const peers = [browser, apps, shared].map((lease) => {
      const peer = new FakePeer()
      lease.session.attach(peer, 'view')
      return peer
    })
    await manager.stopBot('alpha')
    expect(spawner.encoders(':0', '2560,0,1280,800')[0].killed).toBe(true)
    expect(spawner.encoders(':2', '0,0,1280,800')[0].killed).toBe(true)
    expect(spawner.encoders(':0', '0,0,1280,800')[0].killed).toBe(false)
    expect(peers.map((peer) => peer.closed)).toEqual([true, true, false])
    await expect(manager.acquireScreen({ kind: 'browser', botId: 'alpha' })).rejects.toThrow(/alpha/)
    await manager.startBot('beta', 2)
    const next = await manager.acquireScreen({ kind: 'browser', botId: 'beta' })
    expect(spawner.encoders(':0', '2560,0,1280,800')).toHaveLength(2)
    browser.release()
    apps.release()
    await clock.advance(120_000)
    expect(spawner.encoders(':0', '2560,0,1280,800')[1].killed).toBe(false)
    next.release()
    shared.release()
    await clock.advance(60_000)
    expect(spawner.encoders(':0', '2560,0,1280,800')[1].killed).toBe(true)
    expect(spawner.encoders(':0', '0,0,1280,800')[0].killed).toBe(true)
  })

  it('stops every display, encoder and timer on dispose', async () => {
    const { manager, spawner, clock } = setup()
    await manager.startBot('alpha', 2)
    await manager.startBot('beta', 3)
    ;(await manager.acquireScreen(environment)).release()
    const held = await manager.acquireScreen({ kind: 'apps', botId: 'beta' })
    spawner.running('tint2')[0].exit(1)
    await settle()
    expect(clock.pending.size).toBeGreaterThan(0)
    await manager.dispose()
    expect(spawner.servers().filter((child) => child.running)).toEqual([])
    expect(clock.pending.size).toBe(0)
    held.release()
    await clock.advance(120_000)
    expect(spawner.servers().filter((child) => child.running)).toEqual([])
    await expect(manager.startBot('gamma', 4)).rejects.toThrow(/disposed/)
    await expect(manager.acquireScreen(environment)).rejects.toThrow(/disposed/)
    expect(manager.bot('alpha')).toBeNull()
    await expect(manager.dispose()).resolves.toBeUndefined()
  })
})

describe.skipIf(process.platform === 'win32')('maestrly-bot-browser', () => {
  const wrapper = fileURLToPath(new URL('../../../../deploy/bot-fleet/maestrly-bot-browser', import.meta.url))

  it('is a valid POSIX shell script', () => {
    expect(readFileSync(wrapper, 'utf8').split('\n')[0]).toBe('#!/bin/sh')
    expect(spawnSync('sh', ['-n', wrapper], { encoding: 'utf8' }).status).toBe(0)
  })

  it('opens Chromium with the bot profile and passes every argument through', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'maestrly-bot-browser-'))
    try {
      writeFileSync(path.join(directory, 'chromium'), '#!/bin/sh\nprintf \'%s\\n\' "$@"\n', { mode: 0o755 })
      const env = { ...process.env, PATH: directory + path.delimiter + process.env.PATH }
      const profile = path.join(directory, 'profile dir')
      const run = spawnSync('sh', [wrapper, 'https://example.test/a b', '--new-window'], {
        env: { ...env, MAESTRLY_BOT_BROWSER_PROFILE: profile },
        encoding: 'utf8',
      })
      expect(run.status).toBe(0)
      expect(run.stdout.split('\n').slice(0, -1)).toEqual([
        '--no-first-run',
        '--no-default-browser-check',
        '--password-store=basic',
        '--user-data-dir=' + profile,
        'https://example.test/a b',
        '--new-window',
      ])
      const missing = spawnSync('sh', [wrapper, 'https://example.test/'], {
        env: { ...env, MAESTRLY_BOT_BROWSER_PROFILE: '' },
        encoding: 'utf8',
      })
      expect(missing.status).not.toBe(0)
      expect(missing.stdout).toBe('')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
