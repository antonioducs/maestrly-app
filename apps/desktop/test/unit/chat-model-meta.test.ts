import { describe, it, expect } from 'vitest'
import {
  catalogModelMeta,
  catalogModelMetaWithStatus,
  catalogProviderForBaseURL,
  claudeHarnessCatalogModelId,
  composeEffectiveMeta,
  filterChatModels,
  filterChatModelsSnapshot,
  parseCatalog,
  selectProviderModelMeta,
} from '../../src/main/chat/model-meta'

/** models.dev context-window and pricing parser using real API shapes. */
const sample = {
  openai: {
    id: 'openai',
    models: {
      'gpt-4o-mini': {
        id: 'openai/gpt-4o-mini',
        name: 'GPT-4o Mini',
        reasoning: false,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 128000, output: 16384 },
        cost: { input: 0.15, output: 0.6, cache_read: 0.08, cache_write: 0.19 },
      },
    },
  },
  anthropic: {
    models: {
      'claude-opus-4': {
        id: 'anthropic/claude-opus-4',
        reasoning: true,
        reasoning_options: [
          { type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] },
          { type: 'budget_tokens', min: 1024 },
        ],
        modalities: { input: ['text'], output: ['text'] }, // plain text → vision false
        limit: { context: 200000, output: 32000 },
        cost: { input: 15, output: 75 },
      },
      'claude-toggle': {
        id: 'anthropic/claude-toggle',
        reasoning: true,
        reasoning_options: [{ type: 'budget_tokens', min: 1024 }], // No effort: reasoningEfforts is undefined.
        limit: { context: 200000 },
        cost: { input: 1, output: 2 },
      },
    },
  },
  weird: { models: { 'no-meta': { id: 'weird/no-meta', name: 'no metadata' } } }, // No limit/cost: ignored.
  xiaomi: {
    models: {
      'mimo-tts': {
        id: 'xiaomi/mimo-tts',
        modalities: { input: ['text'], output: ['audio'] },
        limit: { context: 8000 },
        cost: { input: 1 },
      },
      'mimo-asr': {
        id: 'xiaomi/mimo-asr',
        modalities: { input: ['audio'], output: ['text'] },
        limit: { context: 8000 },
        cost: { input: 1 },
      },
    },
  },
  deepseek: {
    models: {
      'deepseek-v4-pro': {
        id: 'deepseek/deepseek-v4-pro',
        reasoning: true,
        interleaved: { field: 'reasoning_content' },
        reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high', 'max'] }],
        limit: { context: 131072 },
        cost: { input: 1, output: 4 },
      },
      // Unknown interleaved fields must not invent capabilities.
      'deepseek-bool': {
        id: 'deepseek/deepseek-bool',
        reasoning: true,
        interleaved: true,
        limit: { context: 131072 },
        cost: { input: 1, output: 4 },
      },
      // Unknown structured fields remain disabled.
      'deepseek-structured': {
        id: 'deepseek/deepseek-structured',
        reasoning: true,
        interleaved: { field: 'reasoning_details', format: 'json' },
        limit: { context: 131072 },
        cost: { input: 1, output: 4 },
      },
    },
  },
}

