import { createHash, randomUUID } from 'node:crypto'
import {
  FLEET_BOT_ENV,
  FLEET_INTERNAL_ROUTES,
  FLEET_PROTOCOL_HEADER,
  FLEET_PROTOCOL_VERSION,
  fleetBotIdSchema,
  fleetErrorEnvelopeSchema,
  fleetPeerTextSchema,
} from '@maestrly/bot-fleet-protocol'
import { z } from 'zod'
import { requestOwnerHelp } from '../../fleet/instance'
import { isBotMode } from '../../fleet/instance/config'
import { canUseComputer, registerComputerTools } from './computer'
import type { McpToolContext } from './context'
import { err, ok } from './context'

type GatewayConfig = { url: string; token: string }
const reasonSchema = z.string().trim().min(1).max(500)
const peerNames = new Map<string, string>()
function keyForToolCall(extra: unknown): string {
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

async function gatewayRequest<K extends keyof typeof FLEET_INTERNAL_ROUTES>(
  config: GatewayConfig,
  routeKey: K,
  body?: unknown
): Promise<z.infer<(typeof FLEET_INTERNAL_ROUTES)[K]['response']>> {
  const route = FLEET_INTERNAL_ROUTES[routeKey]
  let response: Response
  try {
    response = await fetch(new URL(route.path, config.url), {
      method: route.method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        [FLEET_PROTOCOL_HEADER]: String(FLEET_PROTOCOL_VERSION),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (error) {
    throw new Error(
      `Gateway unavailable. Check its connection and try later: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!response.ok) {
    const envelope = fleetErrorEnvelopeSchema.safeParse(await response.json().catch(() => null))
    const code = envelope.success ? envelope.data.code : null
    if (response.status === 403)
      throw new Error('Peer contact is not allowed by the bot ACL. Ask your owner to update permissions.')
    if (response.status === 429)
      throw new Error(
        'Peer messaging is rate-limited. Stop messaging peers and summarize the situation for your owner.'
      )
    if (code === 'BOT_NOT_RUNNING' || code === 'INSTANCE_UNAVAILABLE')
      throw new Error('Target bot is offline or unavailable. Check later or ask your owner.')
    if (code === 'PROTOCOL_INCOMPATIBLE')
      throw new Error('Gateway protocol is incompatible. Ask your owner to update the bot or gateway.')
    throw new Error(
      `Gateway rejected the peer request (HTTP ${response.status}). Check gateway configuration or ask your owner.`
    )
  }
  let value: unknown
  try {
    value = await response.json()
  } catch {
    throw new Error('Gateway returned invalid JSON.')
  }
  const parsed = route.response.safeParse(value)
  if (!parsed.success) throw new Error('Gateway returned an invalid peer response. Check protocol versions.')
  return parsed.data as z.infer<(typeof FLEET_INTERNAL_ROUTES)[K]['response']>
}

export function registerBotInstanceTools(ctx: McpToolContext, gateway = configuredGateway()): void {
  ctx.server.registerTool(
    'request_owner_help',
    {
      description:
        'Ask your owner for help with the screen or a blocking issue. After calling, end your turn; the owner will send a message when they hand the screen back.',
      inputSchema: { reason: reasonSchema },
      annotations: { readOnlyHint: false },
    },
    async ({ reason }) => {
      try {
        const helpId = await requestOwnerHelp(reason)
        return ok(
          `Owner notified (helpId: ${helpId}). End your turn now. You will receive a message when the owner hands the screen back.`
        )
      } catch (error) {
        return err(`Could not request owner help: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  )

  if (!gateway) return
  ctx.server.registerTool(
    'bot_peers_list',
    {
      description: 'List bots you may contact through the gateway, including their names, roles and status.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const result = await gatewayRequest(gateway, 'peers')
        for (const peer of result.peers) peerNames.set(peer.botId, peer.name)
        return ok(JSON.stringify(result))
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error))
      }
    }
  )
  ctx.server.registerTool(
    'bot_peers_send',
    {
      description:
        'Send a concise message to another bot by bot ID. Use only when coordination is useful; do not keep retrying rate limits.',
      inputSchema: { to: fleetBotIdSchema, text: fleetPeerTextSchema },
      annotations: { readOnlyHint: false },
    },
    async ({ to, text }, extra) => {
      try {
        const result = await gatewayRequest(gateway, 'peerMessageSend', {
          to,
          text,
          idempotencyKey: keyForToolCall(extra),
        })
        return ok(
          JSON.stringify({
            ...result,
            to,
            name: peerNames.get(to) ?? to,
            status: result.delivered ? 'delivered' : 'queued',
          })
        )
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error))
      }
    }
  )
}

export function registerBotModeTools(
  ctx: McpToolContext,
  env: NodeJS.ProcessEnv = process.env,
  computerAvailable: () => boolean = canUseComputer
): void {
  if (!isBotMode(env)) return
  registerBotInstanceTools(ctx, configuredGateway(env))
  if (computerAvailable()) registerComputerTools(ctx)
}
