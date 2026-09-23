import {
  deriveBotId,
  FLEET_BOT_ENV,
  type FleetActivityEntry,
  type FleetBot,
  type FleetCreateBotRequest,
  type FleetGatewayEvent,
  type FleetInstanceStatus,
  type FleetPatchBotRequest,
} from '@maestrly/bot-fleet-protocol'
import { token, sha256 } from './auth.js'
import type { GatewayConfig } from './config.js'
import { type ContainerInfo, DockerError, type DockerDriver, type ContainerStats } from './docker.js'
import { GatewayError } from './errors.js'
import { InstanceClient } from './instance.js'
import type { Store } from './store.js'

const tints = ['#4978c6', '#9b65b6', '#d47754', '#4c9a87', '#c29a43', '#6379a5']
const managed = 'org.maestrly.fleet.managed'
const botLabel = 'org.maestrly.fleet.bot-id'
const now = () => new Date().toISOString()
export type InstanceFactory = (botId: string, token: string) => InstanceClient
export class Lifecycle {
  readonly statuses = new Map<string, FleetInstanceStatus>()
  readonly resources = new Map<string, ContainerStats & { startedAt: string | null }>()
  onEvent: (event: FleetGatewayEvent) => void = () => {}
  constructor(
    readonly store: Store,
    readonly docker: DockerDriver,
    readonly config: GatewayConfig,
    readonly instance: InstanceFactory = (id, secret) => new InstanceClient(id, secret),
    readonly healthTimeoutMs = 240000
  ) {}
  private emitBot(id: string) {
    const bot = this.get(id)
    if (bot) this.onEvent({ type: 'bot.updated', at: now(), bot })
  }
  private activity(id: string | null, kind: FleetActivityEntry['kind']) {
    const entry = this.store.addActivity(id, kind)
    this.onEvent({ type: 'activity', at: entry.at, entry })
  }
  get(id: string): FleetBot | null {
    const bot = this.store.getBot(id)
    return bot ? this.assemble(bot) : null
  }
  list(): FleetBot[] {
    return this.store.listBots().map((bot) => this.assemble(bot))
  }
  private assemble(bot: FleetBot): FleetBot {
    const status = this.statuses.get(bot.id),
      resources = this.resources.get(bot.id)
    bot.appVersion = status?.appVersion ?? null
    bot.activity = status?.activity ?? null
    bot.pendingCount = status?.pending.length ?? 0
    bot.resources = {
      memoryBytes: resources?.memoryBytes ?? null,
      memoryLimitBytes: resources?.memoryLimitBytes ?? null,
      cpuPercent: resources?.cpuPercent ?? null,
      startedAt: resources?.startedAt ?? null,
    }
    if (bot.lifecycle === 'stopped' || bot.lifecycle === 'archived' || bot.lifecycle === 'failed')
      bot.status = 'offline'
    else if (bot.lifecycle !== 'running' || !status?.ready) bot.status = 'starting'
    else if (bot.paused || status.hold.reason === 'paused') bot.status = 'paused'
    else if (status.hold.reason === 'takeover') bot.status = 'human'
    else if (status.pending.length) bot.status = 'waiting'
    else if (!status.accounts.connected) bot.status = 'setup'
    else if (status.turn.state !== 'idle' || status.queue.length) bot.status = 'working'
    else bot.status = 'idle'
    return bot
  }
  private update(id: string, changes: Partial<FleetBot>) {
    const bot = this.store.getBot(id)
    if (!bot) throw new GatewayError('NOT_FOUND', 'Bot not found')
    const next = { ...bot, ...changes, updatedAt: now() }
    this.store.saveBot(next)
    this.emitBot(id)
    return this.get(id)!
  }
  create(input: FleetCreateBotRequest): FleetBot {
    const ids = this.store.listBots(true).map((bot) => bot.id)
    const id = deriveBotId(input.name, ids),
      at = now()
    const bot: FleetBot = {
      id,
      name: input.name,
      role: '',
      instructions: input.instructions,
      tint: tints[ids.length % tints.length],
      ceiling: input.ceiling,
      selection: null,
      talksTo: input.talksTo,
      paused: false,
      lifecycle: 'creating',
      setup: { step: 'container', error: null, errorMessage: null },
      status: 'starting',
      activity: null,
      pendingCount: 0,
      takeover: { state: 'none', deviceId: null, deviceName: null, since: null },
      resources: { memoryBytes: null, memoryLimitBytes: null, cpuPercent: null, startedAt: null },
      screen: { width: 1280, height: 800, display: ':0' },
      appVersion: null,
      createdAt: at,
      updatedAt: at,
    }
    const controlToken = token(),
      gatewayToken = token()
    this.store.transaction(() => {
      this.validatePeers(id, input.talksTo)
      this.store.insertBot(bot, { controlToken, gatewayToken, gatewayTokenSha256: sha256(gatewayToken) })
      this.syncPeers(id, input.talksTo)
    })
    this.activity(id, 'bot_created')
    queueMicrotask(() => {
      void this.provision(id).catch((error) => this.fail(id, error))
    })
    return this.get(id)!
  }
  private validatePeers(id: string, talksTo: string[]) {
    if (new Set(talksTo).size !== talksTo.length || talksTo.includes(id))
      throw new GatewayError('INVALID_REQUEST', 'Invalid peer list')
    for (const peerId of talksTo) {
      const peer = this.store.getBot(peerId)
      if (!peer || peer.lifecycle === 'archived') throw new GatewayError('NOT_FOUND', 'Peer bot not found')
    }
  }
  private syncPeers(id: string, talksTo: string[]) {
    for (const peer of this.store.listBots()) {
      if (peer.id === id) continue
      const shouldLink = talksTo.includes(peer.id)
      if (peer.talksTo.includes(id) === shouldLink) continue
      peer.talksTo = shouldLink ? [...peer.talksTo, id] : peer.talksTo.filter((value) => value !== id)
      peer.updatedAt = now()
      this.store.saveBot(peer)
    }
  }
  private client(id: string): InstanceClient {
    const secret = this.store.botSecrets(id)
    if (!secret) throw new GatewayError('INTERNAL', 'Bot secrets missing')
    return this.instance(id, secret.controlToken)
  }
  private async container(id: string): Promise<ContainerInfo | null> {
    try {
      return await this.docker.inspect('maestrly-bot-' + id)
    } catch (error) {
      if (error instanceof DockerError && error.status === 404) return null
      throw error
    }
  }
  private async provision(id: string) {
    const bot = this.store.getBot(id)!,
      secrets = this.store.botSecrets(id)!
    if (!(await this.docker.imageInspect(this.config.botImage)))
      throw new GatewayError('IMAGE_MISSING', 'Bot image missing')
    await this.docker.ensureNetwork(this.config.network)
    const name = 'maestrly-bot-' + id,
      volume = name + '-home'
    await this.docker.volumeCreate(volume, { [managed]: 'true', [botLabel]: id })
    const env = {
      [FLEET_BOT_ENV.mode]: '1',
      [FLEET_BOT_ENV.id]: id,
      [FLEET_BOT_ENV.name]: bot.name,
      [FLEET_BOT_ENV.controlHost]: '0.0.0.0',
      [FLEET_BOT_ENV.controlPort]: '7680',
      [FLEET_BOT_ENV.controlToken]: secrets.controlToken,
      [FLEET_BOT_ENV.gatewayUrl]: this.config.internalUrl,
      [FLEET_BOT_ENV.gatewayToken]: secrets.gatewayToken,
      TZ: this.config.timezone,
    }
    const container = await this.docker.containerCreate({
      name,
      image: this.config.botImage,
      hostname: id,
      labels: { [managed]: 'true', [botLabel]: id },
      env: Object.entries(env).map(([key, value]) => key + '=' + value),
      network: this.config.network,
      volume,
      memory: this.config.botMemory,
      shmSize: this.config.botShm,
      securityOpt: this.config.botSecurityOpt,
    })
    await this.docker.start(container)
    await this.ready(id)
  }
  private async ready(id: string) {
    this.update(id, { lifecycle: 'starting', setup: { step: 'desktop', error: null, errorMessage: null } })
    const client = this.client(id),
      deadline = Date.now() + this.healthTimeoutMs
    while (Date.now() < deadline) {
      try {
        const health = await client.health()
        if (health.ready) break
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(1, deadline - Date.now()))))
    }
    if (Date.now() >= deadline) throw new GatewayError('INSTANCE_UNAVAILABLE', 'Bot desktop did not become ready')
    this.update(id, { setup: { step: 'profile', error: null, errorMessage: null } })
    const bot = this.store.getBot(id)!
    const status = await client.putProfile({
      botId: id,
      name: bot.name,
      instructions: bot.instructions,
      ceiling: bot.ceiling,
      selection: bot.selection,
      gateway: { peersEnabled: bot.talksTo.length > 0 },
    })
    this.statuses.set(id, status)
    if (bot.paused) await client.hold({ reason: 'paused' })
    this.update(id, { lifecycle: 'running', setup: { step: 'ready', error: null, errorMessage: null } })
    this.activity(id, 'bot_started')
  }
  private fail(id: string, error: unknown) {
    const code =
      error instanceof GatewayError
        ? error.code
        : error instanceof DockerError && error.status === 404
          ? 'IMAGE_MISSING'
          : 'DOCKER_UNAVAILABLE'
    this.update(id, {
      lifecycle: 'failed',
      setup: {
        step: 'failed',
        error: code,
        errorMessage: code === 'IMAGE_MISSING' ? 'Bot image missing' : 'Bot startup failed',
      },
    })
    this.activity(id, 'bot_failed')
  }
  async start(id: string): Promise<FleetBot> {
    const bot = this.get(id)
    if (!bot || bot.lifecycle === 'archived') throw new GatewayError('NOT_FOUND', 'Bot not found')
    if (bot.lifecycle === 'running') return bot
    const container = await this.container(id)
    if (!container) throw new GatewayError('NOT_FOUND', 'Bot container missing')
    try {
      await this.docker.start(container.id)
      await this.ready(id)
    } catch (error) {
      this.fail(id, error)
    }
    return this.get(id)!
  }
  async stop(id: string): Promise<FleetBot> {
    const bot = this.get(id)
    if (!bot || bot.lifecycle === 'archived') throw new GatewayError('NOT_FOUND', 'Bot not found')
    this.update(id, { lifecycle: 'stopping' })
    const container = await this.container(id)
    if (container) await this.docker.stop(container.id)
    this.statuses.delete(id)
    this.resources.delete(id)
    const result = this.update(id, { lifecycle: 'stopped' })
    this.activity(id, 'bot_stopped')
    return result
  }
  async restart(id: string): Promise<FleetBot> {
    const bot = this.get(id)
    if (!bot || bot.lifecycle === 'archived') throw new GatewayError('NOT_FOUND', 'Bot not found')
    const container = await this.container(id)
    if (!container) throw new GatewayError('NOT_FOUND', 'Bot container missing')
    this.update(id, { lifecycle: 'restarting' })
    try {
      await this.docker.restart(container.id)
      await this.ready(id)
      this.activity(id, 'bot_restarted')
    } catch (error) {
      this.fail(id, error)
    }
    return this.get(id)!
  }
  async archive(id: string): Promise<FleetBot> {
    const bot = this.get(id)
    if (!bot || bot.lifecycle === 'archived') throw new GatewayError('NOT_FOUND', 'Bot not found')
    const container = await this.container(id)
    if (container) {
      await this.docker.stop(container.id)
      await this.docker.remove(container.id, true)
    }
    this.statuses.delete(id)
    this.resources.delete(id)
    const result = this.store.transaction(() => {
      const archived = this.update(id, { lifecycle: 'archived' })
      this.syncPeers(id, [])
      return archived
    })
    for (const peerId of bot.talksTo) this.emitBot(peerId)
    this.activity(id, 'bot_archived')
    this.onEvent({ type: 'bot.removed', at: now(), botId: id })
    return result
  }
  async pause(id: string): Promise<FleetBot> {
    const bot = this.get(id)
    if (!bot || bot.lifecycle === 'archived') throw new GatewayError('NOT_FOUND', 'Bot not found')
    if (bot.lifecycle === 'running') {
      const hold = await this.client(id).hold({ reason: 'paused' })
      const status = this.statuses.get(id)
      if (status) this.statuses.set(id, { ...status, hold })
    }
    const result = this.update(id, { paused: true })
    this.activity(id, 'paused')
    return result
  }
  async resume(id: string): Promise<FleetBot> {
    const bot = this.get(id)
    if (!bot || bot.lifecycle === 'archived') throw new GatewayError('NOT_FOUND', 'Bot not found')
    if (bot.lifecycle === 'running') {
      const hold = await this.client(id).release({ note: null, durationMs: null, continue: true })
      const status = this.statuses.get(id)
      if (status) this.statuses.set(id, { ...status, hold })
    }
    const result = this.update(id, { paused: false })
    this.activity(id, 'resumed')
    return result
  }
  async patch(id: string, input: FleetPatchBotRequest): Promise<FleetBot> {
    const bot = this.get(id)
    if (!bot || bot.lifecycle === 'archived') throw new GatewayError('NOT_FOUND', 'Bot not found')
    if (input.talksTo) this.validatePeers(id, input.talksTo)
    const next = { ...bot, ...input }
    if (next.lifecycle === 'running') {
      const status = await this.client(id).putProfile({
        botId: id,
        name: next.name,
        instructions: next.instructions,
        ceiling: next.ceiling,
        selection: next.selection,
        gateway: { peersEnabled: next.talksTo.length > 0 },
      })
      this.statuses.set(id, status)
    }
    this.store.transaction(() => {
      this.update(id, input)
      if (input.talksTo) this.syncPeers(id, input.talksTo)
    })
    if (input.talksTo) for (const peerId of new Set([...bot.talksTo, ...input.talksTo])) this.emitBot(peerId)
    return this.get(id)!
  }
  instanceFor(id: string) {
    const bot = this.get(id)
    if (!bot || bot.lifecycle === 'archived') throw new GatewayError('NOT_FOUND', 'Bot not found')
    if (bot.lifecycle !== 'running') throw new GatewayError('BOT_NOT_RUNNING', 'Bot not running')
    return this.client(id)
  }
  async reconcile() {
    const containers = await this.docker.list(managed + '=true')
    const byId = new Map(containers.map((container) => [container.labels[botLabel], container]))
    for (const bot of this.store.listBots()) {
      const container = byId.get(bot.id)
      if (!container) {
        this.update(bot.id, { lifecycle: bot.lifecycle === 'creating' ? 'failed' : 'stopped' })
        continue
      }
      if (container.state === 'running') {
        try {
          this.statuses.set(bot.id, await this.client(bot.id).status())
          this.update(bot.id, { lifecycle: 'running' })
        } catch {
          this.update(bot.id, { lifecycle: 'starting' })
        }
      } else this.update(bot.id, { lifecycle: 'stopped' })
    }
  }
  async refreshStats() {
    for (const bot of this.store.listBots()) {
      if (bot.lifecycle !== 'running') continue
      const container = await this.container(bot.id)
      if (!container) continue
      try {
        this.resources.set(bot.id, { ...(await this.docker.statsOnce(container.id)), startedAt: container.startedAt })
        this.emitBot(bot.id)
      } catch {}
    }
  }
}
