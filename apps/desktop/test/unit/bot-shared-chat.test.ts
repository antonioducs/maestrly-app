/**
 * A released bot chat has two writers. These exercise the one rule that keeps that honest: the
 * conversation runs one turn at a time, and whoever holds its slot owns what runs in it.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  webContents: { isDestroyed: () => false, send: vi.fn() },
  runChat: vi.fn(),
}))
vi.mock('../../src/main/window-ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/window-ipc')>()),
  getMainWebContents: () => h.webContents,
  broadcast: vi.fn(),
}))
vi.mock('../../src/main/chat/runner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/chat/runner')>()),
  runChat: h.runChat,
}))
vi.mock('../../src/main/chat/virtual-subagents', () => ({ listEffectiveAgents: vi.fn(async () => []) }))

import type { ChatIpcDeps } from '../../src/main/chat/service'
import {
  acquireChatConversationSlot,
  activeTurnIsBotOwned,
  disposeChat,
  registerChatIpc,
  stopBotChatTurn,
} from '../../src/main/chat/service'
import { addProvider } from '../../src/main/chat/catalog'
import { setApiKey } from '../../src/main/chat/credentials'
import { setBotManagementState, setBotManualChatEnabled } from '../../src/main/bot/store'
import { getDb, patchConvUiPrefs } from '../../src/main/store'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

type Handler = (event: any, ...args: any[]) => any

const ORIGIN = JSON.stringify({ kind: 'bot', connectionId: 'grok-connection', botName: 'Grok Bot' })

function register(): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  registerChatIpc({
    mhandle: (channel, fn) => void handlers.set(channel, fn as Handler),
    mon: (channel, fn) => void handlers.set(channel, fn as Handler),
    emitStatus: vi.fn(),
  } satisfies ChatIpcDeps)
  return handlers
}

/** A bot chat the bot still holds, with a usable BYOK account so a send can actually start. */
function botConversation({ released = false, runnable = false } = {}) {
  const conversation = makeConversation(makeWorkspace().id)
  getDb()
    .prepare("UPDATE conversations SET bot_origin=?,bot_management_state='active' WHERE id=?")
    .run(ORIGIN, conversation.id)
  if (released) setBotManualChatEnabled(conversation.id, true)
  if (runnable) {
    const provider = addProvider({ name: 'Shared', baseURL: 'https://api.example.test/v1/', kind: 'openai' })
    setApiKey(provider.id, 'synthetic-key')
    patchConvUiPrefs(conversation.id, { chat: { providerId: provider.id, modelId: 'shared-model' } })
  }
  return conversation
}

const send = (handlers: Map<string, Handler>, conversationId: string, text: string) =>
  handlers.get('chat:send')!({ sender: h.webContents }, { conversationId, text })

beforeEach(() => {
  freshDb()
  vi.clearAllMocks()
  h.runChat.mockResolvedValue({ planSubmitted: false })
})
afterEach(async () => {
  await disposeChat()
  closeDb()
})

it('refuses what the person writes until they release the chat, without moving the bot out of it', async () => {
  const handlers = register()
  const conversation = botConversation()

  await expect(send(handlers, conversation.id, 'My own instruction.')).resolves.toEqual({
    ok: false,
    error: 'Release this chat for your own messages before sending here.',
  })
  await expect(
    handlers.get('chat:resend')!(
      { sender: h.webContents },
      { conversationId: conversation.id, fromMessageId: 'x', text: 'edit' }
    )
  ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('Release this chat') })

  setBotManualChatEnabled(conversation.id, true)

  // Past the bot gate now: it stops for the ordinary reason a chat without a usable account stops.
  await expect(send(handlers, conversation.id, 'My own instruction.')).resolves.toEqual({
    ok: false,
    error: 'no-key',
  })
  // Releasing is not a pause: the bot still holds the chat.
  expect(
    getDb().prepare('SELECT bot_management_state AS state FROM conversations WHERE id=?').get(conversation.id)
  ).toMatchObject({ state: 'active' })
})

it('keeps a paused chat working the way it always did', async () => {
  const handlers = register()
  const conversation = botConversation()
  setBotManagementState(conversation.id, 'paused')

  await expect(send(handlers, conversation.id, 'Mine now.')).resolves.toEqual({ ok: false, error: 'no-key' })
})

