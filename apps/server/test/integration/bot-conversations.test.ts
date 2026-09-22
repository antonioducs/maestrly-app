import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { BotInventory } from '@maestrly/protocol'
import type { DatabasePool } from '../../src/db/pool.js'
import {
  claimBotCommand,
  completeBotCommand,
  readBotControls,
  renewBotLease,
  uploadBotEventBatch,
} from '../../src/modules/bot-conversations/dispatch.js'
import {
  botTransaction,
  createBotConnection,
  createBotConversation,
  enqueueBotCommand,
  executeBotIdempotent,
  listBotConversations,
  loadBotConnectionForToken,
  patchBotConnection,
  readBotConversation,
  registerBotDesktop,
  revokeBotDesktop,
  saveBotInventory,
  setBotConversationManagement,
  verifyBotDesktopCredential,
  type BotPrincipal,
} from '../../src/modules/bot-conversations/service.js'
import { integrationAvailable, runtimePool } from './helpers.js'

const inventory = (workspaceId: string): BotInventory => ({
  capability: 'bot:conversations:v1',
  enabled: true,
  workspaces: [{ workspaceId, label: 'Product', branches: ['main'], defaultBranch: 'main' }],
  selections: [
    {
      selectionId: 'account-1/model-a',
      label: 'Model A',
      providerLabel: null,
      reasoningEfforts: ['medium'],
      fastMode: false,
      modes: ['agent', 'ask', 'plan'],
      permissionModes: ['ask', 'auto', 'full'],
    },
  ],
})

async function setUpOwner(pool: DatabasePool, workspaceId: string, connectionName = 'Grok') {
  const userId = 'bot-owner-' + randomUUID()
  const registration = await botTransaction(pool, { type: 'bot_owner', userId }, (client) =>
    registerBotDesktop(client, { userId, name: 'Laptop' })
  )
  const identity = { desktopId: registration.desktop.id, ownerUserId: userId }
  await saveBotInventory(pool, identity, inventory(workspaceId))
  const clientId = 'bot-client-' + randomUUID()
  const connection = await botTransaction(pool, { type: 'bot_owner', userId }, (client) =>
    createBotConnection(
      client,
      { userId },
      {
        name: connectionName,
        desktopId: identity.desktopId,
        clientId,
        grants: [{ workspaceId, actions: ['chats:read', 'chats:write', 'chats:control', 'chats:answer'] }],
      }
    )
  )
  const principal: BotPrincipal = {
    userId,
    connectionId: connection.id,
    desktopId: identity.desktopId,
    clientId,
    connectionName,
    scopes: ['api:read', 'api:write'],
    grants: connection.grants,
  }
  return { userId, identity, connection, principal, clientId, registration }
}

const createPayload = (workspaceId: string) => ({
  workspaceId,
  name: 'Release notes',
  baseBranch: 'main',
  selection: { selectionId: 'account-1/model-a' },
  message: 'Summarize the release',
})

