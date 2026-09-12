import { beforeEach, describe, expect, it, vi } from 'vitest'
import { jsonSchema, streamText, tool } from 'ai'
import { runSubagent } from '../../src/main/chat/subagent-runner'
import { adaptToolSetForModel } from '../../src/main/chat/tool-capabilities'
import type { SubagentTextUpdate } from '../../src/main/chat/subagent-text-stream'

const mocks = vi.hoisted(() => ({
  resolveChatModel: vi.fn(),
  getProviderModelMeta: vi.fn(),
  openAIHarness: false,
}))

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, streamText: vi.fn() }
})

vi.mock('../../src/main/chat/provider', () => ({
  resolveChatModel: mocks.resolveChatModel,
}))

vi.mock('../../src/main/chat/catalog', () => ({
  getProvider: () => ({ id: 'anthropic-proxy', baseURL: 'http://localhost:9095/v1' }),
}))

vi.mock('../../src/main/chat/model-meta', () => ({
  catalogProviderForBaseURL: () => 'anthropic',
  getProviderModelMetaWithStatus: mocks.getProviderModelMeta,
}))

vi.mock('../../src/main/store', () => ({
  getAppFlag: () => mocks.openAIHarness,
}))

vi.mock('../../src/main/chat/diag-log', () => ({
  chatDiag: vi.fn(),
}))

vi.mock('../../src/main/chat/usage-diagnostics', () => ({
  recordModelCallUsage: vi.fn(),
}))

const streamTextMock = vi.mocked(streamText)

function fullStream(parts: unknown[]) {
  return {
    fullStream: (async function* () {
      for (const part of parts) yield part
    })(),
  }
}

