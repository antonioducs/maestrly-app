import { createHash, randomUUID } from 'node:crypto'
import {
  FLEET_BOT_ENV,
  FLEET_INTERNAL_ROUTES,
  FLEET_PROTOCOL_HEADER,
  FLEET_PROTOCOL_VERSION,
  FLEET_ROUTINE_LIMITS,
  FLEET_ROUTINE_PROMPT_MAX,
  FLEET_ROUTINE_TITLE_MAX,
  buildPath,
  fleetBotIdSchema,
  fleetErrorEnvelopeSchema,
  fleetIdSchema,
  fleetPeerTextSchema,
  isValidTimeZone,
  type FleetRoutine,
  type FleetRoutineSchedule,
} from '@maestrly/bot-fleet-protocol'
import { z } from 'zod'
import { requestOwnerHelp } from '../../fleet/instance'
import { isBotMode } from '../../fleet/instance/config'
import { canUseComputer, registerComputerTools } from './computer'
import type { McpToolContext } from './context'
import { err, ok } from './context'

type GatewayConfig = { url: string; token: string }
const reasonSchema = z.string().trim().min(1).max(500)
const routineTitle = z.string().trim().min(1).max(FLEET_ROUTINE_TITLE_MAX).describe('Short name the owner sees.')
const routinePrompt = z
  .string()
  .trim()
  .min(1)
  .max(FLEET_ROUTINE_PROMPT_MAX)
  .describe('What to do on each run. Self-contained: it arrives as a new message with no other context.')
const everyMinutes = z
  .number()
  .int()
  .min(FLEET_ROUTINE_LIMITS.intervalMinMinutes)
  .max(FLEET_ROUTINE_LIMITS.intervalMaxMinutes)
  .describe(
    `Run every N minutes (${FLEET_ROUTINE_LIMITS.intervalMinMinutes}-${FLEET_ROUTINE_LIMITS.intervalMaxMinutes}), starting N minutes from now.`
  )
const routineTime = z
  .string()
  .regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/)
  .describe('Run at this 24-hour local time, HH:MM, in `timezone`.')
const routineDays = z
  .array(z.number().int().min(1).max(7))
  .max(7)
  .refine((days) => new Set(days).size === days.length, 'days must be unique')
  .describe('With `time`: ISO weekdays, 1 = Monday … 7 = Sunday. Omit or leave empty for every day.')
const routineTimezone = z
  .string()
  .min(1)
  .max(64)
  .describe('With `time`: IANA time zone such as America/Sao_Paulo. Defaults to your own time zone.')
