import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { chmod, lstat, mkdir, readFile, readdir, readlink, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { runtimeError } from '../turns/service.js'

const execute = promisify(execFile)
// Ubuntu's /usr/bin/x0vncserver is a Perl wrapper that resolves the FQDN and aborts in
// a guest without a NIC. The pinned scraping server executable is called directly.
export const VNC_BINARY = process.env.MAESTRLY_VNC_BINARY ?? '/usr/bin/X0tigervnc'
const REQUIRED = [
  'display', 'desktop', 'rfbport', 'rfbunixpath', 'rfbunixmode', 'SecurityTypes',
  'AcceptKeyEvents', 'AcceptPointerEvents', 'AcceptSetDesktopSize',
  'AlwaysShared', 'NeverShared', 'DisconnectClients', 'FrameRate', 'QueryConnect',
] as const
const CLIPBOARD = ['AcceptCutText', 'SendCutText', 'SendPrimary', 'SetPrimary'] as const
/** Scraping-server releases verified to contain no clipboard implementation at all. */
const CLIPBOARD_ABSENT_VERSIONS = /^1\.13\.\d+$/
export type VncProbe = { version: string; parameters: string[]; clipboard: 'disabled-by-flags' | 'absent' }

/** Verifies the binary against the mandatory read-only configuration; fails closed. */
export async function probeVnc(binary = VNC_BINARY): Promise<VncProbe> {
  const env = { PATH: '/usr/bin:/bin', LANG: 'C' }
  const output = async (args: string[]) => {
    const result = await execute(binary, args, { timeout: 5_000, env, maxBuffer: 256 * 1024 }).catch(
      (error: { stdout?: string; stderr?: string; code?: unknown }) => {
        if (error.code === 'ENOENT') throw runtimeError('DESKTOP_UPDATE_REQUIRED', 'Screen sharing is not installed')
        return { stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
      }
    )
    return `${result.stdout}${result.stderr}`
  }
  const version = /TigerVNC Server version (\d+\.\d+\.\d+)/.exec(await output(['-version']))?.[1]
  const parameters = [...(await output(['-h'])).matchAll(/^ {2}([A-Za-z0-9.]+) +- /gm)].map((match) => match[1])
  if (!version || REQUIRED.some((name) => !parameters.includes(name)))
    throw runtimeError('DESKTOP_UPDATE_REQUIRED', 'Screen sharing lacks the mandatory read-only options')
  const clipboard = CLIPBOARD.every((name) => parameters.includes(name))
    ? 'disabled-by-flags'
    : CLIPBOARD.some((name) => parameters.includes(name)) || !CLIPBOARD_ABSENT_VERSIONS.test(version)
      ? undefined
      : 'absent'
  if (!clipboard) throw runtimeError('DESKTOP_UPDATE_REQUIRED', 'Clipboard sharing cannot be disabled in this screen server')
  return { version, parameters, clipboard }
}
/** RFB never carries input: the server refuses keys, pointer, resize and clipboard. */
export function vncArguments(probe: VncProbe, options: { display: string; socketPath: string; frameRate?: number }): string[] {
  if (!/^:[0-9]{1,4}$/.test(options.display)) throw runtimeError('DESKTOP_CONFIGURATION', 'Invalid display')
  if (!/^\/[A-Za-z0-9._/-]{1,100}$/.test(options.socketPath) || options.socketPath.includes('..'))
    throw runtimeError('DESKTOP_CONFIGURATION', 'Invalid screen socket path')
  // The frame timer is the floor of screen latency: 15 fps measured p50 66 ms from input to
  // pixel, 60 fps 16 ms, for about two points of extra CPU (scripts/test/desktop-frame-bench.ts).
  const frameRate = Math.min(60, Math.max(1, Math.trunc(options.frameRate ?? 60)))
  return [
    `-display=${options.display}`,
    '-desktop=maestrly',
    // TCP disabled; the only listener is a 0600 Unix socket in a private directory.
    '-rfbport=-1',
    `-rfbunixpath=${options.socketPath}`,
    '-rfbunixmode=384',
    // No VNC password is an authority here: the mediated gateway authenticates viewers.
    '-SecurityTypes=None',
    '-AcceptKeyEvents=0',
    '-AcceptPointerEvents=0',
    '-AcceptSetDesktopSize=0',
    // Observers share one framebuffer and never disconnect the controller.
    '-AlwaysShared=1',
    '-NeverShared=0',
    '-DisconnectClients=0',
    '-QueryConnect=0',
    `-FrameRate=${frameRate}`,
    ...(probe.parameters.includes('UseBlacklist') ? ['-UseBlacklist=0'] : []),
    ...(probe.clipboard === 'disabled-by-flags' ? ['-AcceptCutText=0', '-SendCutText=0', '-SendPrimary=0', '-SetPrimary=0'] : []),
  ]
}
/** Collects TCP inodes in LISTEN state visible in this network namespace. */
async function tcpListeners(): Promise<Set<string>> {
  const inodes = new Set<string>()
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const text = await readFile(table, 'utf8').catch(() => '')
    for (const line of text.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/)
      if (fields[3] === '0A' && fields[9]) inodes.add(fields[9])
    }
  }
  return inodes
}
/** Proves a process owns no listening TCP socket (Linux only). */
export async function assertNoTcpListener(pid: number) {
  const listeners = await tcpListeners()
  for (const fd of await readdir(`/proc/${pid}/fd`).catch(() => [] as string[])) {
    const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '')
    const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1]
    if (inode && listeners.has(inode)) throw runtimeError('DESKTOP_UNAVAILABLE', 'Screen server opened a TCP listener')
  }
}

