/**
 * A host turn (a fleet bot's command) reserves its conversation's slot before it configures the turn. These
 * exercise the rule that keeps that honest: the conversation runs one turn at a time, and whoever holds its
 * slot owns what runs in it.
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
import { acquireChatConversationSlot, disposeChat, registerChatIpc } from '../../src/main/chat/service'
import { addProvider } from '../../src/main/chat/catalog'
import { setApiKey } from '../../src/main/chat/credentials'
import { patchConvUiPrefs } from '../../src/main/store'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

type Handler = (event: any, ...args: any[]) => any

function register(): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  registerChatIpc({
    mhandle: (channel, fn) => void handlers.set(channel, fn as Handler),
    mon: (channel, fn) => void handlers.set(channel, fn as Handler),
    emitStatus: vi.fn(),
  } satisfies ChatIpcDeps)
  return handlers
}

/** A conversation with a usable BYOK account, so a send can actually start. */
function runnableConversation() {
  const conversation = makeConversation(makeWorkspace().id)
  const provider = addProvider({ name: 'Shared', baseURL: 'https://api.example.test/v1/', kind: 'openai' })
  setApiKey(provider.id, 'synthetic-key')
  patchConvUiPrefs(conversation.id, { chat: { providerId: provider.id, modelId: 'shared-model' } })
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

it('admits one turn at a time while a host turn holds the slot', async () => {
  const handlers = register()
  const conversation = runnableConversation()
  const slot = await acquireChatConversationSlot(conversation.id, new AbortController().signal)

  // The host holds the slot from before it configures its turn, so nothing of the person's starts under it.
  await expect(send(handlers, conversation.id, 'Mine.')).resolves.toEqual({ ok: false, error: 'busy' })

  slot.release()
  await expect(send(handlers, conversation.id, 'Mine.')).resolves.toEqual({ ok: true })
  await vi.waitFor(() => expect(h.runChat).toHaveBeenCalledTimes(1))
})

it('makes a second writer wait for the turn in flight, and give up when it is interrupted', async () => {
  const conversation = makeConversation(makeWorkspace().id)
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

  // Aborting the caller's signal ends the wait with it.
  const blocking = await acquireChatConversationSlot(conversation.id, new AbortController().signal)
  const interrupted = acquireChatConversationSlot(conversation.id, waiting.signal)
  waiting.abort()
  await expect(interrupted).rejects.toThrow(/interrupted/i)
  blocking.release()
})

it('gives up instead of waiting forever for a turn that never ends', async () => {
  const conversation = makeConversation(makeWorkspace().id)
  const held = await acquireChatConversationSlot(conversation.id, new AbortController().signal)

  await expect(acquireChatConversationSlot(conversation.id, new AbortController().signal, 0)).rejects.toThrow(
    /stayed busy/
  )
  held.release()
})