describe('BYOK subagent prompt cache contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.openAIHarness = false
    mocks.resolveChatModel.mockReturnValue({
      model: { specificationVersion: 'v4', provider: 'anthropic-proxy', modelId: 'claude-opus-5' },
      transport: 'anthropic',
      harnessProfile: 'legacy-v1',
      promptProfile: 'maestrly-legacy',
      capabilities: {
        encryptedReasoning: false,
        nativeApplyPatch: false,
        nativeCompaction: false,
        nativeShell: false,
        promptCacheKey: false,
        toolSearch: false,
      },
      providerFingerprint: 'test',
    })
    mocks.getProviderModelMeta.mockResolvedValue({
      status: 'available',
      meta: { contextWindow: 200_000, maxOutput: 8_192 },
    })
  })

  it('marks every Anthropic attempt, disables SDK retry, and aggregates continuation cache_read', async () => {
    const textUpdates: SubagentTextUpdate[] = []
    streamTextMock
      .mockReturnValueOnce(
        fullStream([
          { type: 'text-delta', text: 'partial' },
          { type: 'finish-step', usage: { inputTokens: 100, outputTokens: 10 } },
          {
            type: 'finish',
            finishReason: 'length',
            totalUsage: { inputTokens: 100, outputTokens: 10 },
          },
        ]) as never
      )
      .mockReturnValueOnce(
        fullStream([
          { type: 'text-delta', text: ' done' },
          {
            type: 'finish-step',
            usage: {
              inputTokens: 100,
              outputTokens: 5,
              inputTokenDetails: { cacheReadTokens: 80, cacheWriteTokens: 0 },
            },
          },
          {
            type: 'finish',
            finishReason: 'stop',
            totalUsage: {
              inputTokens: 100,
              outputTokens: 5,
              inputTokenDetails: { cacheReadTokens: 80, cacheWriteTokens: 0 },
            },
          },
        ]) as never
      )

    const result = await runSubagent({
      cwd: '/repo',
      projectId: 'project',
      conversationId: 'conversation',
      parentMessageId: 'assistant',
      profile: {
        version: 1,
        agentName: 'explore',
        effective: {
          providerId: 'anthropic-proxy',
          modelId: 'claude-opus-5',
          configuredEffort: 'max',
          sentEffort: 'max',
          source: 'parent',
          candidateIndex: 0,
        },
        attempts: [],
      },
      definition: {
        name: 'explore',
        description: 'read only',
        prompt: 'Investigate.',
        source: 'test',
      },
      broker: {} as never,
      signal: new AbortController().signal,
      agentName: 'explore',
      task: 'Find the cause',
      readOnly: true,
      onTextUpdate: (update) => textUpdates.push(update),
    })

    expect(streamTextMock).toHaveBeenCalledTimes(2)
    for (const [options] of streamTextMock.mock.calls) {
      expect(options.maxRetries).toBe(0)
      expect(
        options.messages?.filter((message) => message.providerOptions?.anthropic?.cacheControl != null).length
      ).toBeGreaterThan(0)
    }
    expect(result.usage).toEqual({
      input: 120,
      output: 15,
      cacheRead: 80,
      cacheCreate: 0,
      totalInput: 200,
    })
    expect(result.text).toBe('partial done')
    expect(textUpdates).toEqual([
      { kind: 'append', text: 'partial' },
      { kind: 'append', text: ' done' },
    ])
  })

  it('replays the previous Maestro turn as history ahead of the new task, including on continuation', async () => {
    streamTextMock
      .mockReturnValueOnce(
        fullStream([
          { type: 'text-delta', text: 'partial' },
          { type: 'finish-step', usage: { inputTokens: 10, outputTokens: 1 } },
          { type: 'finish', finishReason: 'length', totalUsage: { inputTokens: 10, outputTokens: 1 } },
        ]) as never
      )
      .mockReturnValueOnce(
        fullStream([
          { type: 'text-delta', text: ' done' },
          { type: 'finish-step', usage: { inputTokens: 10, outputTokens: 1 } },
          { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 10, outputTokens: 1 } },
        ]) as never
      )
    const replayHistory = [
      { role: 'user' as const, content: 'Build the panel.' },
      { role: 'assistant' as const, content: '[tool read → completed]\nPanel built.' },
    ]

    const result = await runSubagent({
      cwd: '/repo',
      projectId: 'project',
      conversationId: 'conversation',
      parentMessageId: 'assistant',
      profile: {
        version: 1,
        agentName: 'author',
        effective: {
          providerId: 'anthropic-proxy',
          modelId: 'claude-opus-5',
          configuredEffort: 'off',
          sentEffort: null,
          source: 'parent',
          candidateIndex: 0,
        },
        attempts: [],
      },
      definition: { name: 'author', description: 'worker', prompt: 'Implement.', source: 'test' },
      broker: {} as never,
      signal: new AbortController().signal,
      agentName: 'author',
      task: 'Apply findings F-1 and F-2.',
      readOnly: true,
      replayHistory,
    })

    expect(result.text).toBe('partial done')
    expect(streamTextMock).toHaveBeenCalledTimes(2)
    const roles = (index: number) =>
      (streamTextMock.mock.calls[index]![0].messages ?? []).map((message) => [
        message.role,
        typeof message.content === 'string' ? message.content : '',
      ])
    expect(roles(0)).toEqual([
      ['user', 'Build the panel.'],
      ['assistant', '[tool read → completed]\nPanel built.'],
      ['user', 'Apply findings F-1 and F-2.'],
    ])
    expect(roles(1)).toEqual([
      ['user', 'Build the panel.'],
      ['assistant', '[tool read → completed]\nPanel built.'],
      ['user', 'Apply findings F-1 and F-2.'],
      ['assistant', 'partial'],
    ])
  })

  it('keeps mutating OpenAI checkpoints in memory for standalone ownership', async () => {
    mocks.openAIHarness = true
    mocks.resolveChatModel.mockReturnValue({
      model: { specificationVersion: 'v4', provider: 'openai', modelId: 'gpt-5.6' },
      transport: 'openai',
      harnessProfile: 'openai-responses-v1',
      promptProfile: 'maestrly-openai-generic-v1',
      capabilities: {
        responseItems: true,
        encryptedReasoning: false,
        messagePhase: false,
        strictTools: true,
        parallelTools: true,
        promptCacheKey: true,
        reasoningContext: false,
        nativeCompaction: false,
        toolSearch: false,
        nativeShell: false,
        nativeApplyPatch: false,
        websocket: false,
      },
      providerFingerprint: 'standalone-test',
    })
    const execute = vi.fn(async () => 'changed')
    const browserClick = tool({
      description: 'Mutate browser state.',
      inputSchema: jsonSchema({ type: 'object', properties: {} }),
      execute,
    })
    streamTextMock.mockImplementationOnce(
      (options) =>
        ({
          fullStream: (async function* () {
            await options.tools?.browser_click?.execute?.({}, {
              toolCallId: 'standalone-call',
              messages: [],
              abortSignal: new AbortController().signal,
            } as never)
            yield { type: 'text-delta', text: 'done' }
            yield { type: 'finish-step', usage: { inputTokens: 1, outputTokens: 1 } }
            yield { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } }
          })(),
        }) as never
    )

    const result = await runSubagent({
      cwd: '/repo',
      projectId: 'standalone-project-without-fk',
      conversationId: 'standalone-conversation-without-fk',
      parentMessageId: 'standalone-message-without-fk',
      messageOwnership: { kind: 'standalone' },
      profile: {
        version: 1,
        agentName: 'browser-worker',
        effective: {
          providerId: 'openai',
          modelId: 'gpt-5.6',
          configuredEffort: 'off',
          sentEffort: null,
          source: 'parent',
          candidateIndex: 0,
        },
        attempts: [],
      },
      definition: {
        name: 'browser-worker',
        description: 'mutable worker',
        prompt: 'Mutate browser state.',
        source: 'test',
        tools: ['browser_click'],
      },
      tools: { browser_click: browserClick },
      broker: {} as never,
      signal: new AbortController().signal,
      agentName: 'browser-worker',
      task: 'Click once.',
      readOnly: false,
    })

    expect(result.text).toBe('done')
    expect(execute).toHaveBeenCalledOnce()
  })

  it('exposes and executes generate_image in a BYOK worker only with the parent ToolSet', async () => {
    const worker = {
      name: 'general-purpose',
      description: 'worker',
      prompt: 'Implement.',
      source: 'test',
      tools: ['bash', 'generate_image'],
    }
    const execute = vi.fn(async () => 'generated')
    const hostTool = tool({
      description: 'Generate an image.',
      inputSchema: jsonSchema({ type: 'object', properties: {} }),
      execute,
    })
    const base: Parameters<typeof runSubagent>[0] = {
      cwd: '/repo',
      projectId: 'project',
      conversationId: 'conversation-image',
      parentMessageId: 'assistant',
      profile: {
        version: 1,
        agentName: 'general-purpose',
        effective: {
          providerId: 'anthropic-proxy',
          modelId: 'claude-opus-5',
          configuredEffort: 'max',
          sentEffort: 'max',
          source: 'parent',
          candidateIndex: 0,
        },
        attempts: [],
      },
      definition: worker,
      broker: {} as never,
      signal: new AbortController().signal,
      agentName: 'general-purpose',
      task: 'Generate an image.',
      readOnly: false,
    }
    const stream = () =>
      fullStream([
        { type: 'text-delta', text: 'done' },
        { type: 'finish-step', usage: { inputTokens: 1, outputTokens: 1 } },
        { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } },
      ]) as never

    streamTextMock.mockReturnValueOnce(stream())
    await runSubagent({ ...base, tools: { generate_image: hostTool } })
    const exposed = streamTextMock.mock.calls[0]?.[0].tools?.generate_image
    expect(exposed).toBeDefined()
    await exposed?.execute?.({}, { toolCallId: 'image-call', abortSignal: new AbortController().signal } as never)
    expect(execute).toHaveBeenCalled()

    streamTextMock.mockReturnValueOnce(stream())
    await runSubagent({ ...base, tools: {} })
    expect(streamTextMock.mock.calls[1]?.[0].tools?.generate_image).toBeUndefined()

    streamTextMock.mockReturnValueOnce(stream())
    await runSubagent({ ...base, readOnly: true, tools: { generate_image: hostTool } })
    expect(streamTextMock.mock.calls[2]?.[0].tools?.generate_image).toBeUndefined()
  })

  it('does not reinvoke a subagent after interruption with generate_image without a durable ledger', async () => {
    const hostTool = tool({
      description: 'Generate an image.',
      inputSchema: jsonSchema({ type: 'object', properties: {} }),
      execute: vi.fn(async () => 'generated'),
    })
    const base: Parameters<typeof runSubagent>[0] = {
      cwd: '/repo',
      projectId: 'project',
      conversationId: 'conversation-interrupted-image',
      parentMessageId: 'assistant',
      profile: {
        version: 1,
        agentName: 'general-purpose',
        effective: {
          providerId: 'anthropic-proxy',
          modelId: 'claude-opus-5',
          configuredEffort: 'max',
          sentEffort: 'max',
          source: 'parent',
          candidateIndex: 0,
        },
        attempts: [],
      },
      definition: {
        name: 'general-purpose',
        description: 'worker',
        prompt: 'Implement.',
        source: 'test',
        tools: ['bash', 'generate_image'],
      },
      broker: {} as never,
      signal: new AbortController().signal,
      agentName: 'general-purpose',
      task: 'Generate an image.',
      readOnly: false,
    }
    streamTextMock.mockReturnValueOnce(
      fullStream([
        { type: 'tool-call', toolCallId: 'img-1', toolName: 'generate_image', input: {} },
        { type: 'finish-step', usage: { inputTokens: 1, outputTokens: 1 } },
        { type: 'finish', finishReason: 'length', totalUsage: { inputTokens: 1, outputTokens: 1 } },
      ]) as never
    )

    const result = await runSubagent({ ...base, tools: { generate_image: hostTool } })

    expect(streamTextMock).toHaveBeenCalledTimes(1)
    expect(result.error).toContain('mutating tool call')
  })

  it('does not reinvoke after interruption with browser_click, notes writes, or unknown MCP tools', async () => {
    const click = tool({
      description: 'Click the page.',
      inputSchema: jsonSchema({ type: 'object', properties: {} }),
      execute: vi.fn(async () => 'clicked'),
    })
    const writeNotes = tool({
      description: 'Write a notes page.',
      inputSchema: jsonSchema({ type: 'object', properties: {} }),
      execute: vi.fn(async () => 'moved'),
    })
    const unknownMcp = tool({
      description: 'Unknown MCP tool.',
      inputSchema: jsonSchema({ type: 'object', properties: {} }),
      execute: vi.fn(async () => 'ok'),
    })
    const base: Parameters<typeof runSubagent>[0] = {
      cwd: '/repo',
      projectId: 'project',
      conversationId: 'conversation-interrupted-host',
      parentMessageId: 'assistant',
      profile: {
        version: 1,
        agentName: 'host-worker',
        effective: {
          providerId: 'anthropic-proxy',
          modelId: 'claude-opus-5',
          configuredEffort: 'max',
          sentEffort: 'max',
          source: 'parent',
          candidateIndex: 0,
        },
        attempts: [],
      },
      broker: {} as never,
      signal: new AbortController().signal,
      agentName: 'host-worker',
      task: 'Interact.',
      readOnly: false,
      definition: {
        name: 'host-worker',
        description: 'worker',
        prompt: 'Drive.',
        source: 'project',
        tools: ['browser_click'],
      },
    }
    const interrupted = (toolName: string) =>
      fullStream([
        { type: 'tool-call', toolCallId: `call-${toolName}`, toolName, input: {} },
        { type: 'finish-step', usage: { inputTokens: 1, outputTokens: 1 } },
        { type: 'finish', finishReason: 'length', totalUsage: { inputTokens: 1, outputTokens: 1 } },
      ]) as never

    streamTextMock.mockReturnValueOnce(interrupted('browser_click'))
    const clicked = await runSubagent({
      ...base,
      definition: {
        name: 'host-worker',
        description: 'worker',
        prompt: 'Drive.',
        source: 'project',
        tools: ['browser_click'],
      },
      tools: { browser_click: click },
    })
    expect(clicked.error).toContain('mutating tool call')

    streamTextMock.mockReturnValueOnce(interrupted('notes_write_page'))
    const wrote = await runSubagent({
      ...base,
      definition: {
        name: 'host-worker',
        description: 'worker',
        prompt: 'Drive.',
        source: 'project',
        tools: ['notes_write_page'],
      },
      tools: { notes_write_page: writeNotes },
    })
    expect(wrote.error).toContain('mutating tool call')

    streamTextMock.mockReturnValueOnce(interrupted('mcp_unknown_write'))
    const unknown = await runSubagent({
      ...base,
      definition: {
        name: 'host-worker',
        description: 'worker',
        prompt: 'Drive.',
        source: 'project',
        tools: ['mcp_unknown_write'],
      },
      tools: { mcp_unknown_write: unknownMcp },
    })
    expect(unknown.error).toContain('mutating tool call')
    expect(streamTextMock).toHaveBeenCalledTimes(3)
  })

  it('retains retry after browser_screenshot interruption with a proven read-only contract', async () => {
    const screenshot = tool({
      description: 'Capture the current browser page.',
      inputSchema: jsonSchema({ type: 'object', properties: {} }),
      execute: vi.fn(async () => 'captured'),
    })
    streamTextMock
      .mockReturnValueOnce(
        fullStream([
          { type: 'tool-call', toolCallId: 'shot-1', toolName: 'browser_screenshot', input: {} },
          { type: 'finish-step', usage: { inputTokens: 1, outputTokens: 1 } },
          { type: 'finish', finishReason: 'length', totalUsage: { inputTokens: 1, outputTokens: 1 } },
        ]) as never
      )
      .mockReturnValueOnce(
        fullStream([
          { type: 'text-delta', text: 'done' },
          { type: 'finish-step', usage: { inputTokens: 1, outputTokens: 1 } },
          { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } },
        ]) as never
      )

    const result = await runSubagent({
      cwd: '/repo',
      projectId: 'project',
      conversationId: 'conversation-screenshot-retry',
      parentMessageId: 'assistant',
      profile: {
        version: 1,
        agentName: 'explore',
        effective: {
          providerId: 'anthropic-proxy',
          modelId: 'claude-opus-5',
          configuredEffort: 'max',
          sentEffort: 'max',
          source: 'parent',
          candidateIndex: 0,
        },
        attempts: [],
      },
      definition: { name: 'explore', description: 'read only', prompt: 'Investigate.', source: 'built-in' },
      broker: {} as never,
      signal: new AbortController().signal,
      agentName: 'explore',
      task: 'Capture.',
      readOnly: true,
      tools: { browser_screenshot: screenshot },
    })

    expect(streamTextMock).toHaveBeenCalledTimes(2)
    expect(result.error).toBeUndefined()
    expect(result.text).toBe('done')
  })

  it('makes built-in explore call browser_screenshot and uses the interpreter when the child lacks vision', async () => {
    const screenshot = tool({
      description: 'Capture the current browser page.',
      inputSchema: jsonSchema({ type: 'object', properties: {} }),
      execute: vi.fn(async () => ({
        text: 'Screenshot captured.',
        images: [{ id: 'tool-image:screenshot', mediaType: 'image/png' }],
      })),
    })
    const click = tool({
      description: 'Click the page.',
      inputSchema: jsonSchema({ type: 'object', properties: {} }),
      execute: vi.fn(async () => 'clicked'),
    })
    const describeImage = vi.fn(async () => ({
      text: 'A browser page with a visible login form.',
      model: 'test/interpreter',
    }))
    const childTools = adaptToolSetForModel({
      tools: { browser_screenshot: screenshot, browser_click: click },
      supportsImages: false,
      describeImage,
    })
    streamTextMock.mockReturnValueOnce(
      fullStream([
        { type: 'text-delta', text: 'done' },
        { type: 'finish-step', usage: { inputTokens: 1, outputTokens: 1 } },
        { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } },
      ]) as never
    )

    await runSubagent({
      cwd: '/repo',
      projectId: 'project',
      conversationId: 'conversation-browser',
      parentMessageId: 'assistant',
      profile: {
        version: 1,
        agentName: 'explore',
        effective: {
          providerId: 'anthropic-proxy',
          modelId: 'claude-opus-5',
          configuredEffort: 'max',
          sentEffort: 'max',
          source: 'parent',
          candidateIndex: 0,
        },
        attempts: [],
      },
      definition: {
        name: 'explore',
        description: 'Read-only exploration',
        prompt: 'Investigate.',
        source: 'built-in',
      },
      broker: {} as never,
      signal: new AbortController().signal,
      agentName: 'explore',
      task: 'Inspect the browser page.',
      readOnly: true,
      tools: childTools,
    })

    const exposed = streamTextMock.mock.calls.at(-1)?.[0].tools?.browser_screenshot as {
      execute?: (input: unknown, options: unknown) => Promise<unknown>
    }
    expect(exposed).toBeDefined()
    expect(streamTextMock.mock.calls.at(-1)?.[0].tools?.browser_click).toBeUndefined()
    const output = await exposed.execute?.({}, { toolCallId: 'screenshot-call' })
    expect(output).toMatchObject({
      text: 'Screenshot captured.',
      images: [{ description: 'A browser page with a visible login form.', descriptionModel: 'test/interpreter' }],
    })
    expect(describeImage).toHaveBeenCalledWith(expect.objectContaining({ id: 'tool-image:screenshot' }))
  })

  it('classifies a browser-only custom agent by the host ToolSet read-only contract', async () => {
    const click = tool({
      description: 'Click the page.',
      inputSchema: jsonSchema({ type: 'object', properties: {} }),
      execute: vi.fn(async () => 'clicked'),
    })
    const screenshot = tool({
      description: 'Capture the current browser page.',
      inputSchema: jsonSchema({ type: 'object', properties: {} }),
      execute: vi.fn(async () => 'captured'),
    })
    const base: Parameters<typeof runSubagent>[0] = {
      cwd: '/repo',
      projectId: 'project',
      conversationId: 'conversation-browser-worker',
      parentMessageId: 'assistant',
      profile: {
        version: 1,
        agentName: 'browser-worker',
        effective: {
          providerId: 'anthropic-proxy',
          modelId: 'claude-opus-5',
          configuredEffort: 'max',
          sentEffort: 'max',
          source: 'parent',
          candidateIndex: 0,
        },
        attempts: [],
      },
      broker: {} as never,
      signal: new AbortController().signal,
      agentName: 'browser-worker',
      task: 'Drive the browser.',
      readOnly: false,
      definition: { name: 'browser-worker', description: 'worker', prompt: 'Drive.', source: 'project' },
    }
    const stream = () =>
      fullStream([
        { type: 'text-delta', text: 'done' },
        { type: 'finish-step', usage: { inputTokens: 1, outputTokens: 1 } },
        { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } },
      ]) as never

    // browser_click-only has no proven read-only contract, so it becomes a worker; internal clamping honors the host ToolSet.
    streamTextMock.mockReturnValueOnce(stream())
    await runSubagent({
      ...base,
      definition: {
        name: 'browser-worker',
        description: 'worker',
        prompt: 'Drive.',
        source: 'project',
        tools: ['browser_click'],
      },
      tools: { browser_click: click },
    })
    expect(streamTextMock.mock.calls.at(-1)?.[0].tools?.browser_click).toBeDefined()

    // browser_screenshot-only: contrato read-only provado → filho read-only, browser_click filtrado.
    streamTextMock.mockReturnValueOnce(stream())
    await runSubagent({
      ...base,
      definition: {
        name: 'screenshot-only',
        description: 'read only',
        prompt: 'Capture.',
        source: 'project',
        tools: ['browser_screenshot'],
      },
      tools: { browser_screenshot: screenshot, browser_click: click },
    })
    const childTools = streamTextMock.mock.calls.at(-1)?.[0].tools as Record<string, unknown>
    expect(childTools?.browser_screenshot).toBeDefined()
    expect(childTools?.browser_click).toBeUndefined()
  })
})