describe('parseCatalog (models.dev)', () => {
  it('indexes by model key AND provider/model id', () => {
    const m = parseCatalog(sample)
    expect(m.get('gpt-4o-mini')).toEqual({
      contextWindow: 128000,
      maxOutput: 16384,
      inputPer1M: 0.15,
      outputPer1M: 0.6,
      cacheReadPer1M: 0.08,
      cacheWritePer1M: 0.19,
      reasoning: false,
      vision: true,
      chatCapable: true,
    })
    expect(m.get('openai/gpt-4o-mini')?.contextWindow).toBe(128000)
    expect(m.get('claude-opus-4')).toMatchObject({ contextWindow: 200000, inputPer1M: 15, outputPer1M: 75 })
    expect(m.get('anthropic/claude-opus-4')?.outputPer1M).toBe(75)
  })

  it('ignores entries without windows or pricing', () => {
    expect(parseCatalog(sample).get('no-meta')).toBeUndefined()
  })

  it('extracts reasoning and image-input vision capabilities', () => {
    const m = parseCatalog(sample)
    expect(m.get('gpt-4o-mini')).toMatchObject({ reasoning: false, vision: true })
    expect(m.get('claude-opus-4')).toMatchObject({ reasoning: true, vision: false })
  })

  it('allows text chat and excludes TTS and audio-only ASR', () => {
    const m = parseCatalog(sample)
    expect(m.get('gpt-4o-mini')?.chatCapable).toBe(true) // in [text,image] / out [text]
    expect(m.get('claude-opus-4')?.chatCapable).toBe(true)
    expect(m.get('mimo-tts')?.chatCapable).toBe(false) // out [audio]
    expect(m.get('mimo-asr')?.chatCapable).toBe(false) // in [audio]
  })

  it('keeps unknown modalities unfiltered', () => {
    const m = parseCatalog({ p: { models: { x: { id: 'p/x', limit: { context: 1000 }, cost: { input: 1 } } } } })
    expect(m.get('x')?.chatCapable).toBeUndefined()
  })

  it('extracts optional cache read and write pricing', () => {
    const m = parseCatalog(sample)
    expect(m.get('gpt-4o-mini')).toMatchObject({ cacheReadPer1M: 0.08, cacheWritePer1M: 0.19 })
    expect(m.get('claude-opus-4')?.cacheReadPer1M).toBeUndefined()
    expect(m.get('claude-opus-4')?.cacheWritePer1M).toBeUndefined()
  })

  it('extracts interleaved.field = reasoning_content as a text capability', () => {
    const m = parseCatalog(sample)
    expect(m.get('deepseek-v4-pro')?.interleavedReasoning).toEqual({ field: 'reasoning_content', format: 'text' })
    // Also indexed by provider/model ID.
    expect(m.get('deepseek/deepseek-v4-pro')?.interleavedReasoning).toEqual({
      field: 'reasoning_content',
      format: 'text',
    })
  })

  it('ignores unknown interleaved shapes', () => {
    const m = parseCatalog(sample)
    expect(m.get('deepseek-bool')?.interleavedReasoning).toBeUndefined()
    expect(m.get('deepseek-structured')?.interleavedReasoning).toBeUndefined()
  })

  it('does not invent interleaved capabilities for reasoning models', () => {
    const m = parseCatalog(sample)
    expect(m.get('claude-opus-4')?.reasoning).toBe(true)
    expect(m.get('claude-opus-4')?.interleavedReasoning).toBeUndefined()
  })

  it('extracts effort levels from reasoning options', () => {
    const m = parseCatalog(sample)
    expect(m.get('claude-opus-4')?.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(m.get('anthropic/claude-opus-4')?.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    // Budget-only options yield undefined and use default UI efforts.
    expect(m.get('claude-toggle')?.reasoningEfforts).toBeUndefined()
    expect(m.get('claude-toggle')?.reasoning).toBe(true)
    // This model omits reasoning_options.
    expect(m.get('gpt-4o-mini')?.reasoningEfforts).toBeUndefined()
  })

  it('distinguishes unknown vision from false', () => {
    const m = parseCatalog({ p: { models: { x: { id: 'p/x', limit: { context: 1000 }, cost: { input: 1 } } } } })
    expect(m.get('x')?.vision).toBeUndefined()
  })

  it('tolerates invalid JSON and unexpected shapes', () => {
    expect(parseCatalog(null).size).toBe(0)
    expect(parseCatalog('x').size).toBe(0)
    expect(parseCatalog({ p: {} }).size).toBe(0)
    expect(parseCatalog({ p: { models: 'nope' } }).size).toBe(0)
  })

  // Duplicate model IDs must not depend on write order; the canonical provider
  // wins even in the middle of the JSON when a later reseller has a smaller window or incomplete effort.
  it('prefers canonical provider entries on ID collisions', () => {
    const collide = {
      // azure appears BEFORE and AFTER anthropic with 200k and no xhigh; last-write-wins selected it.
      azure: {
        models: {
          'claude-opus-4-8': {
            id: 'claude-opus-4-8',
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'max'] }],
            limit: { context: 200000 },
            cost: { input: 5, output: 25 },
          },
        },
      },
      anthropic: {
        models: {
          'claude-opus-4-8': {
            id: 'claude-opus-4-8',
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }],
            limit: { context: 1000000 },
            cost: { input: 5, output: 25 },
          },
        },
      },
      'azure-cognitive-services': {
        models: {
          'claude-opus-4-8': {
            id: 'claude-opus-4-8',
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'max'] }],
            limit: { context: 200000 },
            cost: { input: 5, output: 25 },
          },
        },
      },
    }
    const m = parseCatalog(collide)
    expect(m.get('claude-opus-4-8')?.contextWindow).toBe(1000000) // anthropic, not the later azure entry.
    expect(m.get('claude-opus-4-8')?.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  // Unknown families break ties by largest context window, not insertion order.
  it('prefers larger windows when no canonical provider exists', () => {
    const collide = {
      gatewayA: { models: { 'acme-llm-1': { id: 'acme-llm-1', limit: { context: 32000 }, cost: { input: 1 } } } },
      gatewayB: { models: { 'acme-llm-1': { id: 'acme-llm-1', limit: { context: 256000 }, cost: { input: 1 } } } },
      gatewayC: { models: { 'acme-llm-1': { id: 'acme-llm-1', limit: { context: 128000 }, cost: { input: 1 } } } },
    }
    expect(parseCatalog(collide).get('acme-llm-1')?.contextWindow).toBe(256000)
  })

  it('preserves provider-specific prices without unknown-provider fallback', () => {
    const map = parseCatalog({
      openai: {
        models: {
          'gpt-shared': { id: 'gpt-shared', limit: { context: 128000 }, cost: { input: 2, output: 8 } },
        },
      },
      openrouter: {
        models: {
          'gpt-shared': { id: 'gpt-shared', limit: { context: 128000 }, cost: { input: 3, output: 9 } },
        },
      },
    })
    expect(catalogModelMeta(map, 'gpt-shared', 'openai')).toMatchObject({ inputPer1M: 2, outputPer1M: 8 })
    expect(catalogModelMeta(map, 'gpt-shared', 'openrouter')).toMatchObject({ inputPer1M: 3, outputPer1M: 9 })
    expect(catalogModelMeta(map, 'gpt-shared', 'custom-proxy')).toBeNull()
    expect(catalogModelMeta(map, 'gpt-shared')).toMatchObject({ inputPer1M: 2 }) // Canonical entry without provider.
  })

  it('keeps cached metadata verifiable after refresh failure', () => {
    const map = parseCatalog({
      openai: {
        models: {
          'gpt-5.5': {
            id: 'gpt-5.5',
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh'] }],
            limit: { context: 128000 },
          },
        },
      },
    })
    expect(catalogModelMetaWithStatus(map, 'unavailable', 'gpt-5.5', 'openai')).toMatchObject({
      status: 'available',
      meta: { reasoning: true, reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'] },
    })
    expect(catalogModelMetaWithStatus(map, 'unavailable', 'missing', 'openai')).toEqual({
      status: 'unavailable',
      meta: null,
    })
  })
})

