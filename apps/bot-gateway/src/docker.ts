import http from 'node:http'
import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { GatewayError } from './errors.js'
import { tarFiles } from './tar.js'

export type ContainerSpec = {
  name: string
  image: string
  hostname: string
  labels: Record<string, string>
  env: string[]
  network: string
  volume: string
  /** Directories of the Docker host mounted into the container, besides its home volume. */
  binds?: Array<{ source: string; target: string }>
  memory: number
  /** CPUs the container may use, in billionths of a CPU (Docker's `NanoCpus`); absent: every CPU. */
  nanoCpus?: number
  shmSize: number
  securityOpt: string[]
  user: string
  capAdd: string[]
}
/** A short-lived container that runs one command and is removed: no network, no home volume, no restart. */
export type OneShotSpec = {
  image: string
  /** The program and its arguments, in place of the image's entrypoint. */
  command: string[]
  user: string
  binds: Array<{ source: string; target: string }>
  securityOpt: string[]
  /** The container keeps only these capabilities. */
  capAdd: string[]
  labels: Record<string, string>
}
export type HelperMount = { type: 'volume' | 'bind'; source: string; target: string; readOnly: boolean }
/** A file written into a helper before it starts; `path` is relative to `/`, entries are owned by uid/gid 1000. */
export type HelperFile = { path: string; content: string | Buffer; mode: number }
/** A short-lived container that runs one program to its end with mounts, files and a network, streaming its output. */
export type HelperSpec = {
  image: string
  command: string[]
  user: string
  env: string[]
  /** A network with outbound access, or 'none'. */
  network: string
  mounts: HelperMount[]
  files: HelperFile[]
  securityOpt: string[]
  capAdd: string[]
  labels: Record<string, string>
  timeoutMs: number
  signal?: AbortSignal
  /** Each complete stdout line, as the program prints it. */
  onStdoutLine?: (line: string) => void
  /** Bytes of stdout kept in the result (its tail); default 1 MiB. stderr keeps its last 64 KiB. */
  stdoutLimitBytes?: number
}
export type HelperResult = {
  exitCode: number
  stdout: string
  stderr: string
  ending: 'exited' | 'timeout' | 'cancelled'
}
const HELPER_STDOUT_LIMIT = 1024 * 1024
const HELPER_STDERR_LIMIT = 64 * 1024
/** How long a helper's end is awaited once its output closed, or once it was killed. */
const HELPER_WAIT_MS = 30_000
/** A container attached to a network, with its addresses there (without prefix lengths). */
export type NetworkMember = { id: string; name: string; addresses: string[] }
export type ContainerInfo = {
  id: string
  imageId: string
  name: string
  state: 'running' | 'exited' | 'created'
  startedAt: string | null
  labels: Record<string, string>
}
export type ContainerStats = { memoryBytes: number; memoryLimitBytes: number; cpuPercent: number }
/** What a container's cgroup reports beyond Docker's stats; a figure the server does not provide is null. */
export type CgroupMemory = { swapBytes: number | null; oomKills: number | null; limitOoms: number | null }
export const NO_CGROUP_MEMORY: CgroupMemory = { swapBytes: null, oomKills: null, limitOoms: null }
export type ImageInfo = { id: string; version?: string | null }
/** A fleet network subnet and its bridge gateway address (the host side of the bridge). */
export type FleetNetworkSubnet = { subnet: string; gateway: string | null }
export interface DockerDriver {
  version(): Promise<string>
  /** Creates a bridge network unless one of that name exists; labels apply only to a network it creates. */
  ensureNetwork(name: string, labels?: Record<string, string>): Promise<void>
  networkInspect(name: string): Promise<FleetNetworkSubnet[]>
  /** The containers attached to a network; empty when there is no such network. */
  networkMembers(name: string): Promise<NetworkMember[]>
  /** Attaches a container to a network under these extra names; one already attached is left as it is. */
  networkConnect(name: string, container: string, aliases: string[]): Promise<void>
  /** Detaches a container from a network; one not attached, or a network that is gone, is not an error. */
  networkDisconnect(name: string, container: string): Promise<void>
  /** Removes a network; one already gone is not an error. */
  networkRemove(name: string): Promise<void>
  /** Runs a one-shot container to its end and removes it; returns its exit code. */
  runOnce(spec: OneShotSpec): Promise<number>
  /** Runs a helper container to its end, streaming its output, and removes it whatever happens. */
  runHelper(spec: HelperSpec): Promise<HelperResult>
  imageInspect(ref: string): Promise<ImageInfo | null>
  volumeCreate(name: string, labels: Record<string, string>): Promise<void>
  volumeExists(name: string): Promise<boolean>
  /** Removes a volume; one already gone is not an error, one a container uses fails with 409. */
  volumeRemove(name: string): Promise<void>
  containerCreate(spec: ContainerSpec): Promise<string>
  start(id: string): Promise<void>
  stop(id: string, timeoutSec?: number): Promise<void>
  restart(id: string): Promise<void>
  remove(id: string, force?: boolean): Promise<void>
  /** Changes a container's memory limit (and its swap, twice the limit as Docker sets by default) in place. */
  updateMemory(id: string, bytes: number): Promise<void>
  /** Changes a container's CPU limit in place, in billionths of a CPU; 0 lifts it. */
  updateCpus(id: string, nanoCpus: number): Promise<void>
  inspect(id: string): Promise<ContainerInfo>
  list(label?: string): Promise<ContainerInfo[]>
  statsOnce(id: string): Promise<ContainerStats>
  /** The swap and out-of-memory kills of a running container, which Docker's stats leave out on cgroup v2. */
  cgroupMemory(id: string): Promise<CgroupMemory>
}
export class DockerError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}
export function parseDockerStats(raw: any): ContainerStats {
  const cpu = raw.cpu_stats?.cpu_usage?.total_usage ?? 0
  const prev = raw.precpu_stats?.cpu_usage?.total_usage ?? 0
  const system = raw.cpu_stats?.system_cpu_usage ?? 0
  const prevSystem = raw.precpu_stats?.system_cpu_usage ?? 0
  const cores = raw.cpu_stats?.online_cpus ?? raw.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 1
  const cpuPercent = system > prevSystem ? Math.max(0, ((cpu - prev) / (system - prevSystem)) * cores * 100) : 0
  const usage = raw.memory_stats?.usage ?? 0
  const cache = raw.memory_stats?.stats?.inactive_file ?? 0
  return { memoryBytes: Math.max(0, usage - cache), memoryLimitBytes: raw.memory_stats?.limit ?? 0, cpuPercent }
}
/**
 * Reads what `cat memory.swap.current memory.events` printed in a container (cgroup v2): the swap is the bare number,
 * the events are `name count` lines. The container writes this output, so only whole safe numbers count, and a file it
 * lacks leaves its figures null.
 */
