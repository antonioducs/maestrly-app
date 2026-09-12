import { jsonSchema, tool, type ToolSet } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import { toolOutputImages } from '../../src/shared/chat'
import { buildClaudeToolBridge, CLAUDE_DISALLOWED_NATIVE_TOOLS } from '../../src/main/chat/claude-agent-sdk/tools'
import { chatToolOutputToAiSdkOutput, mcpResultToChatToolOutput } from '../../src/main/chat/tool-output'

function namedTool(description: string) {
  return tool({
    description,
    inputSchema: jsonSchema<{ path: string }>({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    }),
    execute: vi.fn(async ({ path }: { path: string }) => path),
  })
}

describe('Claude in-process MCP bridge', () => {
  it('qualifies Maestrly tools, aliases native names and blocks competing Claude mechanisms', async () => {
    const tools: ToolSet = {
      read: namedTool('Read through the Maestrly permission broker.'),
      task: namedTool('Run the Maestrly subagent scheduler.'),
      review_plan: namedTool('Stage a Maestrly plan.'),
      ask_question: namedTool('Ask through the Maestrly question broker.'),
      use_skill: namedTool('Load a Maestrly skill.'),
      external_search: namedTool('Deferred external MCP search.'),
    }

    const bridge = await buildClaudeToolBridge(tools, new AbortController().signal)

    expect(bridge.allowedTools).toEqual([
      'mcp__maestrly__ask_question',
      'mcp__maestrly__external_search',
      'mcp__maestrly__read',
      'mcp__maestrly__review_plan',
      'mcp__maestrly__task',
      'mcp__maestrly__use_skill',
    ])
    expect(bridge.toolAliases).toMatchObject({
      Agent: 'mcp__maestrly__task',
      Task: 'mcp__maestrly__task',
      AskUserQuestion: 'mcp__maestrly__ask_question',
      ExitPlanMode: 'mcp__maestrly__review_plan',
      Read: 'mcp__maestrly__read',
      Skill: 'mcp__maestrly__use_skill',
    })
    expect(bridge.nameFromSdk('mcp__maestrly__external_search')).toBe('external_search')
    expect(CLAUDE_DISALLOWED_NATIVE_TOOLS).toEqual(
      expect.arrayContaining([
        'Agent',
        'Task',
        'Skill',
        'TodoWrite',
        'AskUserQuestion',
        'ExitPlanMode',
        'Bash',
        'Read',
        'Write',
        'Edit',
      ])
    )
    await expect(
      bridge.preToolUseHook.hooks[0](
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'NotebookEdit',
          tool_input: {},
          tool_use_id: 'native-call',
        } as never,
        'native-call',
        { signal: new AbortController().signal }
      )
    ).resolves.toMatchObject({
      continue: false,
      stopReason: expect.stringContaining('rejected'),
    })
  })

  it('produces a deterministic signature that changes with schema, description or eager/deferred state', async () => {
    const first = await buildClaudeToolBridge(
      { read: namedTool('first description'), remote: namedTool('remote') },
      new AbortController().signal
    )
    const reordered = await buildClaudeToolBridge(
      { remote: namedTool('remote'), read: namedTool('first description') },
      new AbortController().signal
    )
    const changed = await buildClaudeToolBridge(
      { read: namedTool('changed description'), remote: namedTool('remote') },
      new AbortController().signal
    )
    const eagerChanged = await buildClaudeToolBridge(
      { read: namedTool('first description'), remote: namedTool('remote') },
      new AbortController().signal,
      new Set(['read', 'remote'])
    )

    expect(reordered.toolSignature).toBe(first.toolSignature)
    expect(changed.toolSignature).not.toBe(first.toolSignature)
    expect(eagerChanged.toolSignature).not.toBe(first.toolSignature)
  })

  it('loads the Maestro delegate tool eagerly by default', async () => {
    const eager = await buildClaudeToolBridge(
      { delegate: namedTool('Route semantic work through Maestro.') },
      new AbortController().signal
    )
    const deferred = await buildClaudeToolBridge(
      { delegate: namedTool('Route semantic work through Maestro.') },
      new AbortController().signal,
      new Set()
    )

    expect(eager.allowedTools).toEqual(['mcp__maestrly__delegate'])
    expect(eager.toolSignature).not.toBe(deferred.toolSignature)
  })

  it('keeps cold MCP discovery and dispatch deferred while core reads stay eager', async () => {
    const bridge = await buildClaudeToolBridge(
      {
        read: namedTool('Core read.'),
        mcp_search: namedTool('Discover external MCP tools lazily.'),
        mcp_call: namedTool('Call an external MCP tool lazily.'),
      },
      new AbortController().signal
    )
    const registered = (
      bridge.server.instance as unknown as {
        _registeredTools: Record<string, { _meta?: Record<string, unknown> }>
      }
    )._registeredTools

    expect(registered.read?._meta).toMatchObject({ 'anthropic/alwaysLoad': true })
    expect(registered.mcp_search?._meta).toBeUndefined()
    expect(registered.mcp_call?._meta).toBeUndefined()
    expect(bridge.allowedTools).toEqual(['mcp__maestrly__mcp_call', 'mcp__maestrly__mcp_search', 'mcp__maestrly__read'])
  })

  it('correlates the streamed Claude tool-use id with the Maestrly broker execution', async () => {
    const execute = vi.fn(async () => 'ok')
    const bridge = await buildClaudeToolBridge(
      {
        ask_question: tool({
          description: 'Ask the user.',
          inputSchema: jsonSchema<{ question: string }>({
            type: 'object',
            properties: { question: { type: 'string' } },
            required: ['question'],
          }),
          execute,
        }),
      },
      new AbortController().signal
    )
    const registered = (
      bridge.server.instance as unknown as {
        _registeredTools: Record<string, { handler: (input: unknown, extra: unknown) => Promise<unknown> }>
      }
    )._registeredTools.ask_question

    const hook = bridge.preToolUseHook.hooks[0]
    await hook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: { question: 'Proceed?' },
        tool_use_id: 'claude-tool-use-42',
      } as never,
      'claude-tool-use-42',
      { signal: new AbortController().signal }
    )
    const pending = registered.handler({ question: 'Proceed?' }, {})
    await pending

    expect(execute).toHaveBeenCalledWith(
      { question: 'Proceed?' },
      expect.objectContaining({ toolCallId: 'claude-tool-use-42' })
    )
  })

  it('executes the host-managed generate_image bridge with the verified child tool id', async () => {
    const execute = vi.fn(async ({ prompt }: { prompt: string }) => `generated: ${prompt}`)
    const bridge = await buildClaudeToolBridge(
      {
        generate_image: tool({
          description: 'Generate an image.',
          inputSchema: jsonSchema<{ prompt: string }>({
            type: 'object',
            properties: { prompt: { type: 'string' } },
            required: ['prompt'],
          }),
          execute,
        }),
      },
      new AbortController().signal
    )
    const registered = (
      bridge.server.instance as unknown as {
        _registeredTools: Record<string, { handler: (input: unknown, extra: unknown) => Promise<unknown> }>
      }
    )._registeredTools.generate_image
    await bridge.preToolUseHook.hooks[0](
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__maestrly__generate_image',
        tool_input: { prompt: 'a teal robot' },
        tool_use_id: 'child-image-call',
      } as never,
      'child-image-call',
      { signal: new AbortController().signal }
    )
    await registered.handler({ prompt: 'a teal robot' }, {})
    expect(execute).toHaveBeenCalledWith(
      { prompt: 'a teal robot' },
      expect.objectContaining({ toolCallId: 'child-image-call' })
    )
  })

  it('keeps canonical image refs while Claude receives only the non-vision projection', async () => {
    for (const supportsImages of [false, true]) {
      const rawOutput = mcpResultToChatToolOutput({
        content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
      })
      if (typeof rawOutput === 'string' || !rawOutput.images?.[0]) throw new Error('expected image output')
      const canonicalOutput = {
        ...rawOutput,
        images: rawOutput.images.map((image) => ({ ...image, description: 'A small screenshot.' })),
      }
      const bridge = await buildClaudeToolBridge(
        {
          screenshot: tool({
            description: 'Capture a screenshot.',
            inputSchema: jsonSchema({ type: 'object', properties: {} }),
            execute: async () => canonicalOutput,
            toModelOutput: ({ output }) => chatToolOutputToAiSdkOutput(output, { dropImages: !supportsImages }),
          }),
        },
        new AbortController().signal
      )
      const registered = (
        bridge.server.instance as unknown as {
          _registeredTools: Record<string, { handler: (input: unknown, extra: unknown) => Promise<unknown> }>
        }
      )._registeredTools.screenshot
      const toolCallId = `claude-image-${supportsImages ? 'vision' : 'text'}`
      await bridge.preToolUseHook.hooks[0](
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'mcp__maestrly__screenshot',
          tool_input: {},
          tool_use_id: toolCallId,
        } as never,
        toolCallId,
        { signal: new AbortController().signal }
      )

      const providerResult = (await registered.handler({}, {})) as {
        content: Array<{ type: string; text?: string; data?: string }>
      }
      const canonical = bridge.takeToolOutput(toolCallId)
      expect(toolOutputImages(canonical)).toHaveLength(1)
      expect(canonical).toMatchObject({ images: [{ description: 'A small screenshot.' }] })
      if (supportsImages) {
        expect(providerResult.content).toEqual(
          expect.arrayContaining([{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }])
        )
      } else {
        expect(providerResult.content.some((entry) => entry.type === 'image')).toBe(false)
        expect(JSON.stringify(providerResult)).not.toContain('aGVsbG8=')
        expect(JSON.stringify(providerResult)).toContain('A small screenshot.')
      }
    }
  })

  it('keeps a multimodal tool failure as an MCP error in vision and non-vision projections', async () => {
    for (const supportsImages of [false, true]) {
      const rawOutput = mcpResultToChatToolOutput({
        content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
      })
      if (typeof rawOutput === 'string' || !rawOutput.images?.[0]) throw new Error('expected image output')
      const canonicalOutput = {
        ...rawOutput,
        text: 'Screenshot failed.',
        images: rawOutput.images.map((image) => ({ ...image, description: 'A small screenshot.' })),
        isError: true,
      }
      const bridge = await buildClaudeToolBridge(
        {
          screenshot: tool({
            description: 'Capture a screenshot.',
            inputSchema: jsonSchema({ type: 'object', properties: {} }),
            execute: async () => canonicalOutput,
            toModelOutput: ({ output }) => chatToolOutputToAiSdkOutput(output, { dropImages: !supportsImages }),
          }),
        },
        new AbortController().signal
      )
      const registered = (
        bridge.server.instance as unknown as {
          _registeredTools: Record<string, { handler: (input: unknown, extra: unknown) => Promise<unknown> }>
        }
      )._registeredTools.screenshot
      const toolCallId = `claude-error-image-${supportsImages ? 'vision' : 'text'}`
      await bridge.preToolUseHook.hooks[0](
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'mcp__maestrly__screenshot',
          tool_input: {},
          tool_use_id: toolCallId,
        } as never,
        toolCallId,
        { signal: new AbortController().signal }
      )

      const providerResult = (await registered.handler({}, {})) as {
        content: Array<{ type: string; text?: string; data?: string }>
        isError?: boolean
      }
      const canonical = bridge.takeToolOutput(toolCallId)
      expect(providerResult.isError).toBe(true)
      expect(canonical).toMatchObject({ isError: true, images: [{ description: 'A small screenshot.' }] })
      if (supportsImages) {
        expect(providerResult.content).toEqual(
          expect.arrayContaining([{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }])
        )
      } else {
        expect(providerResult.content.some((entry) => entry.type === 'image')).toBe(false)
        expect(JSON.stringify(providerResult)).not.toContain('aGVsbG8=')
        expect(JSON.stringify(providerResult)).toContain('A small screenshot.')
      }
    }
  })

  it('fails closed when an MCP execution cannot be correlated to a verified Claude tool id', async () => {
    const controller = new AbortController()
    const execute = vi.fn(async () => 'should not run')
    const bridge = await buildClaudeToolBridge(
      {
        read: tool({
          description: 'Read.',
          inputSchema: jsonSchema<{ path: string }>({
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          }),
          execute,
        }),
      },
      controller.signal
    )
    const registered = (
      bridge.server.instance as unknown as {
        _registeredTools: Record<string, { handler: (input: unknown, extra: unknown) => Promise<unknown> }>
      }
    )._registeredTools.read

    const pending = registered.handler({ path: '/repo/file.ts' }, { toolCallId: 'unverified-forged-id' })
    controller.abort(new Error('turn cancelled'))

    await expect(pending).rejects.toThrow('turn cancelled')
    expect(execute).not.toHaveBeenCalled()
  })

  it('correlates parallel calls of the same tool by canonical input instead of FIFO name order', async () => {
    const execute = vi.fn(async ({ path }: { path: string }) => path)
    const bridge = await buildClaudeToolBridge(
      {
        read: tool({
          description: 'Read.',
          inputSchema: jsonSchema<{ path: string }>({
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          }),
          execute,
        }),
      },
      new AbortController().signal
    )
    const hook = bridge.preToolUseHook.hooks[0]
    const hookSignal = new AbortController().signal
    await hook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__maestrly__read',
        tool_input: { path: '/first' },
        tool_use_id: 'tool-first',
      } as never,
      'tool-first',
      { signal: hookSignal }
    )
    await hook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__maestrly__read',
        tool_input: { path: '/second' },
        tool_use_id: 'tool-second',
      } as never,
      'tool-second',
      { signal: hookSignal }
    )
    const registered = (
      bridge.server.instance as unknown as {
        _registeredTools: Record<string, { handler: (input: unknown, extra: unknown) => Promise<unknown> }>
      }
    )._registeredTools.read

    await registered.handler({ path: '/second' }, {})
    await registered.handler({ path: '/first' }, {})

    expect(execute).toHaveBeenNthCalledWith(
      1,
      { path: '/second' },
      expect.objectContaining({ toolCallId: 'tool-second' })
    )
    expect(execute).toHaveBeenNthCalledWith(
      2,
      { path: '/first' },
      expect.objectContaining({ toolCallId: 'tool-first' })
    )
  })
})