describe('Claude harness alias to Anthropic catalog resolution', () => {
  // Claude reports aliases while models.dev indexes concrete IDs.
  const price = { input: 5, output: 25 }
  const map = parseCatalog({
    anthropic: {
      models: {
        'claude-opus-4-5': { id: 'claude-opus-4-5', limit: { context: 200000 }, cost: price },
        'claude-opus-4-8': { id: 'claude-opus-4-8', limit: { context: 1000000 }, cost: price },
        'claude-opus-5': { id: 'claude-opus-5', limit: { context: 1000000 }, cost: price },
        'claude-sonnet-4-5-20250929': {
          id: 'claude-sonnet-4-5-20250929',
          limit: { context: 1000000 },
          cost: { input: 3, output: 15 },
        },
        'claude-sonnet-5': { id: 'claude-sonnet-5', limit: { context: 1000000 }, cost: { input: 2, output: 10 } },
        'claude-haiku-4-5': { id: 'claude-haiku-4-5', limit: { context: 200000 }, cost: { input: 1, output: 5 } },
        'claude-haiku-4-5-20251001': {
          id: 'claude-haiku-4-5-20251001',
          limit: { context: 200000 },
          cost: { input: 1, output: 5 },
        },
        'claude-fable-5': { id: 'claude-fable-5', limit: { context: 1000000 }, cost: { input: 10, output: 50 } },
      },
    },
    // Newer reseller IDs cannot override official Anthropic pricing.
    azure: { models: { 'claude-opus-9': { id: 'claude-opus-9', limit: { context: 200000 }, cost: price } } },
  })

  it('resolves window variants to the latest family entry', () => {
    expect(claudeHarnessCatalogModelId(map, 'opus[1m]')).toBe('claude-opus-5')
    expect(claudeHarnessCatalogModelId(map, 'opus')).toBe('claude-opus-5')
    expect(claudeHarnessCatalogModelId(map, 'sonnet')).toBe('claude-sonnet-5')
    expect(claudeHarnessCatalogModelId(map, 'fable')).toBe('claude-fable-5')
  })

  it('matches known concrete model IDs directly', () => {
    expect(claudeHarnessCatalogModelId(map, 'claude-sonnet-4-5-20250929[1m]')).toBe('claude-sonnet-4-5-20250929')
    expect(claudeHarnessCatalogModelId(map, 'claude-opus-4-8')).toBe('claude-opus-4-8')
  })

  it('uses family fallback for unknown new model IDs', () => {
    expect(claudeHarnessCatalogModelId(map, 'claude-opus-4-9')).toBe('claude-opus-5')
    expect(claudeHarnessCatalogModelId(map, 'claude-haiku-9-1[2m]')).toBe('claude-haiku-4-5')
  })

  it('compares numeric version segments and prefers stable IDs on ties', () => {
    expect(claudeHarnessCatalogModelId(map, 'opus')).toBe('claude-opus-5') // 5 > 4-8 > 4-5
    expect(claudeHarnessCatalogModelId(map, 'haiku')).toBe('claude-haiku-4-5') // Not the -20251001 snapshot.
  })

  it('ignores newer reseller IDs outside Anthropic', () => {
    expect(claudeHarnessCatalogModelId(map, 'opus')).not.toBe('claude-opus-9')
  })

  it('does not invent prices for unknown families', () => {
    expect(claudeHarnessCatalogModelId(map, 'default')).toBeNull()
    expect(claudeHarnessCatalogModelId(map, '')).toBeNull()
    expect(claudeHarnessCatalogModelId(map, '[1m]')).toBeNull()
    expect(claudeHarnessCatalogModelId(new Map(), 'opus[1m]')).toBeNull()
  })

  it('prices resolved keys using the Anthropic catalog', () => {
    const key = claudeHarnessCatalogModelId(map, 'opus[1m]')
    expect(catalogModelMeta(map, key as string, 'anthropic')).toMatchObject({ inputPer1M: 5, outputPer1M: 25 })
  })
})

