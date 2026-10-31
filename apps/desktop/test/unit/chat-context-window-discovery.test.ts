import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  providers: new Map<string, { id: string; baseURL: string }>(),
}))

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))
vi.mock('../../src/main/store', () => ({
  getAppSetting: (key: string) => h.settings.get(key) ?? null,
  setAppSetting: (key: string, value: string) => void h.settings.set(key, value),
}))
vi.mock('../../src/main/chat/catalog', () => ({ getProvider: (id: string) => h.providers.get(id) }))
vi.mock('../../src/main/chat/model-meta', () => ({
  catalogProviderForBaseURL: (baseURL: string) => (baseURL.includes('api.openai.com') ? 'openai' : null),
}))

import {
  discoverContextWindow,
  getLearnedContextWindow,
  isLocalOrCustomBaseURL,
  learnContextLimitFromError,
  learnContextLimitFromFailureText,
  llamaCppWindowFromProps,
  lmStudioWindowFromModels,
  ollamaWindowFromShow,
  probeServerContextWindow,
  resetContextWindowDiscoveryForTests,
  resolveProviderContextWindow,
} from '../../src/main/chat/context-window-discovery'
import { extractCatalog } from '../../src/main/chat/models'

type Route = Record<string, unknown>

/** A fake server answering JSON by path; every other path is a 404. */
function server(routes: Route) {
  const calls: string[] = []
  const fetcher = vi.fn(async (url: string) => {
    calls.push(url)
    const path = new URL(url).pathname
    return path in routes ? { ok: true, json: async () => routes[path] } : { ok: false, json: async () => ({}) }
  })
  return { fetcher, calls }
}

beforeEach(() => {
  h.settings.clear()
  h.providers.clear()
  resetContextWindowDiscoveryForTests()
})

describe('server metadata', () => {
  it('Ollama: the runtime num_ctx wins over the trained context length', () => {
    expect(
      ollamaWindowFromShow({
        parameters: 'stop "<|im_end|>"\nnum_ctx                        8192',
        model_info: { 'qwen2.context_length': 32768 },
      })
    ).toBe(8192)
    expect(ollamaWindowFromShow({ model_info: { 'llama.context_length': 131072 } })).toBe(131072)
    expect(ollamaWindowFromShow({ parameters: 'temperature 0.7' })).toBeUndefined()
  })

  it('LM Studio: the loaded instance, else the maximum', () => {
    const body = {
      models: [
        { key: 'other', max_context_length: 4096 },
        {
          key: 'qwen/qwen3-8b',
          max_context_length: 40960,
          loaded_instances: [{ config: { context_length: 16384 } }],
        },
        { key: 'mistral', max_context_length: 32768, loaded_instances: [] },
      ],
    }
    expect(lmStudioWindowFromModels(body, 'qwen/qwen3-8b')).toBe(16384)
    expect(lmStudioWindowFromModels(body, 'mistral')).toBe(32768)
    expect(lmStudioWindowFromModels(body, 'missing')).toBeUndefined()
  })

  it('llama.cpp: the slot context from /props', () => {
    expect(llamaCppWindowFromProps({ default_generation_settings: { n_ctx: 4096 } })).toBe(4096)
    expect(llamaCppWindowFromProps({})).toBeUndefined()
  })

  it('vLLM and other OpenAI-compatible servers: window fields of /models', () => {
    expect(
      extractCatalog({
        data: [
          { id: 'vllm-model', max_model_len: 32768 },
          { id: 'lmstudio', max_context_length: 8192 },
          { id: 'llamacpp', n_ctx: 4096 },
        ],
      }).windows
    ).toEqual({ 'vllm-model': 32768, lmstudio: 8192, llamacpp: 4096 })
  })
})

