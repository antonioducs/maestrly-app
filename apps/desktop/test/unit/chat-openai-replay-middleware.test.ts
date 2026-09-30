import type { LanguageModelV4, LanguageModelV4StreamResult } from '@ai-sdk/provider'
import { jsonSchema, type ModelMessage, stepCountIs, streamText, tool } from 'ai'
import { net } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addProvider } from '../../src/main/chat/catalog'
import { setApiKey } from '../../src/main/chat/credentials'
import { openAIResponsesFetch, withOpenAIRawResponsesPrefix } from '../../src/main/chat/openai/raw-input'
import {
  OpenAIReplayMetadataError,
  restoreOpenAIAssistantTextReplay,
  withOpenAIResponsesReplay,
} from '../../src/main/chat/openai/replay-middleware'
import type { OpenAILedgerValue } from '../../src/main/chat/openai/types'
import { resolveLanguageModel } from '../../src/main/chat/provider'
import { closeDb, freshDb } from '../helpers/db'

beforeEach(freshDb)
afterEach(() => {
  vi.restoreAllMocks()
  closeDb()
})

type Body = Record<string, unknown>

function sse(events: readonly Record<string, unknown>[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const usage = {
  input_tokens: 10,
  input_tokens_details: { cached_tokens: 0, cache_write_tokens: null },
  output_tokens: 2,
  output_tokens_details: { reasoning_tokens: 0 },
}

function completed(): Record<string, unknown> {
  return {
    type: 'response.completed',
    response: { incomplete_details: null, usage, reasoning: null, service_tier: 'default' },
  }
}

function textResponse(id: string, text: string): Response {
  return sse([
    { type: 'response.created', response: { id: `resp_${id}`, created_at: 1, model: 'gpt-5.4', service_tier: null } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id, phase: 'final_answer' } },
    { type: 'response.output_text.delta', item_id: id, delta: text, logprobs: null },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id, phase: 'final_answer' } },
    completed(),
  ])
}

function commentaryThenToolResponse(): Response {
  const call = { type: 'function_call', id: 'fc_loop', call_id: 'call_loop', name: 'read' }
  return sse([
    { type: 'response.created', response: { id: 'resp_loop', created_at: 1, model: 'gpt-5.4', service_tier: null } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_loop', phase: 'commentary' },
    },
    { type: 'response.output_text.delta', item_id: 'msg_loop', delta: 'Reading.', logprobs: null },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'message', id: 'msg_loop', phase: 'commentary' },
    },
    { type: 'response.output_item.added', output_index: 1, item: { ...call, arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_loop', output_index: 1, delta: '{"path":"a.ts"}' },
    {
      type: 'response.output_item.done',
      output_index: 1,
      item: { ...call, arguments: '{"path":"a.ts"}', status: 'completed' },
    },
    completed(),
  ])
}

function nativeText(text: string, itemId: string, phase?: string) {
  return { type: 'text' as const, text, providerOptions: { openai: { itemId, ...(phase ? { phase } : {}) } } }
}

function productionModel(): LanguageModelV4 {
  const descriptor = addProvider({
    name: 'Replay OpenAI',
    baseURL: 'https://openai.invalid/v1',
    kind: 'openai-responses',
  })
  setApiKey(descriptor.id, 'test-key')
  return resolveLanguageModel(descriptor.id, 'gpt-5.4')
}

function mockNetFetch(respond: (body: Body, init: RequestInit | undefined) => Promise<Response> | Response): Body[] {
  const bodies: Body[] = []
  vi.spyOn(net, 'fetch').mockImplementation(async (input, init) => {
    const raw = input instanceof Request ? await input.clone().text() : String(init?.body)
    const body = JSON.parse(raw) as Body
    bodies.push(body)
    return (await respond(body, init)) as never
  })
  return bodies
}

function assistantItems(body: Body): Body[] {
  return (body.input as Body[]).filter((item) => item.role === 'assistant')
}

