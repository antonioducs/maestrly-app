import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getConversation, getLocale } from './store'
import { tFor } from './i18n'
import { registerBrowserTools } from './mcp/tools/browser'
import { registerTerminalTools } from './mcp/tools/terminal'
import { registerConversationNotesTools, registerProjectNotesTools } from './mcp/tools/notes'
import { registerMemoryTools } from './mcp/tools/memory'
import { registerDebugTools } from './mcp/tools/debug'
import { registerBoardTools } from './mcp/tools/board'
import type { MaestroWorkerScope } from './maestro-worker-scope'

/**
 * In-process native Chat tool registry. Client and server connect exclusively through
 * InMemoryTransport, without sockets, tokens, or external processes.
 */
function buildNativeAppToolsServer(name: string): {
  server: McpServer
  locale: ReturnType<typeof getLocale>
  t: ReturnType<typeof tFor>
} {
  const locale = getLocale()
  const t = tFor(locale, 'mcp')
  const server = new McpServer({ name, version: '1.0.0' })
  return { server, locale, t }
}

export function buildAppToolsServer(conversationId: string, workerScope?: MaestroWorkerScope): McpServer {
  const { server, locale, t } = buildNativeAppToolsServer('maestrly-app-tools')

  const ctx = { server, convId: conversationId, locale, t, workerScope }
  const conversation = getConversation(conversationId)
  registerBrowserTools(ctx)
  registerTerminalTools(ctx)
  if (conversation) registerConversationNotesTools(ctx)
  registerProjectNotesTools(ctx)
  registerMemoryTools(ctx)
  registerDebugTools(ctx)
  registerBoardTools(ctx)
  return server
}
