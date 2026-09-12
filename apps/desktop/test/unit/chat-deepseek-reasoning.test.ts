/**
 * HTTP contract for reasoning_content round trips (DeepSeek/GLM/Kimi through chat/completions).
 *
 * The provider rejects with 400 reasoning_content must be passed back whenever an assistant request
 * tool-call messages omit step reasoning. The compatible adapter only
 * materializes nonempty reasoning_content; tool steps without reasoning
 * or an empty string loses the field in the next request. The test uses the REAL adapter with scripted fetch
 * and requires:
 *   - The EXACT step reasoning value in the next request (streamText intra-step round trip);
 * must include an explicitly empty field;
 * reasoning cannot leak into subsequent steps;
 * persisted history must replay correctly on new turns;
 * subagents use the same normalization;
 * ten tool-call cycles retain all reasoning.
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { jsonSchema, streamText, tool, type ToolSet } from 'ai'
import { describe, expect, it } from 'vitest'
import { toModelMessages } from '../../src/main/chat/message'
import {
  applyInterleavedReplayToPrompt,
  normalizeInterleavedModelId,
  resolveInterleavedReplayPolicy,
  wrapInterleavedReplayModel,
  type InterleavedReplayStats,
} from '../../src/main/chat/reasoning-replay'
import type { ChatModelMeta } from '../../src/shared/chat'
import type { StoredChatMessage } from '../../src/main/chat/chat-store'

const FIELD = 'reasoning_content'
/** Synthetic fingerprints distinguish original and rotated backend credentials. */
const FP_A = 'fp_A'
const FP_B = 'fp_B'
/** Resolved policy carries full identity for persisted rehydration. */
const POLICY = { field: FIELD, providerId: 'deepseek', modelId: 'deepseek-v4-pro', providerFingerprint: FP_A }
const HISTORY_MODEL = { providerId: 'deepseek', modelId: 'deepseek-v4-pro' }

/** Catalog metadata models the DeepSeek interleaved capability. */
function interleavedMeta(): ChatModelMeta {
  return {
    reasoning: true,
    reasoningEfforts: ['low', 'high', 'max'],
    interleavedReasoning: { field: FIELD, format: 'text' },
  }
}

/** SSE in the adapter's expected format (data: JSON followed by data: [DONE]). */
function sse(events: readonly Record<string, unknown>[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function reasoningDelta(text: string): Record<string, unknown> {
  return { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: text } }] }
}

function contentDelta(text: string): Record<string, unknown> {
  return { choices: [{ index: 0, delta: { role: 'assistant', content: text } }] }
}

function toolCallDelta(index: number, callId: string, toolName: string, input: unknown): Record<string, unknown> {
  return {
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [
            { index, id: callId, type: 'function', function: { name: toolName, arguments: JSON.stringify(input) } },
          ],
        },
      },
    ],
  }
}

function finishDelta(reason: string): Record<string, unknown> {
  return { choices: [{ index: 0, delta: {}, finish_reason: reason }] }
}

/** Step response with reasoning and tool call (real DeepSeek order: reasoning, empty content, tool_calls). */
function toolStepResponse(reasoning: string, callId: string, toolName: string, input: unknown): Response {
  return sse([
    reasoningDelta(reasoning),
    contentDelta(''),
    toolCallDelta(0, callId, toolName, input),
    finishDelta('tool_calls'),
  ])
}

function finalTextResponse(text: string): Response {
  return sse([contentDelta(text), finishDelta('stop')])
}

/** Scripted fetch records parsed bodies and returns Responses in order. */
function scriptedFetch(script: Response[]) {
  const bodies: Array<Record<string, unknown>> = []
  const fetchImpl = async (_input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    bodies.push(JSON.parse(String(init?.body)))
    const response = script.shift()
    if (!response) throw new Error(`Unexpected HTTP request #${bodies.length}: ${String(init?.body).slice(0, 200)}`)
    return response
  }
  return { bodies, fetchImpl }
}

function deepSeekModel(fetchImpl: typeof fetch, wrapped: boolean, stats?: InterleavedReplayStats) {
  const provider = createOpenAICompatible({
    name: 'deepseek-contract',
    baseURL: 'http://deepseek.invalid/v1',
    apiKey: 'test-key',
    fetch: fetchImpl as unknown as typeof fetch,
    includeUsage: true,
  })
  let model = provider('deepseek-v4-pro')
  if (wrapped) model = wrapInterleavedReplayModel(model, POLICY, stats)
  return model
}

