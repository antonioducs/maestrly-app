import {
  deriveBotId,
  FLEET_BOT_ENV,
  type FleetActivityEntry,
  type FleetArchivedBot,
  type FleetBot,
  type FleetCreateBotRequest,
  type FleetGatewayEvent,
  type FleetInstanceStatus,
  type FleetPatchBotRequest,
  type FleetTakeoverState,
} from '@maestrly/bot-fleet-protocol'
import { token, sha256 } from './auth.js'
import type { GatewayConfig } from './config.js'
import { type ContainerInfo, DockerError, type DockerDriver, type ContainerStats } from './docker.js'
import { GatewayError } from './errors.js'
import { InstanceClient } from './instance.js'
import { Logger } from './logger.js'
import type { Store } from './store.js'

const tints = ['#4978c6', '#9b65b6', '#d47754', '#4c9a87', '#c29a43', '#6379a5']
const managed = 'org.maestrly.fleet.managed'
const botLabel = 'org.maestrly.fleet.bot-id'
const now = () => new Date().toISOString()
const containerName = (id: string) => 'maestrly-bot-' + id
/** The bot's `/home/bot`: its accounts, logins, conversation and files. Archiving keeps it. */
const homeVolume = (id: string) => containerName(id) + '-home'
export type InstanceFactory = (botId: string, token: string) => InstanceClient
export class Lifecycle {
  readonly statuses = new Map<string, FleetInstanceStatus>()
  readonly resources = new Map<string, ContainerStats & { startedAt: string | null }>()
  readonly imageOutdated = new Map<string, boolean>()
  readonly takeovers = new Map<string, FleetTakeoverState>()
  private readonly links = new Map<string, AbortController>()
  private readonly pendingSeen = new Map<string, Set<string>>()
  private readonly reconcileTimers = new Map<string, NodeJS.Timeout>()
  private readonly controllerTimers = new Map<string, NodeJS.Timeout>()
  /** Archived bots being deleted forever: neither listed nor restorable meanwhile. */
  private readonly deleting = new Set<string>()
  private readonly logger = new Logger()
  onCloseScreens: (id: string, code: number, mode?: 'control') => void = () => {}
  controlCount: (id: string) => number = () => 0
  onReady: (id: string) => void = () => {}
  onTurnFinished?: (
    botId: string,
    event: { outcome: 'completed' | 'cancelled' | 'failed'; inputId: string | null; text: string | null }
  ) => void
  onEvent: (event: FleetGatewayEvent) => void = () => {}
  constructor(
    readonly store: Store,
    readonly docker: DockerDriver,
    readonly config: GatewayConfig,
    readonly instance: InstanceFactory = (id, secret) => new InstanceClient(id, secret),
    readonly healthTimeoutMs = 240000,
    readonly controllerLostMs = 300000
  ) {}
  private emitBot(id: string) {
    const bot = this.get(id)
    if (bot) this.onEvent({ type: 'bot.updated', at: now(), bot })
  }
  private activity(id: string | null, kind: FleetActivityEntry['kind']) {
    const entry = this.store.addActivity(id, kind)
    this.onEvent({ type: 'activity', at: entry.at, entry })
  }
  recordActivity(
    id: string | null,
    kind: FleetActivityEntry['kind'],
    summary: string | null = null,
    data: FleetActivityEntry['data'] = {}
  ) {
    const entry = this.store.addActivity(id, kind, summary, data)
    this.onEvent({ type: 'activity', at: entry.at, entry })
  }
  inbox() {
    return [...this.statuses].flatMap(([botId, status]) =>
      status.pending.map((interaction) => ({ botId, interaction }))
    )
  }
  private updateStatus(id: string, status: FleetInstanceStatus) {
    const before = JSON.stringify(this.inbox())
    const seen = this.pendingSeen.get(id) ?? new Set<string>()
    const next = new Set(status.pending.map((item) => item.kind + ':' + item.id))
    for (const item of status.pending) {
      const key = item.kind + ':' + item.id
      if (!seen.has(key))
        this.recordActivity(
          id,
          'needs_you',
          item.kind === 'permission' ? (item.tool?.name ?? item.title) : item.kind === 'help' ? item.reason : 'question'
        )
    }
    this.pendingSeen.set(id, next)
    this.statuses.set(id, status)
    this.emitBot(id)
    if (JSON.stringify(this.inbox()) !== before) this.onEvent({ type: 'inbox.updated', at: now(), items: this.inbox() })
    if (status.ready && this.store.getBot(id)?.lifecycle === 'running') this.onReady(id)
  }
  private stopLink(id: string) {
    this.links.get(id)?.abort()
    this.links.delete(id)
  }
  private removeStatus(id: string) {
    const before = JSON.stringify(this.inbox())
    this.statuses.delete(id)
    if (JSON.stringify(this.inbox()) !== before) this.onEvent({ type: 'inbox.updated', at: now(), items: this.inbox() })
  }
  private startLink(id: string) {
    this.stopLink(id)
    const controller = new AbortController()
    this.links.set(id, controller)
    void (async () => {
      let since = this.statuses.get(id)?.lastEventSeq ?? 0
      let delay = 1000
      while (!controller.signal.aborted) {
        try {
          for await (const event of this.client(id).events(since, controller.signal)) {
            if (event.type === 'reset' || event.seq <= since) {
              const fresh = await this.client(id).status()
              since = fresh.lastEventSeq
              this.updateStatus(id, fresh)
              this.onEvent({ type: 'transcript.reset', at: now(), botId: id })
              continue
            }
            since = event.seq
            delay = 1000
            if (event.type === 'status') this.updateStatus(id, event.status)
            else if (event.type === 'transcript.upsert')
              this.onEvent({ type: 'transcript.upsert', at: now(), botId: id, item: event.item })
            else if (event.type === 'turn.finished') {
              this.onTurnFinished?.(id, { outcome: event.outcome, inputId: event.inputId, text: event.text })
              if (event.outcome !== 'cancelled')
                this.recordActivity(id, event.outcome === 'completed' ? 'turn_completed' : 'turn_failed', event.summary)
            }
          }
        } catch {}
        if (!controller.signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, delay))
          delay = Math.min(delay * 2, 30000)
        }
      }
    })()
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
    bot.capabilities = status?.capabilities ?? []
    bot.accounts = status?.accounts ?? { connected: false, providers: [] }
    bot.usage = status?.usage ?? null
    bot.compactionState = status?.compaction ?? null
    bot.takeover = this.takeovers.get(bot.id) ?? bot.takeover
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
    else if (status.hold.reason === 'takeover' || bot.takeover.state === 'human') bot.status = 'human'
    else if (status.pending.length) bot.status = 'waiting'
    else if (!status.accounts.connected || bot.compactionState?.configured === false) bot.status = 'setup'
    else if (
      status.turn.state !== 'idle' ||
      status.queue.length ||
      bot.compactionState?.progress?.status === 'running' ||
      bot.compactionState?.progress?.status === 'retrying'
    )
      bot.status = 'working'
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
      compaction: null,
      compactionState: null,
      talksTo: input.talksTo,
      paused: false,
      lifecycle: 'creating',
      setup: { step: 'container', error: null, errorMessage: null },
      status: 'starting',
      activity: null,
      pendingCount: 0,
      accounts: { connected: false, providers: [] },
      takeover: { state: 'none', deviceId: null, deviceName: null, since: null },
      resources: { memoryBytes: null, memoryLimitBytes: null, cpuPercent: null, startedAt: null },
      screen: { width: 1280, height: 800, display: ':0' },
      appVersion: null,
      capabilities: [],
      usage: null,
      environmentId: null,
      createdAt: at,
      updatedAt: at,
    }
    const controlToken = token(),
      gatewayToken = token()
    this.store.transaction(() => {
      this.validatePeers(id, input.talksTo)
      this.store.insertBot(bot, {
        controlToken,
        gatewayToken,
        gatewayTokenSha256: sha256(gatewayToken),
        keyringPassword: token(),
      })
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
      return await this.docker.inspect(containerName(id))
    } catch (error) {
      if (error instanceof DockerError && error.status === 404) return null
      throw error
    }
  }
  private async provision(id: string) {
    if (!(await this.docker.imageInspect(this.config.botImage)))
      throw new GatewayError('IMAGE_MISSING', 'Bot image missing')
    await this.docker.ensureNetwork(this.config.network)
    // Docker returns the existing volume for a restored bot, keeping its files.
    await this.docker.volumeCreate(homeVolume(id), { [managed]: 'true', [botLabel]: id })
    const container = await this.createContainer(id)
    this.imageOutdated.set(id, false)
    await this.docker.start(container)
    await this.ready(id)
  }
  private async createContainer(id: string): Promise<string> {
    const bot = this.store.getBot(id)!,
      secrets = this.store.botSecrets(id)!
    const name = containerName(id),
      volume = homeVolume(id)
    const env = {
      [FLEET_BOT_ENV.mode]: '1',
      [FLEET_BOT_ENV.id]: id,
      [FLEET_BOT_ENV.name]: bot.name,
      [FLEET_BOT_ENV.controlHost]: '0.0.0.0',
      [FLEET_BOT_ENV.controlPort]: '7680',
      [FLEET_BOT_ENV.controlToken]: secrets.controlToken,
      [FLEET_BOT_ENV.gatewayUrl]: this.config.internalUrl,
      [FLEET_BOT_ENV.gatewayToken]: secrets.gatewayToken,
      MAESTRLY_BOT_KEYRING_PASSWORD: secrets.keyringPassword,
      TZ: this.config.timezone,
    }
    return this.docker.containerCreate({
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
  }
  private async updateImageState(id: string, container: ContainerInfo): Promise<string | null> {
    const image = await this.docker.imageInspect(this.config.botImage)
    if (!image) {
      this.imageOutdated.set(id, false)
      this.logger.warn('Configured bot image missing; keeping existing container', {
        botId: id,
        image: this.config.botImage,
      })
      return null
    }
    this.imageOutdated.set(id, container.imageId !== image.id)
    return image.id
  }
  private async startWithCurrentImage(id: string, container: ContainerInfo, restart: boolean): Promise<boolean> {
    const imageId = await this.updateImageState(id, container)
    if (imageId && container.imageId !== imageId) {
      await this.docker.stop(container.id)
      await this.docker.remove(container.id)
      const replacement = await this.createContainer(id)
      await this.docker.start(replacement)
      await this.ready(id)
      this.imageOutdated.set(id, false)
      const fromImage = container.imageId.replace(/^sha256:/, '').slice(0, 12)
      const toImage = imageId.replace(/^sha256:/, '').slice(0, 12)
      this.logger.info('Bot container updated', { botId: id, fromImage, toImage })
      this.recordActivity(id, 'bot_restarted', null, { updated: true, fromImage, toImage })
      return true
    }
    if (restart) await this.docker.restart(container.id)
    else await this.docker.start(container.id)
    await this.ready(id)
    return false
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
      compaction: bot.compaction,
      gateway: { peersEnabled: bot.talksTo.length > 0 },
    })
    this.updateStatus(id, status)
    if (bot.paused) await client.hold({ reason: 'paused' })
    this.update(id, { lifecycle: 'running', setup: { step: 'ready', error: null, errorMessage: null } })
    this.onReady(id)
    this.startLink(id)
    this.activity(id, 'bot_started')
  }
  private fail(id: string, error: unknown) {
    this.cancelReconcile(id)
    this.stopLink(id)
    this.clearTakeover(id, 4002)
    this.removeStatus(id)
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
      await this.startWithCurrentImage(id, container, false)
    } catch (error) {
      this.fail(id, error)
    }
    return this.get(id)!
  }
  async stop(id: string): Promise<FleetBot> {
    const bot = this.get(id)
    if (!bot || bot.lifecycle === 'archived') throw new GatewayError('NOT_FOUND', 'Bot not found')
    this.update(id, { lifecycle: 'stopping' })
    this.cancelReconcile(id)
    this.stopLink(id)
    this.clearTakeover(id, 4002)
    const container = await this.container(id)
    if (container) await this.docker.stop(container.id)
    this.removeStatus(id)
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
    this.cancelReconcile(id)
    this.stopLink(id)
    this.clearTakeover(id, 4002)
    this.removeStatus(id)
    try {
      if (!(await this.startWithCurrentImage(id, container, true))) this.activity(id, 'bot_restarted')
    } catch (error) {
      this.fail(id, error)
    }
    return this.get(id)!
  }
  async archive(id: string): Promise<FleetBot> {
    const bot = this.get(id)
    if (!bot || bot.lifecycle === 'archived') throw new GatewayError('NOT_FOUND', 'Bot not found')
    const container = await this.container(id)
    this.cancelReconcile(id)
    this.stopLink(id)
    this.clearTakeover(id, 4002)
    if (container) {
      await this.docker.stop(container.id)
      await this.docker.remove(container.id, true)
    }
    this.removeStatus(id)
    this.resources.delete(id)
    this.imageOutdated.delete(id)
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
  private requireArchived(id: string): FleetBot {
    const bot = this.store.getBot(id)
    if (bot?.lifecycle !== 'archived' || this.deleting.has(id))
      throw new GatewayError('NOT_FOUND', 'Archived bot not found')
    return bot
  }
  async archivedList(): Promise<FleetArchivedBot[]> {
    const archived = this.store.archivedBots().filter(({ bot }) => !this.deleting.has(bot.id))
    return Promise.all(
      archived.map(async ({ bot, archivedAt }) => ({
        id: bot.id,
        name: bot.name,
        role: bot.role,
        tint: bot.tint,
        createdAt: bot.createdAt,
        archivedAt,
        files: (await this.docker.volumeExists(homeVolume(bot.id))) ? ('kept' as const) : ('missing' as const),
        environmentId: null,
      }))
    )
  }
  /**
   * Brings an archived bot back in a new container on its kept home volume, with the same secrets (its keyring,
   * and so its saved API keys, stay readable), talking again to the peers still active. The bot leaves `archived`
   * before any await, so a second request fails instead of racing the first into a container name conflict.
   */
  restore(id: string): FleetBot {
    const bot = this.requireArchived(id)
    const talksTo = bot.talksTo.filter((peerId) => {
      const peer = this.store.getBot(peerId)
      return !!peer && peer.lifecycle !== 'archived'
    })
    const restored = this.store.transaction(() => {
      const next = this.update(id, {
        lifecycle: 'creating',
        setup: { step: 'container', error: null, errorMessage: null },
        talksTo,
      })
      this.syncPeers(id, talksTo)
      return next
    })
    for (const peerId of talksTo) this.emitBot(peerId)
    this.activity(id, 'bot_restored')
    queueMicrotask(() => {
      void (async () => {
        // An archive interrupted after stopping the container may have left it behind.
        const leftover = await this.container(id)
        if (leftover) await this.docker.remove(leftover.id, true)
        await this.provision(id)
      })().catch((error) => this.fail(id, error))
    })
    return restored
  }
  /** Irreversible: removes an archived bot's container if any, its home volume, and every gateway record of it. */
  async purge(id: string): Promise<void> {
    const bot = this.requireArchived(id)
    this.deleting.add(id)
    try {
      const leftover = await this.container(id)
      if (leftover) await this.docker.remove(leftover.id, true)
      try {
        await this.docker.volumeRemove(homeVolume(id))
      } catch (error) {
        if (error instanceof DockerError)
          throw new GatewayError(
            error.status === 409 ? 'CONFLICT' : 'DOCKER_UNAVAILABLE',
            error.status === 409 ? 'The bot files are still in use' : 'Docker could not remove the bot files'
          )
        throw error
      }
      // Files first: if this fails, the record remains and deleting again finishes the job.
      this.store.deleteBot(id)
    } finally {
      this.deleting.delete(id)
    }
    this.pendingSeen.delete(id)
    this.recordActivity(null, 'bot_deleted', bot.name)
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
    if (this.takeovers.get(id)?.state && this.takeovers.get(id)?.state !== 'none')
      throw new GatewayError('CONFLICT', 'Give back the screen before resuming the bot')
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
        compaction: next.compaction,
        gateway: { peersEnabled: next.talksTo.length > 0 },
      })
      this.updateStatus(id, status)
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
  private clearTakeover(id: string, code: number) {
    const timer = this.controllerTimers.get(id)
    if (timer) clearTimeout(timer)
    this.controllerTimers.delete(id)
    this.takeovers.delete(id)
    this.onCloseScreens(id, code)
  }
  controllerChanged(id: string) {
    const timer = this.controllerTimers.get(id)
    if (timer) clearTimeout(timer)
    this.controllerTimers.delete(id)
    if (this.takeovers.get(id)?.state === 'human' && this.controlCount(id) === 0) {
      const next = setTimeout(() => {
        void this.releaseTakeover(id, this.takeovers.get(id)?.deviceId ?? '', null, true, 'controller_lost').catch(
          () => {}
        )
      }, this.controllerLostMs)
      this.controllerTimers.set(id, next)
    }
  }
  async takeover(id: string, deviceId: string, deviceName: string): Promise<FleetTakeoverState> {
    this.instanceFor(id)
    const current = this.takeovers.get(id)
    if (current && current.state !== 'none') {
      if (current.deviceId !== deviceId) throw new GatewayError('CONFLICT', 'Bot controlled by another device')
      if (current.state === 'human') return current
      throw new GatewayError('CONFLICT', 'Takeover in progress')
    }
    const acquiring: FleetTakeoverState = { state: 'acquiring', deviceId, deviceName, since: null }
    this.takeovers.set(id, acquiring)
    this.emitBot(id)
    try {
      const hold = await this.client(id).hold({ reason: 'takeover' })
      if (this.store.deviceRevoked(deviceId)) {
        await this.client(id).release({ note: null, durationMs: null, continue: true })
        throw new GatewayError('CONFLICT', 'Device revoked during takeover')
      }
      const status = this.statuses.get(id)
      if (status) this.updateStatus(id, { ...status, hold })
      const human: FleetTakeoverState = { state: 'human', deviceId, deviceName, since: now() }
      this.takeovers.set(id, human)
      this.emitBot(id)
      this.recordActivity(id, 'takeover_started')
      this.controllerChanged(id)
      return human
    } catch (error) {
      this.takeovers.delete(id)
      this.emitBot(id)
      throw new GatewayError('CONFLICT', error instanceof Error ? error.message : 'Bot could not be held')
    }
  }
  async releaseTakeover(
    id: string,
    deviceId: string,
    note: string | null,
    continueTurn: boolean,
    reason?: string
  ): Promise<FleetTakeoverState> {
    const current = this.takeovers.get(id)
    if (current?.deviceId !== deviceId || current.state !== 'human')
      throw new GatewayError('CONFLICT', 'Device does not hold this takeover')
    this.takeovers.set(id, { ...current, state: 'releasing' })
    this.emitBot(id)
    this.onCloseScreens(id, 4001, 'control')
    const durationMs = Math.max(0, Date.now() - Date.parse(current.since!))
    try {
      const hold = await this.instanceFor(id).release({ note, durationMs, continue: continueTurn })
      const status = this.statuses.get(id)
      if (status) this.updateStatus(id, { ...status, hold })
      const timer = this.controllerTimers.get(id)
      if (timer) clearTimeout(timer)
      this.controllerTimers.delete(id)
      this.takeovers.delete(id)
      this.emitBot(id)
      this.recordActivity(id, 'takeover_ended', null, { durationMs, ...(reason ? { reason } : {}) })
      return { state: 'none', deviceId: null, deviceName: null, since: null }
    } catch (error) {
      this.takeovers.set(id, current)
      this.emitBot(id)
      this.controllerChanged(id)
      throw error
    }
  }
  async reconcile() {
    const containers = await this.docker.list(managed + '=true')
    const byId = new Map(containers.map((container) => [container.labels[botLabel], container]))
    const currentImage = await this.docker.imageInspect(this.config.botImage)
    for (const bot of this.store.listBots()) {
      const container = byId.get(bot.id)
      if (!container) {
        this.imageOutdated.delete(bot.id)
        this.update(bot.id, { lifecycle: bot.lifecycle === 'creating' ? 'failed' : 'stopped' })
        continue
      }
      this.imageOutdated.set(bot.id, Boolean(currentImage && container.imageId !== currentImage.id))
      if (this.imageOutdated.get(bot.id))
        this.logger.info('Bot container uses an older image; restart to update', { botId: bot.id })
      if (container.state === 'running') {
        try {
          await this.reconcileOne(bot.id)
        } catch {
          this.update(bot.id, { lifecycle: 'starting' })
          this.scheduleReconcile(bot.id, 1000)
        }
      } else this.update(bot.id, { lifecycle: 'stopped' })
    }
  }
  private async reconcileOne(id: string) {
    const client = this.client(id)
    const health = await client.health()
    if (!health.ready) throw new GatewayError('INSTANCE_UNAVAILABLE', 'Bot desktop not ready')
    const bot = this.store.getBot(id)!
    let status = await client.putProfile({
      botId: id,
      name: bot.name,
      instructions: bot.instructions,
      ceiling: bot.ceiling,
      selection: bot.selection,
      compaction: bot.compaction,
      gateway: { peersEnabled: bot.talksTo.length > 0 },
    })
    if (!status.ready) throw new GatewayError('INSTANCE_UNAVAILABLE', 'Bot desktop not ready')
    if (status.hold.reason === 'takeover') {
      const hold = await client.release({ note: null, durationMs: null, continue: true })
      status = { ...status, hold }
    }
    if (bot.paused && status.hold.reason !== 'paused') {
      const hold = await client.hold({ reason: 'paused' })
      status = { ...status, hold }
    }
    this.updateStatus(id, status)
    this.update(id, { lifecycle: 'running', setup: { step: 'ready', error: null, errorMessage: null } })
    this.onReady(id)
    this.startLink(id)
  }
  private cancelReconcile(id: string) {
    const timer = this.reconcileTimers.get(id)
    if (timer) clearTimeout(timer)
    this.reconcileTimers.delete(id)
  }
  private scheduleReconcile(id: string, delay: number) {
    if (this.reconcileTimers.has(id)) return
    const timer = setTimeout(async () => {
      this.reconcileTimers.delete(id)
      try {
        const container = await this.container(id)
        if (container?.state !== 'running') {
          this.update(id, { lifecycle: 'stopped' })
          return
        }
        await this.reconcileOne(id)
      } catch {
        this.scheduleReconcile(id, Math.min(delay * 2, 30000))
      }
    }, delay)
    timer.unref()
    this.reconcileTimers.set(id, timer)
  }
  close() {
    for (const timer of this.reconcileTimers.values()) clearTimeout(timer)
    this.reconcileTimers.clear()
    for (const id of this.links.keys()) this.stopLink(id)
    for (const timer of this.controllerTimers.values()) clearTimeout(timer)
    this.controllerTimers.clear()
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