/**
 * On-demand transmitter for one session. It shares the existing X display; it never
 * creates another X server or reads the physical Host screen. The last viewer leaving
 * stops only the transmitter, after a short grace period.
 */
export class VncTransmitter {
  private child?: ChildProcess
  private starting?: Promise<void>
  private users = 0
  private idle?: NodeJS.Timeout
  private exitListeners = new Set<() => void>()
  private probed?: Promise<VncProbe>
  constructor(
    private readonly options: {
      display: string
      socketPath: string
      environment: NodeJS.ProcessEnv
      binary?: string
      idleMs?: number
      frameRate?: number
      probe?: () => Promise<VncProbe>
      verifyListeners?: boolean
    }
  ) {}
  get socketPath() {
    return this.options.socketPath
  }
  get running() {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null
  }
  get viewers() {
    return this.users
  }
  /** Verifies the pinned binary once; a failure keeps the live capability absent. */
  probe(): Promise<VncProbe> {
    this.probed ??= (this.options.probe ?? (() => probeVnc(this.options.binary)))().catch((error) => {
      this.probed = undefined
      throw error
    })
    return this.probed
  }
  onExit(listener: () => void) {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }
  /** Adds a viewer reference and returns once the private socket accepts connections. */
  async acquire(): Promise<string> {
    clearTimeout(this.idle)
    this.idle = undefined
    this.users++
    try {
      await this.ensure()
      return this.options.socketPath
    } catch (error) {
      this.release()
      throw error
    }
  }
  release() {
    this.users = Math.max(0, this.users - 1)
    if (this.users || this.idle) return
    this.idle = setTimeout(() => {
      this.idle = undefined
      if (!this.users) void this.stop()
    }, this.options.idleMs ?? 5_000)
    this.idle.unref?.()
  }
  private ensure() {
    if (this.running && !this.starting) return Promise.resolve()
    this.starting ??= this.start().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }
  private async start() {
    const probe = await this.probe()
    const directory = dirname(this.options.socketPath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.())
      throw runtimeError('DESKTOP_CONFIGURATION', 'Screen socket directory is not private')
    await chmod(directory, 0o700)
    const stale = await lstat(this.options.socketPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
    if (stale && !stale.isSocket()) throw runtimeError('DESKTOP_CONFIGURATION', 'Unexpected file at screen socket path')
    if (stale) await rm(this.options.socketPath, { force: true })
    const env = {
      PATH: '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      DISPLAY: this.options.display,
      ...(this.options.environment.XAUTHORITY ? { XAUTHORITY: this.options.environment.XAUTHORITY } : {}),
      ...(this.options.environment.HOME ? { HOME: this.options.environment.HOME } : {}),
    }
    const child = spawn(this.options.binary ?? VNC_BINARY, vncArguments(probe, { ...this.options }), {
      env,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    this.child = child
    child.once('exit', () => {
      if (this.child !== child) return
      this.child = undefined
      for (const listener of this.exitListeners) listener()
    })
    const failed = new Promise<never>((_, reject) => {
      child.once('error', () => reject(runtimeError('DESKTOP_UNAVAILABLE', 'Screen server could not start')))
      child.once('exit', () => reject(runtimeError('DESKTOP_UNAVAILABLE', 'Screen server exited during startup')))
    })
    failed.catch(() => {})
    const deadline = Date.now() + 5_000
    for (;;) {
      const socket = await lstat(this.options.socketPath).catch(() => undefined)
      if (socket?.isSocket()) {
        if ((socket.mode & 0o777) !== 0o600 || socket.uid !== process.getuid?.()) {
          await this.stop()
          throw runtimeError('DESKTOP_CONFIGURATION', 'Screen socket permissions are not private')
        }
        break
      }
      if (Date.now() > deadline) {
        await this.stop()
        throw runtimeError('DESKTOP_UNAVAILABLE', 'Screen server did not open its socket')
      }
      await Promise.race([new Promise((resolve) => setTimeout(resolve, 50)), failed])
    }
    if ((this.options.verifyListeners ?? process.platform === 'linux') && child.pid) {
      try {
        await assertNoTcpListener(child.pid)
      } catch (error) {
        await this.stop()
        throw error
      }
    }
  }
  async stop() {
    clearTimeout(this.idle)
    this.idle = undefined
    const child = this.child
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 2_000)
      await exited
      clearTimeout(timer)
    }
    if (this.child === child) this.child = undefined
    await rm(this.options.socketPath, { force: true }).catch(() => {})
  }
  async close() {
    this.users = 0
    await this.stop()
  }
}
