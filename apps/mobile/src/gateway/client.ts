import {
  FLEET_GATEWAY_ROUTES,
  FLEET_PROTOCOL_HEADER,
  FLEET_PROTOCOL_VERSION,
  buildPath,
  fleetErrorEnvelopeSchema,
  type FleetErrorCode,
} from '@maestrly/bot-fleet-protocol'
import type { z } from 'zod'

type Routes = typeof FLEET_GATEWAY_ROUTES
export type RouteKey = keyof Routes
export type RouteResponse<K extends RouteKey> = Routes[K]['response'] extends z.ZodType
  ? z.output<Routes[K]['response']>
  : void
export type RouteBody<K extends RouteKey> = Routes[K]['body'] extends z.ZodType ? z.input<Routes[K]['body']> : undefined
export type CallOptions<K extends RouteKey> = {
  params?: Record<string, string | number>
  query?: Record<string, string | number | boolean | null | undefined>
  body?: RouteBody<K>
  timeoutMs?: number
}
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export class GatewayError extends Error {
  constructor(
    readonly code: FleetErrorCode | 'NETWORK' | 'TIMEOUT' | 'BAD_RESPONSE',
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'GatewayError'
  }
  /** Worth trying again later: the network or the server may come back. */
  get retryable(): boolean {
    return this.code === 'NETWORK' || this.code === 'TIMEOUT' || this.status >= 500
  }
}

// Lifecycle actions answer once the container is done; messages may carry 20 MiB of attachments.
const SLOW: Partial<Record<RouteKey, number>> = {
  botStart: 300_000,
  botStop: 300_000,
  botRestart: 300_000,
  botMessageSend: 120_000,
}

export function createGatewayClient(options: { origin: string; token: string | null; fetch: FetchLike }) {
  const headers = (): Record<string, string> => ({
    [FLEET_PROTOCOL_HEADER]: String(FLEET_PROTOCOL_VERSION),
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
  })
  async function call<K extends RouteKey>(key: K, o: CallOptions<K> = {}): Promise<RouteResponse<K>> {
    const route = FLEET_GATEWAY_ROUTES[key]
    const requestHeaders = headers()
    let body: string | undefined
    if (route.body) {
      body = JSON.stringify(route.body.parse(o.body))
      requestHeaders['Content-Type'] = 'application/json'
    }
    const url = options.origin + buildPath(route.path, o.params, o.query)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? SLOW[key] ?? 15_000)
    let response: Awaited<ReturnType<FetchLike>>
    try {
      response = await options.fetch(url, {
        method: route.method,
        headers: requestHeaders,
        body,
        signal: controller.signal,
      })
    } catch (error) {
      throw controller.signal.aborted
        ? new GatewayError('TIMEOUT', 0, 'The server took too long to answer')
        : new GatewayError('NETWORK', 0, error instanceof Error ? error.message : 'Network error')
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      const envelope = fleetErrorEnvelopeSchema.safeParse(await response.json().catch(() => null))
      if (envelope.success) throw new GatewayError(envelope.data.code, response.status, envelope.data.message)
      const code: FleetErrorCode =
        response.status === 401 ? 'UNAUTHORIZED' : response.status === 426 ? 'PROTOCOL_INCOMPATIBLE' : 'INTERNAL'
      throw new GatewayError(code, response.status, `Request failed (${response.status})`)
    }
    if (!route.response) return undefined as RouteResponse<K>
    const parsed = route.response.safeParse(await response.json().catch(() => undefined))
    if (!parsed.success) throw new GatewayError('BAD_RESPONSE', response.status, 'Unexpected server response')
    return parsed.data as RouteResponse<K>
  }
  return { origin: options.origin, headers, call }
}
export type GatewayClient = ReturnType<typeof createGatewayClient>
