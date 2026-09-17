import type { AccountAuthority } from '../accounts/authority.js'
import { AccountDelegation } from '../accounts/delegation.js'
import { PromptService } from '../chat/prompts.js'
import { ExtensionsService } from '../chat/extensions-service.js'
import { ExtensionsDelivery } from '../chat/extensions-delivery.js'
import { randomUUID } from 'node:crypto'
import {
  BOT_MUTATIONS,
  botResultSchemas,
  foldTranscript,
  transcriptCursor,
  type Bot,
  type BotMethod,
  type BotOperation,
  type BotRequest,
  type BotResult,
} from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import type { GuestConnector } from '../guest/session.js'
import { BotAccounts } from './accounts.js'
import { BotFiles } from './files.js'
import { fingerprint } from './interactions.js'
import { BotMemories } from './memory.js'
import { type BotRepository, now } from './repository.js'
import { RuntimeCoordinator } from './runtime-coordinator.js'
import { BotSetup, type SetupHost } from './setup.js'
import { BotTurns } from './turns.js'
import type { HostStore } from '../persistence/store.js'
import { BotRepository as Repository } from './repository.js'
import { BotSessions } from './sessions.js'
import { DesktopService, DIRECT_CONTEXT, type DesktopContext } from '../desktop/service.js'
import { TeamRepository } from '../teams/repository.js'
import { TeamService } from '../teams/service.js'
import { BackgroundAdmission } from '../teams/background-admission.js'
import { RoutineRepository } from '../routines/repository.js'
import { RoutineService } from '../routines/service.js'
import { RoutineGuestLane } from '../routines/guest-lane.js'
import { VoiceRepository } from '../voice/repository.js'
import { VoiceService } from '../voice/service.js'
import type { AsrOptions } from '../voice/worker-client.js'
import type { Clock } from '../routines/calendar.js'
import { CompositeContinuationScope, composeBudgetCeilings, composeDispatchGuards, composeTurnObservers } from './scoped-execution.js'

