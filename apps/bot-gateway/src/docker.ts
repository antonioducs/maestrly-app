import http from 'node:http'
import { createHash } from 'node:crypto'
import { GatewayError } from './errors.js'

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
/** The standard output of a command run without a terminal, which Docker frames as [stream, 0, 0, 0, size (4 bytes)]. */
export function execStdout(raw: Buffer): Buffer {
  const parts: Buffer[] = []
  let offset = 0
  while (offset + 8 <= raw.length) {
    const end = offset + 8 + raw.readUInt32BE(offset + 4)
    if (raw[offset] === 1) parts.push(raw.subarray(offset + 8, Math.min(end, raw.length)))
    offset = end
  }
  return Buffer.concat(parts)
}
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
      }
    )
    return String(response.Id)
  }
  async start(id: string) {
    await this.request('POST', await this.route('/containers/' + encodeURIComponent(id) + '/start'))
  }
  async stop(id: string, timeoutSec = 10) {
    try {
      await this.request('POST', await this.route('/containers/' + encodeURIComponent(id) + '/stop?t=' + timeoutSec))
    } catch (error) {
      if (!(error instanceof DockerError && error.status === 304)) throw error
    }
  }
  async restart(id: string) {
    await this.request('POST', await this.route('/containers/' + encodeURIComponent(id) + '/restart'))
  }
  async remove(id: string, force = false) {
    await this.request('DELETE', await this.route('/containers/' + encodeURIComponent(id) + '?force=' + force))
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
    if ([...this.containers.values()].some((item) => item.spec.volume === name))
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
