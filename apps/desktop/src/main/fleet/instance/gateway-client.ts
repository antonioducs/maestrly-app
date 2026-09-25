import { createHash, randomUUID } from 'node:crypto'
import {
  FLEET_BOT_ENV,
  FLEET_INTERNAL_ROUTES,
  FLEET_PROTOCOL_HEADER,
  FLEET_PROTOCOL_VERSION,
  buildPath,
  fleetErrorEnvelopeSchema,
} from '@maestrly/bot-fleet-protocol'
import type { z } from 'zod'

export type GatewayConfig = { url: string; token: string }
const routineHint = ' Check Settings → Routines or ask your owner.'
export function keyForToolCall(extra: unknown): string {
  const meta = (extra as { _meta?: { toolCallId?: unknown } })._meta
  if (typeof meta?.toolCallId !== 'string' || !meta.toolCallId) return randomUUID()
  const hex = createHash('sha256').update(meta.toolCallId).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export function configuredGateway(env: NodeJS.ProcessEnv = process.env): GatewayConfig | null {
  const url = env[FLEET_BOT_ENV.gatewayUrl]
  const token = env[FLEET_BOT_ENV.gatewayToken]
  if (!url || !token) return null
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
    return { url: parsed.toString(), token }
  } catch {
    return null
  }
}

export async function gatewayRequest<K extends keyof typeof FLEET_INTERNAL_ROUTES>(
  config: GatewayConfig,
  routeKey: K,
  body?: unknown,
  params: Record<string, string> = {},
  signal: AbortSignal = AbortSignal.timeout(10_000)
): Promise<z.infer<Extract<(typeof FLEET_INTERNAL_ROUTES)[K]['response'], z.ZodType>>> {
  const route = FLEET_INTERNAL_ROUTES[routeKey]
  const routineRequest = routeKey.startsWith('routine')
  const ownerRequest = routeKey.startsWith('ownerMemory')
  const family = routineRequest ? 'routine' : ownerRequest ? 'owner memory' : 'peer'
  let response: Response
  try {
    response = await fetch(new URL(buildPath(route.path, params), config.url), {
      method: route.method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        [FLEET_PROTOCOL_HEADER]: String(FLEET_PROTOCOL_VERSION),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    })
  } catch (error) {
    throw new Error(
      `Gateway unavailable. Check its connection and try later: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!response.ok) {
    const envelope = fleetErrorEnvelopeSchema.safeParse(await response.json().catch(() => null))
    const code = envelope.success ? envelope.data.code : null
    if (ownerRequest && ['CONFLICT', 'NOT_FOUND', 'INVALID_REQUEST'].includes(code ?? ''))
      throw new Error(envelope.success ? envelope.data.message : 'Owner memory request failed.')
    if (routineRequest && ['FORBIDDEN', 'CONFLICT', 'NOT_FOUND', 'INVALID_REQUEST'].includes(code ?? ''))
      throw new Error((envelope.success ? envelope.data.message : 'Routine request failed.') + routineHint)
    if (!routineRequest && !ownerRequest && response.status === 403)
      throw new Error('Peer contact is not allowed by the bot ACL. Ask your owner to update permissions.')
    if (!routineRequest && !ownerRequest && response.status === 429)
      throw new Error(
        'Peer messaging is rate-limited. Stop messaging peers and summarize the situation for your owner.'
      )
    if (code === 'BOT_NOT_RUNNING' || code === 'INSTANCE_UNAVAILABLE')
      throw new Error('Target bot is offline or unavailable. Check later or ask your owner.')
    if (code === 'PROTOCOL_INCOMPATIBLE')
      throw new Error('Gateway protocol is incompatible. Ask your owner to update the bot or gateway.')
    throw new Error(
      `Gateway rejected the ${family} request (HTTP ${response.status}). Check gateway configuration or ask your owner.`
    )
  }
  if (response.status === 204)
    return undefined as z.infer<Extract<(typeof FLEET_INTERNAL_ROUTES)[K]['response'], z.ZodType>>
  let value: unknown
  try {
    value = await response.json()
  } catch {
    throw new Error('Gateway returned invalid JSON.')
  }
  const parsed = route.response?.safeParse(value)
  if (!parsed?.success) throw new Error(`Gateway returned an invalid ${family} response. Check protocol versions.`)
  return parsed.data as z.infer<Extract<(typeof FLEET_INTERNAL_ROUTES)[K]['response'], z.ZodType>>
}