export interface BotServiceOptions {
  store: HostStore
  /** Where verified copies of shared team files are kept, outside every guest workspace. */
  stateDirectory: string
  sharedAccounts?: AccountAuthority
  host: SetupHost & { hostGeneration: number }
  connector: GuestConnector
  /** Notifies the egress broker when a bot policy changes or is revoked. */
  onPolicyChanged?: (botId: string, vmId: string | undefined, policy: { mode: 'offline' | 'allowlist' | 'blocklist'; domains: string[]; revision: number }) => void
  activeStreams?: (vmId: string, botId?: string) => number
  /** Local speech recognition. Absent means this Host simply has no voice transcription. */
  asr?: AsrOptions
  /** Injection seam for calendar tests; production reads the real clock. */
  routines?: { clock?: Clock; tickMs?: number }
}
/** Bot domain façade delegated to by HostService. VM authority stays in HostService. */
export class BotService {
  readonly repo: BotRepository
  readonly coordinator: RuntimeCoordinator
  readonly setup: BotSetup
  readonly turns: BotTurns
  readonly memories: BotMemories
  readonly files: BotFiles
  readonly accounts: BotAccounts
  readonly delegation?: AccountDelegation
  readonly sessions: BotSessions
  readonly desktop: DesktopService
  readonly teams: TeamService
  readonly routines: RoutineService
  readonly voice: VoiceService
  readonly prompts: PromptService
  readonly extensions: ExtensionsService
  constructor(private readonly options: BotServiceOptions) {
    this.repo = new Repository(options.store)
    this.coordinator = new RuntimeCoordinator(this.repo, options.connector, { vm: (id) => options.host.vm(id), hostGeneration: options.host.hostGeneration })
    this.sessions = new BotSessions(this.repo, options.connector, id => options.host.vm(id), {
      backup: async (vmId, key) => {
        if (!options.host.preparation?.backupDisk) throw new HostError('UNSUPPORTED', 'Backup de disco indisponível')
        const wait = async (id: string) => {
          for (let count = 0; count < 360; count++) {
            const op = options.host.operation(id)
            if (op.status === 'succeeded') return
            if (['failed', 'cancelled'].includes(op.status)) throw new HostError('VM_OPERATION_FAILED', op.error?.message ?? 'A operação da VM falhou')
            await new Promise(r => setTimeout(r, 500))
          }
          throw new HostError('VM_OPERATION_UNCERTAIN', 'Verifique a operação do computador antes de continuar')
        }
        let vm = options.host.vm(vmId)
        if (vm.state === 'running') await wait((await options.host.admit('vm.shutdown', { vmId, expectedRevision: vm.revision, idempotencyKey: `${key}:stop` })).id)
        vm = options.host.vm(vmId)
        await options.host.preparation.backupDisk(vm, AbortSignal.timeout(300000))
        await wait((await options.host.admit('vm.start', { vmId, expectedRevision: options.host.vm(vmId).revision, idempotencyKey: `${key}:start` })).id)
      },
      activate: async botId => { this.coordinator.dropSession(botId); await this.coordinator.session(this.repo.bot(botId)) },
    })
    if (options.sharedAccounts) {
      this.delegation = new AccountDelegation(this.repo, options.sharedAccounts)
      this.coordinator.setAccounts(this.delegation)
    }
    this.setup = new BotSetup(this.repo, options.host, this.coordinator, this.sessions, options.sharedAccounts ? { authority: options.sharedAccounts, connect: async botId => this.delegation!.authenticate(botId, await this.coordinator.session(this.repo.bot(botId))) } : undefined)
    this.turns = new BotTurns(this.repo, this.coordinator, (botId) => this.desktop.held(botId))
    this.desktop = new DesktopService({
      repo: this.repo,
      coordinator: this.coordinator,
      connector: options.connector,
      vm: (id) => options.host.vm(id),
      hostGeneration: options.host.hostGeneration,
      continueTask: (input) => {
        const bot = this.repo.bot(input.botId)
        if (bot.accountId && options.sharedAccounts) options.sharedAccounts.assertBindable(bot.accountId)
        return this.turns.createContinuation(input)
      },
      returned: (input) => {
        this.teams.handoffReturned(input)
        this.routines.adapter.handoffReturned(input)
      },
      // Exclusive by construction: if two domains ever claimed the same turn, this fails
      // closed instead of quietly handing a continuation somebody else's allowance.
      budgetCeiling: (turnId) =>
        composeBudgetCeilings([
          { domain: 'teams', ceiling: (id) => this.teams.budgetCeiling(id) },
          { domain: 'routines', ceiling: (id) => this.routines.adapter.budgetCeiling(id) },
        ])(turnId),
    })
    this.coordinator.setDesktopHold((botId) => this.desktop.held(botId))
    this.memories = new BotMemories(this.repo)
    const session = (bot: Bot) => this.coordinator.session(bot)
    this.files = new BotFiles(this.repo, session)
    this.accounts = new BotAccounts(this.repo, session, this.coordinator.events, (bot) => this.setup.accountConnected(bot), options.sharedAccounts && this.delegation ? { authority: options.sharedAccounts, delegation: this.delegation } : undefined)
    const teamRepository = new TeamRepository(options.store)
    this.teams = new TeamService({
      repo: this.repo,
      teams: teamRepository,
      turns: this.turns,
      coordinator: this.coordinator,
      hostId: options.store.hostId,
      stateDirectory: options.stateDirectory,
      session,
      held: (botId) => this.desktop.held(botId),
    })
    const routineRepository = new RoutineRepository(options.store)
    // One pool of background slots for every kind of work nobody is watching. Without this,
    // each scheduler would hand out its own pair and the Host would quietly run twice as much.
    this.background = new BackgroundAdmission(() => ({
      teamTasks: teamRepository.activeTaskCount(),
      routineOccurrences: routineRepository.runningBotCount(),
    }))
    this.routines = new RoutineService({
      routines: routineRepository,
      bots: this.repo,
      teams: teamRepository,
      turns: this.turns,
      coordinator: this.coordinator,
      teamService: () => this.teams,
      hostId: options.store.hostId,
      held: (botId) => this.desktop.held(botId),
      vmRunning: (vmId) => {
        try {
          return options.host.vm(vmId).state === 'running'
        } catch {
          return false
        }
      },
      backgroundAvailable: () => this.background.available(),
      ...(options.routines?.clock ? { clock: options.routines.clock } : {}),
      ...(options.routines?.tickMs !== undefined ? { tickMs: options.routines.tickMs } : {}),
    })
    this.prompts = new PromptService(this.options.store, this.repo)
    this.extensions = new ExtensionsService(this.options.store, this.repo, options.stateDirectory)
    this.coordinator.setExtensions(new ExtensionsDelivery(this.extensions, this.coordinator.events))
    this.voice = new VoiceService({
      voice: new VoiceRepository(options.store),
      bots: this.repo,
      teams: teamRepository,
      turns: this.turns,
      coordinator: this.coordinator,
      teamService: () => this.teams,
      stateDirectory: options.stateDirectory,
      ...(options.asr ? { asr: options.asr } : {}),
    })
    // Scheduled and collaborative work ride the SAME turn engine. Each hook below is composed
    // rather than replaced: two domains silently overwriting one another would resume a turn
    // in the wrong conversation, under the wrong budget, with the wrong authorization.
    const continuations = new CompositeContinuationScope()
    continuations.register('teams', this.teams.adapter)
    continuations.register('routines', this.routines.adapter)
    this.turns.setContinuationScope(continuations)
    this.coordinator.onTurnChanged(
      composeTurnObservers(
        (turnId) => this.teams.turnChanged(turnId),
        (turnId) => this.routines.adapter.turnChanged(turnId)
      )
    )
    this.coordinator.setDispatchGuard(
      composeDispatchGuards(
        (turnId) => this.teams.dispatchGuard(turnId),
        (turnId) => this.routines.adapter.dispatchGuard(turnId)
      )
    )
    this.coordinator.setCollaboration((botId, request) => this.teams.collaboration(botId, request))
    const lane = new RoutineGuestLane(this.routines.proposals)
    this.coordinator.setRoutineLane((botId, request) => lane.handle(botId, request))
    // Reference time and whether this turn may suggest a routine; never a new tool or permission.
    this.turns.setRoutineContext(({ botId, turnId, conversationId }) => this.routines.proposals.context(botId, turnId, conversationId))
  }
  readonly background: BackgroundAdmission
  async ready() {
    this.sessions.recover()
    // No controller survives a Host restart; held bots stay held until an explicit return.
    this.desktop.recover()
    await this.coordinator.recover()
    this.setup.recover()
    this.coordinator.start()
    this.desktop.start()
    this.teams.ready()
    // Routines come last: they only admit work through the engines started above.
    this.routines.ready()
    await this.voice.sweep().catch(() => {})
  }
  async close() {
    this.desktop.shutdown()
    this.voice.close()
    await this.routines.close()
    await this.teams.close()
    await this.coordinator.close()
  }
  isMutation(method: BotMethod) {
    return BOT_MUTATIONS.includes(method)
  }
  /** VM operations must not silently break a working bot; emergency administration stays possible. */
  assertVmOperationAllowed(vmId: string, method: string, deleteData: boolean) {
    const bots = this.repo.botsByVm(vmId)
    if (!bots.length) {
      const archived = this.repo.botsByVm(vmId, true)
      if (deleteData && this.repo.bindingByVm(vmId) && (!archived.length || archived.some(b => b.status !== 'archived')))
        throw new HostError('BOT_BOUND', 'Reconcilie os vínculos deste computador antes de apagar os dados')
      return
    }
    if (deleteData) throw new HostError('BOT_BOUND', `Arquive todos os bots deste computador antes de apagar os dados: ${bots.map(b => b.name).join(', ')}.`)
    const working = bots.filter(bot => {
      const turn = this.repo.activeTurn(bot.id)
      return turn && ['running', 'waiting_approval', 'waiting_input', 'starting', 'queued'].includes(turn.status)
    })
    if (working.length && method !== 'vm.start') throw new HostError('BOT_ACTIVE', `Pare as tarefas dos bots ${working.map(b => b.name).join(', ')} antes de alterar o computador compartilhado.`)
  }
  /** After a VM stops, a stuck turn cannot continue: mark it interrupted honestly. */
  vmStopped(vmId: string) {
    this.desktop.vmStopped(vmId)
    for (const bot of this.repo.botsByVm(vmId)) {
    this.coordinator.dropSession(bot.id)
    const session = this.repo.session(bot.id)
    if (session && session.state !== 'archived') this.repo.saveSession({ ...session, state: 'stopped', revision: session.revision + 1, updatedAt: now() })
    const turn = this.repo.activeTurn(bot.id)
    if (turn)
      this.repo.transaction(() => {
        this.repo.saveTurn({ ...turn, status: 'interrupted', finishedAt: now(), attention: undefined, error: { code: 'VM_STOPPED', message: 'O computador do bot foi desligado durante a tarefa.' }, revision: turn.revision + 1, updatedAt: now() })
        this.coordinator.interactions.invalidatePending(turn.id, bot.id)
        const latest = this.repo.bot(bot.id)
        this.repo.saveBot({ ...latest, activeTurnId: undefined, revision: latest.revision + 1, updatedAt: now() })
        const conversation = this.repo.conversation(turn.conversationId)
        this.repo.saveConversation({ ...conversation, activeTurnId: undefined, revision: conversation.revision + 1, updatedAt: now() })
      })
    if (turn) this.coordinator.turnChanged(turn.id)
    }
  }
  /** A VM bound to a bot, or being created for one, launches with the private bot channels. */
  launchProfileFor(vmId: string, createKey?: string) {
    if (this.repo.bindingByVm(vmId)) return { bot: true as const }
    return createKey && this.repo.reservation(createKey) ? { bot: true as const } : undefined
  }
  async handle<M extends BotMethod>(request: Extract<BotRequest, { method: M }>, context: DesktopContext = DIRECT_CONTEXT): Promise<BotResult<M>> {
    const result = await this.dispatch(request as BotRequest, context)
    return botResultSchemas[request.method].parse(result) as BotResult<M>
  }
  private async dispatch(request: BotRequest, context: DesktopContext): Promise<unknown> {
    const p = request.params as any
    switch (request.method) {
      case 'bot.list':
        return this.repo.bots(p.includeArchived)
      case 'bot.create': {
        // Direct creation registers a bot without a computer; onboarding uses bot.setup.* instead.
        const existing = this.repo.operationByKey(p.idempotencyKey)
        if (existing?.operation.botId) return this.repo.bot(existing.operation.botId)
        return this.repo.transaction(() => {
          const bot: Bot = { id: randomUUID(), name: p.name, purpose: p.purpose, instructions: p.instructions, status: 'setup', runtimeState: 'missing', accountState: 'disconnected', permissionMode: 'ask', revision: 0, createdAt: now(), updatedAt: now() }
          this.repo.saveBot(bot)
          this.repo.saveNetwork(bot.id, { mode: 'blocklist', domains: [], revision: 0 })
          const op: BotOperation = { id: randomUUID(), kind: 'setup', botId: bot.id, status: 'waiting_user', steps: [], createdAt: now(), updatedAt: now() }
          this.repo.insertOperation(op, p.idempotencyKey, fingerprint(p), p)
          return bot
        })
      }
      case 'bot.inspect':
        return this.repo.bot(p.botId)
      case 'bot.session.inspect':
        this.repo.bot(p.botId)
        return this.repo.session(p.botId) ?? null
      case 'bot.sessions.list':
        return this.sessions.inspectVm(p.vmId)
      case 'bot.update': {
        const current = this.repo.bot(p.botId)
        const accountId = p.accountId ?? current.accountId
        if (accountId && (p.model || p.accountId)) {
          if (!this.options.sharedAccounts) throw new HostError('ACCOUNT_SERVICE_UNAVAILABLE', 'O serviço de contas não está disponível')
          p.model = await this.options.sharedAccounts.validateModel(accountId, p.model ?? current.model)
        }
        if (!current.accountId && p.accountId && this.delegation) await this.delegation.prepareEmpty(current.id, await this.coordinator.session(current))
        const result = this.repo.transaction(() => {
          const bot = this.repo.bot(p.botId)
          if (bot.revision !== p.expectedRevision) throw new HostError('REVISION_CONFLICT', 'O bot mudou; recarregue antes de editar')
          if (p.permissionMode === 'full-vm' && !p.confirmFullVm) throw new HostError('CONFIRMATION_REQUIRED', 'O controle administrativo completo exige confirmação explícita')
          if ((p.model || p.accountId || p.permissionMode) && this.repo.activeTurn(bot.id)) throw new HostError('BOT_BUSY', 'Pare a tarefa atual antes de mudar modelo ou permissões')
          if (accountId && (p.accountId || p.model)) this.options.sharedAccounts!.assertBindable(accountId)
          const updated: Bot = {
            ...bot,
            ...(p.name !== undefined ? { name: p.name } : {}),
            ...(p.purpose !== undefined ? { purpose: p.purpose } : {}),
            ...(p.instructions !== undefined ? { instructions: p.instructions } : {}),
            ...(p.accountId !== undefined ? { accountId: p.accountId, accountState: 'connected' as const } : {}),
            ...(p.model !== undefined ? { model: { ...p.model, source: 'custom' as const } } : {}),
            ...(p.permissionMode !== undefined ? { permissionMode: p.permissionMode } : {}),
            revision: bot.revision + 1,
            updatedAt: now(),
          }
          this.repo.saveBot(updated)
          if (p.permissionMode !== undefined && p.permissionMode !== bot.permissionMode)
            this.coordinator.events.record(bot.id, 'runtime.changed', p.permissionMode === 'full-vm' ? 'Controle administrativo completo ativado' : 'Permissões recomendadas ativadas')
          return updated
        })
        if (p.accountId && this.delegation) {
          await this.delegation.authenticate(result.id, await this.coordinator.session(result))
          if (result.status === 'setup') this.setup.accountConnected(this.repo.bot(result.id))
          return this.repo.bot(result.id)
        }
        return result
      }
      case 'bot.archive': {
        const existing = this.repo.operationByKey(p.idempotencyKey)
        if (existing) {
          if (existing.fingerprint !== fingerprint(p)) throw new HostError('IDEMPOTENCY_CONFLICT', 'A chave já foi usada com outros parâmetros')
          return existing.operation
        }
        const op = this.repo.transaction(() => {
          const bot = this.repo.bot(p.botId)
          if (bot.revision !== p.expectedRevision) throw new HostError('REVISION_CONFLICT', 'O bot mudou; recarregue antes de arquivar')
          if (this.repo.activeTurn(bot.id)) throw new HostError('BOT_BUSY', 'Pare a tarefa atual antes de arquivar o bot')
          this.repo.saveBot({ ...bot, status: 'archived', activeTurnId: undefined, revision: bot.revision + 1, updatedAt: now() })
          const policy = this.repo.network(bot.id)
          this.repo.saveNetwork(bot.id, { mode: 'offline', domains: [], revision: policy.revision + 1 })
          const operation: BotOperation = { id: randomUUID(), kind: 'archive', botId: bot.id, status: 'succeeded', steps: [{ id: 'archive', label: 'Bot arquivado; computador e histórico preservados', status: 'succeeded' }], retained: { vmId: bot.vmId, diskRetained: true }, createdAt: now(), updatedAt: now() }
          this.repo.insertOperation(operation, p.idempotencyKey, fingerprint(p), p)
          return { operation, bot }
        })
        this.options.onPolicyChanged?.(op.bot.id, op.bot.vmId, this.repo.network(op.bot.id))
        // Viewers and controllers are revoked before the session is stopped or retained.
        this.desktop.closeBot(op.bot.id)
        this.coordinator.dropSession(op.bot.id)
        if (this.repo.session(op.bot.id)?.transport === 'managed') {
          this.repo.saveOperation({ ...op.operation, status: 'running', steps: [{ id: 'archive', label: 'Parando a área de trabalho e preservando os dados', status: 'running' }] })
          try {
            await this.sessions.stop(op.bot.id)
            this.repo.saveOperation(op.operation)
          } catch {
            const failed = { ...op.operation, status: 'failed' as const, error: { code: 'SESSION_STOP_UNCERTAIN', message: 'O bot foi arquivado e sua rede revogada, mas a parada da área de trabalho precisa ser verificada.' } }
            this.repo.saveOperation(failed)
            return failed
          }
        }
        return op.operation
      }
      case 'bot.setup.preview':
        return this.setup.preview(p)
      case 'bot.setup.start':
        return this.setup.start(p)
      case 'bot.setup.inspect':
        return this.setup.inspect(p.operationId)
      case 'bot.setup.cancel':
        return this.setup.cancel(p.operationId)
      case 'bot.runtime.inspect': {
        const bot = this.repo.bot(p.botId)
        try {
          const session = await this.coordinator.session(bot)
          const info = (await session.request('runtime.inspect', {})) as Record<string, unknown>
          return { state: 'ready', version: session.runtimeVersion, bootId: session.bootId, generation: session.generation, capabilities: session.capabilities, ...(typeof info?.reason === 'string' ? { reason: info.reason } : {}) }
        } catch (error) {
          const code = error instanceof HostError ? error.code : 'RUNTIME_UNREACHABLE'
          return { state: code === 'VM_STOPPED' ? 'unreachable' : code === 'RUNTIME_INCOMPATIBLE' ? 'incompatible' : bot.runtimeState === 'ready' ? 'unreachable' : bot.runtimeState, capabilities: [], reason: error instanceof Error ? error.message : 'unreachable' }
        }
      }
      case 'bot.runtime.prepare':
        if (this.repo.operationByKey(p.idempotencyKey)?.operation.kind === 'runtime.prepare' || this.repo.session(p.botId)?.transport === 'legacy' && this.repo.bot(p.botId).conversationId) return this.sessions.adoptLegacy(p)
        return this.setup.prepare(p)
      case 'bot.models.list':
        return this.accounts.models(p.botId)
      case 'bot.auth.status':
        return this.accounts.status(p.botId)
      case 'bot.auth.start':
        return this.accounts.start(p.botId)
      case 'bot.auth.cancel':
        return this.accounts.cancel(p.botId)
      case 'bot.auth.logout':
        return this.accounts.logout(p.botId)
      case 'bot.auth.setApiKey':
        return this.accounts.setApiKey(p.botId, p.apiKey)
      case 'bot.messages.list': {
        const bot = this.repo.bot(p.botId)
        if (!bot.conversationId) return { messages: [], turns: [], hasMore: false }
        const conversation = this.repo.conversation(bot.conversationId)
        const messages = this.repo.messages(conversation.id, p.before, p.limit + 1)
        const page = messages.length > p.limit ? messages.slice(1) : messages
        const turnIds = [...new Set(page.map((m) => m.turnId).filter((id): id is string => !!id))]
        return { conversation, messages: page, turns: this.repo.turns(conversation.id, turnIds), hasMore: messages.length > p.limit }
      }
      case 'bot.transcript.list': {
        const bot = this.repo.bot(p.botId)
        if (!bot.conversationId) return { messages: [], turns: [], hasMore: false, cursor: 0 }
        const conversation = this.repo.conversation(bot.conversationId)
        const messages = this.repo.messages(conversation.id, p.before, p.limit + 1)
        const page = messages.length > p.limit ? messages.slice(1) : messages
        const turnIds = [...new Set(page.map((m) => m.turnId).filter((id): id is string => !!id))]
        const turns = this.repo.turns(conversation.id, turnIds)
        const events = this.repo.eventsOfTurns(turnIds)
        // One projection for history and for the live screen: see foldTranscript in host-protocol.
        return { messages: foldTranscript({ messages: page, turns, events }), turns, hasMore: messages.length > p.limit, cursor: transcriptCursor(events) }
      }
      case 'bot.messages.send': {
        const bot = this.repo.bot(p.botId)
        if (bot.accountId && this.options.sharedAccounts && !this.turns.lookup(bot.id, p.clientMessageId)) {
          await this.options.sharedAccounts.inspect(bot.accountId)
          this.options.sharedAccounts.assertBindable(bot.accountId)
        }
        return this.turns.send(p.botId, p.clientMessageId, p.content, p.attachments)
      }
      case 'bot.messages.lookup':
        return this.turns.lookup(p.botId, p.clientMessageId)
      case 'bot.turn.get':
        return this.turns.get(p.turnId)
      case 'bot.turn.cancel':
        return this.turns.cancel(p.turnId, p.expectedRevision)
      case 'bot.interactions.list':
        return this.repo.interactions(p.botId, p.pendingOnly)
      case 'bot.interactions.resolve': {
        if (this.desktop.held(this.repo.interaction(p.interactionId).botId))
          throw new HostError('BOT_PAUSED_BY_USER', 'Pedidos feitos antes de você assumir a tela deixaram de valer')
        const { interaction, turn } = this.coordinator.interactions.resolve(p.interactionId, p.expectedGeneration, p.decision, p.answer)
        this.repo.transaction(() =>
          this.repo.enqueue({
            id: `${interaction.id}:resolve`,
            botId: turn.botId,
            turnId: turn.id,
            kind: 'interaction.resolve',
            body: { turnId: turn.id, generation: turn.generation, actionId: interaction.actionId, decision: p.decision, ...(p.answer ? { answer: p.answer } : {}), ...(interaction.scope ? { scope: interaction.scope } : {}) },
            createdAt: now(),
            attempts: 0,
          })
        )
        this.coordinator.events.record(turn.botId, p.decision === 'answer' ? 'question.answered' : 'approval.resolved', p.decision === 'approve' ? 'Você permitiu desta vez' : p.decision === 'deny' ? 'Você não permitiu' : 'Você respondeu ao bot', { turnId: turn.id, conversationId: turn.conversationId, detail: { interactionId: interaction.id, decision: p.decision } })
        this.coordinator.kick(turn.botId)
        return interaction
      }
      case 'bot.memory.list':
        return this.memories.list(p.botId, p.includeInactive)
      case 'bot.memory.upsert':
        return this.memories.upsert(p.botId, p)
      case 'bot.memory.delete':
        return this.memories.delete(p.botId, p.memoryId, p.expectedRevision)
      case 'bot.events.list':
        this.repo.bot(p.botId)
        return this.coordinator.events.page(p.botId, p.after, p.limit)
      case 'bot.network.inspect': {
        const bot = this.repo.bot(p.botId)
        return { policy: this.repo.network(bot.id), mediated: !!bot.vmId && this.coordinator.hasSession(bot.id), activeStreams: bot.vmId ? (this.options.activeStreams?.(bot.vmId, bot.id) ?? 0) : 0 }
      }
      case 'bot.network.update': {
        const existing = this.repo.operationByKey(p.idempotencyKey)
        const bot = this.repo.bot(p.botId)
        if (!existing) {
          if (p.mode === 'blocklist') {
            const session = await this.coordinator.session(bot)
            if (!session.capabilities.includes('network.blocklist.v1'))
              throw new HostError('RUNTIME_UPDATE_REQUIRED', 'Atualize o ambiente do bot para usar internet pública com sites bloqueados')
          }
          const print = fingerprint(p)
          this.repo.transaction(() => {
            const policy = this.repo.network(bot.id)
            if (policy.revision !== p.expectedRevision) throw new HostError('REVISION_CONFLICT', 'A política de rede mudou; recarregue antes de editar')
            this.repo.saveNetwork(bot.id, { mode: p.mode, domains: p.domains, revision: policy.revision + 1 })
            this.repo.insertOperation({ id: randomUUID(), kind: 'network.update', botId: bot.id, status: 'succeeded', steps: [], createdAt: now(), updatedAt: now() }, p.idempotencyKey, print, { ...p })
          })
          const policy = this.repo.network(bot.id)
          this.options.onPolicyChanged?.(bot.id, bot.vmId, policy)
          this.coordinator.events.record(bot.id, 'network.changed', p.mode === 'offline' ? 'Acesso à internet desativado' : p.mode === 'blocklist' ? `Internet pública; sites bloqueados: ${p.domains.length}` : `Destinos permitidos: ${p.domains.length}`, { detail: { mode: p.mode, domains: p.domains } })
          if (this.coordinator.hasSession(bot.id))
            await this.coordinator.session(bot).then((session) => session.request('policy.update', { network: policy, permissionMode: bot.permissionMode })).catch(() => {})
          // While automation is stopped for a person, the graphical services still apply the policy.
          const managed = this.repo.session(bot.id)
          const connector = this.options.connector
          if (this.desktop.held(bot.id) && managed?.transport === 'managed' && connector.desktop && connector.inspectSession)
            await connector.inspectSession(managed).then((info) => connector.desktop!(managed, 'desktop.policy', { sessionId: managed.id, generation: info.generation, network: policy })).catch(() => {})
        } else if (existing.fingerprint !== fingerprint(p)) throw new HostError('IDEMPOTENCY_CONFLICT', 'Idempotency key was used with different parameters')
        return { policy: this.repo.network(bot.id), mediated: !!bot.vmId && this.coordinator.hasSession(bot.id), activeStreams: bot.vmId ? (this.options.activeStreams?.(bot.vmId, bot.id) ?? 0) : 0 }
      }
      case 'bot.files.list':
        return this.files.list(p.botId, p.path)
      case 'bot.files.transferBegin':
        return this.files.begin(p.botId, p)
      case 'bot.files.transferChunk':
        return this.files.chunk(p.transferId, p.offset, p.dataBase64)
      case 'bot.files.transferFinish':
        return this.files.finish(p.transferId)
      case 'bot.files.transferAbort':
        return this.files.abort(p.transferId)
      case 'bot.operation.get':
        return this.repo.operation(p.operationId)
      case 'bot.operation.lookup':
        return this.repo.operationByKey(p.idempotencyKey)?.operation ?? null
      case 'bot.desktop.inspect':
        return this.desktop.inspect(p.botId)
      case 'bot.desktop.open':
        return this.desktop.open(p.botId, p.clientInstanceId, context)
      case 'bot.desktop.close':
        return this.desktop.close(p.viewId, context)
      case 'bot.desktop.acquire':
        return this.desktop.acquire(p, context)
      case 'bot.desktop.operation.get':
        return this.desktop.operationGet(p.operationId)
      case 'bot.desktop.operation.lookup':
        return this.desktop.operationLookup(p.idempotencyKey)
      case 'bot.desktop.claimControl':
        return this.desktop.claimControl(p, context)
      case 'bot.desktop.renew':
        return this.desktop.renew(p, context)
      case 'bot.desktop.input':
        return this.desktop.input(p, context)
      case 'bot.desktop.return':
        return this.desktop.return(p, context)
    }
  }
}
