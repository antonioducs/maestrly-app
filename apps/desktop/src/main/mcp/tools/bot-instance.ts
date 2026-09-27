import {
  FLEET_ROUTINE_LIMITS,
  FLEET_OWNER_MEMORY_LIMITS,
  FLEET_ROUTINE_RUN_LIMITS,
  FLEET_ROUTINE_PROMPT_MAX,
  FLEET_ROUTINE_TITLE_MAX,
  fleetBotIdSchema,
  fleetIdSchema,
  fleetPeerTextSchema,
  isValidTimeZone,
  type FleetRoutine,
  type FleetRoutineSchedule,
} from '@maestrly/bot-fleet-protocol'
import { z } from 'zod'
import { requestOwnerHelp, botRuntimeForConversation } from '../../fleet/instance'
import { gatewayRequest, keyForToolCall, type GatewayConfig } from '../../fleet/instance/gateway-client'
import { OwnerMemoryClient } from '../../fleet/instance/owner-memory'
import { isBotMode } from '../../fleet/instance/config'
import { canUseComputer, registerComputerTools } from './computer'
import type { McpToolContext } from './context'
import { err, ok } from './context'

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
/**
 * Registers the bot tools of a conversation. Each call resolves the conversation's own bot: its gateway token, current
 * input, owner-memory client and peer names. `gateway`, when given, replaces the bot's gateway access.
 */
export function registerBotInstanceTools(ctx: McpToolContext, gateway?: GatewayConfig | null): void {
  const bot = () => botRuntimeForConversation(ctx.convId)
  const localPeerNames = new Map<string, string>()
  const peerNames = () => bot()?.peerNames ?? localPeerNames
  const gatewayFor = (): GatewayConfig => {
    const config = gateway === undefined ? (bot()?.gatewayConfig ?? null) : gateway
    if (!config) throw new Error('The gateway has not connected this bot yet. Try again later or ask your owner.')
    return config
  }
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
        const helpId = await requestOwnerHelp(ctx.convId, reason)
        return ok(
          `Owner notified (helpId: ${helpId}). End your turn now. You will receive a message when the owner hands the screen back.`
        )
      } catch (error) {
        return err(`Could not request owner help: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  )

  if (gateway === undefined ? !bot()?.gatewayConfigured : !gateway) return
  ctx.server.registerTool(
    'bot_peers_list',
    {
      description: 'List bots you may contact through the gateway, including their names, roles and status.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const result = await gatewayRequest(gatewayFor(), 'peers')
        for (const peer of result.peers) peerNames().set(peer.botId, peer.name)
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
        const result = await gatewayRequest(gatewayFor(), 'peerMessageSend', {
          to,
          text,
          idempotencyKey: keyForToolCall(extra),
        })
        return ok(
          JSON.stringify({
            ...result,
            to,
            name: peerNames().get(to) ?? to,
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
        const result = await gatewayRequest(gatewayFor(), 'routinesList')
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
        const routine = await gatewayRequest(gatewayFor(), 'routineCreate', {
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
          const current = (await gatewayRequest(gatewayFor(), 'routinesList')).routines.find(
            (item) => item.id === routineId
          )
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
        const routine = await gatewayRequest(gatewayFor(), 'routinePatch', patch, { rid: routineId })
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
        const title = (await gatewayRequest(gatewayFor(), 'routinesList').catch(() => null))?.routines.find(
          (item) => item.id === routineId
        )?.title
        await gatewayRequest(gatewayFor(), 'routineDelete', undefined, { rid: routineId })
        return ok(JSON.stringify({ deleted: true, routineId, title }))
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error))
      }
    }
  )
  let fallbackOwnerMemory: OwnerMemoryClient | undefined
  const ownerMemory = () => bot()?.ownerMemory ?? (fallbackOwnerMemory ??= new OwnerMemoryClient(() => gateway ?? null))
  ctx.server.registerTool(
    'owner_memory_save',
    {
      description:
        'Save a stable preference or fact about your owner, shared with the bots in your environment and shown to the owner on their Mac. Your owner can make it global. One idea per entry, written as a short directive ("Prefer…", "Never…") or a plain fact, up to 500 characters, in the owner’s language. Replace an outdated entry from your environment by passing its id as replaces_id instead of adding a contradicting one. You cannot replace global entries or entries from another environment. Never store secrets.',
      inputSchema: {
        content: z.string().trim().min(1).max(FLEET_OWNER_MEMORY_LIMITS.entryMax),
        replaces_id: fleetIdSchema.optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ content, replaces_id }, extra) => {
      try {
        const entry = await ownerMemory().save({
          content,
          ...(replaces_id ? { replacesId: replaces_id } : {}),
          origin: bot()?.currentInput()?.source ?? 'owner',
          idempotencyKey: keyForToolCall(extra),
        })
        return ok(JSON.stringify({ saved: true, id: entry.id, content: entry.content }))
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error))
      }
    }
  )
  ctx.server.registerTool(
    'owner_memory_forget',
    {
      description:
        'Remove an owner memory entry from your environment that is wrong or no longer true. You cannot remove global entries or entries from another environment. The owner can restore it on their Mac.',
      inputSchema: { id: fleetIdSchema, reason: z.string().trim().min(1).max(FLEET_OWNER_MEMORY_LIMITS.reasonMax) },
      annotations: { readOnlyHint: false },
    },
    async ({ id, reason }) => {
      try {
        const entry = await ownerMemory().forget(id, reason)
        return ok(JSON.stringify({ forgotten: true, id: entry.id }))
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error))
      }
    }
  )
  ctx.server.registerTool(
    'routine_report',
    {
      description:
        'Record what this scheduled routine run did, what is still pending and notes for the next run. The next run receives this report. Call it once, before you finish a routine run.',
      inputSchema: {
        summary: z.string().trim().min(1).max(FLEET_ROUTINE_RUN_LIMITS.summaryMax),
        pending: z.string().trim().max(FLEET_ROUTINE_RUN_LIMITS.pendingMax).optional(),
        notes_for_next_run: z.string().trim().max(FLEET_ROUTINE_RUN_LIMITS.notesMax).optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ summary, pending, notes_for_next_run }) => {
      const routine = bot()?.currentInput()?.routine
      if (!routine?.runId) return err('routine_report works only while running a scheduled routine.')
      try {
        await gatewayRequest(
          gatewayFor(),
          'routineRunReport',
          { summary, pending: pending || null, notes: notes_for_next_run || null },
          { rid: routine.id, runId: routine.runId }
        )
        return ok(JSON.stringify({ reported: true, routineId: routine.id }))
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
  registerBotInstanceTools(ctx)
  if (computerAvailable()) registerComputerTools(ctx)
}
