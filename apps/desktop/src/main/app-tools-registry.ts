import { registerHistoryTools } from './mcp/tools/history'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getConversation, getLocale } from './store'
import { tFor } from './i18n'
import { registerBrowserTools } from './mcp/tools/browser'
import { registerTerminalTools } from './mcp/tools/terminal'
import { registerConversationNotesTools, registerProjectNotesTools } from './mcp/tools/notes'
import { registerMemoryTools } from './mcp/tools/memory'
import { registerDebugTools } from './mcp/tools/debug'
import type { MaestroWorkerScope } from './maestro-worker-scope'
import { registerBotModeTools } from './mcp/tools/bot-instance'
import { registerServerModeTools } from './mcp/tools/server-computer'
import { registerArtifactTools } from './mcp/tools/artifacts'
import { registerArtifactCommentTools } from './mcp/tools/artifact-comments'
import { botRuntimeForConversation } from './fleet/instance'
import { isBotMode } from './fleet/instance/config'
import { registerInterfaceTools } from './mcp/tools/interfaces'
import { generatedInterfacesEnabled } from './chat/generated-interfaces'

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
  if (conversation?.scope !== 'standalone') {
    registerProjectNotesTools(ctx)
  }
  if (conversation) registerHistoryTools(ctx)
  registerMemoryTools(ctx)
  registerDebugTools(ctx)
  if (!isBotMode()) {
    registerArtifactTools(ctx)
    registerArtifactCommentTools(ctx)
  } else if (botRuntimeForConversation(conversationId)?.artifactsEnabled) {
    registerArtifactTools(ctx, undefined, { open: false })
    registerArtifactCommentTools(ctx)
  }
  registerBotModeTools(ctx)
  registerServerModeTools(ctx)
  // Only where the prompt teaches interfaces: never for delegated workers, and not when the person turned them off.
  if (!workerScope && generatedInterfacesEnabled()) registerInterfaceTools(ctx)
  return server
}
