import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { autonomousPolicy } from './autonomous'

/** The executor reads a structured terminal report, so a blocker is never a successful job. */
export function autonomousReportTools(): ToolSet {
  const policy = autonomousPolicy('')
  if (!policy) return {}
  return {
    executor_report: tool({
      description:
        'Record the final result of this unattended task after implementation and verification. Use failed for missing credentials, missing essential information, failed checks or other unresolved blockers. This records a terminal report; it never asks a person to respond. Only the main executor may call it.',
      inputSchema: z
        .object({ state: z.enum(['succeeded', 'failed']), summary: z.string().trim().min(1).max(12000) })
        .strict(),
      execute: async (report) => {
        policy.report = report
        return { recorded: true }
      },
    }),
  }
}
