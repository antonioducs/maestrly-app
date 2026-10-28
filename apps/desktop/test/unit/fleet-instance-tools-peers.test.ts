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
import { ThreadWaits } from '../../src/main/fleet/instance/thread-waits'
import type { ChatMessage } from '../../src/shared/chat'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const help = vi.hoisted(() => ({ requestOwnerHelp: vi.fn(async () => 'help-id') }))
type FakeBot = {
  gatewayConfigured: boolean
  gatewayConfig: { url: string; token: string } | null
  peerNames: Map<string, string>
  primaryConversationId: string
  runs: {
    byConversation: (conversationId: string | undefined) => unknown
    thread: (threadId: string) => unknown
  }
  currentInput: (conversationId: string) => { source: string; text: string } | null
  recordThread: ReturnType<typeof vi.fn>
  reportThread: ReturnType<typeof vi.fn>
  noteThreadSent: ReturnType<typeof vi.fn>
  waits: ThreadWaits
  waitThread: ReturnType<typeof vi.fn>
}
// The bot of the conversation 'primary', and of the side conversations listed; every other conversation has none.
const conversationBot = vi.hoisted(() => ({ bot: null as FakeBot | null, sides: new Set<string>() }))

// MCP tool results type `content` as unknown; the tools under test always return text blocks.
const firstContent = (result: unknown): Record<string, unknown> =>
  (result as { content: Array<Record<string, unknown>> }).content[0]
vi.mock('../../src/main/fleet/instance', () => ({
  requestOwnerHelp: help.requestOwnerHelp,
  botRuntimeForConversation: (conversationId: string | undefined) =>
    conversationId === 'primary' || conversationBot.sides.has(conversationId ?? '') ? conversationBot.bot : null,
}))
const servers: Server[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
  help.requestOwnerHelp.mockClear()
  conversationBot.bot = null
  conversationBot.sides.clear()
})
const botWith = (gatewayConfig: FakeBot['gatewayConfig'], lanes: Record<string, unknown> = {}): FakeBot => {
  const waits = new ThreadWaits()
  const threads = Object.values(lanes) as Array<{ kind: string; runId: string }>
  const thread = (threadId: string) => threads.find((lane) => lane.kind === 'thread' && lane.runId === threadId)
  return {
    gatewayConfigured: true,
    gatewayConfig,
    peerNames: new Map(),
    primaryConversationId: 'primary',
    runs: { byConversation: (conversationId) => (conversationId ? lanes[conversationId] : undefined), thread },
    currentInput: () => ({ source: 'owner', text: 'Ask Nina whether 4.2 passed' }),
    recordThread: vi.fn(async () => {}),
    reportThread: vi.fn(async () => {}),
    noteThreadSent: vi.fn((threadId: string) => waits.sent(threadId)),
    waits,
    waitThread: vi.fn(async (threadId: string, options: { timeoutMs: number; signal?: AbortSignal }) => {
      if (!thread(threadId)) throw new Error('No conversation with another bot has this id here.')
      return waits.wait(threadId, options)
    }),
  }
}

async function appClient(
  env: NodeJS.ProcessEnv,
  computer = () => false,
  bot: FakeBot | null = null,
  convId = 'primary'
) {
  conversationBot.bot = bot
  const server = new McpServer({ name: 'bot-tools', version: '1' })
  registerBotModeTools({ server, convId, locale: 'en', t: (() => '') as never }, env, computer)
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
  let thread: string | null = null
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
            ? { messageId: randomUUID(), delivered: !offline, ...(thread ? { thread } : {}) }
            : { code: responseStatus === 429 ? 'RATE_LIMITED' : 'FORBIDDEN', message: 'refused' }
        )
      )
      return
    }
    if (request.url?.startsWith('/internal/v1/peers/threads/')) {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ ok: true }))
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
    /** Answers sends with this thread, as a gateway with `peer-conversations` does. */
    setThread: (value: string | null) => {
      thread = value
    },
  }
}

