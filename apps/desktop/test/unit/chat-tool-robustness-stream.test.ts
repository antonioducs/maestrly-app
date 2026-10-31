import { jsonSchema, stepCountIs, streamText, tool, type ModelMessage, type ToolSet } from 'ai'
import { asSchema } from '@ai-sdk/provider-utils'
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test'
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { hardenToolSetForModel } from '../../src/main/chat/tool-robustness'
import { createToolCallRepair, type ToolCallRepairEvent } from '../../src/main/chat/tool-robustness/repair-tool-call'
import { editDistance, resolveToolName } from '../../src/main/chat/tool-robustness/tool-name-repair'
import { optimizeOpenAITools } from '../../src/main/chat/openai/tools'
import { copilotTools } from '../../src/main/chat/github-copilot/tools'
import { toolSetRuntimes } from '../../src/main/chat/codex-subscription/runner'
import {
  closeAntigravityHostMcpServer,
  registerAntigravityHostToolset,
} from '../../src/main/chat/antigravity-subscription/host-mcp'

const AVAILABLE = ['read', 'write', 'edit', 'bash', 'grep', 'glob', 'todo_write', 'webfetch', 'web_search', 'task']

describe('resolveToolName', () => {
  it('repairs names deterministically', () => {
    expect(resolveToolName('read', AVAILABLE)).toEqual({ kind: 'exact', name: 'read' })
    expect(resolveToolName('functions.read:0', AVAILABLE)).toMatchObject({ kind: 'repaired', name: 'read' })
    expect(resolveToolName('default_api.grep', AVAILABLE)).toMatchObject({ kind: 'repaired', name: 'grep' })
    expect(resolveToolName('mcp__maestrly__bash', AVAILABLE)).toMatchObject({ kind: 'repaired', name: 'bash' })
    expect(resolveToolName('read" path="a.ts"', AVAILABLE)).toMatchObject({ kind: 'repaired', name: 'read' })
    expect(resolveToolName('Read', AVAILABLE)).toMatchObject({ kind: 'repaired', name: 'read', rule: 'case' })
    expect(resolveToolName('TodoWrite', AVAILABLE)).toMatchObject({ kind: 'repaired', name: 'todo_write' })
    expect(resolveToolName('WebFetch', AVAILABLE)).toMatchObject({ kind: 'repaired', name: 'webfetch' })
    expect(resolveToolName('read_file', AVAILABLE)).toMatchObject({ kind: 'repaired', name: 'read', rule: 'alias' })
    expect(resolveToolName('run_terminal_cmd', AVAILABLE)).toMatchObject({ kind: 'repaired', name: 'bash' })
  })

  it('only suggests a near miss and never maps an alias onto a missing tool', () => {
    expect(resolveToolName('reed', AVAILABLE)).toEqual({ kind: 'unknown', suggestions: ['read'] })
    expect(resolveToolName('read_file', ['write'])).toMatchObject({ kind: 'unknown' })
    expect(resolveToolName('deploy_production', AVAILABLE)).toEqual({ kind: 'unknown', suggestions: [] })
  })

  it('refuses a name that matches several tools', () => {
    expect(resolveToolName('READ', ['read', 'Read'])).toEqual({ kind: 'ambiguous', candidates: ['Read', 'read'] })
  })

  it('measures adjacent transpositions as one edit', () => {
    expect(editDistance('raed', 'read')).toBe(1)
    expect(editDistance('read', 'read')).toBe(0)
    expect(editDistance('grep', 'glob')).toBe(3)
  })
})

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}

function toolStep(calls: Array<{ id: string; name: string; input: string }>): LanguageModelV4StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    ...calls.map(
      (call): LanguageModelV4StreamPart => ({
        type: 'tool-call',
        toolCallId: call.id,
        toolName: call.name,
        input: call.input,
      })
    ),
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
  ]
}

const textStep: LanguageModelV4StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: 'done' },
  { type: 'text-end', id: 't' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
]

function makeTools() {
  const read = vi.fn(async (input: unknown) => `read ${JSON.stringify(input)}`)
  const write = vi.fn(async (input: unknown) => `wrote ${JSON.stringify(input)}`)
  const edit = vi.fn(async (input: unknown) => `edited ${JSON.stringify(input)}`)
  const raw: ToolSet = {
    read: tool({
      description: 'Read a file',
      inputSchema: z.object({
        path: z.string(),
        limit: z.number().int().positive().optional(),
        tags: z.array(z.string()).optional(),
      }),
      execute: read,
    }),
    write: tool({
      description: 'Write a file',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: write,
    }),
    edit: tool({
      description: 'Edit a file',
      inputSchema: z.object({ path: z.string(), oldString: z.string(), newString: z.string() }),
      execute: edit,
    }),
  }
  return { raw, tools: hardenToolSetForModel(raw), read, write, edit }
}

