import { randomUUID } from 'node:crypto'
import {
  type FleetChatAttentionKind,
  deriveBotId,
  fleetBotBlocksUpdate,
  FLEET_BOT_ENV,
  FLEET_BOT_MOVE_FEATURE,
  FLEET_ROUTINE_RUN_SETTINGS_DEFAULT,
  FLEET_PEER_THREAD_SETTINGS_DEFAULT,
  type FleetBotMove,
  type FleetBotMoveRequest,
  FLEET_ENVIRONMENT_COMPACTION_FEATURE,
  FLEET_ENVIRONMENT_LIMITS,
  FLEET_ENVIRONMENT_SETTINGS_FEATURE,
  FLEET_ENVIRONMENTS_FEATURE,
  FLEET_PORTS,
  FLEET_WORKSPACES_HOST_FEATURE,
  type FleetActivityEntry,
  type FleetRoutineRunMedia,
  type FleetArchivedBot,
  type FleetArchivedEnvironment,
  type FleetBot,
  type FleetBotSetup,
  type FleetCompactionConfig,
  type FleetCreateBotRequest,
  type FleetEnvironment,
  type FleetEnvironmentIsolation,
  type FleetEnvironmentKind,
  type FleetEnvironmentSetup,
  type FleetHostFolderMode,
  type FleetRuntimeInfo,
  type FleetErrorCode,
  type FleetGatewayEvent,
  type FleetInstanceEnvironmentStatus,
  type FleetInstanceEvent,
  type FleetInstanceProfile,
  type FleetInstanceStatus,
  type FleetInstanceTurn,
  type FleetBotTurn,
  fleetInstanceTurns,
  type FleetLifecycle,
  type FleetPatchBotRequest,
  type FleetResources,
  type FleetSelectionsResponse,
  type FleetTakeoverState,
} from '@maestrly/bot-fleet-protocol'
import { token, sha256 } from './auth.js'
import type { GatewayConfig } from './config.js'
import {
  type CgroupMemory,
  type ContainerInfo,
  DockerError,
  type DockerDriver,
  type ContainerStats,
  NO_CGROUP_MEMORY,
} from './docker.js'
import { GatewayError } from './errors.js'
import { findGatewayContainer, gatewayAlias } from './gateway-container.js'
import { InstanceClient, InstanceUnreachableError, relayBotPackage } from './instance.js'
import { Logger } from './logger.js'
import type { EnvironmentChanges, Store, StoredBotMove, StoredEnvironment } from './store.js'

const tints = ['#4978c6', '#9b65b6', '#d47754', '#4c9a87', '#c29a43', '#6379a5']
const managed = 'org.maestrly.fleet.managed'
const environmentLabel = 'org.maestrly.fleet.environment-id'
const egressLabel = 'org.maestrly.fleet.egress'
/** The server folder a workspaces environment's container was created with; empty when none. */
const workspacesRootLabel = 'org.maestrly.fleet.workspaces-root'
/** The network a workspaces environment's container was created on; absent on those from before networks of their own. */
const networkLabel = 'org.maestrly.fleet.network'
/** Marks the short-lived containers the gateway runs for a task of its own: never an environment's. */
const helperLabel = 'org.maestrly.fleet.helper'
/** Set on a workspaces environment's container created with the token it publishes artifacts with. */
const hostTokenLabel = 'org.maestrly.fleet.host-token'
/** Shown on a workspaces environment whose container runs an image from before workspaces hosts. */
const WORKSPACES_UNSUPPORTED = 'This bot image cannot host workspaces. Update the server.'
const HOST_FOLDER_FAILED = 'The folder of this environment could not be created on the server.'
const NETWORK_FAILED = 'Docker could not create the network of this environment.'
const GATEWAY_NOT_ATTACHED = 'The gateway could not join the network of this environment.'
/** Failures shown to the owner as they are: fixed texts that say what to look at. */
const SHOWN_FAILURES = new Set([WORKSPACES_UNSUPPORTED, HOST_FOLDER_FAILED, NETWORK_FAILED, GATEWAY_NOT_ATTACHED])
export const WORKSPACES_LIMIT = 'This server already hosts as many workspaces environments as it can.'
export const WORKSPACES_ONLY = 'Only a workspaces environment has this setting.'
const runtimeUpdatesLabel = 'org.maestrly.fleet.runtime-updates'
const botBrowserLabel = 'org.maestrly.fleet.bot-browser'
/** The label of containers created before environments: their bot's id, which their environment took over. */
const legacyBotLabel = 'org.maestrly.fleet.bot-id'
const now = () => new Date().toISOString()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/** The container and home volume of an environment created with environments; migrated ones keep their bot's names. */
export const environmentContainerName = (id: string) => 'maestrly-env-' + id
export const environmentVolumeName = (id: string) => environmentContainerName(id) + '-home'
export const RESTART_TO_ADD_BOTS = 'Restart this environment to update it before adding bots.'
export const RESTART_TO_CHOOSE_COMPACTION =
  'Restart this environment to update it before choosing its compaction model.'
export const SHARED_ENVIRONMENT = 'This bot shares its environment. Restart the environment instead.'
export const RESTART_TO_RESTART_BOT = 'Restart this environment to update it before restarting one of its bots.'
export const RESTORE_ENVIRONMENT_FIRST = 'Restore its environment first'
export const START_ENVIRONMENT_FIRST = 'Start its environment first'
export const SLOT_IN_USE = 'Its display slot is still in use. Start the bot again to retry.'
export const BOT_MOVING = 'This bot is moving to another environment.'
export const MOVE_NEEDS_UPDATE = 'Restart both environments to update them before moving bots between them.'
export const MOVE_NEEDS_SAME_VERSION = 'Update both environments to the same version before moving the bot.'
export const MOVE_NEEDS_RUNNING = 'Start both environments before moving the bot.'
export const MOVE_NEEDS_SCREEN = 'Give back the screen before moving the bot.'
export const MOVE_DIFFERS = 'The bot arrived different from how it left. It stays where it was.'
export const MOVE_INTERRUPTED = 'The server restarted during the move. The bot stays where it was.'
const botSetup = (step: FleetBotSetup['step']): FleetBotSetup => ({ step, error: null, errorMessage: null })
const environmentSetup = (step: FleetEnvironmentSetup['step']): FleetEnvironmentSetup => ({
  step,
  error: null,
  errorMessage: null,
})
/**
 * How long a bot restarting on its own may take to leave its environment: its turns stop, its conversations' processes
 * end and its browser, which may be the very thing that hangs, is killed once it does not exit.
 */
const BOT_RESTART_UNINSTALL_MS = 60_000
const botKinds = { started: 'bot_started', stopped: 'bot_stopped', restarted: 'bot_restarted' } as const
const environmentKinds = {
  started: 'environment_started',
  stopped: 'environment_stopped',
  restarted: 'environment_restarted',
} as const
const sameCompaction = (a: FleetCompactionConfig | null, b: FleetCompactionConfig | null) =>
  a === b ||
  (!!a &&
    !!b &&
    a.providerId === b.providerId &&
    a.modelId === b.modelId &&
    a.reasoning === b.reasoning &&
    a.fastMode === b.fastMode &&
    a.intervalTokens === b.intervalTokens &&
    // Configs stored before the limit have none: absent and null both mean the model's window.
    (a.contextLimitTokens ?? null) === (b.contextLimitTokens ?? null))
