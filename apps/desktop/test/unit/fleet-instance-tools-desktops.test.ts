import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  FLEET_PROTOCOL_HEADER,
  fleetInternalDesktopCallRequestSchema,
  type FleetDesktopCallResult,
  type FleetDesktopLink,
  type FleetInternalDesktopCallRequest,
} from '@maestrly/bot-fleet-protocol'
import { registerBotModeTools } from '../../src/main/mcp/tools/bot-instance'
import { BOT_DESKTOP_TOOL_NAMES } from '../../src/main/mcp/tools/bot-desktops'
import { APP_TOOL_POLICY } from '../../src/main/chat/tool-policy'
import { BOT_DESKTOP_READ_RULES, BYOK_DEFAULT_RULESET, ruleEffect } from '../../src/main/chat/permission'

type FakeBot = {
  gatewayConfigured: boolean
  gatewayConfig: { url: string; token: string } | null
  peerNames: Map<string, string>
  desktopBridgeEnabled?: boolean
}
const conversationBot = vi.hoisted(() => ({ bot: null as FakeBot | null }))
vi.mock('../../src/main/fleet/instance', () => ({
  requestOwnerHelp: vi.fn(async () => 'help-id'),
  botRuntimeForConversation: (conversationId: string | undefined) =>
    conversationId === 'primary' ? conversationBot.bot : null,
}))

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  conversationBot.bot = null
})

const macbook: FleetDesktopLink = {
  desktopId: 'dsk_macbookmacbookmacbook',
  name: 'MacBook',
  online: true,
  lastSeenAt: '2026-10-05T10:00:00.000Z',
  linkedAt: '2026-10-01T10:00:00.000Z',
}
const imac: FleetDesktopLink = {
  desktopId: 'dsk_imacimacimacimacimac',
  name: 'iMac',
  online: false,
  lastSeenAt: '2026-10-04T10:00:00.000Z',
  linkedAt: '2026-10-02T10:00:00.000Z',
}

/** The gateway's internal API for one bot: its Macs, and what each Mac answers to a call. */
async function fakeGateway(
  desktops: FleetDesktopLink[],
  answer: (request: FleetInternalDesktopCallRequest) => FleetDesktopCallResult
) {
  const calls: FleetInternalDesktopCallRequest[] = []
  const headers: Array<{ auth?: string; protocol?: string }> = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    headers.push({
      auth: request.headers.authorization,
      protocol: request.headers[FLEET_PROTOCOL_HEADER.toLowerCase()] as string | undefined,
    })
    response.setHeader('content-type', 'application/json')
    if (request.url === '/internal/v1/desktops') return response.end(JSON.stringify({ desktops }))
    if (request.url === '/internal/v1/desktop/calls') {
      const parsed = fleetInternalDesktopCallRequestSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString()))
      if (!parsed.success) {
        response.statusCode = 400
        return response.end(JSON.stringify({ code: 'INVALID_REQUEST', message: 'Invalid request' }))
      }
      calls.push(parsed.data)
      return response.end(JSON.stringify(answer(parsed.data)))
    }
    response.statusCode = 404
    response.end('{}')
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, headers }
}

async function client(bot: FakeBot) {
  conversationBot.bot = bot
  const server = new McpServer({ name: 'bot-tools', version: '1' })
  registerBotModeTools(
    { server, convId: 'primary', locale: 'en', t: (() => '') as never },
    { MAESTRLY_BOT_MODE: '1' },
    () => false
  )
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const mcp = new Client({ name: 'test', version: '1' })
  await server.connect(serverTransport)
  await mcp.connect(clientTransport)
  return mcp
}
const text = (result: unknown) => (result as { content: Array<{ text: string }> }).content[0].text
const json = (result: unknown) => JSON.parse(text(result)) as Record<string, unknown>