const routineEnabled = z.boolean().describe('Whether it runs. Defaults to true on create.')
const routineFields = {
  title: routineTitle,
  prompt: routinePrompt,
  everyMinutes: everyMinutes.optional(),
  time: routineTime.optional(),
  days: routineDays.optional(),
  timezone: routineTimezone.optional(),
  enabled: routineEnabled.optional(),
}
const routineHint = ' Check Settings → Routines or ask your owner.'
function routineOutput(routine: FleetRoutine) {
  const { id, title, prompt, schedule, enabled, nextRunAt, lastRunAt, lastOutcome, createdBy } = routine
  return {
    id,
    title,
    prompt,
    schedule,
    enabled,
    nextRunAt,
    lastRunAt,
    lastOutcome,
    createdBy,
    canChange: createdBy === 'bot',
  }
}
function weekly(
  time: string,
  days: number[] = [],
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
): FleetRoutineSchedule {
  if (!isValidTimeZone(timezone)) throw new Error('Invalid time zone.' + routineHint)
  return { kind: 'weekly', time, days, timezone }
}
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
  body?: unknown,
  params: Record<string, string> = {}
): Promise<z.infer<Extract<(typeof FLEET_INTERNAL_ROUTES)[K]['response'], z.ZodType>>> {
  const route = FLEET_INTERNAL_ROUTES[routeKey]
  const routineRequest = routeKey.startsWith('routine')
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
    if (routineRequest && ['FORBIDDEN', 'CONFLICT', 'NOT_FOUND', 'INVALID_REQUEST'].includes(code ?? ''))
      throw new Error((envelope.success ? envelope.data.message : 'Routine request failed.') + routineHint)
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
  if (response.status === 204)
    return undefined as z.infer<Extract<(typeof FLEET_INTERNAL_ROUTES)[K]['response'], z.ZodType>>
  let value: unknown
  try {
    value = await response.json()
  } catch {
    throw new Error('Gateway returned invalid JSON.')
  }
  const parsed = route.response?.safeParse(value)
  if (!parsed?.success)
    throw new Error(
      `Gateway returned an invalid ${routineRequest ? 'routine' : 'peer'} response. Check protocol versions.`
    )
  return parsed.data as z.infer<Extract<(typeof FLEET_INTERNAL_ROUTES)[K]['response'], z.ZodType>>
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
  const routineDescription = `A routine runs on the server at its time as a new "Scheduled routine" message in this conversation, even with the Mac off. Write a self-contained prompt. Each run is a full turn using the owner's model quota; intervals are at least ${FLEET_ROUTINE_LIMITS.intervalMinMinutes} minutes, so choose the longest that works. A run is skipped while its previous run is unfinished. The owner may need to approve this call. You may create at most ${FLEET_ROUTINE_LIMITS.botCreatedMax} routines. The owner sees routines marked as bot-created in Settings → Routines and can edit or delete any; you may change or delete only ones you created.`
  ctx.server.registerTool(
    'bot_routines_list',
    {
      description: 'List all your routines, including owner-created routines. ' + routineDescription,
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const result = await gatewayRequest(gateway, 'routinesList')
        return ok(JSON.stringify({ routines: result.routines.map(routineOutput) }))
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error))
      }
    }
  )
  ctx.server.registerTool(
    'bot_routines_create',
    {
      description: 'Create a server routine. Give exactly one of everyMinutes or time. ' + routineDescription,
      inputSchema: routineFields,
      annotations: { readOnlyHint: false },
    },
    async ({ title, prompt, everyMinutes, time, days, timezone, enabled }, extra) => {
      try {
        if ((everyMinutes === undefined) === (time === undefined))
          return err('Give exactly one of everyMinutes or time.')
        if (everyMinutes !== undefined && (days !== undefined || timezone !== undefined))
          return err('Days and timezone require a weekly time schedule.')
        const schedule: FleetRoutineSchedule =
          everyMinutes !== undefined ? { kind: 'interval', everyMinutes } : weekly(time!, days, timezone)
        const routine = await gatewayRequest(gateway, 'routineCreate', {
          title,
          prompt,
          schedule,
          enabled: enabled ?? true,
          idempotencyKey: keyForToolCall(extra),
        })
        return ok(JSON.stringify(routineOutput(routine)))
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error))
      }
    }
  )
  ctx.server.registerTool(
    'bot_routines_update',
    {
      description:
        'Update one of your bot-created routines. everyMinutes switches to interval; time switches to weekly. ' +
        routineDescription,
      inputSchema: {
        routineId: fleetIdSchema,
        title: routineTitle.optional(),
        prompt: routinePrompt.optional(),
        everyMinutes: everyMinutes.optional(),
        time: routineTime.optional(),
        days: routineDays.optional(),
        timezone: routineTimezone.optional(),
        enabled: routineEnabled.optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ routineId, title, prompt, everyMinutes, time, days, timezone, enabled }) => {
      try {
        if (everyMinutes !== undefined && time !== undefined) return err('Give only one of everyMinutes or time.')
        let schedule: FleetRoutineSchedule | undefined
        if (everyMinutes !== undefined) {
          if (days !== undefined || timezone !== undefined)
            return err('Days and timezone require a weekly time schedule.')
          schedule = { kind: 'interval', everyMinutes }
        } else if (time !== undefined || days !== undefined || timezone !== undefined) {
          const current = (await gatewayRequest(gateway, 'routinesList')).routines.find((item) => item.id === routineId)
          if (!current) return err('Routine not found.' + routineHint)
          if (current.createdBy !== 'bot') return err('Only your owner can change this routine.' + routineHint)
          const previous = current.schedule.kind === 'weekly' ? current.schedule : null
          if (!time && !previous) return err('Give time to switch an interval routine to weekly.')
          schedule = weekly(time ?? previous!.time, days ?? previous?.days ?? [], timezone ?? previous?.timezone)
        }
        const patch = {
          ...(title === undefined ? {} : { title }),
          ...(prompt === undefined ? {} : { prompt }),
          ...(schedule === undefined ? {} : { schedule }),
          ...(enabled === undefined ? {} : { enabled }),
        }
        const routine = await gatewayRequest(gateway, 'routinePatch', patch, { rid: routineId })
        return ok(JSON.stringify(routineOutput(routine)))
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error))
      }
    }
  )
  ctx.server.registerTool(
    'bot_routines_delete',
    {
      description: 'Delete one of your bot-created routines. ' + routineDescription,
      inputSchema: { routineId: fleetIdSchema },
      annotations: { readOnlyHint: false },
    },
    async ({ routineId }) => {
      try {
        const title = (await gatewayRequest(gateway, 'routinesList').catch(() => null))?.routines.find(
          (item) => item.id === routineId
        )?.title
        await gatewayRequest(gateway, 'routineDelete', undefined, { rid: routineId })
        return ok(JSON.stringify({ deleted: true, routineId, title }))
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
