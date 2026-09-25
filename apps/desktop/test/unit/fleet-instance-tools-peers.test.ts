import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { FLEET_PROTOCOL_HEADER, fleetInternalPeerMessageRequestSchema } from '@maestrly/bot-fleet-protocol'
import { registerBotModeTools } from '../../src/main/mcp/tools/bot-instance'
import { InstanceTranscriptExtras, projectChatMessages, toolTarget } from '../../src/main/fleet/instance/transcript'
import { InstanceHelpStore } from '../../src/main/fleet/instance/help'
import type { ChatMessage } from '../../src/shared/chat'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const help = vi.hoisted(() => ({ requestOwnerHelp: vi.fn(async () => 'help-id') }))

// MCP tool results type `content` as unknown; the tools under test always return text blocks.
const firstContent = (result: unknown): Record<string, unknown> =>
  (result as { content: Array<Record<string, unknown>> }).content[0]
vi.mock('../../src/main/fleet/instance', () => ({ requestOwnerHelp: help.requestOwnerHelp }))
const servers: Server[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
  help.requestOwnerHelp.mockClear()
})

async function appClient(env: NodeJS.ProcessEnv, computer = () => false) {
  const server = new McpServer({ name: 'bot-tools', version: '1' })
  registerBotModeTools({ server, convId: 'primary', locale: 'en', t: (() => '') as never }, env, computer)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '1' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return { client, server }
}
async function fakeGateway() {
  let responseStatus = 200
  let offline = false
  let malformed = false
  const requests: Array<{ path: string; auth: string | undefined; protocol: string | undefined; body: unknown }> = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown) : null
    requests.push({
      path: request.url ?? '',
      auth: request.headers.authorization,
      protocol: request.headers[FLEET_PROTOCOL_HEADER.toLowerCase()] as string | undefined,
      body,
    })
    if (request.url === '/internal/v1/peers') {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify(
          malformed
            ? { peers: [{ botId: 'INVALID' }] }
            : { peers: [{ botId: 'scout', name: 'Scout', role: 'research', status: 'idle' }] }
        )
      )
      return
    }
    if (request.url === '/internal/v1/peers/messages') {
      if (!fleetInternalPeerMessageRequestSchema.safeParse(body).success) {
        response.statusCode = 400
        response.end('{}')
        return
      }
      response.statusCode = responseStatus
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify(
          responseStatus === 200
            ? { messageId: randomUUID(), delivered: !offline }
            : { code: responseStatus === 429 ? 'RATE_LIMITED' : 'FORBIDDEN', message: 'refused' }
        )
      )
      return
    }
    response.statusCode = 404
    response.end('{}')
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    setStatus: (value: number) => {
      responseStatus = value
    },
    setOffline: (value: boolean) => {
      offline = value
    },
    setMalformed: (value: boolean) => {
      malformed = value
    },
  }
}

describe('bot instance tool registration and gateway', () => {
  it('gates tools by bot mode, gateway config, and computer availability', async () => {
    const off = await appClient({})
    await expect(off.client.listTools()).rejects.toThrow('Method not found')
    await off.client.close()
    await off.server.close()
    const bot = await appClient({ MAESTRLY_BOT_MODE: '1' })
    expect((await bot.client.listTools()).tools.map((tool) => tool.name)).toEqual(['request_owner_help'])
    await bot.client.close()
    await bot.server.close()
    const gateway = await appClient({
      MAESTRLY_BOT_MODE: '1',
      MAESTRLY_BOT_GATEWAY_URL: 'http://localhost:7444',
      MAESTRLY_BOT_GATEWAY_TOKEN: 'token',
    })
    expect((await gateway.client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'request_owner_help',
      'bot_peers_list',
      'bot_peers_send',
      'bot_routines_list',
      'bot_routines_create',
      'bot_routines_update',
      'bot_routines_delete',
    ])
    await gateway.client.close()
    await gateway.server.close()
    const withComputer = await appClient({ MAESTRLY_BOT_MODE: '1' }, () => true)
    expect((await withComputer.client.listTools()).tools.map((tool) => tool.name)).toContain('computer_screenshot')
    await withComputer.client.close()
    await withComputer.server.close()
  })

  it('validates gateway headers and body, and explains ACL, rate limit and offline delivery', async () => {
    const gateway = await fakeGateway()
    const { client, server } = await appClient({
      MAESTRLY_BOT_MODE: '1',
      MAESTRLY_BOT_GATEWAY_URL: gateway.url,
      MAESTRLY_BOT_GATEWAY_TOKEN: 'secret',
    })
    try {
      const list = await client.callTool({ name: 'bot_peers_list', arguments: {} })
      expect(firstContent(list)).toMatchObject({ text: expect.stringContaining('Scout') })
      gateway.setMalformed(true)
      const invalid = await client.callTool({ name: 'bot_peers_list', arguments: {} })
      expect(invalid.isError).toBe(true)
      expect(firstContent(invalid)).toMatchObject({ text: expect.stringContaining('invalid peer response') })
      gateway.setMalformed(false)
      const sent = await client.callTool({ name: 'bot_peers_send', arguments: { to: 'scout', text: 'Hello' } })
      expect(firstContent(sent)).toMatchObject({ text: expect.stringContaining('"delivered":true') })
      expect(gateway.requests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: '/internal/v1/peers', auth: 'Bearer secret', protocol: '1' }),
          expect.objectContaining({
            path: '/internal/v1/peers/messages',
            auth: 'Bearer secret',
            protocol: '1',
            body: expect.objectContaining({ to: 'scout', text: 'Hello' }),
          }),
        ])
      )
      const sendRequest = gateway.requests.find((request) => request.path === '/internal/v1/peers/messages')
      expect(fleetInternalPeerMessageRequestSchema.safeParse(sendRequest?.body).success).toBe(true)
      gateway.setOffline(true)
      const queued = await client.callTool({ name: 'bot_peers_send', arguments: { to: 'scout', text: 'Later' } })
      expect(firstContent(queued)).toMatchObject({ text: expect.stringContaining('"delivered":false') })
      expect(firstContent(queued)).toMatchObject({ text: expect.stringContaining('"status":"queued"') })
      gateway.setStatus(403)
      const denied = await client.callTool({ name: 'bot_peers_send', arguments: { to: 'scout', text: 'No' } })
      expect(denied.isError).toBe(true)
      expect(firstContent(denied)).toMatchObject({ text: expect.stringContaining('not allowed') })
      gateway.setStatus(429)
      const limited = await client.callTool({ name: 'bot_peers_send', arguments: { to: 'scout', text: 'No' } })
      expect(limited.isError).toBe(true)
      expect(firstContent(limited)).toMatchObject({ text: expect.stringContaining('Stop messaging peers') })
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('requests owner help and instructs the bot to stop its turn', async () => {
    const { client, server } = await appClient({ MAESTRLY_BOT_MODE: '1' })
    try {
      const result = await client.callTool({ name: 'request_owner_help', arguments: { reason: 'Login needed' } })
      expect(help.requestOwnerHelp).toHaveBeenCalledWith('Login needed')
      expect(firstContent(result)).toMatchObject({ text: expect.stringContaining('End your turn now') })
    } finally {
      await client.close()
      await server.close()
    }
  })
})

