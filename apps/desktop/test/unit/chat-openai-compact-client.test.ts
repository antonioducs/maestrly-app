import { createOpenAI } from '@ai-sdk/openai'
import { net } from 'electron'
import { jsonSchema, stepCountIs, streamText, tool } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addProvider } from '../../src/main/chat/catalog'
import {
  canFallbackFromOpenAICompact,
  compactOpenAIResponses,
  materializeOpenAIResponsesInput,
  OpenAICompactError,
  parseOpenAICompactResponse,
  resolveOpenAICompactTransport,
} from '../../src/main/chat/openai/compact-client'
import {
  OpenAIRawInputError,
  openAIResponsesFetch,
  prepareOpenAIResponsesBody,
  prependOpenAIRawResponseItems,
  withOpenAIRawResponsesPrefix,
  withoutOpenAIRawResponsesPrefix,
} from '../../src/main/chat/openai/raw-input'
import { setApiKey } from '../../src/main/chat/credentials'
import { closeDb, freshDb } from '../helpers/db'

beforeEach(freshDb)
afterEach(() => {
  vi.restoreAllMocks()
  closeDb()
})

const retained = {
  type: 'message',
  id: 'retained-user',
  role: 'user',
  status: 'completed',
  content: [{ type: 'input_text', text: 'do not change the public API' }],
}
const checkpoint = { type: 'compaction', encrypted_content: 'encrypted-window' }

function sse(events: readonly Record<string, unknown>[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const responseUsage = {
  input_tokens: 20,
  input_tokens_details: { cached_tokens: 0, cache_write_tokens: null },
  output_tokens: 5,
  output_tokens_details: { reasoning_tokens: 0 },
}

function compactionToolResponse(): Response {
  return sse([
    {
      type: 'response.created',
      response: { id: 'resp_compact_step', created_at: 1, model: 'gpt-5.6-sol', service_tier: null },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'compaction', id: 'cmp_new', encrypted_content: 'new-window' },
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'compaction', id: 'cmp_new', encrypted_content: 'new-window' },
    },
    {
      type: 'response.output_item.added',
      output_index: 1,
      item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '' },
    },
    {
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_1',
      output_index: 1,
      delta: '{"path":"src/main.ts"}',
    },
    {
      type: 'response.output_item.done',
      output_index: 1,
      item: {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'read',
        arguments: '{"path":"src/main.ts"}',
        status: 'completed',
      },
    },
    {
      type: 'response.completed',
      response: { incomplete_details: null, usage: responseUsage, reasoning: null, service_tier: 'default' },
    },
  ])
}

function finalTextResponse(): Response {
  return sse([
    {
      type: 'response.created',
      response: { id: 'resp_after_compact', created_at: 2, model: 'gpt-5.6-sol', service_tier: null },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_final', phase: 'final_answer' },
    },
    { type: 'response.output_text.delta', item_id: 'msg_final', delta: 'Done.', logprobs: null },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'message', id: 'msg_final', phase: 'final_answer' },
    },
    {
      type: 'response.completed',
      response: { incomplete_details: null, usage: responseUsage, reasoning: null, service_tier: 'default' },
    },
  ])
}