describe.skipIf(!integrationAvailable)('personal bot conversations', () => {
  it('relays commands serially with leases, fencing and idempotent events, and never leaks another bot', async () => {
    const pool = runtimePool()
    try {
      const workspaceId = 'ws-' + randomUUID()
      const owner = await setUpOwner(pool, workspaceId)
      const other = await setUpOwner(pool, 'ws-' + randomUUID(), 'Second bot')

      // The device credential resolves to its owner and nothing else.
      expect(await verifyBotDesktopCredential(pool, { ...owner.identity, credential: owner.registration.credential }))
        .toEqual(owner.identity)
      expect(
        await verifyBotDesktopCredential(pool, {
          desktopId: owner.identity.desktopId,
          credential: other.registration.credential,
        })
      ).toBeNull()

      const created = await botTransaction(pool, botActor(owner.principal), (client) =>
        createBotConversation(client, owner.principal, createPayload(workspaceId))
      )
      expect(created.conversation.managementState).toBe('active')
      expect(created.command.kind).toBe('create')
      // A bot never receives a lease token.
      expect(created.command.leaseToken).toBeUndefined()

      // A second command queues behind the first; only one command of a conversation is ever leased.
      const queued = await botTransaction(pool, botActor(owner.principal), (client) =>
        enqueueBotCommand(client, owner.principal, {
          conversationId: created.conversation.id,
          kind: 'send',
          payload: { text: 'And add the migration notes' },
        })
      )
      expect(queued.command.status).toBe('queued')

      const claim = await claimBotCommand(pool, owner.identity)
      expect(claim?.command.id).toBe(created.command.id)
      expect(claim?.fence).toBe(1)
      expect(claim?.owner.userId).toBe(owner.userId)
      expect(claim?.connection.id).toBe(owner.connection.id)
      expect(await claimBotCommand(pool, owner.identity)).toBeNull()
      // Another owner's desktop never claims this work.
      expect(await claimBotCommand(pool, other.identity)).toBeNull()

      const lease = { leaseToken: claim!.command.leaseToken!, fence: claim!.fence }
      const messageId = randomUUID()
      const event = {
        eventId: 'message-' + messageId,
        payload: {
          type: 'message' as const,
          message: {
            id: messageId,
            conversationId: created.conversation.id,
            commandId: created.command.id,
            role: 'assistant' as const,
            parts: [{ id: 'p1', type: 'text' as const, text: 'Working on it' }],
            createdAt: new Date().toISOString(),
          },
        },
      }
      expect(
        await uploadBotEventBatch(pool, owner.identity, { commandId: created.command.id, ...lease, events: [event] })
      ).toEqual({ accepted: [event.eventId] })
      // The same event id with the same content replays; with different content it is refused.
      await uploadBotEventBatch(pool, owner.identity, { commandId: created.command.id, ...lease, events: [event] })
      await expect(
        uploadBotEventBatch(pool, owner.identity, {
          commandId: created.command.id,
          ...lease,
          events: [{ ...event, payload: { ...event.payload, message: { ...event.payload.message, parts: [] } } }],
        })
      ).rejects.toThrow(/reused with different content/)
      // A stale lease token or fence is fenced out.
      await expect(
        uploadBotEventBatch(pool, owner.identity, {
          commandId: created.command.id,
          leaseToken: randomUUID(),
          fence: lease.fence,
          events: [event],
        })
      ).rejects.toThrow(/no longer valid/)
      await expect(
        renewBotLease(pool, owner.identity, { commandId: created.command.id, ...lease, fence: lease.fence + 1 })
      ).rejects.toThrow(/no longer valid/)
      // Server-owned payloads are never accepted from a desktop.
      await expect(
        uploadBotEventBatch(pool, owner.identity, {
          commandId: created.command.id,
          ...lease,
          events: [
            { eventId: 'forged', payload: { type: 'command', command: { ...created.command, status: 'succeeded' } } },
          ],
        })
      ).rejects.toThrow(/controlled by the server/)

      const finished = await completeBotCommand(pool, owner.identity, {
        commandId: created.command.id,
        ...lease,
        status: 'succeeded',
        error: null,
      })
      expect(finished.status).toBe('succeeded')
      // Repeating the same completion replays; a different outcome conflicts.
      expect(
        (
          await completeBotCommand(pool, owner.identity, {
            commandId: created.command.id,
            ...lease,
            status: 'succeeded',
            error: null,
          })
        ).status
      ).toBe('succeeded')
      await expect(
        completeBotCommand(pool, owner.identity, {
          commandId: created.command.id,
          ...lease,
          status: 'failed',
          error: 'x',
        })
      ).rejects.toThrow(/conflicts with the recorded outcome/)

      // The next command of the same conversation is claimed with a higher fence.
      const second = await claimBotCommand(pool, owner.identity)
      expect(second?.command.id).toBe(queued.command.id)
      expect(second?.fence).toBe(2)

      // A cancel request reaches the desktop through controls while the turn is still running.
      await botTransaction(pool, botActor(owner.principal), (client) =>
        enqueueBotCommand(client, owner.principal, {
          conversationId: created.conversation.id,
          kind: 'cancel',
          payload: {},
        })
      )
      const controls = await readBotControls(pool, owner.identity, {
        commandId: second!.command.id,
        leaseToken: second!.command.leaseToken!,
        fence: second!.fence,
      })
      expect(controls.cancellationRequested).toBe(true)
      expect(controls.managementState).toBe('active')

      // Another bot of the same person cannot see or touch this conversation, and neither can its owner's
      // other connection through a stale principal.
      const intruder: BotPrincipal = { ...other.principal, grants: owner.principal.grants }
      await expect(readBotConversation(pool, intruder, created.conversation.id)).rejects.toThrow(/not found/)
      expect(await listBotConversations(pool, other.principal)).toEqual([])
      await expect(
        botTransaction(pool, botActor(intruder), (client) =>
          enqueueBotCommand(client, intruder, {
            conversationId: created.conversation.id,
            kind: 'send',
            payload: { text: 'let me in' },
          })
        )
      ).rejects.toThrow(/not found/)

      // Row level security, not only the query filter: the row is invisible in the other bot's context.
      const invisible = await botTransaction(pool, botActor(other.principal), (client) =>
        client.query('select id from bot_conversations where id=$1', [created.conversation.id])
      )
      expect(invisible.rowCount).toBe(0)

      const snapshot = await readBotConversation(pool, owner.principal, created.conversation.id)
      expect(snapshot.messages[0]!.parts).toEqual([{ id: 'p1', type: 'text', text: 'Working on it' }])
      expect(snapshot.cursor).toBeGreaterThan(0)
    } finally {
      await pool.end()
    }
  })

  it('refuses bot writes while the owner keeps the conversation paused', async () => {
    const pool = runtimePool()
    try {
      const workspaceId = 'ws-' + randomUUID()
      const owner = await setUpOwner(pool, workspaceId)
      const created = await botTransaction(pool, botActor(owner.principal), (client) =>
        createBotConversation(client, owner.principal, createPayload(workspaceId))
      )
      const paused = await botTransaction(pool, { type: 'bot_owner', userId: owner.userId }, (client) =>
        setBotConversationManagement(
          client,
          { userId: owner.userId, conversationId: created.conversation.id },
          { expectedVersion: created.conversation.version, state: 'paused' }
        )
      )
      expect(paused.managementState).toBe('paused')

      await expect(
        botTransaction(pool, botActor(owner.principal), (client) =>
          enqueueBotCommand(client, owner.principal, {
            conversationId: created.conversation.id,
            kind: 'send',
            payload: { text: 'keep going' },
          })
        )
      ).rejects.toThrow(/paused by its owner/)
      // The desktop stops receiving work for a paused conversation.
      expect(await claimBotCommand(pool, owner.identity)).toBeNull()
      // The bot cannot lift the pause: only the owner route can, and it is not reachable with a bot actor.
      await expect(
        botTransaction(pool, botActor(owner.principal), (client) =>
          setBotConversationManagement(
            client,
            { userId: owner.userId, conversationId: created.conversation.id },
            { expectedVersion: paused.version, state: 'active' }
          )
        )
      ).rejects.toThrow(/Only the owner can pause, resume or revoke/)

      const resumed = await botTransaction(pool, { type: 'bot_owner', userId: owner.userId }, (client) =>
        setBotConversationManagement(
          client,
          { userId: owner.userId, conversationId: created.conversation.id },
          { expectedVersion: paused.version, state: 'active' }
        )
      )
      expect(resumed.managementState).toBe('active')
      expect((await claimBotCommand(pool, owner.identity))?.command.kind).toBe('create')
    } finally {
      await pool.end()
    }
  })

  it('answers only pending ordinary questions and settles them when the desktop confirms', async () => {
    const pool = runtimePool()
    try {
      const workspaceId = 'ws-' + randomUUID()
      const owner = await setUpOwner(pool, workspaceId)
      const created = await botTransaction(pool, botActor(owner.principal), (client) =>
        createBotConversation(client, owner.principal, createPayload(workspaceId))
      )
      const claim = await claimBotCommand(pool, owner.identity)
      const lease = { leaseToken: claim!.command.leaseToken!, fence: claim!.fence }
      const questionId = randomUUID()
      await uploadBotEventBatch(pool, owner.identity, {
        commandId: created.command.id,
        ...lease,
        events: [
          {
            eventId: 'question-' + questionId,
            payload: {
              type: 'question',
              question: {
                id: questionId,
                conversationId: created.conversation.id,
                commandId: created.command.id,
                questions: [{ question: 'Which branch should I target?', options: [] }],
                state: 'pending',
                answers: null,
                createdAt: new Date().toISOString(),
              },
            },
          },
        ],
      })
      const snapshot = await readBotConversation(pool, owner.principal, created.conversation.id)
      expect(snapshot.questions[0]!.state).toBe('pending')

      await expect(
        botTransaction(pool, botActor(owner.principal), (client) =>
          enqueueBotCommand(client, owner.principal, {
            conversationId: created.conversation.id,
            kind: 'answer',
            payload: { questionId: randomUUID(), answers: [['main']] },
          })
        )
      ).rejects.toThrow(/Question not found/)

      const answer = await botTransaction(pool, botActor(owner.principal), (client) =>
        enqueueBotCommand(client, owner.principal, {
          conversationId: created.conversation.id,
          kind: 'answer',
          payload: { questionId, answers: [['main']] },
        })
      )
      // An answer reaches the turn that asked, so it is claimed while that turn still holds its lease.
      const answerClaim = await claimBotCommand(pool, owner.identity)
      expect(answerClaim?.command.id).toBe(answer.command.id)
      await completeBotCommand(pool, owner.identity, {
        commandId: answer.command.id,
        leaseToken: answerClaim!.command.leaseToken!,
        fence: answerClaim!.fence,
        status: 'succeeded',
        error: null,
      })
      await completeBotCommand(pool, owner.identity, {
        commandId: created.command.id,
        ...lease,
        status: 'succeeded',
        error: null,
      })
      const settled = await readBotConversation(pool, owner.principal, created.conversation.id)
      expect(settled.questions[0]).toMatchObject({ state: 'answered', answers: [['main']] })
      // The same question cannot be answered twice.
      await expect(
        botTransaction(pool, botActor(owner.principal), (client) =>
          enqueueBotCommand(client, owner.principal, {
            conversationId: created.conversation.id,
            kind: 'answer',
            payload: { questionId, answers: [['develop']] },
          })
        )
      ).rejects.toThrow(/already answered/)
    } finally {
      await pool.end()
    }
  })

  it('replays an idempotent retry and cuts everything off on revocation', async () => {
    const pool = runtimePool()
    try {
      const workspaceId = 'ws-' + randomUUID()
      const owner = await setUpOwner(pool, workspaceId)
      const key = 'create-' + randomUUID()
      const body = createPayload(workspaceId)
      const first = await executeBotIdempotent(
        pool,
        {
          actor: botActor(owner.principal),
          ownerUserId: owner.userId,
          actorId: owner.connection.id,
          key,
          method: 'TOOL',
          path: 'bot_create_chat',
          body,
        },
        async (client) => ({ status: 201, body: await createBotConversation(client, owner.principal, body) })
      )
      expect(first.replayed).toBe(false)
      const retry = await executeBotIdempotent(
        pool,
        {
          actor: botActor(owner.principal),
          ownerUserId: owner.userId,
          actorId: owner.connection.id,
          key,
          method: 'TOOL',
          path: 'bot_create_chat',
          body,
        },
        async () => {
          throw new Error('the operation must not run twice')
        }
      )
      expect(retry.replayed).toBe(true)
      expect(retry.body).toEqual(JSON.parse(JSON.stringify(first.body)))
      // The same key with different content is a conflict, not a silent second chat.
      await expect(
        executeBotIdempotent(
          pool,
          {
            actor: botActor(owner.principal),
            ownerUserId: owner.userId,
            actorId: owner.connection.id,
            key,
            method: 'TOOL',
            path: 'bot_create_chat',
            body: { ...body, name: 'Another chat' },
          },
          async (client) => ({ status: 201, body: await createBotConversation(client, owner.principal, body) })
        )
      ).rejects.toThrow(/already used with different content/)
      expect(await listBotConversations(pool, owner.principal)).toHaveLength(1)

      expect(
        await loadBotConnectionForToken(pool, { userId: owner.userId, clientId: owner.clientId })
      ).toMatchObject({ connectionId: owner.connection.id })

      const revoked = await botTransaction(pool, { type: 'bot_owner', userId: owner.userId }, (client) =>
        patchBotConnection(
          client,
          { userId: owner.userId, connectionId: owner.connection.id },
          { expectedVersion: owner.connection.version, revoked: true }
        )
      )
      expect(revoked.revokedAt).not.toBeNull()
      expect(await loadBotConnectionForToken(pool, { userId: owner.userId, clientId: owner.clientId })).toBeNull()
      expect(await claimBotCommand(pool, owner.identity)).toBeNull()
      await expect(
        botTransaction(pool, botActor(owner.principal), (client) =>
          enqueueBotCommand(client, owner.principal, {
            conversationId: (first.body as { conversation: { id: string } }).conversation.id,
            kind: 'send',
            payload: { text: 'still there?' },
          })
        )
      ).rejects.toThrow(/revoked/)

      // Revoking the desktop is the wider stop: connections and queued work go with it.
      const second = await setUpOwner(pool, 'ws-' + randomUUID())
      await botTransaction(pool, botActor(second.principal), (client) =>
        createBotConversation(client, second.principal, createPayload(second.principal.grants[0]!.workspaceId))
      )
      await botTransaction(pool, { type: 'bot_owner', userId: second.userId }, (client) =>
        revokeBotDesktop(client, { userId: second.userId, desktopId: second.identity.desktopId })
      )
      expect(
        await verifyBotDesktopCredential(pool, {
          ...second.identity,
          credential: second.registration.credential,
        })
      ).toBeNull()
      expect(await claimBotCommand(pool, second.identity)).toBeNull()
      expect(await loadBotConnectionForToken(pool, { userId: second.userId, clientId: second.clientId })).toBeNull()
    } finally {
      await pool.end()
    }
  })
})

function botActor(principal: BotPrincipal) {
  return {
    type: 'bot_connection' as const,
    userId: principal.userId,
    connectionId: principal.connectionId,
    desktopId: principal.desktopId,
  }
}
