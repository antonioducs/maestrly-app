import { randomBytes, randomUUID } from 'node:crypto'
import http, { createServer, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import {
  FLEET_DESKTOP_BRIDGE_FEATURE,
  FLEET_GATEWAY_ROUTES,
  FLEET_HOST_DESKTOP_CALLS_FEATURE,
  FLEET_INTERNAL_ROUTES,
  fleetBotSchema,
  fleetDesktopCallResultSchema,
  fleetEnvironmentSchema,
  fleetGatewayEventSchema,
  fleetHostInfoSchema,
  type FleetDesktopCallResult,
  type FleetDesktopLinkView,
  type FleetDesktopOp,
  type FleetGatewayEvent,
  type FleetHostDesktopLink,
  type FleetRoute,
} from '@maestrly/bot-fleet-protocol'
import type { LaunchedHost } from './remote-host'

const now = () => new Date().toISOString()
const GB = 1024 ** 3
/** The id of the workspaces environment the host is, as its container is told. */
export const ENVIRONMENT_ID = 'workspaces'

type Link = { botId: string; desktopId: string; name: string; linkedAt: string }

function routeOf(routes: Record<string, FleetRoute>, method: string, pathname: string) {
  return Object.entries(routes).find(
    ([, route]) => route.method === method && new RegExp(`^${route.path.replace(/:[^/]+/g, '[^/]+')}$`).test(pathname)
  )
}

/**
 * A bot server with one bots environment, its bot Scout, and one workspaces environment, "Personal", that the host of
 * the test runs. The owner's computer pairs with it and reaches the host through a bridge ticket; the host links
 * itself to Scout through the internal API with the token the server gave it. The test plays the gateway sending
 * Scout's calls: `call` posts one to the host's control server with the control token, as the real gateway does. Every
 * event, request and response goes through the protocol's schemas.
 */
export async function createEnvironmentAccessGateway(host: () => LaunchedHost | null, hostToken: string) {
  const requests: Array<{ key: string; body: unknown; auth: string | undefined }> = []
  const errors: string[] = []
  const tokens = new Map<string, string>()
  const streams = new Map<ServerResponse, string>()
  const tickets = new Set<string>()
  const links: Link[] = []
  const capabilities = ['provisioning', 'environments', FLEET_DESKTOP_BRIDGE_FEATURE]
  const environment = (id: string, name: string, patch: Record<string, unknown> = {}) =>
    fleetEnvironmentSchema.parse({
      id,
      name,
      lifecycle: 'running',
      setup: { step: 'ready', error: null, errorMessage: null },
      resources: { memoryBytes: GB, memoryLimitBytes: 4 * GB, cpuPercent: 3, startedAt: now() },
      memoryLimitBytes: null,
      appVersion: '0.21.0',
      capabilities,
      update: { available: false, pendingSince: null },
      botIds: [],
      createdAt: now(),
      updatedAt: now(),
      ...patch,
    })
  const environments = [
    environment('acme', 'Acme', { botIds: ['scout'] }),
    environment(ENVIRONMENT_ID, 'Personal', {
      kind: 'workspaces',
      capabilities: ['provisioning', 'environments', 'workspaces-host', FLEET_HOST_DESKTOP_CALLS_FEATURE],
    }),
  ]
  const bot = fleetBotSchema.parse({
    id: 'scout',
    name: 'Scout',
    environmentId: 'acme',
    capabilities,
    role: 'Develops',
    instructions: 'Synthetic bot that works in the owner’s projects',
    tint: '#6688aa',
    ceiling: 'auto',
    selection: null,
    talksTo: [],
    paused: false,
    lifecycle: 'running',
    setup: { step: 'ready', error: null, errorMessage: null },
    status: 'idle',
    activity: null,
    pendingCount: 0,
    accounts: { connected: true, providers: [] },
    takeover: { state: 'none', deviceId: null, deviceName: null, since: null },
    resources: { memoryBytes: null, memoryLimitBytes: null, cpuPercent: null, startedAt: null },
    screen: { width: 1280, height: 800, display: ':1' },
    appVersion: '0.21.0',
    createdAt: now(),
    updatedAt: now(),
  })
  const view = (link: Link, self: boolean): FleetDesktopLinkView => ({
    desktopId: link.desktopId,
    name: link.name,
    kind: 'environment',
    online: true,
    lastSeenAt: null,
    linkedAt: link.linkedAt,
    self,
    environmentId: ENVIRONMENT_ID,
  })
  const write = (response: ServerResponse, event: FleetGatewayEvent) => {
    const valid = fleetGatewayEventSchema.safeParse(event)
    if (!valid.success) errors.push('event ' + event.type + ': ' + valid.error.message)
    response.write(`event: fleet\ndata: ${JSON.stringify(event)}\n\n`)
  }
  const notify = (botId: string) => {
    const views = links.filter((link) => link.botId === botId).map((link) => view(link, false))
    for (const response of streams.keys())
      write(response, { type: 'desktop_link.updated', at: now(), botId, links: views })
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const send = (status: number, value?: unknown) => {
      if (value === undefined) return response.writeHead(status).end()
      response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value))
    }
    const internal = url.pathname.startsWith('/internal/')
    const entry = routeOf(internal ? FLEET_INTERNAL_ROUTES : FLEET_GATEWAY_ROUTES, request.method ?? '', url.pathname)
    if (!entry) return send(404, { code: 'NOT_FOUND', message: 'Route not found' })
    const [key, route] = entry
    if (request.headers['x-maestrly-fleet-protocol'] !== '1')
      return send(426, { code: 'PROTOCOL_INCOMPATIBLE', message: 'Bad protocol' })
    const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? ''
    const deviceId = tokens.get(token)
    // The internal API takes the host's token only, for its own links; the public API a paired device's.
    if (internal && (token !== hostToken || !key.startsWith('hostDesktopLink')))
      return send(403, { code: 'FORBIDDEN', message: 'Host token is limited to artifacts and its own bot links' })
    if (!internal && key !== 'meta' && key !== 'pair' && !deviceId)
      return send(401, { code: 'UNAUTHORIZED', message: 'Unknown' })
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const text = Buffer.concat(chunks).toString('utf8')
    const body: unknown = text ? JSON.parse(text) : undefined
    if (route.body) {
      const parsed = route.body.safeParse(body)
      if (!parsed.success) {
        errors.push('request ' + key + ': ' + parsed.error.message)
        return send(400, { code: 'INVALID_REQUEST', message: 'Invalid request' })
      }
    }
    requests.push({ key, body, auth: request.headers.authorization })
    const reply = (value: unknown) => {
      const parsed = route.response?.safeParse(value)
      if (parsed && !parsed.success) errors.push('response ' + key + ': ' + parsed.error.message)
      send(200, value)
    }
    const id = url.pathname.split('/')[internal ? 5 : 3] ?? ''
    switch (key) {
      case 'hostDesktopLinks':
        return reply({
          links: links.map((link): FleetHostDesktopLink => ({ ...view(link, true), botId: link.botId })),
        })
      case 'hostDesktopLinkPut': {
        if (id !== bot.id) return send(404, { code: 'NOT_FOUND', message: 'Bot not found' })
        const name = (body as { name: string }).name
        let link = links.find((item) => item.botId === id)
        if (link) link.name = name
        else {
          link = { botId: id, desktopId: 'dsk_' + randomBytes(16).toString('base64url'), name, linkedAt: now() }
          links.push(link)
        }
        notify(id)
        return reply({ ...view(link, true), botId: id })
      }
      case 'hostDesktopLinkDelete': {
        const index = links.findIndex((item) => item.botId === id)
        if (index >= 0) links.splice(index, 1)
        notify(id)
        return send(204)
      }
      case 'meta':
        return reply({
          protocol: 1,
          gatewayVersion: '0.21.0',
          botImage: 'e2e',
          botImageVersion: null,
          features: ['provisioning', 'environments', FLEET_DESKTOP_BRIDGE_FEATURE, 'workspaces-host'],
          moreFeatures: [FLEET_HOST_DESKTOP_CALLS_FEATURE],
        })
      case 'pair': {
        const issued = 'token-' + randomBytes(8).toString('hex')
        tokens.set(issued, 'device-' + tokens.size)
        return reply({ deviceId: tokens.get(issued), token: issued })
      }
      case 'events': {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        streams.set(response, deviceId!)
        write(response, { type: 'hello', at: now(), lastActivitySeq: 0 })
        request.on('close', () => streams.delete(response))
        return
      }
      case 'host':
        return reply(
          fleetHostInfoSchema.parse({
            hostname: 'fleet-environment-access',
            os: 'Linux',
            kernel: '6.8',
            arch: 'x64',
            cpus: 4,
            cpuPercent: 5,
            memory: { totalBytes: 16 * GB, usedBytes: 4 * GB, botsBytes: GB },
            disk: { totalBytes: 100 * GB, usedBytes: 20 * GB },
            uptimeSeconds: 600,
            gatewayVersion: '0.21.0',
            botImage: 'e2e',
            botImageVersion: null,
            dockerVersion: '28',
          })
        )
      case 'botsList':
        return reply({ bots: [bot] })
      case 'botGet':
        return reply(bot)
      case 'environmentsList':
        return reply({ environments })
      case 'environmentGet':
        return reply(environments.find((item) => item.id === id) ?? environments[0])
      case 'inbox':
        return reply({ items: [] })
      case 'peerMessages':
        return reply({ messages: [] })
      case 'activity':
        return reply({ entries: [], lastSeq: 0 })
      case 'archivedBotsList':
        return reply({ bots: [] })
      case 'archivedEnvironmentsList':
        return reply({ environments: [] })
      case 'botTranscript':
        return reply({ items: [], before: null })
      case 'botSelections':
      case 'environmentSelections':
        return reply({ options: [], current: null })
      case 'botRoutinesList':
        return reply({ routines: [] })
      case 'botMemoriesList':
        return reply({ memories: [] })
      case 'ownerMemoryList':
        return reply({ revision: 0, activeChars: 0, entries: [] })
      case 'botDesktopLinks':
        return reply({ links: links.filter((link) => link.botId === id).map((link) => view(link, false)) })
      case 'environmentBridgeTicket': {
        if (id !== ENVIRONMENT_ID) return send(409, { code: 'CONFLICT', message: 'Not a workspaces environment.' })
        const ticket = randomUUID().replaceAll('-', '')
        tickets.add(ticket)
        return send(201, { ticket, path: `/v1/bridge?ticket=${ticket}`, expiresAt: new Date(Date.now() + 30_000) })
      }
      default:
        return send(404, { code: 'NOT_FOUND', message: 'Not in this fixture: ' + key })
    }
  })
  // The bridge, as the real gateway runs it: a one-use ticket, then the handshake passed to the host with its token.
  const bridges = new Set<Duplex>()
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const target = host()
    const refuse = (status: number) => socket.end(`HTTP/1.1 ${status} Refused\r\nContent-Length: 0\r\n\r\n`)
    if (url.pathname !== '/v1/bridge' || request.headers.origin !== undefined) return refuse(403)
    if (!tickets.delete(url.searchParams.get('ticket') ?? '')) return refuse(403)
    if (!target) return refuse(503)
    const headers: Record<string, string> = {
      'X-Maestrly-Fleet-Protocol': '1',
      Authorization: `Bearer ${target.token}`,
      Connection: 'Upgrade',
      Upgrade: 'websocket',
    }
    for (const name of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions'])
      if (typeof request.headers[name] === 'string') headers[name] = request.headers[name]
    const upstream = http.request({ host: '127.0.0.1', port: target.port, path: '/v1/bridge', headers })
    upstream.on('upgrade', (answer, tcp, extra) => {
      const lines = ['HTTP/1.1 101 Switching Protocols']
      for (let index = 0; index < answer.rawHeaders.length; index += 2)
        lines.push(`${answer.rawHeaders[index]}: ${answer.rawHeaders[index + 1]}`)
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (extra.length) socket.write(extra)
      if (head.length) tcp.write(head)
      bridges.add(socket)
      const done = () => {
        bridges.delete(socket)
        tcp.destroy()
        socket.destroy()
      }
      for (const end of [tcp, socket]) end.on('close', done).on('error', done)
      socket.pipe(tcp).pipe(socket)
    })
    upstream.on('response', () => refuse(502))
    upstream.on('error', () => refuse(502))
    upstream.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  return {
    url,
    requests,
    errors,
    /** The link the host holds for Scout, as the server keeps it. */
    link: () => links.find((link) => link.botId === bot.id) ?? null,
    /** Scout's call for the environment, posted to the host's control server as the gateway posts it. */
    async call(op: FleetDesktopOp, input: Record<string, unknown> = {}): Promise<FleetDesktopCallResult> {
      const target = host()
      if (!target) throw new Error('No host runs')
      const response = await fetch(`http://127.0.0.1:${target.port}/v1/host/desktop-calls`, {
        method: 'POST',
        headers: {
          'X-Maestrly-Fleet-Protocol': '1',
          Authorization: `Bearer ${target.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          callId: randomUUID(),
          botId: bot.id,
          desktopId: links.find((link) => link.botId === bot.id)?.desktopId ?? 'dsk_nonenonenonenonenonen',
          op,
          input,
          expiresAt: new Date(Date.now() + 25_000).toISOString(),
        }),
      })
      if (!response.ok) throw new Error(`The host answered ${response.status}`)
      return fleetDesktopCallResultSchema.parse(await response.json())
    },
    async close() {
      for (const response of streams.keys()) response.destroy()
      for (const socket of bridges) socket.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
