import { describe, expect, it } from 'vitest'
import {
  applySchemaDialect,
  inlineLocalRefs,
  selectSchemaDialect,
  toGeminiSchema,
  toLlamaCppSchema,
  toMoonshotSchema,
  toXaiSchema,
} from '../../src/main/chat/tool-robustness/schema-dialects'
import { adaptRequestTools } from '../../src/main/chat/tool-robustness/model-middleware'

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const entry of Object.values(value)) deepFreeze(entry)
  }
  return value
}

describe('selectSchemaDialect', () => {
  const pick = (baseURL: string, modelId: string, transport = 'openai', grok = false) =>
    selectSchemaDialect({ transport, baseURL, modelId, grok })

  it('selects by host first, then by model id', () => {
    expect(pick('https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-4-argon')).toBe('gemini')
    expect(pick('https://us-central1-aiplatform.googleapis.com/v1/projects/x', 'any')).toBe('gemini')
    expect(pick('https://aiplatform.googleapis.com/v1/projects/x', 'any')).toBe('gemini')
    expect(pick('https://evilaiplatform.googleapis.com/v1', 'any')).toBeNull()
    expect(pick('https://aiplatform.googleapis.com.example.test/v1', 'any')).toBeNull()
    expect(pick('https://openrouter.ai/api/v1', 'google/gemini-4-argon')).toBe('gemini')
    expect(pick('https://api.moonshot.ai/v1', 'kimi-k3')).toBe('moonshot')
    expect(pick('https://openrouter.ai/api/v1', 'moonshotai/kimi-k3')).toBe('moonshot')
    expect(pick('https://api.x.ai/v1', 'grok-5')).toBe('xai')
    expect(pick('https://grok.example/v1', 'grok-5', 'openai', true)).toBe('xai')
    expect(pick('http://127.0.0.1:8080/v1', 'qwen3-coder')).toBe('llamacpp')
    expect(pick('http://localhost:11434/v1', 'kimi-k3')).toBe('llamacpp')
    expect(pick('http://192.168.1.20:1234/v1', 'llama-4')).toBe('llamacpp')
    expect(pick('https://api.deepseek.com/v1', 'deepseek-v4-pro')).toBeNull()
  })

  it('never adapts Anthropic or OpenAI Responses', () => {
    expect(pick('https://api.anthropic.com/v1', 'gemini-lookalike', 'anthropic')).toBeNull()
    expect(pick('https://api.openai.com/v1', 'gpt-6', 'openai-responses')).toBeNull()
  })
})

const recursive = deepFreeze({
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: {
    tree: { $ref: '#/$defs/node', description: 'The tree' },
    mode: { const: 'fast' },
    pair: { type: 'array', items: [{ type: 'string' }, { type: 'number' }], additionalItems: { type: 'boolean' } },
    level: { anyOf: [{ const: 1 }, { const: 2 }, { enum: [3] }], description: 'Level' },
    kind: {
      oneOf: [
        { type: 'string', const: 'a' },
        { type: 'string', const: 'b' },
      ],
    },
    either: { anyOf: [{ type: 'string' }, { type: 'number' }] },
    ratio: { type: 'number', minimum: 0, exclusiveMinimum: true, maximum: 1, exclusiveMaximum: false },
  },
  required: ['tree', 'ghost'],
  $defs: {
    node: {
      type: 'object',
      properties: { value: { type: 'integer' }, children: { type: 'array', items: { $ref: '#/$defs/node' } } },
      required: ['value', 'missing'],
    },
  },
})

describe('Gemini dialect', () => {
  it('inlines refs, cuts recursion and rewrites unsupported constructs', () => {
    const out = toGeminiSchema(recursive) as Record<string, any>
    expect(out).not.toHaveProperty('$defs')
    expect(JSON.stringify(out)).not.toContain('$ref')
    expect(out.required).toEqual(['tree'])
    expect(out.properties.tree.description).toBe('The tree')
    expect(out.properties.tree.required).toEqual(['value'])
    expect(out.properties.tree.properties.value).toEqual({ type: 'integer' })
    // The recursive reference becomes an unconstrained schema instead of an endless expansion.
    expect(out.properties.tree.properties.children.items).toEqual({})
    expect(out.properties.mode).toEqual({ enum: ['fast'] })
    expect(out.properties.pair).toEqual({
      type: 'array',
      prefixItems: [{ type: 'string' }, { type: 'number' }],
      items: { type: 'boolean' },
    })
    expect(out.properties.level).toEqual({ description: 'Level', type: 'integer', enum: [1, 2, 3] })
    expect(out.properties.kind).toEqual({ type: 'string', enum: ['a', 'b'] })
    expect(out.properties.either).toEqual({ anyOf: [{ type: 'string' }, { type: 'number' }] })
    expect(out.properties.ratio).toEqual({ type: 'number', exclusiveMinimum: 0, maximum: 1 })
  })

  it('is idempotent and guarantees an object root', () => {
    const once = toGeminiSchema(recursive)
    expect(toGeminiSchema(once)).toEqual(once)
    expect(toGeminiSchema({})).toEqual({ type: 'object', properties: {} })
    expect(toGeminiSchema({ properties: { a: { type: 'string' } } })).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } },
    })
  })

  it('returns an untouched schema as the same reference', () => {
    const plain = deepFreeze({ type: 'object', properties: { path: { type: 'string' } }, required: ['path'] })
    expect(toGeminiSchema(plain)).toBe(plain)
  })
})

