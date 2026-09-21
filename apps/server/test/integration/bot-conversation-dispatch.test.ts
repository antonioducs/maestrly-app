import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { BotAction, BotInventory } from '@maestrly/protocol'
import type { DatabasePool } from '../../src/db/pool.js'
import { integrationAvailable, runtimePool } from './helpers.js'
import {
  botTransaction, createBotConnection, createBotConversation, enqueueBotCommand, listBotConversations,
  patchBotConnection, readBotConversation, registerBotDesktop, saveBotInventory, type BotPrincipal,
} from '../../src/modules/bot-conversations/service.js'
import { claimBotCommand, completeBotCommand, renewBotLease, uploadBotEventBatch } from '../../src/modules/bot-conversations/dispatch.js'
import { botToolCatalog } from '../../src/modules/bot-conversations/mcp.js'

async function fixture(pool: DatabasePool) {
  const userId = `owner-${randomUUID()}`
  const workspaceId = `workspace-${randomUUID()}`
  const registered = await botTransaction(pool, { type: 'bot_owner', userId }, client => registerBotDesktop(client, { userId, name: 'Private desktop' }))
  const identity = { desktopId: registered.desktop.id, ownerUserId: userId }
  const inventory: BotInventory = {
    capability: 'bot:conversations:v1', enabled: true,
    workspaces: [{ workspaceId, label: 'Local repository', branches: ['main'], defaultBranch: 'main' }],
    selections: [{ selectionId: 'selection', label: 'Model', providerLabel: 'Account', reasoningEfforts: [], fastMode: false, modes: ['agent'], permissionModes: ['ask'] }],
  }
  await saveBotInventory(pool, identity, inventory)
  const actions: BotAction[] = ['chats:read', 'chats:write', 'chats:answer', 'chats:control']
  const clientId = `client-${randomUUID()}`
  const connection = await botTransaction(pool, { type: 'bot_owner', userId }, client => createBotConnection(client, { userId }, {
    desktopId: identity.desktopId, clientId, name: 'Grok Bot', grants: [{ workspaceId, actions }],
  }))
  const principal: BotPrincipal = { userId, clientId, connectionId: connection.id, desktopId: identity.desktopId,
    connectionName: 'Grok Bot', scopes: ['api:read', 'api:write'], grants: connection.grants }
  const actor = { type: 'bot_connection' as const, userId, desktopId: identity.desktopId, connectionId: connection.id }
  const input = { workspaceId, name: 'Task', baseBranch: 'main', selection: { selectionId: 'selection' }, message: 'Work' }
  return { userId, identity, connection, principal, actor, input }
}

describe.skipIf(!integrationAvailable)('private bot command control and authorization', () => {
  it('delivers an ordinary answer while the asking native turn still holds its lease', async () => {
    const pool = runtimePool()
    try {
      const f = await fixture(pool)
      const created = await botTransaction(pool, f.actor, client => createBotConversation(client, f.principal, f.input))
      const primary = (await claimBotCommand(pool, f.identity))!
      const questionId = randomUUID()
      await uploadBotEventBatch(pool, f.identity, {
        commandId: primary.command.id, leaseToken: primary.command.leaseToken!, fence: primary.fence,
        events: [{ eventId: randomUUID(), payload: { type: 'question', question: {
          id: questionId, conversationId: created.conversation.id, commandId: primary.command.id,
          questions: [{ header: 'Color', question: 'Which color?', options: [], multiple: false }],
          state: 'pending', answers: null, createdAt: new Date().toISOString(),
        } } }],
      })
      await botTransaction(pool, f.actor, client => enqueueBotCommand(client, f.principal, {
        conversationId: created.conversation.id, kind: 'answer', payload: { questionId, answers: [['Blue']] },
      }))
      const answer = await claimBotCommand(pool, f.identity)
      expect(answer?.command.kind).toBe('answer')
      expect((await renewBotLease(pool, f.identity, { commandId: primary.command.id, leaseToken: primary.command.leaseToken!, fence: primary.fence })).managementState).toBe('active')
      await completeBotCommand(pool, f.identity, { commandId: answer!.command.id, leaseToken: answer!.command.leaseToken!, fence: answer!.fence, status: 'succeeded', error: null })
      expect((await readBotConversation(pool, f.principal, created.conversation.id)).questions[0]).toMatchObject({ state: 'answered', answers: [['Blue']] })
      await completeBotCommand(pool, f.identity, { commandId: primary.command.id, leaseToken: primary.command.leaseToken!, fence: primary.fence, status: 'succeeded', error: null })
    } finally { await pool.end() }
  })

  it('rechecks removed grants for snapshots, leases and idempotent MCP retries', async () => {
    const pool = runtimePool()
    try {
      const f = await fixture(pool)
      const tool = botToolCatalog(pool).find(tool => tool.name === 'bot_create_chat')!
      const input = { ...f.input, idempotencyKey: randomUUID() }
      const context = { principal: f.principal, signal: new AbortController().signal }
      const result = await tool.run(input, context) as { conversation: { id: string } }
      const claim = (await claimBotCommand(pool, f.identity))!
      await botTransaction(pool, { type: 'bot_owner', userId: f.userId }, client => patchBotConnection(client, { userId: f.userId, connectionId: f.connection.id }, {
        expectedVersion: f.connection.version, grants: [],
      }))
      expect(await listBotConversations(pool, f.principal)).toEqual([])
      await expect(readBotConversation(pool, f.principal, result.conversation.id)).rejects.toThrow(/grant|authorized/i)
      await expect(tool.run(input, context)).rejects.toThrow(/grant|authorized/i)
      await expect(renewBotLease(pool, f.identity, { commandId: claim.command.id, leaseToken: claim.command.leaseToken!, fence: claim.fence })).rejects.toThrow(/grant/i)
    } finally { await pool.end() }
  })

  it('rejects an old holder even after a new holder has completed the command', async () => {
    const pool = runtimePool()
    try {
      const f = await fixture(pool)
      await botTransaction(pool, f.actor, client => createBotConversation(client, f.principal, f.input))
      const old = (await claimBotCommand(pool, f.identity))!
      await botTransaction(pool, { type: 'bot_owner', userId: f.userId }, client => client.query("update bot_commands set lease_expires_at=now()-interval '1 second' where id=$1", [old.command.id]))
      const current = (await claimBotCommand(pool, f.identity))!
      expect(current.fence).toBeGreaterThan(old.fence)
      await completeBotCommand(pool, f.identity, { commandId: current.command.id, leaseToken: current.command.leaseToken!, fence: current.fence, status: 'succeeded', error: null })
      await expect(completeBotCommand(pool, f.identity, { commandId: old.command.id, leaseToken: old.command.leaseToken!, fence: old.fence, status: 'succeeded', error: null })).rejects.toThrow(/lease/)
    } finally { await pool.end() }
  })
})
