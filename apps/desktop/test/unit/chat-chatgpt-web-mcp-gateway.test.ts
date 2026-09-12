import { describe, expect, it, vi } from 'vitest'
import type { ListedMcpTool, McpConnection, McpServer } from '../../src/main/chat/mcp'
import {
  CHATGPT_WEB_MCP_RESULT_MAX_CHARS,
  ChatGptWebMcpGatewayError,
  createChatGptWebMcpGateway,
  normalizeChatGptWebMcpResult,
} from '../../src/main/chat/chatgpt-web/mcp-gateway'

const servers: McpServer[] = [
  {
    id: 'read-server',
    name: 'Read server',
    transport: 'http',
    enabled: true,
    url: 'https://secret.example/mcp',
    headers: { Authorization: 'Bearer must-not-leak' },
  },
  {
    id: 'write-server',
    name: 'Write server',
    transport: 'stdio',
    enabled: true,
    command: '/secret/private-command',
    env: { TOKEN: 'must-not-leak-either' },
  },
  { id: 'off-server', name: 'Off server', transport: 'stdio', enabled: true, command: 'off-command' },
]

function fakeConnections(catalogs: Record<string, ListedMcpTool[]>) {
  const calls: Array<{ serverId: string; toolName: string; args: Record<string, unknown>; signal?: AbortSignal }> = []
  const closes: string[] = []
  const connect = vi.fn(
    async (server: McpServer): Promise<McpConnection> => ({
      listTools: vi.fn(async () => catalogs[server.id] ?? []),
      callTool: vi.fn(async (toolName, args = {}, options) => {
        calls.push({ serverId: server.id, toolName, args, signal: options?.signal })
        return { content: [{ type: 'text', text: `${server.id}:${toolName}` }] }
      }),
      close: vi.fn(async () => {
        closes.push(server.id)
      }),
    })
  )
  return { connect, calls, closes }
}

