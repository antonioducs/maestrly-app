import { expect, it } from 'vitest'
import {
  BOT_ACTIONS,
  BOT_MCP_PATH,
  BOT_WAIT_MAX_SECONDS,
  applyBotConversationEvent,
  botClaimSchema,
  botCommandSchema,
  botConnectionSchema,
  botConversationSchema,
  botMcpResource,
  botProtectedResourceMetadataUrl,
  botQuestionSchema,
  botSelectionSchema,
  parseBotCommandPayload,
  type BotConversationSnapshot,
} from '../src/bot-conversations.js'

const conversationId = '11111111-1111-4111-8111-111111111111'
const connectionId = '22222222-2222-4222-8222-222222222222'
const desktopId = '33333333-3333-4333-8333-333333333333'
const commandId = '44444444-4444-4444-8444-444444444444'
const messageId = '55555555-5555-4555-8555-555555555555'
const questionId = '66666666-6666-4666-8666-666666666666'

const selection = { selectionId: 'account-1/model-a' }
const conversation = {
  id: conversationId,
  connectionId,
  desktopId,
  workspaceId: 'workspace-local-1',
  name: 'Release notes',
  baseBranch: 'main',
  selection,
  managementState: 'active' as const,
  version: 1,
}
const command = {
  id: commandId,
  conversationId,
  kind: 'send' as const,
  payload: { text: 'hello' },
  status: 'queued' as const,
  version: 1,
}

it('keeps the bot audience separate from the REST and connector audiences', () => {
  expect(BOT_MCP_PATH).toBe('/mcp/bots')
  expect(botMcpResource('https://team.example/')).toBe('https://team.example/mcp/bots')
  expect(botMcpResource('https://team.example')).not.toBe('https://team.example/mcp')
  expect(botProtectedResourceMetadataUrl('https://team.example')).toBe(
    'https://team.example/.well-known/oauth-protected-resource/mcp/bots'
  )
  expect(BOT_WAIT_MAX_SECONDS).toBe(20)
})

it('describes a personal connection without any organization, project or runner', () => {
  const connection = botConnectionSchema.parse({
    id: connectionId,
    name: 'Grok',
    ownerUserId: 'user-1',
    desktopId,
    clientId: 'maestrly-bot-abc',
    grants: [{ workspaceId: 'workspace-local-1', actions: ['chats:read', 'chats:write'] }],
    revokedAt: null,
    version: 1,
  })
  expect(Object.keys(connection).sort()).toEqual([
    'clientId',
    'desktopId',
    'grants',
    'id',
    'name',
    'ownerUserId',
    'revokedAt',
    'version',
  ])
  // An organization or project id cannot be smuggled into the connection.
  expect(
    botConnectionSchema.safeParse({ ...connection, organizationId: '00000000-0000-4000-8000-000000000000' }).success
  ).toBe(false)
  expect(BOT_ACTIONS).toEqual(['chats:read', 'chats:write', 'chats:control', 'chats:answer'])
})

it('accepts an opaque workspace id and refuses an unknown selection field', () => {
  expect(botConversationSchema.parse({ ...conversation, workspaceId: 'ws_7f3' }).workspaceId).toBe('ws_7f3')
  expect(botSelectionSchema.safeParse({ selectionId: 'a', reasoning: null, mode: 'plan' }).success).toBe(true)
  expect(botSelectionSchema.safeParse({ selectionId: 'a', mode: 'design' }).success).toBe(false)
  expect(botSelectionSchema.safeParse({ selectionId: 'a', permissionMode: 'yolo' }).success).toBe(false)
  expect(botSelectionSchema.safeParse({ mode: 'agent' }).success).toBe(false)
})

it('validates each command payload against its own kind', () => {
  expect(parseBotCommandPayload('send', { text: 'ship it' })).toEqual({ text: 'ship it' })
  expect(() => parseBotCommandPayload('send', { text: '' })).toThrow()
  expect(() => parseBotCommandPayload('answer', { questionId, answers: [] })).toThrow()
  expect(parseBotCommandPayload('answer', { questionId, answers: [['yes']] })).toEqual({
    questionId,
    answers: [['yes']],
  })
  expect(() => parseBotCommandPayload('configure', {})).toThrow()
  expect(parseBotCommandPayload('configure', { selection: { mode: 'ask' } })).toEqual({ selection: { mode: 'ask' } })
  expect(parseBotCommandPayload('cancel', {})).toEqual({})
  expect(() => parseBotCommandPayload('cancel', { force: true })).toThrow()
  const create = {
    workspaceId: conversation.workspaceId,
    name: conversation.name,
    baseBranch: conversation.baseBranch,
    selection,
  }
  expect(parseBotCommandPayload('create', create)).toMatchObject({
    workspaceId: 'workspace-local-1',
    baseBranch: 'main',
    message: null,
  })
  // A create payload carries no server-owned identity: the server mints the conversation.
  expect(() => parseBotCommandPayload('create', { ...create, id: conversationId })).toThrow()
})

