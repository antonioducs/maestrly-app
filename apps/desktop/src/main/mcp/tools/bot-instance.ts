import {
  FLEET_ROUTINE_LIMITS,
  FLEET_PEER_THREAD_LIMITS,
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
import { runConversationText } from '../../fleet/instance/run-files'
import { getConversation } from '../../store'
import { gatewayRequest, keyForToolCall, type GatewayConfig } from '../../fleet/instance/gateway-client'
import { OwnerMemoryClient } from '../../fleet/instance/owner-memory'
import { THREAD_WAIT_SECONDS } from '../../fleet/instance/thread-waits'
import { isBotMode } from '../../fleet/instance/config'
import { canUseComputer, registerComputerTools, type ComputerToolOptions } from './computer'
import { conversationScreen } from '../../conversation-screen'
import type { BotRuntime } from '../../fleet/instance/runtime'
import type { McpToolContext } from './context'
import { err, ok } from './context'
import { registerBotFileTools } from './bot-files'
import { registerBotDesktopTools } from './bot-desktops'
import { registerBotRunnerTools } from './bot-runners'

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
 * input, owner-memory client and peer names. `gateway`, when given, replaces the bot's gateway access, and `desktops`
 * and `runners` then say whether that gateway routes desktop calls and runner jobs (the bot's profile says so otherwise).
 */
export function registerBotInstanceTools(
  ctx: McpToolContext,
  gateway?: GatewayConfig | null,
  options: { desktops?: boolean; runners?: boolean } = {}
): void {
  const bot = () => botRuntimeForConversation(ctx.convId)
  if (bot()) registerBotFileTools(ctx)
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
  // The computers that linked this bot: offered once its gateway routes desktop calls, even before any links it,
  // so the bot can tell its owner how to give it access.
  if (gateway === undefined ? bot()?.desktopBridgeEnabled : options.desktops) registerBotDesktopTools(ctx, gatewayFor)
  // The computers that run this bot's heavy jobs, once its gateway sends them.
  if (gateway === undefined ? bot()?.runnersEnabled : options.runners) registerBotRunnerTools(ctx, gatewayFor, bot)
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
        'Send a concise message to another bot by bot ID. The owner reads it rendered as Markdown: give a longer message short headings, lists or a table instead of one long paragraph. A message to a bot you are not already talking with here opens a conversation of its own with it, apart from this one, named by topic; its replies come there, and messages you send from it to the same bot stay in it. If you need the answer to finish this turn, call bot_peers_wait with the returned thread. Use only when coordination is useful; do not keep retrying rate limits. Answer another bot only when it moves the work forward, never to thanks or confirmations: not sending ends the exchange.',
      inputSchema: {
        to: fleetBotIdSchema,
        text: fleetPeerTextSchema,
        topic: z
          .string()
          .trim()
          .min(1)
          .max(FLEET_PEER_THREAD_LIMITS.topicMax)
          .optional()
          .describe('A short subject for the conversation this message opens.'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ to, text, topic }, extra) => {
      try {
        const runtime = bot()
        // In a conversation with this bot, the message stays in it; anywhere else it opens one.
        const lane = runtime?.runs.byConversation(ctx.convId)
        const continuing = lane?.kind === 'thread' && lane.peerBotId === to ? lane.runId : undefined
        const origin = ctx.convId === runtime?.primaryConversationId ? 'primary' : 'side'
        const result = await gatewayRequest(gatewayFor(), 'peerMessageSend', {
          to,
          text,
          idempotencyKey: keyForToolCall(extra),
          ...(continuing ? { thread: continuing } : { origin, ...(topic ? { topic } : {}) }),
        })
        const name = peerNames().get(to) ?? to
        if (continuing && runtime) runtime.noteThreadSent(continuing)
        if (result.thread && !continuing && runtime) {
          const asked = runtime.currentInput(ctx.convId)
          await runtime.recordThread(
            {
              threadId: result.thread,
              peerBotId: to,
              peerName: name,
              title: (topic ?? text.replace(/\s+/g, ' ').trim().slice(0, 60)) || 'Conversation',
              origin,
              opening: {
                sent: text.slice(0, 4000),
                ask: asked?.source === 'owner' ? asked.text.slice(0, 2000) || null : null,
              },
            },
            {
              kind: 'peer_out',
              id: 'thread-open:' + result.thread,
              at: new Date().toISOString(),
              to: { botId: to, name },
              text,
              delivered: result.delivered,
              thread: { id: result.thread },
            }
          )
        }
        return ok(
          JSON.stringify({
            ...result,
            to,
            name,
            status: result.delivered ? 'delivered' : 'queued',
            ...(result.thread && !continuing
              ? {
                  note: 'This opened a conversation of its own with this bot. Its replies come there, not here. If you need the answer to finish this turn, call bot_peers_wait with this thread.',
                }
              : {}),
          })
        )
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error))
      }
    }
  )
  ctx.server.registerTool(
    'bot_peers_report',
    {
      description:
        'In a conversation with another bot that you opened from your conversation with your owner: bring back a short answer to what your owner asked there. It shows in that conversation, where your owner reads it, and you see it there on your next turn. Report once you have what they need.',
      inputSchema: { text: z.string().trim().min(1).max(FLEET_PEER_THREAD_LIMITS.reportMax) },
      annotations: { readOnlyHint: false },
    },
    async ({ text }) => {
      const runtime = bot()
      const lane = runtime?.runs.byConversation(ctx.convId)
      if (!runtime || lane?.kind !== 'thread' || lane.origin !== 'primary')
        return err(
          'bot_peers_report works only in a conversation with another bot that you opened from your conversation with your owner.'
        )
      try {
        await gatewayRequest(gatewayFor(), 'peerThreadReport', { text }, { threadId: lane.runId })
        await runtime.reportThread(lane.runId, text)
        return ok(JSON.stringify({ reported: true }))
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error))
      }
    }
  )
  ctx.server.registerTool(
    'bot_peers_wait',
    {
      description:
        'Wait, within this turn, for the answer of a conversation with another bot that you opened with bot_peers_send: pass the thread it returned. Returns once that conversation brings back its answer (bot_peers_report there), or once the other bot answered and your side of that conversation ended its turn without writing again; or after timeoutSeconds while it is still working, when you may call it again or end your turn. Use it only when you need the answer to finish what you are doing.',
      inputSchema: {
        thread: z.string().trim().min(1).max(80).describe('The thread bot_peers_send returned.'),
        timeoutSeconds: z
          .number()
          .int()
          .min(THREAD_WAIT_SECONDS.min)
          .max(THREAD_WAIT_SECONDS.max)
          .optional()
          .describe(`Default ${THREAD_WAIT_SECONDS.default}.`),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ thread, timeoutSeconds }, extra) => {
      const runtime = bot()
      if (!runtime) return err('bot_peers_wait works only in a conversation of a bot.')
      if (runtime.runs.byConversation(ctx.convId)?.kind === 'thread')
        return err(
          "bot_peers_wait works outside your conversations with other bots: here, the other bot's replies come to you as messages. End your turn to wait for them."
        )
      try {
        const result = await runtime.waitThread(thread, {
          timeoutMs: (timeoutSeconds ?? THREAD_WAIT_SECONDS.default) * 1000,
          signal: extra.signal,
        })
        const record = runtime.runs.thread(thread)
        const name = record?.peerName ?? peerNames().get(record?.peerBotId ?? '') ?? record?.peerBotId ?? null
        const note =
          result.status === 'reported'
            ? 'That conversation brought back this answer.'
            : result.status === 'answered'
              ? 'The other bot answered and that conversation settled: peerReply is its last message, finalText what you concluded there.'
              : result.status === 'waiting'
                ? `Still working: call bot_peers_wait again, or end your turn.${record?.origin === 'primary' ? ' The answer it reports will be in your memory on your next turn here.' : ''}`
                : 'The wait was cancelled.'
        return ok(JSON.stringify({ ...result, thread, name, note }))
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error))
      }
    }
  )
  const runsWhere = bot()?.routineConversations
    ? 'in a conversation of its own, separate from this one: the owner reads it there, can ask you for changes in it afterwards, and you read past runs with bot_routines_runs'
    : 'as a new "Scheduled routine" message in this conversation'
  const routineDescription = `A routine runs on the server at its time ${runsWhere}, even while the owner's computer is off. Write a self-contained prompt. Each run is a full turn using the owner's model quota; intervals are at least ${FLEET_ROUTINE_LIMITS.intervalMinMinutes} minutes, so choose the longest that works. A run is skipped while its previous run is unfinished. The owner may need to approve this call. You may create at most ${FLEET_ROUTINE_LIMITS.botCreatedMax} routines. The owner sees routines marked as bot-created in Settings → Routines and can edit or delete any; you may change or delete only ones you created.`
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
        'Save a stable preference or fact about your owner, shared with the bots in your environment and shown to the owner in their Maestrly app. Your owner can make it global. One idea per entry, written as a short directive ("Prefer…", "Never…") or a plain fact, up to 500 characters, in the owner’s language. Replace an outdated entry from your environment by passing its id as replaces_id instead of adding a contradicting one. You cannot replace global entries or entries from another environment. Never store secrets.',
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
          origin: bot()?.currentInput(ctx.convId)?.source ?? 'owner',
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
        'Remove an owner memory entry from your environment that is wrong or no longer true. You cannot remove global entries or entries from another environment. The owner can restore it in their Maestrly app.',
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
        "Record what this scheduled routine run did, what is still pending and notes for the next run. The next run receives this report. Call it once, before you finish a routine run; in a run's own conversation, call it again when the owner's changes there change what the run did.",
      inputSchema: {
        summary: z.string().trim().min(1).max(FLEET_ROUTINE_RUN_LIMITS.summaryMax),
        pending: z.string().trim().max(FLEET_ROUTINE_RUN_LIMITS.pendingMax).optional(),
        notes_for_next_run: z.string().trim().max(FLEET_ROUTINE_RUN_LIMITS.notesMax).optional(),
        nothing_new: z
          .boolean()
          .optional()
          .describe(
            "True when the run found nothing worth the owner's attention: it is grouped with others like it and the owner is not alerted."
          ),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ summary, pending, notes_for_next_run, nothing_new }) => {
      const routine = bot()?.currentInput(ctx.convId)?.routine
      if (!routine?.runId) return err('routine_report works only while running a scheduled routine.')
      try {
        await gatewayRequest(
          gatewayFor(),
          'routineRunReport',
          {
            summary,
            pending: pending || null,
            notes: notes_for_next_run || null,
            ...(nothing_new !== undefined ? { quiet: nothing_new } : {}),
          },
          { rid: routine.id, runId: routine.runId }
        )
        return ok(JSON.stringify({ reported: true, routineId: routine.id }))
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error))
      }
    }
  )
  if (!bot()?.routineConversations) return
  ctx.server.registerTool(
    'bot_routines_runs',
    {
      description:
        "List your routine runs, newest first, or read one with run_id: its report, its final answer, what its conversation shows, and the files kept of it. Each run works in a conversation of its own that your conversation with the owner does not show: read a run here when the owner asks about it or refers to it. Files a run wrote are in your conversation folder; a deleted run's images and attachments are under the folder it names. To change what a run did, the owner asks in that run's conversation.",
      inputSchema: {
        run_id: fleetIdSchema.optional().describe('Read this run.'),
        routine_id: fleetIdSchema.optional().describe('List only the runs of this routine.'),
        limit: z.number().int().min(1).max(50).optional().describe('How many runs to list (default 10).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ run_id, routine_id, limit }) => {
      try {
        if (!run_id) {
          const page = await gatewayRequest(gatewayFor(), 'routineRunsList', undefined, {}, undefined, {
            limit: limit ?? 10,
            routineId: routine_id,
          })
          return ok(
            JSON.stringify({
              runs: page.runs.map((run) => ({
                id: run.id,
                routineId: run.routineId,
                routine: run.routineTitle,
                at: run.deliveredAt,
                status: run.status,
                nothingNew: run.quiet,
                summary: run.report?.summary ?? null,
                pending: run.report?.pending ?? null,
                conversation: run.conversation,
              })),
              more: page.before !== null,
            })
          )
        }
        const run = await gatewayRequest(gatewayFor(), 'routineRunGet', undefined, { runId: run_id })
        const record = bot()?.runs.get(run_id)
        const conversation =
          record && getConversation(record.conversationId) ? runConversationText(record.conversationId) : null
        return ok(
          JSON.stringify({
            id: run.id,
            routineId: run.routineId,
            routine: run.routineTitle,
            at: run.deliveredAt,
            finishedAt: run.finishedAt,
            status: run.status,
            nothingNew: run.quiet,
            report: run.report,
            finalAnswer: run.finalText,
            ownerChanges: run.adjustments,
            conversation,
            ...(run.kept ? { keptFolder: run.kept.folder || null, keptFiles: run.kept.files } : {}),
          })
        )
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error))
      }
    }
  )
}