describe('ChatGPT Web MCP session gateway', () => {
  it('is lazy/cached, honors off/read/write and never exposes transport configuration', async () => {
    const catalogs = {
      'read-server': [
        { name: 'lookup', description: 'Find a record', annotations: { readOnlyHint: true } },
        { name: 'contradictory', annotations: { readOnlyHint: true, destructiveHint: true } },
        { name: 'missing_annotations' },
      ],
      'write-server': [
        { name: 'inspect', annotations: { readOnlyHint: true, destructiveHint: false } },
        { name: 'mutate' },
      ],
    } satisfies Record<string, ListedMcpTool[]>
    const fake = fakeConnections(catalogs)
    const gateway = createChatGptWebMcpGateway({
      servers,
      scopes: { 'read-server': 'read', 'write-server': 'write', 'off-server': 'off' },
      connect: fake.connect,
    })

    expect(fake.connect).not.toHaveBeenCalled()
    const found = await gateway.searchTools({ limit: 20 })

    expect(found.tools.map(({ serverId, toolName, access }) => [serverId, toolName, access])).toEqual([
      ['read-server', 'lookup', 'read'],
      ['write-server', 'inspect', 'read'],
      ['write-server', 'mutate', 'write'],
    ])
    expect(fake.connect).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(found)).not.toContain('must-not-leak')
    expect(JSON.stringify(found)).not.toContain('secret.example')

    await gateway.callReadTool({ serverId: 'read-server', toolName: 'lookup', arguments: { id: 1 } })
    await gateway.callWriteTool({ serverId: 'write-server', toolName: 'mutate', arguments: { id: 2 } })
    expect(fake.connect).toHaveBeenCalledTimes(2)
    expect(fake.calls.map(({ serverId, toolName }) => [serverId, toolName])).toEqual([
      ['read-server', 'lookup'],
      ['write-server', 'mutate'],
    ])
    await expect(
      gateway.callWriteTool({ serverId: 'read-server', toolName: 'missing_annotations' })
    ).rejects.toMatchObject({ code: 'scope_denied' })
    await expect(gateway.callReadTool({ serverId: 'off-server', toolName: 'anything' })).rejects.toMatchObject({
      code: 'server_not_allowed',
    })
    await gateway.close()
    expect(fake.closes.sort()).toEqual(['read-server', 'write-server'])
  })

  it('caps search and revalidates current annotations before every call', async () => {
    const changing: ListedMcpTool[] = Array.from({ length: 25 }, (_, index) => ({
      name: `read_${index}`,
      annotations: { readOnlyHint: true },
    }))
    const fake = fakeConnections({ 'read-server': changing })
    const gateway = createChatGptWebMcpGateway({
      servers,
      scopes: { 'read-server': 'read', 'write-server': 'off', 'off-server': 'off' },
      connect: fake.connect,
    })

    const found = await gateway.searchTools({ limit: 999 })
    expect(found.tools).toHaveLength(20)
    expect(found.truncated).toBe(true)

    changing[0] = { name: 'read_0', annotations: { readOnlyHint: true, destructiveHint: true } }
    await expect(gateway.callReadTool({ serverId: 'read-server', toolName: 'read_0' })).rejects.toMatchObject({
      code: 'scope_denied',
    })
    expect(fake.calls).toEqual([])
    await gateway.close()
  })

  it('rejects invalid or disabled search server IDs with safe, actionable authorized IDs', async () => {
    const disabledServer: McpServer = {
      id: 'disabled-server',
      name: 'Disabled server',
      transport: 'http',
      enabled: false,
      url: 'https://disabled-secret.example/mcp',
      headers: { Authorization: 'Bearer disabled-secret' },
    }
    const fake = fakeConnections({})
    const gateway = createChatGptWebMcpGateway({
      servers: [...servers, disabledServer],
      scopes: {
        'read-server': 'read',
        'write-server': 'write',
        'off-server': 'off',
        'disabled-server': 'read',
      },
      connect: fake.connect,
    })

    for (const serverId of ['unknown-server', 'off-server', 'disabled-server']) {
      const error = await gateway.searchTools({ serverId }).catch((reason: unknown) => reason)

      expect(error).toBeInstanceOf(ChatGptWebMcpGatewayError)
      expect(error).toMatchObject({ code: 'server_not_allowed' })
      expect((error as Error).message).toContain('Use the exact serverId returned by list_external_capabilities.')
      expect((error as Error).message).toContain('Currently authorized server IDs: read-server, write-server.')
      expect((error as Error).message).not.toContain('unknown-server')
      expect((error as Error).message).not.toContain('off-server')
      expect((error as Error).message).not.toContain('disabled-server')
      expect((error as Error).message).not.toContain('disabled-secret.example')
      expect((error as Error).message).not.toContain('disabled-secret')
    }
    expect(fake.connect).not.toHaveBeenCalled()
    await gateway.close()
  })

  it('directs missing tool names to the exact search result toolName', async () => {
    const fake = fakeConnections({
      'read-server': [{ name: 'lookup', annotations: { readOnlyHint: true } }],
    })
    const gateway = createChatGptWebMcpGateway({
      servers,
      scopes: { 'read-server': 'read' },
      connect: fake.connect,
    })

    await expect(gateway.callReadTool({ serverId: 'read-server', toolName: 'missing' })).rejects.toMatchObject({
      code: 'tool_not_found',
      message: 'MCP tool was not found. Use the exact toolName returned by search_mcp_tools.',
    })
    expect(fake.calls).toEqual([])
    await gateway.close()
  })

  it('normalizes/truncates output and propagates AbortSignal through lifecycle close', async () => {
    const lifecycle = new AbortController()
    let seenSignal: AbortSignal | undefined
    const close = vi.fn(async () => {})
    const connection: McpConnection = {
      listTools: async () => [{ name: 'lookup', annotations: { readOnlyHint: true } }],
      callTool: async (_name, _args, options) => {
        seenSignal = options?.signal
        return {
          content: [{ type: 'text', text: 'x'.repeat(CHATGPT_WEB_MCP_RESULT_MAX_CHARS * 2) }],
          structuredContent: { invalid: Number.POSITIVE_INFINITY, bigint: 12n },
        }
      },
      close,
    }
    const gateway = createChatGptWebMcpGateway({
      servers,
      scopes: { 'read-server': 'read' },
      signal: lifecycle.signal,
      connect: async () => connection,
    })

    const result = await gateway.callReadTool({ serverId: 'read-server', toolName: 'lookup' })
    expect(JSON.stringify(result).length).toBeLessThan(CHATGPT_WEB_MCP_RESULT_MAX_CHARS + 1_000)
    expect(JSON.stringify(result)).toContain('(truncated)')
    expect(seenSignal).toBe(lifecycle.signal)

    lifecycle.abort()
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    await expect(gateway.searchTools()).rejects.toBeInstanceOf(ChatGptWebMcpGatewayError)
  })

  it('bounds serialized structured output including primitive and structural entries', () => {
    const structuredContent = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `entry_${index}`,
        Object.fromEntries(
          Array.from({ length: 100 }, (_, propertyIndex) => [
            `value_${propertyIndex}`,
            propertyIndex % 2 === 0 ? propertyIndex : propertyIndex % 3 === 0,
          ])
        ),
      ])
    )

    expect(JSON.stringify({ structuredContent }).length).toBeGreaterThan(CHATGPT_WEB_MCP_RESULT_MAX_CHARS)
    const normalized = normalizeChatGptWebMcpResult({ structuredContent })
    const serialized = JSON.stringify(normalized)

    expect(serialized.length).toBeLessThanOrEqual(CHATGPT_WEB_MCP_RESULT_MAX_CHARS + 100)
  })
})