describe('restoreOpenAIAssistantTextReplay', () => {
  const user = { role: 'user', content: [{ type: 'input_text', text: 'Next.' }] }

  it('maps repeated equal texts by position and leaves unannotated text untouched', () => {
    const input: OpenAILedgerValue[] = [
      { role: 'assistant', content: 'Same.' },
      user,
      { role: 'assistant', content: 'Same.' },
      { role: 'assistant', content: 'Same.', phase: 'final_answer' },
    ]
    const body = { store: false, input }
    const restored = restoreOpenAIAssistantTextReplay(body, [
      { text: 'Same.', itemId: 'msg_a' },
      { text: 'Same.' },
      { text: 'Same.', itemId: 'msg_b', phase: 'final_answer' },
    ])

    expect(restored.input).toEqual([
      { type: 'message', role: 'assistant', id: 'msg_a', content: [{ type: 'output_text', text: 'Same.' }] },
      user,
      { role: 'assistant', content: 'Same.' },
      {
        type: 'message',
        role: 'assistant',
        id: 'msg_b',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'Same.' }],
      },
    ])
    expect(input[0]).toEqual({ role: 'assistant', content: 'Same.' })
  })

  it('rebuilds multipart native messages without duplicating their ID', () => {
    const restored = restoreOpenAIAssistantTextReplay(
      {
        store: false,
        input: [
          { role: 'assistant', content: 'First.', phase: 'commentary' },
          { role: 'assistant', content: 'Second.', phase: 'commentary' },
        ],
      },
      [
        { text: 'First.', itemId: 'msg_multi', phase: 'commentary' },
        { text: 'Second.', itemId: 'msg_multi', phase: 'commentary' },
      ]
    )

    expect(restored.input).toEqual([
      {
        type: 'message',
        role: 'assistant',
        id: 'msg_multi',
        phase: 'commentary',
        content: [
          { type: 'output_text', text: 'First.' },
          { type: 'output_text', text: 'Second.' },
        ],
      },
    ])
  })

  it('returns the body unchanged without native IDs, with storage, or with a server conversation', () => {
    const input = [{ role: 'assistant', content: 'Plain.' }]
    const noIds = { store: false, input }
    expect(restoreOpenAIAssistantTextReplay(noIds, [{ text: 'Plain.' }])).toBe(noIds)
    expect(restoreOpenAIAssistantTextReplay(noIds, undefined)).toBe(noIds)
    const stored = { input: [{ type: 'item_reference', id: 'msg_a' }] }
    expect(restoreOpenAIAssistantTextReplay(stored, [{ text: 'Plain.', itemId: 'msg_a' }])).toBe(stored)
    const conversation = { store: false, conversation: 'conv_1', input: [] }
    expect(restoreOpenAIAssistantTextReplay(conversation, [{ text: 'Plain.', itemId: 'msg_a' }])).toBe(conversation)
  })

  it.each([
    ['different text', [{ role: 'assistant', content: 'Other.' }], [{ text: 'Mine.', itemId: 'msg_a' }]],
    [
      'extra assistant message',
      [
        { role: 'assistant', content: 'Mine.' },
        { role: 'assistant', content: 'Mine.' },
      ],
      [{ text: 'Mine.', itemId: 'msg_a' }],
    ],
    ['missing assistant message', [], [{ text: 'Mine.', itemId: 'msg_a' }]],
    [
      'non-adjacent repeated ID',
      [
        { role: 'assistant', content: 'A.' },
        { role: 'user', content: 'x' },
        { role: 'assistant', content: 'B.' },
      ],
      [
        { text: 'A.', itemId: 'msg_a' },
        { text: 'B.', itemId: 'msg_a' },
      ],
    ],
    [
      'typed item with another ID',
      [{ type: 'message', role: 'assistant', id: 'msg_x', content: [{ type: 'output_text', text: 'Mine.' }] }],
      [{ text: 'Mine.', itemId: 'msg_a' }],
    ],
  ])('fails explicitly on %s', (_case, input, texts) => {
    expect(() => restoreOpenAIAssistantTextReplay({ store: false, input }, texts)).toThrow(OpenAIReplayMetadataError)
  })

  it('fails explicitly when the body has no input array', () => {
    expect(() => restoreOpenAIAssistantTextReplay({ store: false }, [{ text: 'A.', itemId: 'msg_a' }])).toThrow(
      OpenAIReplayMetadataError
    )
  })
})

