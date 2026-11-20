import { FLEET_ROUTINE_RUN_LIMITS } from '@maestrly/bot-fleet-protocol'
import { z } from 'zod'
import { routineRunReportSchema } from '../../../shared/routines'
import { isBotMode } from '../../fleet/instance/config'
import { getRun, runByConversation, updateRun } from '../../routines/store'
import { getConversation } from '../../store'
import { ROUTINE_RUN_REPORT_TOOL_NAME } from '../tool-policy'
import { defineTool } from './util'

const parameters = z
  .object({
    outcome: z.enum(['notable', 'nothing_new', 'done']),
    summary: z.string().trim().min(1).max(FLEET_ROUTINE_RUN_LIMITS.summaryMax),
    pending: z.string().trim().max(FLEET_ROUTINE_RUN_LIMITS.pendingMax).nullable().optional(),
    notes_for_next_run: z.string().trim().max(FLEET_ROUTINE_RUN_LIMITS.notesMax).nullable().optional(),
  })
  .strict()

export type RoutineRunReportResult = { reported: true } | { reported: false; error: string }

function resolveRunForConversation(conversationId: string) {
  const conv = getConversation(conversationId)
  if (!conv || conv.scope !== 'standalone' || !conv.routineId) return null
  return (conv.routineRunId ? getRun(conv.routineRunId) : null) ?? runByConversation(conversationId)
}

export function routineRunReportToolAllowed(conversationId: string): boolean {
  if (isBotMode()) return false
  return resolveRunForConversation(conversationId) !== null
}

export const routineRunReportTool = defineTool<typeof parameters, RoutineRunReportResult>({
  name: ROUTINE_RUN_REPORT_TOOL_NAME,
  description:
    'Report the result of this scheduled routine run. Call once when finishing: use outcome "notable" when the ' +
    'person should see what you found, "nothing_new" when a check found nothing new, or "done" when a task ran ' +
    'to completion. Include concise notes_for_next_run when useful for future runs.',
  parameters,
  execute: async (args, ctx) => {
    if (isBotMode()) {
      return { reported: false, error: 'routine_run_report is not available in bot mode.' }
    }
    const run = resolveRunForConversation(ctx.conversationId)
    if (!run) {
      return { reported: false, error: 'routine_run_report is only available inside a routine run conversation.' }
    }
    const pending = args.pending && args.pending.trim().length > 0 ? args.pending.trim() : null
    const notes = args.notes_for_next_run && args.notes_for_next_run.trim().length > 0 ? args.notes_for_next_run.trim() : null
    const parsed = routineRunReportSchema.safeParse({
      outcome: args.outcome,
      summary: args.summary.trim(),
      pending,
      notes,
    })
    if (!parsed.success) {
      return { reported: false, error: parsed.error.issues[0]?.message ?? 'Invalid routine run report.' }
    }
    updateRun(run.id, { report: parsed.data })
    return { reported: true }
  },
  toModelText: (_args, result) =>
    result.reported ? 'Run report saved.' : `Could not save run report: ${result.error}`,
})
