import http from 'node:http'
import { GatewayError } from './errors.js'

export type ContainerSpec = {
  name: string
  image: string
  hostname: string
  labels: Record<string, string>
  env: string[]
  network: string
  volume: string
  memory: number
  shmSize: number
  securityOpt: string[]
}
export type ContainerInfo = {
  id: string
  name: string
  state: 'running' | 'exited' | 'created'
  startedAt: string | null
  labels: Record<string, string>
}
export type ContainerStats = { memoryBytes: number; memoryLimitBytes: number; cpuPercent: number }
export interface DockerDriver {
  version(): Promise<string>
  ensureNetwork(name: string): Promise<void>
  imageInspect(ref: string): Promise<{ id: string } | null>
  volumeCreate(name: string, labels: Record<string, string>): Promise<void>
  containerCreate(spec: ContainerSpec): Promise<string>
  start(id: string): Promise<void>
  stop(id: string, timeoutSec?: number): Promise<void>
  restart(id: string): Promise<void>
  remove(id: string, force?: boolean): Promise<void>
  inspect(id: string): Promise<ContainerInfo>
  list(label?: string): Promise<ContainerInfo[]>
  statsOnce(id: string): Promise<ContainerStats>
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
export class DockerEngineDriver implements DockerDriver {
  private api: string | null = null
  constructor(
    readonly socketPath: string,
    readonly timeoutMs = 10000
  ) {}
  private request(method: string, route: string, body?: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const req = http.request(
        {
          socketPath: this.socketPath,
          method,
          path: route,
          timeout: this.timeoutMs,
          headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString()
            let parsed: any
            try {
              parsed = raw ? JSON.parse(raw) : null
            } catch {
              parsed = null
            }
            if ((res.statusCode ?? 500) >= 400)
              reject(new DockerError(res.statusCode ?? 500, String(parsed?.message ?? 'Docker request failed')))
            else resolve(parsed)
          })
        }
      )
      req.on('timeout', () => req.destroy(new GatewayError('DOCKER_UNAVAILABLE', 'Docker timed out')))
      req.on('error', (error) =>
        reject(error instanceof GatewayError ? error : new GatewayError('DOCKER_UNAVAILABLE', 'Docker unavailable'))
      )
      req.end(payload)
    })
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
  async ensureNetwork(name: string): Promise<void> {
    const networks = await this.request(
      'GET',
      await this.route('/networks?filters=' + encodeURIComponent(JSON.stringify({ name: [name] })))
    )
    if (!networks.some((network: any) => network.Name === name))
      await this.request('POST', await this.route('/networks/create'), { Name: name, Driver: 'bridge' })
  }
  async imageInspect(ref: string): Promise<{ id: string } | null> {
    try {
      const result = await this.request('GET', await this.route('/images/' + encodeURIComponent(ref) + '/json'))
      return { id: String(result.Id) }
    } catch (error) {
      if (error instanceof DockerError && error.status === 404) return null
      throw error
    }
  }
  async volumeCreate(name: string, labels: Record<string, string>) {
    await this.request('POST', await this.route('/volumes/create'), { Name: name, Labels: labels })
  }
  async containerCreate(spec: ContainerSpec): Promise<string> {
    const response = await this.request(
      'POST',
      await this.route('/containers/create?name=' + encodeURIComponent(spec.name)),
      {
        Image: spec.image,
        Hostname: spec.hostname,
        Labels: spec.labels,
        Env: spec.env,
        HostConfig: {
          Memory: spec.memory,
          ShmSize: spec.shmSize,
          Init: true,
          RestartPolicy: { Name: 'unless-stopped' },
          NetworkMode: spec.network,
          Mounts: [{ Type: 'volume', Source: spec.volume, Target: '/home/bot' }],
          SecurityOpt: spec.securityOpt,
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
  async inspect(id: string): Promise<ContainerInfo> {
    const raw = await this.request('GET', await this.route('/containers/' + encodeURIComponent(id) + '/json'))
    return {
      id: String(raw.Id),
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
}
export class FakeDockerDriver implements DockerDriver {
  readonly images = new Set<string>()
  readonly containers = new Map<string, ContainerInfo & { spec: ContainerSpec }>()
  readonly volumes = new Set<string>()
  readonly networks = new Set<string>()
  startLatencyMs = 0
  stats: ContainerStats = { memoryBytes: 0, memoryLimitBytes: 0, cpuPercent: 0 }
  async version() {
    return '28.0.0'
  }
  async ensureNetwork(name: string) {
    this.networks.add(name)
  }
  async imageInspect(ref: string) {
    return this.images.has(ref) ? { id: ref } : null
  }
  async volumeCreate(name: string) {
    this.volumes.add(name)
  }
  async containerCreate(spec: ContainerSpec) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(spec.name)) throw new DockerError(400, 'Invalid container name')
    if ([...this.containers.values()].some((item) => item.name === spec.name))
      throw new DockerError(409, 'Container name already in use')
    const id = 'fake-' + spec.name
    this.containers.set(id, { id, name: spec.name, state: 'created', startedAt: null, labels: spec.labels, spec })
    return id
  }
  async start(id: string) {
    const item = await this.lookup(id)
    if (!this.images.has(item.spec.image)) throw new DockerError(404, 'Image not found')
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
  async remove(id: string) {
    await this.lookup(id)
    this.containers.delete(id)
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
  private async lookup(id: string) {
    const item = this.containers.get(id) ?? [...this.containers.values()].find((item) => item.name === id)
    if (!item) throw new DockerError(404, 'Container not found')
    return item
  }
}
