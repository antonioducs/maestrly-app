import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  FLEET_PROTOCOL_HEADER,
  fleetCreateRoutineRequestSchema,
  fleetPatchRoutineRequestSchema,
} from '@maestrly/bot-fleet-protocol'
import { registerBotModeTools } from '../../src/main/mcp/tools/bot-instance'

vi.mock('../../src/main/fleet/instance', () => ({ requestOwnerHelp: vi.fn(async () => 'help-id') }))
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
})
const text = (result: unknown) => String((result as { content: Array<{ text: string }> }).content[0]?.text)
const at = '2026-09-25T10:00:00.000Z'
const routine = {
  id: randomUUID(),
  botId: 'scout',
  title: 'Check',
  prompt: 'Check later',
  schedule: { kind: 'weekly', time: '09:00', days: [], timezone: 'UTC' },
  enabled: true,
  nextRunAt: at,
  lastRunAt: null,
  lastOutcome: null,
  createdBy: 'owner',
  createdAt: at,
  updatedAt: at,
}
async function fixture() {
  const requests: Array<{ method: string; path: string; body: unknown }> = []
  let failure: { status: number; code: string; message: string } | null = null
  let listedCreatedBy: 'owner' | 'bot' = 'owner'
  const gateway = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString()) as unknown) : null
    requests.push({ method: req.method ?? '', path: req.url ?? '', body })
    expect(req.headers[FLEET_PROTOCOL_HEADER.toLowerCase()]).toBe('1')
    expect(req.headers.authorization).toBe('Bearer token')
    res.setHeader('content-type', 'application/json')
    if (failure) {
      res.statusCode = failure.status
      return res.end(JSON.stringify({ code: failure.code, message: failure.message }))
    }
    if (req.method === 'GET') return res.end(JSON.stringify({ routines: [{ ...routine, createdBy: listedCreatedBy }] }))
    if (req.method === 'POST') {
      expect(fleetCreateRoutineRequestSchema.safeParse(body).success).toBe(true)
      res.statusCode = 201
      return res.end(JSON.stringify({ ...routine, ...(body as object), createdBy: 'bot' }))
    }
    if (req.method === 'PATCH') {
      expect(fleetPatchRoutineRequestSchema.safeParse(body).success).toBe(true)
      return res.end(JSON.stringify({ ...routine, ...(body as object), createdBy: 'bot' }))
    }
    if (req.method === 'DELETE') {
      res.statusCode = 204
      return res.end()
    }
    res.statusCode = 404
    res.end('{}')
  })
  servers.push(gateway)
  gateway.listen(0, '127.0.0.1')
  await once(gateway, 'listening')
  const server = new McpServer({ name: 'routines', version: '1' })
  registerBotModeTools(
    { server, convId: 'primary', locale: 'en', t: (() => '') as never },
    {
      MAESTRLY_BOT_MODE: '1',
      MAESTRLY_BOT_GATEWAY_URL: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`,
      MAESTRLY_BOT_GATEWAY_TOKEN: 'token',
    },
    () => false
  )
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '1' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return {
    client,
    server,
    requests,
    setFailure: (value: typeof failure) => {
      failure = value
    },
    setListedCreatedBy: (value: 'owner' | 'bot') => {
      listedCreatedBy = value
    },
  }
}

it('lists and creates interval routines with a flat schema and rejects ambiguous schedules locally', async () => {
  const f = await fixture()
  try {
    const tools = (await f.client.listTools()).tools
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['bot_routines_list', 'bot_routines_create', 'bot_routines_update', 'bot_routines_delete'])
    )
    // The model learns the schedule rules from the schema: nothing else tells it what days or the minimum mean.
    const create = tools.find((tool) => tool.name === 'bot_routines_create')!
    const fields = create.inputSchema.properties as Record<string, { description?: string; minimum?: number }>
    expect(fields.days.description).toContain('1 = Monday')
    expect(fields.everyMinutes).toMatchObject({ minimum: 15 })
    expect(fields.timezone.description).toContain('Defaults to your own time zone')
    expect(create.description).toContain('at least 15 minutes')
    expect(create.description).toContain('at most 10 routines')
    expect(text(await f.client.callTool({ name: 'bot_routines_list', arguments: {} }))).toContain('"canChange":false')
    const before = f.requests.length
    const invalid = await f.client.callTool({
      name: 'bot_routines_create',
      arguments: {
        title: 'Check',
        prompt: 'Check later',
        everyMinutes: 15,
        time: '09:00',
      },
    })
    expect(invalid.isError).toBe(true)
    expect(text(invalid)).toContain('exactly one')
    expect(f.requests).toHaveLength(before)
    const created = await f.client.callTool({
      name: 'bot_routines_create',
      arguments: {
        title: 'Check',
        prompt: 'Check later',
        everyMinutes: 15,
      },
    })
    expect(created.isError).not.toBe(true)
    expect(f.requests.at(-1)).toMatchObject({
      method: 'POST',
      path: '/internal/v1/routines',
      body: {
        schedule: { kind: 'interval', everyMinutes: 15 },
        enabled: true,
        idempotencyKey: expect.any(String),
      },
    })
    expect(text(created)).toContain('"createdBy":"bot"')
  } finally {
    await f.client.close()
    await f.server.close()
  }
})

it('updates and deletes with encoded paths and exposes gateway refusal messages', async () => {
  const f = await fixture()
  try {
    f.setListedCreatedBy('bot')
    const changed = await f.client.callTool({
      name: 'bot_routines_update',
      arguments: {
        routineId: routine.id,
        time: '10:30',
      },
    })
    expect(changed.isError).not.toBe(true)
    expect(f.requests.at(-1)).toMatchObject({
      method: 'PATCH',
      path: '/internal/v1/routines/' + routine.id,
      body: {
        schedule: { kind: 'weekly', time: '10:30', days: [], timezone: expect.any(String) },
      },
    })
    f.setFailure({ status: 403, code: 'FORBIDDEN', message: 'Only your owner can change this routine.' })
    const denied = await f.client.callTool({ name: 'bot_routines_delete', arguments: { routineId: routine.id } })
    expect(denied.isError).toBe(true)
    expect(text(denied)).toContain('Only your owner can change this routine.')
  } finally {
    await f.client.close()
    await f.server.close()
  }
})
