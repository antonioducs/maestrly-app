import { stepCountIs, streamText, tool, type ModelMessage } from 'ai'
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test'
import type { LanguageModelV4Prompt, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  MISSING_TOOL_RESULT_TEXT,
  sanitizeToolHistory,
  sanitizeToolName,
} from '../../src/main/chat/tool-robustness/tool-history'
import { wrapToolRobustnessModel } from '../../src/main/chat/tool-robustness/model-middleware'

const call = (toolCallId: string, toolName = 'read', input: unknown = { path: 'a.ts' }) =>
  ({ type: 'tool-call', toolCallId, toolName, input }) as const
const result = (toolCallId: string, toolName = 'read', value = 'ok') =>
  ({ type: 'tool-result', toolCallId, toolName, output: { type: 'text', value } }) as const
const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] }) as const

function prompt(...messages: unknown[]): LanguageModelV4Prompt {
  return messages as LanguageModelV4Prompt
}

describe('sanitizeToolHistory', () => {
  it('returns a valid history as the same reference', () => {
    const valid = prompt(
      { role: 'system', content: 'sys' },
      user('go'),
      { role: 'assistant', content: [{ type: 'text', text: 'reading' }, call('c1'), call('c2', 'grep', {})] },
      { role: 'tool', content: [result('c1'), result('c2', 'grep')] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] }
    )
    const sanitized = sanitizeToolHistory(valid, { strictIds: true })
    expect(sanitized.prompt).toBe(valid)
    expect(sanitized.stats).toEqual({
      orphanCalls: 0,
      orphanResults: 0,
      renamedIds: 0,
      renamedNames: 0,
      repairedInputs: 0,
    })
  })

  it('answers an orphan call with a synthetic error right after its assistant message', () => {
    const history = prompt(
      user('go'),
      { role: 'assistant', content: [call('c1'), call('c2', 'bash', { command: 'make' })] },
      { role: 'tool', content: [result('c1')] },
      user('and now?'),
      { role: 'assistant', content: [call('c3')] },
      user('still there?')
    )
    const { prompt: out, stats } = sanitizeToolHistory(history)
    expect(stats.orphanCalls).toBe(2)
    expect(out[2]).toEqual({
      role: 'tool',
      content: [
        result('c1'),
        {
          type: 'tool-result',
          toolCallId: 'c2',
          toolName: 'bash',
          output: { type: 'error-text', value: MISSING_TOOL_RESULT_TEXT },
        },
      ],
    })
    expect(out[5]).toMatchObject({ role: 'tool', content: [{ toolCallId: 'c3', output: { type: 'error-text' } }] })
    expect(out[6]).toEqual(user('still there?'))
  })

  it('drops results without a call and second results for the same call', () => {
    const history = prompt(
      user('go'),
      { role: 'tool', content: [result('ghost')] },
      { role: 'assistant', content: [call('c1')] },
      { role: 'tool', content: [result('c1'), result('c1', 'read', 'again'), result('other')] }
    )
    const { prompt: out, stats } = sanitizeToolHistory(history)
    expect(stats.orphanResults).toBe(3)
    expect(out).toEqual([
      user('go'),
      { role: 'assistant', content: [call('c1')] },
      { role: 'tool', content: [result('c1')] },
    ])
  })

  it('pairs repeated ids by occurrence and renames them with their results', () => {
    const history = prompt(
      user('go'),
      { role: 'assistant', content: [call('call_0', 'read', { path: 'a' })] },
      { role: 'tool', content: [result('call_0', 'read', 'A')] },
      { role: 'assistant', content: [call('call_0', 'read', { path: 'b' })] },
      { role: 'tool', content: [result('call_0', 'read', 'B')] },
      { role: 'assistant', content: [call('', 'read', { path: 'c' }), call('', 'read', { path: 'd' })] },
      { role: 'tool', content: [result('', 'read', 'C'), result('', 'read', 'D')] }
    )
    const { prompt: out, stats } = sanitizeToolHistory(history)
    expect(stats.renamedIds).toBe(3)
    const ids = out.flatMap((message) =>
      Array.isArray(message.content)
        ? (message.content as Array<{ type: string; toolCallId?: string }>).flatMap((part) =>
            part.type === 'tool-call' ? [part.toolCallId] : []
          )
        : []
    )
    expect(new Set(ids).size).toBe(4)
    expect(ids[0]).toBe('call_0')
    expect(out[4]).toEqual({ role: 'tool', content: [result(ids[1]!, 'read', 'B')] })
    expect(out[6]).toEqual({ role: 'tool', content: [result(ids[2]!, 'read', 'C'), result(ids[3]!, 'read', 'D')] })
    // The same history always gets the same ids, which keeps the prompt cacheable.
    expect(sanitizeToolHistory(history).prompt).toEqual(out)
  })

  it('keeps Mistral-shaped ids nine alphanumeric characters when renaming them', () => {
    const history = prompt(
      { role: 'assistant', content: [call('abcDEF123')] },
      { role: 'tool', content: [result('abcDEF123')] },
      { role: 'assistant', content: [call('abcDEF123')] },
      { role: 'tool', content: [result('abcDEF123')] }
    )
    const renamed = (sanitizeToolHistory(history).prompt[2].content as Array<{ toolCallId: string }>)[0].toolCallId
    expect(renamed).toMatch(/^[A-Za-z0-9]{9}$/)
    expect(renamed).not.toBe('abcDEF123')
  })

  it('repairs invented names, Anthropic ids and arguments stored as text', () => {
    const history = prompt(
      { role: 'assistant', content: [call('functions.read:0', 'functions.read:0', '{"path":"a.ts"')] },
      { role: 'tool', content: [result('functions.read:0', 'functions.read:0', 'No tool is named …')] },
      { role: 'assistant', content: [call('c2', 'read', 'not json')] },
      { role: 'tool', content: [result('c2')] }
    )
    const { prompt: out, stats } = sanitizeToolHistory(history, { strictIds: true })
    expect(stats).toMatchObject({ renamedNames: 1, renamedIds: 1, repairedInputs: 2 })
    expect(out[0]).toEqual({
      role: 'assistant',
      content: [call('functions_read_0', 'functions_read_0', { path: 'a.ts' })],
    })
    expect(out[1]).toEqual({
      role: 'tool',
      content: [result('functions_read_0', 'functions_read_0', 'No tool is named …')],
    })
    expect(out[2]).toEqual({ role: 'assistant', content: [call('c2', 'read', {})] })
    // Without strict ids only the name changes.
    expect((sanitizeToolHistory(history).prompt[0].content as Array<{ toolCallId: string }>)[0].toolCallId).toBe(
      'functions.read:0'
    )
  })

  it('never touches provider-executed calls or the original prompt', () => {
    const history = prompt(
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'srv_1', toolName: 'web_search', input: {}, providerExecuted: true },
          { type: 'tool-result', toolCallId: 'srv_1', toolName: 'web_search', output: { type: 'json', value: {} } },
        ],
      },
      user('next')
    )
    expect(sanitizeToolHistory(history).prompt).toBe(history)
    const broken = prompt({ role: 'assistant', content: [call('c1')] })
    const frozen = structuredClone(broken)
    sanitizeToolHistory(broken)
    expect(broken).toEqual(frozen)
    expect(sanitizeToolName('a'.repeat(80))).toHaveLength(64)
    expect(sanitizeToolName('???')).toBe('invalid_tool')
  })
})

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}

