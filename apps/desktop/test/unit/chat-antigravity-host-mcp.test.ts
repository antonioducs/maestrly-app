import http from 'node:http'
import { tool, type ToolSet } from 'ai'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  type AntigravityActiveTurn,
  type AntigravityHostToolset,
  closeAntigravityHostMcpServer,
  registerAntigravityHostToolset,
} from '../../src/main/chat/antigravity-subscription/host-mcp'
import { mcpResultToChatToolOutput } from '../../src/main/chat/tool-output'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const execute = vi.fn(async ({ text }: { text: string }) => `echo:${text}`)
const tools: ToolSet = {
  echo: tool({ description: 'Echo', inputSchema: z.object({ text: z.string() }), execute }),
  shot: tool({
    description: 'Screenshot',
    inputSchema: z.object({}),
    execute: async () =>
      mcpResultToChatToolOutput({
        content: [
          { type: 'text', text: 'captured' },
          { type: 'image', data: PNG, mimeType: 'image/png' },
        ],
      }),
  }),
}

afterAll(() => closeAntigravityHostMcpServer())

function auth(toolset: AntigravityHostToolset): Record<string, string> {
  const header = toolset.mcpServer.headers[0]
  return { [header.name]: header.value }
}

async function post(toolset: AntigravityHostToolset, body: unknown, headers: Record<string, string> = auth(toolset)) {
  return fetch(toolset.mcpServer.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  })
}

async function rpc(toolset: AntigravityHostToolset, method: string, params: unknown = {}) {
  const response = await post(toolset, { jsonrpc: '2.0', id: 1, method, params })
  expect(response.status).toBe(200)
  return ((await response.json()) as { result: Record<string, unknown> }).result
}

function activeTurn(): AntigravityActiveTurn & {
  starts: Array<{ toolCallId: string; toolName: string; input: unknown }>
  results: Array<{ toolCallId: string; isError: boolean; output: unknown }>
} {
  const starts: Array<{ toolCallId: string; toolName: string; input: unknown }> = []
  const results: Array<{ toolCallId: string; isError: boolean; output: unknown }> = []
  return {
    tools,
    signal: new AbortController().signal,
    starts,
    results,
    onToolStart: (event) => starts.push(event),
    onToolResult: (event) => results.push(event),
  }
}

