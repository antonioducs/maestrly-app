import { randomUUID } from 'node:crypto'
import { MESSAGE_CONTENT_MAX, TURN_TERMINAL, type BotMessage, type BotTurn, type TurnSnapshot, type attachmentRefSchema } from '@maestrly/host-protocol'
import type { z } from 'zod'
import { HostError } from '../errors.js'
import { buildSnapshot, TURN_LIMITS } from './context.js'
import { type BotRepository, now } from './repository.js'
import type { RuntimeCoordinator } from './runtime-coordinator.js'

/** One conversation and one active turn per bot. Messages are durable before any receipt. */
export class BotTurns {
  constructor(
    private readonly repo: BotRepository,
    private readonly coordinator: RuntimeCoordinator,
    private readonly held: (botId: string) => boolean = () => false
  ) {}
  lookup(botId: string, clientMessageId: string) {
    const bot = this.repo.bot(botId)
    if (!bot.conversationId) return null
    const message = this.repo.messageByClientId(bot.conversationId, clientMessageId)
    if (!message?.turnId) return null
    return { message, turn: this.repo.turn(message.turnId) }
  }
  send(botId: string, clientMessageId: string, content: string, attachments: z.infer<typeof attachmentRefSchema>[]) {
    const receipt = this.repo.transaction(() => {
      const bot = this.repo.bot(botId)
      if (!bot.conversationId) throw new HostError('BOT_NOT_READY', 'O bot ainda está sendo preparado')
      const existing = this.repo.messageByClientId(bot.conversationId, clientMessageId)
      if (existing) {
        if (existing.content !== content) throw new HostError('IDEMPOTENCY_CONFLICT', 'Esta mensagem já foi enviada com outro conteúdo')
        return { message: existing, turn: this.repo.turn(existing.turnId as string) }
      }
      if (this.held(botId)) throw new HostError('BOT_PAUSED_BY_USER', 'O bot está pausado enquanto você usa a tela. Devolva o controle para enviar novas tarefas.')
      if (bot.status !== 'ready' && bot.status !== 'archived') throw new HostError('BOT_NOT_READY', 'Conclua a preparação do bot antes de enviar tarefas')
      if (bot.status === 'archived') throw new HostError('BOT_ARCHIVED', 'Este bot está arquivado')
      if (bot.runtimeState !== 'ready') throw new HostError('RUNTIME_NOT_READY', 'O computador do bot ainda não está pronto')
      if (bot.accountState !== 'connected') throw new HostError('ACCOUNT_REQUIRED', 'Conecte a conta de IA do bot antes de enviar tarefas')
      if (this.repo.activeTurn(botId)) throw new HostError('BOT_BUSY', 'O bot ainda está trabalhando na tarefa anterior. Aguarde ou pare a tarefa.')
      const conversation = this.repo.conversation(bot.conversationId)
      const sequence = conversation.lastSequence + 1
      const turnId = randomUUID()
      const message: BotMessage = {
        id: randomUUID(),
        conversationId: conversation.id,
        clientMessageId,
        role: 'user',
        content,
        turnId,
        sequence,
        attachments,
        createdAt: now(),
      }
      const turn: BotTurn = {
        id: turnId,
        botId,
        conversationId: conversation.id,
        messageId: message.id,
        status: 'queued',
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
        network: this.repo.network(botId),
        memory: this.repo.memories(botId, false),
        recent: this.repo.messages(conversation.id, undefined, 20),
        message,
        leaseMs: TURN_LIMITS.leaseMs,
      })
      this.repo.saveMessage(message)
      this.repo.saveTurn(turn)
      this.repo.saveConversation({ ...conversation, activeTurnId: turnId, lastSequence: sequence, title: conversation.title || content.slice(0, 80), revision: conversation.revision + 1, updatedAt: now() })
      this.repo.saveBot({ ...bot, activeTurnId: turnId, revision: bot.revision + 1, updatedAt: now() })
      this.repo.enqueue({ id: `${turnId}:start`, botId, turnId, kind: 'turn.start', body: snapshot, createdAt: now(), attempts: 0 })
      return { message, turn }
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
    const conversation = this.repo.conversation(bot.conversationId)
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
    const turn: BotTurn = { id: turnId, botId: bot.id, conversationId: conversation.id, messageId: message.id, status: 'queued', generation: 1, providerThreadId: conversation.providerThreadId, revision: 0, createdAt: now(), updatedAt: now() }
    const snapshot = buildSnapshot({ bot, conversation, turnId, generation: 1, network: this.repo.network(bot.id), memory: this.repo.memories(bot.id, false), recent: this.repo.messages(conversation.id, undefined, 20), message, leaseMs: TURN_LIMITS.leaseMs, limits: input.limits })
    this.repo.saveMessage(message)
    this.repo.saveTurn(turn)
    this.repo.saveConversation({ ...conversation, activeTurnId: turnId, lastSequence: sequence, revision: conversation.revision + 1, updatedAt: now() })
    this.repo.saveBot({ ...bot, activeTurnId: turnId, revision: bot.revision + 1, updatedAt: now() })
    this.repo.enqueue({ id: `${turnId}:start`, botId: bot.id, turnId, kind: 'turn.start', body: snapshot, createdAt: now(), attempts: 0 })
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
