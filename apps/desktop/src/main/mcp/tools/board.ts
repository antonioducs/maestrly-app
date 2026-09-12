import { randomUUID } from 'node:crypto'
import { registerProjectChatBoardTools } from '../../platform/project-chat-context'
import { HttpTransport } from '@maestrly/client-sdk'
import { z } from 'zod'
import type { McpToolContext } from './context'
import { err, ok } from './context'
import { getConversation } from '../../store'
import { platformConnections } from '../../platform/connection-service'
import { platformProjectBindings } from '../../platform/project-bindings'

export function registerBoardTools(ctx: McpToolContext): void {
  if(registerProjectChatBoardTools(ctx))return
  const conversation = getConversation(ctx.convId)
  const binding = conversation ? platformProjectBindings.forWorkspace(conversation.workspaceId) : null
  if (!binding) return
  const connection = platformConnections.list().find((item) => item.id === binding.connectionId)
  const token = platformConnections.token(binding.connectionId)
  if (!connection || !token) return
  const transport = new HttpTransport({
    baseUrl: connection.url,
    authentication: { headers: () => ({
      authorization: `Bearer ${token}`,
      'x-maestrly-client-actor': 'desktop-agent',
      'x-maestrly-conversation-id': ctx.convId,
    }) },
  })
  const json = (value: unknown) => ok(JSON.stringify(value, null, 2))

  ctx.server.registerTool('board_list_cards', {
    title: 'List linked board cards', description: 'Read cards on the explicitly linked remote board.',
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, async () => {
    try {
      const board = await transport.request<{ cards: unknown[] }>('GET', `/api/v1/organizations/${binding.organizationId}/boards/${binding.boardId}`)
      return json(board.cards)
    } catch (error) { return err(error instanceof Error ? error.message : String(error)) }
  })

  ctx.server.registerTool('board_get_card', {
    title: 'Read linked card', description: 'Read the card linked to this local conversation.',
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, async () => {
    if (!binding.cardId) return err('conversation-not-linked-to-card')
    try {
      const board = await transport.request<{ cards: Array<{ id: string }> }>('GET', `/api/v1/organizations/${binding.organizationId}/boards/${binding.boardId}`)
      return json(board.cards.find((card) => card.id === binding.cardId) ?? null)
    } catch (error) { return err(error instanceof Error ? error.message : String(error)) }
  })

  ctx.server.registerTool('board_update_card', {
    title: 'Update linked card', description: 'Update allowed fields on the linked card with optimistic concurrency.',
    inputSchema: { expectedVersion: z.number().int().positive(), description: z.string().max(100_000).optional(), title: z.string().min(1).max(500).optional() },
  }, async (input) => {
    if (!binding.cardId) return err('conversation-not-linked-to-card')
    try { return json(await transport.request('PATCH', `/api/v1/organizations/${binding.organizationId}/cards/${binding.cardId}`, { body: input, idempotencyKey: randomUUID() })) }
    catch (error) { return err(error instanceof Error ? error.message : String(error)) }
  })

  ctx.server.registerTool('board_create_subtask', {
    title: 'Create linked subtask', description: 'Create a card linked as a subtask of this conversation card.',
    inputSchema: { title: z.string().min(1).max(500), description: z.string().max(100_000).optional() },
  }, async (input) => {
    if (!binding.cardId) return err('conversation-not-linked-to-card')
    try {
      return json(await transport.request('POST', `/api/v1/organizations/${binding.organizationId}/boards/${binding.boardId}/cards`, {
        body: { ...input, parentCardId: binding.cardId }, idempotencyKey: randomUUID(),
      }))
    } catch (error) { return err(error instanceof Error ? error.message : String(error)) }
  })

  ctx.server.registerTool('board_comment', {
    title: 'Comment on linked card', description: 'Post an attributed agent comment on the linked card.',
    inputSchema: { body: z.string().min(1).max(100_000) },
  }, async ({ body }) => {
    if (!binding.cardId) return err('conversation-not-linked-to-card')
    try { return json(await transport.request('POST', `/api/v1/organizations/${binding.organizationId}/cards/${binding.cardId}/comments`, { body: { body }, idempotencyKey: randomUUID() })) }
    catch (error) { return err(error instanceof Error ? error.message : String(error)) }
  })

  ctx.server.registerTool('board_move_card', {
    title: 'Move linked card', description: 'Move the linked card. Agent automation chaining stays disabled.',
    inputSchema: { expectedVersion: z.number().int().positive(), targetColumnId: z.string().min(1), targetPosition: z.number().int().nonnegative() },
  }, async (input) => {
    if (!binding.cardId) return err('conversation-not-linked-to-card')
    try { return json(await transport.request('POST', `/api/v1/organizations/${binding.organizationId}/cards/${binding.cardId}/move`, { body: { ...input, source: 'agent', allowAutomationChain: false, chainDepth: 0 }, idempotencyKey: randomUUID() })) }
    catch (error) { return err(error instanceof Error ? error.message : String(error)) }
  })
}
