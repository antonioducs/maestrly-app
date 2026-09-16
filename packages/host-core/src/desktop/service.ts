import { randomUUID } from 'node:crypto'
import type { Duplex } from 'node:stream'
import {
  DESKTOP_CAPABILITIES,
  DESKTOP_HANDOFF_CAPABILITY,
  DESKTOP_LIMITS,
  DESKTOP_LIVE_CAPABILITY,
  MEDIA_STREAMS_PER_HOST,
  MEDIA_VIEWERS_PER_BOT,
  desktopStateSchema,
  vmDesktopInfoSchema,
  vmDesktopInputResultSchema,
  vmDesktopViewerSchema,
  type BotSession,
  type DesktopInput,
  type DesktopOperation,
  type DesktopState,
  type Vm,
} from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import { fingerprint } from '../bots/interactions.js'
import { type BotRepository, now } from '../bots/repository.js'
import type { RuntimeCoordinator } from '../bots/runtime-coordinator.js'
import type { GuestConnector } from '../guest/session.js'
import { MediaTickets } from './grants.js'
import { HandoffRunner, stableCode, type ContinuationFactory } from './handoff.js'
import { DesktopViewers, type Viewer } from './leases.js'
import { DesktopRepository, type DesktopRecord } from './repository.js'

/** The Host connection a request arrived on. Viewers are bound to it. */
export type DesktopContext = { connectionId: string }
export const DIRECT_CONTEXT: DesktopContext = { connectionId: 'direct' }
export interface DesktopServiceOptions {
  repo: BotRepository
  coordinator: RuntimeCoordinator
  connector: GuestConnector
  vm: (id: string) => Vm
  hostGeneration: number
  continueTask: ContinuationFactory
  clock?: () => number
}
const INPUT_ERRORS = new Set(['CONTROL_EXPIRED', 'STALE_DESKTOP', 'INPUT_SEQUENCE_INVALID', 'INPUT_RATE_LIMITED', 'INVALID_COORDINATES', 'DESKTOP_INPUT_REJECTED', 'SESSION_GENERATION_CHANGED'])

/**
 * Host authority for live desktops and human handoff. Viewing and controlling are
 * separate; tickets and control capabilities are random, ephemeral and bound to the
 * connection that asked for them. Only metadata and intent are durable.
 */
