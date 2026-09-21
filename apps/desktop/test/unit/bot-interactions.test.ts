import { expect, it, vi } from 'vitest'

const questions = vi.hoisted(() => ({ pendingFor: vi.fn(), reply: vi.fn() }))
const chat = vi.hoisted(() => ({ stopBotChatTurn: vi.fn(async () => {}), acquireChatConversationSlot: vi.fn() }))
vi.mock('../../src/main/chat/service', () => ({
  getChatQuestionBroker: () => questions,
  stopBotChatTurn: chat.stopBotChatTurn,
  acquireChatConversationSlot: chat.acquireChatConversationSlot,
}))
vi.mock('../../src/main/chat/mcp', () => ({ listMcpServers: () => [] }))
import { NativeBotChatHost } from '../../src/main/bot/native-host'
import { BotModelCatalog } from '../../src/main/bot/catalog'

it('answers only an ordinary question that is pending in the same native conversation', async () => {
  questions.pendingFor.mockImplementation((id: string) => (id === 'own-conversation' ? ['ordinary-question'] : []))
  questions.reply.mockClear()
  const host = new NativeBotChatHost(new BotModelCatalog([]))
  await host.answer('own-conversation', 'ordinary-question', [['Blue']])
  expect(questions.reply).toHaveBeenCalledWith('ordinary-question', [['Blue']])
  await expect(host.answer('other-conversation', 'ordinary-question', [['Red']])).rejects.toThrow(/no longer pending/)
  await expect(host.answer('own-conversation', 'permission-request', [['allow']])).rejects.toThrow(/no longer pending/)
  expect(questions.reply).toHaveBeenCalledTimes(1)
})

it('rejects a stale question instead of treating it as a completed answer', async () => {
  questions.pendingFor.mockReturnValue([])
  questions.reply.mockClear()
  const host = new NativeBotChatHost(new BotModelCatalog([]))
  await expect(host.answer('conversation', 'already-answered', [['Yes']])).rejects.toThrow(/no longer pending/)
  expect(questions.reply).not.toHaveBeenCalled()
})

it('cancels only through the guard that protects a message the person sent', async () => {
  chat.stopBotChatTurn.mockClear()
  const host = new NativeBotChatHost(new BotModelCatalog([]))
  await host.stop('conversation')
  expect(chat.stopBotChatTurn).toHaveBeenCalledWith('conversation')
})

it('holds the chat slot from before the turn is configured until it is released', async () => {
  const release = vi.fn()
  const slot = { operation: { token: Symbol('slot') }, release }
  chat.acquireChatConversationSlot.mockClear().mockResolvedValue(slot)
  const host = new NativeBotChatHost(new BotModelCatalog([]))
  const signal = new AbortController().signal

  const letGo = await host.acquire('conversation', signal)
  expect(chat.acquireChatConversationSlot).toHaveBeenCalledWith('conversation', signal)
  letGo()
  expect(release).toHaveBeenCalledOnce()
})