describe('bot instance tool registration and gateway', () => {
  it('gates tools by bot mode, gateway config, and computer availability', async () => {
    const off = await appClient({})
    await expect(off.client.listTools()).rejects.toThrow('Method not found')
    await off.client.close()
    await off.server.close()
    const bot = await appClient({ MAESTRLY_BOT_MODE: '1' }, () => false, {
      ...botWith(null),
      gatewayConfigured: false,
    })
    expect((await bot.client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'bot_share_file',
      'request_owner_help',
    ])
    await bot.client.close()
    await bot.server.close()
    // A container's own gateway variables no longer give a conversation gateway access: each bot has its own token.
    const legacy = await appClient({
      MAESTRLY_BOT_MODE: '1',
      MAESTRLY_BOT_GATEWAY_URL: 'http://localhost:7444',
      MAESTRLY_BOT_GATEWAY_TOKEN: 'token',
    })
    expect((await legacy.client.listTools()).tools.map((tool) => tool.name)).toEqual(['request_owner_help'])
    await legacy.client.close()
    await legacy.server.close()
    const allTools = [
      'bot_share_file',
      'request_owner_help',
      'bot_peers_list',
      'bot_peers_send',
      'bot_peers_report',
      'bot_peers_wait',
      'bot_routines_list',
      'bot_routines_create',
      'bot_routines_update',
      'bot_routines_delete',
      'owner_memory_save',
      'owner_memory_forget',
      'routine_report',
    ]
    const gateway = await appClient(
      { MAESTRLY_BOT_MODE: '1' },
      () => false,
      botWith({ url: 'http://localhost:7444/', token: 'token' })
    )
    expect((await gateway.client.listTools()).tools.map((tool) => tool.name)).toEqual(allTools)
    await gateway.client.close()
    await gateway.server.close()
    const other = await appClient(
      { MAESTRLY_BOT_MODE: '1' },
      () => false,
      botWith({ url: 'http://localhost:7444/', token: 'token' }),
      'other'
    )
    expect((await other.client.listTools()).tools.map((tool) => tool.name)).toEqual(['request_owner_help'])
    await other.client.close()
    await other.server.close()
    // A bot adopted from an older container offers its tools but waits for the gateway to install its token.
    const waiting = await appClient({ MAESTRLY_BOT_MODE: '1' }, () => false, botWith(null))
    expect((await waiting.client.listTools()).tools.map((tool) => tool.name)).toEqual(allTools)
    const early = await waiting.client.callTool({ name: 'bot_peers_list', arguments: {} })
    expect(early.isError).toBe(true)
    expect(firstContent(early)).toMatchObject({ text: expect.stringContaining('has not connected this bot yet') })
    await waiting.client.close()
    await waiting.server.close()
    const withComputer = await appClient({ MAESTRLY_BOT_MODE: '1' }, () => true)
    expect((await withComputer.client.listTools()).tools.map((tool) => tool.name)).toContain('computer_screenshot')
    await withComputer.client.close()
    await withComputer.server.close()
  })

  it('validates gateway headers and body, and explains ACL, rate limit and offline delivery', async () => {
    const gateway = await fakeGateway()
    const bot = botWith({ url: gateway.url, token: 'secret' })
    const { client, server } = await appClient({ MAESTRLY_BOT_MODE: '1' }, () => false, bot)
    try {
      const list = await client.callTool({ name: 'bot_peers_list', arguments: {} })
      expect(firstContent(list)).toMatchObject({ text: expect.stringContaining('Scout') })
      expect(bot.peerNames.get('scout')).toBe('Scout')
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

  it("opens a thread from the bot's conversation, and keeps a thread's messages to its bot in it", async () => {
    const gateway = await fakeGateway()
    const thread = { kind: 'thread', runId: 'thread-1', peerBotId: 'scout', origin: 'primary' }
    const elsewhere = { kind: 'thread', runId: 'thread-2', peerBotId: 'nina', origin: 'peer' }
    const bot = botWith({ url: gateway.url, token: 'secret' }, { 'thread-conv': thread, 'other-thread': elsewhere })
    conversationBot.sides.add('thread-conv')
    conversationBot.sides.add('other-thread')
    bot.peerNames.set('scout', 'Scout')
    gateway.setThread('thread-1')
    const own = await appClient({ MAESTRLY_BOT_MODE: '1' }, () => false, bot)
    const inThread = await appClient({ MAESTRLY_BOT_MODE: '1' }, () => false, bot, 'thread-conv')
    const inOther = await appClient({ MAESTRLY_BOT_MODE: '1' }, () => false, bot, 'other-thread')
    const bodies = () =>
      gateway.requests
        .filter((request) => request.path === '/internal/v1/peers/messages')
        .map((request) => request.body as Record<string, unknown>)
    try {
      // From its own conversation, a message opens a thread, which gets a conversation of its own here.
      const opened = await own.client.callTool({
        name: 'bot_peers_send',
        arguments: { to: 'scout', text: 'Did 4.2 pass?', topic: 'Release 4.2' },
      })
      expect(firstContent(opened)).toMatchObject({ text: expect.stringContaining('opened a conversation of its own') })
      expect(firstContent(opened)).toMatchObject({ text: expect.stringContaining('call bot_peers_wait') })
      expect(bodies().at(-1)).toMatchObject({ origin: 'primary', topic: 'Release 4.2' })
      expect(bodies().at(-1)).not.toHaveProperty('thread')
      expect(bot.recordThread).toHaveBeenCalledWith(
        {
          threadId: 'thread-1',
          peerBotId: 'scout',
          peerName: 'Scout',
          title: 'Release 4.2',
          origin: 'primary',
          opening: { sent: 'Did 4.2 pass?', ask: 'Ask Nina whether 4.2 passed' },
        },
        expect.objectContaining({ kind: 'peer_out', text: 'Did 4.2 pass?', thread: { id: 'thread-1' } })
      )
      // In the thread, a message to its bot stays in it.
      await inThread.client.callTool({ name: 'bot_peers_send', arguments: { to: 'scout', text: 'Thanks' } })
      expect(bodies().at(-1)).toMatchObject({ thread: 'thread-1' })
      expect(bodies().at(-1)).not.toHaveProperty('origin')
      expect(bot.recordThread).toHaveBeenCalledTimes(1)
      // Writing there again tells whoever waits for the thread that its exchange goes on; opening one does not.
      expect(bot.noteThreadSent.mock.calls).toEqual([['thread-1']])
      // From a thread with another bot, a message to Scout opens a thread of its own.
      gateway.setThread('thread-3')
      await inOther.client.callTool({ name: 'bot_peers_send', arguments: { to: 'scout', text: 'Also this' } })
      expect(bodies().at(-1)).toMatchObject({ origin: 'side' })
      expect(bot.recordThread).toHaveBeenLastCalledWith(
        expect.objectContaining({ threadId: 'thread-3', origin: 'side' }),
        expect.anything()
      )
      // A refusal in a thread says the gateway's reason; outside one, the ACL's.
      gateway.setStatus(403)
      const refused = await inThread.client.callTool({ name: 'bot_peers_send', arguments: { to: 'scout', text: 'No' } })
      expect(firstContent(refused)).toMatchObject({ text: 'refused' })
      const denied = await own.client.callTool({ name: 'bot_peers_send', arguments: { to: 'scout', text: 'No' } })
      expect(firstContent(denied)).toMatchObject({ text: expect.stringContaining('bot ACL') })
      // A message the gateway refused never reached the other bot: the exchange did not go on.
      expect(bot.noteThreadSent).toHaveBeenCalledTimes(1)
    } finally {
      for (const { client, server } of [own, inThread, inOther]) {
        await client.close()
        await server.close()
      }
    }
  })

  it("reports a thread's answer only from a thread opened from the bot's conversation", async () => {
    const gateway = await fakeGateway()
    const opened = { kind: 'thread', runId: 'thread-1', peerBotId: 'scout', origin: 'primary' }
    const theirs = { kind: 'thread', runId: 'thread-2', peerBotId: 'nina', origin: 'peer' }
    const bot = botWith({ url: gateway.url, token: 'secret' }, { mine: opened, theirs })
    conversationBot.sides.add('mine')
    conversationBot.sides.add('theirs')
    const mine = await appClient({ MAESTRLY_BOT_MODE: '1' }, () => false, bot, 'mine')
    const other = await appClient({ MAESTRLY_BOT_MODE: '1' }, () => false, bot, 'theirs')
    const own = await appClient({ MAESTRLY_BOT_MODE: '1' }, () => false, bot)
    try {
      const reported = await mine.client.callTool({ name: 'bot_peers_report', arguments: { text: '4.2 passed.' } })
      expect(reported.isError).toBeFalsy()
      expect(gateway.requests.at(-1)).toMatchObject({
        path: '/internal/v1/peers/threads/thread-1/report',
        body: { text: '4.2 passed.' },
      })
      expect(bot.reportThread).toHaveBeenCalledWith('thread-1', '4.2 passed.')
      for (const client of [other.client, own.client]) {
        const refused = await client.callTool({ name: 'bot_peers_report', arguments: { text: 'No' } })
        expect(refused.isError).toBe(true)
        expect(firstContent(refused)).toMatchObject({ text: expect.stringContaining('works only in a conversation') })
      }
      expect(bot.reportThread).toHaveBeenCalledTimes(1)
    } finally {
      for (const { client, server } of [mine, other, own]) {
        await client.close()
        await server.close()
      }
    }
  })

  it("waits, within the turn, for a thread's answer outside the thread's own conversation", async () => {
    const gateway = await fakeGateway()
    const opened = { kind: 'thread', runId: 'thread-1', peerBotId: 'scout', peerName: 'Scout', origin: 'primary' }
    const bot = botWith({ url: gateway.url, token: 'secret' }, { mine: opened })
    conversationBot.sides.add('mine')
    const own = await appClient({ MAESTRLY_BOT_MODE: '1' }, () => false, bot)
    const inThread = await appClient({ MAESTRLY_BOT_MODE: '1' }, () => false, bot, 'mine')
    const wait = (args: Record<string, unknown>, options?: { signal: AbortSignal }) =>
      own.client.callTool({ name: 'bot_peers_wait', arguments: args }, undefined, options)
    const parsed = (result: unknown) => JSON.parse(String(firstContent(result).text)) as Record<string, unknown>
    try {
      // The thread reports its answer while the bot's own conversation waits for it.
      const reported = wait({ thread: 'thread-1' })
      await vi.waitFor(() => expect(bot.waitThread).toHaveBeenCalledTimes(1))
      expect(bot.waitThread.mock.calls[0][1]).toMatchObject({ timeoutMs: 300_000, signal: expect.any(AbortSignal) })
      bot.waits.reported('thread-1', '4.2 passed.')
      expect(parsed(await reported)).toMatchObject({
        status: 'reported',
        text: '4.2 passed.',
        thread: 'thread-1',
        name: 'Scout',
      })
      // Its turn answering the other bot ends without writing again: the other bot's message is the answer.
      const answered = wait({ thread: 'thread-1', timeoutSeconds: 10 })
      await vi.waitFor(() => expect(bot.waitThread).toHaveBeenCalledTimes(2))
      expect(bot.waitThread.mock.calls[1][1]).toMatchObject({ timeoutMs: 10_000 })
      bot.waits.turnEnded('thread-1', bot.waits.mark('thread-1'), 'It passed.', 'Scout says it passed.')
      expect(parsed(await answered)).toMatchObject({
        status: 'answered',
        peerReply: 'It passed.',
        finalText: 'Scout says it passed.',
        note: expect.stringContaining('settled'),
      })
      // Still working after the timeout: the bot may wait again, or end its turn and read the report then.
      bot.waitThread.mockResolvedValueOnce({ status: 'waiting' })
      const waiting = parsed(await wait({ thread: 'thread-1' }))
      expect(waiting).toMatchObject({ status: 'waiting', note: expect.stringContaining('call bot_peers_wait again') })
      expect(waiting.note).toContain('in your memory on your next turn')
      // The owner's Stop cancels the call, and with it the wait.
      const stop = new AbortController()
      const stopped = wait({ thread: 'thread-1' }, { signal: stop.signal })
      await vi.waitFor(() => expect(bot.waitThread).toHaveBeenCalledTimes(4))
      stop.abort()
      await expect(stopped).rejects.toThrow()
      await expect(bot.waitThread.mock.results[3].value).resolves.toEqual({ status: 'cancelled' })
      // A thread that is not here, or a wait from the thread's own conversation, is refused.
      const unknown = await wait({ thread: 'missing' })
      expect(unknown.isError).toBe(true)
      expect(firstContent(unknown)).toMatchObject({ text: expect.stringContaining('No conversation with another bot') })
      const inside = await inThread.client.callTool({ name: 'bot_peers_wait', arguments: { thread: 'thread-1' } })
      expect(inside.isError).toBe(true)
      expect(firstContent(inside)).toMatchObject({ text: expect.stringContaining('outside your conversations') })
      const short = await wait({ thread: 'thread-1', timeoutSeconds: 1 })
      expect(short.isError).toBe(true)
      expect(bot.waitThread).toHaveBeenCalledTimes(5)
    } finally {
      for (const { client, server } of [own, inThread]) {
        await client.close()
        await server.close()
      }
    }
  })

  it('requests owner help and instructs the bot to stop its turn', async () => {
    const { client, server } = await appClient({ MAESTRLY_BOT_MODE: '1' })
    try {
      const result = await client.callTool({ name: 'request_owner_help', arguments: { reason: 'Login needed' } })
      expect(help.requestOwnerHelp).toHaveBeenCalledWith('primary', 'Login needed')
      expect(firstContent(result)).toMatchObject({ text: expect.stringContaining('End your turn now') })
    } finally {
      await client.close()
      await server.close()
    }
  })
})

describe("waits for a thread's answer", () => {
  it('settles on a report, or on a turn that answered without writing to the other bot again', async () => {
    const waits = new ThreadWaits()
    const first = waits.wait('t', { timeoutMs: 5000 })
    const second = waits.wait('t', { timeoutMs: 5000 })
    // A turn that wrote to the other bot again: the exchange goes on.
    const replying = waits.mark('t')
    waits.sent('t')
    waits.turnEnded('t', replying, 'Which build?', 'Asked back.')
    // A turn that reported its answer settles once, by its report.
    const reporting = waits.mark('t')
    waits.reported('t', 'Build 912 passed.')
    waits.turnEnded('t', reporting, 'Build 912 passed.', 'Reported.')
    for (const wait of [first, second])
      await expect(wait).resolves.toEqual({ status: 'reported', text: 'Build 912 passed.' })
    expect(waits.pending('t')).toBe(false)
    const quiet = waits.mark('t')
    waits.turnEnded('t', quiet, 'Done.', null)
    expect(waits.pending('t')).toBe(true)
    await expect(waits.wait('t', { timeoutMs: 5000 })).resolves.toEqual({
      status: 'answered',
      peerReply: 'Done.',
      finalText: null,
    })
    expect(waits.pending('t')).toBe(false)
  })

  it('drops a kept answer once the bot writes in the thread again, and ends waits on timeout, abort or dispose', async () => {
    let now = 1000
    const waits = new ThreadWaits(() => now)
    waits.reported('t', 'Old answer.')
    expect(waits.lastSentAt('t')).toBe(0)
    now = 2000
    waits.sent('t')
    expect(waits.pending('t')).toBe(false)
    expect(waits.lastSentAt('t')).toBe(2000)
    await expect(waits.wait('t', { timeoutMs: 10 })).resolves.toEqual({ status: 'waiting' })
    const stop = new AbortController()
    const stopped = waits.wait('t', { timeoutMs: 5000, signal: stop.signal })
    stop.abort()
    await expect(stopped).resolves.toEqual({ status: 'cancelled' })
    await expect(waits.wait('t', { timeoutMs: 5000, signal: stop.signal })).resolves.toEqual({ status: 'cancelled' })
    const pending = [waits.wait('t', { timeoutMs: 5000 }), waits.wait('u', { timeoutMs: 5000 })]
    waits.cancelAll()
    for (const wait of pending) await expect(wait).resolves.toEqual({ status: 'cancelled' })
    // A wait that ended takes no later answer: it is kept for the next one.
    waits.reported('t', 'New answer.')
    expect(waits.pending('t')).toBe(true)
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
