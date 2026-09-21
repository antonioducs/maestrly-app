import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { BotClaim, BotConversationSnapshot, BotInventory, BotWaitResult } from '@maestrly/protocol'
import { closeDb, freshDb, restartDb } from '../helpers/db'
import { getDb } from '../../src/main/store'
import { upsertChatMessage } from '../../src/main/chat/chat-store'
import { LocalBotService } from '../../src/main/bot/local-service'
import { LocalBotTransport } from '../../src/main/bot/local-transport'
import { bindBotConversation, reserveBotConversation } from '../../src/main/bot/store'
import { makeConversation, makeWorkspace } from '../helpers/factories'

beforeEach(freshDb)
afterEach(closeDb)

it('keeps a bot at the ceiling the person chose, and at the strictest one when none was saved', () => {
  const { service, connection } = setup()
  // Nothing was chosen for this one, so it asks about everything rather than assuming permission.
  expect(connection.permissionCeiling).toBe('ask')

  const chosen = service.createConnection({
    name: 'Approving bot',
    workspaceIds: [WORKSPACE],
    providerIds: ['provider'],
    permissionCeiling: 'auto',
  })
  expect(chosen.permissionCeiling).toBe('auto')
  expect(service.connections().find((item) => item.id === chosen.id)?.permissionCeiling).toBe('auto')

  // Moving it is a new version, so a command claimed under the old one is fenced out.
  const widened = service.setPermissionCeiling(chosen.id, 'full')
  expect(widened.permissionCeiling).toBe('full')
  expect(widened.version).toBeGreaterThan(chosen.version)
  // Choosing what is already in force changes nothing, including the version a bot is checked against.
  expect(service.setPermissionCeiling(chosen.id, 'full').version).toBe(widened.version)

  service.revokeConnection(chosen.id)
  expect(() => service.setPermissionCeiling(chosen.id, 'ask')).toThrow(/revoked/i)
})

it('reads a ceiling it does not recognize as the strictest one', () => {
  const { service, connection } = setup()
  // Whatever wrote this, it is not a choice this application offers, so it grants nothing extra.
  getDb().prepare("UPDATE bot_local_connections SET permission_ceiling='everything' WHERE id=?").run(connection.id)
  expect(service.connections().find((item) => item.id === connection.id)?.permissionCeiling).toBe('ask')
})

it('adds the ceiling to a bot store that predates it, leaving its bots asking', () => {
  const { connection } = setup()
  // Exactly what an installation from before this choice holds on disk: the column does not exist.
  getDb().exec('ALTER TABLE bot_local_connections DROP COLUMN permission_ceiling;')
  restartDb()
  const service = new LocalBotService()
  expect(service.connections().find((item) => item.id === connection.id)?.permissionCeiling).toBe('ask')
  // The saved connection survived the migration intact; only the new choice was added to it.
  expect(service.requireConnection(connection.id).name).toBe('Grok Bot')
})

it('rechecks grants before returning an idempotent result', async () => {
  const { service, connection } = setup()
  const key = randomUUID()
  await createChat(service, connection.id, { idempotencyKey: key })
  service.setGrants(connection.id, [])
  await expect(createChat(service, connection.id, { idempotencyKey: key })).rejects.toThrow(/grant/i)
})

const signal = new AbortController().signal
const WORKSPACE = 'workspace-1'

function inventory(workspaceId = WORKSPACE): BotInventory {
  return {
    capability: 'bot:conversations:v1',
    enabled: true,
    workspaces: [{ workspaceId, label: 'Project', branches: ['main'], defaultBranch: 'main' }],
    selections: [
      {
        selectionId: 'model',
        label: 'Model',
        providerLabel: 'Provider',
        reasoningEfforts: [],
        fastMode: false,
        modes: ['agent'],
        permissionModes: ['ask'],
      },
    ],
  }
}

interface Created {
  conversation: { id: string }
  command: { id: string }
}

function setup(clock?: () => number, name = 'Grok Bot') {
  const service = new LocalBotService(clock)
  const connection = service.createConnection({
    name,
    workspaceIds: [WORKSPACE],
    providerIds: ['provider'],
  })
  service.saveInventory(connection.id, inventory())
  return { service, connection, transport: new LocalBotTransport(service, connection.id) }
}

