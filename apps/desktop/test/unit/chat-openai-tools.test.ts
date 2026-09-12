import { asSchema } from '@ai-sdk/provider-utils'
import { jsonSchema, tool, type ToolExecutionOptions, type ToolSet } from 'ai'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  OpenAIToolScheduler,
  isOpenAIParallelSafeTool,
  isOpenAIReadOnlyTool,
  makeOpenAIFunctionSchemaStrict,
  optimizeOpenAITools,
} from '../../src/main/chat/openai/tools'

const executionOptions = { toolCallId: 'call-1', messages: [], context: undefined } as ToolExecutionOptions<unknown>

describe('OpenAI tool optimization', () => {
  it('closes object schemas and makes optional properties required nullable', () => {
    const converted = makeOpenAIFunctionSchemaStrict({
      type: 'object',
      properties: {
        optionalCount: { type: 'number' },
        optionalChoice: { type: 'string', enum: ['one', 'two'] },
        requiredName: { type: 'string' },
        nested: {
          type: 'object',
          properties: { flag: { type: 'boolean' } },
        },
        semanticNull: { type: ['string', 'null'] },
      },
      required: ['requiredName', 'semanticNull'],
    })

    expect(converted?.schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['nested', 'optionalChoice', 'optionalCount', 'requiredName', 'semanticNull'],
      properties: {
        optionalCount: { type: ['number', 'null'] },
        optionalChoice: { type: ['string', 'null'], enum: ['one', 'two', null] },
        requiredName: { type: 'string' },
        nested: {
          type: ['object', 'null'],
          additionalProperties: false,
          required: ['flag'],
          properties: { flag: { type: ['boolean', 'null'] } },
        },
        semanticNull: { type: ['string', 'null'] },
      },
    })
  })

  it('removes only synthetic nulls before execute and preserves semantic nulls', async () => {
    let received: unknown
    const result = await optimizeOpenAITools({
      inspect: tool({
        inputSchema: jsonSchema({
          type: 'object',
          properties: {
            optionalCount: { type: 'number' },
            semanticNull: { type: ['string', 'null'] },
            nested: {
              type: 'object',
              properties: { flag: { type: 'boolean' } },
            },
          },
          required: ['semanticNull'],
        }),
        execute: (input) => {
          received = input
          return input
        },
      }),
    })

    await result.tools.inspect.execute?.(
      { optionalCount: null, semanticNull: null, nested: { flag: null } },
      executionOptions
    )
    expect(received).toEqual({ semanticNull: null, nested: {} })
    expect(result.strictToolNames).toEqual(['inspect'])
  })

  it('leaves dynamic-map schemas non-strict instead of changing their contract', async () => {
    const result = await optimizeOpenAITools({
      labels: tool({
        inputSchema: jsonSchema({ type: 'object', additionalProperties: { type: 'string' } }),
        execute: (input) => input,
      }),
    })
    const schema = await asSchema(result.tools.labels.inputSchema).jsonSchema

    expect(result.tools.labels.strict).toBe(false)
    expect(schema).toEqual({ type: 'object', additionalProperties: { type: 'string' } })
    expect(result.nonStrictToolNames).toEqual(['labels'])
  })

  it('strips provider-unsupported annotations while preserving local defaults and validation', async () => {
    let received: unknown
    const result = await optimizeOpenAITools({
      inspect: tool({
        inputSchema: z.object({
          format: z.enum(['markdown', 'text']).default('markdown'),
        }),
        execute: (input) => {
          received = input
          return input
        },
      }),
    })
    const adaptedSchema = asSchema(result.tools.inspect.inputSchema)
    const wireSchema = await adaptedSchema.jsonSchema

    expect(result.strictToolNames).toEqual(['inspect'])
    expect(JSON.stringify(wireSchema)).not.toContain('"default"')
    expect(wireSchema).not.toHaveProperty('$schema')

    // The SDK validates before execute: synthetic null becomes absence, so the original Zod schema applies its default.
    const validation = await adaptedSchema.validate?.({ format: null })
    expect(validation).toEqual({ success: true, value: { format: 'markdown' } })
    if (validation?.success) await result.tools.inspect.execute?.(validation.value, executionOptions)
    expect(received).toEqual({ format: 'markdown' })
  })

  it('removes examples/readOnly recursively from the strict wire copy', () => {
    const converted = makeOpenAIFunctionSchemaStrict({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        value: {
          type: 'string',
          default: 'fallback',
          examples: ['example'],
          readOnly: true,
        },
      },
    })

    expect(converted?.schema).toEqual({
      type: 'object',
      properties: { value: { type: ['string', 'null'] } },
      required: ['value'],
      additionalProperties: false,
    })
  })

  it('normalizes Zod literals from const to a strict-compatible singleton enum', async () => {
    const result = await optimizeOpenAITools({
      inspect: tool({
        inputSchema: z.object({ kind: z.literal('inspect') }),
        execute: (input) => input,
      }),
    })
    const wireSchema = await asSchema(result.tools.inspect.inputSchema).jsonSchema

    expect(result.strictToolNames).toEqual(['inspect'])
    expect(wireSchema.properties?.kind).toMatchObject({ enum: ['inspect'] })
    expect(wireSchema.properties?.kind).not.toHaveProperty('const')
  })

  it('falls back to non-strict for combinators instead of promising unsupported compatibility', async () => {
    const original = {
      type: 'object' as const,
      properties: {
        value: {
          oneOf: [{ type: 'string' as const }, { type: 'number' as const }],
        },
      },
    }
    const result = await optimizeOpenAITools({
      inspect: tool({ inputSchema: jsonSchema(original), execute: (input) => input }),
    })

    expect(result.tools.inspect.strict).toBe(false)
    expect(await asSchema(result.tools.inspect.inputSchema).jsonSchema).toEqual(original)
    expect(result.nonStrictToolNames).toEqual(['inspect'])
  })

  it('falls back for multi-type unions outside the single-type-plus-null subset', async () => {
    const original = {
      type: 'object' as const,
      properties: { value: { type: ['string', 'number'] as Array<'string' | 'number'> } },
      required: ['value'],
    }
    const result = await optimizeOpenAITools({
      inspect: tool({ inputSchema: jsonSchema(original), execute: (input) => input }),
    })

    expect(result.tools.inspect.strict).toBe(false)
    expect(await asSchema(result.tools.inspect.inputSchema).jsonSchema).toEqual(original)
  })

  it('sorts tools, marks deferred namespaces, and adds hosted tool search', async () => {
    const empty = () => tool({ inputSchema: jsonSchema({ type: 'object', properties: {} }), execute: () => 'ok' })
    const tools: ToolSet = {
      zeta: empty(),
      notes_append: empty(),
      alpha: empty(),
      notes_read: empty(),
    }
    const result = await optimizeOpenAITools(tools, {
      deferredToolNames: ['notes_append', 'missing', 'notes_read'],
      enableToolSearch: true,
      conversationId: 'conv-1',
    })

    expect(Object.keys(result.tools)).toEqual(['alpha', 'notes_append', 'notes_read', 'toolSearch', 'zeta'])
    expect(result.toolSearchEnabled).toBe(true)
    expect(result.tools.toolSearch.type).toBe('provider')
    expect((result.tools.notes_read.providerOptions?.openai as Record<string, unknown>).deferLoading).toBe(true)
    expect((result.tools.notes_append.providerOptions?.openai as Record<string, unknown>).namespace).toEqual({
      name: 'maestrly_notes',
      description: 'Maestrly notes tools available on demand.',
    })
    expect(result.deferredToolNames).toEqual(['notes_append', 'notes_read'])
    expect(result.unknownDeferredToolNames).toEqual(['missing'])
    expect(result.scheduler.conversationId).toBe('conv-1')
  })

  it('does not defer tools when tool search is disabled', async () => {
    const result = await optimizeOpenAITools(
      {
        notes_read: tool({
          inputSchema: jsonSchema({ type: 'object', properties: {} }),
          execute: () => 'ok',
        }),
      },
      { deferredToolNames: ['notes_read'], enableToolSearch: false }
    )

    expect(result.toolSearchEnabled).toBe(false)
    expect(result.deferredToolNames).toEqual([])
    expect(result.tools.notes_read.providerOptions).toBeUndefined()
  })

  it('recognizes explicit metadata and conservative built-in read tools', () => {
    expect(isOpenAIParallelSafeTool('read')).toBe(true)
    expect(isOpenAIParallelSafeTool('edit')).toBe(false)
    const readOnlySerial = tool({
      metadata: { readOnly: true },
      inputSchema: jsonSchema({ type: 'object', properties: {} }),
      execute: () => 'ok',
    })
    expect(isOpenAIReadOnlyTool('custom_query', readOnlySerial)).toBe(true)
    expect(isOpenAIParallelSafeTool('custom_query', readOnlySerial)).toBe(false)
    const parallelMutation = tool({
      metadata: { parallelSafe: true, readOnly: false },
      inputSchema: jsonSchema({ type: 'object', properties: {} }),
      execute: () => 'ok',
    })
    expect(isOpenAIParallelSafeTool('task', parallelMutation)).toBe(true)
    expect(isOpenAIReadOnlyTool('task', parallelMutation)).toBe(false)
  })
})

