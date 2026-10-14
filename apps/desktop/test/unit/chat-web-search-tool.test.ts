import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebSearchProvider } from '../../src/shared/web-search'
import type {
  WebSearchBackend,
  WebSearchBackendId,
  WebSearchOutcome,
} from '../../src/main/chat/web-search/types'

const h = vi.hoisted(() => ({
  provider: 'auto' as WebSearchProvider,
  backends: {} as Record<string, unknown>,
}))
vi.mock('../../src/main/chat/web-search/settings', () => ({
  getWebSearchProvider: () => h.provider,
  webSearchToolEnabled: () => h.provider !== 'off',
}))
vi.mock('../../src/main/chat/web-search/backends', () => ({ webSearchBackends: () => h.backends }))

import { webSearchTool } from '../../src/main/chat/tools/web-search'
import type { ToolContext } from '../../src/main/chat/tools/util'

function backend(
  id: WebSearchBackendId,
  label: string,
  opts: { available?: boolean; outcome?: WebSearchOutcome } = {}
): WebSearchBackend {
  return {
    id,
    label,
    unavailableReason: 'add a key',
    available: () => opts.available ?? false,
    search: vi.fn(async (): Promise<WebSearchOutcome> => opts.outcome ?? { kind: 'results', hits: [] }),
  }
}

function useBackends(outcome?: WebSearchOutcome): Record<WebSearchBackendId, WebSearchBackend> {
  const backends = {
    tavily: backend('tavily', 'Tavily'),
    brave: backend('brave', 'Brave Search', { available: true, outcome }),
    chatgpt: backend('chatgpt', 'ChatGPT'),
    duckduckgo: backend('duckduckgo', 'DuckDuckGo'),
  }
  h.backends = backends
  return backends
}

function context(ask = vi.fn(async () => {})): ToolContext {
  return {
    conversationId: 'web-search-test',
    projectId: 'project',
    messageId: 'message',
    toolCallId: 'tool',
    cwd: '.',
    signal: new AbortController().signal,
    ask,
    askQuestion: async () => [],
  }
}

async function search(ctx: ToolContext, query = 'electron vibrancy') {
  const args = webSearchTool.parameters.parse({ query })
  const result = await webSearchTool.execute(args, ctx)
  return webSearchTool.toModelText(args, result)
}

beforeEach(() => {
  h.provider = 'auto'
})

describe('web_search tool', () => {
  it('asks permission for the query and formats list results', async () => {
    useBackends({
      kind: 'results',
      hits: [{ title: 'Title', url: 'https://docs.example.test/a', snippet: 'Snippet' }],
    })
    const ask = vi.fn(async () => {})
    const text = await search(context(ask))
    expect(ask).toHaveBeenCalledWith('web_search', ['electron vibrancy'], ['*'])
    expect(text).toBe(
      'Web search via Brave Search for "electron vibrancy":\n\n' +
        '1. Title\n   https://docs.example.test/a\n   Snippet\n\n' +
        'Use webfetch to read a result in full.'
    )
  })

  it('returns summaries as written', async () => {
    useBackends({ kind: 'summary', text: 'Found it.\n\nSources:\n1. Docs — https://docs.example.test' })
    expect(await search(context())).toBe(
      'Web search via Brave Search for "electron vibrancy":\n\nFound it.\n\nSources:\n1. Docs — https://docs.example.test'
    )
  })

  it('reports an empty result list', async () => {
    useBackends({ kind: 'results', hits: [] })
    expect(await search(context())).toBe('Web search via Brave Search for "electron vibrancy":\n\nNo results.')
  })

  it('refuses to run when turned off', async () => {
    h.provider = 'off'
    const backends = useBackends()
    const ask = vi.fn(async () => {})
    await expect(search(context(ask))).rejects.toThrow(/turned off/)
    expect(ask).not.toHaveBeenCalled()
    expect(backends.brave.search).not.toHaveBeenCalled()
  })

  it('does not search when permission is denied', async () => {
    const backends = useBackends()
    const ask = vi.fn(async () => {
      throw new Error('denied')
    })
    await expect(search(context(ask))).rejects.toThrow('denied')
    expect(backends.brave.search).not.toHaveBeenCalled()
  })

  it('validates the query and the result count', () => {
    expect(() => webSearchTool.parameters.parse({ query: '   ' })).toThrow()
    expect(() => webSearchTool.parameters.parse({ query: 'q', max_results: 11 })).toThrow()
    expect(webSearchTool.parameters.parse({ query: ' q ' })).toEqual({ query: 'q', max_results: 5 })
  })
})
