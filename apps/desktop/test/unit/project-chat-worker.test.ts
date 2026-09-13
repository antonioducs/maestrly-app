import { beforeEach, afterEach, expect, it } from 'vitest'
import { freshDb, closeDb } from '../helpers/db'
import { makeWorkspace, makeConversation } from '../helpers/factories'
import {
  admitChatTurn,
  queueChatEvent,
  chatOutbox,
  ackChatEvents,
  pendingChatTurns,
  bindChatConversation,
  chatConversation,
} from '../../src/main/platform/project-chat-store'
import { publicChatText } from '../../src/main/platform/project-chat-projection'
import { projectChatPreferences, projectChatContextText } from '../../src/main/platform/project-chat-worker'
import { desktopExecutorSettingsSchema } from '../../src/main/platform/executor-settings'
beforeEach(freshDb)
afterEach(closeDb)
it('journals admission and unacknowledged events and reuses the native conversation identity', () => {
  const conv = makeConversation(makeWorkspace().id)
  bindChatConversation('instance', 'remote', conv.id)
  expect(chatConversation('instance', 'remote')).toBe(conv.id)
  expect(chatConversation('another-instance', 'remote')).toBeNull()
  expect(admitChatTurn('instance', 'turn', 'lease')).toBe(true)
  expect(admitChatTurn('instance', 'turn', 'lease')).toBe(false)
  const message = {
    id: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    role: 'assistant' as const,
    createdAt: new Date().toISOString(),
    parts: [],
  }
  queueChatEvent('turn', { eventId: 'durable-event', payload: { type: 'message', message } })
  const first = chatOutbox('turn')
  expect(chatOutbox('turn')).toEqual(first)
  expect(pendingChatTurns('instance')).toHaveLength(1)
  ackChatEvents(['durable-event'])
  expect(chatOutbox('turn')).toEqual([])
})
it('redacts structured credentials and bounds tool results', () => {
  expect(
    publicChatText({ token: 'private', nested: { password: 'secret' }, text: 'Bearer abcdef0123456789' })
  ).not.toMatch(/private|secret|abcdef/)
  expect(publicChatText('x'.repeat(100), 20)).toContain('[truncated]')
})

it('maps persisted web settings to native preferences for every turn', () => {
  const settings = desktopExecutorSettingsSchema.parse({
    providerIds: ['provider'],
    allowAppTools: true,
    allowMcp: false,
    skills: true,
  })
  expect(
    projectChatPreferences({ mode: 'agent', reasoning: 'high', fastMode: true, permMode: 'full' }, settings, [
      'private-mcp',
    ])
  ).toMatchObject({
    mode: 'agent',
    reasoning: 'high',
    fastMode: true,
    permMode: 'full',
    tools: { app: true, mcpDisabled: ['private-mcp'] },
  })
  expect(
    projectChatPreferences({ mode: 'chat', reasoning: null, fastMode: false, permMode: 'ask' }, settings, [])
  ).toMatchObject({ mode: 'ask', reasoning: 'off', fastMode: false, permMode: 'ask' })
})

it('instructs project chat to execute authorized changes with discovered IDs and verify persisted state', () => {
  const prompt = projectChatContextText({ projectId: 'project', boardId: 'board', cardId: 'card', baseBranch: 'main' })
  expect(prompt).toContain('Project: project. Board context: board. Card context: card. Code base: main.')
  expect(prompt).toContain('perform the actual mutation with the scoped board tools')
  expect(prompt).toContain('Read current records and versions')
  expect(prompt).toContain('board_automation_catalog')
  expect(prompt).toContain('reuse it on retries')
  expect(prompt).toContain('In Ask or Plan mode, inspect and explain only; mutations are denied')
  expect(prompt).toContain('Verify persisted state with the read tools before reporting completion')
  expect(prompt).toContain('Never assume a completed answer means a card is done')
})