describe('OpenAI Responses replay middleware', () => {
  const prompt = [
    { role: 'user' as const, content: [{ type: 'text' as const, text: 'Go.' }] },
    { role: 'assistant' as const, content: [nativeText('Done.', 'msg_fake', 'final_answer')] },
  ]
  const sdkBody = JSON.stringify({
    store: false,
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'Go.' }] },
      { role: 'assistant', content: 'Done.', phase: 'final_answer' },
    ],
  })
  const restored = {
    type: 'message',
    role: 'assistant',
    id: 'msg_fake',
    phase: 'final_answer',
    content: [{ type: 'output_text', text: 'Done.' }],
  }

  function fakeResponsesModel(send: () => Promise<unknown>): LanguageModelV4 {
    return {
      specificationVersion: 'v4',
      provider: 'prov_fake.responses',
      modelId: 'gpt-5.4',
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error('unused')
      },
      doStream: async () => {
        await send()
        return {
          stream: new ReadableStream({ start: (controller) => controller.close() }),
        } as LanguageModelV4StreamResult
      },
    }
  }

  it.each([
    ['string', () => openAIResponsesFetch('https://api.openai.com/v1/responses', { method: 'POST', body: sdkBody })],
    [
      'URL',
      () => openAIResponsesFetch(new URL('https://api.openai.com/v1/responses'), { method: 'POST', body: sdkBody }),
    ],
    [
      'Request',
      () => openAIResponsesFetch(new Request('https://api.openai.com/v1/responses', { method: 'POST', body: sdkBody })),
    ],
  ])('restores native items for %s request inputs', async (_case, send) => {
    const bodies = mockNetFetch(() => new Response('{}'))
    await withOpenAIResponsesReplay(fakeResponsesModel(send)).doStream({ prompt })

    expect(bodies).toHaveLength(1)
    expect(assistantItems(bodies[0])).toEqual([restored])
  })

  it('does not apply a capture to later requests on the inherited async chain', async () => {
    const bodies = mockNetFetch(() => new Response('{}'))
    const unrelated = JSON.stringify({ store: false, input: [{ role: 'assistant', content: 'Unrelated.' }] })
    let later: Promise<unknown> | undefined
    const model = fakeResponsesModel(async () => {
      await openAIResponsesFetch('https://api.openai.com/v1/responses', { method: 'POST', body: sdkBody })
      // A second request of the same invocation and work scheduled from it (tools, auxiliary captures).
      await openAIResponsesFetch('https://api.openai.com/v1/responses', { method: 'POST', body: unrelated })
      later = new Promise((resolve, reject) => {
        setTimeout(() => {
          openAIResponsesFetch('https://api.openai.com/v1/responses', { method: 'POST', body: unrelated }).then(
            resolve,
            reject
          )
        }, 0)
      })
    })

    await withOpenAIResponsesReplay(model).doStream({ prompt })
    await later

    expect(bodies).toHaveLength(3)
    expect(assistantItems(bodies[0])).toEqual([restored])
    expect(assistantItems(bodies[1])).toEqual([{ role: 'assistant', content: 'Unrelated.' }])
    expect(assistantItems(bodies[2])).toEqual([{ role: 'assistant', content: 'Unrelated.' }])
  })

  it('fails closed before sending when native IDs cannot be aligned', async () => {
    const bodies = mockNetFetch(() => new Response('{}'))
    const mismatched = JSON.stringify({ store: false, input: [{ role: 'assistant', content: 'Changed.' }] })
    const model = fakeResponsesModel(() =>
      openAIResponsesFetch('https://api.openai.com/v1/responses', { method: 'POST', body: mismatched })
    )

    await expect(withOpenAIResponsesReplay(model).doStream({ prompt })).rejects.toBeInstanceOf(
      OpenAIReplayMetadataError
    )
    expect(bodies).toHaveLength(0)
  })
})