async function run(tools: ToolSet, calls: Array<{ id: string; name: string; input: string }>) {
  const model = new MockLanguageModelV4({
    doStream: [
      { stream: convertArrayToReadableStream(toolStep(calls)) },
      { stream: convertArrayToReadableStream(textStep) },
    ],
  })
  const events: ToolCallRepairEvent[] = []
  const result = streamText({
    model,
    prompt: 'go',
    tools,
    repairToolCall: createToolCallRepair({ onEvent: (event) => events.push(event) }),
    stopWhen: stepCountIs(3),
    onError: () => undefined,
  })
  const parts: Array<Record<string, unknown>> = []
  for await (const part of result.fullStream) parts.push(part as Record<string, unknown>)
  const secondPrompt = (model.doStreamCalls[1]?.prompt ?? []) as ModelMessage[]
  const toolResults = secondPrompt
    .filter((message) => message.role === 'tool')
    .flatMap((message) => message.content as Array<{ toolCallId: string; output: { type: string; value: unknown } }>)
  return { parts, toolResults, events }
}

function resultFor(toolResults: Awaited<ReturnType<typeof run>>['toolResults'], id: string) {
  return toolResults.find((entry) => entry.toolCallId === id)?.output
}

describe('AI SDK loop with repaired tool calls', () => {
  it('runs a valid call with the exact arguments it had before', async () => {
    const { tools, read } = makeTools()
    const { toolResults } = await run(tools, [{ id: 'c1', name: 'read', input: '{"path":"a.ts","limit":5}' }])
    expect(read).toHaveBeenCalledTimes(1)
    expect(read.mock.calls[0][0]).toEqual({ path: 'a.ts', limit: 5 })
    expect(resultFor(toolResults, 'c1')).toEqual({ type: 'text', value: 'read {"path":"a.ts","limit":5}' })
  })

  it('coerces string arguments, double-encoded objects and snake_case keys', async () => {
    const { tools, read, edit } = makeTools()
    await run(tools, [
      { id: 'c1', name: 'read', input: '{"path":"a.ts","limit":"50","tags":"[\\"x\\"]"}' },
      { id: 'c2', name: 'read', input: JSON.stringify(JSON.stringify({ path: 'b.ts' })) },
      { id: 'c3', name: 'edit', input: '{"path":"a.ts","old_string":"a","new_string":"b"}' },
    ])
    expect(read.mock.calls.map((call) => call[0])).toEqual([{ path: 'a.ts', limit: 50, tags: ['x'] }, { path: 'b.ts' }])
    expect(edit.mock.calls[0][0]).toEqual({ path: 'a.ts', oldString: 'a', newString: 'b' })
  })

  it('repairs a missing closer and raw newlines, but never runs a call cut off inside a string', async () => {
    const { tools, read, write } = makeTools()
    const { toolResults, events } = await run(tools, [
      { id: 'c1', name: 'read', input: '{"path":"a.ts"' },
      { id: 'c2', name: 'write', input: '{"path":"a.py","content":"line1\nline2"}' },
      { id: 'c3', name: 'write', input: '{"path":"b.py","content":"def main():\n    retu' },
    ])
    expect(read.mock.calls[0][0]).toEqual({ path: 'a.ts' })
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0][0]).toEqual({ path: 'a.py', content: 'line1\nline2' })
    const cut = resultFor(toolResults, 'c3')
    expect(cut?.type).toBe('error-text')
    expect(String(cut?.value)).toMatch(/cut off before they were complete, so the call was not executed/)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: 'repaired', kinds: ['json'], toolName: 'read' }),
        expect.objectContaining({ outcome: 'failed', reason: 'truncated', toolName: 'write' }),
      ])
    )
  })

  it('maps a namespaced or aliased name and only suggests a near miss', async () => {
    const { tools, read, write } = makeTools()
    const { toolResults } = await run(tools, [
      { id: 'c1', name: 'functions.read:0', input: '{"path":"a.ts"}' },
      { id: 'c2', name: 'Read', input: '{"path":"b.ts"}' },
      { id: 'c3', name: 'reed', input: '{"path":"c.ts"}' },
      { id: 'c4', name: 'wirte', input: '{"path":"d.ts","content":""}' },
    ])
    expect(read.mock.calls.map((call) => call[0])).toEqual([{ path: 'a.ts' }, { path: 'b.ts' }])
    expect(write).not.toHaveBeenCalled()
    expect(String(resultFor(toolResults, 'c3')?.value)).toMatch(/No tool is named "reed".*Did you mean `read`\?/)
    expect(String(resultFor(toolResults, 'c4')?.value)).toMatch(/Did you mean `write`\?/)
  })

  it('returns a validation error the model can act on when coercion cannot help', async () => {
    const { tools, read } = makeTools()
    const { toolResults } = await run(tools, [{ id: 'c1', name: 'read', input: '{"limit":"many"}' }])
    expect(read).not.toHaveBeenCalled()
    const output = resultFor(toolResults, 'c1')
    expect(output?.type).toBe('error-text')
    expect(String(output?.value)).toMatch(/The arguments do not match the tool's input schema:\n- path: /)
  })
})

