import { randomUUID } from 'node:crypto'
import { HttpTransport } from '@maestrly/client-sdk'
import type { McpToolContext } from '../mcp/tools/context'
import { ok, err } from '../mcp/tools/context'
import { linkedBoardCatalog } from './board-tool-catalog'
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
/** Returns true for every remote-managed conversation, including disconnected ones: never fall back to operator credentials. */
export function registerProjectChatBoardTools(ctx: McpToolContext): boolean {
  const remote = remoteChatPolicy(ctx.convId),
    root = remote?.conversationId ?? ctx.convId
  if (!contexts.has(root) && !isWebManagedConversation(root)) return false
  for (const { name, description, schema, readOnly } of linkedBoardCatalog)
    ctx.server.registerTool(
      name,
      {
        title: name.replaceAll('_', ' '),
        description,
        inputSchema: schema.shape,
        annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly },
      },
      async (input: Record<string, unknown>, extra: { requestId?: string | number }) => {
        const context = contexts.get(root)
        if (!context) return err('Remote chat context is unavailable or its turn ended.')
        const { idempotencyKey, ...domainInput } = input
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
                  input: domainInput,
                  callId:
                    !readOnly && typeof idempotencyKey === 'string'
                      ? idempotencyKey
                      : context.turnId + ':' + String(extra.requestId ?? randomUUID()) + ':' + name,
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
