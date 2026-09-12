import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { HttpTransport } from '@maestrly/client-sdk'
import type { McpToolContext } from '../mcp/tools/context'
import { ok, err } from '../mcp/tools/context'
import { remoteChatPolicy, isWebManagedConversation } from '../chat/remote-policy'

export interface ProjectChatContext {
  url: string
  organizationId: string
  projectId: string
  sessionId: string
  turnId: string
  token: string
}
const contexts = new Map<string, ProjectChatContext>()
export function registerProjectChatContext(conversationId: string, context: ProjectChatContext) {
  contexts.set(conversationId, context)
  return () => contexts.delete(conversationId)
}
const id = z.string().uuid(),
  search = {
    query: z.string().max(2000).optional(),
    boardId: id.optional(),
    done: z.boolean().optional(),
    archived: z.boolean().optional(),
    after: id.optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }
const schemas = {
  board_list_boards: {},
  board_get_board: { boardId: id },
  board_list_cards: search,
  board_search_cards: search,
  board_get_card: { cardId: id },
  board_card_history: { cardId: id },
  board_create_card: {
    boardId: id,
    columnId: id.optional(),
    parentCardId: id.optional(),
    title: z.string().min(1).max(500),
    description: z.string().max(100000).optional(),
  },
  board_update_card: {
    cardId: id,
    expectedVersion: z.number().int().positive(),
    title: z.string().min(1).max(500).optional(),
    description: z.string().max(100000).optional(),
  },
  board_comment: { cardId: id, body: z.string().min(1).max(100000) },
  board_move_card: {
    cardId: id,
    expectedVersion: z.number().int().positive(),
    targetColumnId: id,
    targetPosition: z.number().int().nonnegative(),
  },
}
const read = new Set([
  'board_list_boards',
  'board_get_board',
  'board_list_cards',
  'board_search_cards',
  'board_get_card',
  'board_card_history',
])
/** Returns true for every remote-managed conversation, including disconnected ones: never fall back to operator credentials. */
export function registerProjectChatBoardTools(ctx: McpToolContext): boolean {
  const remote = remoteChatPolicy(ctx.convId),
    root = remote?.conversationId ?? ctx.convId
  if (!contexts.has(root) && !isWebManagedConversation(root)) return false
  for (const [name, inputSchema] of Object.entries(schemas))
    ctx.server.registerTool(
      name,
      {
        title: name.replaceAll('_', ' '),
        description:
          name === 'board_search_cards'
            ? 'Search this project, including completed (done) and archived cards. Returns snippets and IDs; follow nextCursor with after.'
            : name === 'board_get_board'
              ? 'Read columns and their roles for a project board. Use board_list_cards to page through its cards.'
              : 'Access the conversation project with the web user permissions. Writes require an expected card version and do not start automation chains.',
        inputSchema,
        annotations: { readOnlyHint: read.has(name) },
      },
      async (input: Record<string, unknown>, extra: { requestId?: string | number }) => {
        const context = contexts.get(root)
        if (!context) return err('Remote chat context is unavailable or its turn ended.')
        const transport = new HttpTransport({
          baseUrl: context.url,
          authentication: {
            headers: () => ({
              authorization: 'Chat ' + context.token,
              'x-maestrly-organization-id': context.organizationId,
            }),
          },
        })
        try {
          return ok(
            JSON.stringify(
              await transport.request('POST', '/api/v1/runners/chat/tools', {
                body: {
                  name,
                  input,
                  callId: context.turnId + ':' + String(extra.requestId ?? randomUUID()) + ':' + name,
                },
              })
            )
          )
        } catch (error) {
          return err((error as Error).message)
        }
      }
    )
  return true
}