describe('hardened tools in other runtimes', () => {
  afterAll(() => closeAntigravityHostMcpServer())

  it('keeps OpenAI strict schemas identical', async () => {
    const { raw, tools } = makeTools()
    const plain = await optimizeOpenAITools(raw)
    const hardened = await optimizeOpenAITools(tools)
    expect(hardened.strictToolNames).toEqual(plain.strictToolNames)
    for (const name of Object.keys(raw)) {
      expect(await asSchema(hardened.tools[name].inputSchema).jsonSchema).toEqual(
        await asSchema(plain.tools[name].inputSchema).jsonSchema
      )
      expect(hardened.tools[name].strict).toBe(plain.tools[name].strict)
    }
    const validate = asSchema(hardened.tools.read.inputSchema).validate!
    expect(await validate({ path: 'a.ts', limit: null, tags: null })).toEqual({
      success: true,
      value: { path: 'a.ts' },
    })
    expect(await validate({ path: 'a.ts', limit: '7', tags: null })).toEqual({
      success: true,
      value: { path: 'a.ts', limit: 7 },
    })
  })

  it('lets the Copilot bridge run calls whose arguments arrived as strings', async () => {
    const { raw, tools, read } = makeTools()
    const signal = new AbortController().signal
    const [rawRead] = (await copilotTools({ read: raw.read }, signal, new Set())).filter(
      (entry) => entry.name === 'read'
    )
    await expect(rawRead.handler!({ path: 'a.ts', limit: '5' }, { toolCallId: 'x' } as never)).rejects.toBeTruthy()
    const [hardenedRead] = await copilotTools({ read: tools.read }, signal, new Set())
    await hardenedRead.handler!({ path: 'a.ts', limit: '5' }, { toolCallId: 'y' } as never)
    expect(read).toHaveBeenLastCalledWith({ path: 'a.ts', limit: 5 }, expect.objectContaining({ toolCallId: 'y' }))
  })

  it('lets Codex dynamic tools run calls whose arguments arrived as strings', async () => {
    const { raw, tools, read } = makeTools()
    const signal = new AbortController().signal
    const [rawRead] = await toolSetRuntimes({ read: raw.read })
    await expect(rawRead.execute({ path: 'a.ts', limit: '5' }, 'x', signal, () => undefined)).rejects.toBeTruthy()
    const [hardenedRead] = await toolSetRuntimes({ read: tools.read })
    expect(hardenedRead.spec.inputSchema).toEqual(rawRead.spec.inputSchema)
    await hardenedRead.execute({ path: 'a.ts', limit: '5' }, 'y', signal, () => undefined)
    expect(read).toHaveBeenLastCalledWith({ path: 'a.ts', limit: 5 }, expect.objectContaining({ toolCallId: 'y' }))
  })

  it('lets the Antigravity host MCP server run calls whose arguments arrived as strings', async () => {
    const { tools, read } = makeTools()
    const toolset = await registerAntigravityHostToolset(tools)
    const results: Array<{ isError: boolean }> = []
    toolset.setActiveTurn({
      tools,
      signal: new AbortController().signal,
      onToolStart: () => undefined,
      onToolResult: (event) => results.push(event),
    })
    const header = toolset.mcpServer.headers[0]
    const response = await fetch(toolset.mcpServer.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', [header.name]: header.value },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'read', arguments: '{"path":"a.ts","limit":"3"}' },
      }),
    })
    const body = (await response.json()) as { result: { isError?: boolean } }
    expect(body.result.isError).not.toBe(true)
    expect(read).toHaveBeenCalledWith({ path: 'a.ts', limit: 3 }, expect.anything())
    expect(results).toEqual([expect.objectContaining({ isError: false })])
    toolset.dispose()
  })

  it('passes provider tools and tools without execute through unchanged', () => {
    const providerTool = { type: 'provider', id: 'openai.tool_search', args: {} } as unknown as ToolSet[string]
    const schemaOnly = tool({ inputSchema: jsonSchema({ type: 'object' }) }) as ToolSet[string]
    const hardened = hardenToolSetForModel({ toolSearch: providerTool, schemaOnly })
    expect(hardened.toolSearch).toBe(providerTool)
    expect(hardened.schemaOnly).toBe(schemaOnly)
  })
})