function createChat(service: LocalBotService, connectionId: string, overrides: Record<string, unknown> = {}) {
  return service.callTool(
    connectionId,
    'bot_create_chat',
    {
      workspaceId: WORKSPACE,
      name: 'Work',
      baseBranch: 'main',
      selection: { selectionId: 'model' },
      message: 'Hello',
      idempotencyKey: randomUUID(),
      ...overrides,
    },
    signal
  ) as Promise<Created>
}

const finish = (claim: BotClaim, status: 'succeeded' | 'failed' | 'cancelled' = 'succeeded') => ({
  leaseToken: claim.command.leaseToken!,
  fence: claim.fence,
  status,
  error: null,
})

it('runs a created chat once and shows the bot the transcript it produced', async () => {
  const { service, connection, transport } = setup()
  const created = await createChat(service, connection.id)
  const claim = await transport.claim()
  expect(claim?.command.kind).toBe('create')
  expect(claim?.connection.grants[0]?.workspaceId).toBe(WORKSPACE)
  expect(claim?.conversation.id).toBe(created.conversation.id)
  await transport.upload(claim!, [
    {
      eventId: 'message-1',
      payload: {
        type: 'message',
        message: {
          id: randomUUID(),
          conversationId: created.conversation.id,
          commandId: created.command.id,
          role: 'assistant',
          parts: [{ id: 'text', type: 'text', text: 'Done.' }],
          createdAt: new Date().toISOString(),
        },
      },
    },
  ])
  await transport.complete(claim!, finish(claim!))
  const snapshot = (await service.callTool(
    connection.id,
    'bot_read_chat',
    { conversationId: created.conversation.id },
    signal
  )) as BotConversationSnapshot
  expect(snapshot.messages.map((message) => message.parts[0])).toEqual([{ id: 'text', type: 'text', text: 'Done.' }])
  expect(snapshot.pendingCommand).toBeNull()
  expect(await transport.claim()).toBeNull()
  const waited = (await service.callTool(
    connection.id,
    'bot_wait_events',
    { conversationId: created.conversation.id, cursor: 0, timeoutSeconds: 0 },
    signal
  )) as BotWaitResult
  expect(waited.timedOut).toBe(false)
  expect(waited.cursor).toBe(snapshot.cursor)
  expect(waited.events.map((event) => event.payload.type)).toContain('message')
})

it('replays a retried tool call and refuses a reused key with different content', async () => {
  const { service, connection } = setup()
  const idempotencyKey = randomUUID()
  const first = await createChat(service, connection.id, { idempotencyKey })
  const replay = await createChat(service, connection.id, { idempotencyKey })
  expect(replay.conversation.id).toBe(first.conversation.id)
  expect(replay.command.id).toBe(first.command.id)
  const listed = (await service.callTool(connection.id, 'bot_list_chats', {}, signal)) as {
    conversations: unknown[]
  }
  expect(listed.conversations).toHaveLength(1)
  await expect(createChat(service, connection.id, { idempotencyKey, name: 'Other' })).rejects.toThrow(/idempotency key/)
})

it('reclaims an expired lease under a higher fence and refuses the fenced holder', async () => {
  let now = Date.now()
  const { service, connection, transport } = setup(() => now)
  await createChat(service, connection.id)
  const first = await transport.claim()
  expect(first?.fence).toBe(1)
  now += 61_000
  const second = await transport.claim()
  expect(second?.command.id).toBe(first?.command.id)
  expect(second?.fence).toBe(2)
  await expect(transport.lease(first!)).rejects.toThrow(/lease is no longer valid/)
  await expect(transport.complete(first!, finish(first!))).rejects.toThrow(/lease is no longer valid/)
  await expect(transport.upload(first!, [])).rejects.toThrow(/lease is no longer valid/)
  await transport.complete(second!, finish(second!))
  expect(await transport.claim()).toBeNull()
})

