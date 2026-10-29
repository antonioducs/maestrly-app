import { createHash, randomUUID } from 'node:crypto'
import {
  FLEET_INTERNAL_ROUTES,
  FLEET_PROTOCOL_HEADER,
  FLEET_PROTOCOL_VERSION,
  buildPath,
  fleetErrorEnvelopeSchema,
} from '@maestrly/bot-fleet-protocol'
import type { z } from 'zod'

export type GatewayConfig = { url: string; token: string }
const routineHint = ' Check Settings → Routines or ask your owner.'
const runnerHint = ' Call runner_list for your runners and runner_status for your jobs.'
/** A UUID shaped from the SHA-256 of `seed`: the same seed always gives the same one. */
export function uuidFromSeed(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
export function keyForToolCall(extra: unknown): string {
  const meta = (extra as { _meta?: { toolCallId?: unknown } })._meta
  if (typeof meta?.toolCallId !== 'string' || !meta.toolCallId) return randomUUID()
  return uuidFromSeed(meta.toolCallId)
}

export async function gatewayRequest<K extends keyof typeof FLEET_INTERNAL_ROUTES>(
  config: GatewayConfig,
  routeKey: K,
  body?: unknown,
  params: Record<string, string> = {},
  signal: AbortSignal = AbortSignal.timeout(10_000),
  query?: Record<string, string | number | undefined>
): Promise<z.infer<Extract<(typeof FLEET_INTERNAL_ROUTES)[K]['response'], z.ZodType>>> {
  const route = FLEET_INTERNAL_ROUTES[routeKey]
  const routineRequest = routeKey.startsWith('routine')
  const ownerRequest = routeKey.startsWith('ownerMemory')
  const artifactRequest = routeKey.startsWith('artifact')
  const desktopRequest = routeKey.startsWith('desktop')
  const hostLinkRequest = routeKey.startsWith('hostDesktop')
  const runnerRequest = routeKey === 'runners' || routeKey.startsWith('runnerJob')
  const family = hostLinkRequest
    ? 'bot access'
    : routineRequest
      ? 'routine'
      : ownerRequest
        ? 'owner memory'
        : artifactRequest
          ? 'artifact'
          : desktopRequest
            ? 'desktop'
            : runnerRequest
              ? 'runner'
              : 'peer'
  const peerRequest = family === 'peer'
  let response: Response
  try {
    response = await fetch(new URL(buildPath(route.path, params, query), config.url), {
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
    // A thread between bots that is not this one's, or a report it may not make, says why; anything else is the ACL.
    const threadRequest =
      routeKey === 'peerThreadReport' || typeof (body as { thread?: unknown } | undefined)?.thread === 'string'
    if (peerRequest && response.status === 403)
      throw new Error(
        threadRequest && envelope.success && envelope.data.message !== 'Peer is not allowed'
          ? envelope.data.message
          : 'Peer contact is not allowed by the bot ACL. Ask your owner to update permissions.'
      )
    // What a workspaces host's owner reads in its settings: the server's own reason (a bot gone, too many links), or,
    // from a server that predates bots' access to environments (no such route, or a host token for artifacts only),
    // what to do.
    if (hostLinkRequest && ['CONFLICT', 'NOT_FOUND', 'FORBIDDEN', 'INVALID_REQUEST'].includes(code ?? ''))
      throw new Error(
        envelope.success && code !== 'FORBIDDEN' && envelope.data.message !== 'Route not found'
          ? envelope.data.message
          : 'Update the bot server before giving bots access to this environment.'
      )
    // A job that is not this bot's, one refused as invalid, or a gateway that predates runners (no such route).
    if (runnerRequest && ['FORBIDDEN', 'CONFLICT', 'NOT_FOUND', 'INVALID_REQUEST'].includes(code ?? ''))
      throw new Error(
        envelope.success && envelope.data.message !== 'Route not found'
          ? envelope.data.message + runnerHint
          : 'This gateway does not offer runners. Ask your owner to update the bot server.'
      )
    if (desktopRequest && code === 'INVALID_REQUEST')
      throw new Error('The gateway refused this desktop call as invalid. Check desktopId and the arguments.')
    if (peerRequest && response.status === 429)
      throw new Error(
        envelope.success && envelope.data.message.includes('paused until your owner')
          ? `${envelope.data.message} Stop messaging this bot here and wait for your owner.`
          : 'Peer messaging is rate-limited. Stop messaging peers and summarize the situation for your owner.'
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
