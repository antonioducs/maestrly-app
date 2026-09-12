import { expect, it, vi } from 'vitest'
import { summarizeWithClaudeRuntime } from '../../src/main/chat/portable-summarizer'
function fixture(messages: unknown[], failure?: Error) {
  const query = {
    initializationResult: vi.fn(async () => ({ account: {} })),
    close: vi.fn(),
    interrupt: vi.fn(async () => {}),
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message
      if (failure) throw failure
    },
  }
  const manager = {
    assertAccountIdentity: vi.fn(),
    assertSubscriptionRuntimeAccount: vi.fn(),
    createQuery: vi.fn(() => query),
  }
  return {
    query,
    manager,
    args: {
      manager: manager as any,
      accountIdentity: { fingerprint: 'a', epoch: 1 },
      cwd: '/tmp',
      modelId: 'm',
      system: 'system',
      prompt: 'summarize',
      signal: new AbortController().signal,
    },
  }
}
it('preserves structured quota and usage/cost from failed results', async () => {
  const raw = {
    type: 'result',
    subtype: 'error_during_execution',
    errors: ["You've hit your limit"],
    usage: { input_tokens: 4, output_tokens: 2 },
    total_cost_usd: 0.12,
  }
  const f = fixture([raw])
  await expect(summarizeWithClaudeRuntime(f.args)).rejects.toMatchObject({
    rawFailure: raw,
    quotaClassification: { kind: 'quota' },
    partialUsage: { input: 4, output: 2 },
    runtimeEstimatedCostUsd: 0.12,
  })
  expect(f.query.close).toHaveBeenCalledOnce()
})
it('retains partial assistant usage when transport ends without a result', async () => {
  const f = fixture(
    [
      {
        type: 'assistant',
        uuid: 'u',
        message: { id: 'm', content: [], usage: { input_tokens: 5, output_tokens: 1 } },
        total_cost_usd: 0.1,
      },
    ],
    new Error('network')
  )
  await expect(summarizeWithClaudeRuntime(f.args)).rejects.toMatchObject({
    partialUsage: { input: 5, output: 1 },
    runtimeEstimatedCostUsd: 0.1,
    quotaClassification: { kind: 'other' },
  })
  expect(f.query.close).toHaveBeenCalledOnce()
})
it('does not classify quota quoted in a non-quota result', async () => {
  const f = fixture([{ type: 'result', subtype: 'error_max_turns', errors: ["You've hit your limit"], usage: {} }])
  await expect(summarizeWithClaudeRuntime(f.args)).rejects.toMatchObject({ quotaClassification: { kind: 'other' } })
})
it('sends images through the gated prompt with no tools or resumable session', async () => {
  const f = fixture([{ type: 'result', subtype: 'success', usage: {}, total_cost_usd: 0 }])
  await summarizeWithClaudeRuntime({
    ...f.args,
    images: [{ name: 'x', mediaType: 'image/png', base64: 'YWJj', dataUrl: 'data:image/png;base64,YWJj' }],
  })
  const input = (f.manager.createQuery.mock.calls as any)[0][0]
  expect(input.options).toMatchObject({
    tools: [],
    allowedTools: [],
    mcpServers: {},
    persistSession: false,
    settingSources: [],
  })
  const prompt = await input.prompt[Symbol.asyncIterator]().next()
  expect(prompt.value.message.content).toContainEqual({
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'YWJj' },
  })
  expect(f.query.close).toHaveBeenCalledOnce()
})
it('closes when initialization identity verification rejects', async () => {
  const f = fixture([])
  f.manager.assertSubscriptionRuntimeAccount.mockImplementation(() => {
    throw new Error('wrong account')
  })
  await expect(summarizeWithClaudeRuntime(f.args)).rejects.toThrow('wrong account')
  expect(f.query.close).toHaveBeenCalledOnce()
})

it('retains the explicit assistant quota diagnostic when the final result is generic', async () => {
  const f = fixture([
    {
      type: 'assistant',
      error: 'rate_limit',
      uuid: 'quota',
      message: {
        id: 'quota',
        usage: { input_tokens: 2, output_tokens: 1 },
        content: [{ type: 'text', text: "You've hit your usage limit" }],
      },
    },
    {
      type: 'result',
      subtype: 'error_during_execution',
      errors: ['Claude execution stopped'],
      usage: { input_tokens: 2, output_tokens: 1 },
    },
  ])
  await expect(summarizeWithClaudeRuntime(f.args)).rejects.toMatchObject({ quotaClassification: { kind: 'quota' } })
})
it('redacts credentials from public helper diagnostics', async () => {
  const f = fixture([], new Error('Authorization: Bearer sk-ant-secretvalue123'))
  await expect(summarizeWithClaudeRuntime(f.args)).rejects.toMatchObject({
    message: 'Authorization: Bearer [REDACTED]',
  })
})
