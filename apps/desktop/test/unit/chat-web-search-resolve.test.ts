import { describe, expect, it, vi } from 'vitest'
import { runWebSearch } from '../../src/main/chat/web-search/resolve'
import type {
  WebSearchBackend,
  WebSearchBackendId,
  WebSearchOutcome,
  WebSearchRequest,
} from '../../src/main/chat/web-search/types'

const LABELS: Record<WebSearchBackendId, string> = {
  tavily: 'Tavily',
  brave: 'Brave',
  chatgpt: 'ChatGPT',
  google: 'Google AI',
  duckduckgo: 'DuckDuckGo',
}

function fake(
  id: WebSearchBackendId,
  opts: { available?: boolean; search?: (request: WebSearchRequest) => Promise<WebSearchOutcome> } = {}
): WebSearchBackend {
  return {
    id,
    label: LABELS[id],
    unavailableReason: 'add a key',
    available: vi.fn(() => opts.available ?? true),
    search: vi.fn(opts.search ?? (async () => ({ kind: 'results', hits: [] }) as WebSearchOutcome)),
  }
}

function request(signal = new AbortController().signal): WebSearchRequest {
  return { query: 'electron vibrancy', maxResults: 5, signal, conversationId: 'c', cwd: '.' }
}

const hits = (url: string): WebSearchOutcome => ({ kind: 'results', hits: [{ title: 't', url, snippet: '' }] })

describe('runWebSearch', () => {
  it('skips unavailable backends in automatic mode', async () => {
    const backends = {
      tavily: fake('tavily', { available: false }),
      brave: fake('brave', { search: async () => hits('https://brave.example.test') }),
      chatgpt: fake('chatgpt'),
      google: fake('google'),
      duckduckgo: fake('duckduckgo'),
    }
    const run = await runWebSearch({ provider: 'auto', backends, request: request() })
    expect(run.backend.id).toBe('brave')
    expect(run.outcome).toEqual(hits('https://brave.example.test'))
    expect(backends.tavily.search).not.toHaveBeenCalled()
    expect(backends.chatgpt.available).not.toHaveBeenCalled()
    expect(backends.chatgpt.search).not.toHaveBeenCalled()
  })

  it('falls back to the next backend after a failure in automatic mode', async () => {
    const backends = {
      tavily: fake('tavily', { available: false }),
      brave: fake('brave', {
        search: async () => {
          throw new Error('HTTP 429')
        },
      }),
      chatgpt: fake('chatgpt', { search: async () => ({ kind: 'summary', text: 'Found.' }) }),
      google: fake('google'),
      duckduckgo: fake('duckduckgo'),
    }
    const run = await runWebSearch({ provider: 'auto', backends, request: request() })
    expect(run.backend.id).toBe('chatgpt')
    expect(run.outcome).toEqual({ kind: 'summary', text: 'Found.' })
    expect(backends.duckduckgo.search).not.toHaveBeenCalled()
  })

  it('searches with Google AI after ChatGPT and before DuckDuckGo in automatic mode', async () => {
    const backends = {
      tavily: fake('tavily', { available: false }),
      brave: fake('brave', { available: false }),
      chatgpt: fake('chatgpt', { available: false }),
      google: fake('google', { search: async () => ({ kind: 'summary', text: 'Grounded.' }) }),
      duckduckgo: fake('duckduckgo'),
    }
    const search = request()
    const run = await runWebSearch({ provider: 'auto', backends, request: search })
    expect(run.backend.id).toBe('google')
    expect(run.outcome).toEqual({ kind: 'summary', text: 'Grounded.' })
    // Availability depends on the conversation, whose accounts may be off limits.
    expect(backends.google.available).toHaveBeenCalledWith(search)
    expect(backends.duckduckgo.available).not.toHaveBeenCalled()
  })

  it('reports every backend when all of them fail', async () => {
    const failing = (message: string) => async () => {
      throw new Error(message)
    }
    const backends = {
      tavily: fake('tavily', { available: false }),
      brave: fake('brave', { search: failing('HTTP 429') }),
      chatgpt: fake('chatgpt', { search: failing('x') }),
      google: fake('google', { search: failing('quota') }),
      duckduckgo: fake('duckduckgo', { search: failing('blocked') }),
    }
    const error = await runWebSearch({ provider: 'auto', backends, request: request() }).catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    for (const part of [
      'Tavily: add a key',
      'Brave: HTTP 429',
      'ChatGPT: x',
      'Google AI: quota',
      'DuckDuckGo: blocked',
    ])
      expect(message).toContain(part)
  })

  it('propagates an abort without trying the next backend', async () => {
    const controller = new AbortController()
    const backends = {
      tavily: fake('tavily', {
        search: async () => {
          controller.abort(new DOMException('Aborted', 'AbortError'))
          throw new Error('request aborted')
        },
      }),
      brave: fake('brave'),
      chatgpt: fake('chatgpt'),
      google: fake('google'),
      duckduckgo: fake('duckduckgo'),
    }
    await expect(runWebSearch({ provider: 'auto', backends, request: request(controller.signal) })).rejects.toThrow(
      /Aborted/
    )
    expect(backends.brave.available).not.toHaveBeenCalled()
    expect(backends.brave.search).not.toHaveBeenCalled()
  })

  it('does not fall back from an unavailable explicit provider', async () => {
    const backends = {
      tavily: fake('tavily', { available: false }),
      brave: fake('brave'),
      chatgpt: fake('chatgpt'),
      google: fake('google'),
      duckduckgo: fake('duckduckgo'),
    }
    await expect(runWebSearch({ provider: 'tavily', backends, request: request() })).rejects.toThrow(
      'Tavily is not available: add a key.'
    )
    expect(backends.brave.search).not.toHaveBeenCalled()
    expect(backends.duckduckgo.search).not.toHaveBeenCalled()
  })

  it('does not fall back from a failing explicit provider', async () => {
    const backends = {
      tavily: fake('tavily'),
      brave: fake('brave', {
        search: async () => {
          throw new Error('Brave returned HTTP 500.')
        },
      }),
      chatgpt: fake('chatgpt'),
      google: fake('google'),
      duckduckgo: fake('duckduckgo'),
    }
    await expect(runWebSearch({ provider: 'brave', backends, request: request() })).rejects.toThrow(
      'Brave returned HTTP 500.'
    )
    expect(backends.tavily.search).not.toHaveBeenCalled()
    expect(backends.chatgpt.search).not.toHaveBeenCalled()
    expect(backends.duckduckgo.search).not.toHaveBeenCalled()
  })

  it('refuses to search when turned off', async () => {
    const backends = {
      tavily: fake('tavily'),
      brave: fake('brave'),
      chatgpt: fake('chatgpt'),
      google: fake('google'),
      duckduckgo: fake('duckduckgo'),
    }
    await expect(runWebSearch({ provider: 'off', backends, request: request() })).rejects.toThrow(/turned off/)
    expect(backends.tavily.search).not.toHaveBeenCalled()
  })
})