describe('OpenAI Responses replay through the production adapter', () => {
  it('restores text IDs between steps of one tool loop', async () => {
    const responses = [commentaryThenToolResponse(), textResponse('msg_loop_final', 'Found it.')]
    const bodies = mockNetFetch(() => {
      const response = responses.shift()
      if (!response) throw new Error('unexpected OpenAI request')
      return response
    })
    const read = tool({
      description: 'Read one file.',
      inputSchema: jsonSchema<{ path: string }>({
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string' } },
        required: ['path'],
      }),
      execute: async () => 'file contents',
    })

    const result = streamText({
      model: productionModel(),
      messages: [{ role: 'user', content: 'Inspect a.ts.' }],
      tools: { read },
      stopWhen: stepCountIs(2),
      providerOptions: { openai: { store: false } },
    })
    await result.consumeStream()

    expect(bodies).toHaveLength(2)
    expect(bodies[1].input).toEqual(
      expect.arrayContaining([
        {
          type: 'message',
          role: 'assistant',
          id: 'msg_loop',
          phase: 'commentary',
          content: [{ type: 'output_text', text: 'Reading.' }],
        },
        expect.objectContaining({ type: 'function_call', call_id: 'call_loop', name: 'read' }),
        expect.objectContaining({ type: 'function_call_output', call_id: 'call_loop', output: 'file contents' }),
      ])
    )
  })

  it('keeps plain assistant text as easy input when there are no native IDs', async () => {
    const bodies = mockNetFetch(() => textResponse('msg_plain_next', 'Ok.'))
    const result = streamText({
      model: productionModel(),
      messages: [
        { role: 'user', content: 'Hello.' },
        { role: 'assistant', content: 'Plain.' },
        { role: 'user', content: 'Again.' },
      ],
      providerOptions: { openai: { store: false } },
    })
    await result.consumeStream()

    expect(assistantItems(bodies[0])).toEqual([{ role: 'assistant', content: 'Plain.' }])
  })

  it('restores before raw prefix injection and compaction trimming', async () => {
    const rawAssistant = {
      type: 'message',
      role: 'assistant',
      id: 'msg_raw',
      content: [{ type: 'output_text', text: 'Before.' }],
    }
    const bodies = mockNetFetch(() => textResponse('msg_after_next', 'Ok.'))
    const model = productionModel()
    const replayed: ModelMessage[] = [
      { role: 'user', content: 'Start.' },
      { role: 'assistant', content: [nativeText('Before.', 'msg_before', 'commentary')] },
      {
        role: 'assistant',
        content: [
          {
            type: 'custom',
            kind: 'openai.compaction',
            providerOptions: { openai: { itemId: 'cmp_1', encryptedContent: 'encrypted-window' } },
          },
        ],
      },
      { role: 'assistant', content: [nativeText('After.', 'msg_after', 'final_answer')] },
      { role: 'user', content: 'Continue.' },
    ]

    await withOpenAIRawResponsesPrefix([rawAssistant], async () => {
      await streamText({
        model,
        system: 'You are a coding agent.',
        messages: [
          { role: 'user', content: 'Prefixed.' },
          { role: 'assistant', content: [nativeText('Before.', 'msg_prefixed', 'commentary')] },
        ],
        providerOptions: { openai: { store: false } },
      }).consumeStream()
    })
    await streamText({
      model,
      system: 'You are a coding agent.',
      messages: replayed,
      providerOptions: { openai: { store: false } },
    }).consumeStream()

    expect(bodies[0].input).toEqual([
      expect.objectContaining({ role: 'developer' }),
      rawAssistant,
      expect.objectContaining({ role: 'user' }),
      {
        type: 'message',
        role: 'assistant',
        id: 'msg_prefixed',
        phase: 'commentary',
        content: [{ type: 'output_text', text: 'Before.' }],
      },
    ])
    expect(bodies[1].input).toEqual([
      expect.objectContaining({ role: 'developer' }),
      { type: 'compaction', id: 'cmp_1', encrypted_content: 'encrypted-window' },
      {
        type: 'message',
        role: 'assistant',
        id: 'msg_after',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'After.' }],
      },
      expect.objectContaining({ role: 'user' }),
    ])
    expect(JSON.stringify(bodies[1])).not.toContain('msg_before')
  })

  it('isolates concurrent invocations that replay equal text', async () => {
    let arrivals = 0
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const bodies = mockNetFetch(async (body) => {
      if (++arrivals === 2) release()
      await barrier
      return textResponse(`msg_next_${String(body.prompt_cache_key)}`, 'Ok.')
    })
    const model = productionModel()
    const run = (chat: string) =>
      streamText({
        model,
        messages: [
          { role: 'user', content: 'Hi.' },
          { role: 'assistant', content: [nativeText('Same.', `msg_${chat}`, 'final_answer')] },
          { role: 'user', content: 'Again.' },
        ],
        providerOptions: { openai: { store: false, promptCacheKey: chat } },
      }).consumeStream()

    await Promise.all([run('chat_a'), run('chat_b')])

    expect(bodies).toHaveLength(2)
    for (const body of bodies) {
      expect(assistantItems(body)).toEqual([
        {
          type: 'message',
          role: 'assistant',
          id: `msg_${String(body.prompt_cache_key)}`,
          phase: 'final_answer',
          content: [{ type: 'output_text', text: 'Same.' }],
        },
      ])
    }
  })

  it('does not leak an aborted invocation into the next one', async () => {
    let started!: () => void
    const inFlight = new Promise<void>((resolve) => {
      started = resolve
    })
    const bodies = mockNetFetch((body, init) => {
      if (body.prompt_cache_key !== 'aborted') return textResponse('msg_after_abort', 'Ok.')
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        })
        started()
      })
    })
    const model = productionModel()
    const controller = new AbortController()
    const aborted = streamText({
      model,
      messages: [
        { role: 'user', content: 'Hi.' },
        { role: 'assistant', content: [nativeText('Old.', 'msg_old')] },
        { role: 'user', content: 'Again.' },
      ],
      abortSignal: controller.signal,
      providerOptions: { openai: { store: false, promptCacheKey: 'aborted' } },
      onError: () => undefined,
    }).consumeStream({ onError: () => undefined })
    await inFlight
    controller.abort()
    await aborted

    await streamText({
      model,
      messages: [
        { role: 'user', content: 'Hi.' },
        { role: 'assistant', content: [nativeText('New.', 'msg_new')] },
        { role: 'user', content: 'Again.' },
      ],
      providerOptions: { openai: { store: false, promptCacheKey: 'next' } },
    }).consumeStream()

    expect(bodies).toHaveLength(2)
    expect(assistantItems(bodies[0])).toEqual([
      { type: 'message', role: 'assistant', id: 'msg_old', content: [{ type: 'output_text', text: 'Old.' }] },
    ])
    expect(assistantItems(bodies[1])).toEqual([
      { type: 'message', role: 'assistant', id: 'msg_new', content: [{ type: 'output_text', text: 'New.' }] },
    ])
  })
})
