import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createChatGptWebBridge } from '../../src/main/chat/chatgpt-web/bridge-server'
import { startBridgeHttp, type BridgeHttpEndpoint } from '../../src/main/chat/chatgpt-web/bridge-http'

/**
 * Transport consumed by `tunnel-client` (`--mcp.server-url`): loopback JSON-RPC POST with a token in the
 * path. Otherwise contract errors would appear only with a live tunnel.
 */
let repo: string
let endpoint: BridgeHttpEndpoint
let bridge: ReturnType<typeof createChatGptWebBridge>

beforeAll(async () => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'chatweb-http-'))
  writeFileSync(path.join(repo, 'file.txt'), 'hello\n')
  bridge = createChatGptWebBridge({ cwd: repo, runGit: async () => '' })
  endpoint = await startBridgeHttp(bridge)
})

afterAll(async () => {
  await endpoint.close()
  rmSync(repo, { recursive: true, force: true })
})

const post = (body: unknown, url = endpoint.url) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

describe('bridge loopback HTTP transport', () => {
  it('serves server/discover 2026-07-28 over HTTP without SSE fallback', async () => {
    const res = await post({
      jsonrpc: '2.0',
      id: 'openai-mcp-discover',
      method: 'server/discover',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'openai-mcp', version: '1' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      id: string
      result: { resultType: string; supportedVersions: string[]; capabilities: { tools?: object } }
    }
    expect(body).toMatchObject({
      id: 'openai-mcp-discover',
      result: {
        resultType: 'complete',
        supportedVersions: ['2026-07-28', '2025-06-18'],
        capabilities: { tools: {} },
      },
    })
  })

  it('serves MCP handshakes on token paths', async () => {
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { serverInfo: { name: string } } }
    expect(body.result.serverInfo.name).toBe('maestrly-bridge')
    expect(endpoint.url.startsWith('http://127.0.0.1:')).toBe(true)
  })

  it('executes tools and returns text', async () => {
    const res = await post({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'read_file', arguments: { path: 'file.txt' } },
    })
    const body = (await res.json()) as { result: { content: Array<{ text: string }> } }
    expect(body.result.content[0].text).toContain('hello')
  })

  it('returns HTTP context fallback after hung bootstrap', async () => {
    const hangingBridge = createChatGptWebBridge({
      cwd: repo,
      runGit: async () => '',
      projectContext: () => new Promise<never>(() => undefined),
      getContextTimeoutMs: 25,
    })
    const hangingEndpoint = await startBridgeHttp(hangingBridge)
    try {
      const res = await fetch(hangingEndpoint.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'get-context-timeout',
          method: 'tools/call',
          params: { name: 'get_context', arguments: {} },
        }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { result: { content: Array<{ text: string }> } }
      expect(body.result.content[0].text).toContain('# Repository context (partial)')
      expect(body.result.content[0].text).toContain('project-context')
    } finally {
      hangingBridge.endSession()
      await hangingEndpoint.close()
    }
  })

  it('returns 202 for notifications and 404 outside the token path', async () => {
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202)
    const missing = await post({ jsonrpc: '2.0', id: 3, method: 'ping' }, `http://127.0.0.1:${endpoint.port}/mcp/wrong`)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'not_found' })
  })

  it('returns nonempty PRMD 404 responses for tunnel no-auth classification', async () => {
    const endpointPath = new URL(endpoint.url).pathname
    for (const discoveryPath of [
      `/.well-known/oauth-protected-resource${endpointPath}`,
      '/.well-known/oauth-protected-resource',
    ]) {
      const res = await fetch(`http://127.0.0.1:${endpoint.port}${discoveryPath}`)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not_found' })
    }
  })

  it('rejects invalid JSON and non-POST methods', async () => {
    const bad = await fetch(endpoint.url, { method: 'POST', body: 'not-json' })
    expect(bad.status).toBe(400)
    const get = await fetch(endpoint.url)
    expect(get.status).toBe(405)
  })
})