const readTool = (): ToolSet => ({
  read: tool({
    description: 'Reads a file',
    inputSchema: jsonSchema<{ path: string }>({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    }),
    execute: async ({ path }) => `content of ${path}`,
  }),
})

function assistantMessages(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return (body.messages as Array<Record<string, unknown>>).filter((m) => m.role === 'assistant')
}

const userMsg = (text: string): StoredChatMessage => ({
  id: `u-${text.length}`,
  conversationId: 'c1',
  role: 'user',
  parts: [{ type: 'text', id: 't', text }],
  createdAt: 1,
})

describe('intra-turn round trip (internal streamText steps)', () => {
  it('replays exact step reasoning without later contamination', async () => {
    const script: Response[] = [
      toolStepResponse('Step reasoning 1', 'call_1', 'read', { path: 'a' }),
      toolStepResponse('Step reasoning 2', 'call_2', 'read', { path: 'b' }),
      finalTextResponse('Done.'),
    ]
    const { bodies, fetchImpl } = scriptedFetch(script)
    const stats: InterleavedReplayStats = { normalizedSteps: 0, emptyFallbacks: 0 }
    const result = streamText({
      model: deepSeekModel(fetchImpl, true, stats),
      messages: [{ role: 'user', content: 'task' }],
      tools: readTool(),
      stopWhen: () => false,
    })
    for await (const part of result.fullStream) {
      void part
    }
    expect(bodies).toHaveLength(3)
    // Request 2: step 1 assistant carries the EXACT reasoning from response 1.
    expect(assistantMessages(bodies[1])[0]).toMatchObject({
      reasoning_content: 'Step reasoning 1',
    })
    // Request 3: TWO assistants (steps 1 and 2), each with ITS OWN reasoning, without mixing.
    const req3 = assistantMessages(bodies[2])
    expect(req3).toHaveLength(2)
    expect(req3[0]).toMatchObject({ reasoning_content: 'Step reasoning 1' })
    expect(req3[1]).toMatchObject({ reasoning_content: 'Step reasoning 2' })
    // CUMULATIVE counters: each request renormalizes the entire prompt (request 2 has 1 step; request 3 has 2).
    expect(stats).toEqual({ normalizedSteps: 3, emptyFallbacks: 0 })
  })

  it('replays exact reasoning with Standard mode policy enabled', async () => {
    const script: Response[] = [
      toolStepResponse('Reasoning with effort off', 'call_1', 'read', { path: 'a' }),
      finalTextResponse('Done.'),
    ]
    const { bodies, fetchImpl } = scriptedFetch(script)
    // Off omits effort overrides but models may still require reasoning replay.
    const policy = resolveInterleavedReplayPolicy({
      transport: 'openai',
      providerId: 'deepseek',
      modelId: 'deepseek-v4-pro',
      providerFingerprint: FP_A,
      meta: interleavedMeta(),
      reasoningEffort: 'off',
    })
    expect(policy).toEqual(POLICY)
    const provider = createOpenAICompatible({
      name: 'deepseek-contract',
      baseURL: 'http://deepseek.invalid/v1',
      apiKey: 'test-key',
      fetch: fetchImpl as unknown as typeof fetch,
      includeUsage: true,
    })
    const result = streamText({
      model: wrapInterleavedReplayModel(provider('deepseek-v4-pro'), policy!),
      messages: [{ role: 'user', content: 'task' }],
      tools: readTool(),
      stopWhen: () => false,
    })
    for await (const part of result.fullStream) {
      void part
    }
    expect(assistantMessages(bodies[1])[0]).toMatchObject({ reasoning_content: 'Reasoning with effort off' })
  })

  it('adds explicitly empty reasoning to tool calls without reasoning', async () => {
    const script: Response[] = [
      // Step 1: direct tool call without reasoning_content in the response.
      sse([toolCallDelta(0, 'call_1', 'read', { path: 'a' }), finishDelta('tool_calls')]),
      finalTextResponse('Done.'),
    ]
    const { bodies, fetchImpl } = scriptedFetch(script)
    const stats: InterleavedReplayStats = { normalizedSteps: 0, emptyFallbacks: 0 }
    const result = streamText({
      model: deepSeekModel(fetchImpl, true, stats),
      messages: [{ role: 'user', content: 'task' }],
      tools: readTool(),
      stopWhen: () => false,
    })
    for await (const part of result.fullStream) {
      void part
    }
    const step1 = assistantMessages(bodies[1])[0]
    expect(Object.hasOwn(step1, 'reasoning_content')).toBe(true)
    expect(step1.reasoning_content).toBe('')
    expect(step1.tool_calls).toHaveLength(1)
    expect(stats).toEqual({ normalizedSteps: 1, emptyFallbacks: 1 })
  })

  it('demonstrates empty-field loss without the normalization wrapper', async () => {
    const script: Response[] = [
      sse([toolCallDelta(0, 'call_1', 'read', { path: 'a' }), finishDelta('tool_calls')]),
      finalTextResponse('Done.'),
    ]
    const { bodies, fetchImpl } = scriptedFetch(script)
    const result = streamText({
      model: deepSeekModel(fetchImpl, false),
      messages: [{ role: 'user', content: 'task' }],
      tools: readTool(),
      stopWhen: () => false,
    })
    for await (const part of result.fullStream) {
      void part
    }
    const step1 = assistantMessages(bodies[1])[0]
    expect(Object.hasOwn(step1, 'reasoning_content')).toBe(false)
  })

  it('preserves ten tool cycles without loss or contamination', async () => {
    const script: Response[] = []
    for (let i = 1; i <= 10; i += 1) {
      script.push(toolStepResponse(`R${i}`, `call_${i}`, 'read', { path: `p${i}` }))
    }
    script.push(finalTextResponse('Done.'))
    const { bodies, fetchImpl } = scriptedFetch(script)
    const stats: InterleavedReplayStats = { normalizedSteps: 0, emptyFallbacks: 0 }
    const result = streamText({
      model: deepSeekModel(fetchImpl, true, stats),
      messages: [{ role: 'user', content: 'task' }],
      tools: readTool(),
      stopWhen: () => false,
    })
    for await (const part of result.fullStream) {
      void part
    }
    expect(bodies).toHaveLength(11)
    for (let i = 1; i <= 10; i += 1) {
      const assistants = assistantMessages(bodies[i])
      // Request i carries steps 1 through i, each with ITS OWN reasoning.
      expect(assistants).toHaveLength(i)
      assistants.forEach((assistant, j) => {
        expect(assistant.reasoning_content).toBe(`R${j + 1}`)
      })
    }
    // Ten steps produce 55 cumulative normalizations.
    expect(stats).toEqual({ normalizedSteps: 55, emptyFallbacks: 0 })
  })

  it('does not carry reasoning across user messages', () => {
    const prompt = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'R1' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'read', input: {} },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'read', output: { type: 'text', value: 'x' } }],
      },
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c2', toolName: 'read', input: {} }] },
    ] as Parameters<typeof applyInterleavedReplayToPrompt>[0]
    const out = applyInterleavedReplayToPrompt(prompt, POLICY)
    const withField = (out[0] as { providerOptions?: Record<string, Record<string, unknown>> }).providerOptions
    const afterUser = (out[3] as { providerOptions?: Record<string, Record<string, unknown>> }).providerOptions
    expect(withField?.openaiCompatible).toEqual({ reasoning_content: 'R1' })
    // Later assistants use their own empty fallback rather than inherited reasoning.
    expect(afterUser?.openaiCompatible).toEqual({ reasoning_content: '' })
  })
})