it('admits one turn at a time when the bot and the person write together', async () => {
  const handlers = register()
  const conversation = botConversation({ released: true, runnable: true })
  const slot = await acquireChatConversationSlot(conversation.id, new AbortController().signal)

  // The bot holds the slot from before it configures its turn, so nothing of the person's starts under it.
  await expect(send(handlers, conversation.id, 'Mine.')).resolves.toEqual({ ok: false, error: 'busy' })

  slot.release()
  await expect(send(handlers, conversation.id, 'Mine.')).resolves.toEqual({ ok: true })
  await vi.waitFor(() => expect(h.runChat).toHaveBeenCalledTimes(1))
})

it('makes a bot command wait for the turn the person started, and give up when it is interrupted', async () => {
  const conversation = botConversation({ released: true })
  const held = await acquireChatConversationSlot(conversation.id, new AbortController().signal)

  const waiting = new AbortController()
  let granted = false
  const pending = acquireChatConversationSlot(conversation.id, waiting.signal).then((slot) => {
    granted = true
    return slot
  })
  await new Promise((resolve) => setTimeout(resolve, 400))
  expect(granted, 'the second writer must not be admitted while the first holds the chat').toBe(false)

  held.release()
  ;(await pending).release()
  expect(granted).toBe(true)

  // A pause, a revocation, an expired lease or Stop aborts the command; the wait ends with it.
  const blocking = await acquireChatConversationSlot(conversation.id, new AbortController().signal)
  const interrupted = acquireChatConversationSlot(conversation.id, waiting.signal)
  waiting.abort()
  await expect(interrupted).rejects.toThrow(/interrupted/i)
  blocking.release()
})

it('gives up instead of waiting forever for a turn that never ends', async () => {
  const conversation = botConversation({ released: true })
  const held = await acquireChatConversationSlot(conversation.id, new AbortController().signal)

  await expect(acquireChatConversationSlot(conversation.id, new AbortController().signal, 0)).rejects.toThrow(
    /stayed busy/
  )
  held.release()
})

it('refuses to let a bot cancel a message the person sent in a released chat', async () => {
  const handlers = register()
  const conversation = botConversation({ released: true, runnable: true })
  let finish!: () => void
  h.runChat.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ planSubmitted: false })
      })
  )

  await expect(send(handlers, conversation.id, 'Mine, and only mine to stop.')).resolves.toEqual({ ok: true })
  await vi.waitFor(() => expect(h.runChat).toHaveBeenCalledTimes(1))
  expect(activeTurnIsBotOwned(conversation.id)).toBe(false)

  // What bot_cancel_turn reaches. The person's turn is not the bot's to take down.
  await expect(stopBotChatTurn(conversation.id)).rejects.toThrow(/did not stop it/)
  expect(h.webContents.send).not.toHaveBeenCalledWith(`chat:delta:${conversation.id}`, { kind: 'aborted' })

  finish()
  // With nothing running, cancelling is the no-op it always was.
  await vi.waitFor(() => stopBotChatTurn(conversation.id))
})

it('refuses to steer the turn a bot is running, and stops without taking the chat back', async () => {
  const handlers = register()
  const conversation = botConversation({ released: true })

  await expect(
    handlers.get('chat:steer')!({ sender: h.webContents }, conversation.id, 'sneak this in', 'client-message-1')
  ).resolves.toMatchObject({ ok: false })

  // Stop in a released chat is only Stop: it does not hand the chat back the way pausing does.
  handlers.get('chat:stop')!({ sender: h.webContents }, conversation.id)
  expect(
    getDb().prepare('SELECT bot_management_state AS state FROM conversations WHERE id=?').get(conversation.id)
  ).toMatchObject({ state: 'active' })

  // A chat that was never released keeps the old behavior: stopping takes it back from the bot.
  const exclusive = botConversation()
  handlers.get('chat:stop')!({ sender: h.webContents }, exclusive.id)
  expect(
    getDb().prepare('SELECT bot_management_state AS state FROM conversations WHERE id=?').get(exclusive.id)
  ).toMatchObject({ state: 'paused' })
})
