import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { SharedTFunc } from '../../../shared/i18n'
import type { SupportedLocale } from '../../../shared/locale'
import type { MaestroWorkerScope } from '../../maestro-worker-scope'

/**
 * Per-MCP-session context injected into domain tools. The host supplies the in-process server and
 * conversation-scoped dependencies.
 */
export interface McpToolContext {
  server: McpServer
  convId: string
  locale: SupportedLocale
  t: SharedTFunc
  /** Present only for delegated Maestro workers. It never changes a tool's visible schema. */
  workerScope?: MaestroWorkerScope
}

export const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] })
export const err = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true })