it('keeps the commands of a chat serial and admits a cancel in its own lane', async () => {
  const { service, connection, transport } = setup()
  const created = await createChat(service, connection.id)
  const running = await transport.claim()
  expect(running?.command.kind).toBe('create')
  await service.callTool(
    connection.id,
    'bot_send_message',
    { conversationId: created.conversation.id, text: 'And then this', idempotencyKey: randomUUID() },
    signal
  )
  expect(await transport.claim()).toBeNull()
  expect((await transport.controls(running!)).cancellationRequested).toBe(false)
  await service.callTool(
    connection.id,
    'bot_cancel_turn',
    { conversationId: created.conversation.id, idempotencyKey: randomUUID() },
    signal
  )
  const cancel = await transport.claim()
  expect(cancel?.command.kind).toBe('cancel')
  expect((await transport.controls(running!)).cancellationRequested).toBe(true)
  await transport.complete(cancel!, finish(cancel!))
  await transport.complete(running!, finish(running!, 'cancelled'))
  const next = await transport.claim()
  expect(next?.command.kind).toBe('send')
  expect(next?.command.payload.text).toBe('And then this')
})

it('answers only a pending question raised by the turn that is running', async () => {
  const { service, connection, transport } = setup()
  const created = await createChat(service, connection.id)
  const turn = await transport.claim()
  const questionId = randomUUID()
  await transport.upload(turn!, [
    {
      eventId: 'question-1',
      payload: {
        type: 'question',
        question: {
          id: questionId,
          conversationId: created.conversation.id,
          commandId: created.command.id,
          questions: [{ question: 'Which branch?', options: [{ label: 'main' }] }],
          state: 'pending',
          answers: null,
          createdAt: new Date().toISOString(),
        },
      },
    },
  ])
  await service.callTool(
    connection.id,
    'bot_answer_question',
    {
      conversationId: created.conversation.id,
      questionId,
      answers: [['main']],
      idempotencyKey: randomUUID(),
    },
    signal
  )
  const answer = await transport.claim()
  expect(answer?.command.kind).toBe('answer')
  await transport.complete(answer!, finish(answer!))
  const snapshot = (await service.callTool(
    connection.id,
    'bot_read_chat',
    { conversationId: created.conversation.id },
    signal
  )) as BotConversationSnapshot
  expect(snapshot.questions[0]?.state).toBe('answered')
  expect(snapshot.questions[0]?.answers).toEqual([['main']])
  await expect(
    service.callTool(
      connection.id,
      'bot_answer_question',
      {
        conversationId: created.conversation.id,
        questionId,
        answers: [['main']],
        idempotencyKey: randomUUID(),
      },
      signal
    )
  ).rejects.toThrow(/already answered or expired/)
})

it('stops admitting work once the grant is narrowed and once the connection is revoked', async () => {
  const { service, connection, transport } = setup()
  const created = await createChat(service, connection.id)
  service.setGrants(connection.id, [])
  expect(await transport.claim()).toBeNull()
  await expect(
    service.callTool(
      connection.id,
      'bot_send_message',
      { conversationId: created.conversation.id, text: 'Anything', idempotencyKey: randomUUID() },
      signal
    )
  ).rejects.toThrow(/grant was changed or revoked/)
  service.revokeConnection(connection.id)
  expect(service.requireConnection(connection.id).revokedAt).not.toBeNull()
  await expect(service.callTool(connection.id, 'bot_list_chats', {}, signal)).rejects.toThrow(/revoked/)
  expect(await transport.claim()).toBeNull()
})

it('leaves a paused chat untouched until its owner resumes it', async () => {
  const { service, connection, transport } = setup()
  const created = await createChat(service, connection.id)
  service.setManagement(created.conversation.id, 'paused')
  expect(await transport.claim()).toBeNull()
  await expect(
    service.callTool(
      connection.id,
      'bot_send_message',
      { conversationId: created.conversation.id, text: 'Keep going', idempotencyKey: randomUUID() },
      signal
    )
  ).rejects.toThrow(/paused/)
  service.setManagement(created.conversation.id, 'active')
  expect((await transport.claim())?.command.kind).toBe('create')
  service.setManagement(created.conversation.id, 'revoked')
  expect(() => service.setManagement(created.conversation.id, 'active')).toThrow(/revoked chat cannot be reactivated/)
})

