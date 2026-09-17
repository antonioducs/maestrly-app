import { randomUUID } from 'node:crypto'
import { MESSAGE_CONTENT_MAX, TURN_TERMINAL, type BotMessage, type BotTurn, type RoutineTurnContext, type TeamTurnContext, type TurnSnapshot, type attachmentRefSchema } from '@maestrly/host-protocol'
import type { z } from 'zod'
import { HostError } from '../errors.js'
import { buildSnapshot, TURN_LIMITS } from './context.js'
import { type BotRepository, now } from './repository.js'
import type { RuntimeCoordinator } from './runtime-coordinator.js'

/**
 * Admission of one scoped turn. `conversationId` is chosen by the Host, never by a caller
 * of the public bot API: `BotTurns.send` always uses the bot's own conversation, and only
 * the teams domain asks for a conversation scoped to a run and task.
 */
export interface ScopedTurnInput {
  botId: string
  conversationId: string
  origin: 'user' | 'team'
  clientMessageId: string
  content: string
  role?: BotMessage['role']
  attachments: z.infer<typeof attachmentRefSchema>[]
  limits?: TurnSnapshot['limits']
  /** Team role instructions and collaboration context for this turn only. */
  instructions?: string
  team?: TeamTurnContext
  permissionMode?: BotTurnPermissionMode
  /** Private memory and private history are included only for the bot's own conversation. */
  includePrivateContext?: boolean
  /** Runs inside the admission transaction, after every guard passed. */
  onAdmitted?: (turn: BotTurn, message: BotMessage) => void
}
type BotTurnPermissionMode = 'ask' | 'full-vm'
/**
 * Resolution of a scoped continuation. Without it (a Host with no teams work) every
 * continuation keeps using the bot's own conversation, exactly as in phase three.
 */
export interface ContinuationScope {
  resolve(interruptedTurnId: string):
    | { conversationId: string; instructions?: string; team?: TeamTurnContext; permissionMode?: BotTurnPermissionMode }
    | undefined
  record(input: { interruptedTurnId: string; turn: BotTurn; operationId: string; limits: TurnSnapshot['limits'] }): void
}