export function parseCgroupMemory(text: string): CgroupMemory {
  let swapBytes: number | null = null
  const events = new Map<string, number>()
  for (const line of text.split('\n')) {
    const value = line.trim()
    if (/^\d+$/.test(value)) swapBytes ??= Number(value)
    const event = /^([a-z_]+) (\d+)$/.exec(value)
    if (event && !events.has(event[1])) events.set(event[1], Number(event[2]))
  }
  const safe = (value: number | null | undefined) => (value !== undefined && Number.isSafeInteger(value) ? value : null)
  return { swapBytes: safe(swapBytes), oomKills: safe(events.get('oom_kill')), limitOoms: safe(events.get('oom')) }
}
/**
 * Splits the output of a program run without a terminal, which Docker frames as [stream, 0, 0, 0, size (4 bytes)],
 * into its streams as the bytes arrive: a header or a frame may be cut anywhere between chunks.
 */
export class DockerStreamDemuxer {
  private header = Buffer.alloc(0)
  private remaining = 0
  private stream: 'stdout' | 'stderr' | null = null
  push(chunk: Buffer): Array<{ stream: 'stdout' | 'stderr'; data: Buffer }> {
    const parts: Array<{ stream: 'stdout' | 'stderr'; data: Buffer }> = []
    let offset = 0
    while (offset < chunk.length) {
      if (this.remaining === 0) {
        const needed = 8 - this.header.length
        this.header = Buffer.concat([this.header, chunk.subarray(offset, offset + needed)])
        offset += Math.min(needed, chunk.length - offset)
        if (this.header.length < 8) break
        this.stream = this.header[0] === 1 ? 'stdout' : this.header[0] === 2 ? 'stderr' : null
        this.remaining = this.header.readUInt32BE(4)
        this.header = Buffer.alloc(0)
        continue
      }
      const take = Math.min(this.remaining, chunk.length - offset)
      if (this.stream) parts.push({ stream: this.stream, data: chunk.subarray(offset, offset + take) })
      offset += take
      this.remaining -= take
    }
    return parts
  }
}
/** The standard output of a command run without a terminal, which Docker frames as [stream, 0, 0, 0, size (4 bytes)]. */
export function execStdout(raw: Buffer): Buffer {
  return Buffer.concat(
    new DockerStreamDemuxer()
      .push(raw)
      .filter((part) => part.stream === 'stdout')
      .map((part) => part.data)
  )
}
/** Keeps the last `limit` bytes written to it. */
class TailBuffer {
  private chunks: Buffer[] = []
  private size = 0
  constructor(private readonly limit: number) {}
  push(data: Buffer) {
    this.chunks.push(data)
    this.size += data.length
    while (this.size > this.limit && this.chunks.length) {
      const excess = this.size - this.limit
      const first = this.chunks[0]
      if (first.length <= excess) {
        this.chunks.shift()
        this.size -= first.length
      } else {
        this.chunks[0] = first.subarray(excess)
        this.size -= excess
      }
    }
  }
  text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}