const stopStep: LanguageModelV4StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
]

function stepWith(id: string, path: string): LanguageModelV4StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id, toolName: 'read' },
    { type: 'tool-input-delta', id, delta: JSON.stringify({ path }) },
    { type: 'tool-input-end', id },
    { type: 'tool-call', toolCallId: id, toolName: 'read', input: JSON.stringify({ path }) },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
  ]
}

describe('tool robustness model middleware', () => {
  it('gives a reused streamed id a fresh one so steps never collide', async () => {
    const inner = new MockLanguageModelV4({
      doStream: [
        { stream: convertArrayToReadableStream(stepWith('call_0', 'a.ts')) },
        { stream: convertArrayToReadableStream(stepWith('call_0', 'b.ts')) },
        {
          stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
            { type: 'stream-start', warnings: [] },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
          ]),
        },
      ],
    })
    const onDiag = vi.fn()
    const model = wrapToolRobustnessModel(inner, {
      transport: 'openai-compatible',
      baseURL: 'http://127.0.0.1:8080/v1',
      modelId: 'qwen3',
      onDiag,
    })
    const execute = vi.fn(async ({ path }: { path: string }) => `content of ${path}`)
    const run = streamText({
      model,
      prompt: 'go',
      tools: { read: tool({ inputSchema: z.object({ path: z.string() }), execute }) },
      stopWhen: stepCountIs(4),
    })
    const ids: string[] = []
    for await (const part of run.fullStream) if (part.type === 'tool-call') ids.push(part.toolCallId)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(ids[0]).toBe('call_0')
    expect(ids[1]).toMatch(/^call_[0-9a-f]{24}$/)
    const third = inner.doStreamCalls[2].prompt
    const results = third.flatMap((message) =>
      message.role === 'tool' ? message.content.map((part) => (part as { toolCallId: string }).toolCallId) : []
    )
    expect(results).toEqual(ids)
    expect(onDiag).toHaveBeenCalledWith(expect.objectContaining({ kind: 'tool-history-sanitized', streamIds: 1 }))
  })

  it('repairs the history and adapts schemas before the provider sees them', async () => {
    const inner = new MockLanguageModelV4({ doStream: { stream: convertArrayToReadableStream(stopStep) } })
    const model = wrapToolRobustnessModel(inner, {
      transport: 'openai-compatible',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
      modelId: 'gemini-4-argon',
    })
    const run = streamText({
      model,
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'k:0', toolName: 'functions.read:0', input: '{"path":"a"' as never },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'k:0',
              toolName: 'functions.read:0',
              output: { type: 'error-text', value: 'No tool is named "functions.read:0"' },
            },
          ],
        },
        { role: 'user', content: 'try again' },
      ],
      tools: {
        pick: tool({
          inputSchema: z.object({ mode: z.literal('fast'), pair: z.tuple([z.string(), z.number()]) }),
          execute: async () => 'ok',
        }),
      },
    })
    await run.consumeStream()
    const request = inner.doStreamCalls[0]
    expect(request.prompt[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'k:0', toolName: 'functions_read_0', input: { path: 'a' } }],
    })
    expect(request.prompt[2]).toMatchObject({ role: 'tool', content: [{ toolName: 'functions_read_0' }] })
    const schema = (request.tools![0] as { inputSchema: Record<string, any> }).inputSchema
    expect(schema.properties.mode).not.toHaveProperty('const')
    expect(schema.properties.mode.enum).toEqual(['fast'])
    expect(schema.properties.pair.prefixItems).toHaveLength(2)
  })

  it('lets the AI SDK accept a history with an orphan call once the messages are sanitized', async () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'read', input: { path: 'a' } }] },
      { role: 'user', content: 'what happened?' },
    ]
    const errors: unknown[] = []
    const refused = new MockLanguageModelV4({ doStream: { stream: convertArrayToReadableStream(stopStep) } })
    await streamText({ model: refused, messages, onError: ({ error }) => void errors.push(error) }).consumeStream()
    expect(String(errors[0])).toMatch(/Tool result is missing for tool call c1/)
    expect(refused.doStreamCalls).toHaveLength(0)

    const inner = new MockLanguageModelV4({ doStream: { stream: convertArrayToReadableStream(stopStep) } })
    await streamText({ model: inner, messages: sanitizeToolHistory(messages).prompt }).consumeStream()
    expect(inner.doStreamCalls[0].prompt[2]).toMatchObject({
      role: 'tool',
      content: [{ toolCallId: 'c1', output: { type: 'error-text', value: MISSING_TOOL_RESULT_TEXT } }],
    })
  })

  it('leaves Anthropic schemas and stream ids alone and only repairs the history', async () => {
    const inner = new MockLanguageModelV4({
      doStream: { stream: convertArrayToReadableStream(stepWith('toolu_1', 'a.ts')) },
    })
    const model = wrapToolRobustnessModel(inner, {
      transport: 'anthropic',
      baseURL: 'https://api.anthropic.com/v1',
      modelId: 'claude-opus-5',
    })
    const { stream } = await model.doStream({
      prompt: prompt({ role: 'assistant', content: [call('toolu_1')] }, { role: 'tool', content: [result('toolu_1')] }),
      tools: [{ type: 'function', name: 'pick', inputSchema: { type: 'object', properties: { a: { const: 1 } } } }],
    })
    const parts: LanguageModelV4StreamPart[] = []
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
    }
    expect(parts.find((part) => part.type === 'tool-call')).toMatchObject({ toolCallId: 'toolu_1' })
    expect((inner.doStreamCalls[0].tools![0] as { inputSchema: unknown }).inputSchema).toEqual({
      type: 'object',
      properties: { a: { const: 1 } },
    })
  })
})