describe('persisted history replay on new turns', () => {
  it('rehydrates exact persisted reasoning and tool calls', async () => {
    const history: StoredChatMessage[] = [
      userMsg('read the file'),
      {
        id: 'a1',
        conversationId: 'c1',
        role: 'assistant',
        createdAt: 2,
        model: HISTORY_MODEL,
        providerFingerprint: FP_A,
        parts: [
          { type: 'reasoning', id: 'r1', text: 'I will read the file.' },
          {
            type: 'tool',
            id: 'k1',
            toolCallId: 'call_1',
            toolName: 'read',
            input: { path: 'a' },
            state: { status: 'completed', output: 'conteudo' },
          },
        ],
      },
    ]
    const messages = toModelMessages(history, { reasoningReplay: POLICY })
    // The reasoning part returns in content AND providerOptions carries its text for the adapter.
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'I will read the file.' },
        { type: 'tool-call', toolCallId: 'call_1', toolName: 'read' },
      ],
    })
    expect((messages[1] as { providerOptions?: unknown }).providerOptions).toEqual({
      openaiCompatible: { reasoning_content: 'I will read the file.' },
    })

    const { bodies, fetchImpl } = scriptedFetch([finalTextResponse('Done.')])
    const result = streamText({
      model: deepSeekModel(fetchImpl, true),
      messages,
      tools: readTool(),
    })
    for await (const part of result.fullStream) {
      void part
    }
    const assistant = assistantMessages(bodies[0])[0]
    expect(assistant.reasoning_content).toBe('I will read the file.')
  })

  it('adds empty reasoning fallback only with the policy active', () => {
    const history: StoredChatMessage[] = [
      userMsg('run'),
      {
        id: 'a1',
        conversationId: 'c1',
        role: 'assistant',
        createdAt: 2,
        model: HISTORY_MODEL,
        providerFingerprint: FP_A,
        parts: [
          {
            type: 'tool',
            id: 'k1',
            toolCallId: 'call_1',
            toolName: 'read',
            input: { path: 'a' },
            state: { status: 'completed', output: 'x' },
          },
        ],
      },
    ]
    const withPolicy = toModelMessages(history, { reasoningReplay: POLICY })
    expect((withPolicy[1] as { providerOptions?: unknown }).providerOptions).toEqual({
      openaiCompatible: { reasoning_content: '' },
    })
    // Without policy, reasoning remains display-only.
    const withoutPolicy = toModelMessages(history)
    expect(withoutPolicy[1].providerOptions).toBeUndefined()
  })

  it('uses empty reasoning for mismatched historical fingerprints', async () => {
    const history: StoredChatMessage[] = [
      userMsg('read'),
      {
        id: 'a1',
        conversationId: 'c1',
        role: 'assistant',
        createdAt: 2,
        model: HISTORY_MODEL,
        // Same provider and model with mismatched backend fingerprints.
        providerFingerprint: FP_B,
        parts: [
          { type: 'reasoning', id: 'r1', text: 'Old endpoint reasoning' },
          {
            type: 'tool',
            id: 'k1',
            toolCallId: 'call_1',
            toolName: 'read',
            input: { path: 'a' },
            state: { status: 'completed', output: 'conteudo' },
          },
        ],
      },
    ]
    const messages = toModelMessages(history, { reasoningReplay: POLICY })
    // Old reasoning stays out of content and the transport field is empty.
    expect(JSON.stringify(messages[1].content)).not.toContain('reasoning')
    expect((messages[1] as { providerOptions?: unknown }).providerOptions).toEqual({
      openaiCompatible: { reasoning_content: '' },
    })

    const { bodies, fetchImpl } = scriptedFetch([finalTextResponse('Done.')])
    const result = streamText({
      model: deepSeekModel(fetchImpl, true),
      messages,
      tools: readTool(),
    })
    for await (const part of result.fullStream) {
      void part
    }
    const assistant = assistantMessages(bodies[0])[0]
    expect(assistant.reasoning_content).toBe('')
  })

  it('combines degraded foreign history and real current-turn reasoning', async () => {
    const history: StoredChatMessage[] = [
      userMsg('first'),
      // Old step from another backend (fp_B): degrades to an empty string.
      {
        id: 'a1',
        conversationId: 'c1',
        role: 'assistant',
        createdAt: 2,
        model: HISTORY_MODEL,
        providerFingerprint: FP_B,
        parts: [
          { type: 'reasoning', id: 'r1', text: 'R-old' },
          {
            type: 'tool',
            id: 'k1',
            toolCallId: 'call_1',
            toolName: 'read',
            input: { path: 'a' },
            state: { status: 'completed', output: 'X' },
          },
        ],
      },
      userMsg('continua'),
      // The current turn PARTIAL (runner msgs[0], same origin): normal replay.
      {
        id: 'a2',
        conversationId: 'c1',
        role: 'assistant',
        createdAt: 4,
        model: HISTORY_MODEL,
        providerFingerprint: FP_A,
        parts: [
          { type: 'reasoning', id: 'r2', text: 'R-current' },
          {
            type: 'tool',
            id: 'k2',
            toolCallId: 'call_2',
            toolName: 'read',
            input: { path: 'b' },
            state: { status: 'completed', output: 'Y' },
          },
        ],
      },
    ]
    const messages = toModelMessages(history, { reasoningReplay: POLICY })
    const assistants = messages.filter((m) => m.role === 'assistant')
    expect(assistants).toHaveLength(2)
    expect(JSON.stringify(assistants[0].content)).not.toContain('reasoning')
    expect((assistants[0] as { providerOptions?: unknown }).providerOptions).toEqual({
      openaiCompatible: { reasoning_content: '' },
    })
    expect(assistants[1].content).toContainEqual({ type: 'reasoning', text: 'R-current' })
    expect((assistants[1] as { providerOptions?: unknown }).providerOptions).toEqual({
      openaiCompatible: { reasoning_content: 'R-current' },
    })

    const { bodies, fetchImpl } = scriptedFetch([finalTextResponse('Done.')])
    const result = streamText({
      model: deepSeekModel(fetchImpl, true),
      messages,
      tools: readTool(),
    })
    for await (const part of result.fullStream) {
      void part
    }
    const sent = assistantMessages(bodies[0])
    expect(sent).toHaveLength(2)
    expect(sent[0].reasoning_content).toBe('')
    expect(sent[1].reasoning_content).toBe('R-current')
  })
})