function failureCode(error: unknown): FleetErrorCode {
  if (error instanceof GatewayError) return error.code
  return error instanceof DockerError && error.status === 404 ? 'IMAGE_MISSING' : 'DOCKER_UNAVAILABLE'
}
export type InstanceFactory = (environmentId: string, token: string, host: string) => InstanceClient
type Resources = ContainerStats & CgroupMemory & { startedAt: string | null }
const resourcesView = (resources: Resources | undefined): FleetResources => ({
  memoryBytes: resources?.memoryBytes ?? null,
  memoryLimitBytes: resources?.memoryLimitBytes ?? null,
  cpuPercent: resources?.cpuPercent ?? null,
  startedAt: resources?.startedAt ?? null,
  swapBytes: resources?.swapBytes ?? null,
  oomKills: resources?.oomKills ?? null,
  limitOoms: resources?.limitOoms ?? null,
})
/** The bot whose own start, stop or restart acted on its environment: the activity is then recorded as the bot's. */
type Via = { botId: string } | null
export class Lifecycle {
  readonly statuses = new Map<string, FleetInstanceStatus>()
  /** Container measurements, by environment. */
  readonly resources = new Map<string, Resources>()
  /** Whether an environment's container runs an older image than the configured one, by environment. */
  readonly imageOutdated = new Map<string, boolean>()
  readonly takeovers = new Map<string, FleetTakeoverState>()
  /**
   * What each environment's Maestrly reported at its last health check, and the runtimes its bots last reported (the
   * same for every bot of an environment; null until one reports them).
   */
  private readonly instances = new Map<
    string,
    {
      appVersion: string
      capabilities: string[]
      runtimes: FleetRuntimeInfo[] | null
      additionalRuntimes?: FleetRuntimeInfo[]
    }
  >()
  /** Whether each workspaces environment had chat turns running at its last health check. */
  private readonly hostBusy = new Map<string, boolean>()
  /** One event stream per environment, fanned out to its bots. */
  private readonly links = new Map<string, AbortController>()
  private readonly pendingSeen = new Map<string, Set<string>>()
  private readonly reconcileTimers = new Map<string, NodeJS.Timeout>()
  private readonly controllerTimers = new Map<string, NodeJS.Timeout>()
  private readonly locks = new Map<string, Promise<void>>()
  /** Archived bots and environments being deleted forever: neither listed nor restorable meanwhile. */
  private readonly deleting = new Set<string>()
  private readonly deletingEnvironments = new Set<string>()
  /** Updates being applied, by environment: a status arriving meanwhile waits for the same one instead of a second. */
  private readonly draining = new Map<string, Promise<void>>()
  /** Bots restarting on their own in their running environment: devices see them restarting meanwhile. */
  private readonly restartingBots = new Set<string>()
  /** Checks waiting updates while any exists: a bot may go idle without a status event reaching the gateway. */
  private updateTimer: NodeJS.Timeout | null = null
  /** Checks idle workspaces environments while any has an idle stop. */
  private idleTimer: NodeJS.Timeout | null = null
  /** When each running environment with an idle stop was last seen in use, by environment. */
  private readonly lastUsed = new Map<string, number>()
  /** The network and server folder each environment's container was created with, from its labels. */
  private readonly applied = new Map<string, { network: string; folder: string }>()
  /** The gateway's own container, once found. */
  private gatewayContainerId: string | null = null
  private readonly logger = new Logger()
  /** Finds the gateway's own container, which joins each workspaces environment's network. */
  locateGateway: () => Promise<string | null> = () =>
    findGatewayContainer(this.docker, this.config.network, this.config.gatewayContainer)
  /** A workspaces environment's network was created or removed: the gateway's network boundary reads them again. */
  onNetworksChanged: () => void = () => {}
  /** How many bridges, editor connections and file transfers devices hold open to an environment now. */
  hostConnections: (environmentId: string) => number = () => 0
  onCloseScreens: (id: string, code: number, mode?: 'control') => void = () => {}
  onCloseEnvironmentScreens: (environmentId: string, code: number) => void = () => {}
  /** Closes the bridges computers hold to a workspaces environment: its container stops or goes away. */
  onCloseEnvironmentBridges: (environmentId: string) => void = () => {}
  /**
   * An environment's lifecycle changed, or it was archived, restored or deleted: bots' calls to it follow. A deleted
   * one names the bots whose links to it went with it.
   */
  onEnvironmentChanged: (environmentId: string, formerlyLinked?: string[]) => void = () => {}
  controlCount: (id: string) => number = () => 0
  artifactsEnabled: () => boolean = () => false
  onReady: (id: string) => void = () => {}
  /** A bot and every record of it are gone for good: whatever still points at it (desktop links, calls) goes too. */
  onBotPurged: (id: string) => void = () => {}
  /** A turn ended: answers what the turn's activity should say of the routine run it belonged to, if any. */
  onTurnFinished?: (
    botId: string,
    event: {
      outcome: 'completed' | 'cancelled' | 'failed'
      inputId: string | null
      text: string | null
      runId?: string | null
      media?: FleetRoutineRunMedia | null
    }
  ) => FleetActivityEntry['data'] | void
  onEvent: (event: FleetGatewayEvent) => void = () => {}
  /**
   * A turn started or ended in some of the bot's side conversations, as its status says. An instance tells a turn
   * finished before its status drops it, so what is told of those conversations then must be told again now.
   */
  onTurnRunsChanged: (botId: string, runIds: string[]) => void = () => {}
  /** A chat of the workspaces host needs the owner (`chat.attention`). */
  onChatAttention?: (environmentId: string, conversationId: string, name: string, kind: FleetChatAttentionKind) => void
  constructor(
    readonly store: Store,
    readonly docker: DockerDriver,
    readonly config: GatewayConfig,
    readonly instance: InstanceFactory = (id, secret, host) =>
      new InstanceClient(id, secret, 'http://' + host + ':' + FLEET_PORTS.instanceControl),
    readonly healthTimeoutMs = 240000,
    readonly controllerLostMs = 300000,
    readonly updateCheckMs = 30000,
    readonly idleCheckMs = 60000
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
  /** Tells devices a bot changed outside its record's fields, such as its routine runs' settings. */
  botChanged(id: string) {
    this.emitBot(id)
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
    const formerRuns = this.turnRuns(this.statuses.get(id))
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
    this.turnRunsChanged(id, formerRuns, this.turnRuns(status))
    this.updateRuntimes(id, status)
    if (JSON.stringify(this.inbox()) !== before) this.onEvent({ type: 'inbox.updated', at: now(), items: this.inbox() })
    if (status.ready && this.get(id)?.lifecycle === 'running') this.onReady(id)
    const environmentId = this.store.getBot(id)?.environmentId
    if (environmentId && this.store.getEnvironment(environmentId)?.updateRequestedAt)
      void this.maybeUpdate(environmentId)
  }
  /** A status with runtimes updates its environment's; devices hear of it only when they changed. */
  private updateRuntimes(id: string, status: FleetInstanceStatus) {
    if (!status.runtimes && !status.additionalRuntimes) return
    const environmentId = this.store.getBot(id)?.environmentId
    const instance = environmentId ? this.instances.get(environmentId) : undefined
    if (!environmentId || !instance) return
    const runtimes = status.runtimes ?? instance.runtimes
    const additionalRuntimes = status.additionalRuntimes ?? instance.additionalRuntimes
    if (
      JSON.stringify(instance.runtimes) === JSON.stringify(runtimes) &&
      JSON.stringify(instance.additionalRuntimes) === JSON.stringify(additionalRuntimes)
    )
      return
    instance.runtimes = runtimes
    instance.additionalRuntimes = additionalRuntimes
    this.emitEnvironment(environmentId, false)
  }
  private stopLink(environmentId: string) {
    this.links.get(environmentId)?.abort()
    this.links.delete(environmentId)
  }
  private removeStatus(id: string) {
    const before = JSON.stringify(this.inbox())
    const formerRuns = this.turnRuns(this.statuses.get(id))
    this.statuses.delete(id)
    if (JSON.stringify(this.inbox()) !== before) this.onEvent({ type: 'inbox.updated', at: now(), items: this.inbox() })
    this.turnRunsChanged(id, formerRuns, new Set())
  }
  /** The side conversations (runs and threads) the bot has a turn in. */
  private turnRuns(status: FleetInstanceStatus | undefined): Set<string> {
    if (!status) return new Set()
    return new Set(fleetInstanceTurns(status).flatMap((turn) => (turn.runId ? [turn.runId] : [])))
  }
  private turnRunsChanged(id: string, before: ReadonlySet<string>, after: ReadonlySet<string>) {
    const changed = [...before, ...after].filter((runId) => before.has(runId) !== after.has(runId))
    if (changed.length) this.onTurnRunsChanged(id, changed)
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
      // Once the stream broke, the instance may have restarted, and one whose new sequence already passed the cursor
      // sends no reset: its bots are checked before the stream is followed again, still from the cursor, which replays
      // what an instance that did not restart sent meanwhile.
      let broken = false
      while (!controller.signal.aborted) {
        try {
          const client = this.client(environmentId)
          if (broken && this.capable(environmentId))
            await client.environmentStatus().then(
              (aggregate) => this.recoverMembers(environmentId, aggregate, controller.signal),
              () => {}
            )
          for await (const event of client.events(since, controller.signal)) {
            // A run's own reset says only that run's transcript changed.
            if ((event.type === 'reset' && !event.runId) || event.seq <= since) {
              since = await this.refreshStatuses(environmentId, client, event.seq, controller.signal)
              continue
            }
            since = event.seq
            delay = 1000
            this.dispatch(environmentId, event)
          }
        } catch {}
        broken = true
        if (!controller.signal.aborted) {
          await sleep(delay)
          delay = Math.min(delay * 2, 30000)
        }
      }
    })()
  }
  private dispatch(environmentId: string, event: FleetInstanceEvent) {
    // A workspaces host's chats are not bots: what they need goes to the owner's phones.
    if (event.type === 'chat.attention') {
      if (this.store.getEnvironment(environmentId)?.kind === 'workspaces')
        this.onChatAttention?.(environmentId, event.conversationId, event.name, event.kind)
      return
    }
    const id = this.eventBot(environmentId, event.botId)
    if (!id) return
    if (event.type === 'status') this.updateStatus(id, event.status)
    else if (event.type === 'transcript.upsert')
      this.onEvent(
        // A side conversation's item is a thread's (`peer-conversations`) or a routine run's.
        event.runId
          ? this.store.peerThreadSide(event.runId, id)
            ? { type: 'peer_thread.transcript.upsert', at: now(), botId: id, threadId: event.runId, item: event.item }
            : { type: 'routine_run.transcript.upsert', at: now(), botId: id, runId: event.runId, item: event.item }
          : { type: 'transcript.upsert', at: now(), botId: id, item: event.item }
      )
    else if (event.type === 'reset' && event.runId)
      this.onEvent(
        this.store.peerThreadSide(event.runId, id)
          ? { type: 'peer_thread.transcript.reset', at: now(), botId: id, threadId: event.runId }
          : { type: 'routine_run.transcript.reset', at: now(), botId: id, runId: event.runId }
      )
    else if (event.type === 'turn.finished') {
      const run =
        this.onTurnFinished?.(id, {
          outcome: event.outcome,
          inputId: event.inputId,
          text: event.text,
          runId: event.runId,
          media: event.media,
        }) ?? {}
      // Devices sound an alert for the turns the owner asked for, and need who started it to leave out the others.
      if (event.outcome !== 'cancelled')
        this.recordActivity(id, event.outcome === 'completed' ? 'turn_completed' : 'turn_failed', event.summary, {
          ...(event.source ? { source: event.source } : {}),
          ...(event.runId ? { runId: event.runId } : {}),
          ...run,
        })
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
  /**
   * After a reset, or a sequence going back because the instance restarted: reloads its bots and returns the cursor. An
   * environment instance that restarted recreated its bots unready: they are installed again (see `recoverMembers`).
   */
  private async refreshStatuses(
    environmentId: string,
    client: InstanceClient,
    seq: number,
    signal: AbortSignal
  ): Promise<number> {
    if (!this.capable(environmentId)) {
      const id = this.eventBot(environmentId, null)
      if (!id) return seq
      const fresh = await client.forBot(id, false).status()
      if (signal.aborted) return seq
      this.updateStatus(id, fresh)
      this.onEvent({ type: 'transcript.reset', at: now(), botId: id })
      return fresh.lastEventSeq
    }
    const aggregate = await client.environmentStatus()
    // A link stopped meanwhile (its environment stopped, restarted or was reconciled) no longer speaks for its bots.
    if (signal.aborted) return seq
    let latest = seq
    for (const installed of aggregate.bots) {
      const id = this.eventBot(environmentId, installed.botId)
      if (!id) continue
      latest = Math.max(latest, installed.status.lastEventSeq)
      this.updateStatus(id, installed.status)
      this.onEvent({ type: 'transcript.reset', at: now(), botId: id })
    }
    this.recoverMembers(environmentId, aggregate, signal)
    return latest
  }
  /**
   * Installs again, through a reconcile, the bots the gateway runs in an environment whose instance does not run them
   * ready: its Maestrly restarted in the running container and recreated them unready and without their pause, until
   * the gateway installs them. An installation reports its bot unready for a moment too, which is why only a reset or a
   * broken stream leads here, never a status event. The reconcile installs only the environment's active bots.
   */
  private recoverMembers(environmentId: string, aggregate: FleetInstanceEnvironmentStatus, signal: AbortSignal) {
    if (signal.aborted || (aggregate.environmentId !== null && aggregate.environmentId !== environmentId)) return
    const ready = new Set(aggregate.bots.flatMap((item) => (item.status.ready ? [item.botId] : [])))
    const waiting = this.store
      .botsOfEnvironment(environmentId)
      .some((bot) => this.get(bot.id)?.lifecycle === 'running' && !ready.has(bot.id))
    if (waiting) this.scheduleReconcile(environmentId, 1000)
  }
  get(id: string): FleetBot | null {
    const bot = this.store.getBot(id)
    return bot ? this.assemble(bot) : null
  }
  list(): FleetBot[] {
    return this.store.listBots().map((bot) => this.assemble(bot))
  }
  /**
   * A bot's lifecycle and setup as devices see them: its own while it is archived, being installed or restarting in a
   * running environment, otherwise its environment's, whose setup steps it shows until the environment's desktop
   * answers.
   */
  private placementState(
    bot: FleetBot,
    environment: StoredEnvironment | null
  ): { lifecycle: FleetLifecycle; setup: FleetBotSetup } {
    if (bot.lifecycle === 'archived' || !environment) return { lifecycle: bot.lifecycle, setup: bot.setup }
    if (environment.lifecycle === 'running')
      return {
        lifecycle: this.restartingBots.has(bot.id)
          ? 'restarting'
          : bot.lifecycle === 'running' || bot.lifecycle === 'failed' || bot.lifecycle === 'creating'
            ? bot.lifecycle
            : 'starting',
        setup: bot.setup,
      }
    return {
      lifecycle: environment.lifecycle,
      setup: environment.setup.step === 'ready' ? bot.setup : { ...environment.setup },
    }
  }
  /** The model a bot compacts with: its own, or else its environment's default. */
  private effectiveCompaction(bot: FleetBot, environment: StoredEnvironment | null): FleetCompactionConfig | null {
    return bot.compaction ?? environment?.compaction ?? null
  }
  /**
   * The bot as devices see it, from its stored record. The result is a view: it is never saved, since its `compaction`
   * may be its environment's default rather than its own (`update` and `syncPeers` save records read from the store).
   */
  private assemble(bot: FleetBot): FleetBot {
    const environment = bot.environmentId ? this.store.getEnvironment(bot.environmentId) : null
    const state = this.placementState(bot, environment)
    bot.lifecycle = state.lifecycle
    bot.setup = state.setup
    bot.compactionSource = bot.compaction ? 'bot' : environment?.compaction ? 'environment' : null
    bot.compaction = this.effectiveCompaction(bot, environment)
    const move = this.store.runningBotMove(bot.id)
    bot.move = move ? this.moveView(move) : null
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
    bot.sharedFiles = status?.sharedFiles ?? null
    bot.takeover = this.takeovers.get(bot.id) ?? bot.takeover
    bot.activity = status?.activity ?? null
    bot.pendingCount = status?.pending.length ?? 0
    bot.resources = resourcesView(resources)
    // Every turn it runs now, one per conversation (`parallel-turns`), and for older readers the routine run one of
    // them works on, in the run's own conversation.
    bot.turns = status ? this.botTurns(bot.id, fleetInstanceTurns(status)) : null
    const routineTurn = bot.turns?.find((turn) => turn.kind === 'routine') ?? null
    const run = routineTurn?.id ? this.store.routineRunById(routineTurn.id) : null
    bot.runningRun =
      run && routineTurn
        ? {
            id: run.id,
            routineId: run.routineId,
            title: run.routineTitle ?? '',
            startedAt: routineTurn.startedAt,
          }
        : null
    if (bot.lifecycle === 'stopped' || bot.lifecycle === 'archived' || bot.lifecycle === 'failed')
      bot.status = 'offline'
    else if (bot.lifecycle !== 'running' || !status?.ready) bot.status = 'starting'
    else if (bot.paused || status.hold.reason === 'paused') bot.status = 'paused'
    else if (status.hold.reason === 'takeover' || bot.takeover.state === 'human') bot.status = 'human'
    else if (status.pending.length) bot.status = 'waiting'
    else if (!status.accounts.connected || bot.compactionState?.configured === false) bot.status = 'setup'
    else if (
      // `turn` is the bot's own conversation's turn, else the oldest: any turn of an instance of any age.
      status.turn.state !== 'idle' ||
      fleetInstanceTurns(status).length ||
      // What the owner stopped waits for them: the bot is not working on it.
      status.queue.some((item) => !item.stopped) ||
      bot.compactionState?.progress?.status === 'running' ||
      bot.compactionState?.progress?.status === 'retrying'
    )
      bot.status = 'working'
    else bot.status = 'idle'
    return bot
  }
  /**
   * A bot's turns as devices see them: its own conversation's, and each side conversation's with the routine whose
   * run it is. A turn in a conversation the gateway does not know (a run it never recorded) is left out.
   */
  private botTurns(botId: string, turns: FleetInstanceTurn[]): FleetBotTurn[] {
    return turns.flatMap((turn): FleetBotTurn[] => {
      const common = {
        startedAt: turn.startedAt,
        tool: turn.tool?.tool ?? null,
        cancelling: turn.state === 'cancelling',
        ...(turn.compacting ? { compacting: true } : {}),
      }
      if (turn.runId === null) return [{ kind: 'primary', id: null, title: '', ...common }]
      const run = this.store.routineRunById(turn.runId)
      if (run && run.botId === botId) return [{ kind: 'routine', id: run.id, title: run.routineTitle ?? '', ...common }]
      const thread = this.store.peerThreadSide(turn.runId, botId) ? this.store.peerThread(turn.runId) : null
      return thread ? [{ kind: 'peer', id: thread.id, title: thread.title, ...common }] : []
    })
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
      kind: environment.kind,
      lifecycle: environment.lifecycle,
      setup: environment.setup,
      resources: resourcesView(resources),
      memoryLimitBytes: environment.memoryLimitBytes,
      cpuLimit: environment.cpuLimit,
      idleStopMinutes: environment.idleStopMinutes,
      tint: environment.tint,
      isolation: environment.kind === 'workspaces' ? this.isolation(environment) : null,
      compaction: environment.compaction,
      appVersion: instance?.appVersion ?? null,
      capabilities: this.environmentCapabilities(environment.id),
      update: {
        available: this.imageOutdated.get(environment.id) ?? false,
        pendingSince: environment.updateRequestedAt,
      },
      runtimes: instance?.runtimes ?? null,
      additionalRuntimes: instance?.additionalRuntimes,
      botIds: this.store.botsOfEnvironment(environment.id).map((bot) => bot.id),
      createdAt: environment.createdAt,
      updatedAt: environment.updatedAt,
    }
  }
  /**
   * What an environment's Maestrly can do. One from before environments names nothing at its health check: its bot's
   * status tells instead (as it does for configuration from the Mac), and never that it hosts several bots.
   */
  environmentCapabilities(id: string): string[] {
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
    if (changes.lifecycle !== undefined) this.onEnvironmentChanged(id)
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
  /** What a bot's Maestrly runs it with, from its stored record: its model, or else its environment's default. */
  private profile(bot: FleetBot): FleetInstanceProfile {
    const environment = bot.environmentId ? this.store.getEnvironment(bot.environmentId) : null
    return {
      botId: bot.id,
      name: bot.name,
      instructions: bot.instructions,
      ceiling: bot.ceiling,
      selection: bot.selection,
      compaction: this.effectiveCompaction(bot, environment),
      ...(bot.delegation ? { delegation: bot.delegation } : {}),
      ...(environment && this.environmentCapabilities(environment.id).includes(FLEET_ENVIRONMENT_SETTINGS_FEATURE)
        ? { compactionInherited: !bot.compaction && !!environment.compaction }
        : {}),
      gateway: {
        peersEnabled: bot.talksTo.length > 0,
        artifactsEnabled: bot.publishArtifacts && this.artifactsEnabled(),
        // This gateway routes desktop calls; whether any Mac linked the bot is answered per call, never cached here.
        desktopBridgeEnabled: true,
        // This gateway runs routines in conversations of their own whenever the bot's Maestrly can.
        routineConversations: true,
      },
      tint: bot.tint,
    }
  }
  private insertEnvironment(
    name: string,
    memoryLimitBytes: number | null,
    at: string,
    kind: FleetEnvironmentKind = 'bots',
    extra: { cpuLimit?: number | null; idleStopMinutes?: number | null; tint?: string | null } = {}
  ): string {
    const taken = [...this.store.listEnvironments(), ...this.store.archivedEnvironments()].map((item) => item.id)
    const id = deriveBotId(name, taken)
    this.store.insertEnvironment(
      {
        id,
        name,
        kind,
        lifecycle: 'creating',
        setup: environmentSetup('container'),
        containerName: environmentContainerName(id),
        volumeName: environmentVolumeName(id),
        memoryLimitBytes,
        cpuLimit: extra.cpuLimit ?? null,
        idleStopMinutes: kind === 'workspaces' ? (extra.idleStopMinutes ?? null) : null,
        tint: extra.tint ?? null,
        // A new workspaces environment gets a server folder of its own.
        hostFolder: kind === 'workspaces' ? 'own' : null,
        compaction: null,
        updateRequestedAt: null,
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
      },
      { controlToken: token(), keyringPassword: token() }
    )
    return id
  }
  /**
   * A server hosts a bounded number of workspaces environments, one per scope of the owner's work: each is a whole
   * Maestrly with a network of its own.
   */
  private requireWorkspacesRoom() {
    const active = this.store.listEnvironments().filter((environment) => environment.kind === 'workspaces')
    if (active.length >= FLEET_ENVIRONMENT_LIMITS.workspacesMax) throw new GatewayError('CONFLICT', WORKSPACES_LIMIT)
  }
  /**
   * Creates an environment with no bot yet: its container, then its desktop. A `workspaces` environment never gets
   * bots: it runs Maestrly in server mode for the owner's chats and workspaces, on a network and a server folder of its
   * own.
   */
  createEnvironment(input: {
    name: string
    memoryLimitBytes: number | null
    kind?: FleetEnvironmentKind
    cpuLimit?: number | null
    idleStopMinutes?: number | null
    tint?: string | null
  }): FleetEnvironment {
    const kind = input.kind ?? 'bots'
    // Bots run routines on their own: their environment never stops for being idle.
    if (kind !== 'workspaces' && input.idleStopMinutes != null)
      throw new GatewayError('INVALID_REQUEST', WORKSPACES_ONLY)
    const id = this.store.transaction(() => {
      if (kind === 'workspaces') this.requireWorkspacesRoom()
      return this.insertEnvironment(input.name, input.memoryLimitBytes, now(), kind, input)
    })
    this.recordEnvironmentActivity(id, 'environment_created')
    this.emitEnvironment(id, false)
    this.queueProvision(id, false)
    this.armIdleChecks()
    return this.environment(id)!
  }
  /** The Docker network an environment's container runs on: one of its own for workspaces, the fleet's for bots. */
  environmentNetwork(environment: Pick<StoredEnvironment, 'id' | 'kind'>): string {
    return environment.kind === 'workspaces' ? this.config.network + '-env-' + environment.id : this.config.network
  }
  /** The networks of the active workspaces environments: the gateway's network boundary includes them. */
  isolatedNetworks(): string[] {
    return this.store
      .listEnvironments()
      .filter((environment) => environment.kind === 'workspaces')
      .map((environment) => this.environmentNetwork(environment))
  }
  /** The server folder a workspaces environment mounts at the same path; null when it mounts none. */
  private hostFolderPath(environment: StoredEnvironment): string | null {
    const root = this.config.workspacesRoot
    if (environment.kind !== 'workspaces' || !root) return null
    return environment.hostFolder === 'own' ? root.replace(/\/+$/, '') + '/' + environment.id : root
  }
  /** What a workspaces environment's container should be created with. */
  private desiredPlacement(environment: StoredEnvironment): { network: string; folder: string } {
    return { network: this.environmentNetwork(environment), folder: this.hostFolderPath(environment) ?? '' }
  }
  /** What a workspaces environment's container was created with, as its labels say. */
  private placementOf(container: ContainerInfo): { network: string; folder: string } {
    return {
      network: container.labels[networkLabel] ?? this.config.network,
      folder: container.labels[workspacesRootLabel] ?? '',
    }
  }
  private isolation(environment: StoredEnvironment): FleetEnvironmentIsolation {
    const desired = this.desiredPlacement(environment)
    const applied = this.applied.get(environment.id)
    const path = desired.folder || null
    return {
      network: desired.network === this.config.network ? 'shared' : 'own',
      folder: { mode: !path ? 'none' : environment.hostFolder === 'own' ? 'own' : 'shared', path },
      restartRequired: !!applied && (applied.network !== desired.network || applied.folder !== desired.folder),
    }
  }
  /** The gateway's own container, found once; null while it cannot be found. */
  private async gatewayContainer(): Promise<string | null> {
    if (this.gatewayContainerId) return this.gatewayContainerId
    try {
      this.gatewayContainerId = await this.locateGateway()
    } catch {
      return null
    }
    return this.gatewayContainerId
  }
  /**
   * Gets a workspaces environment ready for its container: its network exists with the gateway on it (under the name
   * its internal URL gives, so the environment reaches the gateway at the usual address), and its server folder exists,
   * owned by the user the environment runs as. A gateway container recreated since starts on the fleet network only,
   * so this runs before every start, not only when the container is created.
   */
  private async prepareWorkspaces(environment: StoredEnvironment) {
    if (environment.kind !== 'workspaces') return
    const network = this.environmentNetwork(environment)
    try {
      await this.docker.ensureNetwork(network, { [managed]: 'true', [environmentLabel]: environment.id })
    } catch (error) {
      if (error instanceof GatewayError) throw error
      throw new GatewayError('DOCKER_UNAVAILABLE', NETWORK_FAILED)
    }
    this.onNetworksChanged()
    const gateway = await this.gatewayContainer()
    if (!gateway) throw new GatewayError('INSTANCE_UNAVAILABLE', GATEWAY_NOT_ATTACHED)
    const alias = gatewayAlias(this.config.internalUrl)
    try {
      await this.docker.networkConnect(network, gateway, alias ? [alias] : [])
    } catch {
      throw new GatewayError('INSTANCE_UNAVAILABLE', GATEWAY_NOT_ATTACHED)
    }
    await this.ensureHostFolder(environment)
  }
  /**
   * Creates a workspaces environment's own server folder, owned by uid 1000, through a short-lived container: the
   * gateway itself does not mount the server's workspaces folder. It never touches the shared folder.
   */
  private async ensureHostFolder(environment: StoredEnvironment) {
    const root = this.config.workspacesRoot
    if (!root || environment.hostFolder !== 'own') return
    let code: number
    try {
      code = await this.docker.runOnce({
        image: this.config.botImage,
        command: ['install', '-d', '-o', '1000', '-g', '1000', '-m', '0750', '--', '/mnt/root/' + environment.id],
        user: '0',
        binds: [{ source: root, target: '/mnt/root' }],
        securityOpt: this.config.botSecurityOpt,
        capAdd: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'],
        labels: { [helperLabel]: 'host-folder' },
      })
    } catch (error) {
      if (error instanceof DockerError && error.status === 404)
        throw new GatewayError('IMAGE_MISSING', 'Bot image missing')
      code = -1
    }
    if (code !== 0) {
      this.logger.warn('Environment folder not created', { environmentId: environment.id, exitCode: code })
      throw new GatewayError('DOCKER_UNAVAILABLE', HOST_FOLDER_FAILED)
    }
  }
  /** Takes a workspaces environment's network away once its container is gone; failures only leave it unused. */
  private async removeNetwork(environment: StoredEnvironment) {
    if (environment.kind !== 'workspaces') return
    const network = this.environmentNetwork(environment)
    try {
      const gateway = await this.gatewayContainer()
      if (gateway) await this.docker.networkDisconnect(network, gateway)
      await this.docker.networkRemove(network)
    } catch {
      this.logger.warn('Environment network not removed', { environmentId: environment.id })
    }
    this.onNetworksChanged()
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
      compactionSource: null,
      compactionState: null,
      talksTo: input.talksTo,
      publishArtifacts: input.publishArtifacts ?? this.artifactsEnabled(),
      paused: false,
      lifecycle: 'creating',
      setup: botSetup(joining ? 'profile' : 'container'),
      status: 'starting',
      activity: null,
      pendingCount: 0,
      accounts: { connected: false, providers: [] },
      takeover: { state: 'none', deviceId: null, deviceName: null, since: null },
      resources: resourcesView(undefined),
      screen: { width: 1280, height: 800, display: ':0' },
      appVersion: null,
      capabilities: [],
      usage: null,
      environmentId: null,
      move: null,
      runSettings: FLEET_ROUTINE_RUN_SETTINGS_DEFAULT,
      runningRun: null,
      turns: null,
      peerSettings: FLEET_PEER_THREAD_SETTINGS_DEFAULT,
      delegation: null,
      sharedFiles: null,
      createdAt: at,
      updatedAt: at,
    }
    const gatewayToken = token()
    const environmentId = this.store.transaction(() => {
      this.validatePeers(id, input.talksTo)
      let target: string
      if (input.environmentId !== undefined) {
        // The store refuses a bot in a workspaces environment.
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
    this.clearUpdate(environment.id)
    const container = await this.container(environment)
    if (container) await this.startWithCurrentImage(environment.id, container, false, null)
    else await this.provision(environment.id)
  }
  private async provision(environmentId: string) {
    const environment = this.store.getEnvironment(environmentId)!
    if (!(await this.docker.imageInspect(this.config.botImage)))
      throw new GatewayError('IMAGE_MISSING', 'Bot image missing')
    await this.docker.ensureNetwork(this.config.network)
    await this.prepareWorkspaces(environment)
    // Docker returns the existing volume of a restored environment, keeping its files.
    await this.docker.volumeCreate(environment.volumeName, { [managed]: 'true', [environmentLabel]: environmentId })
    const container = await this.createContainer(environmentId)
    this.imageOutdated.set(environmentId, false)
    await this.docker.start(container)
    await this.ready(environmentId)
  }
  /** The token a workspaces environment publishes artifacts with: the one it has, or a new one. */
  private hostGatewayToken(environmentId: string): string {
    const existing = this.store.hostGatewaySecrets(environmentId)
    if (existing) return existing.gatewayToken
    const gatewayToken = token()
    return this.store.ensureHostGatewaySecrets(environmentId, {
      gatewayToken,
      gatewayTokenSha256: sha256(gatewayToken),
    }).gatewayToken
  }
  /**
   * The container carries its environment: bots arrive through the control API with their own token. An image from
   * before environments reads its one bot from the container instead, and refuses to start without that bot's gateway
   * token, so a bot alone in its environment (the one such an image would run) is named there too. Newer images ignore
   * these variables; they are never set in a shared environment, whose bots must not see each other's token.
   */
  private async createContainer(environmentId: string): Promise<string> {
    const guarded = this.config.botEgress === 'public'
    const environment = this.store.getEnvironment(environmentId)!,
      secrets = this.store.environmentSecrets(environmentId)!
    const active = this.store.botsOfEnvironment(environmentId),
      single = this.singleBot(environmentId)
    const sole = active.length === 1 && single?.id === active[0].id ? single : null
    const soleToken = sole ? this.store.botGatewaySecrets(sole.id)?.gatewayToken : undefined
    const workspaces = environment.kind === 'workspaces'
    const root = this.hostFolderPath(environment)
    const network = this.environmentNetwork(environment)
    // The owner's chats there publish artifacts on this server with it; it is kept, so a new container reuses it.
    const hostToken = workspaces ? this.hostGatewayToken(environmentId) : null
    const env = {
      // A workspaces environment runs Maestrly in server mode; the image's entrypoint then leaves bot mode unset.
      [workspaces ? FLEET_BOT_ENV.serverMode : FLEET_BOT_ENV.mode]: '1',
      ...(root ? { [FLEET_BOT_ENV.workspacesRoot]: root } : {}),
      ...(hostToken ? { [FLEET_BOT_ENV.hostGatewayToken]: hostToken } : {}),
      [FLEET_BOT_ENV.environmentId]: environmentId,
      [FLEET_BOT_ENV.controlHost]: '0.0.0.0',
      [FLEET_BOT_ENV.controlPort]: String(FLEET_PORTS.instanceControl),
      [FLEET_BOT_ENV.controlToken]: secrets.controlToken,
      [FLEET_BOT_ENV.gatewayUrl]: this.config.internalUrl,
      ...(guarded ? { [FLEET_BOT_ENV.egress]: 'public' } : {}),
      ...(this.config.botRuntimeUpdates === 'off' ? { [FLEET_BOT_ENV.runtimeUpdates]: 'off' } : {}),
      ...(this.config.botBrowser === 'electron' ? { [FLEET_BOT_ENV.browser]: 'electron' } : {}),
      ...(sole && soleToken
        ? { [FLEET_BOT_ENV.id]: sole.id, [FLEET_BOT_ENV.name]: sole.name, [FLEET_BOT_ENV.gatewayToken]: soleToken }
        : {}),
      MAESTRLY_BOT_KEYRING_PASSWORD: secrets.keyringPassword,
      TZ: this.config.timezone,
    }
    const id = await this.docker.containerCreate({
      name: environment.containerName,
      image: this.config.botImage,
      hostname: environmentId,
      labels: {
        [managed]: 'true',
        [environmentLabel]: environmentId,
        [egressLabel]: this.config.botEgress,
        [runtimeUpdatesLabel]: this.config.botRuntimeUpdates,
        [botBrowserLabel]: this.config.botBrowser,
        ...(workspaces ? { [workspacesRootLabel]: root ?? '', [hostTokenLabel]: '1', [networkLabel]: network } : {}),
      },
      env: Object.entries(env).map(([key, value]) => key + '=' + value),
      network,
      volume: environment.volumeName,
      // The same path inside as on the host, so paths in logs, in the host's shell and in Maestrly agree.
      ...(root ? { binds: [{ source: root, target: root }] } : {}),
      memory: environment.memoryLimitBytes ?? this.config.botMemory,
      ...(environment.cpuLimit ? { nanoCpus: Math.round(environment.cpuLimit * 1e9) } : {}),
      shmSize: this.config.botShm,
      securityOpt: this.config.botSecurityOpt,
      user: guarded ? '0' : '1000',
      capAdd: guarded ? ['NET_ADMIN'] : [],
    })
    if (workspaces) this.applied.set(environmentId, { network, folder: root ?? '' })
    return id
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
    const imageChanged = imageId !== null && container.imageId !== imageId
    const egressChanged = (container.labels[egressLabel] ?? 'open') !== this.config.botEgress
    // Containers from before this setting update on their own, as `auto` does.
    const runtimeUpdatesChanged = (container.labels[runtimeUpdatesLabel] ?? 'auto') !== this.config.botRuntimeUpdates
    // Containers from before this setting run the image's default, each bot's own Chromium.
    const botBrowserChanged = (container.labels[botBrowserLabel] ?? 'chromium') !== this.config.botBrowser
    // A workspaces environment is created with its server folder and network: a server that gained or moved its
    // workspaces folder, an environment that moved to a folder of its own, or a container from before networks of
    // their own replaces it.
    const environment = this.store.getEnvironment(environmentId)!
    const workspaces = environment.kind === 'workspaces'
    const desired = workspaces ? this.desiredPlacement(environment) : null
    const placed = workspaces ? this.placementOf(container) : null
    if (workspaces) this.applied.set(environmentId, placed!)
    const rootChanged = !!desired && placed!.folder !== desired.folder
    const networkChanged = !!desired && placed!.network !== desired.network
    // A container created before host tokens cannot publish artifacts: it is created again with its token.
    const hostTokenMissing = workspaces && container.labels[hostTokenLabel] !== '1'
    await this.prepareWorkspaces(environment)
    if (
      imageId &&
      (imageChanged ||
        egressChanged ||
        runtimeUpdatesChanged ||
        botBrowserChanged ||
        rootChanged ||
        networkChanged ||
        hostTokenMissing)
    ) {
      await this.docker.stop(container.id)
      await this.docker.remove(container.id)
      this.instances.delete(environmentId)
      const replacement = await this.createContainer(environmentId)
      await this.docker.start(replacement)
      await this.ready(environmentId)
      this.imageOutdated.set(environmentId, false)
      const fromImage = container.imageId.replace(/^sha256:/, '').slice(0, 12)
      const toImage = imageId.replace(/^sha256:/, '').slice(0, 12)
      this.logger.info('Environment container updated', {
        environmentId,
        ...(imageChanged ? { fromImage, toImage } : {}),
        ...(egressChanged ? { egress: this.config.botEgress } : {}),
        ...(runtimeUpdatesChanged ? { runtimeUpdates: this.config.botRuntimeUpdates } : {}),
        ...(botBrowserChanged ? { botBrowser: this.config.botBrowser } : {}),
      })
      this.lifecycleActivity(environmentId, via, 'restarted', {
        updated: true,
        ...(imageChanged ? { fromImage, toImage } : {}),
        ...(egressChanged ? { egress: this.config.botEgress } : {}),
      })
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
    let health: { appVersion: string; capabilities: string[]; runtimes: null } | null = null
    while (Date.now() < deadline) {
      try {
        const value = await client.health()
        if (value.ready) {
          health = { appVersion: value.appVersion, capabilities: value.capabilities, runtimes: null }
          break
        }
      } catch {}
      await sleep(Math.min(1000, Math.max(1, deadline - Date.now())))
    }
    if (!health) throw new GatewayError('INSTANCE_UNAVAILABLE', 'Bot desktop did not become ready')
    if (
      this.store.getEnvironment(environmentId)?.kind === 'workspaces' &&
      !health.capabilities.includes(FLEET_WORKSPACES_HOST_FEATURE)
    )
      throw new GatewayError('INSTANCE_UNAVAILABLE', WORKSPACES_UNSUPPORTED)
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
    const unreleased = await this.releasePendingMoves(environmentId)
    if (lingering || unreleased) this.scheduleReconcile(environmentId, 1000)
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
  /** Installs one bot; `restart` records its restart instead of its start, whatever it was before. */
  private async installOne(client: InstanceClient, id: string, slot: number, strict: boolean, restart = false) {
    const bot = this.store.getBot(id),
      secrets = this.store.botGatewaySecrets(id)
    if (!bot || bot.lifecycle === 'archived' || !secrets) return
    const fresh = bot.lifecycle !== 'running'
    if (fresh) this.updateActive(id, { setup: botSetup('profile') })
    try {
      const takeover = this.takeovers.get(id)?.state
      const status = await client.botInstall(id, {
        profile: this.profile(bot),
        slot,
        gatewayToken: secrets.gatewayToken,
        paused: bot.paused,
        takeover: takeover === 'human' || takeover === 'acquiring',
      })
      await this.settle(id, client.forBot(id, true), status)
      if ((fresh || restart) && this.store.getBot(id)?.lifecycle === 'running')
        this.recordActivity(id, restart ? 'bot_restarted' : 'bot_started')
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
  /**
   * Brings an installed bot's hold in line with the gateway, then records it running. The bot is read again after each
   * answer: a pause or a resume recorded meanwhile (a bot not running yet only records it) is applied before the bot
   * counts as running, and a bot archived meanwhile stays archived.
   */
  private async settle(id: string, client: InstanceClient, installed: FleetInstanceStatus) {
    const active = () => {
      const bot = this.store.getBot(id)
      return bot && bot.lifecycle !== 'archived' ? bot : null
    }
    if (!active()) return
    let status = installed
    const release = () => client.release({ note: null, durationMs: null, continue: true })
    // A takeover or a pause the gateway no longer knows about (it restarted, or the bot was restored) is released.
    if (status.hold.reason === 'takeover' && !this.takeovers.has(id)) status = { ...status, hold: await release() }
    // A few rounds at most, so that an owner pausing and resuming meanwhile cannot keep the bot from running.
    for (let round = 0; round < 4; round++) {
      const bot = active()
      if (!bot) return
      if (status.hold.reason === 'paused' && !bot.paused) status = { ...status, hold: await release() }
      else if (bot.paused && status.hold.reason === null)
        status = { ...status, hold: await client.hold({ reason: 'paused' }) }
      else break
    }
    if (!active()) return
    this.updateStatus(id, status)
    this.updateActive(id, { lifecycle: 'running', setup: botSetup('ready') })
  }
  private async uninstall(client: InstanceClient, id: string, purge: boolean, timeoutMs?: number) {
    try {
      await client.botUninstall(id, purge, timeoutMs)
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
    this.onCloseEnvironmentBridges(environmentId)
    const code = failureCode(error)
    this.updateEnvironment(environmentId, {
      // Starting it again recreates its container on the configured image anyway.
      updateRequestedAt: null,
      lifecycle: 'failed',
      setup: {
        step: 'failed',
        error: code,
        // Fixed texts only: what a container or Docker answered is not shown to the owner.
        errorMessage:
          code === 'IMAGE_MISSING'
            ? 'Bot image missing'
            : error instanceof GatewayError && SHOWN_FAILURES.has(error.message)
              ? error.message
              : 'Bot startup failed',
      },
    })
    for (const bot of this.store.botsOfEnvironment(environmentId)) this.activity(bot.id, 'bot_failed')
    this.logger.warn('Environment startup failed', { environmentId, failure: code })
  }
  /**
   * Starts a stopped or failed environment. A running one installs again those of its bots that are not running (their
   * installation failed), as their own start does: devices start a bot that shares its environment through it.
   */
  async startEnvironment(id: string, via: Via = null): Promise<FleetEnvironment> {
    this.requireEnvironment(id)
    return this.exclusive(id, async () => {
      const environment = this.requireEnvironment(id)
      if (environment.lifecycle !== 'running') {
        this.clearUpdate(id)
        const container = await this.container(environment)
        try {
          // An update that failed after removing the old container leaves none: a new one is created on its volume.
          if (container) await this.startWithCurrentImage(id, container, false, via)
          else await this.provision(id)
          this.lifecycleActivity(id, via, 'started')
        } catch (error) {
          this.failEnvironment(id, error)
        }
      } else {
        const waiting = this.store
          .botsOfEnvironment(id)
          .filter((bot) => bot.lifecycle !== 'running')
          .map((bot) => bot.id)
        if (waiting.length) await this.installInRunning(id, waiting)
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
  private async halt(id: string, via: Via, data: FleetActivityEntry['data'] = {}) {
    const environment = this.store.getEnvironment(id)!
    // Its next start moves it to the configured image anyway.
    this.updateEnvironment(id, { lifecycle: 'stopping', updateRequestedAt: null })
    this.cancelReconcile(id)
    this.stopLink(id)
    this.releaseBots(id, 4002)
    this.onCloseEnvironmentScreens(id, 4002)
    this.onCloseEnvironmentBridges(id)
    const container = await this.container(environment)
    if (container) await this.docker.stop(container.id)
    this.resources.delete(id)
    this.lastUsed.delete(id)
    this.updateEnvironment(id, { lifecycle: 'stopped' })
    this.lifecycleActivity(id, via, 'stopped', data)
  }
  /** Restarts every bot of an environment, recreating its container on the configured image when it is older. */
  async restartEnvironment(id: string, via: Via = null): Promise<FleetEnvironment> {
    this.requireEnvironment(id)
    return this.exclusive(id, () => this.restartLocked(id, via))
  }
  /** A restart moves the environment to the configured image, which is what a waiting update waits for. */
  private async restartLocked(id: string, via: Via): Promise<FleetEnvironment> {
    const environment = this.requireEnvironment(id)
    const container = await this.container(environment)
    this.updateEnvironment(id, { lifecycle: 'restarting', updateRequestedAt: null })
    this.cancelReconcile(id)
    this.stopLink(id)
    this.releaseBots(id, 4002)
    this.onCloseEnvironmentScreens(id, 4002)
    this.onCloseEnvironmentBridges(id)
    try {
      if (!container) {
        await this.provision(id)
        this.lifecycleActivity(id, via, 'restarted')
      } else if (!(await this.startWithCurrentImage(id, container, true, via)))
        this.lifecycleActivity(id, via, 'restarted')
    } catch (error) {
      this.failEnvironment(id, error)
    }
    return this.environmentView(this.store.getEnvironment(id)!)
  }
  /** Whether the bot's environment waits to update: its scheduled routine runs are skipped and peer messages held. */
  updatePending(botId: string): boolean {
    const environmentId = this.store.getBot(botId)?.environmentId
    return !!environmentId && !!this.store.getEnvironment(environmentId)?.updateRequestedAt
  }
  /** The active bots of an environment that restarting it now would interrupt. */
  busyBots(environmentId: string): string[] {
    return this.store
      .botsOfEnvironment(environmentId)
      .map((bot) => this.get(bot.id))
      .filter((bot): bot is FleetBot => !!bot && fleetBotBlocksUpdate(bot))
      .map((bot) => bot.id)
  }
  /**
   * Schedules a move to the configured image that waits until none of the environment's bots is busy, and answers at
   * once. Without an update available it changes nothing; scheduling again keeps the first request.
   */
  async scheduleUpdate(id: string): Promise<FleetEnvironment> {
    this.requireEnvironment(id)
    const view = await this.exclusive(id, async () => {
      const environment = this.requireEnvironment(id)
      if (environment.lifecycle !== 'running')
        throw new GatewayError('BOT_NOT_RUNNING', 'Start the environment to update it')
      // Inspected again, so that an image retagged since the last start counts without restarting the gateway.
      const container = await this.container(environment)
      if (container) await this.updateImageState(id, container)
      if (this.imageOutdated.get(id) && !environment.updateRequestedAt) {
        this.updateEnvironment(id, { updateRequestedAt: now() })
        this.logger.info('Environment update scheduled', { environmentId: id })
      } else this.emitEnvironment(id, false)
      return this.environmentView(this.store.getEnvironment(id)!)
    })
    if (view.update?.pendingSince) {
      this.armUpdateChecks()
      void this.maybeUpdate(id)
    }
    return view
  }
  /** Updates at once, interrupting its busy bots: a restart on the configured image. */
  updateNow(id: string): Promise<FleetEnvironment> {
    return this.restartEnvironment(id)
  }
  async cancelUpdate(id: string): Promise<FleetEnvironment> {
    this.requireEnvironment(id)
    return this.exclusive(id, async () => {
      this.requireEnvironment(id)
      this.clearUpdate(id)
      return this.environmentView(this.store.getEnvironment(id)!)
    })
  }
  /** Tries every waiting update; the timer calls it, and so can tests. */
  async checkUpdates(): Promise<void> {
    const pending = this.store.listEnvironments().filter((environment) => environment.updateRequestedAt)
    if (!pending.length) this.disarmUpdateChecks()
    await Promise.all(pending.map((environment) => this.maybeUpdate(environment.id)))
  }
  private clearUpdate(id: string) {
    const environment = this.store.getEnvironment(id)
    if (environment?.updateRequestedAt && !environment.archivedAt)
      this.updateEnvironment(id, { updateRequestedAt: null })
  }
  /** Whether a scheduled update could apply to the environment at all, busy or not. */
  private awaitsUpdate(id: string): StoredEnvironment | null {
    const environment = this.store.getEnvironment(id)
    return environment?.updateRequestedAt && !environment.archivedAt && environment.lifecycle === 'running'
      ? environment
      : null
  }
  /**
   * Asks a workspaces environment whether chat turns are running. It has no bots whose statuses would tell: its
   * Maestrly reports it on its health check. An environment that does not answer counts as busy.
   */
  private async refreshHostBusy(id: string): Promise<void> {
    try {
      this.hostBusy.set(id, (await this.client(id).health()).busy === true)
    } catch {
      this.hostBusy.set(id, true)
    }
  }
  private readyToUpdate(id: string): boolean {
    const environment = this.awaitsUpdate(id)
    if (!environment) return false
    return environment.kind === 'workspaces' ? this.hostBusy.get(id) === false : this.busyBots(id).length === 0
  }
  /** Applies a waiting update once none of the environment's bots is busy, or no chat of a workspaces host runs. */
  private maybeUpdate(id: string): Promise<void> {
    const running = this.draining.get(id)
    if (running) return running
    const workspaces = this.awaitsUpdate(id)?.kind === 'workspaces'
    if (!workspaces && !this.readyToUpdate(id)) return Promise.resolve()
    const drain = this.exclusive(id, async () => {
      // Checked again with the statuses of this moment: a turn may have started while the lock was taken.
      if (workspaces) await this.refreshHostBusy(id)
      if (!this.readyToUpdate(id)) return
      this.logger.info('Environment idle; updating', { environmentId: id })
      await this.restartLocked(id, null)
    })
      .catch((error: unknown) => {
        this.logger.warn('Environment update failed', {
          environmentId: id,
          failure: error instanceof GatewayError ? error.code : 'INTERNAL',
        })
      })
      .finally(() => this.draining.delete(id))
    this.draining.set(id, drain)
    return drain
  }
  private armUpdateChecks() {
    if (this.updateTimer) return
    this.updateTimer = setInterval(() => void this.checkUpdates(), this.updateCheckMs)
    this.updateTimer.unref?.()
  }
  private disarmUpdateChecks() {
    if (this.updateTimer) clearInterval(this.updateTimer)
    this.updateTimer = null
  }
  /**
   * Changes an environment's name, tint, memory or CPU limit, idle stop, server folder or default compaction model. A
   * new limit reaches its container live first: when Docker refuses it, the container and the record both keep the
   * previous one. A new default then reaches the bots that inherit it. A new server folder applies when the container is
   * next created: the environment reports that a restart is required meanwhile.
   */
  async patchEnvironment(
    id: string,
    input: {
      name?: string
      memoryLimitBytes?: number | null
      cpuLimit?: number | null
      idleStopMinutes?: number | null
      tint?: string | null
      hostFolder?: FleetHostFolderMode
      compaction?: FleetCompactionConfig | null
      expected?: { name?: string; compaction?: FleetCompactionConfig | null }
    }
  ): Promise<FleetEnvironment> {
    const environment = this.requireEnvironment(id)
    if (
      environment.kind !== 'workspaces' &&
      ((input.idleStopMinutes !== undefined && input.idleStopMinutes !== null) || input.hostFolder !== undefined)
    )
      throw new GatewayError('INVALID_REQUEST', WORKSPACES_ONLY)
    const limit = input.memoryLimitBytes
    const changesLimit = limit !== undefined && limit !== environment.memoryLimitBytes
    const cpus = input.cpuLimit
    const changesCpus = cpus !== undefined && cpus !== environment.cpuLimit
    /** What changes in the record alone, compared with the environment as it is when the change applies. */
    const plain = (current: StoredEnvironment): EnvironmentChanges => {
      const changes: EnvironmentChanges = {}
      if (input.name !== undefined && input.name !== current.name) changes.name = input.name
      if (input.tint !== undefined && input.tint !== current.tint) changes.tint = input.tint
      if (input.idleStopMinutes !== undefined && input.idleStopMinutes !== current.idleStopMinutes)
        changes.idleStopMinutes = input.idleStopMinutes
      if (input.hostFolder !== undefined && input.hostFolder !== current.hostFolder)
        changes.hostFolder = input.hostFolder
      return changes
    }
    const applyPlain = (changes: EnvironmentChanges) => {
      if (!Object.keys(changes).length) return
      this.updateEnvironment(id, changes)
      if (changes.idleStopMinutes !== undefined) {
        // A new idle stop counts from now, not from when the environment was last used.
        this.lastUsed.delete(id)
        this.armIdleChecks()
      }
    }
    // A default is compared in the environment's turn: an earlier change may still be waiting for it.
    if (!changesLimit && !changesCpus && input.compaction === undefined && !input.expected) {
      applyPlain(plain(environment))
      return this.environment(id)!
    }
    return this.exclusive(id, async () => {
      const current = this.requireEnvironment(id)
      if (
        (input.expected?.name !== undefined && input.expected.name !== current.name) ||
        (input.expected?.compaction !== undefined && !sameCompaction(input.expected.compaction, current.compaction))
      )
        throw new GatewayError('CONFLICT', 'Environment settings changed. Reload before saving.')
      const changesCompaction = input.compaction !== undefined && !sameCompaction(input.compaction, current.compaction)
      if (!changesLimit && !changesCpus && !changesCompaction) {
        applyPlain(plain(current))
        return this.environment(id)!
      }
      const container = changesLimit || changesCpus ? await this.container(current) : null
      if (changesLimit && limit !== undefined && container) {
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
      if (changesCpus && cpus !== undefined && container) {
        try {
          // 0 lifts Docker's limit.
          await this.docker.updateCpus(container.id, cpus === null ? 0 : Math.round(cpus * 1e9))
        } catch (error) {
          if (error instanceof DockerError)
            throw new GatewayError(
              error.status >= 400 && error.status < 500 ? 'CONFLICT' : 'DOCKER_UNAVAILABLE',
              'Docker could not change the CPU limit'
            )
          throw error
        }
      }
      const changes = plain(current)
      this.store.updateEnvironment(id, {
        ...changes,
        ...(changesLimit ? { memoryLimitBytes: limit } : {}),
        ...(changesCpus ? { cpuLimit: cpus } : {}),
        ...(changesCompaction ? { compaction: input.compaction } : {}),
      })
      if (changes.idleStopMinutes !== undefined) {
        this.lastUsed.delete(id)
        this.armIdleChecks()
      }
      // A new limit shows in the resources of a bot alone in its environment; a new default only in the bots that
      // inherit it, which it reaches next.
      this.emitEnvironment(id, changesLimit)
      if (changesCompaction) await this.propagateCompaction(id, null)
      return this.environment(id)!
    })
  }
  /** The models of a running environment's accounts, to choose its default compaction model from. */
  async environmentSelections(id: string): Promise<FleetSelectionsResponse> {
    const client = this.environmentInstance(id)
    if (!this.environmentCapabilities(id).includes(FLEET_ENVIRONMENT_COMPACTION_FEATURE))
      throw new GatewayError('CONFLICT', RESTART_TO_CHOOSE_COMPACTION)
    return client.environmentSelections()
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
      this.onCloseEnvironmentBridges(id)
      if (container) {
        await this.docker.stop(container.id)
        await this.docker.remove(container.id, true)
      }
      // Restoring it creates its network again.
      await this.removeNetwork(environment)
      this.resources.delete(id)
      this.imageOutdated.delete(id)
      this.instances.delete(id)
      this.applied.delete(id)
      this.lastUsed.delete(id)
      const members = this.store.botsOfEnvironment(id)
      const botIds = this.store.transaction(() => {
        // Restoring it creates its container on the configured image anyway.
        if (environment.updateRequestedAt) this.store.updateEnvironment(id, { updateRequestedAt: null })
        const archived = this.store.archiveEnvironment(id)
        for (const botId of archived) this.syncPeers(botId, [])
        return archived
      })
      for (const peerId of new Set(members.flatMap((bot) => bot.talksTo))) this.emitBot(peerId)
      for (const botId of botIds) this.onEvent({ type: 'bot.removed', at: now(), botId })
      this.recordEnvironmentActivity(id, 'environment_archived')
      this.onEvent({ type: 'environment.removed', at: now(), environmentId: id })
      this.onEnvironmentChanged(id)
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
      if (environment.kind === 'workspaces') this.requireWorkspacesRoom()
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
    this.onEnvironmentChanged(id)
    this.queueProvision(id, true)
    return { environment: this.environment(id)!, botIds }
  }
  /** Irreversible: removes an archived environment's container if any, its home volume, and every record of it. */
  async purgeEnvironment(id: string): Promise<void> {
    const environment = this.store.getEnvironment(id)
    if (!environment?.archivedAt || this.deletingEnvironments.has(id))
      throw new GatewayError('NOT_FOUND', 'Archived environment not found')
    this.deletingEnvironments.add(id)
    // The bots it gave access to, whose links go with its records.
    const linked = this.store.desktopLinksOfEnvironment(id).map((link) => link.botId)
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
    for (const botId of removed.botIds) {
      this.pendingSeen.delete(botId)
      this.onBotPurged(botId)
    }
    this.forgetEnvironment(id)
    if (removed.ownerMemoriesDeleted)
      this.onEvent({ type: 'owner_memory.updated', at: now(), revision: this.store.ownerMemoryRevision() })
    this.recordEnvironmentActivity(id, 'environment_deleted', {}, environment.name)
    this.onEvent({ type: 'environment.removed', at: now(), environmentId: id })
    this.onEnvironmentChanged(id, linked)
  }
  private async removeFiles(environment: StoredEnvironment, subject: 'bot' | 'environment') {
    const leftover = await this.container(environment)
    if (leftover) await this.docker.remove(leftover.id, true)
    // Its server folder stays: it holds the owner's files, not the environment's.
    await this.removeNetwork(environment)
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
    this.applied.delete(id)
    this.lastUsed.delete(id)
  }
  private activeEnvironment(id: string): string {
    const bot = this.store.getBot(id)
    if (!bot || bot.lifecycle === 'archived') throw new GatewayError('NOT_FOUND', 'Bot not found')
    this.requireSettled(id)
    return this.store.botPlacement(id)!.environmentId
  }
  /** A bot's own start and stop act on its environment, which only a bot alone in it may do. */
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
  /**
   * Restarts a bot. A bot alone in its environment restarts its environment, which also moves it to the configured
   * image. A bot that shares its environment restarts on its own (`bot-restart`), and its siblings keep running.
   */
  async restart(id: string): Promise<FleetBot> {
    const environmentId = this.activeEnvironment(id)
    if (this.store.botsOfEnvironment(environmentId).length > 1)
      await this.exclusive(environmentId, () => this.restartBotLocked(environmentId, id))
    else await this.restartEnvironment(environmentId, { botId: id })
    return this.get(id)!
  }
  /**
   * Restarts one bot of a running environment, which must be exclusive. Its Maestrly uninstalls the bot, which stops its
   * turns, the processes of its conversations, its browser and its display, then installs it again from its record,
   * paused if it was. Its data stays, and a takeover of its screen ends. A bot that does not leave fails the restart; a
   * reconcile then installs it again, whatever state it is in.
   */
  private async restartBotLocked(environmentId: string, id: string) {
    const bot = this.store.getBot(id)
    if (!bot || bot.lifecycle === 'archived') throw new GatewayError('NOT_FOUND', 'Bot not found')
    this.requireSettled(id)
    // A move that finished while this restart waited took the bot elsewhere.
    if (this.store.botPlacement(id)?.environmentId !== environmentId) throw new GatewayError('CONFLICT', BOT_MOVING)
    if (this.store.getEnvironment(environmentId)?.lifecycle !== 'running')
      throw new GatewayError('CONFLICT', START_ENVIRONMENT_FIRST)
    // An image from before environments cannot uninstall its bot.
    if (!this.capable(environmentId)) throw new GatewayError('CONFLICT', RESTART_TO_RESTART_BOT)
    const client = this.client(environmentId)
    this.clearTakeover(id, 4002)
    this.removeStatus(id)
    this.restartingBots.add(id)
    this.emitBot(id)
    try {
      try {
        await this.uninstall(client, id, false, BOT_RESTART_UNINSTALL_MS)
      } catch (error) {
        this.logger.warn('A restarting bot did not leave its environment', {
          botId: id,
          environmentId,
          failure: failureCode(error),
        })
        this.scheduleReconcile(environmentId, 1000)
        throw error
      }
      await this.installOne(client, id, this.store.botPlacement(id)!.slot, false, true)
    } finally {
      this.restartingBots.delete(id)
      this.emitBot(id)
    }
    if (this.get(id)?.lifecycle === 'running') this.onReady(id)
  }
  /**
   * Archives one bot: its environment's instance uninstalls it and keeps its data, its slot becomes free and its
   * records stay. Its siblings keep running.
   */
  async archive(id: string): Promise<FleetBot> {
    const bot = this.get(id)
    if (!bot || bot.lifecycle === 'archived') throw new GatewayError('NOT_FOUND', 'Bot not found')
    this.requireSettled(id)
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
    this.onBotPurged(id)
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
    this.requireSettled(id)
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
    this.requireSettled(id)
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
  /**
   * Changes a bot; a running bot takes its new profile first, and a refusal changes nothing. A compaction model of
   * null makes the bot use its environment's default; in an environment without one, a model becomes that default.
   */
  async patch(id: string, input: FleetPatchBotRequest): Promise<FleetBot> {
    const bot = this.get(id)
    if (!bot || bot.lifecycle === 'archived') throw new GatewayError('NOT_FOUND', 'Bot not found')
    this.requireSettled(id)
    if (input.talksTo) this.validatePeers(id, input.talksTo)
    const environmentId = bot.environmentId!
    const { compaction } = input
    // Whether a model becomes its environment's default depends on that default, which only the environment's turn
    // reads reliably: the bot may be installed, or given a default, while the change waits for it.
    if (compaction) await this.exclusive(environmentId, () => this.patchCompaction(id, input, compaction))
    else {
      if (bot.lifecycle === 'running')
        await this.exclusive(environmentId, async () => {
          const current = this.store.getBot(id)
          if (!current || this.get(id)?.lifecycle !== 'running') return
          this.updateStatus(id, await this.reinstallProfile(environmentId, { ...current, ...input }))
        })
      this.store.transaction(() => {
        this.update(id, input)
        if (input.talksTo) this.syncPeers(id, input.talksTo)
      })
    }
    if (input.talksTo) for (const peerId of new Set([...bot.talksTo, ...input.talksTo])) this.emitBot(peerId)
    return this.get(id)!
  }
  /**
   * Gives a bot a model, in its environment's turn. A running bot takes it first, and a refusal changes nothing. In an
   * environment without a default, the model becomes that default: the bot inherits it, and so do its siblings without
   * a model of their own; otherwise it is the bot's own.
   */
  private async patchCompaction(id: string, input: FleetPatchBotRequest, compaction: FleetCompactionConfig) {
    const current = this.store.getBot(id)
    if (!current || current.lifecycle === 'archived') throw new GatewayError('NOT_FOUND', 'Bot not found')
    const environmentId = current.environmentId!
    const adopt = !this.requireEnvironment(environmentId).compaction
    if (this.get(id)?.lifecycle === 'running')
      this.updateStatus(id, await this.reinstallProfile(environmentId, { ...current, ...input }))
    this.store.transaction(() => {
      if (adopt) this.store.updateEnvironment(environmentId, { compaction })
      this.update(id, adopt ? { ...input, compaction: null } : input)
      if (input.talksTo) this.syncPeers(id, input.talksTo)
    })
    if (!adopt) return
    this.emitEnvironment(environmentId, false)
    await this.propagateCompaction(environmentId, id)
  }
  /** Sends a running bot its profile again, from its stored record. */
  async refreshProfiles(): Promise<void> {
    for (const environment of this.store.listEnvironments()) {
      await this.exclusive(environment.id, async () => {
        for (const bot of this.store.botsOfEnvironment(environment.id)) {
          if (this.get(bot.id)?.lifecycle !== 'running') continue
          try {
            this.updateStatus(bot.id, await this.reinstallProfile(environment.id, bot))
          } catch (error) {
            this.logger.warn('Could not refresh bot profile', { botId: bot.id, failure: failureCode(error) })
          }
        }
      })
    }
  }
  private reinstallProfile(environmentId: string, bot: FleetBot): Promise<FleetInstanceStatus> {
    const profile = this.profile(bot)
    return this.capable(environmentId)
      ? this.client(environmentId).botInstall(bot.id, {
          profile,
          slot: this.store.botPlacement(bot.id)!.slot,
          gatewayToken: this.store.botGatewaySecrets(bot.id)!.gatewayToken,
        })
      : this.botClient(bot.id).putProfile(profile)
  }
  /**
   * Gives an environment's default compaction model to its bots without one of their own, but `except`; the
   * environment must be exclusive. A running bot takes it at once; one that cannot now takes it from a later
   * reconcile, as do the bots after it once the instance cannot be reached. A bot that is not running takes it when
   * it is installed.
   */
  private async propagateCompaction(environmentId: string, except: string | null) {
    let reachable = this.store.getEnvironment(environmentId)?.lifecycle === 'running'
    for (const { id } of this.store.botsOfEnvironment(environmentId)) {
      const bot = this.store.getBot(id)
      if (!bot || bot.compaction || id === except) continue
      if (reachable && this.get(id)?.lifecycle === 'running')
        try {
          this.updateStatus(id, await this.reinstallProfile(environmentId, bot))
          continue
        } catch (error) {
          this.logger.warn('Could not apply the environment compaction model', {
            botId: id,
            environmentId,
            failure: failureCode(error),
          })
          this.scheduleReconcile(environmentId, 1000)
          if (error instanceof InstanceUnreachableError) reachable = false
        }
      this.emitBot(id)
    }
  }
  instanceFor(id: string) {
    const bot = this.get(id)
    if (!bot || bot.lifecycle === 'archived') throw new GatewayError('NOT_FOUND', 'Bot not found')
    if (bot.lifecycle !== 'running') throw new GatewayError('BOT_NOT_RUNNING', 'Bot not running')
    // A moving bot runs nowhere until its move commits or fails.
    if (bot.move) throw new GatewayError('BOT_NOT_RUNNING', BOT_MOVING)
    return this.botClient(id)
  }

  /** A bot's move as devices see it, without the slots the gateway keeps. */
  private moveView(move: StoredBotMove): FleetBotMove {
    const { fromSlot: _from, toSlot: _to, ...view } = move
    return view
  }
  /** The bot's last move, running or finished. */
  latestMove(id: string): FleetBotMove | null {
    const move = this.store.latestBotMove(id)
    return move ? this.moveView(move) : null
  }
  /** Nothing changes a bot while it moves. */
  private requireSettled(id: string) {
    if (this.store.runningBotMove(id)) throw new GatewayError('CONFLICT', BOT_MOVING)
  }
  /** Both ends of a move must run an image that moves bots, as an environment of several bots. */
  private requireMovable(environmentId: string) {
    if (!this.capable(environmentId) || !this.environmentCapabilities(environmentId).includes(FLEET_BOT_MOVE_FEATURE))
      throw new GatewayError('CONFLICT', MOVE_NEEDS_UPDATE)
  }
  /** A package is read by the same Maestrly that wrote it: the schema of its rows is that version's. */
  private requireSameVersion(from: string, to: string) {
    const version = this.instances.get(from)?.appVersion
    if (!version || version !== this.instances.get(to)?.appVersion)
      throw new GatewayError('CONFLICT', MOVE_NEEDS_SAME_VERSION)
  }
  private advanceMove(moveId: string, phase: FleetBotMove['phase']) {
    const move = this.store.updateBotMove(moveId, { phase })
    this.emitBot(move.botId)
  }

  /**
   * Moves a running bot to another running bots environment (`environmentId`) or to a new one (`newEnvironment`), with
   * everything that is its own and under its own id, so its routines, peers, links and activity still name it. It
   * answers at once with the move, which holds a slot in the destination; the move then runs in the turn of both
   * environments (see `moveLocked`), and devices follow it in the bot's `move`.
   */
  moveBot(id: string, request: FleetBotMoveRequest): FleetBotMove {
    const bot = this.get(id)
    if (!bot || bot.lifecycle === 'archived') throw new GatewayError('NOT_FOUND', 'Bot not found')
    this.requireSettled(id)
    const source = this.store.botPlacement(id)!.environmentId
    if (bot.lifecycle !== 'running' || this.store.getEnvironment(source)?.lifecycle !== 'running')
      throw new GatewayError('CONFLICT', MOVE_NEEDS_RUNNING)
    const takeover = this.takeovers.get(id)?.state
    if (takeover && takeover !== 'none') throw new GatewayError('CONFLICT', MOVE_NEEDS_SCREEN)
    this.requireMovable(source)
    if (request.environmentId !== undefined) {
      const target = this.requireEnvironment(request.environmentId)
      if (target.kind === 'workspaces') throw new GatewayError('CONFLICT', 'Workspaces environments hold no bots.')
      if (target.id === source) throw new GatewayError('CONFLICT', 'The bot is already there.')
      if (target.lifecycle !== 'running') throw new GatewayError('CONFLICT', MOVE_NEEDS_RUNNING)
      this.requireMovable(target.id)
      this.requireSameVersion(source, target.id)
    }
    const move = this.store.transaction(() =>
      this.store.beginBotMove({
        id: randomUUID(),
        botId: id,
        toEnvironmentId:
          request.environmentId ?? this.insertEnvironment(request.newEnvironment!.name, null, now(), 'bots'),
        newEnvironment: request.environmentId === undefined,
      })
    )
    if (move.newEnvironment) {
      this.recordEnvironmentActivity(move.toEnvironmentId, 'environment_created')
      this.emitEnvironment(move.toEnvironmentId, false)
    }
    this.emitBot(id)
    this.logger.info('Bot move started', { botId: id, from: source, to: move.toEnvironmentId })
    // After the request's transaction commits: the move it started is in the journal by then.
    setImmediate(() => void this.runMove(move.id))
    return this.moveView(move)
  }
  /** Runs a move in the turn of both its environments, always taken in the same order so two moves never wait on each other. */
  private async runMove(moveId: string) {
    const move = this.store.botMove(moveId)
    if (move?.state !== 'running') return
    const [first, second] = [move.fromEnvironmentId, move.toEnvironmentId].sort()
    try {
      await this.exclusive(first, () => this.exclusive(second, () => this.moveLocked(moveId)))
    } catch (error) {
      this.logger.warn('Bot move stopped', { moveId, failure: failureCode(error) })
    }
  }
  /**
   * The steps of a move; both environments are exclusive. Until it is verified, a failure puts everything back: the
   * destination deletes what it received, the bot is installed again where it was, and a destination created for the
   * move goes. Once it commits, the bot belongs to its destination and the move only goes forward: the copy left in
   * the former environment is deleted then, or once that environment runs again.
   */
  private async moveLocked(moveId: string) {
    const move = this.store.botMove(moveId)
    if (move?.state !== 'running') return
    const id = move.botId,
      source = move.fromEnvironmentId,
      target = move.toEnvironmentId
    const reached = { freeze: false, send: false }
    try {
      const destination = this.store.getEnvironment(target)
      if (!destination || destination.archivedAt) throw new GatewayError('NOT_FOUND', 'Environment not found')
      if (destination.lifecycle !== 'running') {
        if (!move.newEnvironment) throw new GatewayError('CONFLICT', MOVE_NEEDS_RUNNING)
        // A new destination gets its container and desktop first, as a new bot's environment does.
        try {
          await this.provision(target)
        } catch (error) {
          this.failEnvironment(target, error)
          throw error
        }
      }
      const bot = this.get(id)
      if (bot?.lifecycle !== 'running' || this.store.getEnvironment(source)?.lifecycle !== 'running')
        throw new GatewayError('CONFLICT', MOVE_NEEDS_RUNNING)
      this.requireMovable(source)
      this.requireMovable(target)
      this.requireSameVersion(source, target)
      this.advanceMove(moveId, 'freezing')
      const from = this.client(source)
      this.clearTakeover(id, 4002)
      reached.freeze = true
      const frozen = await from.botFreeze(id)
      this.removeStatus(id)
      this.advanceMove(moveId, 'exporting')
      reached.send = true
      const imported = await relayBotPackage(from, this.client(target), id, () => this.advanceMove(moveId, 'importing'))
      this.advanceMove(moveId, 'verifying')
      if (JSON.stringify(imported.digest) !== JSON.stringify(frozen.digest))
        throw new GatewayError('INTERNAL', MOVE_DIFFERS)
    } catch (error) {
      await this.rollbackMove(moveId, error, reached)
      return
    }
    this.advanceMove(moveId, 'committing')
    const { ownerMemoriesMoved } = this.store.commitBotMove(moveId)
    if (ownerMemoriesMoved)
      this.onEvent({ type: 'owner_memory.updated', at: now(), revision: this.store.ownerMemoryRevision() })
    this.emitEnvironment(source, false)
    this.emitEnvironment(target, false)
    this.emitBot(id)
    // An installation that fails now fails the bot in its destination, which starting it tries again.
    await this.installOne(this.client(target), id, move.toSlot, false)
    // The bot is in place: what is left is deleting its former copy, which does not hold it back.
    this.store.updateBotMove(moveId, { state: 'completed' })
    this.emitBot(id)
    if (this.get(id)?.lifecycle === 'running') this.onReady(id)
    if (!(await this.releaseSource(moveId))) this.scheduleReconcile(source, 1000)
    this.logger.info('Bot moved', { botId: id, from: source, to: target })
  }
  private async rollbackMove(moveId: string, error: unknown, reached: { freeze: boolean; send: boolean }) {
    const move = this.store.botMove(moveId)!
    const id = move.botId
    // Docker is the gateway's only other dependency: anything else that failed is the gateway's own.
    const code = error instanceof GatewayError || error instanceof DockerError ? failureCode(error) : 'INTERNAL'
    this.logger.warn('Bot move failed', { botId: id, phase: move.phase, failure: code })
    if (reached.send) await this.discardImport(move)
    // A bot that was frozen is installed again where it was, as an archived bot comes back, before the move counts as
    // failed; one whose environment no longer runs comes back when it starts.
    const back = reached.freeze && this.store.getEnvironment(move.fromEnvironmentId)?.lifecycle === 'running'
    if (back)
      try {
        await this.installOne(this.client(move.fromEnvironmentId), id, move.fromSlot, true)
      } catch {
        // An environment that did not answer may still be busy with the freeze the move gave up on, which its bot
        // waits behind: the bot is starting, and the environment's reconcile installs it once it answers.
        this.updateActive(id, { lifecycle: 'starting', setup: botSetup('profile') })
        this.scheduleReconcile(move.fromEnvironmentId, 1000)
      }
    this.store.updateBotMove(moveId, {
      state: 'failed',
      error: {
        code,
        message: (error instanceof GatewayError ? error.message : 'The bot could not be moved.').slice(0, 500),
      },
    })
    this.emitBot(id)
    if (back && this.get(id)?.lifecycle === 'running') this.onReady(id)
    if (move.newEnvironment) await this.discardEnvironment(move.toEnvironmentId)
  }
  /** Deletes what a destination received of a bot that does not belong to it; a failure leaves it for a later move. */
  private async discardImport(move: StoredBotMove) {
    const environment = this.store.getEnvironment(move.toEnvironmentId)
    if (environment?.lifecycle !== 'running' || !this.capable(environment.id)) return
    if (this.store.botPlacement(move.botId)?.environmentId === environment.id) return
    try {
      await this.uninstall(this.client(environment.id), move.botId, true)
    } catch (error) {
      this.logger.warn('A moved bot was not deleted from its destination', {
        botId: move.botId,
        environmentId: environment.id,
        failure: failureCode(error),
      })
    }
  }
  /** Removes an environment created for a move that failed, with its container and files, while it holds no bot. */
  private async discardEnvironment(environmentId: string) {
    const environment = this.store.getEnvironment(environmentId)
    if (!environment || this.store.botsOfEnvironment(environmentId, true).length) return
    try {
      this.cancelReconcile(environmentId)
      this.stopLink(environmentId)
      await this.removeFiles(environment, 'environment')
      this.store.purgeEnvironment(environmentId)
    } catch (error) {
      this.logger.warn('The environment of a failed move was not removed', {
        environmentId,
        failure: failureCode(error),
      })
      return
    }
    this.forgetEnvironment(environmentId)
    this.recordEnvironmentActivity(environmentId, 'environment_deleted', {}, environment.name)
    this.onEvent({ type: 'environment.removed', at: now(), environmentId })
  }
  /**
   * Deletes the copy a moved bot left in its former environment, which must be exclusive. A copy that cannot go now
   * (the environment does not run, or did not answer) waits for that environment's next start or reconcile; the move
   * is complete meanwhile. Nothing is deleted from an environment the bot belongs to again. True when it went.
   */
  private async releaseSource(moveId: string): Promise<boolean> {
    const move = this.store.botMove(moveId)
    if (move?.phase !== 'releasing-source') return true
    const done = () => {
      this.store.updateBotMove(moveId, { phase: 'completed', state: 'completed' })
      this.emitBot(move.botId)
      return true
    }
    const wait = () => {
      if (this.store.botMove(moveId)?.state === 'running') {
        this.store.updateBotMove(moveId, { state: 'completed' })
        this.emitBot(move.botId)
      }
      return false
    }
    if (this.store.botPlacement(move.botId)?.environmentId === move.fromEnvironmentId) return done()
    const environment = this.store.getEnvironment(move.fromEnvironmentId)
    // Its files went with it.
    if (!environment) return done()
    if (environment.archivedAt || environment.lifecycle !== 'running' || !this.capable(environment.id)) return wait()
    try {
      await this.uninstall(this.client(environment.id), move.botId, true)
    } catch (error) {
      this.logger.warn('A moved bot is still in its former environment', {
        botId: move.botId,
        environmentId: environment.id,
        failure: failureCode(error),
      })
      return wait()
    }
    return done()
  }
  /** Deletes what moved bots left in a running environment; the environment must be exclusive. True when some stays. */
  private async releasePendingMoves(environmentId: string): Promise<boolean> {
    let pending = false
    for (const move of this.store.pendingReleases(environmentId))
      if (!(await this.releaseSource(move.id))) pending = true
    return pending
  }
  /**
   * After the gateway restarted: a move that committed is complete (its destination installs the bot, its former
   * environment deletes the copy when it runs), one that did not failed, and its bot comes back where it was with its
   * environment's reconcile. Returns the failed ones, whose destination may hold part of the bot.
   */
  private recoverMoves(): StoredBotMove[] {
    const failed: StoredBotMove[] = []
    for (const move of this.store.runningBotMoves()) {
      if (this.store.botPlacement(move.botId)?.environmentId === move.toEnvironmentId)
        this.store.updateBotMove(move.id, { phase: 'releasing-source', state: 'completed' })
      else {
        this.store.updateBotMove(move.id, { state: 'failed', error: { code: 'INTERNAL', message: MOVE_INTERRUPTED } })
        failed.push(move)
      }
      this.logger.info('Bot move recovered', { botId: move.botId, phase: move.phase })
    }
    return failed
  }
  /**
   * What a move the restart failed left in its destination: the part of the bot it received, and the destination
   * itself when the move created it and it holds no bot.
   */
  private async discardInterrupted(move: StoredBotMove) {
    if (['exporting', 'importing', 'verifying', 'committing'].includes(move.phase)) await this.discardImport(move)
    if (move.newEnvironment) await this.discardEnvironment(move.toEnvironmentId)
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
    // Moves first: a failed one's bot is then an ordinary member of its environment, which installs it below.
    const interrupted = this.recoverMoves()
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
        this.updateEnvironment(id, {
          lifecycle: environment.lifecycle === 'creating' ? 'failed' : 'stopped',
          updateRequestedAt: null,
        })
        continue
      }
      this.imageOutdated.set(id, Boolean(currentImage && container.imageId !== currentImage.id))
      if (this.imageOutdated.get(id))
        this.logger.info('Environment container uses an older image; restart to update', { environmentId: id })
      if (environment.kind === 'workspaces') this.applied.set(id, this.placementOf(container))
      // A waiting update survives a gateway restart, including the one updating the server, while there is still
      // something to update in a running container.
      if (environment.updateRequestedAt && (!this.imageOutdated.get(id) || container.state !== 'running'))
        this.clearUpdate(id)
      if (container.state === 'running') {
        try {
          if (await this.exclusive(id, () => this.reconcileEnvironment(id))) this.scheduleReconcile(id, 1000)
        } catch (error) {
          if (error instanceof GatewayError && error.message === GATEWAY_NOT_ATTACHED)
            this.logger.warn('Gateway not on the network of a running environment', { environmentId: id })
          this.updateEnvironment(id, { lifecycle: 'starting' })
          this.scheduleReconcile(id, 1000)
        }
      } else this.updateEnvironment(id, { lifecycle: 'stopped' })
    }
    for (const move of interrupted) void this.exclusive(move.toEnvironmentId, () => this.discardInterrupted(move))
    if (this.store.listEnvironments().some((environment) => environment.updateRequestedAt)) this.armUpdateChecks()
    this.armIdleChecks()
  }
  /**
   * Installs a running environment's bots again; true when a bot that had to leave its slot could not. A workspaces
   * environment on a network of its own is reached only once the gateway (perhaps a container recreated since) is on it.
   */
  private async reconcileEnvironment(id: string): Promise<boolean> {
    const environment = this.store.getEnvironment(id)
    if (environment?.kind === 'workspaces' && this.applied.get(id)?.network === this.environmentNetwork(environment))
      await this.prepareWorkspaces(environment)
    const client = this.client(id)
    const health = await client.health()
    if (!health.ready) throw new GatewayError('INSTANCE_UNAVAILABLE', 'Bot desktop not ready')
    this.instances.set(id, {
      appVersion: health.appVersion,
      capabilities: health.capabilities,
      runtimes: this.instances.get(id)?.runtimes ?? null,
      additionalRuntimes: this.instances.get(id)?.additionalRuntimes,
    })
    const lingering = await this.installMembers(id, client, null, true)
    this.updateEnvironment(id, { lifecycle: 'running', setup: environmentSetup('ready') })
    for (const bot of this.store.botsOfEnvironment(id))
      if (this.get(bot.id)?.lifecycle === 'running') this.onReady(bot.id)
    this.startLink(id)
    // What bots that moved away left here goes now; what cannot is tried again with the next reconcile.
    const unreleased = await this.releasePendingMoves(id)
    return lingering || unreleased
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
    this.disarmUpdateChecks()
    this.disarmIdleChecks()
  }
  private armIdleChecks() {
    if (this.idleTimer || !this.store.listEnvironments().some((environment) => environment.idleStopMinutes)) return
    this.idleTimer = setInterval(() => void this.checkIdle(), this.idleCheckMs)
    this.idleTimer.unref?.()
  }
  private disarmIdleChecks() {
    if (this.idleTimer) clearInterval(this.idleTimer)
    this.idleTimer = null
  }
  /**
   * Stops the running workspaces environments idle for longer than their idle stop: no device holds a bridge, an editor
   * connection or a file transfer to them, and no chat turn runs there (one that does not answer counts as busy). The
   * timer calls it, and so can tests.
   */
  async checkIdle(at = Date.now()): Promise<void> {
    const environments = this.store.listEnvironments()
    if (!environments.some((environment) => environment.idleStopMinutes)) this.disarmIdleChecks()
    for (const environment of environments) {
      const id = environment.id
      if (environment.kind !== 'workspaces' || !environment.idleStopMinutes || environment.lifecycle !== 'running') {
        this.lastUsed.delete(id)
        continue
      }
      let used = this.hostConnections(id) > 0
      if (!used) {
        await this.refreshHostBusy(id)
        used = this.hostBusy.get(id) !== false
      }
      const last = this.lastUsed.get(id)
      if (used || last === undefined) {
        this.lastUsed.set(id, at)
        continue
      }
      if (at - last < environment.idleStopMinutes * 60000) continue
      this.lastUsed.delete(id)
      try {
        await this.exclusive(id, async () => {
          // Checked again in the environment's turn: someone may have connected or started it meanwhile.
          const current = this.store.getEnvironment(id)
          if (current?.lifecycle !== 'running' || current.archivedAt || this.hostConnections(id) > 0) return
          this.logger.info('Environment idle; stopping', { environmentId: id })
          await this.halt(id, null, { idle: true })
        })
      } catch {
        this.logger.warn('Idle environment not stopped', { environmentId: id })
      }
    }
  }
  /** Measures each running environment's container; a bot alone in its environment reports the figures too. */
  async refreshStats() {
    for (const environment of this.store.listEnvironments()) {
      if (environment.lifecycle !== 'running') continue
      try {
        const container = await this.container(environment)
        if (!container) continue
        const [stats, cgroup] = await Promise.all([
          this.docker.statsOnce(container.id),
          // A server whose containers do not report them (cgroup v1) shows no swap or out-of-memory figures.
          this.docker.cgroupMemory(container.id).catch(() => NO_CGROUP_MEMORY),
        ])
        // The count starts over with the container; each rise is logged once.
        const before = this.resources.get(environment.id)
        const seen = before?.startedAt === container.startedAt ? (before.oomKills ?? 0) : 0
        if ((cgroup.oomKills ?? 0) > seen)
          this.logger.warn('Environment processes ended for lack of memory', {
            environmentId: environment.id,
            oomKills: cgroup.oomKills,
            limitOoms: cgroup.limitOoms,
          })
        this.resources.set(environment.id, { ...stats, ...cgroup, startedAt: container.startedAt })
        this.emitEnvironment(environment.id, this.store.botsOfEnvironment(environment.id).length === 1)
      } catch {}
    }
  }
}