it('never carries a lease token in a command a bot can see, and always carries one on a claim', () => {
  expect(botCommandSchema.parse(command).leaseToken).toBeUndefined()
  const claim = botClaimSchema.parse({
    owner: { userId: 'user-1' },
    connection: {
      id: connectionId,
      name: 'Grok',
      ownerUserId: 'user-1',
      desktopId,
      clientId: 'maestrly-bot-abc',
      grants: [{ workspaceId: 'workspace-local-1', actions: ['chats:write'] }],
      revokedAt: null,
      version: 1,
    },
    conversation,
    command: { ...command, leaseToken: '77777777-7777-4777-8777-777777777777' },
    leaseExpiresAt: '2026-09-20T12:00:00.000Z',
    fence: 3,
  })
  expect(claim.command.leaseToken).toBe('77777777-7777-4777-8777-777777777777')
  expect(claim.owner.userId).toBe('user-1')
  expect(botClaimSchema.safeParse({ ...claim, fence: 0 }).success).toBe(false)
})

it('only models ordinary questions, never a permission prompt or a plan approval', () => {
  const question = {
    id: questionId,
    conversationId,
    commandId,
    questions: [{ question: 'Which branch should I target?', options: [] }],
    state: 'pending' as const,
    answers: null,
    createdAt: '2026-09-20T12:00:00.000Z',
  }
  expect(botQuestionSchema.parse(question).state).toBe('pending')
  expect(botQuestionSchema.safeParse({ ...question, type: 'permission' }).success).toBe(false)
  expect(botQuestionSchema.safeParse({ ...question, decision: { type: 'plan', action: 'approve' } }).success).toBe(
    false
  )
})

it('applies relayed events in order and refuses a gap', () => {
  const snapshot: BotConversationSnapshot = {
    conversation,
    messages: [],
    questions: [],
    pendingCommand: null,
    cursor: 0,
  }
  const started = applyBotConversationEvent(snapshot, {
    version: 1,
    conversationId,
    sequence: 1,
    eventId: 'a',
    payload: {
      type: 'message',
      message: {
        id: messageId,
        conversationId,
        commandId,
        role: 'assistant',
        parts: [],
        createdAt: '2026-09-20T12:00:00.000Z',
      },
    },
  })
  expect(started.cursor).toBe(1)
  const streamed = applyBotConversationEvent(started, {
    version: 1,
    conversationId,
    sequence: 2,
    eventId: 'b',
    payload: { type: 'delta', messageId, partId: 'p1', kind: 'text', delta: 'Hello' },
  })
  const continued = applyBotConversationEvent(streamed, {
    version: 1,
    conversationId,
    sequence: 3,
    eventId: 'c',
    payload: { type: 'delta', messageId, partId: 'p1', kind: 'text', delta: ' there' },
  })
  expect(continued.messages[0]!.parts).toEqual([{ id: 'p1', type: 'text', text: 'Hello there' }])
  // A replayed event changes nothing; a missing one is reported instead of silently applied.
  expect(applyBotConversationEvent(continued, {
    version: 1,
    conversationId,
    sequence: 3,
    eventId: 'c',
    payload: { type: 'delta', messageId, partId: 'p1', kind: 'text', delta: ' again' },
  })).toBe(continued)
  expect(() =>
    applyBotConversationEvent(continued, {
      version: 1,
      conversationId,
      sequence: 5,
      eventId: 'e',
      payload: { type: 'conversation', conversation },
    })
  ).toThrow(/gap/)
  const finished = applyBotConversationEvent(continued, {
    version: 1,
    conversationId,
    sequence: 4,
    eventId: 'd',
    payload: { type: 'command', command: { ...command, status: 'succeeded' } },
  })
  expect(finished.pendingCommand).toBeNull()
})
