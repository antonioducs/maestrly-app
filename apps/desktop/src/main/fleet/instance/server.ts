import { createHash, timingSafeEqual } from 'node:crypto'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { createConnection, type Socket } from 'node:net'
import {
  FLEET_INSTANCE_ROUTES,
  type FleetLoginAttempt,
  type FleetLoginStartRequest,
  type FleetLoginCallbackRequest,
  type FleetLoginCallbackResponse,
  FLEET_SKILL_BODY_MAX,
  fleetSubscriptionKindSchema,
  fleetAccountSlotIdSchema,
  type FleetBotAccounts,
  type FleetAccountImportRequest,
  type FleetImportResults,
  type FleetSubscriptionKind,
  type FleetBotSkills,
  type FleetSkillInstallRequest,
  type FleetSkillInstallResponse,
  type FleetBotMcpServers,
  type FleetMcpImportRequest,
  FLEET_MESSAGE_BODY_MAX,
  FLEET_PROTOCOL_HEADER,
  FLEET_PROTOCOL_VERSION,
  FLEET_SCREEN_UPGRADE,
  fleetInstanceEventSchema,
  type FleetInstanceEvent,
  type FleetBotMemory,
  type FleetBotMemoryPatchRequest,
  type FleetInstanceStatus,
  type FleetInstanceProfile,
  type FleetInstanceInput,
  type FleetInteractionResolution,
  type FleetInstanceHold,
  type FleetInstanceReleaseRequest,
  type FleetSelectionOption,
  type FleetSelection,
  type FleetTranscriptPage,
  type FleetInputReceipt,
  type FleetAddApiKeyAccountRequest,
  type FleetAddApiKeyAccountResponse,
  type FleetConversationCallRequest,
  type FleetUiOpenRequest,
} from '@maestrly/bot-fleet-protocol'
import type { z } from 'zod'
import type { BotInstanceConfig } from './config'

export class InstanceHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}
export interface InstanceControl {
  startLogin(request: FleetLoginStartRequest): Promise<FleetLoginAttempt>
  login(loginId: string): FleetLoginAttempt
  loginCallback(loginId: string, request: FleetLoginCallbackRequest): Promise<FleetLoginCallbackResponse>
  submitLoginCode(loginId: string, code: string): Promise<FleetLoginAttempt>
  cancelLogin(loginId: string): Promise<void>
  accounts(): FleetBotAccounts
  importAccounts(request: FleetAccountImportRequest): Promise<FleetImportResults>
  removeSubscription(kind: FleetSubscriptionKind, slot: string): Promise<void>
  skills(): Promise<FleetBotSkills>
  installSkill(request: FleetSkillInstallRequest): Promise<FleetSkillInstallResponse>
  removeSkill(name: string): Promise<void>
  mcpServers(): FleetBotMcpServers
  importMcpServers(request: FleetMcpImportRequest): Promise<FleetImportResults>
  removeMcpServer(id: string): Promise<void>
  memories(status: 'active' | 'archived' | 'superseded' | 'all'): Promise<{ memories: FleetBotMemory[] }>
  patchMemory(id: string, patch: FleetBotMemoryPatchRequest): Promise<FleetBotMemory>
  deleteMemory(id: string): Promise<void>
  health(): { ok: true; appVersion: string; protocol: 1; ready: boolean }
  status(): FleetInstanceStatus | Promise<FleetInstanceStatus>
  profile(value: FleetInstanceProfile): Promise<FleetInstanceStatus>
  selections(): Promise<{ options: FleetSelectionOption[]; current: FleetSelection | null }>
  addApiKeyAccount(value: FleetAddApiKeyAccountRequest): Promise<FleetAddApiKeyAccountResponse>
  removeAccount(providerId: string): Promise<void>
  transcript(before: string | null, limit: number): FleetTranscriptPage | Promise<FleetTranscriptPage>
  image(imageId: string): Promise<{ mediaType: string; bytes: Uint8Array }>
  input(value: FleetInstanceInput): Promise<FleetInputReceipt>
  deleteInput(id: string): Promise<void>
  cancel(): Promise<void>
  resolve(id: string, value: FleetInteractionResolution): Promise<void>
  hold(reason: 'takeover' | 'paused'): Promise<FleetInstanceHold>
  release(value: FleetInstanceReleaseRequest): Promise<FleetInstanceHold>
  open(target: FleetUiOpenRequest['target']): Promise<void>
  conversationCall(value: FleetConversationCallRequest): Promise<{ result: unknown }>
}
// `botId` defaults to null when the event is parsed.
type EventPayload = {
  [K in FleetInstanceEvent['type']]: Omit<Extract<FleetInstanceEvent, { type: K }>, 'seq' | 'at' | 'botId'> & {
    botId?: string | null
  }
}[FleetInstanceEvent['type']]
export class InstanceEvents {
  private seq = 0
  private ring: FleetInstanceEvent[] = []
  private subscribers = new Set<(event: FleetInstanceEvent) => void>()
  get lastSeq(): number {
    return this.seq
  }
  publish(event: EventPayload): FleetInstanceEvent {
    const seq = this.seq + 1
    const payload = event.type === 'status' ? { ...event, status: { ...event.status, lastEventSeq: seq } } : event
    const full = fleetInstanceEventSchema.parse({ ...payload, seq, at: new Date().toISOString() })
    this.seq = seq
    this.ring.push(full)
    if (this.ring.length > 2_000) this.ring.shift()
    for (const send of this.subscribers) send(full)
    return full
  }
  replay(since: number): FleetInstanceEvent[] | null {
    if (since < 0 || !Number.isSafeInteger(since) || since > this.seq) return null
    if (this.ring.length && since < this.ring[0].seq - 1) return null
    return this.ring.filter((event) => event.seq > since)
  }
  subscribe(send: (event: FleetInstanceEvent) => void): () => void {
    this.subscribers.add(send)
    return () => {
      this.subscribers.delete(send)
    }
  }
}
const errorStatus = (status: number): string =>
  (
    ({
      400: 'INVALID_REQUEST',
      401: 'UNAUTHORIZED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      426: 'PROTOCOL_INCOMPATIBLE',
    }) as Record<number, string>
  )[status] ?? 'INTERNAL'
