import { createOpenAI } from '@ai-sdk/openai'
import { jsonSchema, Output, stepCountIs, streamText, tool } from 'ai'
import { describe, expect, it } from 'vitest'
import { openAIHarnessProviderOptions, resolveChatHarness } from '../../src/main/chat/harness'
import {
  createOpenAIResponsesLedger,
  reduceOpenAIResponsesStreamEvent,
  replayOpenAIResponsesLedger,
} from '../../src/main/chat/openai/ledger'
import type { OpenAIResponsesLedger, OpenAIStreamEventLike } from '../../src/main/chat/openai/types'
import { buildOpenAINativeTools, OPENAI_NATIVE_PERMISSION_DENIED_PREFIX } from '../../src/main/chat/openai/native-tools'
import { optimizeOpenAITools } from '../../src/main/chat/openai/tools'

const reasoningItemId = 'rs_wire_1'
const messageItemId = 'msg_wire_1'
const functionItemId = 'fc_wire_1'
const functionCallId = 'call_wire_1'
const encryptedReasoning = 'encrypted-wire-reasoning'

function sse(events: readonly Record<string, unknown>[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

const terminalUsage = {
  input_tokens: 8,
  input_tokens_details: { cached_tokens: 0, cache_write_tokens: null },
  output_tokens: 2,
  output_tokens_details: { reasoning_tokens: 0 },
}

function partialTextThen(terminal: Record<string, unknown>): Response {
  return sse([
    {
      type: 'response.created',
      response: { id: 'resp_terminal', created_at: 1, model: 'gpt-5.4', service_tier: null },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_terminal', phase: 'final_answer' },
    },
    {
      type: 'response.output_text.delta',
      item_id: 'msg_terminal',
      delta: 'partial',
      logprobs: null,
    },
    terminal,
  ])
}

async function collectTerminalParts(response: Response): Promise<Array<Record<string, unknown>>> {
  const provider = createOpenAI({
    apiKey: 'test-key',
    baseURL: 'https://openai.invalid/v1',
    fetch: async () => response,
  })
  const result = streamText({
    model: provider.responses('gpt-5.4'),
    messages: [{ role: 'user', content: 'Continue.' }],
    onError: () => undefined,
  })
  const parts: Array<Record<string, unknown>> = []
  for await (const part of result.fullStream) parts.push(part as unknown as Record<string, unknown>)
  return parts
}

function firstResponse(): Response {
  return sse([
    {
      type: 'response.created',
      response: { id: 'resp_wire_1', created_at: 1, model: 'gpt-5.4', service_tier: null },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'reasoning', id: reasoningItemId, encrypted_content: null },
    },
    {
      type: 'response.reasoning_summary_part.added',
      item_id: reasoningItemId,
      summary_index: 0,
    },
    {
      type: 'response.reasoning_summary_text.delta',
      item_id: reasoningItemId,
      summary_index: 0,
      delta: 'I should inspect the requested file.',
    },
    {
      type: 'response.reasoning_summary_part.done',
      item_id: reasoningItemId,
      summary_index: 0,
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'reasoning', id: reasoningItemId, encrypted_content: encryptedReasoning },
    },
    {
      type: 'response.output_item.added',
      output_index: 1,
      item: { type: 'message', id: messageItemId, phase: 'commentary' },
    },
    {
      type: 'response.output_text.delta',
      item_id: messageItemId,
      delta: 'I will inspect the file.',
      logprobs: null,
    },
    {
      type: 'response.output_item.done',
      output_index: 1,
      item: { type: 'message', id: messageItemId, phase: 'commentary' },
    },
    {
      type: 'response.output_item.added',
      output_index: 2,
      item: {
        type: 'function_call',
        id: functionItemId,
        call_id: functionCallId,
        name: 'read',
        arguments: '',
        namespace: 'workspace',
      },
    },
    {
      type: 'response.function_call_arguments.delta',
      item_id: functionItemId,
      output_index: 2,
      delta: '{"path":"src/main.ts"}',
    },
    {
      type: 'response.output_item.done',
      output_index: 2,
      item: {
        type: 'function_call',
        id: functionItemId,
        call_id: functionCallId,
        name: 'read',
        arguments: '{"path":"src/main.ts"}',
        status: 'completed',
        namespace: 'workspace',
      },
    },
    {
      type: 'response.completed',
      response: {
        incomplete_details: null,
        usage: {
          input_tokens: 20,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: null },
          output_tokens: 10,
          output_tokens_details: { reasoning_tokens: 4 },
        },
        reasoning: null,
        service_tier: 'default',
      },
    },
  ])
}

