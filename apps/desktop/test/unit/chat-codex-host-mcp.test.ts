import http from 'node:http'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import {
  CODEX_HOST_MCP_SERVER_NAME,
  CODEX_HOST_MCP_TOKEN_ENV,
  closeCodexHostMcpServer,
  codexContentItemsToHostMcpContent,
  codexHostMcpProcessEnv,
  codexHostMcpThreadConfig,
  setCodexHostMcpCallHandler,
} from '../../src/main/chat/codex-subscription/host-mcp'

const token = codexHostMcpProcessEnv()[CODEX_HOST_MCP_TOKEN_ENV]
const taskSpec = {
  name: 'task',
  description: 'Delegates a subtask.',
  inputSchema: { type: 'object', properties: { agent: { type: 'string' }, prompt: { type: 'string' } } },
}

async function serverUrl(conversationId = 'conversation-1'): Promise<string> {
  const config = await codexHostMcpThreadConfig({ conversationId, tools: [taskSpec] })
  return (config[`mcp_servers.${CODEX_HOST_MCP_SERVER_NAME}`] as { url: string }).url
}

function post(
  url: string,
  body: unknown,
  headers: Record<string, string> = { authorization: `Bearer ${token}` }
): Promise<{ status: number; json: unknown }> {
  const target = new URL(url)
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', host: target.host, ...headers },
      },
      (res) => {
        let text = ''
        res.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }))
      }
    )
    req.on('error', reject)
    req.end(payload)
  })
}

function rpc(id: number, method: string, params: Record<string, unknown> = {}) {
  return { jsonrpc: '2.0', id, method, params }
}

describe('Codex host MCP server', () => {
  afterEach(() => setCodexHostMcpCallHandler(null))
  afterAll(closeCodexHostMcpServer)

  it('attaches a loopback, parallel-safe, pre-approved and always-visible server without leaking the token', async () => {
    const config = await codexHostMcpThreadConfig({ conversationId: 'conversation-1', tools: [taskSpec] })
    const server = config[`mcp_servers.${CODEX_HOST_MCP_SERVER_NAME}`]

    expect(server).toEqual({
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f]{32}$/),
      bearer_token_env_var: CODEX_HOST_MCP_TOKEN_ENV,
      required: true,
      supports_parallel_tool_calls: true,
      default_tools_approval_mode: 'approve',
      omit_tools_from: ['deferred'],
      startup_timeout_sec: expect.any(Number),
      tool_timeout_sec: expect.any(Number),
    })
    expect(config[`shell_environment_policy.set.${CODEX_HOST_MCP_TOKEN_ENV}`]).toBe('')
    expect(JSON.stringify(config)).not.toContain(token)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('addresses each published catalog by content so a loaded thread keeps its original tools', async () => {
    const first = await serverUrl('conversation-a')
    const same = await serverUrl('conversation-a')
    const other = await serverUrl('conversation-b')
    const changed = (
      (await codexHostMcpThreadConfig({
        conversationId: 'conversation-a',
        tools: [{ ...taskSpec, description: 'Changed.' }],
      })) as Record<string, { url: string }>
    )[`mcp_servers.${CODEX_HOST_MCP_SERVER_NAME}`].url

    expect(same).toBe(first)
    expect(other).not.toBe(first)
    expect(changed).not.toBe(first)
    const listed = await post(first, rpc(1, 'tools/list'))
    expect(listed.json).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [taskSpec] } })
  })

  it('rejects foreign hosts, unknown paths, missing tokens and non-POST requests', async () => {
    const url = await serverUrl()
    const target = new URL(url)

    expect(
      (await post(url, rpc(1, 'tools/list'), { authorization: `Bearer ${token}`, host: 'evil.example' })).status
    ).toBe(403)
    expect((await post(`${target.origin}/mcp/${'0'.repeat(31)}`, rpc(1, 'tools/list'))).status).toBe(404)
    expect((await post(url, rpc(1, 'tools/list'), {})).status).toBe(401)
    expect((await post(url, rpc(1, 'tools/list'), { authorization: `Bearer ${'f'.repeat(64)}` })).status).toBe(401)
    const get = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
    expect(get.status).toBe(405)
    expect((await post(url, '{not json')).status).toBe(400)
  })

  it('speaks the stateless MCP handshake', async () => {
    const url = await serverUrl()

    expect((await post(url, rpc(1, 'initialize', { protocolVersion: '2025-11-25' }))).json).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: CODEX_HOST_MCP_SERVER_NAME, version: '1.0.0' },
      },
    })
    expect((await post(url, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202)
    expect((await post(url, rpc(2, 'ping'))).json).toEqual({ jsonrpc: '2.0', id: 2, result: {} })
    expect((await post(url, rpc(3, 'resources/list'))).json).toMatchObject({ id: 3, error: { code: -32601 } })
  })

  it('routes delegation calls with Codex thread and call ids, and refuses everything else', async () => {
    const url = await serverUrl()
    const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'delegated' }] }))
    setCodexHostMcpCallHandler(handler)
    const call = (params: Record<string, unknown>) => post(url, rpc(7, 'tools/call', params))

    expect(
      (
        await call({
          name: 'task',
          arguments: { agent: 'explore', prompt: 'Map it.' },
          _meta: { threadId: 'thread-1', callId: 'call-1' },
        })
      ).json
    ).toEqual({ jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: 'delegated' }] } })
    expect(handler).toHaveBeenCalledWith({
      name: 'task',
      arguments: { agent: 'explore', prompt: 'Map it.' },
      threadId: 'thread-1',
      callId: 'call-1',
    })

    expect((await call({ name: 'bash', arguments: {}, _meta: { threadId: 'thread-1' } })).json).toMatchObject({
      result: { isError: true },
    })
    expect((await call({ name: 'task', arguments: {} })).json).toMatchObject({ result: { isError: true } })
    expect(handler).toHaveBeenCalledTimes(1)

    handler.mockRejectedValueOnce(new Error('route closed'))
    expect((await call({ name: 'task', arguments: {}, _meta: { threadId: 'thread-1' } })).json).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { content: [{ type: 'text', text: 'route closed' }], isError: true },
    })
  })

  it('projects Codex dynamic-tool content onto MCP content', () => {
    expect(
      codexContentItemsToHostMcpContent([
        { type: 'inputText', text: 'summary' },
        { type: 'inputImage', imageUrl: 'data:image/png;base64,AAAA' },
        { type: 'inputImage', imageUrl: 'https://example.com/remote.png' },
      ])
    ).toEqual([
      { type: 'text', text: 'summary' },
      { type: 'image', mimeType: 'image/png', data: 'AAAA' },
    ])
    expect(codexContentItemsToHostMcpContent([])).toEqual([{ type: 'text', text: '(no output)' }])
  })
})
