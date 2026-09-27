import {
  deriveBotId,
  FLEET_BOT_ENV,
  FLEET_ENVIRONMENTS_FEATURE,
  FLEET_PORTS,
  type FleetActivityEntry,
  type FleetArchivedBot,
  type FleetArchivedEnvironment,
  type FleetBot,
  type FleetBotSetup,
  type FleetCreateBotRequest,
  type FleetEnvironment,
  type FleetEnvironmentSetup,
  type FleetErrorCode,
  type FleetGatewayEvent,
  type FleetInstanceEvent,
  type FleetInstanceProfile,
  type FleetInstanceStatus,
  type FleetLifecycle,
  type FleetPatchBotRequest,
  type FleetTakeoverState,
} from '@maestrly/bot-fleet-protocol'
import { token, sha256 } from './auth.js'
import type { GatewayConfig } from './config.js'
import { type ContainerInfo, DockerError, type DockerDriver, type ContainerStats } from './docker.js'
import { GatewayError } from './errors.js'
import { InstanceClient, InstanceUnreachableError } from './instance.js'
import { Logger } from './logger.js'
import type { EnvironmentChanges, Store, StoredEnvironment } from './store.js'

const tints = ['#4978c6', '#9b65b6', '#d47754', '#4c9a87', '#c29a43', '#6379a5']
const managed = 'org.maestrly.fleet.managed'
const environmentLabel = 'org.maestrly.fleet.environment-id'
/** The label of containers created before environments: their bot's id, which their environment took over. */
const legacyBotLabel = 'org.maestrly.fleet.bot-id'
const now = () => new Date().toISOString()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/** The container and home volume of an environment created with environments; migrated ones keep their bot's names. */
export const environmentContainerName = (id: string) => 'maestrly-env-' + id
export const environmentVolumeName = (id: string) => environmentContainerName(id) + '-home'
export const RESTART_TO_ADD_BOTS = 'Restart this environment to update it before adding bots.'
export const SHARED_ENVIRONMENT = 'This bot shares its environment. Restart the environment instead.'
export const RESTORE_ENVIRONMENT_FIRST = 'Restore its environment first'
export const START_ENVIRONMENT_FIRST = 'Start its environment first'
export const SLOT_IN_USE = 'Its display slot is still in use. Start the bot again to retry.'
const botSetup = (step: FleetBotSetup['step']): FleetBotSetup => ({ step, error: null, errorMessage: null })
const environmentSetup = (step: FleetEnvironmentSetup['step']): FleetEnvironmentSetup => ({
  step,
  error: null,
  errorMessage: null,
})
const botKinds = { started: 'bot_started', stopped: 'bot_stopped', restarted: 'bot_restarted' } as const
const environmentKinds = {
  started: 'environment_started',
  stopped: 'environment_stopped',
  restarted: 'environment_restarted',
} as const
function failureCode(error: unknown): FleetErrorCode {
  if (error instanceof GatewayError) return error.code
  return error instanceof DockerError && error.status === 404 ? 'IMAGE_MISSING' : 'DOCKER_UNAVAILABLE'
}
export type InstanceFactory = (environmentId: string, token: string, host: string) => InstanceClient
type Resources = ContainerStats & { startedAt: string | null }
/** The bot whose own start, stop or restart acted on its environment: the activity is then recorded as the bot's. */
type Via = { botId: string } | null
export class Lifecycle {
  readonly statuses = new Map<string, FleetInstanceStatus>()
  /** Container measurements, by environment. */
  readonly resources = new Map<string, Resources>()
  /** Whether an environment's container runs an older image than the configured one, by environment. */
  readonly imageOutdated = new Map<string, boolean>()
  readonly takeovers = new Map<string, FleetTakeoverState>()
  /** What each environment's Maestrly reported at its last health check. */
  private readonly instances = new Map<string, { appVersion: string; capabilities: string[] }>()
  /** One event stream per environment, fanned out to its bots. */
  private readonly links = new Map<string, AbortController>()
  private readonly pendingSeen = new Map<string, Set<string>>()
  private readonly reconcileTimers = new Map<string, NodeJS.Timeout>()
  private readonly controllerTimers = new Map<string, NodeJS.Timeout>()
  private readonly locks = new Map<string, Promise<void>>()
  /** Archived bots and environments being deleted forever: neither listed nor restorable meanwhile. */
  private readonly deleting = new Set<string>()
  private readonly deletingEnvironments = new Set<string>()
  private readonly logger = new Logger()
  onCloseScreens: (id: string, code: number, mode?: 'control') => void = () => {}
  onCloseEnvironmentScreens: (environmentId: string, code: number) => void = () => {}
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
    readonly instance: InstanceFactory = (id, secret, host) =>
      new InstanceClient(id, secret, 'http://' + host + ':' + FLEET_PORTS.instanceControl),
    readonly healthTimeoutMs = 240000,
    readonly controllerLostMs = 300000
  ) {}
  /**
   * Runs an environment's container, membership and installation changes one at a time, so that a bot joining while
   * its environment starts, or taking a slot another bot just left, always sees what the change before it did.
   */
  private exclusive<T>(environmentId: string, action: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(environmentId) ?? Promise.resolve()).then(action)
    const settled = run.then(
      () => undefined,
      () => undefined
    )
    this.locks.set(environmentId, settled)
    void settled.then(() => {
      if (this.locks.get(environmentId) === settled) this.locks.delete(environmentId)
    })
    return run
  }
  private emitBot(id: string) {
    const bot = this.get(id)
    if (bot) this.onEvent({ type: 'bot.updated', at: now(), bot })
  }
  /** Tells devices about an environment and, since their lifecycle follows it, about its bots. */
  private emitEnvironment(environmentId: string, bots = true) {
    const environment = this.environment(environmentId)
    if (!environment) return
    this.onEvent({ type: 'environment.updated', at: now(), environment })
    if (bots) for (const id of environment.botIds) this.emitBot(id)
  }
  private activity(id: string | null, kind: FleetActivityEntry['kind']) {
    this.recordActivity(id, kind)
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
  /** Records an entry about an environment itself: no bot, the environment's name as the summary unless given. */
  recordEnvironmentActivity(
    environmentId: string,
    kind: FleetActivityEntry['kind'],
    data: FleetActivityEntry['data'] = {},
    summary: string | null = this.store.getEnvironment(environmentId)?.name ?? null
  ) {
    const entry = this.store.addActivity(null, kind, summary, data, environmentId)
    this.onEvent({ type: 'activity', at: entry.at, entry })
  }
  private lifecycleActivity(
    environmentId: string,
    via: Via,
    kind: keyof typeof botKinds,
    data: FleetActivityEntry['data'] = {}
  ) {
    if (via) this.recordActivity(via.botId, botKinds[kind], null, data)
    else this.recordEnvironmentActivity(environmentId, environmentKinds[kind], data)
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
    if (status.ready && this.get(id)?.lifecycle === 'running') this.onReady(id)
  }
  private stopLink(environmentId: string) {
    this.links.get(environmentId)?.abort()
    this.links.delete(environmentId)
  }
  private removeStatus(id: string) {
    const before = JSON.stringify(this.inbox())
    this.statuses.delete(id)
    if (JSON.stringify(this.inbox()) !== before) this.onEvent({ type: 'inbox.updated', at: now(), items: this.inbox() })
  }
  /** Follows an environment's one event stream and hands each event to the bot it names. */
  private startLink(environmentId: string) {
    this.stopLink(environmentId)
    const controller = new AbortController()
    this.links.set(environmentId, controller)
    void (async () => {
      let since = Math.max(
        0,
        ...this.store.botsOfEnvironment(environmentId).map((bot) => this.statuses.get(bot.id)?.lastEventSeq ?? 0)
      )
      let delay = 1000
      while (!controller.signal.aborted) {
        try {
          const client = this.client(environmentId)
          for await (const event of client.events(since, controller.signal)) {
            if (event.type === 'reset' || event.seq <= since) {
              since = await this.refreshStatuses(environmentId, client, event.seq)
              continue
            }
            since = event.seq
            delay = 1000
            this.dispatch(environmentId, event)
          }
        } catch {}
        if (!controller.signal.aborted) {
          await sleep(delay)
          delay = Math.min(delay * 2, 30000)
        }
      }
    })()
  }
  private dispatch(environmentId: string, event: FleetInstanceEvent) {
    const id = this.eventBot(environmentId, event.botId)
    if (!id) return
    if (event.type === 'status') this.updateStatus(id, event.status)
    else if (event.type === 'transcript.upsert')
      this.onEvent({ type: 'transcript.upsert', at: now(), botId: id, item: event.item })
    else if (event.type === 'turn.finished') {
      this.onTurnFinished?.(id, { outcome: event.outcome, inputId: event.inputId, text: event.text })
      if (event.outcome !== 'cancelled')
        this.recordActivity(id, event.outcome === 'completed' ? 'turn_completed' : 'turn_failed', event.summary)
    }
  }
  /**
   * The active bot of this environment that an instance event is about. An environment's stream speaks only for its
   * own bots: events naming another environment's bot, an unknown or archived bot, or no bot at all are dropped. An
   * instance from before environments names no bot; its events belong to its one bot.
   */
  private eventBot(environmentId: string, botId: string | null): string | null {
    if (botId === null) return this.capable(environmentId) ? null : (this.singleBot(environmentId)?.id ?? null)
    if (this.store.botPlacement(botId)?.environmentId !== environmentId) return null
    return this.store.getBot(botId)?.lifecycle === 'archived' ? null : botId
  }
  /**
   * The bot an instance from before environments runs, archived or not: the one its environment was made from (a
   * migrated bot gave the environment its id), or else its first bot. The instance keeps that bot's conversation.
   */
  private legacyBot(environmentId: string): FleetBot | null {
    const everyone = this.store.botsOfEnvironment(environmentId, true)
    return (
      everyone.find((bot) => bot.id === environmentId) ??
      [...everyone].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ??
      null
    )
  }
  /** That bot, if active. */
  private singleBot(environmentId: string): FleetBot | null {
    const own = this.legacyBot(environmentId)
    return own && own.lifecycle !== 'archived' ? own : null
  }
  /** After a reset, or a sequence going back because the instance restarted: reloads its bots and returns the cursor. */
  private async refreshStatuses(environmentId: string, client: InstanceClient, seq: number): Promise<number> {
    if (!this.capable(environmentId)) {
      const id = this.eventBot(environmentId, null)
      if (!id) return seq
      const fresh = await client.forBot(id, false).status()
      this.updateStatus(id, fresh)
      this.onEvent({ type: 'transcript.reset', at: now(), botId: id })
      return fresh.lastEventSeq
    }
    const aggregate = await client.environmentStatus()
    let latest = seq
    for (const installed of aggregate.bots) {
      const id = this.eventBot(environmentId, installed.botId)
      if (!id) continue
      latest = Math.max(latest, installed.status.lastEventSeq)
      this.updateStatus(id, installed.status)
      this.onEvent({ type: 'transcript.reset', at: now(), botId: id })
    }
    return latest
  }
  get(id: string): FleetBot | null {
    const bot = this.store.getBot(id)
    return bot ? this.assemble(bot) : null
  }
  list(): FleetBot[] {
    return this.store.listBots().map((bot) => this.assemble(bot))
  }
  /**
   * A bot's lifecycle and setup as devices see them: its own while it is archived or being installed in a running
   * environment, otherwise its environment's, whose setup steps it shows until the environment's desktop answers.
   */
  private placementState(
    bot: FleetBot,
    environment: StoredEnvironment | null
  ): { lifecycle: FleetLifecycle; setup: FleetBotSetup } {
    if (bot.lifecycle === 'archived' || !environment) return { lifecycle: bot.lifecycle, setup: bot.setup }
    if (environment.lifecycle === 'running')
      return {
        lifecycle:
          bot.lifecycle === 'running' || bot.lifecycle === 'failed' || bot.lifecycle === 'creating'
            ? bot.lifecycle
            : 'starting',
        setup: bot.setup,
      }
    return {
      lifecycle: environment.lifecycle,
      setup: environment.setup.step === 'ready' ? bot.setup : { ...environment.setup },
    }
  }
  private assemble(bot: FleetBot): FleetBot {
    const environment = bot.environmentId ? this.store.getEnvironment(bot.environmentId) : null
    const state = this.placementState(bot, environment)
    bot.lifecycle = state.lifecycle
    bot.setup = state.setup
    const status = this.statuses.get(bot.id)
    // Resources are measured per environment: a bot reports them only when it is alone in it, so that devices that
    // add up bots do not count shared memory twice.
    const alone =
      !!environment && bot.lifecycle !== 'archived' && this.store.botsOfEnvironment(environment.id).length === 1
    const resources = alone ? this.resources.get(environment.id) : undefined
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
  /** An active environment as devices see it, or null. */
  environment(id: string): FleetEnvironment | null {
    const environment = this.store.getEnvironment(id)
    return environment && !environment.archivedAt ? this.environmentView(environment) : null
  }
  environments(): FleetEnvironment[] {
    return this.store.listEnvironments().map((environment) => this.environmentView(environment))
  }
  private environmentView(environment: StoredEnvironment): FleetEnvironment {
    const instance = this.instances.get(environment.id),
      resources = this.resources.get(environment.id)
    return {
      id: environment.id,
      name: environment.name,
      lifecycle: environment.lifecycle,
      setup: environment.setup,
      resources: {
        memoryBytes: resources?.memoryBytes ?? null,
        memoryLimitBytes: resources?.memoryLimitBytes ?? null,
        cpuPercent: resources?.cpuPercent ?? null,
        startedAt: resources?.startedAt ?? null,
      },
      memoryLimitBytes: environment.memoryLimitBytes,
      appVersion: instance?.appVersion ?? null,
      capabilities: this.environmentCapabilities(environment.id),
      botIds: this.store.botsOfEnvironment(environment.id).map((bot) => bot.id),
      createdAt: environment.createdAt,
      updatedAt: environment.updatedAt,
    }
  }
  /**
   * What an environment's Maestrly can do. One from before environments names nothing at its health check: its bot's
   * status tells instead (as it does for configuration from the Mac), and never that it hosts several bots.
   */
  private environmentCapabilities(id: string): string[] {
    const instance = this.instances.get(id)
    if (!instance || instance.capabilities.includes(FLEET_ENVIRONMENTS_FEATURE)) return instance?.capabilities ?? []
    const bot = this.singleBot(id)
    const status = bot ? this.statuses.get(bot.id) : undefined
    return [...new Set([...instance.capabilities, ...(status?.capabilities ?? [])])].filter(
      (capability) => capability !== FLEET_ENVIRONMENTS_FEATURE
    )
  }
  /** Whether an environment's Maestrly hosts several bots; null until its health has been checked. */
  environmentCapable(id: string): boolean | null {
    const instance = this.instances.get(id)
    return instance ? instance.capabilities.includes(FLEET_ENVIRONMENTS_FEATURE) : null
  }
  private capable(id: string): boolean {
    return this.environmentCapable(id) === true
  }
  private requireEnvironment(id: string): StoredEnvironment {
    const environment = this.store.getEnvironment(id)
    if (!environment || environment.archivedAt || this.deletingEnvironments.has(id))
      throw new GatewayError('NOT_FOUND', 'Environment not found')
    return environment
  }
  private updateEnvironment(id: string, changes: EnvironmentChanges) {
    this.store.updateEnvironment(id, changes)
    this.emitEnvironment(id)
  }
  private update(id: string, changes: Partial<FleetBot>) {
    const bot = this.store.getBot(id)
    if (!bot) throw new GatewayError('NOT_FOUND', 'Bot not found')
    const next = { ...bot, ...changes, updatedAt: now() }
    this.store.saveBot(next)
    this.emitBot(id)
    return this.get(id)!
  }
  /** Records how an installation went, unless the bot was archived meanwhile: it then stays archived. */
  private updateActive(id: string, changes: Partial<FleetBot>) {
    const bot = this.store.getBot(id)
    if (bot && bot.lifecycle !== 'archived') this.update(id, changes)
  }
  private profile(bot: FleetBot): FleetInstanceProfile {
    return {
      botId: bot.id,
      name: bot.name,
      instructions: bot.instructions,
      ceiling: bot.ceiling,
      selection: bot.selection,
      compaction: bot.compaction,
      gateway: { peersEnabled: bot.talksTo.length > 0 },
    }
  }
  private insertEnvironment(name: string, memoryLimitBytes: number | null, at: string): string {
    const taken = [...this.store.listEnvironments(), ...this.store.archivedEnvironments()].map((item) => item.id)
    const id = deriveBotId(name, taken)
    this.store.insertEnvironment(
      {
        id,
        name,
        lifecycle: 'creating',
        setup: environmentSetup('container'),
        containerName: environmentContainerName(id),
        volumeName: environmentVolumeName(id),
        memoryLimitBytes,
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
      },
      { controlToken: token(), keyringPassword: token() }
    )
    return id
  }
  /** Creates an environment with no bot yet: its container, then its desktop. */
  createEnvironment(input: { name: string; memoryLimitBytes: number | null }): FleetEnvironment {
    const id = this.insertEnvironment(input.name, input.memoryLimitBytes, now())
    this.recordEnvironmentActivity(id, 'environment_created')
    this.emitEnvironment(id, false)
    this.queueProvision(id, false)
    return this.environment(id)!
  }
  /**
   * Creates a bot in an existing environment (`environmentId`) or in a new one (`environment`, or else one named after
   * the bot, as older Macs ask). A new environment gets its container and desktop first; the bot then installs its
   * profile, which is all a bot joining an existing environment needs.
   */
  create(input: FleetCreateBotRequest): FleetBot {
    const ids = this.store.listBots(true).map((bot) => bot.id)
    const id = deriveBotId(input.name, ids),
      at = now()
    const joining = input.environmentId !== undefined
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
      setup: botSetup(joining ? 'profile' : 'container'),
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
    const gatewayToken = token()
    const environmentId = this.store.transaction(() => {
      this.validatePeers(id, input.talksTo)
      let target: string
      if (input.environmentId !== undefined) {
        target = this.requireEnvironment(input.environmentId).id
        this.requireSingleBotRoom(target, id)
      } else
        target = this.insertEnvironment(
          input.environment?.name ?? input.name,
          input.environment?.memoryLimitBytes ?? null,
          at
        )
      this.store.insertBot(bot, { gatewayToken, gatewayTokenSha256: sha256(gatewayToken) }, { environmentId: target })
      this.syncPeers(id, input.talksTo)
      return target
    })
    this.activity(id, 'bot_created')
    if (joining) {
      this.emitEnvironment(environmentId, false)
      this.emitBot(id)
      this.queueInstall(environmentId, [id], false)
    } else {
      this.emitEnvironment(environmentId)
      this.queueProvision(environmentId, false)
    }
    return this.get(id)!
  }
  /** An instance from before environments runs one bot, and keeps its conversation: no other bot can join it. */
  private requireSingleBotRoom(environmentId: string, botId: string) {
    if (this.environmentCapable(environmentId) !== false) return
    if (this.store.botsOfEnvironment(environmentId, true).some((bot) => bot.id !== botId))
      throw new GatewayError('CONFLICT', RESTART_TO_ADD_BOTS)
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
  private activePeers(bot: FleetBot): string[] {
    return bot.talksTo.filter((peerId) => {
      const peer = this.store.getBot(peerId)
      return !!peer && peer.lifecycle !== 'archived'
    })
  }
  private client(environmentId: string): InstanceClient {
    const environment = this.store.getEnvironment(environmentId),
      secrets = this.store.environmentSecrets(environmentId)
    if (!environment || !secrets) throw new GatewayError('INTERNAL', 'Environment secrets missing')
    return this.instance(environmentId, secrets.controlToken, environment.containerName)
  }
  private botClient(id: string): InstanceClient {
    const placement = this.store.botPlacement(id)
    if (!placement) throw new GatewayError('NOT_FOUND', 'Bot not found')
    return this.client(placement.environmentId).forBot(id, this.capable(placement.environmentId))
  }
  private async container(environment: StoredEnvironment): Promise<ContainerInfo | null> {
    try {
      return await this.docker.inspect(environment.containerName)
    } catch (error) {
      if (error instanceof DockerError && error.status === 404) return null
      throw error
    }
  }
  /** Creates an environment's container on its home volume (a restored environment finds its files there). */
  private queueProvision(environmentId: string, replaceLeftover: boolean) {
    void this.exclusive(environmentId, async () => {
      const environment = this.store.getEnvironment(environmentId)
      if (!environment || environment.archivedAt) return
      try {
        if (replaceLeftover) {
          // An archive interrupted after stopping the container may have left it behind.
          const leftover = await this.container(environment)
          if (leftover) await this.docker.remove(leftover.id, true)
        }
        await this.provision(environmentId)
      } catch (error) {
        this.failEnvironment(environmentId, error)
      }
    })
  }
  /**
   * Installs bots that joined or came back once their environment runs; a stopped environment installs them when it
   * starts, unless `bringUp` starts it for them.
   */
  private queueInstall(environmentId: string, ids: string[], bringUp: boolean) {
    void this.exclusive(environmentId, async () => {
      const environment = this.store.getEnvironment(environmentId)
      if (!environment || environment.archivedAt) return
      if (environment.lifecycle !== 'running') {
        if (bringUp)
          try {
            await this.bringUp(environment)
          } catch (error) {
            this.failEnvironment(environmentId, error)
          }
        return
      }
      await this.installInRunning(environmentId, ids)
    })
  }
  /** Installs bots in their running environment, each one failing on its own; the environment must be exclusive. */
  private async installInRunning(environmentId: string, ids: string[]) {
    const pending = ids.filter((id) => {
      const bot = this.store.getBot(id)
      return !!bot && bot.lifecycle !== 'archived'
    })
    try {
      if (await this.installMembers(environmentId, this.client(environmentId), pending, false))
        this.scheduleReconcile(environmentId, 1000)
    } catch (error) {
      for (const id of pending) if (this.store.getBot(id)?.lifecycle !== 'running') this.failBot(id, error)
    }
    for (const id of pending) if (this.get(id)?.lifecycle === 'running') this.onReady(id)
  }
  /** Brings a stopped or failed environment back: its container if it still has one, otherwise a new one. */
  private async bringUp(environment: StoredEnvironment) {
    const container = await this.container(environment)
    if (container) await this.startWithCurrentImage(environment.id, container, false, null)
    else await this.provision(environment.id)
  }
  private async provision(environmentId: string) {
    const environment = this.store.getEnvironment(environmentId)!
    if (!(await this.docker.imageInspect(this.config.botImage)))
      throw new GatewayError('IMAGE_MISSING', 'Bot image missing')
    await this.docker.ensureNetwork(this.config.network)
    // Docker returns the existing volume of a restored environment, keeping its files.
    await this.docker.volumeCreate(environment.volumeName, { [managed]: 'true', [environmentLabel]: environmentId })
    const container = await this.createContainer(environmentId)
    this.imageOutdated.set(environmentId, false)
    await this.docker.start(container)
    await this.ready(environmentId)
  }
  /**
   * The container carries its environment: bots arrive through the control API with their own token. An image from
   * before environments reads its one bot from the container instead, and refuses to start without that bot's gateway
   * token, so a bot alone in its environment (the one such an image would run) is named there too. Newer images ignore
   * these variables; they are never set in a shared environment, whose bots must not see each other's token.
   */
  private async createContainer(environmentId: string): Promise<string> {
    const environment = this.store.getEnvironment(environmentId)!,
      secrets = this.store.environmentSecrets(environmentId)!
    const active = this.store.botsOfEnvironment(environmentId),
      single = this.singleBot(environmentId)
    const sole = active.length === 1 && single?.id === active[0].id ? single : null
    const soleToken = sole ? this.store.botGatewaySecrets(sole.id)?.gatewayToken : undefined
    const env = {
      [FLEET_BOT_ENV.mode]: '1',
      [FLEET_BOT_ENV.environmentId]: environmentId,
      [FLEET_BOT_ENV.controlHost]: '0.0.0.0',
      [FLEET_BOT_ENV.controlPort]: String(FLEET_PORTS.instanceControl),
      [FLEET_BOT_ENV.controlToken]: secrets.controlToken,
      [FLEET_BOT_ENV.gatewayUrl]: this.config.internalUrl,
      ...(sole && soleToken
        ? { [FLEET_BOT_ENV.id]: sole.id, [FLEET_BOT_ENV.name]: sole.name, [FLEET_BOT_ENV.gatewayToken]: soleToken }
        : {}),
      MAESTRLY_BOT_KEYRING_PASSWORD: secrets.keyringPassword,
      TZ: this.config.timezone,
    }
    return this.docker.containerCreate({
      name: environment.containerName,
      image: this.config.botImage,
      hostname: environmentId,
      labels: { [managed]: 'true', [environmentLabel]: environmentId },
      env: Object.entries(env).map(([key, value]) => key + '=' + value),
      network: this.config.network,
      volume: environment.volumeName,
      memory: environment.memoryLimitBytes ?? this.config.botMemory,
      shmSize: this.config.botShm,
      securityOpt: this.config.botSecurityOpt,
    })
  }
  private async updateImageState(environmentId: string, container: ContainerInfo): Promise<string | null> {
    const image = await this.docker.imageInspect(this.config.botImage)
    if (!image) {
      this.imageOutdated.set(environmentId, false)
      this.logger.warn('Configured bot image missing; keeping existing container', {
        environmentId,
        image: this.config.botImage,
      })
      return null
    }
    this.imageOutdated.set(environmentId, container.imageId !== image.id)
    return image.id
  }
  private async startWithCurrentImage(
    environmentId: string,
    container: ContainerInfo,
    restart: boolean,
    via: Via
  ): Promise<boolean> {
    const imageId = await this.updateImageState(environmentId, container)
    if (imageId && container.imageId !== imageId) {
      await this.docker.stop(container.id)
      await this.docker.remove(container.id)
      this.instances.delete(environmentId)
      const replacement = await this.createContainer(environmentId)
      await this.docker.start(replacement)
      await this.ready(environmentId)
      this.imageOutdated.set(environmentId, false)
      const fromImage = container.imageId.replace(/^sha256:/, '').slice(0, 12)
      const toImage = imageId.replace(/^sha256:/, '').slice(0, 12)
      this.logger.info('Environment container updated', { environmentId, fromImage, toImage })
      this.lifecycleActivity(environmentId, via, 'restarted', { updated: true, fromImage, toImage })
      return true
    }
    if (restart) await this.docker.restart(container.id)
    else if (container.state !== 'running') await this.docker.start(container.id)
    await this.ready(environmentId)
    return false
  }
  /** Waits for the environment's desktop, then installs its bots; the environment runs once they are in place. */
  private async ready(environmentId: string) {
    this.updateEnvironment(environmentId, { lifecycle: 'starting', setup: environmentSetup('desktop') })
    const client = this.client(environmentId),
      deadline = Date.now() + this.healthTimeoutMs
    let health: { appVersion: string; capabilities: string[] } | null = null
    while (Date.now() < deadline) {
      try {
        const value = await client.health()
        if (value.ready) {
          health = { appVersion: value.appVersion, capabilities: value.capabilities }
          break
        }
      } catch {}
      await sleep(Math.min(1000, Math.max(1, deadline - Date.now())))
    }
    if (!health) throw new GatewayError('INSTANCE_UNAVAILABLE', 'Bot desktop did not become ready')
    this.instances.set(environmentId, health)
    // The desktop answers: bots still to be installed move on to their profile step.
    for (const bot of this.store.botsOfEnvironment(environmentId))
      if (bot.lifecycle !== 'running' && bot.setup.step !== 'profile')
        this.store.saveBot({ ...bot, setup: botSetup('profile'), updatedAt: now() })
    this.updateEnvironment(environmentId, { setup: environmentSetup('ready') })
    const lingering = await this.installMembers(environmentId, client, null, true)
    this.updateEnvironment(environmentId, { lifecycle: 'running' })
    for (const bot of this.store.botsOfEnvironment(environmentId))
      if (this.get(bot.id)?.lifecycle === 'running') this.onReady(bot.id)
    this.startLink(environmentId)
    if (lingering) this.scheduleReconcile(environmentId, 1000)
  }
  /**
   * Installs the environment's active bots (all of them, or those named) in the slots the gateway recorded. Bots the
   * instance still runs although the gateway archived them, or runs in another slot, leave first: a bot taking a
   * freed slot never meets the bot that held it. The instance's bots of other environments are not touched.
   *
   * An error the instance answers about one bot fails that bot only; with `strict` (the environment is starting), an
   * instance that cannot be reached, or whose status does not belong to this environment, fails the whole of it. A bot
   * that answers an error when asked to leave keeps its slot: no bot is installed there meanwhile, and the result is
   * true so that a later reconcile tries again.
   */
  private async installMembers(
    environmentId: string,
    client: InstanceClient,
    only: string[] | null,
    strict: boolean
  ): Promise<boolean> {
    if (!this.capable(environmentId)) {
      await this.installSingle(environmentId, client, only, strict)
      return false
    }
    const members = this.store.botsOfEnvironment(environmentId)
    const aggregate = await client.environmentStatus()
    if (aggregate.environmentId !== null && aggregate.environmentId !== environmentId)
      throw new GatewayError('INSTANCE_UNAVAILABLE', 'The instance belongs to another environment')
    const slots = new Map(members.map((bot) => [bot.id, this.store.botPlacement(bot.id)!.slot]))
    const moved = new Set<string>()
    // The slots bots that could not leave still hold, and the members among them with why they could not.
    const occupied = new Set<number>()
    const stuck = new Map<string, unknown>()
    for (const installed of aggregate.bots) {
      if (this.store.botPlacement(installed.botId)?.environmentId !== environmentId) continue
      const slot = slots.get(installed.botId)
      if (slot === installed.slot) continue
      try {
        await this.uninstall(client, installed.botId, false)
      } catch (error) {
        if (error instanceof InstanceUnreachableError) throw error
        occupied.add(installed.slot)
        if (slot !== undefined) stuck.set(installed.botId, error)
        this.logger.warn('A bot could not leave its display slot', {
          botId: installed.botId,
          environmentId,
          slot: installed.slot,
          failure: failureCode(error),
        })
        continue
      }
      if (slot !== undefined) moved.add(installed.botId)
    }
    for (const bot of members) {
      if (only && !only.includes(bot.id) && !moved.has(bot.id)) continue
      const slot = slots.get(bot.id)!
      if (stuck.has(bot.id)) this.failAgain(bot.id, stuck.get(bot.id))
      else if (occupied.has(slot)) this.failAgain(bot.id, new GatewayError('CONFLICT', SLOT_IN_USE))
      else await this.installOne(client, bot.id, slot, strict)
    }
    return occupied.size > 0
  }
  private async installOne(client: InstanceClient, id: string, slot: number, strict: boolean) {
    const bot = this.store.getBot(id),
      secrets = this.store.botGatewaySecrets(id)
    if (!bot || bot.lifecycle === 'archived' || !secrets) return
    const fresh = bot.lifecycle !== 'running'
    if (fresh) this.updateActive(id, { setup: botSetup('profile') })
    try {
      const status = await client.botInstall(id, {
        profile: this.profile(bot),
        slot,
        gatewayToken: secrets.gatewayToken,
        paused: bot.paused,
      })
      await this.settle(id, client.forBot(id, true), status)
      if (fresh && this.store.getBot(id)?.lifecycle === 'running') this.recordActivity(id, 'bot_started')
    } catch (error) {
      if (strict && error instanceof InstanceUnreachableError) throw error
      this.failBot(id, error)
    }
  }
  /**
   * An instance from before environments runs one bot through the routes it has always had, and keeps that bot's
   * conversation: any other bot of the environment waits for the environment to be updated.
   */
  private async installSingle(environmentId: string, client: InstanceClient, only: string[] | null, strict: boolean) {
    const bot = this.singleBot(environmentId)
    for (const other of this.store.botsOfEnvironment(environmentId))
      if (other.id !== bot?.id && (!only || only.includes(other.id)))
        this.failBot(other.id, new GatewayError('CONFLICT', RESTART_TO_ADD_BOTS))
    if (!bot) {
      if (strict) await this.holdArchivedSingle(environmentId, client)
      return
    }
    if (only && !only.includes(bot.id)) return
    const fresh = bot.lifecycle !== 'running'
    if (fresh) this.updateActive(bot.id, { setup: botSetup('profile') })
    const single = client.forBot(bot.id, false)
    try {
      const status = await single.putProfile(this.profile(bot))
      if (!status.ready) throw new GatewayError('INSTANCE_UNAVAILABLE', 'Bot desktop not ready')
      await this.settle(bot.id, single, status)
      if (fresh && this.store.getBot(bot.id)?.lifecycle === 'running') this.recordActivity(bot.id, 'bot_started')
    } catch (error) {
      if (strict && error instanceof InstanceUnreachableError) throw error
      this.failBot(bot.id, error)
    }
  }
  /**
   * An instance from before environments cannot uninstall its bot, and keeps running it once the gateway archived it:
   * before its environment counts as running, that bot is held (a pause the instance keeps across restarts). When the
   * hold cannot be confirmed, the container stops, so that an archived bot never works.
   */
  private async holdArchivedSingle(environmentId: string, client: InstanceClient) {
    const single = client.forBot(this.legacyBot(environmentId)?.id ?? environmentId, false)
    try {
      const status = await single.status().catch((error: unknown) => {
        // An instance with no bot at all has nothing to hold.
        if (error instanceof GatewayError && error.code === 'NOT_FOUND') return null
        throw error
      })
      if (!status?.profile || status.hold.state === 'held') return
      await single.hold({ reason: 'paused' })
    } catch (error) {
      this.logger.warn('Could not hold an archived bot; stopping its environment', {
        environmentId,
        failure: failureCode(error),
      })
      const environment = this.store.getEnvironment(environmentId)
      const container = environment ? await this.container(environment) : null
      if (container) await this.docker.stop(container.id)
      throw new GatewayError('INSTANCE_UNAVAILABLE', 'An archived bot could not be held')
    }
  }
  /** Brings an installed bot's hold in line with the gateway, then records it running. */
  private async settle(id: string, client: InstanceClient, installed: FleetInstanceStatus) {
    const bot = this.store.getBot(id)
    if (!bot || bot.lifecycle === 'archived') return
    let status = installed
    const release = () => client.release({ note: null, durationMs: null, continue: true })
    // A takeover or a pause the gateway no longer knows about (it restarted, or the bot was restored) is released.
    if (status.hold.reason === 'takeover' && !this.takeovers.has(id)) status = { ...status, hold: await release() }
    if (status.hold.reason === 'paused' && !bot.paused) status = { ...status, hold: await release() }
    if (bot.paused && status.hold.reason === null) status = { ...status, hold: await client.hold({ reason: 'paused' }) }
    if (this.store.getBot(id)?.lifecycle === 'archived') return
    this.updateStatus(id, status)
    this.updateActive(id, { lifecycle: 'running', setup: botSetup('ready') })
  }
  private async uninstall(client: InstanceClient, id: string, purge: boolean) {
    try {
      await client.botUninstall(id, purge)
    } catch (error) {
      if (!(error instanceof GatewayError && error.code === 'NOT_FOUND')) throw error
    }
  }
  private failBot(id: string, error: unknown) {
    const bot = this.store.getBot(id)
    if (!bot || bot.lifecycle === 'archived') return
    this.clearTakeover(id, 4002)
    this.removeStatus(id)
    const code = failureCode(error)
    this.update(id, {
      lifecycle: 'failed',
      setup: {
        step: 'failed',
        error: code,
        errorMessage: code === 'CONFLICT' && error instanceof GatewayError ? error.message : 'Bot startup failed',
      },
    })
    this.activity(id, 'bot_failed')
    this.logger.warn('Bot installation failed', { botId: id, failure: code })
  }
  /** Fails a bot unless it already failed that same way, so that a reconcile trying again stays quiet. */
  private failAgain(id: string, error: unknown) {
    const bot = this.store.getBot(id)
    const code = failureCode(error)
    const message = code === 'CONFLICT' && error instanceof GatewayError ? error.message : 'Bot startup failed'
    if (bot?.lifecycle === 'failed' && bot.setup.error === code && bot.setup.errorMessage === message) return
    this.failBot(id, error)
  }
  /** Ends every takeover and forgets every status of an environment's bots: its container stops or goes away. */
  private releaseBots(environmentId: string, code: number) {
    for (const bot of this.store.botsOfEnvironment(environmentId)) {
      this.clearTakeover(bot.id, code)
      this.removeStatus(bot.id)
    }
  }
  private failEnvironment(environmentId: string, error: unknown) {
    const environment = this.store.getEnvironment(environmentId)
    if (!environment || environment.archivedAt) return
    this.cancelReconcile(environmentId)
    this.stopLink(environmentId)
    this.releaseBots(environmentId, 4002)
    this.onCloseEnvironmentScreens(environmentId, 4002)
    const code = failureCode(error)
    this.updateEnvironment(environmentId, {
      lifecycle: 'failed',
      setup: {
        step: 'failed',
        error: code,
        errorMessage: code === 'IMAGE_MISSING' ? 'Bot image missing' : 'Bot startup failed',
      },
    })
    for (const bot of this.store.botsOfEnvironment(environmentId)) this.activity(bot.id, 'bot_failed')
    this.logger.warn('Environment startup failed', { environmentId, failure: code })
  }
  async startEnvironment(id: string, via: Via = null): Promise<FleetEnvironment> {
    this.requireEnvironment(id)
    return this.exclusive(id, async () => {
      const environment = this.requireEnvironment(id)
      if (environment.lifecycle !== 'running') {
        const container = await this.container(environment)
        if (!container)
          throw new GatewayError('NOT_FOUND', via ? 'Bot container missing' : 'Environment container missing')
        try {
          await this.startWithCurrentImage(id, container, false, via)
          this.lifecycleActivity(id, via, 'started')
        } catch (error) {
          this.failEnvironment(id, error)
        }
      }
      return this.environmentView(this.store.getEnvironment(id)!)
    })
  }
  async stopEnvironment(id: string, via: Via = null): Promise<FleetEnvironment> {
    this.requireEnvironment(id)
    return this.exclusive(id, async () => {
      this.requireEnvironment(id)
      await this.halt(id, via)
      return this.environmentView(this.store.getEnvironment(id)!)
    })
  }
  /** Stops an environment's container and every bot in it; the environment must be exclusive. */
  private async halt(id: string, via: Via) {
    const environment = this.store.getEnvironment(id)!
    this.updateEnvironment(id, { lifecycle: 'stopping' })
    this.cancelReconcile(id)
    this.stopLink(id)
    this.releaseBots(id, 4002)
    this.onCloseEnvironmentScreens(id, 4002)
    const container = await this.container(environment)
    if (container) await this.docker.stop(container.id)
    this.resources.delete(id)
    this.updateEnvironment(id, { lifecycle: 'stopped' })
    this.lifecycleActivity(id, via, 'stopped')
  }
  /** Restarts every bot of an environment, recreating its container on the configured image when it is older. */
  async restartEnvironment(id: string, via: Via = null): Promise<FleetEnvironment> {
    this.requireEnvironment(id)
    return this.exclusive(id, async () => {
      const environment = this.requireEnvironment(id)
      const container = await this.container(environment)
      if (!container)
        throw new GatewayError('NOT_FOUND', via ? 'Bot container missing' : 'Environment container missing')
      this.updateEnvironment(id, { lifecycle: 'restarting' })
      this.cancelReconcile(id)
      this.stopLink(id)
      this.releaseBots(id, 4002)
      this.onCloseEnvironmentScreens(id, 4002)
      try {
        if (!(await this.startWithCurrentImage(id, container, true, via))) this.lifecycleActivity(id, via, 'restarted')
      } catch (error) {
        this.failEnvironment(id, error)
      }
      return this.environmentView(this.store.getEnvironment(id)!)
    })
  }
  /**
   * Changes an environment's name or memory limit. A new limit reaches its container live first: when Docker refuses
   * it, the container and the record both keep the previous one.
   */
  async patchEnvironment(
    id: string,
    input: { name?: string; memoryLimitBytes?: number | null }
  ): Promise<FleetEnvironment> {
    const environment = this.requireEnvironment(id)
    const limit = input.memoryLimitBytes
    if (limit === undefined || limit === environment.memoryLimitBytes) {
      if (input.name !== undefined && input.name !== environment.name) this.updateEnvironment(id, { name: input.name })
      return this.environment(id)!
    }
    return this.exclusive(id, async () => {
      const current = this.requireEnvironment(id)
      const container = await this.container(current)
      if (container) {
        const bytes = limit ?? this.config.botMemory
        try {
          await this.docker.updateMemory(container.id, bytes)
        } catch (error) {
          if (error instanceof DockerError)
            throw new GatewayError(
              error.status >= 400 && error.status < 500 ? 'CONFLICT' : 'DOCKER_UNAVAILABLE',
              'Docker could not change the memory limit'
            )
          throw error
        }
        const measured = this.resources.get(id)
        if (measured) this.resources.set(id, { ...measured, memoryLimitBytes: bytes })
      }
      this.updateEnvironment(id, { name: input.name, memoryLimitBytes: limit })
      return this.environment(id)!
    })
  }
  /**
   * Removes an environment's container and archives it with its active bots; its home volume and records stay, and
   * restoring it brings those bots back.
   */
  async archiveEnvironment(id: string): Promise<FleetEnvironment> {
    this.requireEnvironment(id)
    return this.exclusive(id, async () => {
      const environment = this.requireEnvironment(id)
      const container = await this.container(environment)
      this.cancelReconcile(id)
      this.stopLink(id)
      this.releaseBots(id, 4002)
      this.onCloseEnvironmentScreens(id, 4002)
      if (container) {
        await this.docker.stop(container.id)
        await this.docker.remove(container.id, true)
      }
      this.resources.delete(id)
      this.imageOutdated.delete(id)
      this.instances.delete(id)
      const members = this.store.botsOfEnvironment(id)
      const botIds = this.store.transaction(() => {
        const archived = this.store.archiveEnvironment(id)
        for (const botId of archived) this.syncPeers(botId, [])
        return archived
      })
      for (const peerId of new Set(members.flatMap((bot) => bot.talksTo))) this.emitBot(peerId)
      for (const botId of botIds) this.onEvent({ type: 'bot.removed', at: now(), botId })
      this.recordEnvironmentActivity(id, 'environment_archived')
      this.onEvent({ type: 'environment.removed', at: now(), environmentId: id })
      return this.environmentView(this.store.getEnvironment(id)!)
    })
  }
  async archivedEnvironments(): Promise<FleetArchivedEnvironment[]> {
    const archived = this.store
      .archivedEnvironments()
      .filter((environment) => !this.deletingEnvironments.has(environment.id))
    return Promise.all(
      archived.map(async (environment) => ({
        id: environment.id,
        name: environment.name,
        createdAt: environment.createdAt,
        archivedAt: environment.archivedAt!,
        files: (await this.docker.volumeExists(environment.volumeName)) ? ('kept' as const) : ('missing' as const),
        bots: this.store
          .botsOfEnvironment(environment.id, true)
          .map((bot) => ({ id: bot.id, name: bot.name, role: bot.role, tint: bot.tint })),
      }))
    )
  }
  /**
   * Brings an archived environment back in a new container on its kept home volume, with the bots archived along with
   * it (bots archived on their own before stay archived). The environment leaves `archived` before any await, so a
   * second request fails instead of racing the first.
   */
  restoreEnvironment(id: string): { environment: FleetEnvironment; botIds: string[] } {
    const environment = this.store.getEnvironment(id)
    if (!environment?.archivedAt || this.deletingEnvironments.has(id))
      throw new GatewayError('NOT_FOUND', 'Archived environment not found')
    const peers = new Set<string>()
    const botIds = this.store.transaction(() => {
      const restored = this.store.restoreEnvironment(id)
      for (const botId of restored) {
        const talksTo = this.activePeers(this.store.getBot(botId)!)
        this.update(botId, { talksTo })
        this.syncPeers(botId, talksTo)
        for (const peerId of talksTo) peers.add(peerId)
      }
      return restored
    })
    for (const peerId of peers) this.emitBot(peerId)
    this.recordEnvironmentActivity(id, 'environment_restored')
    this.emitEnvironment(id)
    this.queueProvision(id, true)
    return { environment: this.environment(id)!, botIds }
  }
  /** Irreversible: removes an archived environment's container if any, its home volume, and every record of it. */
  async purgeEnvironment(id: string): Promise<void> {
    const environment = this.store.getEnvironment(id)
    if (!environment?.archivedAt || this.deletingEnvironments.has(id))
      throw new GatewayError('NOT_FOUND', 'Archived environment not found')
    this.deletingEnvironments.add(id)
    let removed: { botIds: string[]; ownerMemoriesDeleted: number }
    try {
      removed = await this.exclusive(id, async () => {
        // Files first: if this fails, the records remain and deleting again finishes the job.
        await this.removeFiles(environment, 'environment')
        return this.store.purgeEnvironment(id)
      })
    } finally {
      this.deletingEnvironments.delete(id)
    }
    for (const botId of removed.botIds) this.pendingSeen.delete(botId)
    this.forgetEnvironment(id)
    if (removed.ownerMemoriesDeleted)
      this.onEvent({ type: 'owner_memory.updated', at: now(), revision: this.store.ownerMemoryRevision() })
    this.recordEnvironmentActivity(id, 'environment_deleted', {}, environment.name)
    this.onEvent({ type: 'environment.removed', at: now(), environmentId: id })
  }
  private async removeFiles(environment: StoredEnvironment, subject: 'bot' | 'environment') {
    const leftover = await this.container(environment)
    if (leftover) await this.docker.remove(leftover.id, true)
    try {
      await this.docker.volumeRemove(environment.volumeName)
    } catch (error) {
      if (error instanceof DockerError)
        throw new GatewayError(
          error.status === 409 ? 'CONFLICT' : 'DOCKER_UNAVAILABLE',
          error.status === 409
            ? `The ${subject} files are still in use`
            : `Docker could not remove the ${subject} files`
        )
      throw error
    }
  }
  private forgetEnvironment(id: string) {
    this.cancelReconcile(id)
    this.stopLink(id)
    this.resources.delete(id)
    this.imageOutdated.delete(id)
    this.instances.delete(id)
  }
  private activeEnvironment(id: string): string {
    const bot = this.store.getBot(id)
    if (!bot || bot.lifecycle === 'archived') throw new GatewayError('NOT_FOUND', 'Bot not found')
    return this.store.botPlacement(id)!.environmentId
  }
  /** A bot's own start, stop and restart act on its environment, which only a bot alone in it may do. */
  private soleEnvironment(id: string): string {
    const environmentId = this.activeEnvironment(id)
    if (this.store.botsOfEnvironment(environmentId).length > 1) throw new GatewayError('CONFLICT', SHARED_ENVIRONMENT)
    return environmentId
  }
  /**
   * In a running environment, a bot that is not running (its installation failed) is installed again, alone, even
   * when it shares the environment. Otherwise the bot starts its environment.
   */
  async start(id: string): Promise<FleetBot> {
    const environmentId = this.activeEnvironment(id)
    const installed = await this.exclusive(environmentId, async () => {
      const environment = this.store.getEnvironment(environmentId),
        bot = this.store.getBot(id)
      if (environment?.archivedAt || environment?.lifecycle !== 'running') return false
      if (!bot || bot.lifecycle === 'archived' || bot.lifecycle === 'running') return false
      await this.installInRunning(environmentId, [id])
      return true
    })
    if (!installed) await this.startEnvironment(this.soleEnvironment(id), { botId: id })
    return this.get(id)!
  }
  async stop(id: string): Promise<FleetBot> {
    await this.stopEnvironment(this.soleEnvironment(id), { botId: id })
    return this.get(id)!
  }
  async restart(id: string): Promise<FleetBot> {
    await this.restartEnvironment(this.soleEnvironment(id), { botId: id })
    return this.get(id)!
  }
  /**
   * Archives one bot: its environment's instance uninstalls it and keeps its data, its slot becomes free and its
   * records stay. Its siblings keep running.
   */
  async archive(id: string): Promise<FleetBot> {
    const bot = this.get(id)
    if (!bot || bot.lifecycle === 'archived') throw new GatewayError('NOT_FOUND', 'Bot not found')
    const environmentId = bot.environmentId!
    this.clearTakeover(id, 4002)
    this.removeStatus(id)
    this.store.transaction(() => {
      this.store.archiveBot(id)
      this.syncPeers(id, [])
    })
    for (const peerId of bot.talksTo) this.emitBot(peerId)
    this.activity(id, 'bot_archived')
    this.onEvent({ type: 'bot.removed', at: now(), botId: id })
    this.emitEnvironment(environmentId, false)
    await this.exclusive(environmentId, async () => {
      const environment = this.store.getEnvironment(environmentId)
      // A stopped environment's instance uninstalls, or holds, the bot when it next starts.
      if (environment?.lifecycle !== 'running' || this.store.getBot(id)?.lifecycle !== 'archived') return
      const capable = this.environmentCapable(environmentId)
      if (capable === null) {
        // Its instance is not known yet: the reconcile due for it uninstalls, or holds, the bot.
        this.scheduleReconcile(environmentId, 1000)
        return
      }
      const client = this.client(environmentId)
      if (!capable) {
        // Only the environment's first bot runs on an instance from before environments; the others wait for it.
        if (this.legacyBot(environmentId)?.id !== id) return
        // Such an instance cannot uninstall its one bot, and hosts no other: the bot is held (it stays held across
        // restarts), then the environment stops, so that it cannot work even when the hold fails.
        await client
          .forBot(id, false)
          .hold({ reason: 'paused' })
          .catch(() => this.logger.warn('Could not hold an archived bot', { botId: id, environmentId }))
        await this.halt(environmentId, null)
        return
      }
      try {
        await this.uninstall(client, id, false)
      } catch {
        this.logger.warn('An archived bot is still installed; it leaves when its environment is reconciled', {
          botId: id,
          environmentId,
        })
        this.scheduleReconcile(environmentId, 1000)
      }
    })
    return this.get(id)!
  }
  private requireArchived(id: string): FleetBot {
    const bot = this.store.getBot(id)
    if (bot?.lifecycle !== 'archived' || this.deleting.has(id))
      throw new GatewayError('NOT_FOUND', 'Archived bot not found')
    return bot
  }
  /** Bots archived on their own in an active environment; the bots of archived environments are listed with them. */
  async archivedList(): Promise<FleetArchivedBot[]> {
    const archived = this.store.archivedBots().flatMap((record) => {
      const environment = record.bot.environmentId ? this.store.getEnvironment(record.bot.environmentId) : null
      return environment && !environment.archivedAt && !this.deleting.has(record.bot.id)
        ? [{ ...record, environment }]
        : []
    })
    return Promise.all(
      archived.map(async ({ bot, archivedAt, environment }) => ({
        id: bot.id,
        name: bot.name,
        role: bot.role,
        tint: bot.tint,
        createdAt: bot.createdAt,
        archivedAt,
        files: (await this.docker.volumeExists(environment.volumeName)) ? ('kept' as const) : ('missing' as const),
        environmentId: environment.id,
      }))
    )
  }
  /**
   * Brings an archived bot back into its environment, talking again to the peers still active: in its previous slot if
   * free, otherwise the lowest free one. It is installed at once when its environment runs; a bot alone in a stopped
   * environment brings the environment back with it. The bot leaves `archived` before any await, so a second request
   * fails instead of racing the first.
   */
  restore(id: string): FleetBot {
    const bot = this.requireArchived(id)
    const environmentId = this.store.botPlacement(id)!.environmentId
    const environment = this.store.getEnvironment(environmentId)
    if (!environment || environment.archivedAt || this.deletingEnvironments.has(environmentId))
      throw new GatewayError('CONFLICT', RESTORE_ENVIRONMENT_FIRST)
    this.requireSingleBotRoom(environmentId, id)
    const talksTo = this.activePeers(bot)
    this.store.transaction(() => {
      this.store.restoreBot(id)
      this.update(id, { talksTo })
      this.syncPeers(id, talksTo)
    })
    for (const peerId of talksTo) this.emitBot(peerId)
    this.activity(id, 'bot_restored')
    const bringUp =
      (environment.lifecycle === 'stopped' || environment.lifecycle === 'failed') &&
      this.store.botsOfEnvironment(environmentId).length === 1
    if (bringUp)
      this.updateEnvironment(environmentId, {
        lifecycle: 'creating',
        ...(environment.setup.step === 'failed' ? { setup: environmentSetup('container') } : {}),
      })
    else this.emitEnvironment(environmentId, false)
    this.queueInstall(environmentId, [id], bringUp)
    return this.get(id)!
  }
  /**
   * Irreversible: its running environment's instance deletes the bot's conversation, memory space and folders, then
   * every gateway record of the bot goes. A bot from before environments, alone in its environment's files, goes
   * with those files, as it did when it was its own container.
   */
  async purge(id: string): Promise<void> {
    const bot = this.requireArchived(id)
    const environmentId = this.store.botPlacement(id)!.environmentId
    const environment = this.store.getEnvironment(environmentId)
    if (!environment || environment.archivedAt || this.deletingEnvironments.has(environmentId))
      throw new GatewayError('CONFLICT', RESTORE_ENVIRONMENT_FIRST)
    this.deleting.add(id)
    let whole: boolean
    try {
      whole = await this.exclusive(environmentId, async () => {
        const current = this.store.getEnvironment(environmentId)
        if (!current || current.archivedAt) throw new GatewayError('CONFLICT', RESTORE_ENVIRONMENT_FIRST)
        if (current.lifecycle === 'running' && this.capable(environmentId)) {
          await this.uninstall(this.client(environmentId), id, true)
          this.store.purgeBot(id)
          return false
        }
        if (
          this.environmentCapable(environmentId) === false &&
          this.store.botsOfEnvironment(environmentId, true).length === 1
        ) {
          await this.removeFiles(current, 'bot')
          this.store.deleteBot(id)
          return true
        }
        throw new GatewayError('CONFLICT', START_ENVIRONMENT_FIRST)
      })
    } finally {
      this.deleting.delete(id)
    }
    this.pendingSeen.delete(id)
    if (whole) {
      this.forgetEnvironment(environmentId)
      this.recordActivity(null, 'bot_deleted', bot.name)
      this.onEvent({ type: 'environment.removed', at: now(), environmentId })
    } else {
      const entry = this.store.addActivity(null, 'bot_deleted', bot.name, {}, environmentId)
      this.onEvent({ type: 'activity', at: entry.at, entry })
      this.emitEnvironment(environmentId, false)
    }
  }
  async pause(id: string): Promise<FleetBot> {
    const bot = this.get(id)
    if (!bot || bot.lifecycle === 'archived') throw new GatewayError('NOT_FOUND', 'Bot not found')
    if (bot.lifecycle === 'running') {
      const hold = await this.botClient(id).hold({ reason: 'paused' })
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
      const hold = await this.botClient(id).release({ note: null, durationMs: null, continue: true })
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
    if (bot.lifecycle === 'running') {
      const environmentId = bot.environmentId!
      await this.exclusive(environmentId, async () => {
        const current = this.get(id)
        if (current?.lifecycle !== 'running') return
        const next = this.profile({ ...current, ...input })
        const status = this.capable(environmentId)
          ? await this.client(environmentId).botInstall(id, {
              profile: next,
              slot: this.store.botPlacement(id)!.slot,
              gatewayToken: this.store.botGatewaySecrets(id)!.gatewayToken,
            })
          : await this.botClient(id).putProfile(next)
        this.updateStatus(id, status)
      })
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
    return this.botClient(id)
  }
  /** The environment's own API (accounts, skills, MCP servers, sign-ins, its settings window) while it runs. */
  environmentInstance(id: string): InstanceClient {
    const environment = this.requireEnvironment(id)
    if (environment.lifecycle !== 'running') throw new GatewayError('BOT_NOT_RUNNING', 'Environment not running')
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
    const client = this.instanceFor(id)
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
      const hold = await client.hold({ reason: 'takeover' })
      if (this.store.deviceRevoked(deviceId)) {
        await client.release({ note: null, durationMs: null, continue: true })
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
  /**
   * Matches the recorded environments with their containers, found by their environment label or, for containers
   * from before environments, their bot label; running ones get their bots installed again.
   */
  async reconcile() {
    const containers = await this.docker.list(managed + '=true')
    const found = new Map<string, ContainerInfo>()
    for (const container of containers) {
      const id = container.labels[environmentLabel] ?? container.labels[legacyBotLabel]
      if (!id) continue
      // Two containers for one environment: the one with its recorded name wins.
      if (!found.has(id) || container.name === this.store.getEnvironment(id)?.containerName) found.set(id, container)
    }
    const currentImage = await this.docker.imageInspect(this.config.botImage)
    for (const environment of this.store.listEnvironments()) {
      const id = environment.id,
        container = found.get(id)
      if (!container) {
        this.imageOutdated.delete(id)
        this.updateEnvironment(id, { lifecycle: environment.lifecycle === 'creating' ? 'failed' : 'stopped' })
        continue
      }
      this.imageOutdated.set(id, Boolean(currentImage && container.imageId !== currentImage.id))
      if (this.imageOutdated.get(id))
        this.logger.info('Environment container uses an older image; restart to update', { environmentId: id })
      if (container.state === 'running') {
        try {
          if (await this.exclusive(id, () => this.reconcileEnvironment(id))) this.scheduleReconcile(id, 1000)
        } catch {
          this.updateEnvironment(id, { lifecycle: 'starting' })
          this.scheduleReconcile(id, 1000)
        }
      } else this.updateEnvironment(id, { lifecycle: 'stopped' })
    }
  }
  /** Installs a running environment's bots again; true when a bot that had to leave its slot could not. */
  private async reconcileEnvironment(id: string): Promise<boolean> {
    const client = this.client(id)
    const health = await client.health()
    if (!health.ready) throw new GatewayError('INSTANCE_UNAVAILABLE', 'Bot desktop not ready')
    this.instances.set(id, { appVersion: health.appVersion, capabilities: health.capabilities })
    const lingering = await this.installMembers(id, client, null, true)
    this.updateEnvironment(id, { lifecycle: 'running', setup: environmentSetup('ready') })
    for (const bot of this.store.botsOfEnvironment(id))
      if (this.get(bot.id)?.lifecycle === 'running') this.onReady(bot.id)
    this.startLink(id)
    return lingering
  }
  private cancelReconcile(environmentId: string) {
    const timer = this.reconcileTimers.get(environmentId)
    if (timer) clearTimeout(timer)
    this.reconcileTimers.delete(environmentId)
  }
  private scheduleReconcile(environmentId: string, delay: number) {
    if (this.reconcileTimers.has(environmentId)) return
    const timer = setTimeout(() => {
      this.reconcileTimers.delete(environmentId)
      void this.exclusive(environmentId, async () => {
        const environment = this.store.getEnvironment(environmentId)
        if (!environment || environment.archivedAt) return
        const container = await this.container(environment)
        if (container?.state !== 'running') {
          this.updateEnvironment(environmentId, { lifecycle: 'stopped' })
          return
        }
        // A bot still holding a slot it had to leave is tried again, less often each time.
        if (await this.reconcileEnvironment(environmentId))
          throw new GatewayError('INSTANCE_UNAVAILABLE', 'A bot could not leave its display slot')
      }).catch(() => this.scheduleReconcile(environmentId, Math.min(delay * 2, 30000)))
    }, delay)
    timer.unref()
    this.reconcileTimers.set(environmentId, timer)
  }
  close() {
    for (const timer of this.reconcileTimers.values()) clearTimeout(timer)
    this.reconcileTimers.clear()
    for (const id of [...this.links.keys()]) this.stopLink(id)
    for (const timer of this.controllerTimers.values()) clearTimeout(timer)
    this.controllerTimers.clear()
  }
  /** Measures each running environment's container; a bot alone in its environment reports the figures too. */
  async refreshStats() {
    for (const environment of this.store.listEnvironments()) {
      if (environment.lifecycle !== 'running') continue
      try {
        const container = await this.container(environment)
        if (!container) continue
        this.resources.set(environment.id, {
          ...(await this.docker.statsOnce(container.id)),
          startedAt: container.startedAt,
        })
        this.emitEnvironment(environment.id, this.store.botsOfEnvironment(environment.id).length === 1)
      } catch {}
    }
  }
}