function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}
const hash = (value: string): Buffer => createHash('sha256').update(value).digest()
function authorized(input: string | undefined, expected: string): boolean {
  if (!input?.startsWith('Bearer ')) return false
  return timingSafeEqual(hash(input.slice(7)), hash(expected))
}
async function body(request: IncomingMessage, schema: z.ZodType | null, maxBytes = 1_048_576): Promise<unknown> {
  if (schema && !request.headers['content-type']?.startsWith('application/json'))
    throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Expected a JSON request body.')
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > maxBytes) throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Request body too large.')
    chunks.push(bytes)
  }
  if (!schema) return undefined
  try {
    return schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  } catch (error) {
    if (error instanceof InstanceHttpError) throw error
    throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Invalid request body.')
  }
}
function routeFor(
  method: string,
  pathname: string
): { key: keyof typeof FLEET_INSTANCE_ROUTES; id?: string; slot?: string } | null {
  for (const [key, route] of Object.entries(FLEET_INSTANCE_ROUTES)) {
    if (route.method !== method) continue
    const pattern = route.path.replace(/:[A-Za-z][A-Za-z0-9_]*/g, '([^/]+)')
    const match = pathname.match(new RegExp('^' + pattern + '$'))
    if (match)
      return {
        key: key as keyof typeof FLEET_INSTANCE_ROUTES,
        id: match[1] ? decodeURIComponent(match[1]) : undefined,
        slot: match[2] ? decodeURIComponent(match[2]) : undefined,
      }
  }
  return null
}
function sseFrame(event: FleetInstanceEvent): string {
  return `id: ${event.seq}\nevent: fleet\ndata: ${JSON.stringify(event)}\n\n`
}
export function createInstanceControlServer(
  config: BotInstanceConfig,
  control: InstanceControl,
  events: InstanceEvents,
  screenPorts: { view: number; control: number } = { view: 5901, control: 5900 }
): http.Server {
  const tunnels = new Set<{ mode: 'view' | 'control'; socket: import('node:stream').Duplex; vnc: Socket }>()
  const connecting = { view: 0, control: 0 }
  const server = http.createServer(async (request, response) => {
    try {
      if ('origin' in request.headers) throw new InstanceHttpError(403, 'FORBIDDEN', 'Origin requests are forbidden.')
      if (request.headers[FLEET_PROTOCOL_HEADER.toLowerCase()] !== String(FLEET_PROTOCOL_VERSION))
        throw new InstanceHttpError(426, 'PROTOCOL_INCOMPATIBLE', 'Incompatible fleet protocol.')
      if (!authorized(request.headers.authorization, config.controlToken))
        throw new InstanceHttpError(401, 'UNAUTHORIZED', 'Invalid control credentials.')
      const url = new URL(request.url ?? '/', 'http://localhost')
      const match = routeFor(request.method ?? '', url.pathname)
      if (!match) throw new InstanceHttpError(404, 'NOT_FOUND', 'Route not found.')
      if (match.key === 'screenView' || match.key === 'screenControl')
        throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Screen upgrade required.')
      const route = FLEET_INSTANCE_ROUTES[match.key]
      const input = await body(
        request,
        route.body,
        match.key === 'skillInstall'
          ? FLEET_SKILL_BODY_MAX
          : match.key === 'inputSend'
            ? FLEET_MESSAGE_BODY_MAX
            : 1_048_576
      )
      if (match.key === 'image') {
        const image = await control.image(match.id ?? '')
        response.writeHead(200, {
          'Content-Type': image.mediaType,
          'Content-Length': image.bytes.length,
          'Cache-Control': 'private, max-age=86400',
          'X-Content-Type-Options': 'nosniff',
        })
        response.end(Buffer.from(image.bytes))
        return
      }
      if (match.key === 'events') {
        const raw = url.searchParams.get('since') ?? '0'
        if (!/^\d+$/.test(raw)) throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Invalid event cursor.')
        const since = Number(raw)
        if (!Number.isSafeInteger(since)) throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Invalid event cursor.')
        const replay = events.replay(since)
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        if (replay === null)
          response.write(sseFrame({ seq: events.lastSeq, at: new Date().toISOString(), type: 'reset', botId: null }))
        else for (const event of replay) response.write(sseFrame(event))
        const unsubscribe = events.subscribe((event) => response.write(sseFrame(event)))
        const heartbeat = setInterval(() => response.write(': ping\n\n'), 15_000)
        request.on('close', () => {
          unsubscribe()
          clearInterval(heartbeat)
        })
        return
      }
      let output: unknown
      switch (match.key) {
        case 'loginStart':
          output = await control.startLogin(input as FleetLoginStartRequest)
          break
        case 'loginGet':
          output = control.login(match.id ?? '')
          break
        case 'loginCallback':
          output = await control.loginCallback(match.id ?? '', input as FleetLoginCallbackRequest)
          break
        case 'loginCode':
          output = await control.submitLoginCode(match.id ?? '', (input as { code: string }).code)
          break
        case 'loginCancel':
          await control.cancelLogin(match.id ?? '')
          break
        case 'accountsList':
          output = control.accounts()
          break
        case 'accountsImport':
          output = await control.importAccounts(input as FleetAccountImportRequest)
          break
        case 'subscriptionRemove': {
          const kind = fleetSubscriptionKindSchema.safeParse(match.id)
          const slot = match.slot === 'default' ? match.slot : fleetAccountSlotIdSchema.safeParse(match.slot).data
          if (!kind.success || !slot) throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Invalid subscription slot.')
          await control.removeSubscription(kind.data, slot)
          break
        }
        case 'skillsList':
          output = await control.skills()
          break
        case 'skillInstall':
          output = await control.installSkill(input as FleetSkillInstallRequest)
          break
        case 'skillRemove':
          await control.removeSkill(match.id ?? '')
          break
        case 'mcpServersList':
          output = control.mcpServers()
          break
        case 'mcpServersImport':
          output = await control.importMcpServers(input as FleetMcpImportRequest)
          break
        case 'mcpServerRemove':
          await control.removeMcpServer(match.id ?? '')
          break
        case 'memoriesList': {
          const raw = url.searchParams.get('status') ?? 'active'
          if (!['active', 'archived', 'superseded', 'all'].includes(raw))
            throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Invalid memory status.')
          output = await control.memories(raw as 'active' | 'archived' | 'superseded' | 'all')
          break
        }
        case 'memoryPatch':
          output = await control.patchMemory(match.id ?? '', input as FleetBotMemoryPatchRequest)
          break
        case 'memoryDelete':
          await control.deleteMemory(match.id ?? '')
          break
        case 'health':
          output = control.health()
          break
        case 'status':
          output = await control.status()
          break
        case 'profile':
          output = await control.profile(input as FleetInstanceProfile)
          break
        case 'selections':
          output = await control.selections()
          break
        case 'apiKeyAccountAdd':
          output = await control.addApiKeyAccount(input as FleetAddApiKeyAccountRequest)
          break
        case 'accountRemove':
          await control.removeAccount(match.id ?? '')
          break
        case 'transcript': {
          const raw = url.searchParams.get('limit')
          const limit = raw === null ? 200 : Number(raw)
          if (!Number.isInteger(limit) || limit < 1 || limit > 500)
            throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Invalid transcript limit.')
          output = await control.transcript(url.searchParams.get('before'), limit)
          break
        }
        case 'inputSend':
          output = await control.input(input as FleetInstanceInput)
          break
        case 'inputDelete':
          await control.deleteInput(match.id ?? '')
          break
        case 'turnCancel':
          await control.cancel()
          break
        case 'interactionResolve':
          await control.resolve(match.id ?? '', input as FleetInteractionResolution)
          break
        case 'hold':
          output = await control.hold((input as { reason: 'takeover' | 'paused' }).reason)
          break
        case 'holdRelease':
          output = await control.release(input as FleetInstanceReleaseRequest)
          if ((output as FleetInstanceHold).state !== 'held' || (output as FleetInstanceHold).reason !== 'takeover')
            for (const entry of tunnels) if (entry.mode === 'control') entry.socket.destroy()
          break
        case 'conversationCall':
          output = await control.conversationCall(input as FleetConversationCallRequest)
          break
        case 'uiOpen':
          await control.open((input as FleetUiOpenRequest).target)
          break
      }
      if (route.response) writeJson(response, 200, route.response.parse(output))
      else {
        response.writeHead(204)
        response.end()
      }
    } catch (error) {
      const known =
        error instanceof InstanceHttpError ? error : new InstanceHttpError(500, 'INTERNAL', 'Instance request failed.')
      writeJson(response, known.status, { code: known.code || errorStatus(known.status), message: known.message })
    }
  })
  const closeControls = events.subscribe((event) => {
    if (event.type === 'status' && (event.status.hold.state !== 'held' || event.status.hold.reason !== 'takeover')) {
      for (const entry of tunnels) if (entry.mode === 'control') entry.socket.destroy()
    }
  })
  const originalClose = server.close.bind(server)
  server.close = ((callback?: (error?: Error) => void) => {
    closeControls()
    for (const entry of tunnels) entry.socket.destroy()
    return originalClose(callback)
  }) as typeof server.close
  server.on('upgrade', (request, socket, head) => {
    const reject = (status: number, code: string, message: string) => {
      const body = JSON.stringify({ code, message })
      socket.write(
        `HTTP/1.1 ${status} Error\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
      )
      socket.end()
    }
    void (async () => {
      if ('origin' in request.headers) return reject(403, 'FORBIDDEN', 'Origin requests are forbidden.')
      if (request.headers[FLEET_PROTOCOL_HEADER.toLowerCase()] !== String(FLEET_PROTOCOL_VERSION))
        return reject(426, 'PROTOCOL_INCOMPATIBLE', 'Incompatible fleet protocol.')
      if (!authorized(request.headers.authorization, config.controlToken))
        return reject(401, 'UNAUTHORIZED', 'Invalid control credentials.')
      const url = new URL(request.url ?? '/', 'http://localhost')
      const mode =
        url.pathname === FLEET_INSTANCE_ROUTES.screenView.path
          ? 'view'
          : url.pathname === FLEET_INSTANCE_ROUTES.screenControl.path
            ? 'control'
            : null
      if (request.method !== 'GET' || !mode) return reject(404, 'NOT_FOUND', 'Route not found.')
      if (
        !request.headers.connection
          ?.toLowerCase()
          .split(',')
          .map((value) => value.trim())
          .includes('upgrade') ||
        request.headers.upgrade?.toLowerCase() !== FLEET_SCREEN_UPGRADE
      )
        return reject(400, 'INVALID_REQUEST', 'Screen upgrade required.')
      if (mode === 'control') {
        const hold = (await control.status()).hold
        if (hold.state !== 'held' || hold.reason !== 'takeover')
          return reject(409, 'CONFLICT', 'Takeover hold required.')
      }
      if ([...tunnels].filter((entry) => entry.mode === mode).length + connecting[mode] >= (mode === 'view' ? 4 : 1))
        return reject(409, 'CONFLICT', 'Screen tunnel limit reached.')
      connecting[mode]++
      const vnc = createConnection({ host: '127.0.0.1', port: screenPorts[mode] })
      await new Promise<void>((resolve, rejectConnection) => {
        vnc.once('connect', resolve)
        vnc.once('error', rejectConnection)
      }).catch(() => {
        connecting[mode]--
        throw new InstanceHttpError(503, 'INSTANCE_UNAVAILABLE', 'Screen unavailable.')
      })
      connecting[mode]--
      if (socket.destroyed) return vnc.destroy()
      if (mode === 'control') {
        const hold = (await control.status()).hold
        if (hold.state !== 'held' || hold.reason !== 'takeover') {
          vnc.destroy()
          return reject(409, 'CONFLICT', 'Takeover hold required.')
        }
      }
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: ${FLEET_SCREEN_UPGRADE}\r\n\r\n`
      )
      const entry: { mode: 'view' | 'control'; socket: import('node:stream').Duplex; vnc: Socket } = {
        mode,
        socket,
        vnc,
      }
      tunnels.add(entry)
      const cleanup = () => {
        tunnels.delete(entry)
        socket.destroy()
        vnc.destroy()
      }
      socket.on('close', cleanup)
      vnc.on('close', cleanup)
      socket.on('error', cleanup)
      vnc.on('error', cleanup)
      if (head.length && !vnc.write(head)) socket.pause()
      socket.pipe(vnc).pipe(socket)
    })().catch((error) => {
      const known =
        error instanceof InstanceHttpError ? error : new InstanceHttpError(500, 'INTERNAL', 'Screen request failed.')
      reject(known.status, known.code, known.message)
    })
  })
  return server
}