describe('subagent (same shape as runSubagent)', () => {
  it('normalizes subagent tool loops identically', async () => {
    const script: Response[] = [
      toolStepResponse('Subagent reasoning 1', 'call_1', 'read', { path: 'a' }),
      toolStepResponse('Subagent reasoning 2', 'call_2', 'read', { path: 'b' }),
      finalTextResponse('Sub done.'),
    ]
    const { bodies, fetchImpl } = scriptedFetch(script)
    const stats: InterleavedReplayStats = { normalizedSteps: 0, emptyFallbacks: 0 }
    const result = streamText({
      model: deepSeekModel(fetchImpl, true, stats),
      system: 'Subagent prompt',
      messages: [{ role: 'user', content: 'subtarefa' }],
      tools: readTool(),
      stopWhen: () => false,
    })
    for await (const part of result.fullStream) {
      void part
    }
    expect(assistantMessages(bodies[1])[0].reasoning_content).toBe('Subagent reasoning 1')
    expect(assistantMessages(bodies[2])).toHaveLength(2)
    expect(assistantMessages(bodies[2])[1].reasoning_content).toBe('Subagent reasoning 2')
    expect(stats).toEqual({ normalizedSteps: 3, emptyFallbacks: 0 })
  })
})

describe('resolveInterleavedReplayPolicy (capability-driven)', () => {
  const args = {
    transport: 'openai' as const,
    providerId: 'deepseek' as const,
    modelId: 'deepseek-v4-pro' as const,
    providerFingerprint: FP_A,
  }

  it('enables openai-compatible transport with interleaved metadata, with OR without selected effort', () => {
    expect(resolveInterleavedReplayPolicy({ ...args, meta: interleavedMeta(), reasoningEffort: 'high' })).toEqual(
      POLICY
    )
    expect(resolveInterleavedReplayPolicy({ ...args, meta: interleavedMeta(), reasoningEffort: undefined })).toEqual(
      POLICY
    )
  })

  it('enables replay in Standard mode without effort overrides', () => {
    expect(resolveInterleavedReplayPolicy({ ...args, meta: interleavedMeta(), reasoningEffort: 'off' })).toEqual(POLICY)
  })

  it('disables replay without interleaved capability', () => {
    expect(
      resolveInterleavedReplayPolicy({
        ...args,
        providerId: 'openai',
        modelId: 'gpt-5.6',
        meta: { reasoning: true, reasoningEfforts: ['low', 'high'] },
        reasoningEffort: 'high',
      })
    ).toBeNull()
  })

  it('does not enable replay for Responses, Anthropic or subscriptions', () => {
    expect(
      resolveInterleavedReplayPolicy({
        ...args,
        transport: 'openai-responses',
        meta: interleavedMeta(),
        reasoningEffort: 'high',
      })
    ).toBeNull()
    expect(
      resolveInterleavedReplayPolicy({
        ...args,
        transport: 'anthropic',
        meta: interleavedMeta(),
        reasoningEffort: 'high',
      })
    ).toBeNull()
    expect(
      resolveInterleavedReplayPolicy({
        ...args,
        transport: 'codex-subscription',
        providerId: 'openai',
        modelId: 'gpt-5.6',
        meta: { reasoning: true },
        reasoningEffort: 'high',
      })
    ).toBeNull()
  })

  it('uses conservative offline fallback only for known families', () => {
    const args2 = {
      transport: 'openai' as const,
      providerId: 'deepseek' as const,
      providerFingerprint: FP_A,
      reasoningEffort: 'high',
    }
    expect(
      resolveInterleavedReplayPolicy({ ...args2, modelId: 'deepseek-v4-pro', meta: null, catalogStatus: 'unavailable' })
    ).toEqual({ field: FIELD, providerId: 'deepseek', modelId: 'deepseek-v4-pro', providerFingerprint: FP_A })
    expect(
      resolveInterleavedReplayPolicy({
        ...args2,
        modelId: 'deepseek-v4-flash',
        meta: null,
        catalogStatus: 'unavailable',
      })
    ).toEqual({ field: FIELD, providerId: 'deepseek', modelId: 'deepseek-v4-flash', providerFingerprint: FP_A })
    // Available catalogs with missing entries cannot invent capabilities.
    expect(
      resolveInterleavedReplayPolicy({ ...args2, modelId: 'deepseek-v4-pro', meta: null, catalogStatus: 'available' })
    ).toBeNull()
    // Unknown families stay disabled even offline.
    expect(
      resolveInterleavedReplayPolicy({ ...args2, modelId: 'deepseek-chat', meta: null, catalogStatus: 'unavailable' })
    ).toBeNull()
    expect(
      resolveInterleavedReplayPolicy({ ...args2, modelId: 'gpt-5.6', meta: null, catalogStatus: 'unavailable' })
    ).toBeNull()
  })

  it('normalizes gateway IDs only for matching without changing sent IDs', () => {
    const args2 = {
      transport: 'openai' as const,
      providerId: 'deepseek' as const,
      providerFingerprint: FP_A,
      meta: null,
      catalogStatus: 'unavailable' as const,
      reasoningEffort: 'high',
    }
    expect(resolveInterleavedReplayPolicy({ ...args2, modelId: 'deepseek-v4-pro' })).toEqual({
      field: FIELD,
      providerId: 'deepseek',
      modelId: 'deepseek-v4-pro',
      providerFingerprint: FP_A,
    })
    expect(resolveInterleavedReplayPolicy({ ...args2, modelId: 'deepseek/deepseek-v4-pro' })).toEqual({
      field: FIELD,
      providerId: 'deepseek',
      modelId: 'deepseek/deepseek-v4-pro',
      providerFingerprint: FP_A,
    })
    expect(resolveInterleavedReplayPolicy({ ...args2, modelId: 'DEEPSEEK-V4-PRO' })).toEqual({
      field: FIELD,
      providerId: 'deepseek',
      modelId: 'DEEPSEEK-V4-PRO',
      providerFingerprint: FP_A,
    })
    expect(resolveInterleavedReplayPolicy({ ...args2, modelId: ' deepseek-v4-flash ' })).toEqual({
      field: FIELD,
      providerId: 'deepseek',
      modelId: ' deepseek-v4-flash ',
      providerFingerprint: FP_A,
    })
    // Namespaced matching uses only the final segment.
    expect(resolveInterleavedReplayPolicy({ ...args2, modelId: 'gateway/v1/deepseek/deepseek-v4-pro' })).toEqual({
      field: FIELD,
      providerId: 'deepseek',
      modelId: 'gateway/v1/deepseek/deepseek-v4-pro',
      providerFingerprint: FP_A,
    })
    // Empty and unknown IDs remain without policy.
    expect(resolveInterleavedReplayPolicy({ ...args2, modelId: 'deepseek-chat' })).toBeNull()
    expect(resolveInterleavedReplayPolicy({ ...args2, modelId: '  ' })).toBeNull()
  })

  it('normalizes interleaved IDs by trimming, lowercasing and taking the last segment', () => {
    expect(normalizeInterleavedModelId('deepseek-v4-pro')).toBe('deepseek-v4-pro')
    expect(normalizeInterleavedModelId('deepseek/deepseek-v4-pro')).toBe('deepseek-v4-pro')
    expect(normalizeInterleavedModelId('DEEPSEEK-V4-PRO')).toBe('deepseek-v4-pro')
    expect(normalizeInterleavedModelId(' deepseek-v4-flash ')).toBe('deepseek-v4-flash')
    expect(normalizeInterleavedModelId('gateway/v1/deepseek/deepseek-v4-pro')).toBe('deepseek-v4-pro')
  })
})