describe('journaled Claude bridge', () => {
  async function setup(execute: (...args: any[]) => Promise<any>, toModelOutput?: any) {
    const { createClaudeToolJournal } = await import('../../src/main/chat/claude-agent-sdk/tool-journal')
    const host = new AbortController()
    const journal = createClaudeToolJournal({ attemptId: 'attempt' })
    const bridge = await buildClaudeToolBridge(
      {
        write: tool({
          inputSchema: jsonSchema({ type: 'object', properties: {} }),
          execute,
          toModelOutput,
        }),
      },
      host.signal,
      undefined,
      undefined,
      journal
    )
    const handler = (bridge.server.instance as any)._registeredTools.write.handler
    const hook = (id: string, input = {}) =>
      bridge.preToolUseHook.hooks[0](
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'mcp__maestrly__write',
          tool_input: input,
          tool_use_id: id,
        } as never,
        id,
        { signal: host.signal }
      )
    return { host, journal, bridge, handler, hook }
  }

  it('retains canonical images before SDK projection fails and retries without repeating the effect', async () => {
    const output = mcpResultToChatToolOutput({ content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }] })
    const execute = vi.fn(async () => output)
    const state = await setup(execute, () => {
      expect(state.journal.snapshot()[0].state).toBe('completed')
      throw new Error('SDK projection failed')
    })
    await state.hook('image')
    await expect(state.handler({}, {})).rejects.toThrow('SDK projection failed')
    expect(toolOutputImages(state.journal.snapshot()[0].output)).toHaveLength(1)
    await state.hook('image')
    await expect(state.handler({}, {})).rejects.toThrow('SDK projection failed')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('preserves distinct IDs with equal input and rejects conflicting verified input', async () => {
    const execute = vi.fn(async (_input: unknown, _options: { toolCallId: string }) => 'done')
    const { hook, handler } = await setup(execute)
    await hook('one')
    await hook('one')
    await hook('two')
    await Promise.all([handler({}, {}), handler({}, {})])
    expect(execute.mock.calls.map((call) => call[1].toolCallId)).toEqual(['one', 'two'])
    await expect(hook('one', { changed: true })).rejects.toThrow('Conflicting')
  })

  it('accepts callbacks before their verified hooks, including same-ID retries', async () => {
    const execute = vi.fn(async () => 'done')
    const { hook, handler } = await setup(execute)
    const first = handler({}, {})
    await Promise.resolve()
    await hook('late')
    await first
    const retry = handler({}, {})
    await Promise.resolve()
    await hook('late')
    await expect(retry).resolves.toBeDefined()
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('ignores SDK disconnect while preserving explicit host cancellation', async () => {
    let executionSignal!: AbortSignal
    let finish!: () => void
    const { host, hook, handler, journal } = await setup(async (_input, options) => {
      executionSignal = options.abortSignal
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return 'effect done'
    })
    await hook('one')
    const sdk = new AbortController()
    sdk.abort()
    const pending = handler({}, { signal: sdk.signal })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    expect(executionSignal.aborted).toBe(false)
    host.abort()
    expect(executionSignal.aborted).toBe(true)
    finish()
    await pending
    expect(journal.snapshot()[0].output).toBe('effect done')
  })
})