it('never hands one bot connection the work or the chats of another', async () => {
  const first = setup(undefined, 'First bot')
  const second = setup(undefined, 'Second bot')
  const chat = await createChat(first.service, first.connection.id)
  expect(await second.transport.claim()).toBeNull()
  expect((await first.transport.claim())?.connection.id).toBe(first.connection.id)
  await expect(
    second.service.callTool(second.connection.id, 'bot_read_chat', { conversationId: chat.conversation.id }, signal)
  ).rejects.toThrow(/Conversation not found/)
  const listed = (await second.service.callTool(second.connection.id, 'bot_list_chats', {}, signal)) as {
    conversations: unknown[]
  }
  expect(listed.conversations).toHaveLength(0)
})

it('reads the chat on this computer back to the bot, page by page, and only its own', async () => {
  const workspace = makeWorkspace()
  const service = new LocalBotService()
  const connection = service.createConnection({
    name: 'Grok Bot',
    workspaceIds: [workspace.id],
    providerIds: ['provider'],
  })
  service.saveInventory(connection.id, inventory(workspace.id))
  const created = (await service.callTool(
    connection.id,
    'bot_create_chat',
    {
      workspaceId: workspace.id,
      name: 'Work',
      baseBranch: 'main',
      selection: { selectionId: 'model' },
      idempotencyKey: randomUUID(),
    },
    signal
  )) as Created
  const history = (cursor?: string | null) =>
    service.callTool(
      connection.id,
      'bot_read_chat_history',
      { conversationId: created.conversation.id, limit: 1, ...(cursor ? { cursor } : {}) },
      signal
    ) as Promise<{ messages: Array<{ text: string; botName?: string }>; nextCursor: string | null; hasMore: boolean }>

  // The chat exists for the bot, but nothing on this computer has been allocated for it yet.
  await expect(history()).rejects.toThrow(/nothing to read back/)

  const conversation = makeConversation(workspace.id)
  const allocationId = randomUUID()
  reserveBotConversation({
    instanceId: 'local',
    ownerUserId: connection.ownerUserId,
    desktopId: connection.desktopId,
    connectionId: connection.id,
    requestId: created.conversation.id,
    allocationId,
    conversationId: null,
    workspaceId: workspace.id,
    branch: 'bot/work',
    cwd: '/tmp/bot-work',
    baseBranch: 'main',
    name: 'Work',
    fingerprint: allocationId,
    phase: 'reserved',
    error: null,
  })
  bindBotConversation(allocationId, conversation.id)
  upsertChatMessage({
    id: randomUUID(),
    conversationId: conversation.id,
    role: 'user',
    createdAt: 1,
    parts: [{ type: 'text', id: 'a', text: 'Report the evidence.' }],
    botName: 'Grok Bot',
  })
  upsertChatMessage({
    id: randomUUID(),
    conversationId: conversation.id,
    role: 'user',
    createdAt: 2,
    parts: [{ type: 'text', id: 'b', text: 'My own instruction, written here.' }],
  })

  const first = await history()
  expect(first.messages).toHaveLength(1)
  expect(first.messages[0]).toMatchObject({ text: 'Report the evidence.', botName: 'Grok Bot' })
  expect(first.hasMore).toBe(true)
  const second = await history(first.nextCursor)
  expect(second.messages[0]).toMatchObject({ text: 'My own instruction, written here.' })
  expect(second.messages[0].botName).toBeUndefined()

  // The same rules as every other read: another bot never sees it, and a withdrawn grant refuses it.
  const other = service.createConnection({
    name: 'Another bot',
    workspaceIds: [workspace.id],
    providerIds: ['provider'],
  })
  await expect(
    service.callTool(other.id, 'bot_read_chat_history', { conversationId: created.conversation.id }, signal)
  ).rejects.toThrow(/not found/i)
  service.setGrants(connection.id, [])
  await expect(history()).rejects.toThrow(/grant/i)
})