describe('OpenAI standalone compaction', () => {
  it('preserves complete output and opaque checkpoints', () => {
    const response = {
      id: 'cmp_response_1',
      object: 'response.compaction',
      created_at: 1,
      output: [retained, checkpoint],
      usage: {
        input_tokens: 120,
        input_tokens_details: { cached_tokens: 20 },
        output_tokens: 30,
      },
    }

    const parsed = parseOpenAICompactResponse(response)

    expect(parsed.canonicalWindow.response).toEqual(response)
    expect(parsed.canonicalWindow.response.output).toEqual([retained, checkpoint])
    expect(parsed.usage).toEqual({ inputTokens: 120, outputTokens: 30, cachedInputTokens: 20 })
  })

  it('uses SDK input codecs without reconverting previous windows', async () => {
    const rawPrefix = [retained, checkpoint]
    const input = await materializeOpenAIResponsesInput({
      modelId: 'gpt-5.6-sol',
      rawPrefix,
      messages: [{ role: 'user', content: 'continue daqui' }],
    })

    expect(input.slice(0, rawPrefix.length)).toEqual(rawPrefix)
    expect(input.at(-1)).toEqual({ role: 'user', content: [{ type: 'input_text', text: 'continue daqui' }] })
  })

  it('materializes function_call/function_call_output pairs without redeclaring the tool', async () => {
    const input = await materializeOpenAIResponsesInput({
      modelId: 'gpt-5.6-sol',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'read', input: { path: 'a.ts' } }],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call_1',
              toolName: 'read',
              output: { type: 'text', value: 'file contents' },
            },
          ],
        },
      ],
    })

    expect(input).toEqual([
      { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"a.ts"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'file contents' },
    ])
  })

  it('posts authenticated provider requests and validates returned windows', async () => {
    const provider = addProvider({
      name: 'Codex proxy',
      baseURL: 'http://127.0.0.1:4144/v1/',
      kind: 'openai-responses',
    })
    setApiKey(provider.id, 'subscription-token')
    const transport = resolveOpenAICompactTransport(provider.id)
    // Credentials may change during input materialization; requests must
    // remain bound to the snapshot labeling their sidecars.
    setApiKey(provider.id, 'new-token-after-snapshot')
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    vi.spyOn(net, 'fetch').mockImplementation(async (input, init) => {
      capturedUrl = String(input)
      capturedInit = init
      return new Response(JSON.stringify({ object: 'response.compaction', output: [retained, checkpoint] }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-request-id': 'req_123' },
      }) as never
    })

    const result = await compactOpenAIResponses({
      transport,
      modelId: 'gpt-5.6-sol',
      input: [{ role: 'user', content: 'compacte' }],
      promptCacheKey: 'maestrly:conv-1',
    })

    expect(capturedUrl).toBe('http://127.0.0.1:4144/v1/responses/compact')
    expect(capturedInit?.headers).toMatchObject({
      authorization: 'Bearer subscription-token',
      'content-type': 'application/json',
    })
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      model: 'gpt-5.6-sol',
      input: [{ role: 'user', content: 'compacte' }],
      prompt_cache_key: 'maestrly:conv-1',
    })
    expect(result.requestId).toBe('req_123')
    expect(result.canonicalWindow.response.output).toEqual([retained, checkpoint])
    expect(transport.providerFingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it('allows endpoint and network fallbacks without masking authentication or rate limits', () => {
    expect(canFallbackFromOpenAICompact(new OpenAICompactError('missing', 404))).toBe(true)
    expect(canFallbackFromOpenAICompact(new OpenAICompactError('payload too large', 413))).toBe(true)
    expect(canFallbackFromOpenAICompact(new OpenAICompactError('gateway schema', 422))).toBe(true)
    expect(canFallbackFromOpenAICompact(new OpenAICompactError('upstream', 502))).toBe(true)
    expect(canFallbackFromOpenAICompact(new OpenAICompactError('network'))).toBe(true)
    expect(canFallbackFromOpenAICompact(new OpenAICompactError('auth', 401))).toBe(false)
    expect(canFallbackFromOpenAICompact(new OpenAICompactError('rate limit', 429))).toBe(false)
  })

  it('normalizes transport failures while propagating abort', async () => {
    vi.spyOn(net, 'fetch').mockRejectedValueOnce(new TypeError('connection refused'))

    await expect(
      compactOpenAIResponses({
        transport: {
          providerId: 'proxy',
          baseURL: 'http://127.0.0.1:4144/v1',
          apiKey: 'subscription-token',
          providerFingerprint: 'a'.repeat(64),
        },
        modelId: 'gpt-5.6-sol',
        input: [{ role: 'user', content: 'compacte' }],
      })
    ).rejects.toMatchObject({ name: 'OpenAICompactError', status: undefined })
  })

  it('normalizes body-read resets while preserving HTTP status', async () => {
    const response = new Response('ignored', { status: 502, headers: { 'x-request-id': 'req_reset' } })
    vi.spyOn(response, 'text').mockRejectedValueOnce(new TypeError('socket reset'))
    vi.spyOn(net, 'fetch').mockResolvedValueOnce(response as never)

    await expect(
      compactOpenAIResponses({
        transport: {
          providerId: 'proxy',
          baseURL: 'http://127.0.0.1:4144/v1',
          apiKey: 'subscription-token',
          providerFingerprint: 'a'.repeat(64),
        },
        modelId: 'gpt-5.6-sol',
        input: [{ role: 'user', content: 'compacte' }],
      })
    ).rejects.toMatchObject({ name: 'OpenAICompactError', status: 502, requestId: 'req_reset' })
  })

  it('treats non-JSON success responses as unsupported endpoints', async () => {
    vi.spyOn(net, 'fetch').mockResolvedValueOnce(
      new Response('<html>not compact json</html>', { status: 200, headers: { 'x-request-id': 'req_html' } }) as never
    )

    const error = await compactOpenAIResponses({
      transport: {
        providerId: 'proxy',
        baseURL: 'http://127.0.0.1:4144/v1',
        apiKey: 'subscription-token',
        providerFingerprint: 'a'.repeat(64),
      },
      modelId: 'gpt-5.6-sol',
      input: [{ role: 'user', content: 'compacte' }],
    }).catch((caught: unknown) => caught)

    expect(error).toMatchObject({ name: 'OpenAICompactError', status: undefined, requestId: 'req_html' })
    expect(canFallbackFromOpenAICompact(error)).toBe(true)
  })
})