describe('single-source provider model capabilities', () => {
  const canonical = {
    status: 'available' as const,
    meta: { reasoning: true, reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'] },
  }

  it('prefers exact-provider metadata over canonical metadata', () => {
    expect(
      selectProviderModelMeta(
        { status: 'available', meta: { reasoning: true, reasoningEfforts: ['low', 'high'] } },
        canonical
      )
    ).toEqual({ status: 'available', meta: { reasoning: true, reasoningEfforts: ['low', 'high'] } })
  })

  it('uses canonical IDs when exact-provider entries are missing', () => {
    expect(selectProviderModelMeta(null, canonical)).toEqual(canonical)
    expect(selectProviderModelMeta({ status: 'available', meta: null }, canonical)).toEqual(canonical)
  })

  it('remains unavailable without any metadata source', () => {
    expect(selectProviderModelMeta({ status: 'available', meta: null }, { status: 'unavailable', meta: null })).toEqual(
      { status: 'unavailable', meta: null }
    )
  })

  it('preserves canonical interleaved reasoning for custom providers', () => {
    const canonical = {
      status: 'available' as const,
      meta: {
        reasoning: true,
        interleavedReasoning: { field: 'reasoning_content', format: 'text' as const },
      },
    }
    expect(selectProviderModelMeta(null, canonical)).toEqual(canonical)
    expect(selectProviderModelMeta({ status: 'available', meta: null }, canonical)).toEqual(canonical)
  })
})

describe('exact then canonical proxy pricing composition', () => {
  const exact: import('../../src/shared/chat').ChatModelMeta = {
    contextWindow: 200000,
    maxOutput: 32000,
    inputPer1M: 5,
    outputPer1M: 25,
    cacheReadPer1M: 0.5,
    cacheWritePer1M: 6.25,
    reasoning: true,
    reasoningEfforts: ['low', 'medium', 'high'],
    vision: false,
    chatCapable: true,
  }
  const canonical: import('../../src/shared/chat').ChatModelMeta = {
    contextWindow: 1000000,
    maxOutput: 64000,
    inputPer1M: 3,
    outputPer1M: 15,
    cacheReadPer1M: 0.3,
    cacheWritePer1M: 3.75,
    reasoning: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    vision: true,
    chatCapable: true,
  }

  it('mapped host with an exact entry uses the exact provider rate', () => {
    const m = composeEffectiveMeta(exact, canonical)
    expect(m).toMatchObject({
      inputPer1M: 5,
      outputPer1M: 25,
      cacheReadPer1M: 0.5,
      cacheWritePer1M: 6.25,
      contextWindow: 200000,
    })
  })

  it('falls back to canonical model prices for proxies', () => {
    const m = composeEffectiveMeta(null, canonical)
    expect(m).toMatchObject({
      inputPer1M: 3,
      outputPer1M: 15,
      cacheReadPer1M: 0.3,
      cacheWritePer1M: 3.75,
      contextWindow: 1000000,
    })
  })

  it('neither exact nor canonical returns null without metadata', () => {
    expect(composeEffectiveMeta(null, null)).toBeNull()
  })

  it('does not invent missing canonical prices', () => {
    const noPrice: import('../../src/shared/chat').ChatModelMeta = { contextWindow: 8000 }
    const m = composeEffectiveMeta(null, noPrice)
    expect(m?.inputPer1M).toBeUndefined()
    expect(m?.outputPer1M).toBeUndefined()
    expect(m?.contextWindow).toBe(8000)
  })

  it('preserves interleaved reasoning during metadata composition', () => {
    const withCapability: import('../../src/shared/chat').ChatModelMeta = {
      contextWindow: 131072,
      reasoning: true,
      interleavedReasoning: { field: 'reasoning_content', format: 'text' },
    }
    expect(composeEffectiveMeta(withCapability, null)?.interleavedReasoning).toEqual({
      field: 'reasoning_content',
      format: 'text',
    })
    // Custom proxies inherit capabilities from canonical model metadata.
    expect(composeEffectiveMeta(null, withCapability)?.interleavedReasoning).toEqual({
      field: 'reasoning_content',
      format: 'text',
    })
  })
})

describe('catalogProviderForBaseURL', () => {
  it('maps only recognized hosts and rejects custom proxies', () => {
    expect(catalogProviderForBaseURL('https://api.openai.com/v1')).toBe('openai')
    expect(catalogProviderForBaseURL('https://openrouter.ai/api/v1')).toBe('openrouter')
    expect(catalogProviderForBaseURL('https://api.anthropic.com/v1')).toBe('anthropic')
    expect(catalogProviderForBaseURL('https://proxy.example.com/v1')).toBeNull()
    expect(catalogProviderForBaseURL('not-a-url')).toBeNull()
  })
})

describe('chat model name heuristics for uncataloged IDs', () => {
  it('can apply the conservative filter synchronously without fetching models.dev', () => {
    expect(
      filterChatModelsSnapshot([
        'grok-4.6',
        'grok-imagine-image',
        'grok-imagine-video-1.5',
        'whisper-large-v3',
        'text-embedding-3-small',
      ])
    ).toEqual(['grok-4.6'])
  })

  // Network failure leaves an empty catalog, exercising name-only heuristics.
  it('filters speech, embedding and reranking models while preserving chat', async () => {
    const out = await filterChatModels([
      'gpt-4o',
      'mimo-v2.5',
      'mimo-v2.5-asr',
      'mimo-v2.5-tts',
      'mimo-v2.5-tts-voiceclone',
      'text-embedding-3-small',
      'qwen3-asr-flash',
      'bge-reranker-v2',
      'whisper-large-v3',
      'claude-opus-4',
    ])
    expect(out).toEqual(['gpt-4o', 'mimo-v2.5', 'claude-opus-4'])
  })
})
