import type { BotSelection } from '@maestrly/protocol'
import { createHash } from 'node:crypto'
import { patchConvUiPrefs, getConversation, getConvUiPrefs } from '../store'
import { observeChatHost } from '../chat/host-events'
import { listMcpServers } from '../chat/mcp'
import { registerRemoteChatPolicy, withRemoteChatPolicy, type RemoteChatPolicy } from '../chat/remote-policy'
import type { BotNativeHost } from './worker'
import type { BotModelCatalog } from './catalog'
import type { ChatConversationSlot } from '../chat/service'

/** Adapts the existing native chat runtime; no web-chat projection or Kanban prompt is installed. */
export class NativeBotChatHost implements BotNativeHost {
  /** Slot of the command running in each conversation, held from configure until the turn ends. */
  private readonly slots = new Map<string, ChatConversationSlot>()

  constructor(private readonly catalog: BotModelCatalog) {}

  async acquire(conversationId: string, signal: AbortSignal): Promise<() => void> {
    const { acquireChatConversationSlot } = await import('../chat/service')
    const slot = await acquireChatConversationSlot(conversationId, signal)
    this.slots.set(conversationId, slot)
    return () => {
      if (this.slots.get(conversationId) === slot) this.slots.delete(conversationId)
      slot.release()
    }
  }

  async configure(conversationId: string, selection: BotSelection): Promise<void> {
    const model = await this.catalog.resolve(selection)
    const { primeChatTurnSelection, publishConvChatSettings } = await import('../chat/service')
    primeChatTurnSelection(conversationId, {
      providerId: model.providerId,
      modelId: model.modelId,
      reasoning: selection.reasoning ?? undefined,
      fastMode: selection.fastMode,
    })
    patchConvUiPrefs(conversationId, {
      chat: {
        ...getConvUiPrefs(conversationId).chat,
        mode: selection.mode ?? 'agent',
        // Never the bot's own word: the catalog already capped it at the ceiling the person chose.
        permMode: model.permissionMode,
        tools: { app: true, mcpDisabled: listMcpServers().map((server) => server.id), imageGen: false },
      },
    })
    // The person may be watching this conversation: the composer has to show what the bot just set.
    publishConvChatSettings(conversationId)
  }

  async start(input: Parameters<BotNativeHost['start']>[0]): ReturnType<BotNativeHost['start']> {
    input.assertCurrent()
    const conversation = getConversation(input.conversationId)
    if (!conversation?.botOrigin || conversation.botOrigin.connectionId !== input.identity.connectionId)
      throw new Error('The bot conversation belongs to another connection.')
    const model = await this.catalog.resolve(input.selection)
    input.assertCurrent()
    const policy: RemoteChatPolicy = {
      conversationId: conversation.id,
      cwd: conversation.cwd,
      mode: input.selection.mode ?? 'agent',
      permMode: model.permissionMode,
      providerIds: [model.providerId],
      allowCommands: true,
      allowWeb: true,
      allowAppTools: true,
      allowMcp: false,
      allowPush: false,
    }
    const release = registerRemoteChatPolicy(policy)
    try {
      const { startExecutorChatTurn } = await import('../chat/service')
      const turn = await withRemoteChatPolicy(policy, () =>
        startExecutorChatTurn({
          conversationId: conversation.id,
          prompt: input.prompt,
          signal: input.signal,
          remoteAdmission: true,
          // The turn inherits the slot this command already holds; it is never reserved twice.
          ...(this.slots.get(conversation.id) ? { slot: this.slots.get(conversation.id) } : {}),
          botAdmission: {
            connectionId: input.identity.connectionId,
            botName: input.identity.botName,
            commandId: createHash('sha256')
              .update(`${input.identity.instanceId}:${input.identity.connectionId}:${input.commandId}`)
              .digest('hex'),
            providerId: model.providerId,
            modelId: model.modelId,
            assertCurrent: input.assertCurrent,
          },
        })
      )
      return { done: turn.done.finally(release), cancel: () => turn.cancel() }
    } catch (error) {
      release()
      throw error
    }
  }

  observe = observeChatHost

  async answer(conversationId: string, requestId: string, answers: string[][]): Promise<void> {
    const { getChatQuestionBroker } = await import('../chat/service')
    const broker = getChatQuestionBroker()
    if (!broker.pendingFor(conversationId).includes(requestId))
      throw new Error('This ordinary question is no longer pending in the bot conversation.')
    broker.reply(requestId, answers)
  }

  /** A bot cancels its own turn. A message the person sent in a released chat is theirs to stop. */
  async stop(conversationId: string): Promise<void> {
    const { stopBotChatTurn } = await import('../chat/service')
    await stopBotChatTurn(conversationId)
  }
}