export class DesktopService {
  readonly store: DesktopRepository
  readonly viewers: DesktopViewers
  readonly tickets: MediaTickets
  private readonly handoff: HandoffRunner
  private timer?: ReturnType<typeof setInterval>
  constructor(private readonly options: DesktopServiceOptions) {
    this.store = new DesktopRepository(options.repo)
    this.viewers = new DesktopViewers(options.clock)
    this.tickets = new MediaTickets(options.clock)
    this.handoff = new HandoffRunner({
      repo: options.repo,
      store: this.store,
      coordinator: options.coordinator,
      connector: options.connector,
      continueTask: options.continueTask,
      event: (botId, summary, detail, kind = 'runtime.changed') => this.event(botId, summary, detail, kind),
    })
  }
  start() {
    this.timer ??= setInterval(() => void this.tick(), 1_000)
    this.timer.unref?.()
  }
  shutdown() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    for (const viewer of this.viewers.all()) viewer.stream?.destroy()
  }
  held(botId: string) {
    return this.store.held(botId)
  }
  private event(botId: string, summary: string, detail: Record<string, unknown>, kind: 'runtime.changed' | 'attention' = 'runtime.changed') {
    // Existing event kinds only: older applications keep parsing the activity feed.
    this.options.coordinator.events.record(botId, kind, summary, { detail: { kind: 'desktop', ...detail } })
  }
  private capabilities(vmId: string) {
    return this.options.repo.sessionCapabilities(vmId).filter((value): value is (typeof DESKTOP_CAPABILITIES)[number] => (DESKTOP_CAPABILITIES as readonly string[]).includes(value))
  }
  private async refreshCapabilities(vmId: string) {
    const info = await this.options.connector.inspectVm?.(vmId)
    if (info?.capabilities) this.options.repo.saveSessionCapabilities(vmId, info.capabilities)
  }
  private managed(botId: string): BotSession {
    const bot = this.options.repo.bot(botId)
    if (bot.status === 'archived') throw new HostError('BOT_ARCHIVED', 'Este bot está arquivado')
    const session = this.options.repo.session(botId)
    if (!bot.vmId || !session || session.transport !== 'managed' || session.issue || session.state === 'archived' || !this.options.connector.desktop || !this.options.connector.inspectSession)
      throw new HostError('DESKTOP_UPDATE_REQUIRED', 'Atualize o ambiente para ver a tela')
    return session
  }
  private async resolve(botId: string, capability: string) {
    const session = this.managed(botId)
    const vm = this.options.vm(session.vmId)
    if (vm.state !== 'running') throw new HostError('DESKTOP_UNAVAILABLE', 'Ligue o computador do bot para ver a tela')
    if (!this.capabilities(session.vmId).includes(capability as never)) await this.refreshCapabilities(session.vmId).catch(() => {})
    if (!this.capabilities(session.vmId).includes(capability as never)) throw new HostError('DESKTOP_UPDATE_REQUIRED', 'Atualize o ambiente para ver a tela')
    return { session, vm }
  }
  private project(record: DesktopRecord): DesktopState {
    const session = this.options.repo.session(record.botId)
    const capabilities = session ? this.capabilities(session.vmId) : []
    const running = session ? this.options.vm(session.vmId).state === 'running' : false
    return desktopStateSchema.parse({
      botId: record.botId,
      sessionId: record.sessionId,
      revision: record.revision,
      controlEpoch: record.controlEpoch,
      mode: record.mode,
      ...(record.desktopGeneration ? { desktopGeneration: record.desktopGeneration } : {}),
      width: record.width,
      height: record.height,
      ...(record.interruptedTurnId ? { interruptedTurnId: record.interruptedTurnId } : {}),
      ...(record.reasonCode ? { reasonCode: record.reasonCode } : {}),
      controlled: !!this.viewers.controllerOf(record.botId),
      viewers: this.viewers.forBot(record.botId).length,
      capabilities,
      available: running && capabilities.includes(DESKTOP_LIVE_CAPABILITY),
      updatedAt: record.updatedAt,
    })
  }
  private viewer(viewId: string, context: DesktopContext): Viewer {
    const viewer = this.viewers.get(viewId)
    if (!viewer || viewer.connectionId !== context.connectionId)
      throw new HostError('DESKTOP_UNAVAILABLE', 'Esta visualização da tela terminou; abra a tela novamente')
    return viewer
  }
  async inspect(botId: string): Promise<DesktopState> {
    const session = this.managed(botId)
    if (this.options.vm(session.vmId).state === 'running' && !this.capabilities(session.vmId).includes(DESKTOP_LIVE_CAPABILITY))
      await this.refreshCapabilities(session.vmId).catch(() => {})
    return this.project(this.store.transaction(() => this.store.ensure(session)))
  }
  async open(botId: string, clientInstanceId: string, context: DesktopContext) {
    const { session } = await this.resolve(botId, DESKTOP_LIVE_CAPABILITY)
    if (this.viewers.forBot(botId).length >= MEDIA_VIEWERS_PER_BOT || this.viewers.all().length >= MEDIA_STREAMS_PER_HOST)
      throw new HostError('VIEWER_LIMIT', 'Há telas demais abertas; feche uma antes de abrir outra')
    const info = await this.options.connector.inspectSession!(session)
    if (info.state !== 'running') throw new HostError('DESKTOP_UNAVAILABLE', 'A área de trabalho deste bot não está disponível')
    const grantId = randomUUID()
    const opened = vmDesktopViewerSchema.parse(await this.options.connector.desktop!(session, 'desktop.viewer.open', { sessionId: session.id, generation: info.generation, grantId }))
    const record = this.store.transaction(() => {
      const current = this.store.ensure(session)
      const next = { ...current, desktopGeneration: opened.desktopGeneration, width: opened.width, height: opened.height }
      this.store.save(next)
      return next
    })
    const viewId = randomUUID()
    this.viewers.add({ viewId, botId, sessionId: session.id, sessionGeneration: info.generation, connectionId: context.connectionId, clientInstanceId, grantId })
    const { ticket, expiresAt } = this.tickets.issue({ viewId, botId, sessionId: session.id, sessionGeneration: info.generation, grantId, hostGeneration: this.options.hostGeneration })
    return { viewId, mediaTicket: ticket, ticketExpiresAt: expiresAt, state: this.project(record) }
  }
  /** desktop-stdio: exchanges a single-use ticket for one RFB stream. */
  async attach(ticket: string): Promise<{ stream: Duplex; width: number; height: number }> {
    const grant = this.tickets.consume(ticket)
    const viewer = grant ? this.viewers.get(grant.viewId) : undefined
    if (!grant || !viewer || viewer.grantId !== grant.grantId || viewer.stream || grant.hostGeneration !== this.options.hostGeneration)
      throw new HostError('TICKET_INVALID', 'A autorização da tela expirou; abra a tela novamente')
    const session = this.options.repo.session(grant.botId)
    if (!session || session.id !== grant.sessionId || !this.options.connector.openDesktopMedia) throw new HostError('STALE_DESKTOP', 'A área de trabalho mudou')
    const stream = await this.options.connector.openDesktopMedia(session, grant.sessionGeneration, grant.grantId)
    if (this.viewers.get(viewer.viewId) !== viewer) {
      stream.destroy()
      throw new HostError('DESKTOP_UNAVAILABLE', 'A visualização foi encerrada')
    }
    viewer.stream = stream
    stream.once('close', () => {
      if (viewer.stream === stream) viewer.stream = undefined
    })
    const record = this.store.forBot(grant.botId)
    return { stream, width: record?.width || 1280, height: record?.height || 800 }
  }
  async close(viewId: string, context: DesktopContext) {
    const viewer = this.viewer(viewId, context)
    await this.closeViewer(viewer, 'CONTROLLER_CLOSED')
    const record = this.store.forBot(viewer.botId)
    return { closed: true as const, ...(record ? { state: this.project(record) } : {}) }
  }
  private async closeViewer(viewer: Viewer, reason: string) {
    if (this.viewers.get(viewer.viewId) !== viewer) return
    this.viewers.remove(viewer.viewId)
    this.tickets.revokeView(viewer.viewId)
    viewer.stream?.destroy()
    const controlled = this.viewers.revokeControl(viewer)
    const session = this.options.repo.session(viewer.botId)
    if (session && this.options.connector.desktop)
      void this.options.connector.desktop(session, 'desktop.viewer.close', { sessionId: session.id, grantId: viewer.grantId }).catch(() => {})
    if (controlled) await this.pause(viewer.botId, reason)
  }
  /** A lost or closed controller pauses the bot; it never resumes by itself. */
  private async pause(botId: string, reasonCode: string) {
    for (const viewer of this.viewers.forBot(botId)) this.viewers.revokeControl(viewer)
    const next = this.store.transaction(() => {
      const current = this.store.forBot(botId)
      if (current?.mode !== 'human') return undefined
      const value: DesktopRecord = { ...current, mode: 'paused', controlEpoch: current.controlEpoch + 1, revision: current.revision + 1, reasonCode, updatedAt: now() }
      this.store.save(value)
      return value
    })
    if (!next) return
    this.event(botId, 'O bot está pausado; você deixou de controlar a tela', { mode: 'paused', reasonCode })
    const session = this.options.repo.session(botId)
    if (!session || !this.options.connector.desktop || !this.options.connector.inspectSession) return
    const info = await this.options.connector.inspectSession(session).catch(() => undefined)
    if (info) await this.options.connector.desktop(session, 'desktop.pause', { sessionId: session.id, generation: info.generation, epoch: next.controlEpoch }).catch(() => {})
  }
  async acquire(params: { viewId: string; expectedRevision: number; idempotencyKey: string }, context: DesktopContext): Promise<DesktopOperation> {
    const viewer = this.viewer(params.viewId, context)
    const print = fingerprint({ method: 'acquire', viewId: params.viewId, expectedRevision: params.expectedRevision })
    const previous = this.store.operationByKey(params.idempotencyKey)
    if (previous) {
      if (previous.fingerprint !== print) throw new HostError('IDEMPOTENCY_CONFLICT', 'A chave já foi usada com outros parâmetros')
      return previous.operation
    }
    const { session } = await this.resolve(viewer.botId, DESKTOP_HANDOFF_CAPABILITY)
    const record = this.store.transaction(() => this.store.ensure(session))
    const controller = this.viewers.controllerOf(viewer.botId)
    if (controller || record.mode === 'acquiring' || record.mode === 'resuming' || record.mode === 'human')
      throw new HostError('CONTROL_BUSY', 'Outra pessoa ou etapa já está com o controle desta tela')
    const active = this.options.repo.activeTurn(viewer.botId)
    const interruptedTurnId = active?.id ?? (record.mode === 'paused' || record.mode === 'blocked' ? record.interruptedTurnId : undefined)
    const begun = this.store.beginTransition(session.id, params.expectedRevision, params.idempotencyKey, print, { kind: 'acquire', mode: 'acquiring', viewId: viewer.viewId, interruptedTurnId }, () => {
      // Approvals and questions asked before the takeover never become valid again.
      if (active) this.options.coordinator.interactions.invalidatePending(active.id, viewer.botId)
    })
    if (begun.existing) return begun.operation
    this.event(viewer.botId, active ? 'Você pediu o controle da tela; o bot está parando a tarefa' : 'Você pediu o controle da tela', { mode: 'acquiring' })
    void this.handoff.acquire(begun.operation, session)
    return begun.operation
  }
  operationGet(operationId: string) {
    return this.store.operation(operationId)
  }
  operationLookup(idempotencyKey: string) {
    return this.store.operationByKey(idempotencyKey)?.operation ?? null
  }
  async claimControl(params: { viewId: string; operationId: string }, context: DesktopContext) {
    const viewer = this.viewer(params.viewId, context)
    const operation = this.store.operation(params.operationId)
    if (operation.kind !== 'acquire' || operation.status !== 'succeeded' || operation.viewId !== viewer.viewId || operation.botId !== viewer.botId)
      throw new HostError('CONTROL_EXPIRED', 'Este pedido de controle não vale mais')
    const record = this.store.forBot(viewer.botId)
    if (record?.mode !== 'human' || record.controlEpoch !== operation.controlEpoch) throw new HostError('CONTROL_EXPIRED', 'Este pedido de controle não vale mais')
    const other = this.viewers.controllerOf(viewer.botId)
    if (other && other.viewId !== viewer.viewId) throw new HostError('CONTROL_BUSY', 'Outra pessoa já está com o controle')
    const session = this.managed(viewer.botId)
    try {
      await this.options.connector.desktop!(session, 'desktop.lease', { sessionId: session.id, generation: viewer.sessionGeneration, epoch: record.controlEpoch, leaseMs: DESKTOP_LIMITS.controlLeaseMs }, 10_000)
    } catch (error) {
      await this.pause(viewer.botId, 'CONTROL_EXPIRED')
      throw new HostError(stableCode(error, 'CONTROL_EXPIRED') === 'CONTROL_EXPIRED' ? 'CONTROL_EXPIRED' : 'HANDOFF_UNCERTAIN', 'O controle expirou; peça o controle novamente')
    }
    const controlCapability = this.viewers.grantControl(viewer, record.controlEpoch)
    const desktopGeneration = record.desktopGeneration ?? vmDesktopInfoSchema.parse(await this.options.connector.desktop!(session, 'desktop.inspect', { sessionId: session.id, generation: viewer.sessionGeneration })).desktopGeneration
    if (!desktopGeneration) throw new HostError('DESKTOP_UNAVAILABLE', 'A tela deste bot não está disponível')
    return { controlCapability, controlEpoch: record.controlEpoch, desktopGeneration, leaseMs: DESKTOP_LIMITS.controlLeaseMs, renewMs: DESKTOP_LIMITS.controlRenewMs, state: this.project(record) }
  }
  async renew(params: { viewId: string; controlEpoch?: number; controlCapability?: string }, context: DesktopContext) {
    const viewer = this.viewer(params.viewId, context)
    this.viewers.renewViewer(viewer)
    let controlling = false
    if (params.controlCapability) {
      const record = this.store.forBot(viewer.botId)
      const controller = this.viewers.verify(viewer, params.controlCapability, params.controlEpoch)
      if (!controller || record?.mode !== 'human' || record.controlEpoch !== controller.epoch) throw new HostError('CONTROL_EXPIRED', 'O controle expirou')
      const session = this.managed(viewer.botId)
      try {
        await this.options.connector.desktop!(session, 'desktop.lease', { sessionId: session.id, generation: viewer.sessionGeneration, epoch: controller.epoch, leaseMs: DESKTOP_LIMITS.controlLeaseMs }, 10_000)
      } catch (error) {
        await this.pause(viewer.botId, 'CONTROL_EXPIRED')
        throw new HostError(stableCode(error, 'HANDOFF_UNCERTAIN') === 'CONTROL_EXPIRED' ? 'CONTROL_EXPIRED' : 'HANDOFF_UNCERTAIN', 'O controle expirou')
      }
      this.viewers.renewControl(controller)
      controlling = true
    }
    const record = this.store.forBot(viewer.botId)
    if (!record) throw new HostError('DESKTOP_UNAVAILABLE', 'A tela deste bot não está disponível')
    return { state: this.project(record), controlling }
  }
  async input(params: { viewId: string; controlCapability: string; controlEpoch: number; desktopGeneration: string; sequence: number; events: DesktopInput[] }, context: DesktopContext) {
    const viewer = this.viewer(params.viewId, context)
    const controller = this.viewers.verify(viewer, params.controlCapability, params.controlEpoch)
    const record = this.store.forBot(viewer.botId)
    if (!controller || record?.mode !== 'human' || record.controlEpoch !== params.controlEpoch) throw new HostError('CONTROL_EXPIRED', 'O controle expirou')
    if (record.desktopGeneration && record.desktopGeneration !== params.desktopGeneration) throw new HostError('STALE_DESKTOP', 'A tela mudou; ela será recarregada')
    // Same sequence: already applied, never twice. Older: rejected. No automatic retry.
    if (params.sequence === controller.sequence) return { sequence: params.sequence, applied: controller.applied }
    if (params.sequence < controller.sequence) throw new HostError('INPUT_SEQUENCE_INVALID', 'Entrada fora de ordem')
    controller.sequence = params.sequence
    const session = this.managed(viewer.botId)
    try {
      const result = vmDesktopInputResultSchema.parse(await this.options.connector.desktop!(session, 'desktop.input', {
        sessionId: session.id, generation: viewer.sessionGeneration, epoch: params.controlEpoch, desktopGeneration: params.desktopGeneration, sequence: params.sequence, events: params.events,
      }, 15_000))
      controller.applied = result.applied
      return result
    } catch (error) {
      const code = stableCode(error, 'HANDOFF_UNCERTAIN')
      if (code === 'CONTROL_EXPIRED') await this.pause(viewer.botId, 'CONTROL_EXPIRED')
      if (INPUT_ERRORS.has(code)) throw new HostError(code === 'SESSION_GENERATION_CHANGED' ? 'STALE_DESKTOP' : code, 'A entrada não foi aplicada')
      // Unknown outcome: invalidate the epoch instead of assuming exactly-once delivery.
      await this.pause(viewer.botId, 'HANDOFF_UNCERTAIN')
      throw new HostError('HANDOFF_UNCERTAIN', 'Não foi possível confirmar a entrada; o bot ficou pausado')
    }
  }
  async return(params: { botId: string; viewId?: string; controlCapability?: string; expectedRevision: number; idempotencyKey: string; continueTask: boolean }, context: DesktopContext): Promise<DesktopOperation> {
    const print = fingerprint({ method: 'return', botId: params.botId, viewId: params.viewId ?? null, expectedRevision: params.expectedRevision, continueTask: params.continueTask })
    const previous = this.store.operationByKey(params.idempotencyKey)
    if (previous) {
      if (previous.fingerprint !== print) throw new HostError('IDEMPOTENCY_CONFLICT', 'A chave já foi usada com outros parâmetros')
      return previous.operation
    }
    const session = this.managed(params.botId)
    const record = this.store.forBot(params.botId)
    if (!record || record.mode === 'bot') throw new HostError('STALE_DESKTOP', 'O bot já está com o controle')
    if (record.mode === 'acquiring' || record.mode === 'resuming') throw new HostError('CONTROL_BUSY', 'Aguarde a etapa atual terminar')
    if (record.mode === 'human') {
      const viewer = params.viewId ? this.viewer(params.viewId, context) : undefined
      if (!viewer || !this.viewers.verify(viewer, params.controlCapability, record.controlEpoch))
        throw new HostError(this.viewers.controllerOf(params.botId) ? 'CONTROL_BUSY' : 'CONTROL_EXPIRED', 'Somente quem está no controle pode devolvê-lo agora')
    } else if (params.viewId) this.viewer(params.viewId, context)
    const interrupted = record.interruptedTurnId ? this.options.repo.turn(record.interruptedTurnId) : undefined
    const continueTask = params.continueTask && interrupted?.status === 'interrupted' && interrupted.error?.code === 'HUMAN_TAKEOVER'
    const begun = this.store.beginTransition(session.id, params.expectedRevision, params.idempotencyKey, print, {
      kind: 'return', mode: 'resuming', viewId: params.viewId, continueTask: params.continueTask, interruptedTurnId: record.interruptedTurnId, resumeOfTurnId: continueTask ? interrupted!.id : undefined,
    }, () => {
      // Input is revoked in the same step that raises the epoch.
      for (const viewer of this.viewers.forBot(params.botId)) this.viewers.revokeControl(viewer)
    })
    if (begun.existing) return begun.operation
    this.event(params.botId, 'Devolvendo o controle ao bot', { mode: 'resuming', continueTask })
    void this.handoff.return(begun.operation, session, { continueTask, interruptedTurnId: continueTask ? interrupted!.id : undefined })
    return begun.operation
  }
  /** The Host connection closed: its viewers go away and a controller becomes a pause. */
  async disconnect(connectionId: string) {
    await Promise.allSettled(this.viewers.forConnection(connectionId).map((viewer) => this.closeViewer(viewer, 'CONTROLLER_DISCONNECTED')))
  }
  async tick() {
    for (const viewer of this.viewers.expiredControllers()) {
      this.viewers.revokeControl(viewer)
      await this.pause(viewer.botId, 'CONTROL_EXPIRED').catch(() => {})
    }
    for (const viewer of this.viewers.expiredViewers()) await this.closeViewer(viewer, 'VIEWER_EXPIRED').catch(() => {})
    this.tickets.sweep()
  }
  /** Host restart: no controller survives; unfinished handoff steps need inspection, never replay. */
  recover() {
    this.store.transaction(() => {
      for (const operation of this.store.running())
        this.store.applyTransition(operation.id, { phase: 'failed', status: 'failed', failureCode: 'HANDOFF_UNCERTAIN' })
      for (const record of this.store.all()) {
        const mode = record.mode === 'human' || record.mode === 'resuming' ? 'paused' : record.mode === 'acquiring' ? 'blocked' : undefined
        if (mode) this.store.save({ ...record, mode, reasonCode: mode === 'paused' ? 'HOST_RESTARTED' : 'HANDOFF_UNCERTAIN', revision: record.revision + 1, updatedAt: now() })
      }
    })
  }
  /** The VM stopped: screens close and any control becomes a pause. */
  vmStopped(vmId: string) {
    for (const viewer of this.viewers.all()) {
      const session = this.options.repo.session(viewer.botId)
      if (session?.vmId !== vmId) continue
      this.viewers.remove(viewer.viewId)
      this.tickets.revokeView(viewer.viewId)
      viewer.stream?.destroy()
    }
    this.store.transaction(() => {
      for (const record of this.store.all()) {
        const session = this.options.repo.session(record.botId)
        if (session?.vmId !== vmId || !['human', 'acquiring', 'resuming'].includes(record.mode)) continue
        this.store.save({ ...record, mode: 'paused', reasonCode: 'VM_STOPPED', revision: record.revision + 1, updatedAt: now() })
      }
    })
  }
  /** Archive/emergency: revoke the bot's viewers before its session is stopped. */
  closeBot(botId: string) {
    for (const viewer of this.viewers.forBot(botId)) {
      this.viewers.remove(viewer.viewId)
      this.tickets.revokeView(viewer.viewId)
      viewer.stream?.destroy()
    }
  }
}