describe('Antigravity host MCP server', () => {
  it('requires the per-toolset bearer and a loopback host', async () => {
    const toolset = await registerAntigravityHostToolset(tools)
    expect(toolset.mcpServer).toMatchObject({ type: 'http', name: 'maestrly' })
    expect(toolset.mcpServer.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f-]{36}$/)
    expect((await post(toolset, { jsonrpc: '2.0', id: 1, method: 'ping' }, {})).status).toBe(401)
    expect(
      (await post(toolset, { jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: 'Bearer wrong' })).status
    ).toBe(401)
    const { port, pathname } = new URL(toolset.mcpServer.url)
    const rebinding = await new Promise<number>((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, path: pathname, method: 'POST', headers: { host: 'evil.test', ...auth(toolset) } },
        (response) => resolve(response.statusCode ?? 0)
      )
      request.on('error', reject)
      request.end('{}')
    })
    expect(rebinding).toBe(403)
    expect((await fetch(toolset.mcpServer.url, { headers: auth(toolset) })).status).toBe(405)
    toolset.dispose()
  })

  it('initializes and lists only its own tools', async () => {
    const toolset = await registerAntigravityHostToolset(tools)
    expect(toolset.wasInitialized()).toBe(false)
    const init = await rpc(toolset, 'initialize', { protocolVersion: '2025-11-25' })
    expect(init).toMatchObject({ protocolVersion: '2025-11-25', serverInfo: { name: 'maestrly' } })
    expect(toolset.wasInitialized()).toBe(true)
    expect((await post(toolset, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202)
    const listed = (await rpc(toolset, 'tools/list')) as { tools: Array<{ name: string }> }
    expect(listed.tools.map((entry) => entry.name)).toEqual(['echo', 'shot'])

    const other = await registerAntigravityHostToolset({ echo: tools.echo })
    const otherList = (await rpc(other, 'tools/list')) as { tools: Array<{ name: string }> }
    expect(otherList.tools.map((entry) => entry.name)).toEqual(['echo'])
    const crossed = await post(toolset, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, auth(other))
    expect(crossed.status).toBe(401)
    toolset.dispose()
    other.dispose()
  })

  it('refuses calls outside an active turn', async () => {
    const toolset = await registerAntigravityHostToolset(tools)
    const result = await rpc(toolset, 'tools/call', { name: 'echo', arguments: { text: 'x' } })
    expect(result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: expect.stringMatching(/no active/i) }],
    })
    toolset.dispose()
  })

  it('executes a validated call and reports start and result with one tool call id', async () => {
    const toolset = await registerAntigravityHostToolset(tools)
    const turn = activeTurn()
    toolset.setActiveTurn(turn)
    execute.mockClear()
    const result = await rpc(toolset, 'tools/call', { name: 'echo', arguments: { text: 'hi' } })
    expect(result).toEqual({ content: [{ type: 'text', text: 'echo:hi' }] })
    expect(turn.starts).toEqual([
      { toolCallId: expect.stringMatching(/^agy_/), toolName: 'echo', input: { text: 'hi' } },
    ])
    expect(turn.results).toEqual([
      { toolCallId: turn.starts[0].toolCallId, toolName: 'echo', output: 'echo:hi', isError: false },
    ])

    const invalid = await rpc(toolset, 'tools/call', { name: 'echo', arguments: { text: 3 } })
    expect(invalid).toMatchObject({ isError: true })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(turn.results[1]).toMatchObject({ isError: true })

    const unknown = await rpc(toolset, 'tools/call', { name: 'nope', arguments: {} })
    expect(unknown).toMatchObject({ isError: true })
    toolset.dispose()
  })

  it('replaces tool images the model cannot see with a notice', async () => {
    const toolset = await registerAntigravityHostToolset(tools)
    const turn = activeTurn()
    toolset.setActiveTurn(turn)
    const result = (await rpc(toolset, 'tools/call', { name: 'shot', arguments: {} })) as {
      content: Array<Record<string, unknown>>
    }
    expect(result.content.some((item) => item.type === 'image')).toBe(false)
    expect(result.content).toContainEqual({ type: 'text', text: '[image omitted: not visible to this model]' })
    expect(turn.results[0].output).toMatchObject({ images: [expect.objectContaining({ mediaType: 'image/png' })] })
    toolset.dispose()
  })

  it('serves the schemas of tools the catalog lists without them, and repeats one after invalid arguments', async () => {
    const count = vi.fn(async ({ count }: { count: number }) => `count:${count}`)
    const big = tool({
      description: `Big tool. ${'Long explanation. '.repeat(6_000)}`,
      inputSchema: z.object({ count: z.number() }),
      execute: count,
    })
    const toolset = await registerAntigravityHostToolset({ ...tools, big }, { summarizable: [['big']] })
    expect([...toolset.summarized]).toEqual(['big'])
    expect(toolset.catalog).toContain('- maestrly_big: Big tool.\n')
    expect(toolset.catalog).not.toContain('Long explanation')
    const listed = (await rpc(toolset, 'tools/list')) as { tools: Array<{ name: string }> }
    expect(listed.tools.map((entry) => entry.name)).toEqual(['big', 'echo', 'get_tool_schemas', 'shot'])

    const turn = { ...activeTurn(), tools: { ...tools, big } }
    toolset.setActiveTurn(turn)
    const schemas = (await rpc(toolset, 'tools/call', {
      name: 'get_tool_schemas',
      arguments: { names: ['maestrly_big'] },
    })) as { content: Array<{ text: string }>; isError?: boolean }
    expect(schemas.isError).toBeUndefined()
    expect(schemas.content[0].text).toMatch(/^- maestrly_big: Big tool\. Long explanation\./)
    expect(schemas.content[0].text).toMatch(/\n {2}arguments: \{.*"properties":\{"count":\{"type":"number"\}\}/)
    expect(turn.starts).toEqual([])

    const invalid = (await rpc(toolset, 'tools/call', { name: 'big', arguments: { count: 'x' } })) as {
      content: Array<{ text: string }>
      isError?: boolean
    }
    expect(invalid.isError).toBe(true)
    expect(invalid.content[0].text).toMatch(/^Invalid arguments for "big": [\s\S]+\n {2}arguments: \{.*"count"/)
    expect(count).not.toHaveBeenCalled()
    expect(await rpc(toolset, 'tools/call', { name: 'big', arguments: { count: 2 } })).toEqual({
      content: [{ type: 'text', text: 'count:2' }],
    })
    toolset.dispose()
  })

  it('keeps every schema in the catalog and adds no lookup tool while the catalog fits', async () => {
    const toolset = await registerAntigravityHostToolset(tools, { summarizable: [['echo', 'shot']] })
    expect(toolset.summarized.size).toBe(0)
    expect(toolset.specs.map((spec) => spec.name)).toEqual(['echo', 'shot'])
    expect(toolset.catalog).toMatch(/- maestrly_echo: Echo\n {2}arguments: /)
    toolset.dispose()
  })

  it('revokes the key on dispose', async () => {
    const toolset = await registerAntigravityHostToolset(tools)
    toolset.dispose()
    expect((await post(toolset, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(404)
  })
})
