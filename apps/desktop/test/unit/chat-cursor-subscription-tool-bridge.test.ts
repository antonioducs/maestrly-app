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

  describe('snake_case argument names from Cursor models', () => {
    const buildEdit = async (execute = vi.fn(async (_args: Record<string, unknown>) => 'edited')) => {
      const bridge = await buildCursorToolBridge({
        tools: {
          edit: tool({
            description: 'Edit a file.',
            inputSchema: z.object({
              path: z.string(),
              oldString: z.string(),
              newString: z.string(),
              replaceAll: z.boolean().optional(),
            }),
            execute,
          }),
        },
        signal: new AbortController().signal,
      })
      return { bridge, execute }
    }

    it('renames snake_case keys that the schema declares in camelCase and runs the tool', async () => {
      const { bridge, execute } = await buildEdit()
      const result = await bridge.customTools.edit!.execute(
        { path: 'notes.txt', old_string: 'alpha\nbeta', new_string: 'alpha\nbeta\ngamma', replace_all: true },
        { toolCallId: 'snake-1' }
      )
      expect(result).toMatchObject({ content: [{ type: 'text', text: 'edited' }] })
      expect(result).not.toHaveProperty('isError')
      expect(execute).toHaveBeenCalledTimes(1)
      expect(execute.mock.calls[0]?.[0]).toEqual({
        path: 'notes.txt',
        oldString: 'alpha\nbeta',
        newString: 'alpha\nbeta\ngamma',
        replaceAll: true,
      })
    })

    it('leaves camelCase arguments untouched', async () => {
      const { bridge, execute } = await buildEdit()
      await bridge.customTools.edit!.execute(
        { path: 'notes.txt', oldString: 'a', newString: 'b' },
        { toolCallId: 'camel-1' }
      )
      expect(execute.mock.calls[0]?.[0]).toEqual({ path: 'notes.txt', oldString: 'a', newString: 'b' })
    })

    it('never overwrites a camelCase argument that already arrived', async () => {
      const { bridge, execute } = await buildEdit()
      await bridge.customTools.edit!.execute(
        { path: 'notes.txt', oldString: 'kept', old_string: 'ignored', new_string: 'b' },
        { toolCallId: 'both-1' }
      )
      expect(execute.mock.calls[0]?.[0]).toEqual({ path: 'notes.txt', oldString: 'kept', newString: 'b' })
    })

    it('still refuses unknown keys and missing arguments', async () => {
      const execute = vi.fn(async () => 'ok')
      const bridge = await buildCursorToolBridge({
        tools: {
          strict: tool({
            description: 'Strict tool.',
            inputSchema: z.object({ filePath: z.string() }).strict(),
            execute,
          }),
        },
        signal: new AbortController().signal,
      })

      // `other_key` has no camelCase counterpart in the schema, so it stays and the strict schema rejects it.
      const unknownKey = await bridge.customTools.strict!.execute(
        { file_path: 'a.txt', other_key: 'x' },
        { toolCallId: 'unknown-1' }
      )
      expect(unknownKey).toMatchObject({ isError: true })

      const missing = await bridge.customTools.strict!.execute({ other_key: 'x' }, { toolCallId: 'missing-1' })
      expect(missing).toMatchObject({ isError: true })
      expect(execute).not.toHaveBeenCalled()
    })

    it('only renames top-level keys', async () => {
      const execute = vi.fn(async (_args: Record<string, unknown>) => 'ok')
      const bridge = await buildCursorToolBridge({
        tools: {
          nested: tool({
            description: 'Nested tool.',
            inputSchema: jsonSchema<Record<string, unknown>>({
              type: 'object',
              properties: { filePath: { type: 'string' }, options: { type: 'object', additionalProperties: true } },
            }),
            execute,
          }),
        },
        signal: new AbortController().signal,
      })
      await bridge.customTools.nested!.execute(
        { file_path: 'a.txt', options: { filePath: 'x', inner_key: 'y' } },
        { toolCallId: 'nested-1' }
      )
      expect(execute.mock.calls[0]?.[0]).toEqual({ filePath: 'a.txt', options: { filePath: 'x', inner_key: 'y' } })
    })
  })

  it('records a refused call as a canonical error so the card can close as failed', async () => {
    const bridge = await buildCursorToolBridge({
      tools: {
        greet: tool({
          description: 'greets',
          inputSchema: z.object({ name: z.string().min(1) }),
          execute: async ({ name }) => `hello ${name}`,
        }),
      },
      signal: new AbortController().signal,
    })
    const invalid = await bridge.customTools.greet!.execute({ name: '' }, { toolCallId: 'refused-1' })
    expect(invalid).toMatchObject({ isError: true })
    expect(bridge.takeToolOutput('refused-1')).toMatchObject({
      isError: true,
      text: expect.stringContaining('Invalid arguments for "greet"'),
    })
    expect(bridge.takeToolOutput('refused-1')).toBeUndefined()
  })

  describe('a tool that throws while it runs', () => {
    const original = 'oldString not found. It must match the target block uniquely; read the file again.'
    const buildEdit = async (execute: () => Promise<unknown>, signal = new AbortController().signal) =>
      buildCursorToolBridge({
        tools: {
          edit: tool({
            description: 'Edit a file.',
            inputSchema: z.object({ path: z.string(), oldString: z.string(), newString: z.string() }),
            execute: execute as never,
          }),
        },
        signal,
      })
    const args = { path: 'notes.txt', oldString: 'zzz-nao-existe', newString: 'x' }

    it('records the original message as a canonical error and rethrows the error unchanged', async () => {
      const failure = new Error(original)
      const bridge = await buildEdit(async () => {
        throw failure
      })
      await expect(bridge.customTools.edit!.execute(args, { toolCallId: 'throw-1' })).rejects.toBe(failure)
      expect(bridge.takeToolOutput('throw-1')).toEqual({ text: original, isError: true })
      expect(bridge.takeToolOutput('throw-1')).toBeUndefined()
    })

    it('records the failure under the call that threw only', async () => {
      const bridge = await buildEdit(async () => {
        throw new Error(original)
      })
      await expect(bridge.customTools.edit!.execute(args, { toolCallId: 'throw-2' })).rejects.toThrow(original)
      expect(bridge.takeToolOutput('throw-3')).toBeUndefined()
      expect(bridge.takeToolOutput('throw-2')).toMatchObject({ isError: true })
    })

    it('records a fallback message for a thrown value without one', async () => {
      for (const thrown of [new Error('  '), '', undefined, { code: 1 }]) {
        const bridge = await buildEdit(async () => {
          throw thrown
        })
        await expect(bridge.customTools.edit!.execute(args, { toolCallId: 'throw-4' })).rejects.toBe(thrown)
        expect(bridge.takeToolOutput('throw-4')).toEqual({ text: 'Tool failed', isError: true })
      }
    })

    it('keeps the text of a thrown string', async () => {
      const bridge = await buildEdit(async () => {
        throw 'disk full'
      })
      await expect(bridge.customTools.edit!.execute(args, { toolCallId: 'throw-5' })).rejects.toBe('disk full')
      expect(bridge.takeToolOutput('throw-5')).toEqual({ text: 'disk full', isError: true })
    })

    it('rethrows an abort without recording a failure', async () => {
      const abort = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
      const bridge = await buildEdit(async () => {
        throw abort
      })
      await expect(bridge.customTools.edit!.execute(args, { toolCallId: 'abort-1' })).rejects.toBe(abort)
      expect(bridge.takeToolOutput('abort-1')).toBeUndefined()
    })

    it('rethrows without recording a failure once the run was cancelled', async () => {
      const controller = new AbortController()
      const failure = new Error('connection reset')
      const bridge = await buildEdit(async () => {
        controller.abort()
        throw failure
      }, controller.signal)
      await expect(bridge.customTools.edit!.execute(args, { toolCallId: 'abort-2' })).rejects.toBe(failure)
      expect(bridge.takeToolOutput('abort-2')).toBeUndefined()
    })

    it('records nothing for a call cancelled before it started', async () => {
      const controller = new AbortController()
      controller.abort()
      const execute = vi.fn(async () => 'edited')
      const bridge = await buildEdit(execute, controller.signal)
      await expect(bridge.customTools.edit!.execute(args, { toolCallId: 'abort-3' })).rejects.toThrow()
      expect(execute).not.toHaveBeenCalled()
      expect(bridge.takeToolOutput('abort-3')).toBeUndefined()
    })

    it('keeps a successful call free of a failure record', async () => {
      const bridge = await buildEdit(async () => 'edited')
      const result = await bridge.customTools.edit!.execute(args, { toolCallId: 'ok-1' })
      expect(result).toMatchObject({ content: [{ type: 'text', text: 'edited' }] })
      expect(result).not.toHaveProperty('isError')
      expect(bridge.takeToolOutput('ok-1')).toBe('edited')
    })
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
