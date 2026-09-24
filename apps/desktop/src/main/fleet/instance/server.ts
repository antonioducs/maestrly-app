import { createHash, timingSafeEqual } from 'node:crypto'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import {
  FLEET_INSTANCE_ROUTES,
  FLEET_PROTOCOL_HEADER,
  FLEET_PROTOCOL_VERSION,
  fleetInstanceEventSchema,
  type FleetInstanceEvent,
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
  health(): { ok: true; appVersion: string; protocol: 1; ready: boolean }
  status(): FleetInstanceStatus | Promise<FleetInstanceStatus>
  profile(value: FleetInstanceProfile): Promise<FleetInstanceStatus>
  selections(): Promise<{ options: FleetSelectionOption[]; current: FleetSelection | null }>
  addApiKeyAccount(value: FleetAddApiKeyAccountRequest): Promise<FleetAddApiKeyAccountResponse>
  removeAccount(providerId: string): Promise<void>
  transcript(before: string | null, limit: number): FleetTranscriptPage | Promise<FleetTranscriptPage>
  input(value: FleetInstanceInput): Promise<FleetInputReceipt>
  deleteInput(id: string): Promise<void>
  cancel(): Promise<void>
  resolve(id: string, value: FleetInteractionResolution): Promise<void>
  hold(reason: 'takeover' | 'paused'): Promise<FleetInstanceHold>
  release(value: FleetInstanceReleaseRequest): Promise<FleetInstanceHold>
  open(target: 'accounts' | 'main'): Promise<void>
}
type EventPayload = {
  [K in FleetInstanceEvent['type']]: Omit<Extract<FleetInstanceEvent, { type: K }>, 'seq' | 'at'>
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
async function body(request: IncomingMessage, schema: z.ZodType | null): Promise<unknown> {
  if (schema && !request.headers['content-type']?.startsWith('application/json'))
    throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Expected a JSON request body.')
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > 1_048_576) throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Request body exceeds 1 MiB.')
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
function routeFor(method: string, pathname: string): { key: keyof typeof FLEET_INSTANCE_ROUTES; id?: string } | null {
  for (const [key, route] of Object.entries(FLEET_INSTANCE_ROUTES)) {
    if (route.method !== method) continue
    const pattern = route.path.replace(/:[A-Za-z][A-Za-z0-9_]*/g, '([^/]+)')
    const match = pathname.match(new RegExp('^' + pattern + '$'))
    if (match)
      return { key: key as keyof typeof FLEET_INSTANCE_ROUTES, id: match[1] ? decodeURIComponent(match[1]) : undefined }
  }
  return null
}
function sseFrame(event: FleetInstanceEvent): string {
  return `id: ${event.seq}\nevent: fleet\ndata: ${JSON.stringify(event)}\n\n`
}
export function createInstanceControlServer(
  config: BotInstanceConfig,
  control: InstanceControl,
  events: InstanceEvents
): http.Server {
  return http.createServer(async (request, response) => {
    try {
      if ('origin' in request.headers) throw new InstanceHttpError(403, 'FORBIDDEN', 'Origin requests are forbidden.')
      if (request.headers[FLEET_PROTOCOL_HEADER.toLowerCase()] !== String(FLEET_PROTOCOL_VERSION))
        throw new InstanceHttpError(426, 'PROTOCOL_INCOMPATIBLE', 'Incompatible fleet protocol.')
      if (!authorized(request.headers.authorization, config.controlToken))
        throw new InstanceHttpError(401, 'UNAUTHORIZED', 'Invalid control credentials.')
      const url = new URL(request.url ?? '/', 'http://localhost')
      const match = routeFor(request.method ?? '', url.pathname)
      if (!match) throw new InstanceHttpError(404, 'NOT_FOUND', 'Route not found.')
      const route = FLEET_INSTANCE_ROUTES[match.key]
      const input = await body(request, route.body)
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
          response.write(sseFrame({ seq: events.lastSeq, at: new Date().toISOString(), type: 'reset' }))
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
          break
        case 'uiOpen':
          await control.open((input as { target: 'accounts' | 'main' }).target)
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
}