/** Calls `onLine` with each complete line of the text written to it, and the last one without a newline on `end`. */
class LineSplitter {
  private decoder = new StringDecoder('utf8')
  private pending = ''
  constructor(private readonly onLine: (line: string) => void) {}
  push(data: Buffer) {
    const lines = (this.pending + this.decoder.write(data)).split('\n')
    this.pending = lines.pop() ?? ''
    for (const line of lines) this.emit(line)
  }
  end() {
    const last = this.pending + this.decoder.end()
    this.pending = ''
    if (last) this.emit(last)
  }
  private emit(line: string) {
    try {
      this.onLine(line.endsWith('\r') ? line.slice(0, -1) : line)
    } catch {
      // A listener's failure does not stop reading the program's output.
    }
  }
}
/**
 * How long Docker may take to create, start, stop or remove a container. It answers only once the work is done, which
 * on a busy server (several environments updating at once, a large container layer to delete) takes far longer than a
 * query. Giving up sooner leaves the work half done: an update could remove an environment's container and never
 * start its new one.
 */
export const CONTAINER_CHANGE_TIMEOUT_MS = 120_000
/** The seconds Docker waits for a container it stops or restarts before killing it. */
const STOP_GRACE_SECONDS = 10
export class DockerEngineDriver implements DockerDriver {
  private api: string | null = null
  constructor(
    readonly socketPath: string,
    readonly timeoutMs = 10000
  ) {}
  /** One call to the Engine API: its status and raw body, which may hold at most `maxBytes`. */
  private send(
    method: string,
    route: string,
    body: unknown,
    timeoutMs: number,
    maxBytes = Infinity
  ): Promise<{ status: number; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const req = http.request(
        {
          socketPath: this.socketPath,
          method,
          path: route,
          timeout: timeoutMs,
          headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
        },
        (res) => {
          const chunks: Buffer[] = []
          let size = 0
          res.on('data', (chunk) => {
            size += chunk.length
            if (size <= maxBytes) chunks.push(Buffer.from(chunk))
            else {
              res.destroy()
              reject(new GatewayError('DOCKER_UNAVAILABLE', 'Docker answer too large'))
            }
          })
          // A socket that closes or times out once the answer started fails the answer, not the request.
          res.on('error', () => reject(new GatewayError('DOCKER_UNAVAILABLE', 'Docker unavailable')))
          res.on('end', () => resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks) }))
        }
      )
      req.on('timeout', () => req.destroy(new GatewayError('DOCKER_UNAVAILABLE', 'Docker timed out')))
      req.on('error', (error) =>
        reject(error instanceof GatewayError ? error : new GatewayError('DOCKER_UNAVAILABLE', 'Docker unavailable'))
      )
      req.end(payload)
    })
  }
  /** Sends raw bytes (an archive) to the Engine API; fails on an error status. */
  private upload(route: string, data: Buffer, contentType: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.socketPath,
          method: 'PUT',
          path: route,
          timeout: timeoutMs,
          headers: { 'content-type': contentType, 'content-length': data.length },
        },
        (res) => {
          res.resume()
          res.on('error', () => reject(new GatewayError('DOCKER_UNAVAILABLE', 'Docker unavailable')))
          res.on('end', () => {
            const status = res.statusCode ?? 500
            if (status >= 400) reject(new DockerError(status, 'Docker could not write the files'))
            else resolve()
          })
        }
      )
      req.on('timeout', () => req.destroy(new GatewayError('DOCKER_UNAVAILABLE', 'Docker timed out')))
      req.on('error', (error) =>
        reject(error instanceof GatewayError ? error : new GatewayError('DOCKER_UNAVAILABLE', 'Docker unavailable'))
      )
      req.end(data)
    })
  }
  /**
   * A call to the Engine API whose answer is read as it streams (a container's logs), passing each chunk to `onData`.
   * It settles once the answer ends, Docker fails, or `signal` aborts it; it never times out on its own.
   */
  private stream(route: string, onData: (chunk: Buffer) => void, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return resolve()
      const req = http.request({ socketPath: this.socketPath, method: 'GET', path: route }, (res) => {
        const status = res.statusCode ?? 500
        if (status >= 400) {
          res.resume()
          return reject(new DockerError(status, 'Docker could not read the output'))
        }
        res.on('data', (chunk) => onData(Buffer.from(chunk)))
        res.on('error', () => resolve())
        res.on('close', () => resolve())
        res.on('end', () => resolve())
      })
      const abort = () => {
        req.destroy()
        resolve()
      }
      signal.addEventListener('abort', abort, { once: true })
      req.on('close', () => signal.removeEventListener('abort', abort))
      req.on('error', (error) => {
        if (signal.aborted) return resolve()
        reject(error instanceof GatewayError ? error : new GatewayError('DOCKER_UNAVAILABLE', 'Docker unavailable'))
      })
      req.end()
    })
  }
  private async request(method: string, route: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<any> {
    const { status, body: raw } = await this.send(method, route, body, timeoutMs)
    let parsed: any
    try {
      parsed = raw.length ? JSON.parse(raw.toString()) : null
    } catch {
      parsed = null
    }
    if (status >= 400) throw new DockerError(status, String(parsed?.message ?? 'Docker request failed'))
    return parsed
  }
  /** Runs a short command in a running container, as its user, and returns what it wrote to its standard output. */
  private async execOutput(id: string, command: string[], timeoutMs = 5000): Promise<string> {
    const created = await this.request(
      'POST',
      await this.route('/containers/' + encodeURIComponent(id) + '/exec'),
      { AttachStdin: false, AttachStdout: true, AttachStderr: false, Tty: false, Cmd: command },
      timeoutMs
    )
    const { status, body } = await this.send(
      'POST',
      await this.route('/exec/' + encodeURIComponent(String(created?.Id ?? '')) + '/start'),
      { Detach: false, Tty: false },
      timeoutMs,
      64 * 1024
    )
    if (status >= 400) throw new DockerError(status, 'Docker could not run the command')
    return execStdout(body).toString('utf8')
  }
  async version(): Promise<string> {
    const result = await this.request('GET', '/version')
    const value = String(result.ApiVersion ?? '')
    const [major, minor] = value.split('.').map(Number)
    if (major < 1 || (major === 1 && minor < 41) || !major || !Number.isFinite(minor))
      throw new GatewayError('DOCKER_UNAVAILABLE', 'Docker API 1.41 or newer is required')
    this.api = '/v' + value
    return String(result.Version ?? value)
  }
  private async route(path: string): Promise<string> {
    if (!this.api) await this.version()
    return this.api + path
  }
  async ensureNetwork(name: string, labels: Record<string, string> = {}): Promise<void> {
    const networks = await this.request(
      'GET',
      await this.route('/networks?filters=' + encodeURIComponent(JSON.stringify({ name: [name] })))
    )
    if (!networks.some((network: any) => network.Name === name))
      await this.request('POST', await this.route('/networks/create'), {
        Name: name,
        Driver: 'bridge',
        ...(Object.keys(labels).length ? { Labels: labels } : {}),
      })
  }
  async networkInspect(name: string): Promise<FleetNetworkSubnet[]> {
    const result = await this.request('GET', await this.route('/networks/' + encodeURIComponent(name)))
    const entries: { Subnet?: string; Gateway?: string }[] = result.IPAM?.Config ?? []
    return entries.flatMap((entry) =>
      entry.Subnet ? [{ subnet: entry.Subnet, gateway: entry.Gateway ? entry.Gateway : null }] : []
    )
  }
  async networkMembers(name: string): Promise<NetworkMember[]> {
    let result: any
    try {
      result = await this.request('GET', await this.route('/networks/' + encodeURIComponent(name)))
    } catch (error) {
      if (error instanceof DockerError && error.status === 404) return []
      throw error
    }
    const containers: Record<string, { Name?: string; IPv4Address?: string; IPv6Address?: string }> =
      result.Containers ?? {}
    return Object.entries(containers).map(([id, entry]) => ({
      id,
      name: String(entry.Name ?? ''),
      addresses: [entry.IPv4Address, entry.IPv6Address].flatMap((value) =>
        value ? [String(value).split('/')[0]] : []
      ),
    }))
  }
  async networkConnect(name: string, container: string, aliases: string[]): Promise<void> {
    const members = await this.networkMembers(name)
    if (
      members.some((member) => member.id === container || member.id.startsWith(container) || member.name === container)
    )
      return
    await this.request('POST', await this.route('/networks/' + encodeURIComponent(name) + '/connect'), {
      Container: container,
      EndpointConfig: aliases.length ? { Aliases: aliases } : {},
    })
  }
  async networkDisconnect(name: string, container: string): Promise<void> {
    try {
      await this.request('POST', await this.route('/networks/' + encodeURIComponent(name) + '/disconnect'), {
        Container: container,
        Force: true,
      })
    } catch (error) {
      // 404: no such network or container; 403 and 409 (by version): not attached to it.
      if (error instanceof DockerError && [403, 404, 409].includes(error.status)) return
      throw error
    }
  }
  async networkRemove(name: string): Promise<void> {
    try {
      await this.request('DELETE', await this.route('/networks/' + encodeURIComponent(name)))
    } catch (error) {
      if (error instanceof DockerError && error.status === 404) return
      throw error
    }
  }
  async runOnce(spec: OneShotSpec): Promise<number> {
    const created = await this.request('POST', await this.route('/containers/create'), {
      Image: spec.image,
      User: spec.user,
      Entrypoint: spec.command.slice(0, 1),
      Cmd: spec.command.slice(1),
      Labels: spec.labels,
      NetworkDisabled: true,
      HostConfig: {
        NetworkMode: 'none',
        Init: false,
        AutoRemove: false,
        Mounts: spec.binds.map((bind) => ({ Type: 'bind', Source: bind.source, Target: bind.target })),
        SecurityOpt: spec.securityOpt,
        CapDrop: ['ALL'],
        ...(spec.capAdd.length ? { CapAdd: spec.capAdd } : {}),
      },
    })
    const id = String(created.Id)
    try {
      await this.request('POST', await this.route('/containers/' + encodeURIComponent(id) + '/start'))
      const result = await this.request(
        'POST',
        await this.route('/containers/' + encodeURIComponent(id) + '/wait?condition=not-running'),
        undefined,
        60000
      )
      return Number(result?.StatusCode ?? 1)
    } finally {
      await this.request('DELETE', await this.route('/containers/' + encodeURIComponent(id) + '?force=true')).catch(
        () => undefined
      )
    }
  }
  async runHelper(spec: HelperSpec): Promise<HelperResult> {
    let created: any
    try {
      created = await this.request(
        'POST',
        await this.route('/containers/create'),
        {
          Image: spec.image,
          User: spec.user,
          Entrypoint: spec.command.slice(0, 1),
          Cmd: spec.command.slice(1),
          Env: spec.env,
          Labels: spec.labels,
          ...(spec.network === 'none' ? { NetworkDisabled: true } : {}),
          HostConfig: {
            NetworkMode: spec.network,
            Init: true,
            AutoRemove: false,
            Mounts: spec.mounts.map((mount) => ({
              Type: mount.type,
              Source: mount.source,
              Target: mount.target,
              ReadOnly: mount.readOnly,
            })),
            SecurityOpt: spec.securityOpt,
            CapDrop: ['ALL'],
            ...(spec.capAdd.length ? { CapAdd: spec.capAdd } : {}),
          },
        },
        CONTAINER_CHANGE_TIMEOUT_MS
      )
    } catch (error) {
      if (error instanceof DockerError && error.status === 404)
        throw new GatewayError('IMAGE_MISSING', 'Bot image missing')
      throw error
    }
    const id = String(created.Id)
    const container = '/containers/' + encodeURIComponent(id)
    const stdout = new TailBuffer(spec.stdoutLimitBytes ?? HELPER_STDOUT_LIMIT)
    const stderr = new TailBuffer(HELPER_STDERR_LIMIT)
    const lines = spec.onStdoutLine ? new LineSplitter(spec.onStdoutLine) : null
    const reading = new AbortController()
    let ending: HelperResult['ending'] = 'exited'
    let timer: NodeJS.Timeout | undefined
    const kill = () => {
      reading.abort()
      void this.route(container + '/kill').then(
        (route) => this.request('POST', route).catch(() => undefined),
        () => undefined
      )
    }
    const cancel = () => {
      if (ending !== 'exited') return
      ending = 'cancelled'
      kill()
    }
    try {
      if (spec.files.length)
        await this.upload(
          await this.route(container + '/archive?path=' + encodeURIComponent('/')),
          tarFiles(spec.files),
          'application/x-tar',
          CONTAINER_CHANGE_TIMEOUT_MS
        )
      await this.request('POST', await this.route(container + '/start'), undefined, CONTAINER_CHANGE_TIMEOUT_MS)
      timer = setTimeout(() => {
        if (ending !== 'exited') return
        ending = 'timeout'
        kill()
      }, spec.timeoutMs)
      if (spec.signal?.aborted) cancel()
      else spec.signal?.addEventListener('abort', cancel, { once: true })
      const demuxer = new DockerStreamDemuxer()
      await this.stream(
        await this.route(container + '/logs?follow=1&stdout=1&stderr=1'),
        (chunk) => {
          for (const part of demuxer.push(chunk)) {
            if (part.stream === 'stderr') stderr.push(part.data)
            else {
              stdout.push(part.data)
              lines?.push(part.data)
            }
          }
        },
        reading.signal
      )
      lines?.end()
      const result = await this.request(
        'POST',
        await this.route(container + '/wait?condition=not-running'),
        undefined,
        HELPER_WAIT_MS
      ).catch(() => null)
      return {
        exitCode: Number(result?.StatusCode ?? (ending === 'exited' ? 1 : 137)),
        stdout: stdout.text(),
        stderr: stderr.text(),
        ending,
      }
    } finally {
      clearTimeout(timer)
      spec.signal?.removeEventListener('abort', cancel)
      await this.request(
        'DELETE',
        await this.route(container + '?force=true'),
        undefined,
        CONTAINER_CHANGE_TIMEOUT_MS
      ).catch(() => undefined)
    }
  }
  async imageInspect(ref: string): Promise<ImageInfo | null> {
    try {
      const result = await this.request('GET', await this.route('/images/' + encodeURIComponent(ref) + '/json'))
      const version = result.Config?.Labels?.['org.opencontainers.image.version']
      return { id: String(result.Id), version: typeof version === 'string' ? version.trim() || null : null }
    } catch (error) {
      if (error instanceof DockerError && error.status === 404) return null
      throw error
    }
  }
  async volumeCreate(name: string, labels: Record<string, string>) {
    await this.request('POST', await this.route('/volumes/create'), { Name: name, Labels: labels })
  }
  async volumeExists(name: string): Promise<boolean> {
    try {
      await this.request('GET', await this.route('/volumes/' + encodeURIComponent(name)))
      return true
    } catch (error) {
      if (error instanceof DockerError && error.status === 404) return false
      throw error
    }
  }
  async volumeRemove(name: string) {
    try {
      await this.request('DELETE', await this.route('/volumes/' + encodeURIComponent(name)))
    } catch (error) {
      if (error instanceof DockerError && error.status === 404) return
      throw error
    }
  }
  async containerCreate(spec: ContainerSpec): Promise<string> {
    const response = await this.request(
      'POST',
      await this.route('/containers/create?name=' + encodeURIComponent(spec.name)),
      {
        Image: spec.image,
        User: spec.user,
        Hostname: spec.hostname,
        Labels: spec.labels,
        Env: spec.env,
        HostConfig: {
          Memory: spec.memory,
          ...(spec.nanoCpus ? { NanoCpus: spec.nanoCpus } : {}),
          ShmSize: spec.shmSize,
          Init: true,
          RestartPolicy: { Name: 'unless-stopped' },
          NetworkMode: spec.network,
          Mounts: [
            { Type: 'volume', Source: spec.volume, Target: '/home/bot' },
            ...(spec.binds ?? []).map((bind) => ({ Type: 'bind', Source: bind.source, Target: bind.target })),
          ],
          SecurityOpt: spec.securityOpt,
          ...(spec.capAdd.length ? { CapAdd: spec.capAdd } : {}),
        },
      },
      CONTAINER_CHANGE_TIMEOUT_MS
    )
    return String(response.Id)
  }
  async start(id: string) {
    await this.request(
      'POST',
      await this.route('/containers/' + encodeURIComponent(id) + '/start'),
      undefined,
      CONTAINER_CHANGE_TIMEOUT_MS
    )
  }
  async stop(id: string, timeoutSec = STOP_GRACE_SECONDS) {
    try {
      await this.request(
        'POST',
        await this.route('/containers/' + encodeURIComponent(id) + '/stop?t=' + timeoutSec),
        undefined,
        timeoutSec * 1000 + CONTAINER_CHANGE_TIMEOUT_MS
      )
    } catch (error) {
      if (!(error instanceof DockerError && error.status === 304)) throw error
    }
  }
  async restart(id: string) {
    await this.request(
      'POST',
      await this.route('/containers/' + encodeURIComponent(id) + '/restart'),
      undefined,
      STOP_GRACE_SECONDS * 1000 + CONTAINER_CHANGE_TIMEOUT_MS
    )
  }
  async remove(id: string, force = false) {
    await this.request(
      'DELETE',
      await this.route('/containers/' + encodeURIComponent(id) + '?force=' + force),
      undefined,
      CONTAINER_CHANGE_TIMEOUT_MS
    )
  }
  async updateMemory(id: string, bytes: number) {
    // Docker refuses a memory limit above the swap limit already set, so both change together.
    await this.request('POST', await this.route('/containers/' + encodeURIComponent(id) + '/update'), {
      Memory: bytes,
      MemorySwap: bytes * 2,
    })
  }
  async updateCpus(id: string, nanoCpus: number) {
    await this.request('POST', await this.route('/containers/' + encodeURIComponent(id) + '/update'), {
      NanoCpus: nanoCpus,
    })
  }
  async inspect(id: string): Promise<ContainerInfo> {
    const raw = await this.request('GET', await this.route('/containers/' + encodeURIComponent(id) + '/json'))
    return {
      id: String(raw.Id),
      imageId: String(raw.Image),
      name: String(raw.Name).replace(/^\//, ''),
      state: raw.State?.Running ? 'running' : raw.State?.Status === 'created' ? 'created' : 'exited',
      startedAt:
        raw.State?.StartedAt && !String(raw.State.StartedAt).startsWith('0001')
          ? new Date(raw.State.StartedAt).toISOString()
          : null,
      labels: raw.Config?.Labels ?? {},
    }
  }
  async list(label?: string): Promise<ContainerInfo[]> {
    const query = label ? '?all=1&filters=' + encodeURIComponent(JSON.stringify({ label: [label] })) : '?all=1'
    const raw = await this.request('GET', await this.route('/containers/json' + query))
    return raw.map((item: any) => ({
      id: String(item.Id),
      imageId: String(item.ImageID),
      name: String(item.Names?.[0] ?? '').replace(/^\//, ''),
      state: item.State === 'running' ? 'running' : item.State === 'created' ? 'created' : 'exited',
      startedAt: null,
      labels: item.Labels ?? {},
    }))
  }
  async statsOnce(id: string): Promise<ContainerStats> {
    return parseDockerStats(
      await this.request('GET', await this.route('/containers/' + encodeURIComponent(id) + '/stats?stream=false'))
    )
  }
  async cgroupMemory(id: string): Promise<CgroupMemory> {
    return parseCgroupMemory(
      await this.execOutput(id, ['cat', '/sys/fs/cgroup/memory.swap.current', '/sys/fs/cgroup/memory.events'])
    )
  }
}
export class FakeDockerDriver implements DockerDriver {
  readonly images = new Set<string>()
  readonly imageIds = new Map<string, string>()
  readonly containers = new Map<string, ContainerInfo & { spec: ContainerSpec }>()
  readonly volumes = new Set<string>()
  readonly networks = new Set<string>()
  /** Labels each network was created with, and the containers (names or ids, as attached) on each one. */
  readonly networkLabels = new Map<string, Record<string, string>>()
  readonly networkAttachments = new Map<string, Set<string>>()
  /** The subnet each network reports; the fleet network gets the default. */
  readonly subnets = new Map<string, FleetNetworkSubnet[]>()
  readonly memoryUpdates: Array<{ id: string; memory: number }> = []
  readonly cpuUpdates: Array<{ id: string; nanoCpus: number }> = []
  readonly oneShots: OneShotSpec[] = []
  /** The exit code of the next one-shot containers; 0 by default. */
  oneShotExitCode = 0
  readonly helperRuns: HelperSpec[] = []
  /** What each helper does; its stdout is passed line by line to the spec's listener. */
  helperHandler: (spec: HelperSpec) => Promise<{ exitCode: number; stdout?: string; stderr?: string }> = async () => ({
    exitCode: 0,
  })
  /** Volumes a running helper mounts, as many times as helpers mount each. */
  private readonly helperVolumes = new Map<string, number>()
  memoryUpdateFailure: DockerError | null = null
  cpuUpdateFailure: DockerError | null = null
  /** Refuses to create networks, as a server with no address pool left does. */
  networkCreateFailure: DockerError | null = null
  startLatencyMs = 0
  stats: ContainerStats = { memoryBytes: 0, memoryLimitBytes: 0, cpuPercent: 0 }
  cgroup: CgroupMemory = NO_CGROUP_MEMORY
  /** Fails reading cgroups, as a container without `cat` or a paused one does. */
  cgroupFailure: DockerError | null = null
  async version() {
    return '28.0.0'
  }
  async networkInspect(name: string): Promise<FleetNetworkSubnet[]> {
    return this.subnets.get(name) ?? [{ subnet: '172.30.0.0/16', gateway: '172.30.0.1' }]
  }
  async ensureNetwork(name: string, labels: Record<string, string> = {}) {
    if (this.networks.has(name)) return
    if (this.networkCreateFailure) throw this.networkCreateFailure
    this.networks.add(name)
    this.networkLabels.set(name, labels)
  }
  async networkMembers(name: string): Promise<NetworkMember[]> {
    if (!this.networks.has(name)) return []
    const attached = [...(this.networkAttachments.get(name) ?? [])].map((id) => ({ id, name: id, addresses: [] }))
    const containers = [...this.containers.values()]
      .filter((item) => item.spec.network === name)
      .map((item) => ({ id: item.id, name: item.name, addresses: [] }))
    return [...containers, ...attached]
  }
  async networkConnect(name: string, container: string) {
    if (!this.networks.has(name)) throw new DockerError(404, 'Network not found')
    const attached = this.networkAttachments.get(name) ?? new Set<string>()
    attached.add(container)
    this.networkAttachments.set(name, attached)
  }
  async networkDisconnect(name: string, container: string) {
    this.networkAttachments.get(name)?.delete(container)
  }
  async networkRemove(name: string) {
    if ([...this.containers.values()].some((item) => item.spec.network === name))
      throw new DockerError(409, 'Network has active endpoints')
    if (this.networkAttachments.get(name)?.size) throw new DockerError(409, 'Network has active endpoints')
    this.networks.delete(name)
    this.networkLabels.delete(name)
    this.networkAttachments.delete(name)
  }
  async runOnce(spec: OneShotSpec): Promise<number> {
    const image = await this.imageInspect(spec.image)
    if (!image) throw new DockerError(404, 'Image not found')
    this.oneShots.push(spec)
    return this.oneShotExitCode
  }
  async runHelper(spec: HelperSpec): Promise<HelperResult> {
    if (!(await this.imageInspect(spec.image))) throw new GatewayError('IMAGE_MISSING', 'Bot image missing')
    this.helperRuns.push(spec)
    const cancelled: HelperResult = { exitCode: 137, stdout: '', stderr: '', ending: 'cancelled' }
    if (spec.signal?.aborted) return cancelled
    const volumes = spec.mounts.filter((mount) => mount.type === 'volume').map((mount) => mount.source)
    for (const volume of volumes) this.helperVolumes.set(volume, (this.helperVolumes.get(volume) ?? 0) + 1)
    let onAbort: (() => void) | undefined
    try {
      const aborted = new Promise<null>((resolve) => {
        onAbort = () => resolve(null)
        spec.signal?.addEventListener('abort', onAbort, { once: true })
      })
      const result = await Promise.race([this.helperHandler(spec), aborted])
      if (!result || spec.signal?.aborted) return cancelled
      const stdout = result.stdout ?? ''
      if (spec.onStdoutLine) {
        const lines = stdout.split('\n')
        if (lines.at(-1) === '') lines.pop()
        for (const line of lines) spec.onStdoutLine(line)
      }
      const limit = spec.stdoutLimitBytes ?? HELPER_STDOUT_LIMIT
      const bytes = Buffer.from(stdout)
      return {
        exitCode: result.exitCode,
        stdout: bytes.length > limit ? bytes.subarray(bytes.length - limit).toString() : stdout,
        stderr: result.stderr ?? '',
        ending: 'exited',
      }
    } finally {
      if (onAbort) spec.signal?.removeEventListener('abort', onAbort)
      for (const volume of volumes) {
        const count = (this.helperVolumes.get(volume) ?? 1) - 1
        if (count > 0) this.helperVolumes.set(volume, count)
        else this.helperVolumes.delete(volume)
      }
    }
  }
  setImage(ref: string, id: string) {
    this.images.add(ref)
    this.imageIds.set(ref, id)
  }
  async imageInspect(ref: string): Promise<ImageInfo | null> {
    return this.images.has(ref)
      ? { id: this.imageIds.get(ref) ?? 'sha256:' + createHash('sha256').update(ref).digest('hex') }
      : null
  }
  async volumeCreate(name: string) {
    this.volumes.add(name)
  }
  async volumeExists(name: string) {
    return this.volumes.has(name)
  }
  async volumeRemove(name: string) {
    if ([...this.containers.values()].some((item) => item.spec.volume === name) || this.helperVolumes.has(name))
      throw new DockerError(409, 'Volume is in use')
    this.volumes.delete(name)
  }
  async containerCreate(spec: ContainerSpec) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(spec.name)) throw new DockerError(400, 'Invalid container name')
    if ([...this.containers.values()].some((item) => item.name === spec.name))
      throw new DockerError(409, 'Container name already in use')
    const image = await this.imageInspect(spec.image)
    if (!image) throw new DockerError(404, 'Image not found')
    const id = 'fake-' + spec.name
    this.containers.set(id, {
      id,
      imageId: image.id,
      name: spec.name,
      state: 'created',
      startedAt: null,
      labels: spec.labels,
      spec,
    })
    return id
  }
  async start(id: string) {
    const item = await this.lookup(id)
    if (item.state === 'running') throw new DockerError(304, 'Container already started')
    if (this.startLatencyMs) await new Promise((r) => setTimeout(r, this.startLatencyMs))
    item.state = 'running'
    item.startedAt = new Date().toISOString()
  }
  async stop(id: string) {
    const item = await this.lookup(id)
    item.state = 'exited'
  }
  async restart(id: string) {
    await this.stop(id)
    await this.start(id)
  }
  async remove(id: string, force = false) {
    const item = await this.lookup(id)
    if (item.state === 'running' && !force) throw new DockerError(409, 'Container is running')
    this.containers.delete(item.id)
  }
  async updateMemory(id: string, bytes: number) {
    const item = await this.lookup(id)
    if (this.memoryUpdateFailure) throw this.memoryUpdateFailure
    item.spec = { ...item.spec, memory: bytes }
    this.memoryUpdates.push({ id: item.id, memory: bytes })
  }
  async updateCpus(id: string, nanoCpus: number) {
    const item = await this.lookup(id)
    if (this.cpuUpdateFailure) throw this.cpuUpdateFailure
    item.spec = { ...item.spec, nanoCpus: nanoCpus || undefined }
    this.cpuUpdates.push({ id: item.id, nanoCpus })
  }
  async inspect(id: string) {
    const { spec, ...item } = await this.lookup(id)
    return item
  }
  async list(label?: string) {
    return [...this.containers.values()]
      .filter((item) => !label || item.labels[label.split('=')[0]] === label.split('=')[1])
      .map(({ spec, ...item }) => item)
  }
  async statsOnce(id: string) {
    await this.lookup(id)
    return this.stats
  }
  async cgroupMemory(id: string) {
    await this.lookup(id)
    if (this.cgroupFailure) throw this.cgroupFailure
    return this.cgroup
  }
  private async lookup(id: string) {
    const item = this.containers.get(id) ?? [...this.containers.values()].find((item) => item.name === id)
    if (!item) throw new DockerError(404, 'Container not found')
    return item
  }
}