/** What the computer tools need of the bot whose conversation calls them. */
export type ComputerBot = Pick<BotRuntime, 'primaryConversationId' | 'laneComputer'>

/**
 * The screens of a bot's computer tools: its own conversation uses the bot's desktop, and each of its side
 * conversations a desktop of its own, started on its first use, so conversations working at once never share a mouse.
 */
export function botComputerOptions(
  resolve: (conversationId: string) => ComputerBot | null = (conversationId) =>
    botRuntimeForConversation(conversationId)
): ComputerToolOptions {
  return {
    prepare: async (conversationId) => {
      const bot = resolve(conversationId)
      if (!bot || conversationId === bot.primaryConversationId)
        return { screen: conversationScreen(conversationId), notes: [] }
      const own = await bot.laneComputer(conversationId)
      if (!own) return { screen: conversationScreen(conversationId), notes: [] }
      const { display } = own
      const registered = conversationScreen(conversationId)
      return {
        screen: {
          display: display.display,
          width: display.width,
          height: display.height,
          windowArea: registered?.windowArea ?? { x: 0, y: 0, width: display.width, height: display.height },
        },
        notes: own.started
          ? [
              `Started this conversation's own desktop on display ${display.display}. Programs you start from a shell show on it while it runs; in this turn, run them with DISPLAY=${display.display}.`,
            ]
          : [],
      }
    },
  }
}

export function registerBotModeTools(
  ctx: McpToolContext,
  env: NodeJS.ProcessEnv = process.env,
  computerAvailable: () => boolean = canUseComputer
): void {
  if (!isBotMode(env)) return
  registerBotInstanceTools(ctx)
  if (computerAvailable()) registerComputerTools(ctx, botComputerOptions())
}