describe('help and transcript items', () => {
  it('creates a pending help interaction with matching helpId', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fleet-help-test-'))
    try {
      const extras = new InstanceTranscriptExtras(path.join(dir, 'extras.json'), () => {})
      const store = new InstanceHelpStore(extras, () => {})
      const id = await store.requestHelp('Login needed')
      expect(store.pending()).toMatchObject([{ kind: 'help', id, itemId: 'help:' + id }])
      expect(extras.list()).toMatchObject([{ kind: 'help', helpId: id, reason: 'Login needed' }])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('projects peer delivery from the tool result and desktop targets', () => {
    const message = {
      id: 'assistant',
      conversationId: 'primary',
      role: 'assistant',
      createdAt: Date.now(),
      parts: [
        {
          type: 'tool',
          id: 'send',
          toolCallId: 'send',
          toolName: 'bot_peers_send',
          input: { to: 'scout', text: 'Hello' },
          state: { status: 'completed', output: JSON.stringify({ messageId: 'm', delivered: false, name: 'Scout' }) },
        },
        {
          type: 'tool',
          id: 'key',
          toolCallId: 'key',
          toolName: 'computer_key',
          input: { keys: 'ctrl+s' },
          state: { status: 'completed', output: 'done' },
        },
        {
          type: 'tool',
          id: 'drag',
          toolCallId: 'drag',
          toolName: 'computer_drag',
          input: { fromX: 1, fromY: 2, toX: 3, toY: 4 },
          state: { status: 'completed', output: 'done' },
        },
        {
          type: 'tool',
          id: 'help',
          toolCallId: 'help',
          toolName: 'request_owner_help',
          input: { reason: 'login' },
          state: { status: 'completed', output: 'help-id' },
        },
      ],
    } as ChatMessage
    expect(projectChatMessages([message])).toMatchObject([
      { kind: 'peer_out', to: { botId: 'scout', name: 'Scout' }, delivered: false },
      { kind: 'tool', target: 'ctrl+s' },
      { kind: 'tool', target: '(1, 2) → (3, 4)' },
    ])
    expect(toolTarget({ text: 'x'.repeat(50) })).toHaveLength(40)
    expect(toolTarget({ title: 'Morning check', prompt: 'Check now' })).toBe('Morning check')
  })
  it('shows a completed routine title as the tool target', () => {
    const message = {
      id: 'assistant',
      conversationId: 'primary',
      role: 'assistant',
      createdAt: Date.now(),
      parts: [
        {
          type: 'tool',
          id: 'routine',
          toolCallId: 'routine',
          toolName: 'bot_routines_update',
          input: { routineId: 'r1', time: '10:30' },
          state: { status: 'completed', output: JSON.stringify({ id: 'r1', title: 'Morning check' }) },
        },
      ],
    } as ChatMessage
    expect(projectChatMessages([message])).toMatchObject([{ kind: 'tool', target: 'Morning check' }])
  })
})
