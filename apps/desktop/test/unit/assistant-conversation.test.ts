import { beforeEach, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  conversations: new Map<string, Record<string, unknown>>(),
  created: 0,
  pinned: [] as string[],
}))

vi.mock('../../src/main/store', () => ({
  getAppSetting: (key: string) => h.settings.get(key) ?? null,
  setAppSetting: (key: string, value: string) => h.settings.set(key, value),
  getConversation: (id: string) => h.conversations.get(id),
  setConversationPinned: (id: string) => {
    h.pinned.push(id)
    return 1234
  },
}))
vi.mock('../../src/main/standalone-conversation-service', () => ({
  createStandaloneConversation: async (payload: { name?: string }) => {
    h.created += 1
    const conversation = {
      id: `chat-${h.created}`,
      scope: 'standalone',
      name: payload.name,
      archived: 0,
      cwd: `/chats/chat-${h.created}`,
    }
    h.conversations.set(conversation.id, conversation)
    return conversation
  },
}))

import {
  ensureAssistantConversation,
  getAssistantConversationId,
  isAssistantConversation,
  setAssistantConversationArchiver,
  startNewAssistantSession,
} from '../../src/main/assistant/assistant-conversation'
import { ASSISTANT_CONVERSATION_SETTING } from '../../src/shared/assistant'
import { setMainLocale } from '../../src/main/i18n'

beforeEach(() => {
  h.settings.clear()
  h.conversations.clear()
  h.created = 0
  h.pinned = []
  setMainLocale('en')
  setAssistantConversationArchiver(null)
})

it('creates the assistant once, pins it and reuses it', async () => {
  const first = await ensureAssistantConversation()
  const second = await ensureAssistantConversation()
  expect(second.id).toBe(first.id)
  expect(h.created).toBe(1)
  expect(h.pinned).toEqual([first.id])
  expect(first.name).toBe('Assistant')
  expect(h.settings.get(ASSISTANT_CONVERSATION_SETTING)).toBe(first.id)
})

it('shares one creation between concurrent callers', async () => {
  const [a, b] = await Promise.all([ensureAssistantConversation(), ensureAssistantConversation()])
  expect(a.id).toBe(b.id)
  expect(h.created).toBe(1)
})

it('names it in the active locale', async () => {
  setMainLocale('pt-BR')
  expect((await ensureAssistantConversation()).name).toBe('Assistente')
})

it('recreates the assistant when its conversation was archived or deleted', async () => {
  const first = await ensureAssistantConversation()
  h.conversations.set(first.id, { ...h.conversations.get(first.id), archived: 1 })
  expect(getAssistantConversationId()).toBeNull()
  const second = await ensureAssistantConversation()
  expect(second.id).not.toBe(first.id)
  h.conversations.delete(second.id)
  const third = await ensureAssistantConversation()
  expect(third.id).not.toBe(second.id)
})

it('does not take a project conversation as the assistant', async () => {
  h.conversations.set('project-1', { id: 'project-1', scope: 'project', archived: 0 })
  h.settings.set(ASSISTANT_CONVERSATION_SETTING, 'project-1')
  expect(getAssistantConversationId()).toBeNull()
  expect(isAssistantConversation('project-1')).toBe(false)
})

it('starts a new session by archiving the current conversation', async () => {
  const archived: string[] = []
  setAssistantConversationArchiver(async (id) => {
    archived.push(id)
    h.conversations.set(id, { ...h.conversations.get(id), archived: 1 })
  })
  const first = await ensureAssistantConversation()
  const next = await startNewAssistantSession()
  expect(archived).toEqual([first.id])
  expect(next.id).not.toBe(first.id)
  expect(getAssistantConversationId()).toBe(next.id)
})

it('refuses a new session before the archive path is wired', async () => {
  await ensureAssistantConversation()
  await expect(startNewAssistantSession()).rejects.toThrow(/archive/)
})

it('recognizes only the assistant conversation', async () => {
  const assistant = await ensureAssistantConversation()
  expect(isAssistantConversation(assistant.id)).toBe(true)
  expect(isAssistantConversation('other')).toBe(false)
  expect(isAssistantConversation(null)).toBe(false)
  expect(isAssistantConversation(undefined)).toBe(false)
})