describe('OpenAI tool scheduler', () => {
  it('runs reads in parallel and puts mutations behind fair barriers', async () => {
    const scheduler = new OpenAIToolScheduler('conv')
    const events: string[] = []
    let releaseReads!: () => void
    const readsBlocked = new Promise<void>((resolve) => {
      releaseReads = resolve
    })

    const readOne = scheduler.scheduleRead(async () => {
      events.push('read-1:start')
      await readsBlocked
      events.push('read-1:end')
    })
    const readTwo = scheduler.scheduleRead(async () => {
      events.push('read-2:start')
      await readsBlocked
      events.push('read-2:end')
    })
    const mutationOne = scheduler.scheduleMutation(async () => {
      events.push('write-1')
    })
    const readAfterMutation = scheduler.scheduleRead(async () => {
      events.push('read-3')
    })
    const mutationTwo = scheduler.scheduleMutation(async () => {
      events.push('write-2')
    })

    await Promise.resolve()
    expect(events).toEqual(['read-1:start', 'read-2:start'])
    releaseReads()
    await Promise.all([readOne, readTwo, mutationOne, readAfterMutation, mutationTwo])

    expect(events.slice(2, 4).sort()).toEqual(['read-1:end', 'read-2:end'])
    expect(events.indexOf('write-1')).toBeGreaterThan(events.indexOf('read-1:end'))
    expect(events.indexOf('read-3')).toBeGreaterThan(events.indexOf('write-1'))
    expect(events.indexOf('write-2')).toBeGreaterThan(events.indexOf('read-3'))
  })
})
