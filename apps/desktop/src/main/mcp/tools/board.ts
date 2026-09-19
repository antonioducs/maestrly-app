import { getConversation } from '../../store'
import { registerProjectChatBoardTools } from '../../platform/project-chat-context'
import { createLinkedBoardAccess, linkedConversationBinding } from '../../platform/linked-board'
import { linkedBoardCatalog } from '../../platform/board-tool-catalog'
import type { McpToolContext } from './context'
import { err, ok } from './context'

export function registerBoardTools(ctx: McpToolContext): void {
  if (getConversation(ctx.convId)?.scope === 'standalone') return
  // Remote chats keep their own short-lived user/project token, including after disconnect.
  if (registerProjectChatBoardTools(ctx) || !linkedConversationBinding(ctx.convId)) return
  const access = createLinkedBoardAccess(ctx.convId)
  const result = async (run: () => unknown) => {
    try {
      if (getConversation(ctx.convId)?.scope === 'standalone') return err('project-required')
      return ok(JSON.stringify(await run()))
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error))
    }
  }
  ctx.server.registerTool(
    'get_linked_kanban',
    {
      description: 'Read the Kanban project and default board explicitly linked to this conversation workspace.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => result(access.context)
  )
  for (const tool of linkedBoardCatalog) {
    ctx.server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.schema.shape,
        annotations: { readOnlyHint: tool.readOnly, destructiveHint: !tool.readOnly },
      },
      (input, extra) => result(() => access.call(tool.name, input, extra.signal))
    )
  }
}
