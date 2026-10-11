import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import {
  FLEET_DESKTOP_BRIDGE_FEATURE,
  FLEET_GATEWAY_ROUTES,
  fleetBotSchema,
  fleetEnvironmentSchema,
  fleetGatewayEventSchema,
  fleetHostInfoSchema,
  type FleetDesktopCallResult,
  type FleetDesktopLinkView,
  type FleetDesktopOp,
  type FleetGatewayEvent,
} from '@maestrly/bot-fleet-protocol'

const now = () => new Date().toISOString()
const GB = 1024 ** 3
/** The desktop id another of the owner's computers holds for Scout: offline, linked before this run. */
export const OTHER_DESKTOP_ID = 'dsk_otherotherotherotherot'

type Link = { botId: string; deviceId: string; desktopId: string; name: string; linkedAt: string }

/**
 * A bot server with one environment and one bot, Scout, as the owner's computer reaches it: pairing, the event stream
 * and the desktop bridge routes. The test plays the bot through it: `call` sends a desktop call on this computer's
 * own stream and waits for the answer it posts. Every event and response goes through the protocol's schemas.
 */
export async function createDesktopBridgeGateway() {
  const requests: Array<{ key: string; body: unknown; path: string }> = []
  const errors: string[] = []
  const tokens = new Map<string, string>()
  const streams = new Map<ServerResponse, { deviceId: string; bridge: boolean }>()
  const pending = new Map<string, { deviceId: string; resolve: (result: FleetDesktopCallResult) => void }>()
  const links: Link[] = [
    {
      botId: 'scout',
      deviceId: 'device-other',
      desktopId: OTHER_DESKTOP_ID,
      name: 'iMac da sala',
      linkedAt: '2026-10-01T10:00:00.000Z',
    },
  ]
  const capabilities = ['provisioning', 'environments', FLEET_DESKTOP_BRIDGE_FEATURE]
  const environment = fleetEnvironmentSchema.parse({
    id: 'acme',
    name: 'Acme',
    lifecycle: 'running',
    setup: { step: 'ready', error: null, errorMessage: null },
    resources: { memoryBytes: GB, memoryLimitBytes: 4 * GB, cpuPercent: 3, startedAt: now() },
    memoryLimitBytes: null,
    appVersion: '0.14.1',
    capabilities,
    botIds: ['scout'],
    createdAt: now(),
    updatedAt: now(),
  })
  const bot = fleetBotSchema.parse({
    id: 'scout',
    name: 'Scout',
    environmentId: 'acme',
    capabilities,
    role: 'Desenvolve',
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
    appVersion: '0.14.1',
    createdAt: now(),
    updatedAt: now(),
  })
  const host = fleetHostInfoSchema.parse({
    hostname: 'fleet-bridge-host',
    os: 'Linux',
    kernel: '6.8',
    arch: 'x64',
    cpus: 4,
    cpuPercent: 5,
    memory: { totalBytes: 16 * GB, usedBytes: 4 * GB, botsBytes: GB },
    disk: { totalBytes: 100 * GB, usedBytes: 20 * GB },
    uptimeSeconds: 600,
    gatewayVersion: '0.14.1',
    botImage: 'e2e',
    botImageVersion: null,
    dockerVersion: '28',
  })
  const online = (deviceId: string) => [...streams.values()].some((item) => item.deviceId === deviceId && item.bridge)
  const views = (botId: string, deviceId: string): FleetDesktopLinkView[] =>
    links
      .filter((link) => link.botId === botId)
      .map((link) => ({
        desktopId: link.desktopId,
        name: link.name,
        online: online(link.deviceId),
        lastSeenAt: link.deviceId === 'device-other' ? '2026-10-04T18:00:00.000Z' : null,
        linkedAt: link.linkedAt,
        self: link.deviceId === deviceId,
      }))
  const write = (response: ServerResponse, event: FleetGatewayEvent) => {
    const valid = fleetGatewayEventSchema.safeParse(event)
    if (!valid.success) errors.push('event ' + event.type + ': ' + valid.error.message)
    response.write(`event: fleet\ndata: ${JSON.stringify(event)}\n\n`)
  }
  const notify = (botId: string) => {
    for (const [response, stream] of streams)
      if (stream.bridge)
        write(response, { type: 'desktop_link.updated', at: now(), botId, links: views(botId, stream.deviceId) })
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const send = (status: number, value?: unknown) => {
      if (value === undefined) return response.writeHead(status).end()
      response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value))
    }
    const entry = Object.entries(FLEET_GATEWAY_ROUTES).find(
      ([, route]) =>
        route.method === request.method && new RegExp(`^${route.path.replace(/:[^/]+/g, '[^/]+')}$`).test(url.pathname)
    )
    if (!entry) return send(404, { code: 'NOT_FOUND', message: 'Unknown route' })
    const [key, route] = entry
    if (request.headers['x-maestrly-fleet-protocol'] !== '1')
      return send(426, { code: 'PROTOCOL_INCOMPATIBLE', message: 'Bad protocol' })
    const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? ''
    const deviceId = tokens.get(token)
    if (key !== 'meta' && key !== 'pair' && !deviceId) return send(401, { code: 'UNAUTHORIZED', message: 'Unknown' })
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const text = Buffer.concat(chunks).toString('utf8')
    const body: unknown = text ? JSON.parse(text) : undefined
    if (route.body) {
      const parsed = route.body.safeParse(body)
      if (!parsed.success) errors.push('request ' + key + ': ' + parsed.error.message)
    }
    requests.push({ key, body, path: url.pathname })
    const reply = (value: unknown) => {
      const parsed = route.response?.safeParse(value)
      if (parsed && !parsed.success) errors.push('response ' + key + ': ' + parsed.error.message)
      send(200, value)
    }
    const id = url.pathname.split('/')[3] ?? ''
    switch (key) {
      case 'meta':
        return reply({
          protocol: 1,
          gatewayVersion: '0.14.1',
          botImage: 'e2e',
          botImageVersion: null,
          features: ['provisioning', 'environments', FLEET_DESKTOP_BRIDGE_FEATURE],
        })
      case 'pair': {
        const issued = 'token-' + randomBytes(8).toString('hex')
        tokens.set(issued, 'device-' + tokens.size)
        return reply({ deviceId: tokens.get(issued), token: issued })
      }
      case 'events': {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        const stream = { deviceId: deviceId!, bridge: url.searchParams.get('desktopBridge') === '1' }
        streams.set(response, stream)
        write(response, { type: 'hello', at: now(), lastActivitySeq: 0 })
        request.on('close', () => streams.delete(response))
        // A computer that connects hears the links of the bots it has, as the real server tells it.
        if (stream.bridge) notify('scout')
        return
      }
      case 'host':
        return reply(host)
      case 'botsList':
        return reply({ bots: [bot] })
      case 'botGet':
        return reply(bot)
      case 'environmentsList':
        return reply({ environments: [environment] })
      case 'environmentGet':
        return reply(environment)
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
      case 'botDesktopLinkPut': {
        const name = (body as { name: string }).name.trim()
        const existing = links.find((link) => link.botId === id && link.deviceId === deviceId)
        if (existing) existing.name = name
        else
          links.push({
            botId: id,
            deviceId: deviceId!,
            desktopId: 'dsk_' + randomBytes(16).toString('base64url'),
            name,
            linkedAt: now(),
          })
        notify(id)
        return reply(views(id, deviceId!).find((link) => link.self))
      }
      case 'botDesktopLinkDelete': {
        const index = links.findIndex((link) => link.botId === id && link.deviceId === deviceId)
        if (index >= 0) links.splice(index, 1)
        notify(id)
        return send(204)
      }
      case 'botDesktopLinks':
        return reply({ links: views(id, deviceId!) })
      case 'botDesktopLinkRemove': {
        const desktopId = url.pathname.split('/')[5]
        const index = links.findIndex((link) => link.botId === id && link.desktopId === desktopId)
        if (index < 0) return send(404, { code: 'NOT_FOUND', message: 'Desktop link not found' })
        links.splice(index, 1)
        notify(id)
        return send(204)
      }
      case 'desktopCallResult': {
        const callId = url.pathname.split('/')[3]
        const call = pending.get(callId)
        if (!call) return send(404, { code: 'NOT_FOUND', message: 'Desktop call not found or already answered' })
        if (call.deviceId !== deviceId) return send(403, { code: 'FORBIDDEN', message: 'Another computer' })
        pending.delete(callId)
        call.resolve(body as FleetDesktopCallResult)
        return send(204)
      }
      default:
        return send(404, { code: 'NOT_FOUND', message: 'Not in this fixture: ' + key })
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  return {
    url,
    requests,
    errors,
    /** Streams open that take desktop calls. */
    bridges: () => [...streams.values()].filter((stream) => stream.bridge).length,
    /** This computer's own link for Scout, as the server holds it. */
    selfLink: () => links.find((link) => link.botId === 'scout' && link.deviceId !== 'device-other') ?? null,
    /**
     * Scout's call for one computer, sent on the paired computer's stream; `timeout` when nobody answers in time.
     * `desktopId` defaults to the link this computer holds.
     */
    call(
      op: FleetDesktopOp,
      input: Record<string, unknown> = {},
      options: { desktopId?: string; timeoutMs?: number } = {}
    ) {
      const self = this.selfLink()
      const target = [...streams.entries()].find(([, stream]) => stream.bridge && stream.deviceId !== 'device-other')
      if (!target) throw new Error('This computer has no stream that takes desktop calls')
      const callId = randomUUID()
      const timeoutMs = options.timeoutMs ?? 30_000
      return new Promise<FleetDesktopCallResult | 'timeout'>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(callId)
          resolve('timeout')
        }, timeoutMs)
        pending.set(callId, {
          deviceId: target[1].deviceId,
          resolve: (result) => {
            clearTimeout(timer)
            resolve(result)
          },
        })
        write(target[0], {
          type: 'desktop.call',
          at: now(),
          callId,
          botId: 'scout',
          desktopId: options.desktopId ?? self?.desktopId ?? OTHER_DESKTOP_ID,
          op,
          input,
          expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
        })
      })
    },
    /** Another of the owner's computers removes this one's link, as the real server then tells every computer. */
    removeSelf() {
      const index = links.findIndex((link) => link.botId === 'scout' && link.deviceId !== 'device-other')
      if (index >= 0) links.splice(index, 1)
      notify('scout')
    },
    async close() {
      for (const response of streams.keys()) response.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
