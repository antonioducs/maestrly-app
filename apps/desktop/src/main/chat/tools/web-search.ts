/** `web_search` tool — general web search through the configured provider. Gated network egress, like webfetch. */
import { z } from 'zod'
import { WEB_SEARCH_TOOL_NAME } from '../../../shared/web-search'
import { webSearchBackends } from '../web-search/backends'
import { runWebSearch } from '../web-search/resolve'
import { getWebSearchProvider } from '../web-search/settings'
import type { WebSearchOutcome } from '../web-search/types'
import { defineTool, type ToolContext } from './util'

const params = z.object({
  query: z.string().trim().min(1).max(400).describe('Search query, as you would type it into a search engine.'),
  max_results: z.number().int().min(1).max(10).default(5).describe('Maximum number of results (1-10).'),
})

export interface WebSearchToolResult {
  query: string
  backend: string
  outcome: WebSearchOutcome
}

export function formatWebSearchResult(result: WebSearchToolResult): string {
  const head = `Web search via ${result.backend} for "${result.query}":`
  if (result.outcome.kind === 'summary') return `${head}\n\n${result.outcome.text}`
  if (!result.outcome.hits.length) return `${head}\n\nNo results.`
  const lines = result.outcome.hits.map((hit, index) =>
    [`${index + 1}. ${hit.title}`, `   ${hit.url}`, ...(hit.snippet ? [`   ${hit.snippet}`] : [])].join('\n')
  )
  return `${head}\n\n${lines.join('\n\n')}\n\nUse webfetch to read a result in full.`
}

async function run(args: z.infer<typeof params>, ctx: ToolContext): Promise<WebSearchToolResult> {
  const provider = getWebSearchProvider()
  if (provider === 'off')
    throw new Error('Web search is turned off in Maestrly settings (Settings → Tools → Web search).')
  await ctx.ask('web_search', [args.query], ['*'])
  const { backend, outcome } = await runWebSearch({
    provider,
    backends: webSearchBackends(),
    request: {
      query: args.query,
      maxResults: args.max_results,
      signal: ctx.signal,
      conversationId: ctx.conversationId,
      cwd: ctx.cwd,
    },
  })
  return { query: args.query, backend: backend.label, outcome }
}

export const webSearchTool = defineTool({
  name: WEB_SEARCH_TOOL_NAME,
  description:
    'Searches the web and returns result titles, URLs and snippets. Use it for current or unknown information, ' +
    'then read relevant pages with webfetch. Asks for permission (network egress).',
  parameters: params,
  execute: run,
  toModelText: (_args, result) => formatWebSearchResult(result),
})