/** One conversation and one active turn per bot. Messages are durable before any receipt. */
export class BotTurns {
  constructor(
    private readonly repo: BotRepository,
    private readonly coordinator: RuntimeCoordinator,
    private readonly held: (botId: string) => boolean = () => false,
    private scope?: ContinuationScope
  ) {}
  /** Installed once the teams domain exists; bots created before keep working untouched. */
  setContinuationScope(scope: ContinuationScope) {
    this.scope = scope
  }
  private routineContext?: (input: { botId: string; turnId: string; conversationId: string }) => RoutineTurnContext | undefined
  /**
   * Installed once the routines domain exists. It only ever adds reference time and whether
   * this turn may suggest a routine; it never adds a tool, a permission or a destination.
   */
  setRoutineContext(provider: (input: { botId: string; turnId: string; conversationId: string }) => RoutineTurnContext | undefined) {
    this.routineContext = provider
  }
  private routinesFor(botId: string, turnId: string, conversationId: string) {
    try {
      return this.routineContext?.({ botId, turnId, conversationId })
    } catch {
      // A routine context is a convenience; failing to build one must never block work.
      return undefined
    }
  }
  /**
   * The single admission path. It revalidates the bot, its account, the global slot (which
   * spans the private chat and every team) and the desktop hold inside one transaction, then
   * persists message, turn, conversation and outbox together. A scoped conversation never
   * becomes the bot's main conversation.
   */
  enqueueScopedTurn(input: ScopedTurnInput): { message: BotMessage; turn: BotTurn } {
    const receipt = this.repo.transaction(() => {
      const bot = this.repo.bot(input.botId)
      const conversation = this.repo.conversation(input.conversationId)
      if (conversation.botId !== bot.id) throw new HostError('INVALID_REQUEST', 'A conversa pertence a outro bot')
      const existing = this.repo.messageByClientId(conversation.id, input.clientMessageId)
      if (existing) {
        if (existing.content !== input.content) throw new HostError('IDEMPOTENCY_CONFLICT', 'Esta mensagem já foi enviada com outro conteúdo')
        return { message: existing, turn: this.repo.turn(existing.turnId as string) }
      }
      if (this.held(bot.id)) throw new HostError('BOT_PAUSED_BY_USER', 'O bot está pausado enquanto você usa a tela. Devolva o controle para enviar novas tarefas.')
      if (bot.status === 'archived') throw new HostError('BOT_ARCHIVED', 'Este bot está arquivado')
      if (bot.status !== 'ready') throw new HostError('BOT_NOT_READY', 'Conclua a preparação do bot antes de enviar tarefas')
      if (bot.runtimeState !== 'ready') throw new HostError('RUNTIME_NOT_READY', 'O computador do bot ainda não está pronto')
      if (bot.accountState !== 'connected') throw new HostError('ACCOUNT_REQUIRED', 'Conecte a conta de IA do bot antes de enviar tarefas')
      if (this.repo.activeTurn(bot.id)) throw new HostError('BOT_BUSY', 'O bot ainda está trabalhando na tarefa anterior. Aguarde ou pare a tarefa.')
      const sequence = conversation.lastSequence + 1
      const turnId = randomUUID()
      const message: BotMessage = {
        id: randomUUID(),
        conversationId: conversation.id,
        clientMessageId: input.clientMessageId,
        role: input.role ?? 'user',
        content: input.content,
        turnId,
        sequence,
        attachments: input.attachments,
        createdAt: now(),
      }
      const turn: BotTurn = {
        id: turnId,
        botId: bot.id,
        conversationId: conversation.id,
        messageId: message.id,
        status: 'queued',
        // The model the ledger prices this turn at; changing the bot later must not rewrite history.
        ...(bot.model ? { model: bot.model } : {}),
        generation: 1,
        providerThreadId: conversation.providerThreadId,
        revision: 0,
        createdAt: now(),
        updatedAt: now(),
      }
      const snapshot = buildSnapshot({
        bot,
        conversation,
        turnId,
        generation: 1,
        network: this.repo.network(bot.id),
        // A team turn never carries the bot's private memory or private history.
        memory: input.includePrivateContext === false ? [] : this.repo.memories(bot.id, false),
        recent: input.includePrivateContext === false ? [] : this.repo.messages(conversation.id, undefined, 20),
        message,
        leaseMs: TURN_LIMITS.leaseMs,
        ...(input.limits ? { limits: input.limits } : {}),
        ...(input.instructions ? { instructions: input.instructions } : {}),
        ...(input.team ? { team: input.team } : {}),
        ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
        ...(() => {
          const routines = this.routinesFor(bot.id, turnId, conversation.id)
          return routines ? { routines } : {}
        })(),
      })
      this.repo.saveMessage(message)
      this.repo.saveTurn(turn)
      this.repo.saveConversation({
        ...conversation,
        activeTurnId: turnId,
        lastSequence: sequence,
        title: conversation.title || input.content.slice(0, 80),
        revision: conversation.revision + 1,
        updatedAt: now(),
      })
      // Only the bot's own conversation is the one the person sees; a scoped thread never
      // replaces bot.conversationId.
      this.repo.saveBot({ ...bot, activeTurnId: turnId, revision: bot.revision + 1, updatedAt: now() })
      this.repo.enqueue({ id: `${turnId}:start`, botId: bot.id, turnId, kind: 'turn.start', body: snapshot, createdAt: now(), attempts: 0 })
      input.onAdmitted?.(turn, message)
      return { message, turn }
    })
    return receipt
  }
  lookup(botId: string, clientMessageId: string) {
    const bot = this.repo.bot(botId)
    if (!bot.conversationId) return null
    const message = this.repo.messageByClientId(bot.conversationId, clientMessageId)
    if (!message?.turnId) return null
    return { message, turn: this.repo.turn(message.turnId) }
  }
  send(botId: string, clientMessageId: string, content: string, attachments: z.infer<typeof attachmentRefSchema>[]) {
    const bot = this.repo.bot(botId)
    if (!bot.conversationId) throw new HostError('BOT_NOT_READY', 'O bot ainda está sendo preparado')
    const receipt = this.enqueueScopedTurn({
      botId,
      conversationId: bot.conversationId,
      origin: 'user',
      clientMessageId,
      content,
      attachments,
    })
    this.coordinator.events.record(botId, 'turn.status', 'Tarefa recebida', { turnId: receipt.turn.id, conversationId: receipt.turn.conversationId, detail: { status: receipt.turn.status } })
    this.coordinator.kick(botId)
    return receipt
  }
  get(turnId: string) {
    return this.repo.turn(turnId)
  }
  /**
   * One continuation per return operation, in the caller's transaction: new turn ID and
   * generation, same conversation and provider thread, a fresh desktop capture attached,
   * and only what is left of the original budget. Nothing from before the takeover is replayed.
   */
  createContinuation(input: { botId: string; interruptedTurnId: string; operationId: string; capture: { path: string; name: string; size: number; digest: string }; limits: TurnSnapshot['limits'] }) {
    const bot = this.repo.bot(input.botId)
    if (!bot.conversationId || bot.status !== 'ready') throw new HostError('BOT_NOT_READY', 'O bot não está pronto para continuar a tarefa')
    if (bot.accountState !== 'connected') throw new HostError('ACCOUNT_REQUIRED', 'Conecte a conta de IA do bot para continuar a tarefa')
    // A team task continues its own scoped thread, not the person's private conversation.
    const scoped = this.scope?.resolve(input.interruptedTurnId)
    const conversation = this.repo.conversation(scoped?.conversationId ?? bot.conversationId)
    const clientMessageId = `desktop-return:${input.operationId}`
    const existing = this.repo.messageByClientId(conversation.id, clientMessageId)
    if (existing?.turnId) return { turnId: existing.turnId, conversationId: conversation.id }
    if (this.repo.activeTurn(bot.id)) throw new HostError('BOT_BUSY', 'O bot já tem outra tarefa em andamento')
    const interrupted = this.repo.turn(input.interruptedTurnId)
    const original = this.repo.message(interrupted.messageId)
    const task = original.role === 'system' ? original.content.split(CONTINUATION_TASK_MARKER).pop()! : original.content
    const content = [
      'Continuação após intervenção humana.',
      'A pessoa assumiu o controle da área de trabalho, fez alterações e devolveu o controle.',
      'A imagem anexada é uma captura atual da tela. Antes de qualquer ação, observe o estado atual: observações, referências de página e aprovações anteriores não valem mais. Reavalie o plano a partir deste estado e não repita ações sem verificar.',
      `${CONTINUATION_TASK_MARKER}${task}`,
    ].join('\n\n').slice(0, MESSAGE_CONTENT_MAX)
    const sequence = conversation.lastSequence + 1
    const turnId = randomUUID()
    const message: BotMessage = { id: randomUUID(), conversationId: conversation.id, clientMessageId, role: 'system', content, turnId, sequence, attachments: [input.capture], createdAt: now() }
    const turn: BotTurn = { id: turnId, botId: bot.id, conversationId: conversation.id, messageId: message.id, status: 'queued', ...(bot.model ? { model: bot.model } : {}), generation: 1, providerThreadId: conversation.providerThreadId, revision: 0, createdAt: now(), updatedAt: now() }
    const snapshot = buildSnapshot({
      bot,
      conversation,
      turnId,
      generation: 1,
      network: this.repo.network(bot.id),
      memory: scoped ? [] : this.repo.memories(bot.id, false),
      recent: scoped ? [] : this.repo.messages(conversation.id, undefined, 20),
      message,
      leaseMs: TURN_LIMITS.leaseMs,
      limits: input.limits,
      ...(scoped?.instructions ? { instructions: scoped.instructions } : {}),
      ...(scoped?.team ? { team: scoped.team } : {}),
      ...(scoped?.permissionMode ? { permissionMode: scoped.permissionMode } : {}),
      ...(() => {
        const routines = this.routinesFor(bot.id, turnId, conversation.id)
        return routines ? { routines } : {}
      })(),
    })
    this.repo.saveMessage(message)
    this.repo.saveTurn(turn)
    this.repo.saveConversation({ ...conversation, activeTurnId: turnId, lastSequence: sequence, revision: conversation.revision + 1, updatedAt: now() })
    this.repo.saveBot({ ...bot, activeTurnId: turnId, revision: bot.revision + 1, updatedAt: now() })
    this.repo.enqueue({ id: `${turnId}:start`, botId: bot.id, turnId, kind: 'turn.start', body: snapshot, createdAt: now(), attempts: 0 })
    // The retry keeps the original task, run and budget; it is not a new piece of work.
    if (scoped) this.scope?.record({ interruptedTurnId: input.interruptedTurnId, turn, operationId: input.operationId, limits: input.limits })
    return { turnId, conversationId: conversation.id }
  }
  async cancel(turnId: string, expectedRevision: number) {
    const turn = this.repo.turn(turnId)
    if (TURN_TERMINAL.has(turn.status)) return turn
    if (turn.revision !== expectedRevision) throw new HostError('REVISION_CONFLICT', 'A tarefa mudou; verifique o estado atual antes de parar')
    return this.coordinator.requestCancel(turn.botId, turnId, 'Solicitado pela pessoa')
  }
}
export const CONTINUATION_TASK_MARKER = 'Tarefa original:\n'
