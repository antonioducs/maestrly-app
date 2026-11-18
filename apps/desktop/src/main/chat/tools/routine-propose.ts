import { isValidTimeZone } from '@maestrly/bot-fleet-protocol'
import { z } from 'zod'
import {
  ROUTINE_LIMITS,
  routineDraftSchema,
  routineMissedSchema,
  routineNotifySchema,
  type RoutineDraft,
} from '../../../shared/routines'
import type { ChatBehavior } from '../../../shared/conversation-experience'
import { isBotMode } from '../../fleet/instance/config'
import { isHeadlessInstance } from '../../remote-host/server/config'
import { createProposal } from '../../routines/store'
import { getConversation } from '../../store'
import { autonomousPolicy } from '../autonomous'
import { remoteChatPolicy } from '../remote-policy'
import { conversationDispatchToolsAllowed, ROUTINE_PROPOSE_TOOL_NAME, ROUTINE_RUN_REPORT_TOOL_NAME } from '../tool-policy'
import { routineRunReportToolAllowed } from './routine-run-report'
import { defineTool } from './util'

const weeklyScheduleSchema = z
  .object({
    kind: z.literal('weekly'),
    time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM in 24h format'),
    days: z.array(z.number().int().min(1).max(7)).max(7),
    timezone: z.string().min(1).max(120).optional(),
  })
  .strict()

const intervalScheduleSchema = z
  .object({
    kind: z.literal('interval'),
    every_minutes: z.number().int().min(15).max(1440),
  })
  .strict()

const parameters = z
  .object({
    title: z.string().trim().min(1).max(ROUTINE_LIMITS.titleMax),
    instruction: z.string().trim().min(1).max(ROUTINE_LIMITS.instructionMax),
    schedule: z.discriminatedUnion('kind', [weeklyScheduleSchema, intervalScheduleSchema]),
    notify: routineNotifySchema.optional(),
    missed: routineMissedSchema.optional(),
  })
  .strict()

export type RoutineProposeResult =
  | { ok: true; proposalId: string; draft: RoutineDraft }
  | { ok: false; error: string }

/**
 * Only local desktop conversations (standalone or project) that are not routine runs, not bot/headless instances,
 * not remote web chats, and not unattended autonomous turns may propose routines.
 */
export function routineProposeToolAllowed(conversationId: string, mode?: ChatBehavior): boolean {
  if (mode && !conversationDispatchToolsAllowed(mode)) return false
  if (isBotMode() || isHeadlessInstance()) return false
  if (autonomousPolicy(conversationId) || remoteChatPolicy(conversationId)) return false
  const conversation = getConversation(conversationId)
  if (!conversation) return false
  if (conversation.scope === 'standalone' && conversation.routineId) return false
  return true
}

/** Adds routine_run_report inside run conversations, or routine_propose in eligible local chats. */
export function enableRoutineTools(enabled: Set<string>, conversationId: string, mode?: ChatBehavior): void {
  if (routineRunReportToolAllowed(conversationId)) {
    enabled.add(ROUTINE_RUN_REPORT_TOOL_NAME)
    return
  }
  if (routineProposeToolAllowed(conversationId, mode)) {
    enabled.add(ROUTINE_PROPOSE_TOOL_NAME)
  }
}

export const routineProposeTool = defineTool<typeof parameters, RoutineProposeResult>({
  name: ROUTINE_PROPOSE_TOOL_NAME,
  description:
    'Propose a scheduled routine for this computer when the person asks for something to happen on its own at set ' +
    'times or intervals. You may check access first (for example by opening the site). Write the instruction as a ' +
    'standalone order to an unattended agent running alone, including when to alert the person. Permission mode and ' +
    'model are inherited automatically from this conversation.',
  parameters,
  execute: async (args, ctx) => {
    if (!routineProposeToolAllowed(ctx.conversationId)) {
      return { ok: false, error: 'Routine proposals are only available in local desktop conversations.' }
    }
    const { conversationExecutionSettings, permModeFor, persistedConversationSettings } = await import('../service')
    const exec = conversationExecutionSettings(ctx.conversationId)
    const model = exec && exec.modelId ? exec : persistedConversationSettings(ctx.conversationId)
    if (!model || !model.providerId || !model.modelId) {
      return { ok: false, error: 'Select a provider and model for this conversation before proposing a routine.' }
    }

    const timezone =
      args.schedule.kind === 'weekly'
        ? args.schedule.timezone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
        : undefined
    if (args.schedule.kind === 'weekly' && timezone && !isValidTimeZone(timezone)) {
      return { ok: false, error: `Invalid time zone: ${timezone}` }
    }

    const schedule =
      args.schedule.kind === 'weekly'
        ? {
            kind: 'weekly' as const,
            time: args.schedule.time,
            days: args.schedule.days,
            timezone: timezone!,
          }
        : {
            kind: 'interval' as const,
            everyMinutes: args.schedule.every_minutes,
          }

    const candidate: RoutineDraft = {
      title: args.title.trim(),
      instruction: args.instruction.trim(),
      schedule,
      permMode: permModeFor(ctx.conversationId),
      model: {
        providerId: model.providerId,
        modelId: model.modelId,
        reasoning: model.reasoning,
        fastMode: model.fastMode,
      },
      notify: args.notify ?? 'notable',
      missed: args.missed ?? 'catchup',
      retentionDays: 30,
    }
    const parsed = routineDraftSchema.safeParse(candidate)
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid routine draft.' }
    }

    const proposal = createProposal(ctx.conversationId, parsed.data)
    return { ok: true, proposalId: proposal.id, draft: proposal.draft }
  },
  toModelText: (_args, result) =>
    result.ok
      ? `Proposal ${result.proposalId} created. The routine does NOT exist yet: the person creates, adjusts or discards it in the card shown below. Do not claim the routine was created or scheduled.`
      : `Could not create routine proposal: ${result.error}`,
})
