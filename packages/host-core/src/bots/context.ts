import { MEMORY_ACTIVE_BUDGET, type Bot, type BotConversation, type BotMemory, type BotMessage, type NetworkPolicy, type TeamTurnContext, type TurnSnapshot } from '@maestrly/host-protocol'
import { HostError } from '../errors.js'

export const TURN_LIMITS = { activeMs: 30 * 60_000, maxTools: 100, maxLogBytes: 10 * 1024 * 1024, leaseMs: 30_000, renewMs: 10_000, humanWaitMs: 24 * 3_600_000, dispatchAttentionMs: 60_000 }
export function defaultInstructions(bot: Pick<Bot, 'name' | 'purpose'>): string {
  const purpose = bot.purpose.trim()
  return [
    `Você é ${bot.name}, um bot que trabalha dentro de um computador Linux próprio.`,
    purpose ? `Objetivo definido pela pessoa: ${purpose}` : 'A pessoa ainda não descreveu um objetivo específico; ajude com o que for pedido.',
    'Trabalhe somente no seu espaço de trabalho, explique o que está fazendo em linguagem simples e entregue resultados como arquivos quando fizer sentido.',
  ].join('\n')
}
/** Versioned snapshot the guest receives for a turn. Limits are explained, never silently truncated. */
export function buildSnapshot(input: {
  bot: Bot
  conversation: BotConversation
  turnId: string
  generation: number
  network: NetworkPolicy
  memory: BotMemory[]
  recent: BotMessage[]
  message: BotMessage
  leaseMs: number
  /** Remaining budget of a continued task; defaults to a fresh task budget. */
  limits?: TurnSnapshot['limits']
  /** Replaces the bot's own instructions for this turn only (team role, never persisted). */
  instructions?: string
  /**
   * Collaboration context of a team task. It is added only for a turn that belongs to a
   * team run and only when the guest announced the team capability; the caller is
   * responsible for passing an empty private memory and no private history alongside it.
   */
  team?: TeamTurnContext
  /** Permission ceiling agreed for this work; never wider than the bot's own mode. */
  permissionMode?: Bot['permissionMode']
}): TurnSnapshot {
  const active = input.memory.filter((m) => m.active)
  const memoryBytes = active.reduce((sum, m) => sum + Buffer.byteLength(m.content), 0)
  if (memoryBytes > MEMORY_ACTIVE_BUDGET)
    throw new HostError(
      'MEMORY_BUDGET_EXCEEDED',
      `A memória ativa do bot tem ${memoryBytes} bytes e o limite por tarefa é ${MEMORY_ACTIVE_BUDGET}. Desative ou resuma algumas memórias antes de continuar.`
    )
  if (!input.bot.model) throw new HostError('MODEL_UNRESOLVED', 'Conecte a conta de IA para escolher um modelo antes de enviar tarefas')
  return {
    botId: input.bot.id,
    conversationId: input.conversation.id,
    turnId: input.turnId,
    generation: input.generation,
    permissionMode: input.permissionMode ?? input.bot.permissionMode,
    policyRevision: input.network.revision,
    network: input.network,
    instructions: input.instructions?.trim() || input.bot.instructions.trim() || defaultInstructions(input.bot),
    memory: active.map((m) => ({ id: m.id, content: m.content })),
    contextSummary: input.conversation.contextSummary,
    recentMessages: input.recent
      .filter((m) => m.role !== 'system' && m.id !== input.message.id)
      .slice(-20)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    message: input.message.content,
    attachments: input.message.attachments.map((a) => a.path),
    model: { model: input.bot.model.model, ...(input.bot.model.effort ? { effort: input.bot.model.effort } : {}) },
    providerThreadId: input.conversation.providerThreadId,
    leaseMs: input.leaseMs,
    limits: input.limits ?? { activeMs: TURN_LIMITS.activeMs, maxTools: TURN_LIMITS.maxTools, maxLogBytes: TURN_LIMITS.maxLogBytes },
    ...(input.team ? { team: input.team } : {}),
  }
}