function secondResponse(): Response {
  return sse([
    {
      type: 'response.created',
      response: { id: 'resp_wire_2', created_at: 2, model: 'gpt-5.4', service_tier: null },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_wire_2', phase: 'final_answer' },
    },
    {
      type: 'response.output_text.delta',
      item_id: 'msg_wire_2',
      delta: 'Done.',
      logprobs: null,
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'message', id: 'msg_wire_2', phase: 'final_answer' },
    },
    {
      type: 'response.completed',
      response: {
        incomplete_details: null,
        usage: {
          input_tokens: 35,
          input_tokens_details: { cached_tokens: 20, cache_write_tokens: null },
          output_tokens: 3,
          output_tokens_details: { reasoning_tokens: 0 },
        },
        reasoning: null,
        service_tier: 'default',
      },
    },
  ])
}

function structuredResponse(): Response {
  return sse([
    {
      type: 'response.created',
      response: { id: 'resp_structured', created_at: 3, model: 'gpt-5.4', service_tier: null },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_structured', phase: 'final_answer' },
    },
    {
      type: 'response.output_text.delta',
      item_id: 'msg_structured',
      delta: '{"answer":"ok"}',
      logprobs: null,
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'message', id: 'msg_structured', phase: 'final_answer' },
    },
    {
      type: 'response.completed',
      response: {
        incomplete_details: null,
        usage: terminalUsage,
        reasoning: null,
        service_tier: 'default',
      },
    },
  ])
}

function applyPatchResponse(): Response {
  return sse([
    {
      type: 'response.created',
      response: { id: 'resp_patch_1', created_at: 1, model: 'gpt-5.1', service_tier: null },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        type: 'apply_patch_call',
        id: 'ap_wire_1',
        call_id: 'call_patch_1',
        status: 'in_progress',
        operation: { type: 'create_file', path: 'denied.txt', diff: '+denied' },
      },
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'apply_patch_call',
        id: 'ap_wire_1',
        call_id: 'call_patch_1',
        status: 'completed',
        operation: { type: 'create_file', path: 'denied.txt', diff: '+denied' },
      },
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_patch_1',
        incomplete_details: null,
        usage: {
          input_tokens: 5,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: null },
          output_tokens: 2,
          output_tokens_details: { reasoning_tokens: 0 },
        },
        reasoning: null,
        service_tier: 'default',
      },
    },
  ])
}

