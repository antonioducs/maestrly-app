import { describe, expect, it, vi } from 'vitest'
import { jsonSchema, tool } from 'ai'
import { z } from 'zod'
import { buildCursorToolBridge, cursorNameFromSdk } from '../../src/main/chat/cursor-subscription/tool-bridge'
import { chatToolOutputToAiSdkOutput, mcpResultToChatToolOutput } from '../../src/main/chat/tool-output'
import { toolOutputImages } from '../../src/shared/chat'
import type { ToolContext } from '../../src/main/chat/tools/util'

function makeContext(askImpl?: (action: string) => Promise<void> | void) {
  return (toolCallId: string, signal: AbortSignal): ToolContext =>
    ({
      conversationId: 'conv-1',
      projectId: 'ws-1',
      messageId: 'msg-1',
      toolCallId,
      cwd: '/tmp',
      signal,
      ask: vi.fn(async (action) => {
        await askImpl?.(String(action))
      }),
      askQuestion: vi.fn(async () => [['yes']]),
      submitPlan: vi.fn(),
    }) as unknown as ToolContext
}

describe('Cursor tool bridge (Scenario D surface)', () => {
  it('publishes cold MCP discovery and dispatch as local custom tools without provider-specific transport', async () => {
    const bridge = await buildCursorToolBridge({
      tools: {
        mcp_search: tool({
          description: 'Discover external MCP tools lazily.',
          inputSchema: z.object({ server: z.string() }),
          execute: async () => '[]',
        }),
        mcp_call: tool({
          description: 'Call an external MCP tool lazily.',
          inputSchema: jsonSchema({
            type: 'object',
            properties: {
              server: { type: 'string' },
              tool: { type: 'string' },
              arguments: { type: 'object', additionalProperties: true },
            },
            required: ['server', 'tool'],
          }),
          execute: async () => 'ok',
        }),
      },
      signal: new AbortController().signal,
    })

    expect(Object.keys(bridge.customTools).sort()).toEqual(['mcp_call', 'mcp_search'])
    expect(bridge.customTools.mcp_search?.inputSchema).toMatchObject({
      type: 'object',
      required: ['server'],
    })
  })

  it('converts host tools to SDK tools with JSON schemas and Zod validation', async () => {
    const tools = {
      greet: tool({
        description: 'greets',
        inputSchema: z.object({ name: z.string().min(1) }),
        execute: async ({ name }) => `hello ${name}`,
      }),
    }
    const bridge = await buildCursorToolBridge({ tools, signal: new AbortController().signal })
    expect(Object.keys(bridge.customTools)).toEqual(['greet'])
    expect(bridge.customTools.greet?.description).toBe('greets')
    const schema = bridge.customTools.greet?.inputSchema as Record<string, unknown>
    expect(schema.type).toBe('object')
    expect((schema.properties as Record<string, unknown>).name).toMatchObject({ type: 'string' })

    const ok = await bridge.customTools.greet!.execute({ name: 'maestrly' }, { toolCallId: 't1' })
    expect(ok).toMatchObject({ content: [{ type: 'text', text: 'hello maestrly' }] })

    const invalid = await bridge.customTools.greet!.execute({ name: '' }, { toolCallId: 't2' })
    expect(invalid).toMatchObject({ isError: true })
  })

  it('executes the host image generation tool through the bridge', async () => {
    const execute = vi.fn(async ({ prompt }: { prompt: string }) => `generated: ${prompt}`)
    const bridge = await buildCursorToolBridge({
      tools: {
        generate_image: tool({
          description: 'Generate an image.',
          inputSchema: z.object({ prompt: z.string() }),
          execute,
        }),
      },
      signal: new AbortController().signal,
    })

    await expect(
      bridge.customTools.generate_image!.execute({ prompt: 'a teal robot' }, { toolCallId: 'child-image-call' })
    ).resolves.toMatchObject({ content: [{ type: 'text', text: 'generated: a teal robot' }] })
    expect(execute).toHaveBeenCalledWith(
      { prompt: 'a teal robot' },
      expect.objectContaining({ toolCallId: 'child-image-call' })
    )
  })

  it('preserves multimodal failures with and without vision support', async () => {
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
      const bridge = await buildCursorToolBridge({
        tools: {
          screenshot: tool({
            description: 'Capture a screenshot.',
            inputSchema: z.object({}),
            execute: async () => canonicalOutput,
            toModelOutput: ({ output }) => chatToolOutputToAiSdkOutput(output, { dropImages: !supportsImages }),
          }),
        },
        signal: new AbortController().signal,
      })
      const toolCallId = `cursor-error-image-${supportsImages ? 'vision' : 'text'}`
      const providerResult = await bridge.customTools.screenshot!.execute({}, { toolCallId })
      expect(providerResult).toMatchObject({ isError: true })
      const canonical = bridge.takeToolOutput(toolCallId)
      expect(canonical).toMatchObject({
        isError: true,
        images: [{ description: 'A small screenshot.' }],
      })
      expect(toolOutputImages(canonical)).toHaveLength(1)
      expect(JSON.stringify(providerResult)).not.toContain('__maestrlyToolOutput')
      if (supportsImages) {
        expect(providerResult).toMatchObject({
          content: expect.arrayContaining([{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }]),
        })
      } else {
        expect(
          (providerResult as { content: Array<{ type: string }> }).content.some((entry) => entry.type === 'image')
        ).toBe(false)
        expect(JSON.stringify(providerResult)).not.toContain('aGVsbG8=')
        expect(JSON.stringify(providerResult)).toContain('A small screenshot.')
      }
    }
  })

  it('publishes the inner JSON schema rather than its wrapper', async () => {
    const internalSchema = {
      type: 'object',
      properties: { resource: { type: 'string' } },
      required: ['resource'],
      additionalProperties: false,
    } as const
    const tools = {
      mcpish: tool({
        description: 'MCP-like',
        inputSchema: jsonSchema<{ resource: string }>(internalSchema),
        execute: async ({ resource }) => resource,
      }),
    }
    const bridge = await buildCursorToolBridge({ tools, signal: new AbortController().signal })

    expect(bridge.customTools.mcpish?.inputSchema).toEqual(internalSchema)

    const published = bridge.customTools.mcpish?.inputSchema as Record<string, unknown>
    expect(published.safeParse).toBeUndefined()
    expect(published.validate).toBeUndefined()
  })

  it('executes MCP and app tools with validated and transformed arguments', async () => {
    const seen: unknown[] = []
    const tools = {
      appish: tool({
        description: 'app tool',
        inputSchema: z.object({ name: z.string().min(1) }).transform((value) => ({ name: value.name.toUpperCase() })),
        execute: async (args) => {
          seen.push(args)
          return 'ok'
        },
      }),
    }
    const bridge = await buildCursorToolBridge({ tools, signal: new AbortController().signal })
    const result = await bridge.customTools.appish!.execute({ name: 'maestrly' }, { toolCallId: 't1' })
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'ok' }] })

    expect(seen).toEqual([{ name: 'MAESTRLY' }])

    const invalid = await bridge.customTools.appish!.execute({ name: '' }, { toolCallId: 't2' })
    expect(invalid).toMatchObject({ isError: true })
    expect(seen).toHaveLength(1)
  })

  it('keeps signatures stable across volatile descriptions and schemas', async () => {
    const signal = new AbortController().signal
    const build = (description: string, schema: z.ZodType) =>
      buildCursorToolBridge({
        tools: {
          x: tool({ description, inputSchema: schema, execute: async () => 'x' }),
        },
        signal,
      })
    const a = await build('d1', z.object({ a: z.string() }))
    const b = await build('d1', z.object({ a: z.string() }))
    const c = await build('d2', z.object({ a: z.string().describe('outra doc') }))

    expect(a.toolSignature).toBe(b.toolSignature)
    expect(a.toolSignature).toBe(c.toolSignature)

    const d = await buildCursorToolBridge({
      tools: {
        x: tool({ description: 'd1', inputSchema: z.object({ a: z.string() }), execute: async () => 'x' }),
        y: tool({ description: 'd1', inputSchema: z.object({}), execute: async () => 'y' }),
      },
      signal,
    })
    expect(d.toolSignature).not.toBe(a.toolSignature)

    const e = await buildCursorToolBridge({
      tools: {
        y: tool({ description: 'd1', inputSchema: z.object({}), execute: async () => 'y' }),
        x: tool({ description: 'd1', inputSchema: z.object({ a: z.string() }), execute: async () => 'x' }),
      },
      signal,
    })
    expect(e.toolSignature).toBe(d.toolSignature)
  })

  it('routes mutations through permission checks and rejects denied execution', async () => {
    const ask = vi.fn(async (action: string) => {
      if (action === 'write') throw new Error('denied by user')
    })
    const ctxFactory = makeContext(ask)
    let executed = false

    const withAsk = (action: string, body: () => Promise<unknown>) =>
      tool({
        description: action,
        inputSchema: z.object({ resource: z.string() }),
        execute: async (args, options) => {
          const ctx = ctxFactory(options.toolCallId, options.abortSignal ?? new AbortController().signal)
          await ctx.ask(action as never, [args.resource])
          return body()
        },
      })
    const tools = {
      bash: withAsk('bash', async () => 'ran'),
      write: withAsk('write', async () => {
        executed = true
        return 'written'
      }),
    }
    const bridge = await buildCursorToolBridge({ tools, signal: new AbortController().signal })

    await bridge.customTools.bash!.execute({ resource: 'ls' }, { toolCallId: 't1' })
    expect(ask).toHaveBeenCalledWith('bash')

    await expect(bridge.customTools.write!.execute({ resource: 'x' }, { toolCallId: 't2' })).rejects.toThrow(
      'denied by user'
    )
    expect(executed).toBe(false)
  })

  it('routes questions and plan submission through host context', async () => {
    const ctx = makeContext()
    const tools = {
      ask_question: tool({
        description: 'ask',
        inputSchema: z.object({ question: z.string() }),
        execute: async (_args, options) => {
          const context = ctx(options.toolCallId, options.abortSignal ?? new AbortController().signal)
          const answer = await context.askQuestion([{ header: 'h', question: 'q?', options: [] }])
          return JSON.stringify(answer)
        },
      }),
      review_plan: tool({
        description: 'plan',
        inputSchema: z.object({ plan: z.string() }),
        execute: async (args, options) => {
          const context = ctx(options.toolCallId, options.abortSignal ?? new AbortController().signal)
          context.submitPlan?.(args.plan, 'title')
          return 'submitted'
        },
      }),
    }
    const bridge = await buildCursorToolBridge({ tools, signal: new AbortController().signal })
    const answer = await bridge.customTools.ask_question!.execute({ question: 'x' }, { toolCallId: 't1' })
    expect(answer).toMatchObject({ content: [{ type: 'text', text: '[["yes"]]' }] })
    await bridge.customTools.review_plan!.execute({ plan: 'do x' }, { toolCallId: 't2' })
    expect((ctx as unknown as { calls: unknown }).calls).toBeUndefined()
  })

  it('normalizes known MCP names while preserving unknown names', async () => {
    const bridge = await buildCursorToolBridge({
      tools: {
        bash: tool({ description: 'b', inputSchema: z.object({}), execute: async () => 'x' }),
      },
      signal: new AbortController().signal,
    })
    expect(bridge.nameFromSdk('bash')).toBe('bash')
    expect(bridge.nameFromSdk('mcp__custom-user-tools__bash')).toBe('bash')
    expect(bridge.nameFromSdk('custom-user-tools_bash')).toBe('bash')
    expect(bridge.nameFromSdk('mcp__bash')).toBe('bash')
    expect(bridge.nameFromSdk('mcp__custom-user-tools_bash')).toBe('bash')
    expect(bridge.nameFromSdk('mcp__custom_user_tools__bash')).toBe('bash')
    expect(bridge.nameFromSdk('mcp__account-scoped-server__bash')).toBe('bash')
    expect(bridge.nameFromSdk('whatever')).toBe('whatever')
    expect(cursorNameFromSdk('mcp__custom-user-tools__read', new Set(['read']))).toBe('read')
    expect(cursorNameFromSdk('mcp__server__file_read', new Set(['file_read']))).toBe('file_read')
    expect(cursorNameFromSdk('mcp__server__file_read', new Set(['read', 'file_read']))).toBe('mcp__server__file_read')
  })
})