describe('probing', () => {
  it('asks only the configured origin, and the first server kind that answers wins', async () => {
    const { fetcher, calls } = server({ '/props': { default_generation_settings: { n_ctx: 8192 } } })
    expect(await probeServerContextWindow('http://127.0.0.1:8080/v1', 'model', fetcher)).toBe(8192)
    expect(calls.every((url) => url.startsWith('http://127.0.0.1:8080/'))).toBe(true)
  })

  it('probes local and custom servers only, once per model for five minutes', async () => {
    h.providers.set('local', { id: 'local', baseURL: 'http://localhost:11434/v1' })
    h.providers.set('openai', { id: 'openai', baseURL: 'https://api.openai.com/v1' })
    const { fetcher, calls } = server({ '/api/show': { parameters: 'num_ctx 8192' } })
    expect(isLocalOrCustomBaseURL('https://api.openai.com/v1')).toBe(false)
    expect(isLocalOrCustomBaseURL('https://llm.internal.example/v1')).toBe(true)

    expect(await discoverContextWindow('openai', 'gpt-5', fetcher)).toBeUndefined()
    expect(calls).toEqual([])
    const [first, second] = await Promise.all([
      discoverContextWindow('local', 'qwen', fetcher),
      discoverContextWindow('local', 'qwen', fetcher),
    ])
    expect([first, second]).toEqual([8192, 8192])
    const probes = calls.length
    expect(await discoverContextWindow('local', 'qwen', fetcher)).toBe(8192)
    expect(calls.length).toBe(probes)
  })
})

describe('limits revealed by errors', () => {
  it('keeps only a smaller limit', () => {
    expect(learnContextLimitFromError('p', 'm', 32_000)).toBe(true)
    expect(learnContextLimitFromError('p', 'm', 64_000)).toBe(false)
    expect(getLearnedContextWindow('p', 'm')).toBe(32_000)
    expect(learnContextLimitFromError('p', 'm', 16_000)).toBe(true)
    expect(getLearnedContextWindow('p', 'm')).toBe(16_000)
    expect(learnContextLimitFromError('p', 'm', 12)).toBe(false)
  })

  it('reads the limit from an overflow message, never from throttling', () => {
    expect(
      learnContextLimitFromFailureText(
        'p',
        'm',
        "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens."
      )
    ).toBe(true)
    expect(getLearnedContextWindow('p', 'm')).toBe(8192)
    expect(learnContextLimitFromFailureText('p', 'n', 'Rate limit: too many tokens per minute (limit 4096)')).toBe(
      false
    )
  })
})

describe('resolveProviderContextWindow', () => {
  it('a learned limit caps the live window', async () => {
    h.providers.set('local', { id: 'local', baseURL: 'http://localhost:11434/v1' })
    const { fetcher } = server({ '/api/show': { parameters: 'num_ctx 32768' } })
    learnContextLimitFromError('local', 'qwen', 16_384)
    expect(await resolveProviderContextWindow('local', 'qwen', async () => undefined, fetcher)).toBe(16_384)
  })

  it('a reconfigured server drops the learned limit', async () => {
    h.providers.set('local', { id: 'local', baseURL: 'http://localhost:11434/v1' })
    const before = server({ '/api/show': { parameters: 'num_ctx 8192' } })
    await discoverContextWindow('local', 'qwen', before.fetcher)
    learnContextLimitFromError('local', 'qwen', 4096)
    resetContextWindowDiscoveryForTests()
    const after = server({ '/api/show': { parameters: 'num_ctx 65536' } })
    expect(await resolveProviderContextWindow('local', 'qwen', async () => undefined, after.fetcher)).toBe(65536)
    expect(getLearnedContextWindow('local', 'qwen')).toBeUndefined()
  })

  it('a remote custom gateway with a listed window is not probed', async () => {
    h.providers.set('gw', { id: 'gw', baseURL: 'https://llm.internal.example/v1' })
    const { fetcher, calls } = server({})
    expect(await resolveProviderContextWindow('gw', 'm', async () => 200_000, fetcher)).toBe(200_000)
    expect(calls).toEqual([])
  })
})