describe('OpenAI Responses harness wire contract', () => {
  it('preserves native IDs across stateless turns', async () => {
    const requests: Array<Record<string, unknown>> = []
    const responses = [firstResponse(), secondResponse()]
    type OpenAISettings = NonNullable<Parameters<typeof createOpenAI>[0]>
    const fakeFetch: NonNullable<OpenAISettings['fetch']> = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      const response = responses.shift()
      if (!response) throw new Error('unexpected OpenAI request')
      return response
    }
    const openai = createOpenAI({
      // The app uses the BYOK id as provider name; options deliberately remain under the openai key.
      name: 'prov_custom_openai',
      apiKey: 'test-key',
      baseURL: 'https://openai.invalid/v1',
      fetch: fakeFetch,
    })
    const read = tool({
      description: 'Read a workspace file.',
      inputSchema: jsonSchema<{ path: string }>({
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string' } },
        required: ['path'],
      }),
    })
    const resolution = resolveChatHarness('openai-responses', 'gpt-5.4')
    const providerOptions = {
      openai: openAIHarnessProviderOptions(resolution, {
        promptCacheKey: 'maestrly:test-wire-contract',
        reasoningEnabled: true,
        compactionThreshold: 180_000,
      }),
    }

    const optimized = await optimizeOpenAITools({ read }, { conversationId: 'wire-strict-tools' })
    expect(optimized.strictToolNames).toEqual(['read'])
    const first = streamText({
      model: openai.responses('gpt-5.4'),
      system: 'You are a coding agent.',
      messages: [{ role: 'user', content: 'Inspect src/main.ts.' }],
      tools: optimized.tools,
      providerOptions,
    })

    let ledger: OpenAIResponsesLedger = createOpenAIResponsesLedger()
    for await (const event of first.fullStream) {
      ledger = reduceOpenAIResponsesStreamEvent(ledger, event as OpenAIStreamEventLike)
    }
    ledger = reduceOpenAIResponsesStreamEvent(ledger, {
      type: 'tool-result',
      toolCallId: functionCallId,
      toolName: 'read',
      output: 'export const answer = 42',
    })

    expect(requests[0]).toMatchObject({
      model: 'gpt-5.4',
      store: false,
      include: ['reasoning.encrypted_content'],
      parallel_tool_calls: true,
      prompt_cache_key: 'maestrly:test-wire-contract',
      context_management: [{ type: 'compaction', compact_threshold: 180_000 }],
      truncation: 'disabled',
      stream: true,
      tools: [
        {
          type: 'function',
          name: 'read',
          strict: true,
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ],
    })
    expect(ledger.entries).toMatchObject([
      {
        type: 'assistant-reasoning',
        text: 'I should inspect the requested file.',
        status: 'complete',
        providerMetadata: {
          openai: { itemId: reasoningItemId, reasoningEncryptedContent: encryptedReasoning },
        },
      },
      {
        type: 'assistant-text',
        text: 'I will inspect the file.',
        providerMetadata: { openai: { itemId: messageItemId, phase: 'commentary' } },
      },
      {
        type: 'tool-call',
        toolCallId: functionCallId,
        providerMetadata: { openai: { itemId: functionItemId, namespace: 'workspace' } },
      },
      { type: 'step-boundary', responseId: 'resp_wire_1' },
      { type: 'tool-result', toolCallId: functionCallId },
    ])

    const replay = replayOpenAIResponsesLedger(ledger)
    expect(replay).toMatchObject({ lossless: true, requiresRawResponsesInput: false, issues: [] })

    const second = streamText({
      model: openai.responses('gpt-5.4'),
      system: 'You are a coding agent.',
      messages: [
        { role: 'user', content: 'Inspect src/main.ts.' },
        ...replay.messages,
        { role: 'user', content: 'What did you find?' },
      ],
      tools: optimized.tools,
      providerOptions,
    })
    await second.consumeStream()

    expect(requests).toHaveLength(2)
    expect(requests[1]).toMatchObject({
      store: false,
      include: ['reasoning.encrypted_content'],
      input: [
        { role: 'developer' },
        { role: 'user' },
        {
          type: 'reasoning',
          id: reasoningItemId,
          encrypted_content: encryptedReasoning,
          summary: [{ type: 'summary_text', text: 'I should inspect the requested file.' }],
        },
        {
          role: 'assistant',
          id: messageItemId,
          phase: 'commentary',
          content: [{ type: 'output_text', text: 'I will inspect the file.' }],
        },
        {
          type: 'function_call',
          call_id: functionCallId,
          name: 'read',
          namespace: 'workspace',
          arguments: '{"path":"src/main.ts"}',
        },
        {
          type: 'function_call_output',
          call_id: functionCallId,
          output: 'export const answer = 42',
        },
        { role: 'user' },
      ],
    })
  })

  it('uses edit/write functions in the Codex gateway without advertising provider-native apply_patch', async () => {
    const requests: Array<Record<string, unknown>> = []
    type OpenAISettings = NonNullable<Parameters<typeof createOpenAI>[0]>
    const fakeFetch: NonNullable<OpenAISettings['fetch']> = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return secondResponse()
    }
    const provider = createOpenAI({
      apiKey: 'test-key',
      baseURL: 'http://localhost:4144/v1',
      fetch: fakeFetch,
    })
    const fileMutation = tool({
      description: 'Mutate a workspace file.',
      inputSchema: jsonSchema<{ path: string; content: string }>({
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      }),
    })
    const resolution = resolveChatHarness('openai-responses', 'gpt-5.6-sol', 'http://localhost:4144/v1')
    const nativeTools = buildOpenAINativeTools({
      cwd: process.cwd(),
      capabilities: resolution.capabilities,
      makeCtx: (toolCallId, signal) => ({
        conversationId: 'wire-conversation',
        projectId: 'wire-project',
        messageId: 'wire-message',
        toolCallId,
        cwd: process.cwd(),
        signal,
        ask: async () => undefined,
        askQuestion: async () => [],
      }),
    })

    const result = streamText({
      model: provider.responses('gpt-5.6-sol'),
      messages: [{ role: 'user', content: 'Inspect the workspace.' }],
      tools: { edit: fileMutation, write: fileMutation, ...nativeTools },
      providerOptions: { openai: { store: false } },
    })
    await result.consumeStream()

    const sentTools = requests[0].tools as Array<Record<string, unknown>>
    expect(sentTools.some((entry) => entry.type === 'apply_patch')).toBe(false)
    expect(sentTools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'function', name: 'edit' }),
        expect.objectContaining({ type: 'function', name: 'write' }),
      ])
    )
  })

  it('materializes strict JSON schemas without automatic truncation', async () => {
    let request: Record<string, unknown> | undefined
    const provider = createOpenAI({
      apiKey: 'test-key',
      baseURL: 'https://openai.invalid/v1',
      fetch: async (_input, init) => {
        request = JSON.parse(String(init?.body)) as Record<string, unknown>
        return structuredResponse()
      },
    })
    const resolution = resolveChatHarness('openai-responses', 'gpt-5.4')
    const result = streamText({
      model: provider.responses('gpt-5.4'),
      messages: [{ role: 'user', content: 'Return the answer.' }],
      output: Output.object({
        name: 'answer',
        schema: jsonSchema<{ answer: string }>({
          type: 'object',
          additionalProperties: false,
          properties: { answer: { type: 'string' } },
          required: ['answer'],
        }),
      }),
      providerOptions: {
        openai: openAIHarnessProviderOptions(resolution, {
          promptCacheKey: 'maestrly:structured-wire',
          reasoningEnabled: true,
        }),
      },
    })

    await result.consumeStream()
    expect(request).toMatchObject({
      truncation: 'disabled',
      text: {
        format: {
          type: 'json_schema',
          name: 'answer',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { answer: { type: 'string' } },
            required: ['answer'],
          },
        },
      },
    })
  })

  it('serializes patch denial in native schemas', async () => {
    const requests: Array<Record<string, unknown>> = []
    const responses = [applyPatchResponse(), secondResponse()]
    type OpenAISettings = NonNullable<Parameters<typeof createOpenAI>[0]>
    const fakeFetch: NonNullable<OpenAISettings['fetch']> = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      const response = responses.shift()
      if (!response) throw new Error('unexpected OpenAI request')
      return response
    }
    const provider = createOpenAI({
      apiKey: 'test-key',
      baseURL: 'https://openai.invalid/v1',
      fetch: fakeFetch,
    })
    const denial = Object.assign(new Error('user rejected edit'), { name: 'PermissionRejectedError' })
    const tools = buildOpenAINativeTools({
      cwd: process.cwd(),
      capabilities: resolveChatHarness('openai-responses', 'gpt-5.1', 'https://api.openai.com/v1').capabilities,
      makeCtx: (toolCallId, signal) => ({
        conversationId: 'wire-conversation',
        projectId: 'wire-project',
        messageId: 'wire-message',
        toolCallId,
        cwd: process.cwd(),
        signal,
        ask: async () => {
          throw denial
        },
        askQuestion: async () => [],
      }),
    })
    const result = streamText({
      model: provider.responses('gpt-5.1'),
      messages: [{ role: 'user', content: 'Create denied.txt.' }],
      tools,
      stopWhen: stepCountIs(2),
      providerOptions: { openai: { store: false } },
    })

    await result.consumeStream()

    expect(requests).toHaveLength(2)
    const secondInput = requests[1].input as Array<Record<string, unknown>>
    expect(secondInput).toContainEqual({
      type: 'apply_patch_call_output',
      call_id: 'call_patch_1',
      status: 'failed',
      output: `${OPENAI_NATIVE_PERMISSION_DENIED_PREFIX}user rejected edit`,
    })
    expect(secondInput.some((item) => item.type === 'function_call_output')).toBe(false)
  })

  it('preserves incomplete response reasons as length finishes', async () => {
    const parts = await collectTerminalParts(
      partialTextThen({
        type: 'response.incomplete',
        response: {
          incomplete_details: { reason: 'max_output_tokens' },
          usage: terminalUsage,
          reasoning: null,
          service_tier: 'default',
        },
      })
    )

    expect(parts).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'partial' }))
    expect(parts).toContainEqual(
      expect.objectContaining({ type: 'finish-step', finishReason: 'length', rawFinishReason: 'max_output_tokens' })
    )
    expect(parts).toContainEqual(
      expect.objectContaining({ type: 'finish', finishReason: 'length', rawFinishReason: 'max_output_tokens' })
    )
  })

  it('surfaces midstream response.failed as terminal errors', async () => {
    const parts = await collectTerminalParts(
      partialTextThen({
        type: 'response.failed',
        sequence_number: 4,
        response: {
          error: { code: 'server_error', message: 'temporarily unavailable' },
          incomplete_details: null,
          usage: terminalUsage,
          reasoning: null,
          service_tier: 'default',
        },
      })
    )

    expect(parts).toContainEqual(
      expect.objectContaining({
        type: 'error',
        error: expect.objectContaining({
          type: 'response.failed',
          code: 'server_error',
          message: 'temporarily unavailable',
          statusCode: 500,
          isRetryable: true,
          data: expect.objectContaining({
            response: expect.objectContaining({
              error: { code: 'server_error', message: 'temporarily unavailable' },
            }),
          }),
        }),
      })
    )
    expect(parts).toContainEqual(expect.objectContaining({ type: 'finish-step', finishReason: 'error' }))
    expect(parts).toContainEqual(expect.objectContaining({ type: 'finish', finishReason: 'error' }))
  })

  it('does not turn SSE error frames into success', async () => {
    const parts = await collectTerminalParts(
      partialTextThen({
        type: 'error',
        sequence_number: 5,
        code: 'server_error',
        message: 'network error',
        param: null,
      })
    )

    expect(parts).toContainEqual(
      expect.objectContaining({
        type: 'error',
        error: expect.objectContaining({ type: 'error', code: 'server_error', message: 'network error' }),
      })
    )
    expect(parts).toContainEqual(expect.objectContaining({ type: 'finish-step', finishReason: 'error' }))
    expect(parts).toContainEqual(expect.objectContaining({ type: 'finish', finishReason: 'error' }))
  })
})