describe('raw Responses prefix seam', () => {
  it('injects after system/developer and before the SDK suffix', () => {
    const body = {
      model: 'gpt-5.6-sol',
      input: [
        { role: 'developer', content: 'current instructions' },
        { role: 'user', content: 'new message' },
      ],
    }
    expect(prependOpenAIRawResponseItems(body, [retained, checkpoint]).input).toEqual([
      { role: 'developer', content: 'current instructions' },
      retained,
      checkpoint,
      { role: 'user', content: 'new message' },
    ])
  })

  it('preserves standalone retained items until the next automatic checkpoint', () => {
    const oldWindow = [retained, checkpoint]
    const first = prepareOpenAIResponsesBody(
      {
        input: [
          { role: 'developer', content: 'current instructions' },
          { role: 'user', content: 'visual suffix' },
        ],
      },
      oldWindow
    )
    expect(first.input).toEqual([
      { role: 'developer', content: 'current instructions' },
      retained,
      checkpoint,
      { role: 'user', content: 'visual suffix' },
    ])

    const newer = { type: 'compaction', id: 'cmp_new', encrypted_content: 'new-window' }
    const next = prepareOpenAIResponsesBody(
      {
        input: [
          { role: 'developer', content: 'current instructions' },
          { role: 'user', content: 'visual suffix' },
          newer,
          { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{}' },
          { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
        ],
      },
      oldWindow
    )
    expect(next.input).toEqual([
      { role: 'developer', content: 'current instructions' },
      newer,
      { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
    ])
    expect(JSON.stringify(next)).not.toContain('retained-user')
    expect(JSON.stringify(next)).not.toContain('visual suffix')
  })

  it('reduces second-step wire input without reinjecting old windows', async () => {
    const requests: Array<Record<string, unknown>> = []
    const responses = [compactionToolResponse(), finalTextResponse()]
    vi.spyOn(net, 'fetch').mockImplementation(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      const response = responses.shift()
      if (!response) throw new Error('unexpected OpenAI request')
      return response as never
    })
    const provider = createOpenAI({
      apiKey: 'test-key',
      baseURL: 'https://openai.invalid/v1',
      fetch: openAIResponsesFetch,
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

    await withOpenAIRawResponsesPrefix([retained, checkpoint], async () => {
      const result = streamText({
        model: provider.responses('gpt-5.6-sol'),
        system: 'You are a coding agent.',
        messages: [{ role: 'user', content: 'inspect the old visual suffix' }],
        tools: { read },
        stopWhen: stepCountIs(2),
        providerOptions: { openai: { store: false } },
      })
      await result.consumeStream()
    })

    expect(requests).toHaveLength(2)
    expect(requests[0].input).toEqual(
      expect.arrayContaining([retained, checkpoint, expect.objectContaining({ role: 'user' })])
    )
    const secondInput = requests[1].input as Array<Record<string, unknown>>
    expect(secondInput[0]).toMatchObject({ role: 'developer' })
    expect(secondInput[1]).toEqual({ type: 'compaction', id: 'cmp_new', encrypted_content: 'new-window' })
    expect(secondInput).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'function_call', call_id: 'call_1' }),
        expect.objectContaining({ type: 'function_call_output', call_id: 'call_1', output: 'file contents' }),
      ])
    )
    expect(JSON.stringify(secondInput)).not.toContain('retained-user')
    expect(JSON.stringify(secondInput)).not.toContain('encrypted-window')
    expect(JSON.stringify(secondInput)).not.toContain('old visual suffix')
  })

  it('isolates prefixes by async chain without changing compact endpoints', async () => {
    const bodies: Array<{ url: string; body: unknown }> = []
    vi.spyOn(net, 'fetch').mockImplementation(async (input, init) => {
      bodies.push({ url: String(input), body: JSON.parse(String(init?.body)) })
      return new Response('{}', { status: 200 }) as never
    })

    await Promise.all([
      withOpenAIRawResponsesPrefix([checkpoint], () =>
        openAIResponsesFetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          body: JSON.stringify({ input: [{ role: 'user', content: 'A' }] }),
        })
      ),
      withOpenAIRawResponsesPrefix([retained], () =>
        openAIResponsesFetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          body: JSON.stringify({ input: [{ role: 'user', content: 'B' }] }),
        })
      ),
      withOpenAIRawResponsesPrefix([checkpoint], () =>
        openAIResponsesFetch('https://api.openai.com/v1/responses/compact', {
          method: 'POST',
          body: JSON.stringify({ input: [{ role: 'user', content: 'C' }] }),
        })
      ),
    ])

    expect((bodies[0].body as { input: unknown[] }).input).toEqual([checkpoint, { role: 'user', content: 'A' }])
    expect((bodies[1].body as { input: unknown[] }).input).toEqual([retained, { role: 'user', content: 'B' }])
    expect((bodies[2].body as { input: unknown[] }).input).toEqual([{ role: 'user', content: 'C' }])
  })

  it('masks parent prefixes in nested inference', async () => {
    const bodies: unknown[] = []
    vi.spyOn(net, 'fetch').mockImplementation(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response('{}', { status: 200 }) as never
    })

    await withOpenAIRawResponsesPrefix([checkpoint], async () => {
      await openAIResponsesFetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        body: JSON.stringify({ input: [{ role: 'user', content: 'parent' }] }),
      })
      await withoutOpenAIRawResponsesPrefix(() =>
        openAIResponsesFetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          body: JSON.stringify({ input: [{ role: 'user', content: 'nested' }] }),
        })
      )
    })

    expect(bodies).toEqual([
      { input: [checkpoint, { role: 'user', content: 'parent' }] },
      { input: [{ role: 'user', content: 'nested' }] },
    ])
  })

  it.each([
    ['Invalid JSON', '{'],
    ['input ausente', JSON.stringify({ model: 'gpt-5.6-sol' })],
  ])('fails closed when the window cannot be injected: %s', async (_case, body) => {
    const fetchSpy = vi.spyOn(net, 'fetch')

    await expect(
      withOpenAIRawResponsesPrefix([checkpoint], () =>
        openAIResponsesFetch('https://api.openai.com/v1/responses', { method: 'POST', body })
      )
    ).rejects.toBeInstanceOf(OpenAIRawInputError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