describe('desktop tools of a fleet bot', () => {
  it('are offered only when the gateway routes desktop calls, with reads marked as reads', async () => {
    const config = { url: 'http://127.0.0.1:1', token: 'secret' }
    const without = await client({ gatewayConfigured: true, gatewayConfig: config, peerNames: new Map() })
    const names = (await without.listTools()).tools.map((tool) => tool.name)
    expect(names.filter((name) => name.startsWith('desktop_'))).toEqual([])
    await without.close()

    const mcp = await client({
      gatewayConfigured: true,
      gatewayConfig: config,
      peerNames: new Map(),
      desktopBridgeEnabled: true,
    })
    const tools = (await mcp.listTools()).tools
    expect(tools.filter((tool) => tool.name.startsWith('desktop_')).map((tool) => tool.name)).toEqual([
      ...BOT_DESKTOP_TOOL_NAMES,
    ])
    for (const tool of tools.filter((item) => item.name.startsWith('desktop_'))) {
      const policy = APP_TOOL_POLICY[tool.name as keyof typeof APP_TOOL_POLICY]
      expect(policy, tool.name).toBeDefined()
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(policy.readOnly)
      // Reads never prompt in a bot container; a change passes the bot's own ceiling first.
      expect(ruleEffect('mcp', tool.name, BYOK_DEFAULT_RULESET, BOT_DESKTOP_READ_RULES), tool.name).toBe(
        policy.readOnly ? 'allow' : 'ask'
      )
    }
    // Every tool but the listings names the Mac it reaches.
    for (const tool of tools.filter((item) => item.name.startsWith('desktop_'))) {
      const required = (tool.inputSchema.required ?? []) as string[]
      const optional = ['desktop_list_desktops', 'desktop_list_workspaces', 'desktop_list_chats'].includes(tool.name)
      expect(required.includes('desktopId'), tool.name).toBe(!optional && tool.name !== 'desktop_list_desktops')
    }
    await mcp.close()
  })

  it('tells the bot how to get access when no computer linked it', async () => {
    const gateway = await fakeGateway([], () => ({ ok: true, value: {} }))
    const mcp = await client({
      gatewayConfigured: true,
      gatewayConfig: { url: gateway.url, token: 'secret' },
      peerNames: new Map(),
      desktopBridgeEnabled: true,
    })
    const listed = json(await mcp.callTool({ name: 'desktop_list_desktops', arguments: {} }))
    expect(listed).toEqual({ desktops: [], note: expect.stringContaining('Workspaces on this computer') })
    const workspaces = json(await mcp.callTool({ name: 'desktop_list_workspaces', arguments: {} }))
    expect(workspaces.note).toEqual(expect.stringContaining('No computer gives you access yet'))
    expect(gateway.calls).toEqual([])
    expect(gateway.headers.every((item) => item.auth === 'Bearer secret' && item.protocol === '1')).toBe(true)
    await mcp.close()
  })

  it('asks every online Mac at once, groups the answers by Mac, and marks the offline ones', async () => {
    const gateway = await fakeGateway([macbook, imac], (request) =>
      request.op === 'listWorkspaces'
        ? {
            ok: true,
            value: {
              desktop: { id: request.desktopId, name: 'MacBook' },
              workspaces: [{ workspaceId: 'w-1', label: 'maestrly', branches: ['main'], defaultBranch: 'main' }],
              selections: [],
            },
          }
        : { ok: true, value: { conversations: [] } }
    )
    const mcp = await client({
      gatewayConfigured: true,
      gatewayConfig: { url: gateway.url, token: 'secret' },
      peerNames: new Map(),
      desktopBridgeEnabled: true,
    })
    const all = json(await mcp.callTool({ name: 'desktop_list_workspaces', arguments: {} }))
    expect(all).toEqual({
      desktops: [
        {
          desktopId: macbook.desktopId,
          name: 'MacBook',
          online: true,
          workspaces: [{ workspaceId: 'w-1', label: 'maestrly', branches: ['main'], defaultBranch: 'main' }],
          selections: [],
        },
        { desktopId: imac.desktopId, name: 'iMac', online: false, error: 'desktop_offline' },
      ],
    })
    // The offline Mac is never asked.
    expect(gateway.calls.map((call) => call.desktopId)).toEqual([macbook.desktopId])
    const chats = json(await mcp.callTool({ name: 'desktop_list_chats', arguments: { desktopId: macbook.desktopId } }))
    expect(chats).toEqual({ desktopId: macbook.desktopId, desktopName: 'MacBook', conversations: [] })
    await mcp.close()
  })

  it('names the Mac in every call, and keeps a retry on the same idempotency key', async () => {
    let failing = false
    const gateway = await fakeGateway([macbook], (request) =>
      failing
        ? {
            ok: false,
            error: { code: 'desktop_timeout', message: '"MacBook" did not answer within 25 seconds.' },
          }
        : { ok: true, value: { conversation: { id: 'c', workspaceId: request.input.workspaceId } } }
    )
    const mcp = await client({
      gatewayConfigured: true,
      gatewayConfig: { url: gateway.url, token: 'secret' },
      peerNames: new Map(),
      desktopBridgeEnabled: true,
    })
    // Without the Mac, a conversation tool is refused before anything is sent.
    const missing = await mcp.callTool({
      name: 'desktop_read_chat',
      arguments: { conversationId: '7c9e6679-7425-40de-944b-e07fc1f90ae7' },
    })
    expect(missing.isError).toBe(true)
    const invalid = await mcp.callTool({
      name: 'desktop_read_chat',
      arguments: { desktopId: 'macbook', conversationId: '7c9e6679-7425-40de-944b-e07fc1f90ae7' },
    })
    expect(invalid.isError).toBe(true)
    expect(gateway.calls).toEqual([])

    const create = {
      desktopId: macbook.desktopId,
      workspaceId: 'w-1',
      name: 'Fix the build',
      baseBranch: 'main',
      selection: { selectionId: 's-1' },
      message: 'Fix the failing build.',
    }
    const created = await mcp.callTool({ name: 'desktop_create_chat', arguments: create })
    expect(json(created)).toEqual({
      desktopId: macbook.desktopId,
      desktopName: 'MacBook',
      conversation: { id: 'c', workspaceId: 'w-1' },
    })
    const sent = gateway.calls.at(-1)!
    expect(sent.op).toBe('createChat')
    expect(sent.input).toMatchObject({ workspaceId: 'w-1', baseBranch: 'main', selection: { selectionId: 's-1' } })
    expect(sent.input).not.toHaveProperty('desktopId')
    expect(sent.input.idempotencyKey).toEqual(expect.any(String))

    failing = true
    const timedOut = await mcp.callTool({
      name: 'desktop_send_message',
      arguments: { desktopId: macbook.desktopId, conversationId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', text: 'go' },
    })
    expect(timedOut.isError).toBe(true)
    const key = /idempotencyKey: ([^)]+)\)/.exec(text(timedOut))?.[1]
    expect(text(timedOut)).toContain('desktop_timeout')
    expect(key).toBe(gateway.calls.at(-1)!.input.idempotencyKey)
    failing = false
    await mcp.callTool({
      name: 'desktop_send_message',
      arguments: {
        desktopId: macbook.desktopId,
        conversationId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        text: 'go',
        idempotencyKey: key,
      },
    })
    expect(gateway.calls.at(-1)!.input.idempotencyKey).toBe(key)
    await mcp.close()
  })
})