describe('other dialects', () => {
  it('moonshot types untyped enums and turns tuples into an item union', () => {
    const out = toMoonshotSchema(
      deepFreeze({
        type: 'object',
        properties: {
          mode: { enum: ['a', 'b'] },
          maybe: { enum: [1, 2, null] },
          mixed: { enum: ['a', 1] },
          pair: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] },
          rest: { type: 'array', prefixItems: [{ type: 'string' }], items: { type: 'integer' } },
          one: { type: 'array', items: [{ type: 'string' }] },
          ref: { $ref: '#/definitions/x' },
        },
        definitions: { x: { type: 'string' } },
      })
    ) as Record<string, any>
    expect(out.properties.mode).toEqual({ enum: ['a', 'b'], type: 'string' })
    expect(out.properties.maybe).toEqual({ enum: [1, 2, null], type: ['integer', 'null'] })
    expect(out.properties.mixed).toEqual({ enum: ['a', 1] })
    expect(out.properties.pair).toEqual({ type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] } })
    expect(out.properties.rest).toEqual({ type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'integer' }] } })
    expect(out.properties.one).toEqual({ type: 'array', items: { type: 'string' } })
    expect(out.properties.ref).toEqual({ type: 'string' })
    expect(out).not.toHaveProperty('definitions')
  })

  it('xai drops contains bounds', () => {
    expect(
      toXaiSchema({
        type: 'object',
        properties: {
          tags: { type: 'array', items: { type: 'string' }, contains: { const: 'x' }, minContains: 1, maxContains: 2 },
        },
      })
    ).toEqual({
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' }, contains: { const: 'x' } } },
    })
  })

  it('llama.cpp drops patterns and long length bounds, never a property named pattern', () => {
    const grep = deepFreeze({
      type: 'object',
      properties: {
        pattern: { type: 'string', pattern: '^\\S+$', maxLength: 500 },
        content: { type: 'string', maxLength: 100000 },
        include: { type: 'string', maxLength: 1999 },
      },
      required: ['pattern'],
    })
    expect(toLlamaCppSchema(grep)).toEqual({
      type: 'object',
      properties: {
        pattern: { type: 'string', maxLength: 500 },
        content: { type: 'string' },
        include: { type: 'string', maxLength: 1999 },
      },
      required: ['pattern'],
    })
  })

  it('inlines refs inside definitions too and keeps external refs out of the request', () => {
    expect(
      inlineLocalRefs({
        type: 'object',
        properties: { a: { $ref: '#/$defs/b' }, ext: { $ref: 'https://example.com/s.json', description: 'x' } },
        $defs: { b: { $ref: '#/$defs/c' }, c: { type: 'boolean' } },
      })
    ).toEqual({ type: 'object', properties: { a: { type: 'boolean' }, ext: { description: 'x' } } })
  })

  it('adapts only the function tools of a request and keeps the array when nothing changes', () => {
    const tools = [
      {
        type: 'function' as const,
        name: 'a',
        inputSchema: { type: 'object' as const, properties: { m: { const: 1 } } },
      },
      { type: 'provider' as const, id: 'x.y' as const, name: 'y', args: {} },
    ]
    const adapted = adaptRequestTools(tools, 'gemini')!
    expect(adapted).not.toBe(tools)
    expect((adapted[0] as { inputSchema: unknown }).inputSchema).toEqual({
      type: 'object',
      properties: { m: { enum: [1] } },
    })
    expect(adapted[1]).toBe(tools[1])
    expect(adaptRequestTools(tools, null)).toBe(tools)
    expect(adaptRequestTools(tools, 'xai')).toBe(tools)
    expect(applySchemaDialect(tools[0].inputSchema, 'llamacpp')).toBe(tools[0].inputSchema)
  })
})
