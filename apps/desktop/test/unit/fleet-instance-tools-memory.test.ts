import { afterEach, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { OwnerMemoryClient } from '../../src/main/fleet/instance/owner-memory'
import { registerBotInstanceTools } from '../../src/main/mcp/tools/bot-instance'

const state = vi.hoisted(() => ({
  ownerMemory: undefined as OwnerMemoryClient | undefined,
  input: null as null | {
    source: 'owner' | 'routine' | 'peer'
    routine?: { id: string; title: string; runId: string }
  },
}))
vi.mock('../../src/main/fleet/instance', () => ({
  requestOwnerHelp: vi.fn(),
  getBotInstanceRuntime: () => ({ currentInput: () => state.input, ownerMemory: state.ownerMemory }),
}))
const at = '2026-09-20T10:00:00.000Z'
const entry = {
  id: 'm1',
  content: 'Prefer short answers.',
  status: 'active',
  author: { kind: 'bot', botId: 'scout', name: 'Scout' },
  origin: 'owner',
  replacesId: null,
  replacedById: null,
  createdAt: at,
  updatedAt: at,
}
const text = (result: unknown) => String((result as { content: Array<{ text: string }> }).content[0]?.text)
const sessions: Array<{ client: Client; server: McpServer }> = []
afterEach(async () => {
  for (const { client, server } of sessions.splice(0)) {
    await client.close()
    await server.close()
  }
  state.input = null
  state.ownerMemory = undefined
  vi.unstubAllGlobals()
})
async function fixture() {
  const server = new McpServer({ name: 'memory', version: '1' })
  registerBotInstanceTools(
    { server, convId: 'primary', locale: 'en', t: (() => '') as never },
    { url: 'http://gateway.test', token: 'synthetic-token' }
  )
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '1' })
  await server.connect(b)
  await client.connect(a)
  sessions.push({ client, server })
  return client
}
it('registers the three memory and report tools', async () => {
  expect((await (await fixture()).listTools()).tools.map(({ name }) => name)).toEqual(
    expect.arrayContaining(['owner_memory_save', 'owner_memory_forget', 'routine_report'])
  )
})
it.each([null, { source: 'peer' as const }])(
  'saves owner memory with the current origin or owner default: %s',
  async (input) => {
    state.input = input
    const fetch = vi.fn().mockResolvedValue(Response.json(entry))
    vi.stubGlobal('fetch', fetch)
    const result = await (await fixture()).callTool({
      name: 'owner_memory_save',
      arguments: { content: entry.content },
    })
    expect(result.isError).not.toBe(true)
    expect(String(fetch.mock.calls[0][0])).toBe('http://gateway.test/internal/v1/owner-memory')
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
      content: entry.content,
      origin: input?.source ?? 'owner',
      idempotencyKey: expect.any(String),
    })
  }
)
it('preserves actionable owner-memory conflict messages', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { code: 'CONFLICT', message: 'Owner memory is full. Replace or forget a stale entry.' },
          { status: 409 }
        )
      )
  )
  const result = await (await fixture()).callTool({ name: 'owner_memory_save', arguments: { content: entry.content } })
  expect(result.isError).toBe(true)
  expect(text(result)).toBe('Owner memory is full. Replace or forget a stale entry.')
})
it('forgets an owner memory with a reason', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ ...entry, status: 'archived' }))
  vi.stubGlobal('fetch', fetch)
  const result = await (await fixture()).callTool({
    name: 'owner_memory_forget',
    arguments: { id: 'm1', reason: 'No longer true' },
  })
  expect(result.isError).not.toBe(true)
  expect(String(fetch.mock.calls[0][0])).toBe('http://gateway.test/internal/v1/owner-memory/m1/forget')
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ reason: 'No longer true' })
})
it('rejects reporting outside a scheduled run without contacting the gateway', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const result = await (await fixture()).callTool({ name: 'routine_report', arguments: { summary: 'Done' } })
  expect(result.isError).toBe(true)
  expect(text(result)).toContain('only while running a scheduled routine')
  expect(fetch).not.toHaveBeenCalled()
})
it('reports for the active routine run', async () => {
  state.input = { source: 'routine', routine: { id: 'r1', title: 'Check', runId: 'run-1' } }
  const fetch = vi.fn().mockResolvedValue(
    Response.json({
      id: 'run-1',
      routineId: 'r1',
      botId: 'scout',
      trigger: 'schedule',
      status: 'delivered',
      deliveredAt: at,
      finishedAt: null,
      report: { summary: 'Done', pending: null, notes: 'Retry tomorrow' },
      finalText: null,
    })
  )
  vi.stubGlobal('fetch', fetch)
  const result = await (await fixture()).callTool({
    name: 'routine_report',
    arguments: { summary: 'Done', notes_for_next_run: 'Retry tomorrow' },
  })
  expect(result.isError).not.toBe(true)
  expect(String(fetch.mock.calls[0][0])).toBe('http://gateway.test/internal/v1/routines/r1/runs/run-1/report')
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ summary: 'Done', pending: null, notes: 'Retry tomorrow' })
})

it.each(['owner_memory_save', 'owner_memory_forget'])(
  'invalidates the runtime prompt cache through %s resolved at call time',
  async (name) => {
    const client = await fixture()
    state.ownerMemory = new OwnerMemoryClient({ url: 'http://gateway.test', token: 'synthetic-token' })
    const memory = { revision: 1, activeChars: entry.content.length, entries: [entry] }
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(memory))
        .mockResolvedValueOnce(Response.json(entry))
        .mockRejectedValueOnce(new Error('offline'))
    )
    expect(await state.ownerMemory.get()).toEqual(memory)
    const result = await client.callTool({
      name,
      arguments:
        name === 'owner_memory_save'
          ? { content: 'Prefer detailed answers.', replaces_id: entry.id }
          : { id: entry.id, reason: 'Outdated' },
    })
    expect(result.isError).not.toBe(true)
    expect(await state.ownerMemory.coreSections(new AbortController().signal)).toBeNull()
  }
)
