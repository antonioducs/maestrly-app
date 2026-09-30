import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import type net from 'node:net'
import { FLEET_PROTOCOL_HEADER, type FleetInstanceBotInstall } from '@maestrly/bot-fleet-protocol'
import { GatewayError } from '../src/errors.js'
import { InstanceClient, InstanceUnreachableError } from '../src/instance.js'

const servers: http.Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
type Answer = (res: http.ServerResponse, req: http.IncomingMessage) => void
/** A synthetic instance that answers each request, by method and path, as the test chooses. */
async function instance(answers: Record<string, Answer>) {
  const routes = new Map(Object.entries(answers))
  const server = http.createServer((req, res) => {
    if (req.headers[FLEET_PROTOCOL_HEADER.toLowerCase()] !== '1' || req.headers.authorization !== 'Bearer control') {
      res.writeHead(401).end()
      return
    }
    const answer = routes.get(req.method + ' ' + req.url)
    if (typeof answer === 'function') return answer(res, req)
    json(404, { code: 'NOT_FOUND', message: 'Not found' })(res, req)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return 'http://127.0.0.1:' + (server.address() as net.AddressInfo).port
}
const json =
  (code: number, value: unknown): Answer =>
  (res) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(value))
  }
const empty: Answer = (res) => {
  res.writeHead(204)
  res.end()
}
async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected the call to fail')
}
const install = (botId: string): FleetInstanceBotInstall => ({
  profile: {
    botId,
    name: botId,
    instructions: '',
    ceiling: 'ask',
    selection: null,
    compaction: null,
    gateway: { peersEnabled: false },
  },
  slot: 1,
  gatewayToken: 'g'.repeat(43),
})

describe('instance client', () => {
  it('rejects an empty answer where the route promises a body, and accepts it where none is expected', async () => {
    const origin = await instance({
      'POST /v1/bots/ads/hold': empty,
      'POST /v1/hold/release': empty,
      'GET /v1/bots/ads/status': empty,
      'DELETE /v1/bots/ads': empty,
      'DELETE /v1/skills/notes': empty,
    })
    const client = new InstanceClient('work', 'control', origin)
    for (const call of [
      () => client.forBot('ads', true).hold({ reason: 'paused' }),
      () => client.forBot('ads', false).release({ note: null, durationMs: null, continue: true }),
      () => client.forBot('ads', true).status(),
    ]) {
      const error = await failure(call())
      expect(error).toBeInstanceOf(GatewayError)
      expect(error).toMatchObject({ code: 'INSTANCE_UNAVAILABLE' })
      // The instance answered: it is reachable.
      expect(error).not.toBeInstanceOf(InstanceUnreachableError)
    }
    await expect(client.botUninstall('ads', false)).resolves.toBeUndefined()
    await expect(client.skillRemove('notes')).resolves.toBeUndefined()
  })

  it('tells an instance that answered with an error from one it could not reach or that did not answer in time', async () => {
    const origin = await instance({
      'PUT /v1/bots/ads': json(500, { code: 'INTERNAL', message: 'Synthetic failure' }),
      'PUT /v1/bots/cleo': json(409, { code: 'CONFLICT', message: 'Display slot 1 is used by another bot.' }),
      'PUT /v1/bots/scout': (_res, req) => req.socket.destroy(),
      // Never answers.
      'PUT /v1/bots/dana': () => {},
      'GET /v1/environment/status': json(200, { environmentId: 'work', bots: 'malformed' }),
    })
    const client = new InstanceClient('work', 'control', origin, 200)
    const answered = [
      [await failure(client.botInstall('ads', install('ads'))), 'INSTANCE_UNAVAILABLE', 'Synthetic failure'],
      [await failure(client.botInstall('cleo', install('cleo'))), 'CONFLICT', 'Display slot 1 is used by another bot.'],
      [await failure(client.environmentStatus()), 'INSTANCE_UNAVAILABLE', 'Invalid bot instance response'],
    ] as const
    for (const [error, code, message] of answered) {
      expect(error).toBeInstanceOf(GatewayError)
      expect(error).toMatchObject({ code, message })
      expect(error).not.toBeInstanceOf(InstanceUnreachableError)
    }
    const unreachable = [
      await failure(client.botInstall('scout', install('scout'))),
      await failure(client.botInstall('dana', install('dana'))),
      await failure(new InstanceClient('gone', 'control', 'http://127.0.0.1:1', 200).health()),
    ]
    for (const error of unreachable) {
      expect(error).toBeInstanceOf(InstanceUnreachableError)
      expect(error).toMatchObject({ code: 'INSTANCE_UNAVAILABLE', message: 'Bot instance unavailable' })
    }
  })
})

describe('transcript reasoning', () => {
  const at = '2026-09-29T10:00:00.000Z'
  const reasoning = { kind: 'reasoning', id: 'm:0', at, text: 'Thinking', truncated: false, streaming: false }

  it('asks a bot for reasoning items only for a device that asked for them', async () => {
    const page = { items: [reasoning], before: null }
    const origin = await instance({
      'GET /v1/bots/alpha/transcript?limit=200&reasoning=1': json(200, page),
      'GET /v1/bots/alpha/transcript?before=m%3A5&limit=20': json(200, { items: [], before: null }),
    })
    const client = new InstanceClient('work', 'control', origin).forBot('alpha', true)
    expect(await client.transcript(undefined, 200, true)).toEqual(page)
    expect(await client.transcript('m:5', 20)).toEqual({ items: [], before: null })
  })

  it('reads the event stream with reasoning items, which the gateway passes on to devices that ask', async () => {
    const event = { seq: 1, at, botId: 'alpha', type: 'transcript.upsert', item: reasoning }
    const origin = await instance({
      'GET /v1/events?since=0&reasoning=1': (res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end('id: 1\nevent: fleet\ndata: ' + JSON.stringify(event) + '\n\n')
      },
    })
    const received = []
    for await (const value of new InstanceClient('work', 'control', origin).events(0)) received.push(value)
    expect(received).toEqual([event])
  })
})
